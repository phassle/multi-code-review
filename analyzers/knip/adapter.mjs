// Best practices: knip (unused files, exports, types, enum members and
// dependencies; unlisted dependencies, unresolved imports, unlisted binaries).
// Knip is whole-project, so it runs once per project holding changed files and
// only findings in the files under review are kept.
//
// Projects: the nearest package.json dir of each changed file. When a dir at
// or above it is a workspace root (package.json#workspaces or
// pnpm-workspace.yaml), knip runs from that root, filtered with one
// `--workspace <dir>` per changed workspace ('.' for the root package), so a
// monorepo is one run and cross-workspace imports resolve. Without
// node_modules (in the project dir or above, up to the repo root) knip's
// results are unreliable (every package import is unlisted, configs and
// plugins can't load), so the project is skipped with a note.
//
// Config: knip loads the repo's own config (knip.json[c], .knip.json[c],
// knip.(js|ts), knip.config.(js|ts), package.json#knip) and its plugins load
// tool configs (vite.config.ts, jest.config.js, ...). A .js/.ts config is repo
// code that knip executes; it is loaded anyway, as the ts analyzer loads
// ESLint configs: the container is read-only, has no network and drops all
// capabilities. Knip's cache is off by default and stays off (repo is read-only).
//
// Severity is medium or low, never high: dead code and stale dependencies are
// worth fixing but shouldn't block a change by default.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const version = process.env.MCR_ROOT ? (await run('knip', ['--version'])).stdout.trim() : 'knip';

const info = {
  name: 'knip',
  version,
  languages: ['typescript', 'javascript'],
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro', '.mdx', '.json'],
};

const HELP = 'https://knip.dev/reference/issue-types';
const RELEVANT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx)$/;

const q = (s) => `'${s}'`;
const member = (i) => (i.namespace ? `${i.namespace}.${i.name}` : i.name);

/** knip issue type -> rule id, severity, message. Types not listed (cycles, ...) are ignored. */
export const RULES = {
  files: { ruleId: 'unused-file', severity: 'medium', message: (i, file) => `Unused file: ${file} is not reached from any entry file. Delete it, or add it as an entry in the knip config.` },
  dependencies: { ruleId: 'unused-dependency', severity: 'medium', message: (i) => `Unused dependency ${q(i.name)}: listed in dependencies but never imported. Remove it from package.json.` },
  devDependencies: { ruleId: 'unused-dev-dependency', severity: 'low', message: (i) => `Unused devDependency ${q(i.name)}: listed but never imported or used by a tool config. Remove it from package.json.` },
  optionalPeerDependencies: { ruleId: 'unused-optional-peer-dependency', severity: 'low', message: (i) => `Optional peer dependency ${q(i.name)} is never imported.` },
  unlisted: { ruleId: 'unlisted-dependency', severity: 'medium', message: (i) => `${q(i.name)} is imported but not listed in package.json. Add it to dependencies (or devDependencies).` },
  unresolved: { ruleId: 'unresolved-import', severity: 'medium', message: (i) => `Import ${q(i.name)} does not resolve to a file or an installed package.` },
  binaries: { ruleId: 'unlisted-binary', severity: 'medium', message: (i) => `Binary ${q(i.name)} is used (scripts, CI) but no listed dependency provides it. Add its package to devDependencies.` },
  exports: {
    ruleId: 'unused-export',
    severity: 'medium',
    message: (i) =>
      `Unused export ${q(i.name)}: ${i.namespace ? `only imported through namespace ${q(i.namespace)}, which never reads it` : 'nothing imports it'}. Remove the export, or the code if it is dead.`,
  },
  nsExports: { ruleId: 'unused-export', severity: 'low', message: (i) => `Unused export ${q(i.name)}: only re-exported through a namespace that nothing reads.` },
  types: { ruleId: 'unused-type', severity: 'low', message: (i) => `Unused exported type ${q(i.name)}: nothing imports it. Remove the export, or the type.` },
  nsTypes: { ruleId: 'unused-type', severity: 'low', message: (i) => `Unused exported type ${q(i.name)}: only re-exported through a namespace that nothing reads.` },
  enumMembers: { ruleId: 'unused-enum-member', severity: 'low', message: (i) => `Unused enum member ${q(member(i))}.` },
  classMembers: { ruleId: 'unused-class-member', severity: 'low', message: (i) => `Unused class member ${q(member(i))}.` },
  namespaceMembers: { ruleId: 'unused-namespace-member', severity: 'low', message: (i) => `Unused namespace member ${q(member(i))}.` },
  duplicates: { ruleId: 'duplicate-export', severity: 'low', message: (i) => `Duplicate exports of the same value: ${i.name}. Keep one.` },
  catalog: { ruleId: 'unused-catalog-entry', severity: 'low', message: (i) => `Unused catalog entry ${q(i.name)}.` },
};

