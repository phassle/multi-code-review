// Architecture: import-linter (lint-imports) checks the repo's own import
// contracts (layers, forbidden, independence, protected, acyclic_siblings).
// It runs only where the repo configures it: the nearest .importlinter,
// setup.cfg with [importlinter] or pyproject.toml with [tool.importlinter],
// from a changed .py file's dir up to the root. No default contracts.
//
// grimp builds the import graph by parsing the files; repo code is never run.
// The root packages must be importable, so PYTHONPATH is the config dir and
// its src/. --no-cache: the repo is read-only.
//
// lint-imports has no machine-readable output, so its text report is parsed:
// under "Broken contracts", each contract name (underlined with dashes) and
// its import chains, `- pkg.a -> pkg.b (l.12)`. Every import in a chain lands
// on its line in the importing module's file, so whichever file under review
// added a link gets the finding. A broken contract fails lint-imports in the
// repo's CI: severity high.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const version = process.env.MCR_ROOT
  ? (await run('lint-imports', ['--version'])).stdout.trim().replace(/^import-linter\s*/i, '') || 'import-linter'
  : 'import-linter';

const info = {
  name: 'import-linter',
  version,
  languages: ['python'],
  extensions: ['.py'],
};

const HELP = 'https://import-linter.readthedocs.io/en/stable/contract_types.html';

/** Does the file text configure import-linter? */
export function configures(name, text) {
  if (text == null) return false;
  if (name === '.importlinter') return true;
  const lines = text.split('\n').map((l) => l.trim());
  if (name === 'setup.cfg') return lines.some((l) => l === '[importlinter]');
  if (name === 'pyproject.toml') return lines.some((l) => l === '[tool.importlinter]' || l.startsWith('[[tool.importlinter.') || l.startsWith('[tool.importlinter.'));
  return false;
}

const CONFIGS = ['.importlinter', 'setup.cfg', 'pyproject.toml'];

/** Nearest { dir, name } (dir relative to root, '' = root) at or above `file` holding an import-linter config. */
export function findConfig(file, read) {
  let dir = dirname(file);
  for (;;) {
    const d = dir === '.' ? '' : dir;
    for (const n of CONFIGS) if (configures(n, read(d ? `${d}/${n}` : n))) return { dir: d, name: n };
    if (d === '') return null;
    dir = dirname(d);
  }
}

/** Contract name -> rule id: lower case, non-alphanumerics to '-'. */
export function slug(name) {
  let out = '';
  let dash = false;
  for (const ch of name.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      if (dash && out) out += '-';
      out += ch;
      dash = false;
    } else dash = true;
  }
  return out || 'contract';
}

const isRule = (l) => l.length > 0 && [...l].every((c) => c === '-');

/** `X -> Y (l.1, l.2)` or `X (l.3)` (prefix `- ` / `& ` stripped) -> { importer, imported?, lines } or null. */
export function parseImport(text) {
  const open = text.lastIndexOf(' (');
  if (open < 0 || !text.endsWith(')')) return null;
  const inner = text.slice(open + 2, -1);
  const left = text.slice(0, open).trim();
  const parts = left.split(' -> ').map((s) => s.trim());
  if (parts.length > 2 || parts.some((p) => !p || p.includes(' '))) return null;
  const cycle = inner.match(/^(\d+) imports?$/);
  if (cycle) return { importer: parts[0], imported: parts[1], lines: [], count: Number(cycle[1]) };
  const lines = [];
  for (const piece of inner.split(',')) {
    const p = piece.trim();
    if (!p.startsWith('l.')) return null;
    const n = Number(p.slice(2));
    lines.push(Number.isInteger(n) && n > 0 ? n : null);
  }
  return { importer: parts[0], imported: parts[1], lines };
}

/**
 * Lines of one chain block (`- a -> b (l.1)` then indented continuations)
 * -> links [{ importer, imported, lines }]. Handles collapsed chains:
 *   - x.a (l.1)                 x.a, x.b and x.c all import y
 *     & x.b (l.1)
 *     & x.c -> y (l.2)
 *     y -> z (l.1)
 *          & z.other (l.3)      y also imports z.other
 */
