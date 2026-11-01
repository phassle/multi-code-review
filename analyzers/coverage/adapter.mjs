// Diff coverage: changed lines that no test executes. It reads the coverage
// reports the repo's own test run already wrote (locally, or in CI's prepare
// step): lcov, Cobertura (coverage.py, coverlet/.NET, others), JaCoCo, Go cover
// profiles and SimpleCov. Each report path is mapped to a repo file, and every
// changed line the report calls executable but never hit is reported, one
// finding per contiguous uncovered range. Pure Node, no tool binary.
//
// It never runs tests or any repo code, and never writes coverage itself: no
// report means no findings, just a note. A report older than the file it would
// judge is skipped, since its line numbers may no longer fit. Medium severity
// on purpose: shown at the default level, blocking only where a team sets
// testing to `maximum`.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';
import { serve } from '../_kit/serve.mjs';

const info = { name: 'coverage', version: 'coverage-1', languages: ['any'], extensions: ['*'] };

const MAX_DEPTH = 7;
const MAX_ENTRIES = 50_000;
const MAX_REPORTS = 25;
const MAX_REPORT_BYTES = 100_000_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', '.venv', 'venv', '.tox', '__pycache__', 'bower_components', '.gradle', '.idea', '.vs', 'obj']);
const TEST_PATH = /(^|\/)(tests?|__tests__|__mocks__|spec|specs|testdata|e2e)\/|[._-](test|spec)s?\.[^/]+$|_test\.go$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|kts|cs|scala|groovy|swift)$|Spec\.(groovy|scala|kt)$/;
// Cheap filter before a file's head is read; detectFormat decides.
const REPORT_NAME = /(^|\/)(lcov\.info|[^/]*\.lcov|\.resultset\.json|cover\.out|coverage\.out|c\.out|[^/]*\.coverprofile|coverage\.xml|[^/]*cobertura[^/]*\.xml|jacoco[^/]*\.xml)$|(^|\/)build\/reports\/jacoco\/.*\.xml$/i;
const SOURCE = /\.(m?[jt]sx?|cjs|cts|mts|py|go|java|kt|kts|scala|groovy|cs|vb|fs|rb|php|c|cc|cpp|cxx|h|hh|hpp|rs|swift|dart|ex|exs|erl|lua|svelte|vue)$/i;

// ---------------------------------------------------------------- parsers
// Every parser returns records: { path, lines: Map<line, hits> }. A line in the
// map is executable; hits 0 means no test ran it.

function addHits(lines, line, hits) {
  if (!Number.isInteger(line) || line < 1 || !Number.isFinite(hits)) return;
  lines.set(line, Math.max(lines.get(line) ?? 0, hits));
}

/** lcov tracefile: SF:<path>, DA:<line>,<hits>[,<checksum>], end_of_record. */
export function parseLcov(text) {
  const records = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('SF:')) {
      cur = { path: l.slice(3), lines: new Map() };
      records.push(cur);
    } else if (l.startsWith('DA:') && cur) {
      const [line, hits] = l.slice(3).split(',');
      addHits(cur.lines, Number(line), Number(hits));
    } else if (l === 'end_of_record') cur = null;
  }
  return records;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unxml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()],
  );
}

// One literal pattern per attribute the parsers read (no regex built from input).
const ATTRS = {
  filename: /\sfilename\s*=\s*(?:"([^"]*)"|'([^']*)')/,
  number: /\snumber\s*=\s*(?:"([^"]*)"|'([^']*)')/,
  hits: /\shits\s*=\s*(?:"([^"]*)"|'([^']*)')/,
  name: /\sname\s*=\s*(?:"([^"]*)"|'([^']*)')/,
  nr: /\snr\s*=\s*(?:"([^"]*)"|'([^']*)')/,
  mi: /\smi\s*=\s*(?:"([^"]*)"|'([^']*)')/,
  ci: /\sci\s*=\s*(?:"([^"]*)"|'([^']*)')/,
};

function attr(tag, name) {
  const m = tag.match(ATTRS[name]);
  return m ? unxml(m[1] ?? m[2]) : undefined;
}

