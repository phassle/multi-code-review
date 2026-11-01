// Dependencies: osv-scanner over the lockfiles and manifests under review,
// against the OSV database (GitHub advisories, PyPI, Go, RustSec, ... and
// OpenSSF malicious packages). Fully offline: the database is baked into the
// image at build (rebuild to refresh; info.version says how old it is), and
// osv-scanner runs with --offline, so manifests are read as written, without
// resolving transitive dependencies from a registry.
//
// MAL-* advisories (known malicious packages) are always high: assistants add
// dependencies, sometimes typo'd or hallucinated names that attackers have
// registered. Each finding sits on the lockfile line of that package@version,
// so a newly added dependency lands on a changed line.

import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const DB = process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY ?? '/opt/osv-db';

/** Newest Last-Modified of the baked ecosystem zips (ADD keeps it as mtime), as YYYY-MM-DD. */
function dbDate() {
  try {
    const dir = join(DB, 'osv-scalibr');
    const times = readdirSync(dir).map((e) => statSync(join(dir, e, 'all.zip')).mtimeMs);
    return new Date(Math.max(...times)).toISOString().slice(0, 10);
  } catch {
    return 'unknown';
  }
}

const date = process.env.MCR_ROOT ? dbDate() : 'unknown';
const tool = process.env.MCR_ROOT ? (await run('osv-scanner', ['--version'])).stdout.match(/osv-scanner version: (\S+)/)?.[1] : undefined;
const version = `osv-scanner ${tool ?? '?'}, db ${date}`;

const info = { name: 'osv', version, languages: ['any'], extensions: ['*'] };

// Basenames osv-scanner 2.7 extracts from a lockfile or manifest.
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock',
  'Pipfile.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', 'pylock.toml',
  'go.mod', 'Cargo.lock', 'Gemfile.lock', 'gems.locked', 'composer.lock',
  'packages.lock.json', 'packages.config',
  'gradle.lockfile', 'buildscript-gradle.lockfile', 'pom.xml',
  'pubspec.lock', 'mix.lock', 'renv.lock', 'Package.resolved',
]);
// requirements.txt, requirements-dev.txt, dev-requirements.txt, requirements/base.txt
const REQUIREMENTS = /(^|\/)([\w.-]*requirements[\w.-]*\.txt|requirements\/[\w.-]+\.txt)$/i;

/** -L argument for a file osv-scanner can read, else undefined. Requirements variants name their parser. */
export function lockfileArg(file) {
  const name = basename(file);
  if (name === 'requirements.txt' || LOCKFILES.has(name) || /(^|\/)gradle\/verification-metadata\.xml$/.test(file)) return file;
  if (REQUIREMENTS.test(file)) return `requirements.txt:${file}`;
  return undefined;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name as it is spelled in a lockfile: Maven by artifactId, PyPI with - _ . interchangeable. */
function namePattern(name, ecosystem) {
  const n = ecosystem === 'Maven' && name.includes(':') ? name.split(':').pop() : name;
  const body = ecosystem === 'PyPI' ? n.split(/[-_.]+/).map(escape).join('[-_.]+') : escape(n);
  return new RegExp(`(^|[^\\w.@/-]|node_modules/|^\\s*/|[\\s"']/)${body}(?![\\w.-])`, 'i');
}

const versionPattern = (v) => new RegExp(`(^|[^\\w.])v?${escape(v)}(?![\\w.])`);

// npm lockfiles also name a package in the root's dependency list
// (`"lodash": "^4.17.15"`); its own entry is the line to point at.
const npmEntry = (body) => new RegExp(`node_modules/${body}"|^\\s*"?/?${body}@|^\\s*/${body}/`, 'i');

/**
 * 1-based line of package@version in a lockfile: a line naming the package
 * with the version on it or within the next few lines (lockfiles put the
 * version just below the name), for npm its own entry first; else the first
 * line naming it; else 1.
 */
export function locate(text, name, version, ecosystem) {
  const lines = text.split('\n');
  const n = namePattern(name, ecosystem);
  const v = version ? versionPattern(version) : undefined;
  const hits = [];
  let first;
  for (let i = 0; i < lines.length; i++) {
    if (!n.test(lines[i])) continue;
    first ??= i + 1;
    for (let j = i; j < Math.min(lines.length, i + 8); j++) {
      if (j > i && n.test(lines[j])) break;
      if (!v || v.test(lines[j])) {
        hits.push(i);
        break;
      }
    }
  }
  if (ecosystem === 'npm') {
    const entry = npmEntry(escape(name));
    const i = hits.find((h) => entry.test(lines[h]));
    if (i !== undefined) return i + 1;
  }
  return hits.length ? hits[0] + 1 : (first ?? 1);
}

/** Numeric-ish version compare, enough to pick the nearest fixed version. */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).replace(/^v/, '').split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Lowest fixed version above the installed one, from the advisory's ranges for this package. */
export function fixedVersion(vuln, pkg) {
  const fixed = [];
  for (const a of vuln?.affected ?? []) {
    if (a.package?.name !== pkg.name || a.package?.ecosystem !== pkg.ecosystem) continue;
    for (const r of a.ranges ?? []) {
      if (r.type === 'GIT') continue;
      for (const e of r.events ?? []) if (e.fixed) fixed.push(e.fixed);
    }
  }
  const above = fixed.filter((f) => compareVersions(f, pkg.version) > 0).sort(compareVersions);
  return above[0];
}

