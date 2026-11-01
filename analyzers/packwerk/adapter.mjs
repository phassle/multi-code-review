// Architecture: packwerk boundaries (dependency, privacy, visibility, layer,
// folder_privacy) via pks, the static Rust port of packwerk. No Rails boot;
// repo code is never run.
//
// Each reviewed file belongs to the nearest ancestor directory with a
// packwerk.yml (or pks's packs.yml), searched up to MCR_ROOT. pks runs once
// per such root, on that root's files, with --no-cache (the mount is
// read-only; its cache would go to tmp/cache/packwerk). Files under no
// packwerk root are skipped with a note.
//
// pks check leaves out violations recorded in package_todo.yml (known debt)
// and reports only boundaries that are enforced (enforce_*: true or strict);
// its strict_mode_violations list (recorded debt in strict packs) and stale
// todo entries are not findings here.
//
// Severity, from the package.yml of the pack whose rule applies (the
// referencing pack for dependency and layer, the defining pack for privacy,
// visibility and folder_privacy):
//   enforce_<type>: true | strict -> high (blocks on a changed line)
//   anything else, or unreadable  -> medium

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const version = process.env.MCR_ROOT ? (await run('pks', ['--version'])).stdout.trim() : 'pks';

const info = { name: 'packwerk', version, languages: ['ruby'], extensions: ['.rb', '.rake', '.erb'] };

const CONFIG_FILES = ['packwerk.yml', 'packs.yml'];
const HELP = 'https://github.com/Shopify/packwerk/blob/main/RESOLVING_VIOLATIONS.md';

const RULES = {
  dependency: { key: 'enforce_dependencies', pack: 'referencing', name: 'Undeclared pack dependency' },
  layer: { key: 'enforce_layers', pack: 'referencing', name: 'Layer violation' },
  privacy: { key: 'enforce_privacy', pack: 'defining', name: 'Private constant of another pack' },
  visibility: { key: 'enforce_visibility', pack: 'defining', name: 'Pack not visible to the referencing pack' },
  folder_privacy: { key: 'enforce_folder_privacy', pack: 'defining', name: 'Folder-private pack' },
};

const HINTS = {
  dependency: (v) => `Add ${v.defining_pack_name} to the dependencies in ${v.referencing_pack_name}/package.yml if this is intended, or go through a pack that may depend on it.`,
  layer: () => 'A pack may only depend on packs in the same or a lower layer; move the code or invert the dependency.',
  privacy: (v) => `Use ${v.defining_pack_name}'s public API (its public folder) instead, or make the constant public there.`,
  visibility: (v) => `${v.defining_pack_name} limits who may use it (visible_to); use another route or add ${v.referencing_pack_name} there.`,
  folder_privacy: (v) => `${v.defining_pack_name} is only usable from its parent or sibling packs.`,
};

/**
 * Nearest ancestor of `file` (relative to `root`) holding a packwerk config,
 * as an absolute path, searching no higher than `limit`. null if none.
 * `exists` is injectable for tests.
 */
export function packwerkRoot(root, file, limit = root, exists = existsSync) {
  let dir = dirname(join(root, file));
  for (;;) {
    if (CONFIG_FILES.some((c) => exists(join(dir, c)))) return dir;
    if (dir === limit || !(dir.startsWith(limit + sep))) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Groups files by packwerk root: { groups: Map<absRoot, relFiles[]>, outside: relFiles[] }. */
export function groupByRoot(root, files, limit = root, exists = existsSync) {
  const groups = new Map();
  const outside = [];
  for (const f of files) {
    const pk = packwerkRoot(root, f, limit, exists);
    if (!pk) {
      outside.push(f);
      continue;
    }
    if (!groups.has(pk)) groups.set(pk, []);
    groups.get(pk).push(f);
  }
  return { groups, outside };
}

/** Top-level `key: value` of a package.yml (value unquoted, comment stripped); undefined if absent. */
export function yamlValue(text, key) {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${key}:`)) continue;
    const raw = line.slice(key.length + 1).replace(/\s+#.*$/, '').trim();
    return raw.replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

/** The enforce_* setting for a violation type in a package.yml's text. */
export function enforcement(packageYml, type) {
  const rule = RULES[type];
  if (!rule || packageYml == null) return undefined;
  const v = yamlValue(packageYml, rule.key);
  // enforce_folder_visibility is the deprecated name of enforce_folder_privacy.
  if (v === undefined && type === 'folder_privacy') return yamlValue(packageYml, 'enforce_folder_visibility');
  return v;
}

/** high when the applicable pack enforces the boundary (true or strict), else medium. */
export function severity(violation, readPackageYml) {
  if (violation.strict) return 'high';
  const rule = RULES[violation.violation_type];
  if (!rule) return 'medium';
  const pack = rule.pack === 'referencing' ? violation.referencing_pack_name : violation.defining_pack_name;
  const setting = enforcement(readPackageYml(pack), violation.violation_type);
  return setting === 'true' || setting === 'strict' ? 'high' : 'medium';
}

/**
 * pks `check --json` output (one packwerk root) -> findings for the requested
 * files. Paths from pks are relative to `pkRoot`; findings are relative to `root`.
 */
export function toFindings(report, { root, pkRoot, files, readPackageYml }) {
  const wanted = new Set(files);
  const findings = [];
  for (const v of report?.violations ?? []) {
    const file = relative(root, join(pkRoot, v.file));
    if (!wanted.has(file)) continue;
    const type = v.violation_type;
    const rule = RULES[type];
    const hint = HINTS[type]?.(v) ?? '';
    findings.push({
      ruleId: type,
      message: `${type} violation: ${v.constant_name} belongs to ${v.defining_pack_name} and is referenced from ${v.referencing_pack_name}. ${hint}`.trim(),
      file,
      line: v.line || 1,
      column: Number.isInteger(v.column) ? v.column + 1 : undefined,
      category: 'architecture',
      severity: severity(v, readPackageYml),
      helpUri: HELP,
      ruleName: rule?.name ?? type,
    });
  }
  return findings;
}

/** Reads <pkRoot>/<pack>/package.yml; null when missing. */
function packageReader(pkRoot) {
  const cache = new Map();
  return (pack) => {
    if (!cache.has(pack)) {
      const path = join(pkRoot, pack === '.' ? '' : pack, 'package.yml');
      let text = null;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        text = null;
      }
      cache.set(pack, text);
    }
    return cache.get(pack);
  };
}

function limitFor(root) {
  try {
    const mcr = realpathSync(process.env.MCR_ROOT ?? root);
    return root === mcr || root.startsWith(mcr + sep) ? mcr : root;
  } catch {
    return root;
  }
}

export async function analyze({ root, files }) {
  if (files.length === 0) return { findings: [], notes: [] };
  const { groups, outside } = groupByRoot(root, files, limitFor(root));
  const notes = [];
  if (groups.size === 0) return { findings: [], notes: ['packwerk: no packwerk.yml (or packs.yml) above the reviewed files; skipped'] };
  if (outside.length) notes.push(`packwerk: ${outside.length} file(s) outside any packwerk root skipped`);
  const findings = [];
  for (const [pkRoot, group] of groups) {
    const rel = group.map((f) => relative(pkRoot, join(root, f)));
    const r = await run('pks', ['--project-root', pkRoot, '--no-cache', 'check', '--json', ...rel], { cwd: pkRoot });
    let report;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      notes.push(`packwerk: pks failed in ${relative(root, pkRoot) || '.'} (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      continue;
    }
    findings.push(...toFindings(report, { root, pkRoot, files: group, readPackageYml: packageReader(pkRoot) }));
  }
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