/** Cobertura XML: <source> roots plus <class filename> with <line number hits>. */
export function parseCobertura(text) {
  const sources = [...text.matchAll(/<source>([^<]*)<\/source>/g)].map((m) => unxml(m[1].trim())).filter(Boolean);
  const byPath = new Map();
  for (const m of text.matchAll(/<class\b([^>]*?)(\/?)>/g)) {
    const path = attr(m[1], 'filename');
    if (!path) continue;
    let rec = byPath.get(path);
    if (!rec) byPath.set(path, (rec = { path, lines: new Map() }));
    if (m[2] === '/') continue;
    const end = text.indexOf('</class>', m.index);
    const body = text.slice(m.index, end < 0 ? undefined : end);
    for (const l of body.matchAll(/<line\b([^>]*)>/g)) {
      addHits(rec.lines, Number(attr(l[1], 'number')), Number(attr(l[1], 'hits')));
    }
  }
  return { sources, records: [...byPath.values()] };
}

/** JaCoCo XML: <package name="a/b"><sourcefile name="C.java"><line nr mi ci/>. Hits = covered instructions. */
export function parseJacoco(text) {
  const records = [];
  for (const p of text.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)) {
    const pkg = attr(p[1], 'name') ?? '';
    for (const s of p[2].matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g)) {
      const name = attr(s[1], 'name');
      if (!name) continue;
      const rec = { path: pkg ? `${pkg}/${name}` : name, lines: new Map() };
      for (const l of s[2].matchAll(/<line\b([^>]*)>/g)) {
        const mi = Number(attr(l[1], 'mi') ?? 0);
        const ci = Number(attr(l[1], 'ci') ?? 0);
        if (mi + ci > 0) addHits(rec.lines, Number(attr(l[1], 'nr')), ci);
      }
      records.push(rec);
    }
  }
  return records;
}

/** Go cover profile: `mode: x` then `file.go:l1.c1,l2.c2 stmts count`. A line counts as hit if any block on it ran. */
export function parseGoCover(text) {
  const byPath = new Map();
  const lines = text.split('\n');
  if (!/^mode:\s*\w+/.test(lines[0] ?? '')) return [];
  for (const raw of lines.slice(1)) {
    const m = raw.trim().match(/^(.+):(\d+)\.\d+,(\d+)\.\d+\s+(\d+)\s+(\d+)$/);
    if (!m || Number(m[4]) === 0) continue;
    let rec = byPath.get(m[1]);
    if (!rec) byPath.set(m[1], (rec = { path: m[1], lines: new Map() }));
    for (let n = Number(m[2]); n <= Number(m[3]); n++) addHits(rec.lines, n, Number(m[5]));
  }
  return [...byPath.values()];
}

/** SimpleCov .resultset.json: { suite: { coverage: { path: [hits|null] | { lines: [...] } } } }, merged across suites. */
export function parseSimpleCov(text) {
  const data = JSON.parse(text);
  const byPath = new Map();
  for (const suite of Object.values(data ?? {})) {
    for (const [path, cov] of Object.entries(suite?.coverage ?? {})) {
      const arr = Array.isArray(cov) ? cov : cov?.lines;
      if (!Array.isArray(arr)) continue;
      let rec = byPath.get(path);
      if (!rec) byPath.set(path, (rec = { path, lines: new Map() }));
      arr.forEach((h, i) => typeof h === 'number' && addHits(rec.lines, i + 1, h));
    }
  }
  return [...byPath.values()];
}