export function parseChain(blockLines) {
  const links = [];
  const pending = [];
  let lastImporter = null;
  for (const raw of blockLines) {
    let t = raw.trim();
    if (t.startsWith('- ') || t.startsWith('& ')) t = t.slice(2).trim();
    const imp = parseImport(t);
    if (!imp) continue;
    if (imp.imported) {
      for (const p of pending.splice(0)) links.push({ importer: p.importer, imported: imp.imported, lines: p.lines });
      links.push(imp);
      lastImporter = imp.importer;
    } else if (lastImporter) links.push({ importer: lastImporter, imported: imp.importer, lines: imp.lines });
    else pending.push(imp);
  }
  return links;
}

/**
 * lint-imports text report -> [{ contract, groups: [{ header, chains: [links] }], cycles?: { ancestor, edges } }]
 * for the broken contracts.
 */
export function parseReport(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l, i) => l.trim() === 'Broken contracts' && isRule(lines[i + 1]?.trim() ?? ''));
  if (start < 0) return [];
  const contracts = [];
  let cur = null;
  let header = '';
  let block = null;
  const flush = () => {
    if (block && cur) {
      const chain = parseChain(block);
      if (chain.length) {
        let g = cur.groups.find((x) => x.header === header);
        if (!g) cur.groups.push((g = { header, chains: [] }));
        g.chains.push(chain);
      }
    }
    block = null;
  };
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    const next = lines[i + 1]?.trim() ?? '';
    if (t && !t.startsWith('- ') && isRule(next) && next.length === t.length) {
      flush();
      cur = { contract: t, groups: [] };
      contracts.push(cur);
      header = '';
      i++;
      continue;
    }
    if (!cur) continue;
    if (!t) {
      flush();
      continue;
    }
    const acyclic = t.match(/^No cycles are allowed in (\S+)\.$/);
    if (acyclic) {
      flush();
      cur.cycles = { ancestor: acyclic[1], edges: [] };
      continue;
    }
    if (t.startsWith('- ')) {
      const imp = cur.cycles ? parseImport(t.slice(2).trim()) : null;
      if (imp?.count !== undefined) {
        const abs = (m) => (m.startsWith('.') ? cur.cycles.ancestor + m : m);
        cur.cycles.edges.push({ importer: abs(imp.importer), imported: abs(imp.imported), count: imp.count });
        continue;
      }
      flush();
      block = [line];
      continue;
    }
    if (block && line.startsWith(' ')) {
      block.push(line);
      continue;
    }
    flush();
    if (t.endsWith(':')) header = t.slice(0, -1);
  }
  flush();
  return contracts;
}

/** Candidate repo-relative files for module `m` under the given bases (repo-relative dirs). */
export function moduleFiles(m, bases) {
  const path = m.split('.').join('/');
  return bases.flatMap((b) => [b ? `${b}/${path}.py` : `${path}.py`, b ? `${b}/${path}/__init__.py` : `${path}/__init__.py`]);
}

/** Repo-relative file -> dotted module under one of the bases, or null. */
export function moduleOf(file, bases) {
  if (!file.endsWith('.py')) return null;
  for (const b of bases) {
    if (b && !file.startsWith(`${b}/`)) continue;
    const rel = (b ? file.slice(b.length + 1) : file).slice(0, -3).split('/');
    if (rel[rel.length - 1] === '__init__') rel.pop();
    if (rel.length && rel.every((p) => p && !p.includes('.') && !p.includes('-'))) return rel.join('.');
  }
  return null;
}

