// What changed in a working tree relative to a base: committed, staged,
// unstaged and untracked. The repo is mounted read-only, so git must not take
// optional locks or refresh the index.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { isCloudTemplate, TEMPLATE_CANDIDATES } from './detect.ts';
import { parseUnifiedDiff, type ChangedLines } from './diff.ts';

const exec = promisify(execFile);

const DEFAULT_BASES = ['origin/develop', 'origin/main', 'origin/master', 'develop', 'main', 'master'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'safe.directory=*', '-c', 'core.quotePath=false', ...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** The path must exist, be inside MCR_ROOT, and be (inside) a git work tree. */
export async function resolveRepo(path: string, mcrRoot: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
  const real = realpathSync(path);
  const allowed = realpathSync(mcrRoot);
  if (real !== allowed && !real.startsWith(allowed + sep)) {
    throw new Error(`${path} is outside MCR_ROOT (${mcrRoot}); widen MCR_ROOT in the compose setup to review it`);
  }
  return (await git(real, ['rev-parse', '--show-toplevel'])).trim();
}

export interface Change {
  repoRoot: string;
  base: string;
  mergeBase: string;
  head: string;
  /** Existing files that changed (not deleted), relative to repoRoot. */
  files: string[];
  /** Changed line ranges; untracked files are entirely new. */
  lines: Map<string, Array<[number, number]> | 'all'>;
}

async function pickBase(repoRoot: string, base?: string): Promise<string> {
  for (const candidate of base ? [base] : DEFAULT_BASES) {
    try {
      await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error(base ? `base ${base} not found` : `no base found; tried ${DEFAULT_BASES.join(', ')}`);
}

export async function changes(repoRoot: string, base?: string): Promise<Change> {
  const resolvedBase = await pickBase(repoRoot, base);
  const mergeBase = (await git(repoRoot, ['merge-base', resolvedBase, 'HEAD'])).trim();
  const head = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  const tracked = (await git(repoRoot, ['diff', '--name-only', '--diff-filter=d', mergeBase])).split('\n').filter(Boolean);
  const untracked = (await git(repoRoot, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const hunks: ChangedLines = parseUnifiedDiff(await git(repoRoot, ['diff', '-U0', '--no-color', '--no-ext-diff', mergeBase]));
  const lines = new Map<string, Array<[number, number]> | 'all'>();
  for (const f of tracked) lines.set(f, hunks.get(f) ?? []);
  for (const f of untracked) lines.set(f, 'all');
  return { repoRoot, base: resolvedBase, mergeBase, head, files: [...new Set([...tracked, ...untracked])], lines };
}

/** Every tracked and untracked (not ignored) file, all lines counted as in scope: a baseline audit. */
export async function everything(repoRoot: string): Promise<Change> {
  const head = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  const files = (await git(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const existing = files.filter((f) => existsSync(join(repoRoot, f)));
  return { repoRoot, base: '(whole repo)', mergeBase: head, head, files: existing, lines: new Map(existing.map((f) => [f, 'all'])) };
}

export async function gitUser(repoRoot: string): Promise<string | undefined> {
  try {
    return (await git(repoRoot, ['config', 'user.name'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Templates are small; skip lockfiles, fixtures and data dumps. */
const MAX_TEMPLATE_BYTES = 512 * 1024;
const MAX_TEMPLATE_READS = 5000;

/** Which of these JSON/YAML files are cloud templates (CloudFormation, SAM, Serverless, ARM) by content. */
export function cloudTemplates(root: string, files: string[]): Set<string> {
  const found = new Set<string>();
  const candidates = files.filter((f) => TEMPLATE_CANDIDATES.some((e) => f.endsWith(e)) && !f.includes('node_modules/') && !f.includes('.github/'));
  for (const f of candidates.slice(0, MAX_TEMPLATE_READS)) {
    try {
      const path = isAbsolute(f) ? f : join(root, f);
      if (statSync(path).size <= MAX_TEMPLATE_BYTES && isCloudTemplate(readFileSync(path, 'utf8'))) found.add(f);
    } catch {
      // Gone or unreadable: not a template we can review.
    }
  }
  return found;
}