/** Report format from its path and content, or null. */
export function detectFormat(relPath, head) {
  const name = posix.basename(relPath);
  if (name === '.resultset.json') return 'simplecov';
  if (name === 'lcov.info' || /\.lcov$/i.test(name)) return 'lcov';
  if (/^(cover|coverage|c)\.out$|\.coverprofile$/i.test(name)) return /^mode:/.test(head) ? 'go' : null;
  if (/\.xml$/i.test(name) && (/^coverage\.xml$|cobertura|^jacoco/i.test(name) || /(^|\/)build\/reports\/jacoco\//.test(relPath))) {
    if (/<coverage\b/.test(head)) return 'cobertura';
    if (/<report\b/.test(head)) return 'jacoco';
  }
  return null;
}

/** Parses one report: { format, records, sources? }. */
export function parseReport(format, text) {
  if (format === 'lcov') return { records: parseLcov(text) };
  if (format === 'cobertura') return parseCobertura(text);
  if (format === 'jacoco') return { records: parseJacoco(text) };
  if (format === 'go') return { records: parseGoCover(text) };
  if (format === 'simplecov') return { records: parseSimpleCov(text) };
  return { records: [] };
}

// ----------------------------------------------------------- path mapping

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const isAbs = (p) => isAbsolute(p) || /^[A-Za-z]:\//.test(p);

/**
 * A report path -> { file } (a repo-relative file that exists) or
 * { suffix } (a path to match by trailing segments, e.g. a CI runner's absolute
 * path, a JaCoCo package path, a Go import path outside a known module).
 * ctx: { root, reportDir (repo-relative), sources?, modules?: [{ module, dir }] },
 * exists(repoRelative) -> boolean.
 */
export function mapPath(reportPath, ctx, exists) {
  const p = norm(reportPath);
  const tries = [];
  const raw = [];
  const fromRoot = (abs) => {
    const rel = norm(relative(ctx.root, abs));
    if (rel && !rel.startsWith('..') && !isAbs(rel)) tries.push(rel);
  };
  const add = (cand) => {
    if (isAbs(cand)) {
      fromRoot(cand);
      raw.push(cand);
    } else {
      for (const base of [ctx.reportDir, posix.dirname(ctx.reportDir), '']) {
        const rel = posix.normalize(posix.join(base || '.', cand));
        if (!rel.startsWith('..')) tries.push(rel);
      }
      raw.push(cand);
    }
  };
  for (const { module, dir } of ctx.modules ?? []) {
    if (p.startsWith(`${module}/`)) tries.push(posix.join(dir || '.', p.slice(module.length + 1)));
  }
  for (const s of ctx.sources ?? []) add(posix.join(norm(s), p));
  add(p);
  const file = tries.find((t) => exists(t));
  if (file) return { file };
  return { suffix: raw.sort((a, b) => b.length - a.length)[0] ?? p };
}

/** Trailing path segments shared by `file` and `suffix`, if one ends with the whole of the other; else 0. */
export function suffixScore(file, suffix) {
  const a = norm(file).split('/').filter(Boolean);
  const b = norm(suffix).split('/').filter(Boolean);
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k > 0 && (k === a.length || k === b.length) ? k : 0;
}

/**
 * The records (from mapped reports) that describe `file`: exact matches, or
 * else the suffix matches with the most shared segments.
 */
export function recordsFor(file, mapped) {
  const exact = mapped.filter((m) => m.file === file);
  if (exact.length) return exact;
  let best = 0;
  let hits = [];
  for (const m of mapped) {
    if (!m.suffix) continue;
    const s = suffixScore(file, m.suffix);
    if (s > best) [best, hits] = [s, [m]];
    else if (s === best && s > 0) hits.push(m);
  }
  return hits;
}

/** Line maps of several records for one file, merged: executable if any says so, hit if any ran it. */
export function mergeLines(maps) {
  const out = new Map();
  for (const m of maps) for (const [l, h] of m) out.set(l, Math.max(out.get(l) ?? 0, h));
  return out;
}

// ---------------------------------------------------------- diff coverage

const inChanges = (changes, line) => changes === 'all' || changes.some(([a, b]) => line >= a && line <= b);

/**
 * Changed, executable, never-hit lines of one file, as ranges
 * [{ from, to, count }]. Uncovered lines merge into one range when only
 * non-executable lines lie between them.
 */
export function uncoveredRanges(changes, lines) {
  const exec = [...lines.keys()].sort((a, b) => a - b);
  const ranges = [];
  let prev = -2;
  exec.forEach((line, i) => {
    if (lines.get(line) !== 0 || !inChanges(changes, line)) return;
    const last = ranges[ranges.length - 1];
    if (last && prev === i - 1) {
      last.to = line;
      last.count++;
    } else ranges.push({ from: line, to: line, count: 1 });
    prev = i;
  });
  return ranges;
}

/** Findings for one file's uncovered ranges. */
export function toFindings(file, ranges) {
  return ranges.map(({ from, to, count }) => ({
    ruleId: 'uncovered-change',
    ruleName: 'Changed lines not covered by tests',
    message:
      count === 1
        ? `1 changed line (${from}) is not run by any test.`
        : `${count} changed lines (${from}–${to}) are not run by any test.`,
    file,
    line: from,
    ...(to > from ? { endLine: to } : {}),
    category: 'testing',
    severity: 'medium',
  }));
}

export const isTestFile = (file) => TEST_PATH.test(file);

// -------------------------------------------------------------------- I/O

/** Coverage reports under root (bounded walk): [{ path (repo-relative), format }]. */
export function findReports(root) {
  const found = [];
  let seen = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES || found.length >= MAX_REPORTS) return;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(rel, depth + 1);
      } else if (e.isFile() && REPORT_NAME.test(rel)) {
        let head = '';
        try {
          head = readHead(join(root, rel));
        } catch {
          continue;
        }
        const format = detectFormat(rel, head);
        if (format) found.push({ path: rel, format });
      }
    }
  };
  walk('', 0);
  return found;
}