/** 1-based line of the JSON key `"name":` in `source` (string search, no regex), else 0. */
export function findKeyLine(source, name) {
  const lines = source.split('\n');
  const key = `"${name}"`;
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf(key);
    if (at >= 0 && lines[i].slice(at + key.length).trimStart().startsWith(':')) return i + 1;
  }
  return 0;
}

/** 1-based line holding `word` delimited by non-name chars (a binary in a script), else 0. */
export function findWordLine(source, word) {
  const name = /[\w@/.-]/;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (let at = lines[i].indexOf(word); at >= 0; at = lines[i].indexOf(word, at + 1)) {
      const before = lines[i][at - 1];
      const after = lines[i][at + word.length];
      if ((!before || !name.test(before)) && (!after || !name.test(after))) return i + 1;
    }
  }
  return 0;
}

/** Duplicates come as an array of symbols; others as one symbol. -> { name, line, col }. */
function symbolOf(issue) {
  if (Array.isArray(issue)) {
    const first = issue[0] ?? {};
    return { ...first, name: issue.map((s) => s?.name ?? s?.symbol).filter(Boolean).join(', ') };
  }
  return issue ?? {};
}

/**
 * knip json ({ issues: [{ file, <type>: [{ name, line?, col?, namespace? }] }] }) -> findings.
 * project: dir knip ran in, relative to root ('' = root); knip paths are relative to it.
 * wanted: Set of repo-relative files under review. read(file) -> source text or null.
 */
