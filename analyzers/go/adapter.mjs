// Go: golangci-lint. The repo's own config when it has one (its config is the
// norm), else a default set of linters. Go analysis loads the packages and their
// dependencies; the repo is read-only and there is no network, so modules come
// from the repo's vendor/ or the host's module cache (MCR_GOMODCACHE, mounted
// read-only at the same path). go.mod/go.sum are copied to /tmp (-modfile) so
// the go command may update them without writing to the repo.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const version = (await run('golangci-lint', ['version', '--short'])).stdout.trim() || 'golangci-lint';

const info = { name: 'golangci-lint', version, languages: ['go'], extensions: ['.go'] };

const REPO_CONFIGS = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'];

export const DEFAULT_LINTERS = ['govet', 'staticcheck', 'errcheck', 'ineffassign', 'unused', 'gosec', 'bodyclose', 'contextcheck', 'noctx', 'sqlclosecheck', 'rowserrcheck', 'errorlint', 'nilerr'];

export const DEFAULT_CONFIG = `version: "2"
run:
  relative-path-mode: wd
  tests: true
linters:
  default: none
  enable: [${DEFAULT_LINTERS.join(', ')}]
issues:
  max-issues-per-linter: 0
  max-same-issues: 0
`;

const CORRECTNESS = new Set(['govet', 'typecheck', 'nilerr', 'errorlint']);
const RELIABILITY = new Set(['errcheck', 'bodyclose', 'contextcheck', 'noctx', 'sqlclosecheck', 'rowserrcheck']);

/** Leading check code in an issue text: "SA4006: ..." or "G104: ...". */
export function ruleCode(text) {
  return /^([A-Z]+\d+):/.exec(String(text ?? ''))?.[1];
}

export function goCategory(linter, text) {
  if (linter === 'gosec') return 'security';
  if (linter === 'staticcheck') return /^SA\d/.test(ruleCode(text) ?? '') ? 'correctness' : 'best-practices';
  if (CORRECTNESS.has(linter)) return 'correctness';
  if (RELIABILITY.has(linter)) return 'reliability';
  return 'best-practices';
}

export function goSeverity(linter, category, severity) {
  const s = String(severity ?? '').toLowerCase();
  if (linter === 'gosec') return ['high', 'medium', 'low'].includes(s) ? s : 'medium';
  if (linter === 'typecheck') return 'high';
  return category === 'correctness' ? 'medium' : 'low';
}

/** Nearest directory at or above `dir` (but not above root) holding go.mod. */
export function moduleRoot(root, dir, exists = existsSync) {
  for (let d = dir; ; d = dirname(d)) {
    if (exists(join(d, 'go.mod'))) return d;
    if (d === root || !d.startsWith(root + sep)) return undefined;
  }
}

/** Requested .go files -> Map(moduleDir -> sorted package patterns relative to it). */
export function groupPackages(root, files, exists = existsSync) {
  const groups = new Map();
  const orphans = [];
  for (const f of files) {
    if (!f.endsWith('.go')) continue;
    const dir = dirname(resolve(root, f));
    const mod = moduleRoot(root, dir, exists);
    if (!mod) {
      orphans.push(f);
      continue;
    }
    const rel = relative(mod, dir);
    const pkg = rel === '' ? '.' : `./${rel.split(sep).join('/')}`;
    if (!groups.has(mod)) groups.set(mod, new Set());
    groups.get(mod).add(pkg);
  }
  return { groups: new Map([...groups].map(([m, p]) => [m, [...p].sort()])), orphans };
}

