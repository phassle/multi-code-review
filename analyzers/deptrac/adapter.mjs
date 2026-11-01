// Architecture: deptrac, the repo's own PHP layer rules. Runs only where the
// repo has a deptrac config: for each changed .php file the nearest
// deptrac.yaml / deptrac.yml / deptrac.php from its dir up to the root. No
// config, no run (there is no sensible default layering), just a note.
//
// deptrac parses the sources (nikic/php-parser) and never runs them. A
// deptrac.php config is PHP that deptrac executes; it is loaded anyway, as
// depcruise loads .js configs and the ts analyzer ESLint configs: the container
// is read-only, has no network and drops all capabilities. YAML is preferred
// when a dir has both.
//
// Only violations are reported (high: the repo's own rules are broken, and
// `deptrac analyse` fails its CI on them). Skipped violations (the config's
// skip_violations) and uncovered dependencies (classes in no layer, mostly
// vendor and PHP built-ins; deptrac only fails on them with
// --fail-on-uncovered) are not requested. deptrac's errors and warnings are
// counted in a note; the JSON report carries no details for them.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const DEPTRAC = '/opt/deptrac/vendor/bin/deptrac';
const TMP = '/tmp/deptrac';
const PHP_ARGS = ['-d', 'memory_limit=1G', DEPTRAC];

const version = process.env.MCR_ROOT
  ? (await run('php', [...PHP_ARGS, '--version', '--no-cache', '--no-ansi'])).stdout.trim().split('\n')[0] || 'deptrac'
  : 'deptrac';

const info = { name: 'deptrac', version, languages: ['php'], extensions: ['.php'] };

export const CONFIGS = ['deptrac.yaml', 'deptrac.yml', 'deptrac.php'];
const HELP = 'https://deptrac.github.io/deptrac/';

/** Nearest dir (relative to root, '' = root) at or above `file` holding one of `names`. */
export function nearestConfig(root, file, names = CONFIGS, exists = existsSync) {
  let dir = dirname(file);
  for (;;) {
    const d = dir === '.' ? '' : dir;
    for (const n of names) if (exists(join(root, d, n))) return join(d, n);
    if (d === '') return null;
    dir = dirname(d);
  }
}

/** Changed .php files grouped by their config (repo-relative path); files without one under `null`. */
export function groupByConfig(root, files, exists = existsSync) {
  const groups = new Map();
  for (const f of files) {
    if (!f.endsWith('.php')) continue;
    const cfg = nearestConfig(root, f, CONFIGS, exists);
    if (!groups.has(cfg)) groups.set(cfg, []);
    groups.get(cfg).push(f);
  }
  return groups;
}

const VIOLATION = ' must not depend on ';
const SKIPPED = ' should not depend on ';
const UNCOVERED = ' has uncovered dependency on ';

/**
 * One message of deptrac's JSON report -> its kind and parts.
 * violation: "A must not depend on B (L1 on L2)", type error.
 * skipped:   "A should not depend on B (L1 on L2)", type warning.
 * uncovered: "A has uncovered dependency on B (L1)", type warning.
 */
export function parseMessage(m) {
  const text = String(m?.message ?? '');
  const kind = text.includes(VIOLATION)
    ? 'violation'
    : text.includes(SKIPPED)
      ? 'skipped'
      : text.includes(UNCOVERED)
        ? 'uncovered'
        : m?.type === 'error'
          ? 'violation'
          : 'other';
  const sep = { violation: VIOLATION, skipped: SKIPPED, uncovered: UNCOVERED }[kind];
  if (!sep || !text.includes(sep)) return { kind, text };
  const at = text.indexOf(sep);
  const depender = text.slice(0, at);
  let rest = text.slice(at + sep.length);
  let layers = '';
  if (rest.endsWith(')') && rest.lastIndexOf(' (') > 0) {
    layers = rest.slice(rest.lastIndexOf(' (') + 2, -1);
    rest = rest.slice(0, rest.lastIndexOf(' ('));
  }
  const [from, to] = layers.split(' on ');
  return { kind, text, depender, dependent: rest, fromLayer: from || undefined, toLayer: to || undefined };
}

/**
 * deptrac JSON report -> findings for the files under review.
 * Paths in the report are absolute; `wanted` holds repo-relative paths.
 * config: repo-relative config path, named in the message.
 */
export function toFindings(report, { root, wanted, config }) {
  const findings = [];
  const seen = new Set();
  for (const [path, entry] of Object.entries(report?.files ?? {})) {
    const file = isAbsolute(path) ? relative(root, path) : path;
    if (!wanted.has(file)) continue;
    for (const m of entry?.messages ?? []) {
      const p = parseMessage(m);
      if (p.kind !== 'violation') continue;
      const line = Number.isInteger(m.line) && m.line > 0 ? m.line : 1;
      const key = `${file}|${line}|${p.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const why = p.fromLayer && p.toLayer
        ? `${config}'s ruleset does not allow layer ${p.fromLayer} to depend on layer ${p.toLayer}.`
        : `${config}'s ruleset forbids this dependency.`;
      findings.push({
        ruleId: 'layer-violation',
        message: `${p.depender && p.dependent ? `${p.depender} must not depend on ${p.dependent}` : p.text}: ${why} Depend on an allowed layer instead, or change the ruleset.`,
        file,
        line,
        category: 'architecture',
        severity: 'high',
        helpUri: HELP,
      });
    }
  }
  return findings;
}

/** Note text for deptrac's error and warning counts (the JSON report has no details). */
export function countsNote(report, config) {
  const r = report?.Report ?? {};
  const parts = [];
  if (r.Errors > 0) parts.push(`${r.Errors} error(s)`);
  if (r.Warnings > 0) parts.push(`${r.Warnings} warning(s)`);
  return parts.length ? `deptrac (${config}): ${parts.join(', ')}; run \`deptrac analyse\` locally for details` : null;
}

const oneLine = (s, root) => String(s).split(root + '/').join('').replace(/\s+/g, ' ').trim().slice(0, 400);

async function deptrac(root, config, files, notes) {
  mkdirSync(TMP, { recursive: true });
  const out = join(TMP, `report-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    // --no-cache: the repo is read-only and deptrac otherwise writes .deptrac.cache next to it.
    const r = await run(
      'php',
      [...PHP_ARGS, 'analyse', `--config-file=${join(root, config)}`, '--formatter=json', `--output=${out}`, '--no-progress', '--no-cache', '--no-ansi', '--no-interaction'],
      { cwd: join(root, dirname(config)), env: { ...process.env, HOME: '/tmp', TMPDIR: '/tmp' } },
    );
    let report;
    try {
      report = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      notes.push(`deptrac (${config}) failed (exit ${r.code}): ${oneLine(r.stderr || r.stdout, root)}`);
      return [];
    }
    notes.push(`deptrac: using the repo's ${config}`);
    const counts = countsNote(report, config);
    if (counts) notes.push(counts);
    return toFindings(report, { root, wanted: new Set(files), config });
  } finally {
    rmSync(out, { force: true });
  }
}

export async function analyze({ root, files }) {
  const notes = [];
  const findings = [];
  for (const [config, group] of groupByConfig(root, files.filter((f) => existsSync(join(root, f))))) {
    if (config === null) {
      notes.push(`deptrac: no deptrac.yaml/deptrac.yml/deptrac.php at or above ${group.length} changed PHP file(s); layer rules not checked`);
      continue;
    }
    findings.push(...(await deptrac(root, config, group, notes)));
  }
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
