// `./setup` runs this inside the gateway image (Node 24, MCR_ROOT mounted
// read-only): walk the codebase, detect its stacks, print the report to
// stderr and the .env lines to stdout. setup.sh writes .env and starts compose.
//
//   node src/setup.ts [dir ...]     default: $MCR_ROOT

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { registryFor } from './catalog.ts';
import { detect, detectionMarkdown } from './detect.ts';
import { cloudTemplates } from './git.ts';

/** Build output, dependencies and tool state: never source, often huge. */
const SKIP = new Set([
  '.git', 'node_modules', 'vendor', 'bin', 'obj', 'target', 'build', 'dist', 'out', '.next', '.nuxt', '.turbo',
  '.gradle', '.idea', '.vs', '.vscode', 'coverage', '__pycache__', '.venv', 'venv', '.tox', 'Pods', '.claude',
  'playwright-report', 'test-results', 'graphify-out', '.terraform', '.cache',
]);
const MAX_FILES = 500_000;

function walk(dir: string, root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && !e.name.startsWith('.terraform')) walk(join(dir, e.name), root, out);
    } else if (e.isFile()) out.push(relative(root, join(dir, e.name)));
  }
}

/** Node projects whose dependencies are not installed: eslint and tsc cannot run there. */
function nodeHints(root: string, projects: string[]): string[] {
  // Workspaces install once at the top, so node_modules in any parent counts.
  const installed = (p: string): boolean => {
    for (let parts = p.split('/'); ; parts = parts.slice(0, -1)) {
      if (existsSync(join(root, ...parts, 'node_modules'))) return true;
      if (parts.length === 0 || (parts.length === 1 && parts[0] === '.')) return false;
    }
  };
  return projects
    .filter((p) => !installed(p))
    .map((p) => `${p === '.' ? root : join(root, p)}: no node_modules; run npm ci (or pnpm install) there so eslint and tsc can run.`);
}

const mcrRoot = process.env.MCR_ROOT;
if (!mcrRoot) throw new Error('MCR_ROOT is not set');
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [mcrRoot];

const files: string[] = [];
const templates = new Set<string>();
const hints: string[] = [];
for (const dir of dirs) {
  const mine: string[] = [];
  walk(dir, dir, mine);
  const own = cloudTemplates(dir, mine);
  const d = detect(mine, undefined, own);
  console.error(detectionMarkdown(d, dir) + '\n');
  const node = d.stacks.find((s) => s.id === 'node');
  if (node) hints.push(...nodeHints(dir, node.projects));
  files.push(...mine.map((f) => join(dir, f)));
  for (const t of own) templates.add(join(dir, t));
}
if (files.length >= MAX_FILES) hints.push(`Stopped after ${MAX_FILES} files; pass the repos to review to ./setup to narrow it.`);

const all = detect(files, undefined, templates);
if (dirs.length > 1) console.error(detectionMarkdown(all, 'All together') + '\n');
for (const h of hints.slice(0, 10)) console.error(`⚠️  ${h}`);

const profiles = all.profiles.filter((p) => p !== 'core');
console.log(`COMPOSE_PROFILES=${profiles.join(',')}`);
console.log(`MCR_PROFILES=${profiles.join(',')}`);
console.error(`\nAnalyzers: ${registryFor(all.profiles).split(',').map((e) => e.split('=')[0]).join(', ')}`);