function readHead(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(2000);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** go.mod modules under root that a Go report may refer to (root and the report's ancestors). */
function goModules(root, reportDir) {
  const out = [];
  let dir = reportDir;
  for (;;) {
    try {
      const m = readFileSync(join(root, dir, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m);
      if (m) out.push({ module: m[1].replace(/^"|"$/g, ''), dir });
    } catch {
      /* no go.mod here */
    }
    if (!dir || dir === '.') break;
    dir = posix.dirname(dir) === '.' ? '' : posix.dirname(dir);
  }
  return out;
}

const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

async function analyze({ root, files, changes = {} }) {
  const reports = findReports(root);
  if (!reports.length) {
    return { findings: [], notes: ['coverage: no coverage report found; run your tests with coverage (lcov, Cobertura, JaCoCo, Go, SimpleCov) before review'] };
  }
  const notes = [];
  const exists = (rel) => {
    try {
      return statSync(join(root, rel)).isFile();
    } catch {
      return false;
    }
  };
  const mapped = [];
  const used = [];
  for (const r of reports) {
    let parsed;
    try {
      if (statSync(join(root, r.path)).size > MAX_REPORT_BYTES) throw new Error('larger than 100 MB');
      parsed = parseReport(r.format, readFileSync(join(root, r.path), 'utf8'));
    } catch (e) {
      notes.push(`coverage: could not read ${r.path} (${e.message})`);
      continue;
    }
    const reportDir = posix.dirname(r.path) === '.' ? '' : posix.dirname(r.path);
    const ctx = { root, reportDir, sources: parsed.sources, modules: r.format === 'go' ? goModules(root, reportDir) : [] };
    const time = mtime(join(root, r.path));
    for (const rec of parsed.records) mapped.push({ ...mapPath(rec.path, ctx, exists), lines: rec.lines, report: r.path, time });
    used.push(`${r.path} (${r.format})`);
  }
  if (used.length) notes.push(`coverage: read ${used.join(', ')}`);

  const findings = [];
  const unmeasured = [];
  const stale = [];
  for (const file of files) {
    if (isTestFile(file) || !SOURCE.test(file) || !exists(file)) continue;
    const recs = recordsFor(file, mapped);
    if (!recs.length) {
      unmeasured.push(file);
      continue;
    }
    const fileTime = mtime(join(root, file));
    const fresh = recs.filter((r) => r.time >= fileTime);
    if (!fresh.length) {
      stale.push(file);
      continue;
    }
    findings.push(...toFindings(file, uncoveredRanges(changes[file] ?? 'all', mergeLines(fresh.map((r) => r.lines)))));
  }
  for (const file of stale.slice(0, 5)) notes.push(`coverage: coverage report older than ${file}; rerun tests`);
  if (stale.length > 5) notes.push(`coverage: ${stale.length - 5} more changed file(s) newer than their coverage report; rerun tests`);
  if (unmeasured.length) notes.push(`coverage: ${unmeasured.length} changed source file(s) not in any coverage report, not judged: ${unmeasured.slice(0, 5).join(', ')}${unmeasured.length > 5 ? ', ...' : ''}`);
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });

export { analyze };