const identChar = (c) => c !== undefined && (c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'));

/** Does `text` name module `m` (not as a prefix of a longer name)? */
function mentions(text, m, afterDot = false) {
  for (let i = text.indexOf(m); i >= 0; i = text.indexOf(m, i + 1)) {
    if (!identChar(text[i - 1]) && (afterDot || text[i - 1] !== '.') && !identChar(text[i + m.length])) return true;
  }
  return false;
}

/** 1-based lines of `source` that import `target` (absolute or relative by its last part). */
export function importLines(source, target) {
  const last = target.split('.').pop();
  const out = [];
  source.split('\n').forEach((l, i) => {
    const t = l.trim();
    if (!t.startsWith('import ') && !t.startsWith('from ')) return;
    const abs = mentions(t, target);
    const rel = t.startsWith('from .') && mentions(t, last, true);
    if (abs || rel) out.push(i + 1);
  });
  return out;
}

/**
 * Parsed report -> findings for files in `wanted`.
 * bases: repo-relative dirs where modules live (config dir, its src/).
 * read(file) -> source or null (for acyclic edges, which have no line numbers).
 */
export function toFindings(contracts, { bases, wanted, read = () => null }) {
  // One finding per contract, file and line; the reasons it breaks are joined.
  const byLine = new Map();
  const fileOf = (m) => moduleFiles(m, bases).find((f) => wanted.has(f)) ?? null;
  const add = (contract, file, line, reason, detail) => {
    const key = `${contract}|${file}|${line}`;
    if (!byLine.has(key)) byLine.set(key, { contract, file, line, reasons: new Set(), details: new Set() });
    const e = byLine.get(key);
    e.reasons.add(reason);
    if (detail) e.details.add(detail);
  };
  for (const c of contracts) {
    for (const g of c.groups) {
      for (const chain of g.chains) {
        const indirect = chain.some((l) => l.importer !== chain[0].importer && l.imported !== chain[0].imported);
        for (const link of chain) {
          const file = fileOf(link.importer);
          if (!file) continue;
          const lines = link.lines.filter(Boolean);
          const detail = `${link.importer} imports ${link.imported}${indirect ? ', one step of an indirect import chain' : ''}`;
          for (const line of lines.length ? lines : [1]) add(c.contract, file, line, g.header || 'import not allowed', detail);
        }
      }
    }
    for (const e of c.cycles?.edges ?? []) {
      for (const file of wanted) {
        const m = moduleOf(file, bases);
        if (!m || (m !== e.importer && !m.startsWith(`${e.importer}.`))) continue;
        const source = read(file);
        if (source == null) continue;
        const reason = `${e.importer} and its siblings in ${c.cycles.ancestor} import each other in a cycle; removing ${e.importer} -> ${e.imported} (${e.count} import${e.count === 1 ? '' : 's'}) would break it`;
        for (const line of importLines(source, e.imported)) add(c.contract, file, line, reason);
      }
    }
  }
  return [...byLine.values()].map((e) => ({
    ruleId: slug(e.contract),
    ruleName: e.contract,
    message: `Contract "${e.contract}" is broken: ${[...e.reasons].join('; ')}.${e.details.size ? ` ${[...e.details].join('; ')}.` : ''} lint-imports fails on this.`,
    file: e.file,
    line: e.line,
    category: 'architecture',
    severity: 'high',
    helpUri: HELP,
  }));
}

function readSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Groups .py files by import-linter config; files without one go under null. */
export function groupByConfig(files, read) {
  const groups = new Map();
  const missing = [];
  for (const f of files) {
    if (!f.endsWith('.py')) continue;
    const cfg = findConfig(f, read);
    if (!cfg) {
      missing.push(f);
      continue;
    }
    const key = cfg.dir ? `${cfg.dir}/${cfg.name}` : cfg.name;
    if (!groups.has(key)) groups.set(key, { ...cfg, files: [] });
    groups.get(key).files.push(f);
  }
  return { groups, missing };
}

async function lint(root, cfg, wanted, notes) {
  const cwd = join(root, cfg.dir);
  const bases = [cfg.dir];
  const src = cfg.dir ? `${cfg.dir}/src` : 'src';
  if (existsSync(join(root, src))) bases.unshift(src);
  const where = cfg.dir ? `${cfg.dir}/${cfg.name}` : cfg.name;
  const r = await run('lint-imports', ['--config', join(cwd, cfg.name), '--no-cache', '--no-logo'], {
    cwd,
    env: {
      ...process.env,
      PYTHONPATH: bases.map((b) => join(root, b)).join(':'),
      COLUMNS: '10000',
      NO_COLOR: '1',
      TERM: 'dumb',
    },
  });
  if (r.code === 0) return [];
  const contracts = parseReport(r.stdout);
  if (!contracts.length) {
    notes.push(`import-linter (${where}) failed (exit ${r.code}): ${(r.stdout + r.stderr).trim().slice(0, 400)}`);
    return [];
  }
  return toFindings(contracts, { bases, wanted, read: (f) => readSafe(join(root, f)) });
}

export async function analyze({ root, files }) {
  const notes = [];
  const findings = [];
  const { groups, missing } = groupByConfig(files, (f) => readSafe(join(root, f)));
  if (missing.length) {
    notes.push(`import-linter: no .importlinter, setup.cfg [importlinter] or pyproject.toml [tool.importlinter] above ${missing.length} Python file(s); no contracts to check there.`);
  }
  const wanted = new Set(files);
  const seen = new Set();
  for (const cfg of groups.values()) {
    for (const f of await lint(root, cfg, wanted, notes)) {
      const key = `${f.ruleId}|${f.file}|${f.line}|${f.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(f);
    }
  }
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