export function toFindings(result, { project = '', wanted, read = () => null }) {
  const findings = [];
  const seen = new Set();
  const repoPath = (p) => (project ? `${project}/${p}` : p);
  for (const entry of result?.issues ?? []) {
    if (typeof entry?.file !== 'string') continue;
    const file = repoPath(entry.file);
    if (!wanted.has(file)) continue;
    let source;
    const text = () => (source === undefined ? (source = read(file)) : source);
    for (const [type, rule] of Object.entries(RULES)) {
      for (const raw of entry[type] ?? []) {
        const issue = symbolOf(raw);
        if (!issue.name) continue;
        let line = Number.isInteger(issue.line) && issue.line > 0 ? issue.line : 0;
        if (!line && type !== 'files' && text() != null) {
          line = basename(file) === 'package.json' && type !== 'binaries' ? findKeyLine(text(), issue.name) : findWordLine(text(), issue.name);
        }
        line ||= 1;
        const message = rule.message(issue, file);
        const key = `${rule.ruleId}|${file}|${line}|${message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          ruleId: rule.ruleId,
          ruleName: rule.ruleId,
          message,
          file,
          line,
          ...(Number.isInteger(issue.col) && issue.col > 0 && type !== 'files' ? { column: issue.col } : {}),
          category: 'best-practices',
          severity: rule.severity,
          helpUri: HELP,
        });
      }
    }
  }
  return findings;
}

const parent = (d) => (d === '' ? null : dirname(d) === '.' ? '' : dirname(d));

/** Nearest dir (relative to root, '' = root) at or above `file` with a package.json; null if none. */
export function packageDir(root, file, exists = existsSync) {
  for (let d = dirname(file) === '.' ? '' : dirname(file); d !== null; d = parent(d)) {
    if (exists(join(root, d, 'package.json'))) return d;
  }
  return null;
}

/** Is `dir` a workspace root: pnpm-workspace.yaml, or package.json with `workspaces`. */
export function isWorkspaceRoot(root, dir, { exists = existsSync, read = readSafe } = {}) {
  if (exists(join(root, dir, 'pnpm-workspace.yaml'))) return true;
  const text = read(join(root, dir, 'package.json'));
  if (text == null) return false;
  try {
    const w = JSON.parse(text).workspaces;
    return Array.isArray(w) ? w.length > 0 : Array.isArray(w?.packages) && w.packages.length > 0;
  } catch {
    return false;
  }
}

/**
 * Groups the files knip can say something about by the dir knip runs in.
 * -> Map(runDir -> { workspaces: Set of package dirs relative to runDir ('.' = runDir), files })
 * runDir is the nearest workspace root at or above the file's package dir, else the package dir.
 * Files under no package.json are left out.
 */
export function groupByProject(root, files, { exists = existsSync, read = readSafe } = {}) {
  const groups = new Map();
  const runDirOf = new Map();
  for (const f of files) {
    if (!RELEVANT.test(f) && basename(f) !== 'package.json') continue;
    const pkg = packageDir(root, f, exists);
    if (pkg === null) continue;
    if (!runDirOf.has(pkg)) {
      let runDir = pkg;
      for (let d = pkg; d !== null; d = parent(d)) {
        if (exists(join(root, d, 'package.json')) && isWorkspaceRoot(root, d, { exists, read })) {
          runDir = d;
          break;
        }
      }
      runDirOf.set(pkg, runDir);
    }
    const runDir = runDirOf.get(pkg);
    if (!groups.has(runDir)) groups.set(runDir, { workspaces: new Set(), files: [] });
    const g = groups.get(runDir);
    g.workspaces.add(pkg === runDir ? '.' : runDir ? pkg.slice(runDir.length + 1) : pkg);
    g.files.push(f);
  }
  return groups;
}

/** knip arguments; `--workspace` filters only when knip runs from a workspace root. */
export function knipArgs(workspaces, monorepo) {
  const args = ['--reporter', 'json', '--no-progress', '--no-exit-code', '--no-config-hints', '--no-tag-hints'];
  if (monorepo) for (const w of [...workspaces].sort()) args.push('--workspace', w);
  return args;
}

/** First JSON object in knip's stdout (a plugin may print before it); null if none. */
export function parseOutput(stdout) {
  const at = stdout.indexOf('{"issues"');
  try {
    return JSON.parse(at >= 0 ? stdout.slice(at) : stdout);
  } catch {
    return null;
  }
}

/** Does `dir` (relative to root) or any parent up to root have node_modules? */
function hasNodeModules(root, dir) {
  for (let d = dir; d !== null; d = parent(d)) {
    if (existsSync(join(root, d, 'node_modules'))) return true;
  }
  return false;
}

function readSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function knip(root, runDir, { workspaces, files }, notes) {
  const label = runDir || '.';
  if (!hasNodeModules(root, runDir)) {
    notes.push(`knip (${label}): skipped, no node_modules (run npm ci); without them knip can't tell used from unlisted dependencies or load plugin configs.`);
    return [];
  }
  const monorepo = isWorkspaceRoot(root, runDir);
  const r = await run('knip', knipArgs(workspaces, monorepo), { cwd: join(root, runDir) });
  const result = parseOutput(r.stdout);
  if (!result) {
    notes.push(`knip (${label}) failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 400)}`);
    return [];
  }
  return toFindings(result, { project: runDir, wanted: new Set(files), read: (f) => readSafe(join(root, f)) });
}

export async function analyze({ root, files }) {
  const notes = [];
  const findings = [];
  for (const [runDir, group] of groupByProject(root, files)) {
    findings.push(...(await knip(root, runDir, group, notes)));
  }
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
