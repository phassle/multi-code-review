// Architecture: go-arch-lint, the repo's own component rules (.go-arch-lint.yml
// in the module root, next to go.mod). No default config: without the repo's
// arch file there is no architecture to check, so such a module only gets a note.
//
// Warnings, each reported only in files under review:
// - deps (high): a component imports a package its `mayDependOn`/`canUse` does
//   not allow. Reported on the import line. `go-arch-lint check` fails on it,
//   so the repo's own CI would too.
// - deep-scan (high): an implementation from a forbidden component is injected
//   into a component's public function (deep scan, on by default in arch v3).
//   Reported where it is injected (the call argument). go-arch-lint runs it
//   only once the import rules pass.
// - not-matched (medium): a Go file outside every component. The code may be
//   fine; the arch file lacks a component for it, so the rules silently skip it.
//   `go-arch-lint check` fails on it too, but it is a gap in coverage, not a
//   broken dependency, so it only blocks at level maximum.
//
// Imports are checked from the AST alone; the deep scan loads typed packages
// with the go command. The repo is read-only and there is no network, so
// modules come from the repo's vendor/ or the host's module cache
// (MCR_GOMODCACHE, mounted read-only at the same path), and go.mod/go.sum are
// copied to /tmp (-modfile), as in analyzers/go.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const version = process.env.MCR_ROOT ? (await run('go-arch-lint', ['version', '--json', '--output-json-one-line'])).stdout : '';

/** `go-arch-lint version --json` -> "1.19.1" (or the raw text). */
export function parseVersion(text) {
  try {
    return JSON.parse(text)?.Payload?.LinterVersion || 'go-arch-lint';
  } catch {
    return String(text ?? '').trim() || 'go-arch-lint';
  }
}

const info = { name: 'go-arch-lint', version: parseVersion(version), languages: ['go'], extensions: ['.go'] };

export const ARCH_FILE = '.go-arch-lint.yml';
const HELP = 'https://github.com/fe3dback/go-arch-lint/blob/master/docs/syntax/README.md';
const MAX_WARNINGS = 32768; // the tool's upper bound

/** Nearest directory at or above `dir` (but not above root) holding go.mod. */
export function moduleRoot(root, dir, exists = existsSync) {
  for (let d = dir; ; d = dirname(d)) {
    if (exists(join(d, 'go.mod'))) return d;
    if (d === root || !d.startsWith(root + sep)) return undefined;
  }
}

/** Requested .go files -> { groups: Map(moduleDir -> files), orphans }. */
export function groupByModule(root, files, exists = existsSync) {
  const groups = new Map();
  const orphans = [];
  for (const f of files) {
    if (!f.endsWith('.go')) continue;
    const mod = moduleRoot(root, dirname(resolve(root, f)), exists);
    if (!mod) {
      orphans.push(f);
      continue;
    }
    if (!groups.has(mod)) groups.set(mod, []);
    groups.get(mod).push(f);
  }
  return { groups, orphans };
}

/**
 * go-arch-lint's `check --json` payload -> findings in the requested files,
 * paths relative to root. mod: module dir (absolute); paths in the report are
 * absolute, or relative to mod with a leading slash.
 */
export function toFindings(json, { root, mod, wanted }) {
  const p = json?.Payload ?? {};
  const norm = (f) => relative(root, resolve(root, f)).split(sep).join('/');
  const keep = new Set(wanted.map(norm));
  const fileOf = (abs, rel) => {
    if (abs && isAbsolute(abs)) return norm(abs);
    if (rel) return norm(join(mod, rel));
    return undefined;
  };
  const findings = [];
  const seen = new Set();
  const add = (f) => {
    if (!f.file || !keep.has(f.file)) return;
    const key = `${f.ruleId}|${f.file}|${f.line}|${f.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ...f, category: 'architecture', helpUri: HELP });
  };
  for (const w of p.ArchWarningsDeps ?? []) {
    const ref = w.Reference ?? {};
    add({
      ruleId: 'deps',
      ruleName: 'component dependency',
      message: `Component '${w.ComponentName}' may not depend on '${w.ResolvedImportName}': .go-arch-lint.yml does not allow it (go-arch-lint check fails). Remove the import, or allow it in the component's mayDependOn/canUse if the dependency is intended.`,
      file: fileOf(ref.Valid !== false ? ref.File : undefined, undefined) ?? fileOf(w.FileAbsolutePath, w.FileRelativePath),
      line: ref.Valid !== false && ref.Line > 0 ? ref.Line : 1,
      ...(ref.Valid !== false && ref.Offset > 0 ? { column: ref.Offset } : {}),
      severity: 'high',
    });
  }
  for (const w of p.ArchWarningsDeepScan ?? []) {
    const gate = w.Gate ?? {};
    const dep = w.Dependency ?? {};
    const at = dep.Injection ?? {};
    add({
      ruleId: 'deep-scan',
      ruleName: 'injected dependency',
      message: `Component '${gate.ComponentName}' may not depend on component '${dep.ComponentName}', but ${dep.Name}${dep.InjectionAST ? ` (${dep.InjectionAST})` : ''} is passed to its ${gate.MethodName}: .go-arch-lint.yml does not allow it (go-arch-lint check fails). Inject an implementation from an allowed component, or allow the dependency.`,
      file: fileOf(at.File, undefined),
      line: at.Line > 0 ? at.Line : 1,
      ...(at.Offset > 0 ? { column: at.Offset } : {}),
      severity: 'high',
    });
  }
  for (const w of p.ArchWarningsNotMatched ?? []) {
    add({
      ruleId: 'not-matched',
      ruleName: 'file outside components',
      message: `This file is in no component of .go-arch-lint.yml, so its imports are not checked (go-arch-lint check fails). Add its package to a component, or to exclude.`,
      file: fileOf(w.FileAbsolutePath, w.FileRelativePath),
      line: 1,
      severity: 'medium',
    });
  }
  return findings;
}

