// Architecture: dependency-cruiser over the JS/TS files under review. For each
// project (nearest package.json dir) holding changed files, depcruise starts at
// those files and follows their imports, so a cycle through a changed file is
// found without cruising the whole repo. Only violations whose `from` is a
// file under review are reported, on the line that imports the `to` module.
//
// Config: the repo's own .dependency-cruiser.{json,js,cjs,mjs} (nearest, from
// the project dir up to the repo root) when it has one, else a default set
// written to /tmp: no-circular, not-to-unresolvable, no-non-package-json
// (all warn). A .js/.cjs/.mjs config is repo code that depcruise executes with
// node; it is loaded anyway, as the ts analyzer loads ESLint configs: the
// container is read-only, has no network and drops all capabilities.
//
// Without node_modules (in the project dir or above) every package import is
// unresolvable, so hits on unresolvable bare specifiers are dropped, under any
// rule name (and no-non-package-json can't fire); relative imports and cycles
// are still checked. A note says so. Skipping the whole project would lose
// those, which need no node_modules.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const version = process.env.MCR_ROOT ? (await run('depcruise', ['--version'])).stdout.trim() : 'dependency-cruiser';

const info = {
  name: 'depcruise',
  version,
  languages: ['typescript', 'javascript'],
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
};

const HELP = 'https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md';
const CRUISABLE = /\.(?:[cm]?[jt]sx?)$/;
const CONFIGS = ['.dependency-cruiser.json', '.dependency-cruiser.js', '.dependency-cruiser.cjs', '.dependency-cruiser.mjs'];
const SEVERITY = { error: 'high', warn: 'medium', info: 'low' };

/** depcruise rule severity -> finding severity; `ignore` (or unknown) -> null. */
export function severityOf(s) {
  return SEVERITY[s] ?? null;
}

/** The default config: three warn rules; tsconfig (if any) so path aliases resolve. */
export function defaultConfig(tsConfig) {
  return {
    forbidden: [
      {
        name: 'no-circular',
        severity: 'warn',
        comment: 'Circular dependency. Break the cycle: move the shared part to its own module or invert one import.',
        from: {},
        to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
      },
      {
        name: 'not-to-unresolvable',
        severity: 'warn',
        comment: 'Import that does not resolve to a file or an installed package.',
        from: {},
        to: { couldNotResolve: true },
      },
      {
        name: 'no-non-package-json',
        severity: 'warn',
        comment: 'Package used but not declared in package.json (dependencies, devDependencies, ...). Declare it.',
        from: {},
        to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
      },
    ],
    options: {
      doNotFollow: { path: ['node_modules'] },
      tsPreCompilationDeps: true,
      skipAnalysisNotInRules: true,
      ...(tsConfig ? { tsConfig: { fileName: tsConfig } } : {}),
      enhancedResolveOptions: {
        exportsFields: ['exports'],
        conditionNames: ['import', 'require', 'node', 'default', 'types'],
        mainFields: ['module', 'main', 'types', 'typings'],
      },
    },
  };
}

/** Nearest dir (relative to root, '' = root) at or above `file` that holds `name`. */
export function nearestWith(root, file, names, exists = existsSync) {
  let dir = dirname(file);
  for (;;) {
    const d = dir === '.' ? '' : dir;
    for (const n of names) if (exists(join(root, d, n))) return { dir: d, name: n };
    if (d === '') return null;
    dir = dirname(d);
  }
}

/** Groups cruisable files by project dir (nearest package.json; repo root if none). */
export function groupByProject(root, files, exists = existsSync) {
  const groups = new Map();
  for (const f of files) {
    if (!CRUISABLE.test(f)) continue;
    const dir = nearestWith(root, f, ['package.json'], exists)?.dir ?? '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  return groups;
}

const isBare = (spec) => !spec.startsWith('.') && !spec.startsWith('/');

/**
 * 1-based line in `source` that imports `spec` (the specifier as written):
 * a line with the quoted specifier and import/require/from/export on it,
 * else any line with the quoted specifier, else 1.
 */
export function findImportLine(source, spec) {
  if (!spec) return 1;
  const quoted = [`'${spec}'`, `"${spec}"`, `\`${spec}\``];
  const lines = source.split('\n');
  const has = (l) => quoted.some((q) => l.includes(q));
  const keyword = (l) => ['import', 'require', 'from', 'export'].some((k) => l.includes(k));
  let loose = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!has(lines[i])) continue;
    if (keyword(lines[i])) return i + 1;
    if (!loose) loose = i + 1;
  }
  return loose || 1;
}

const cycleNames = (cycle) => (cycle ?? []).map((c) => (typeof c === 'string' ? c : c.name));

/** Message for a dependency-level rule hit: `from` imports `spec` (resolved `to`). */
export function messageFor(rule, { from, to, spec, cycle }) {
  if (cycle?.length) {
    return `Circular dependency: ${[from, ...cycleNames(cycle)].join(' -> ')}. Break the cycle: move the shared part to its own module or invert one import.`;
  }
  if (rule === 'not-to-unresolvable') return `Import '${spec}' does not resolve to a file or an installed package.`;
  if (rule === 'no-non-package-json') return `Package '${spec}' is imported but not declared in package.json. Add it to dependencies (or devDependencies).`;
  return `${rule}: ${from} imports '${spec}'${to && to !== spec ? ` (${to})` : ''}, which the dependency-cruiser config forbids.`;
}