/** high | medium | low from MAL-, CVSS score and the database's own rating. */
export function severityOf(ids, maxSeverity, dbSeverity) {
  if (ids.some((id) => id.startsWith('MAL-'))) return 'high';
  const score = Number.parseFloat(maxSeverity);
  const db = String(dbSeverity ?? '').toUpperCase();
  if ((Number.isFinite(score) && score >= 7) || db === 'HIGH' || db === 'CRITICAL') return 'high';
  if (Number.isFinite(score)) return score >= 4 ? 'medium' : 'low';
  if (db === 'LOW') return 'low';
  return 'medium';
}

/** Stable rule id for a group of aliases: MAL-, then GHSA-, then the first OSV id. */
export function primaryId(ids) {
  return ids.find((i) => i.startsWith('MAL-')) ?? ids.find((i) => i.startsWith('GHSA-')) ?? ids[0];
}

const oneLine = (s, max = 160) => {
  const t = String(s ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * osv-scanner JSON -> findings. `root` relativizes source paths; `read(file)`
 * returns a lockfile's text (for line numbers). One finding per package and
 * advisory group (a group folds aliases such as GHSA/CVE/PYSEC together).
 */
export function toFindings(report, root, read) {
  const findings = [];
  for (const result of report?.results ?? []) {
    const path = result.source?.path ?? '';
    const file = path.startsWith(`${root}/`) ? relative(root, path) : path;
    let text;
    try {
      text = read(file);
    } catch {
      text = '';
    }
    for (const p of result.packages ?? []) {
      const pkg = p.package ?? {};
      const vulns = new Map((p.vulnerabilities ?? []).map((v) => [v.id, v]));
      for (const g of p.groups ?? []) {
        const ids = [...new Set([...(g.ids ?? []), ...(g.aliases ?? [])])];
        if (ids.length === 0) continue;
        const ruleId = primaryId(g.ids?.length ? g.ids : ids);
        const vuln = vulns.get(ruleId) ?? (g.ids ?? []).map((id) => vulns.get(id)).find(Boolean);
        const malicious = ids.some((id) => id.startsWith('MAL-'));
        const summary = oneLine(vuln?.summary || vuln?.details) || 'known vulnerability';
        const fix = malicious ? undefined : fixedVersion(vuln, pkg);
        const others = ids.filter((id) => id !== ruleId).slice(0, 3);
        const label = `${pkg.name}@${pkg.version} (${pkg.ecosystem})`;
        const message = malicious
          ? `${label} is a known malicious package: ${summary} [${ruleId}]. Remove it, check that the name is the one you meant (typosquats and invented names get registered), and rotate secrets on machines that installed it.`
          : `${label}: ${summary} [${[ruleId, ...others].join(', ')}]. ${fix ? `Upgrade to ${fix} or later.` : 'No fixed version known; replace the package or mitigate.'}`;
        findings.push({
          ruleId,
          ruleName: summary,
          message,
          file,
          line: locate(text, pkg.name ?? '', pkg.version ?? '', pkg.ecosystem),
          category: 'security',
          severity: severityOf(ids, g.max_severity, vuln?.database_specific?.severity),
          helpUri: `https://osv.dev/vulnerability/${ruleId}`,
        });
      }
    }
  }
  return findings;
}

/** One osv-scanner run over some -L args; the parsed report, or an error string. */
async function scan(root, args) {
  const report = `/tmp/osv-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  try {
    const r = await run(
      'osv-scanner',
      ['scan', 'source', '--offline', '--offline-vulnerabilities', '--format', 'json', '--output-file', report, '--verbosity', 'error', ...args.flatMap((a) => ['-L', a])],
      { cwd: root, env: { ...process.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: DB } },
    );
    // 0: nothing found, 1: vulnerabilities found, 128: no packages in the files.
    if (r.code === 128) return { results: [] };
    if (r.code !== 0 && r.code !== 1) return `exit ${r.code}: ${r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`;
    return JSON.parse(readFileSync(report, 'utf8'));
  } finally {
    rmSync(report, { force: true });
  }
}

async function analyze({ root, files }) {
  const args = files.map(lockfileArg).filter(Boolean);
  if (args.length === 0) return { findings: [], notes: [] };
  const notes = [];
  // One unreadable file fails the whole run, so on failure each file gets its
  // own (one after the other: each run loads its ecosystems' database).
  let reports = [await scan(root, args)];
  if (typeof reports[0] === 'string' && args.length > 1) {
    reports = [];
    for (const a of args) reports.push(await scan(root, [a]));
  }
  reports.forEach((r, i) => {
    if (typeof r === 'string') notes.push(`osv: could not scan ${reports.length > 1 ? args[i] : args.join(', ')} (${r})`);
  });
  // root is already a realpath (checkRequest); osv-scanner reports absolute paths under it.
  const read = (f) => readFileSync(join(root, f), 'utf8');
  const findings = reports.filter((r) => typeof r !== 'string').flatMap((r) => toFindings(r, root, read));
  const age = (Date.now() - Date.parse(date)) / 86_400_000;
  if (age > 14) notes.push(`osv: vulnerability database is from ${date} (${Math.floor(age)} days old); rebuild the image to refresh it`);
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