/** Notes from the report: arch file problems, truncation. */
export function reportNotes(json, { root, mod }) {
  const p = json?.Payload ?? {};
  const where = relative(root, mod) || '.';
  const notes = [];
  for (const n of p.ExecutionWarnings ?? []) {
    const at = n.File ? ` (${relative(root, n.File) || n.File}${n.Line ? `:${n.Line}` : ''})` : '';
    notes.push(`go-arch-lint (${where}): ${String(n.Text ?? '').trim()}${at}`);
  }
  if (p.OmittedCount > 0) notes.push(`go-arch-lint (${where}): ${p.OmittedCount} warnings omitted; findings may be incomplete`);
  return notes;
}

/** Load errors that mean the module's dependencies are not available offline. */
export function missingDeps(text) {
  return /module lookup disabled by GOPROXY=off|cannot find module providing package|missing go\.sum entry|no required module provides package|inconsistent vendoring|could not import|cannot query module|go: updates to go\.mod needed/.test(text);
}

/** The JSON document in go-arch-lint's stdout, or undefined. */
export function parseReport(stdout) {
  const text = String(stdout ?? '').trim();
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  try {
    const json = JSON.parse(text.slice(start));
    return json?.Type === 'models.Check' ? json : undefined;
  } catch {
    return undefined;
  }
}

/** Does go.mod require modules (anything beyond the standard library)? */
export function hasRequires(goMod) {
  return /^\s*require\b/m.test(String(goMod ?? ''));
}

/**
 * The deep scan swallows load errors: with dependencies missing it just finds
 * less. So say up front when they can't be there (no vendor/, no module cache).
 */
function depsNote(root, mod) {
  if (existsSync(join(mod, 'vendor/modules.txt'))) return undefined;
  const cache = process.env.MCR_GOMODCACHE;
  if (cache && existsSync(cache)) return undefined;
  let goMod = '';
  try {
    goMod = readFileSync(join(mod, 'go.mod'), 'utf8');
  } catch {
    return undefined;
  }
  if (!hasRequires(goMod)) return undefined;
  return `go-arch-lint (${relative(root, mod) || '.'}): no vendor/ and no module cache (MCR_GOMODCACHE); the deep scan can't type-check code using dependencies and may miss injected dependencies. Import rules are checked fully.`;
}

function goEnv(mod) {
  const tmp = join('/tmp/mcr-go', createHash('sha1').update(mod).digest('hex').slice(0, 12));
  mkdirSync(tmp, { recursive: true });
  let flags;
  if (existsSync(join(mod, 'vendor/modules.txt'))) flags = '-mod=vendor';
  else {
    copyFileSync(join(mod, 'go.mod'), join(tmp, 'go.mod'));
    if (existsSync(join(mod, 'go.sum'))) copyFileSync(join(mod, 'go.sum'), join(tmp, 'go.sum'));
    flags = `-mod=mod -modfile=${join(tmp, 'go.mod')}`;
  }
  return { ...process.env, GOFLAGS: flags, GOMODCACHE: process.env.MCR_GOMODCACHE || '/tmp/gomodcache' };
}

async function checkModule(root, mod, files, notes) {
  const where = relative(root, mod) || '.';
  const args = ['check', '--project-path', mod, '--json', '--output-json-one-line', '--output-color=false', `--max-warnings=${MAX_WARNINGS}`];
  // Exit 1 just means warnings; the JSON says what they are.
  const result = await run('go-arch-lint', args, { cwd: mod, env: goEnv(mod) });
  const json = parseReport(result.stdout);
  if (!json) {
    const why = `${result.stderr}\n${result.stdout}`.trim();
    notes.push(
      missingDeps(why)
        ? `go-arch-lint (${where}): dependencies are missing offline (deep scan loads typed packages); run go mod download on the host. ${why.slice(0, 300)}`
        : `go-arch-lint failed in ${where} (exit ${result.code}): ${why.slice(0, 400)}`,
    );
    return [];
  }
  notes.push(...reportNotes(json, { root, mod }));
  // The deep scan only runs once the import rules pass.
  const imports = (json.Payload?.ArchWarningsDeps?.length ?? 0) + (json.Payload?.ArchWarningsNotMatched?.length ?? 0);
  const deep = json.Payload?.Qualities?.some((q) => q.ID === 'deepscan' && q.Used);
  const note = deep && imports === 0 ? depsNote(root, mod) : undefined;
  if (note) notes.push(note);
  return toFindings(json, { root, mod, wanted: files });
}

export async function analyze({ root, files }) {
  const targets = files.filter((f) => f.endsWith('.go'));
  if (targets.length === 0) return { findings: [], notes: [] };
  const notes = [];
  const findings = [];
  const { groups, orphans } = groupByModule(root, targets);
  if (orphans.length) notes.push(`go-arch-lint: no go.mod found for ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ', ...' : ''}`);
  for (const [mod, group] of groups) {
    if (!existsSync(join(mod, ARCH_FILE))) {
      notes.push(`go-arch-lint (${relative(root, mod) || '.'}): no ${ARCH_FILE} next to go.mod; architecture not checked`);
      continue;
    }
    findings.push(...(await checkModule(root, mod, group, notes)));
  }
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