/**
 * depcruise json (cruise result) -> findings.
 * Dependency rules come from modules[].dependencies[].rules: summary.violations
 * reports each cycle once, from whichever module depcruise met first, while
 * every file under review in a cycle should get it on its own import line.
 * Module-level rules (orphans, reachability, instability, folders) come from
 * summary.violations, on line 1.
 * project: dir of the cruise relative to root ('' = root); depcruise paths are relative to it.
 * wanted: Set of repo-relative files under review. read(file) -> source text or null.
 * bareUnresolvable: false drops rule hits on unresolvable bare specifiers (no node_modules).
 */
export function toFindings(result, { project = '', wanted, read = () => null, bareUnresolvable = true }) {
  const findings = [];
  const seen = new Set();
  const sources = new Map();
  const repoPath = (p) => (project ? `${project}/${p}` : p);
  // Rules that flag cycles get the cycle message; others on a circular import keep their own.
  const cycleRules = new Set(
    (result?.summary?.ruleSetUsed?.forbidden ?? []).filter((r) => r.to?.circular === true).map((r) => r.name),
  );
  cycleRules.add('no-circular');
  const add = (rule, file, line, message) => {
    const severity = severityOf(rule?.severity);
    if (!severity) return;
    const key = `${rule.name}|${file}|${line}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ruleId: rule.name, ruleName: rule.name, message, file, line, category: 'architecture', severity, helpUri: HELP });
  };
  for (const m of result?.modules ?? []) {
    const file = repoPath(m.source);
    if (!wanted.has(file)) continue;
    for (const d of m.dependencies ?? []) {
      if (d.valid !== false || !d.rules?.length) continue;
      const spec = d.module;
      if (!sources.has(file)) sources.set(file, read(file));
      const source = sources.get(file);
      const line = source == null ? 1 : findImportLine(source, spec);
      // Without node_modules every package is unresolvable: noise under any rule name.
      if (d.couldNotResolve && !bareUnresolvable && isBare(spec)) continue;
      for (const rule of d.rules) {
        add(rule, file, line, messageFor(rule.name, { from: m.source, to: d.resolved, spec, cycle: d.circular && cycleRules.has(rule.name) ? d.cycle : undefined }));
      }
    }
  }
  for (const v of result?.summary?.violations ?? []) {
    if (v.type === 'dependency' || v.type === 'cycle') continue;
    const file = repoPath(v.from);
    if (!wanted.has(file)) continue;
    add(v.rule, file, 1, `${v.rule?.name}: ${v.from}${v.to && v.to !== v.from ? ` -> ${v.to}` : ''}${v.comment ? ` (${v.comment})` : ''}`);
  }
  return findings;
}

/** Does `dir` (relative to root) or any parent up to root have node_modules? */
function hasNodeModules(root, dir) {
  for (let d = dir; ; d = dirname(d) === '.' ? '' : dirname(d)) {
    if (existsSync(join(root, d, 'node_modules'))) return true;
    if (d === '') return false;
  }
}

function readSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function cruise(root, project, files, notes) {
  const cwd = join(root, project);
  const rel = files.map((f) => (project ? f.slice(project.length + 1) : f));
  // The repo's own config, nearest to the project, else the default set.
  const own = nearestWith(root, join(project, 'x'), CONFIGS);
  let config;
  let tmpConfig = null;
  if (own) {
    config = join(root, own.dir, own.name);
    notes.push(`depcruise (${project || '.'}): using the repo's ${join(own.dir, own.name)}`);
  } else {
    const ts = existsSync(join(cwd, 'tsconfig.json')) ? join(cwd, 'tsconfig.json') : null;
    tmpConfig = `/tmp/depcruise-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    writeFileSync(tmpConfig, JSON.stringify(defaultConfig(ts)));
    config = tmpConfig;
  }
  const modules = hasNodeModules(root, project);
  if (!modules) {
    notes.push(`depcruise (${project || '.'}): no node_modules (run npm ci); package imports can't be resolved, so unresolvable package imports are skipped and undeclared dependencies are not checked. Cycles and relative imports are.`);
  }
  try {
    // --no-cache: a repo config may turn the cache on, and the repo is read-only.
    const r = await run('depcruise', ['--config', config, '--output-type', 'json', '--no-cache', '--', ...rel], { cwd });
    let result;
    try {
      result = JSON.parse(r.stdout);
    } catch {
      notes.push(`depcruise (${project || '.'}) failed (exit ${r.code}): ${r.stderr.slice(0, 400)}`);
      return [];
    }
    return toFindings(result, {
      project,
      wanted: new Set(files),
      read: (f) => readSafe(join(root, f)),
      bareUnresolvable: modules,
    });
  } finally {
    if (tmpConfig) rmSync(tmpConfig, { force: true });
  }
}

async function analyze({ root, files }) {
  const notes = [];
  const findings = [];
  for (const [project, group] of groupByProject(root, files)) {
    findings.push(...(await cruise(root, project, group, notes)));
  }
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