/** golangci-lint's JSON report -> findings in the requested files, paths relative to root. */
export function parseGolangci(json, root, cwd, wanted) {
  const norm = (f) => relative(root, resolve(root, f)).split(sep).join('/');
  const keep = new Set(wanted.map(norm));
  const findings = [];
  for (const i of json?.Issues ?? []) {
    const name = i.Pos?.Filename;
    if (!name) continue;
    const file = norm(isAbsolute(name) ? name : resolve(cwd, name));
    if (!keep.has(file)) continue;
    const linter = i.FromLinter ?? 'golangci-lint';
    if (linter === 'typecheck') {
      // Compiler errors arrive as one issue at line 1 whose text lists
      // "./file.go:line:col: message" lines; split them into real locations.
      const located = [...String(i.Text ?? '').matchAll(/^\s*(\S+?\.go):(\d+):(?:(\d+):)? (.+)$/gm)];
      if (located.length) {
        for (const [, path, line, column, message] of located) {
          const f = norm(isAbsolute(path) ? path : resolve(cwd, path));
          if (keep.has(f)) findings.push({ ruleId: 'typecheck', message: message.trim(), file: f, line: Number(line), ...(column ? { column: Number(column) } : {}), category: 'correctness', severity: 'high' });
        }
        continue;
      }
    }
    const code = ruleCode(i.Text);
    const category = goCategory(linter, i.Text);
    findings.push({
      ruleId: code ? `${linter}/${code}` : linter,
      message: String(i.Text ?? linter).trim(),
      file,
      line: i.Pos.Line || 1,
      ...(i.LineRange?.To > i.Pos.Line ? { endLine: i.LineRange.To } : {}),
      ...(i.Pos.Column ? { column: i.Pos.Column } : {}),
      category,
      severity: goSeverity(linter, category, i.Severity),
      helpUri: `https://golangci-lint.run/docs/linters/configuration/#${linter}`,
    });
  }
  return findings;
}

/** Load errors that mean the module's dependencies are not available offline. */
export function missingDeps(text) {
  return /module lookup disabled by GOPROXY=off|cannot find module providing package|missing go\.sum entry|no required module provides package|inconsistent vendoring|could not import|cannot query module|go: updates to go\.mod needed/.test(text);
}

function findConfig(root, mod) {
  for (let d = mod; ; d = dirname(d)) {
    const hit = REPO_CONFIGS.find((c) => existsSync(join(d, c)));
    if (hit) return join(d, hit);
    if (d === root || !d.startsWith(root + sep)) return undefined;
  }
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

async function lintModule(root, mod, pkgs, notes) {
  const defaultConfig = '/tmp/mcr-go/golangci.yml';
  mkdirSync(dirname(defaultConfig), { recursive: true });
  writeFileSync(defaultConfig, DEFAULT_CONFIG);
  const own = findConfig(root, mod);
  const args = (config) => ['run', '--config', config, '--output.json.path=stdout', '--show-stats=false', '--issues-exit-code=0', '--path-mode=abs', '--timeout=5m', ...pkgs];
  const env = goEnv(mod);
  let result = await run('golangci-lint', args(own ?? defaultConfig), { cwd: mod, env });
  if (own && !result.stdout.trim().startsWith('{')) {
    notes.push(`golangci-lint: the repo's ${relative(root, own)} failed (${result.stderr.trim().split('\n')[0].slice(0, 200)}); used the default linters instead`);
    result = await run('golangci-lint', args(defaultConfig), { cwd: mod, env });
  } else if (own) notes.push(`golangci-lint: using the repo's config ${relative(root, own)}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim().split('\n').find((l) => l.startsWith('{')) ?? '');
  } catch {
    parsed = undefined;
  }
  const typeErrors = (parsed?.Issues ?? []).filter((i) => i.FromLinter === 'typecheck').map((i) => i.Text).join('\n');
  if (missingDeps(`${result.stderr}\n${typeErrors}`)) {
    notes.push(`golangci-lint: dependencies of ${relative(root, mod) || '.'} are missing offline; run go mod download on the host (findings may be incomplete)`);
  }
  if (!parsed) {
    notes.push(`golangci-lint failed in ${relative(root, mod) || '.'} (exit ${result.code}): ${result.stderr.trim().slice(0, 400)}`);
    return { json: undefined };
  }
  return { json: parsed };
}

async function analyze({ root, files }) {
  const targets = files.filter((f) => f.endsWith('.go'));
  if (targets.length === 0) return { findings: [], notes: [] };
  const notes = [];
  const { groups, orphans } = groupPackages(root, targets);
  if (orphans.length) notes.push(`golangci-lint: no go.mod found for ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ', ...' : ''}`);
  const findings = [];
  // Sequentially: each run already uses all CPUs and type-checks the dependencies.
  for (const [mod, pkgs] of groups) {
    const { json } = await lintModule(root, mod, pkgs, notes);
    if (json) findings.push(...parseGolangci(json, root, mod, targets));
  }
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
