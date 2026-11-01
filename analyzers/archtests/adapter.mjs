// Architecture tests the repo writes and runs itself: ArchUnit (JVM) and
// NetArchTest / ArchUnitNET (.NET). This adapter never runs repo code or builds
// anything; it only reads the results the repo's own test run left behind
// (JUnit XML from Maven/Gradle, TRX from `dotnet test --logger trx`) and maps
// each violation to a line in the reviewed files. Pure Node, no tool binary.
//
// MCR_TOOLS picks the tool for this container: "archunit"
// (architecture-archunit) or "netarchtest" (architecture-netarchtest).
//
// Severity: high, because the repo's own architecture test fails, so the team
// has already declared the rule binding. The one exception is an ArchUnit rule
// the team marked `Priority.LOW`, which becomes medium (shown, blocking only at
// level `maximum`). A result file older than the source file it points to is
// skipped with a note: results from before the change would mislead.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { serve } from '../_kit/serve.mjs';

/** MCR_TOOLS -> the tools this container runs. */
export function toolsFrom(value) {
  const known = new Set(['archunit', 'netarchtest']);
  return (value ?? 'archunit,netarchtest')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => known.has(t));
}

const TOOLS = toolsFrom(process.env.MCR_TOOLS);

/** /info for a tool selection. */
export function infoFor(tools) {
  const java = tools.includes('archunit');
  const dotnet = tools.includes('netarchtest');
  return {
    name: tools.join('+') || 'archtests',
    version: 'archtests-1',
    languages: [...(java ? ['java', 'kotlin'] : []), ...(dotnet ? ['csharp'] : [])],
    extensions: [...(java ? ['.java', '.kt'] : []), ...(dotnet ? ['.cs'] : [])],
  };
}

const info = infoFor(TOOLS);

const MAX_DEPTH = 9;
const MAX_ENTRIES = 50_000;
const MAX_REPORTS = 500;
const MAX_REPORT_BYTES = 20_000_000;
const MAX_SOURCE_BYTES = 2_000_000;
const MAX_FINDINGS = 500;
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', '.venv', 'venv', '__pycache__', 'bower_components', '.gradle', '.idea', '.vs', 'obj', 'bin']);
const JUNIT_PATH = /(^|\/)target\/(surefire|failsafe)-reports\/TEST-[^/]*\.xml$|(^|\/)build\/test-results\/(.+\/)?TEST-[^/]*\.xml$/;
const TRX_PATH = /(^|\/)TestResults\/[^/]*\.trx$/i;

// ------------------------------------------------------------------ XML

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function unxml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()],
  );
}

/** Attributes of a start tag's inner text, decoded. */
export function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = unxml(m[2] ?? m[3]);
  return out;
}

/** Element text: CDATA kept verbatim, the rest entity-decoded. */
export function elementText(body) {
  if (!body) return '';
  let out = '';
  let last = 0;
  for (const m of body.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    out += unxml(body.slice(last, m.index)) + m[1];
    last = m.index + m[0].length;
  }
  return out + unxml(body.slice(last));
}

const slug = (s, max = 60) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');

// ------------------------------------------------------------- ArchUnit

/** Failed testcases of a JUnit XML report: [{ classname, name, texts: [message, body] }]. */
export function parseJUnit(text) {
  const out = [];
  for (const m of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (!m[2]) continue;
    const a = attrs(m[1]);
    const texts = [];
    for (const f of m[2].matchAll(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/g)) {
      const fa = attrs(f[2]);
      if (fa.message) texts.push(fa.message);
      if (f[3]) texts.push(elementText(f[3]));
    }
    if (texts.length) out.push({ classname: a.classname ?? '', name: a.name ?? '', texts });
  }
  return out;
}

/**
 * ArchUnit violations in a failure text:
 * [{ priority, rule, line (the violation line), fqn?, fileName, lineNo }].
 * Header: `Architecture Violation [Priority: X] - Rule '...' was violated (N times):`
 * then one violation per line, each ending in `in (File.java:42)`.
 */
export function parseArchUnit(text) {
  const out = [];
  const t = text.replace(/\r\n?/g, '\n');
  const headers = [...t.matchAll(/Architecture Violation \[Priority: (\w+)\] - Rule '([\s\S]*?)' was violated \((\d+) times?\):?/g)];
  headers.forEach((h, i) => {
    const end = i + 1 < headers.length ? headers[i + 1].index : t.length;
    const body = t.slice(h.index + h[0].length, end);
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (/^at\s+[\w$.]+\(/.test(line)) break; // the stack trace starts
      const loc = line.match(/\(([\w$-]+\.(?:java|kt|kts|groovy|scala)):(\d+)\)\s*$/);
      if (!loc) continue;
      const fqn = line.match(/<([\w$.]+)/);
      out.push({
        priority: h[1].toUpperCase(),
        rule: h[2].replace(/\s+/g, ' ').trim(),
        line: line.replace(/^-\s*/, ''),
        fqn: fqn ? fqn[1] : undefined,
        fileName: loc[1],
        lineNo: Number(loc[2]),
      });
    }
  });
  return out;
}

/** The package path (`com/acme`) of a violation's class, from its FQN and the file name. */
export function packagePath(fqn, fileName) {
  if (!fqn) return undefined;
  const base = fileName.replace(/\.[^.]+$/, '');
  const parts = fqn.split('.');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].split('$')[0] === base) return parts.slice(0, i).join('/');
  }
  return undefined;
}

const JVM_SOURCE = /\.(java|kt|kts|groovy|scala)$/;

/**
 * The reviewed file a JVM violation points to, or undefined: a file ending in
 * `<package path>/<File.java>` (preferring one under src/<set>/java|kotlin),
 * else the only reviewed file with that name.
 */
export function mapJvmFile(fileName, pkg, files) {
  const named = files.filter((f) => JVM_SOURCE.test(f) && posix.basename(f) === fileName);
  if (pkg !== undefined) {
    const suffix = pkg ? `${pkg}/${fileName}` : fileName;
    const byPkg = named.filter((f) => f === suffix || f.endsWith(`/${suffix}`));
    const src = byPkg.filter((f) => /(^|\/)src\/[^/]+\/(java|kotlin|groovy|scala)\//.test(f));
    if (src.length) return src[0];
    if (byPkg.length) return byPkg[0];
  }
  return named.length === 1 ? named[0] : undefined;
}

/** A finding for one ArchUnit violation mapped to `file`. */
export function archUnitFinding(v, file) {
  return {
    ruleId: slug(v.rule) || 'archunit-rule',
    ruleName: v.rule,
    message: v.line,
    file,
    line: Math.max(1, v.lineNo),
    category: 'architecture',
    severity: v.priority === 'LOW' ? 'medium' : 'high',
    helpUri: 'https://www.archunit.org/userguide/html/000_Index.html',
  };
}

// ---------------------------------------------------------- NetArchTest

/** Results of a TRX file: [{ key, testName, className, outcome, message, stackTrace }]. */
export function parseTrx(text) {
  const classes = new Map();
  for (const m of text.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g)) {
    const id = attrs(m[1]).id;
    const tm = m[2].match(/<TestMethod\b([^>]*?)\/?>/);
    if (id && tm) classes.set(id, attrs(tm[1]).className ?? '');
  }
  const out = [];
  for (const m of text.matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const a = attrs(m[1]);
    const body = m[2] ?? '';
    const msg = body.match(/<Message>([\s\S]*?)<\/Message>/);
    const st = body.match(/<StackTrace>([\s\S]*?)<\/StackTrace>/);
    const testName = a.testName ?? '';
    const className = classes.get(a.testId) ?? '';
    out.push({
      key: `${className}::${testName}`,
      testName,
      className,
      outcome: a.outcome ?? '',
      message: msg ? elementText(msg[1]) : '',
      stackTrace: st ? elementText(st[1]) : '',
    });
  }
  return out;
}

/** Whether a failed .NET test is an architecture test (by its name or its message). */
export function isArchTest(r) {
  const name = `${r.className}.${r.testName}`;
  if (/Arch|Layer|Dependenc/.test(name) || /(^|[._])(arch|architecture|layers?|dependency|dependencies)([._]|$)/i.test(name)) return true;
  if (/FailingType(Name)?s|NetArchTest|ArchUnitNET|IsSuccessful/.test(r.message)) return true;
  if (/^\s*".*" failed:\s*$/m.test(r.message)) return true; // ArchUnitNET rule description
  return /NetArchTest|ArchUnitNET/.test(r.stackTrace);
}

/** Dotted identifiers in a message that may name a type (`MyApp.Domain.Order`). */
export function candidateTypes(message) {
  const out = new Set();
  for (const m of message.matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?:`\d+)?(?:\+[A-Za-z_]\w*)*/g)) {
    out.add(m[0].replace(/`\d+/g, ''));
  }
  return [...out];
}

/**
 * Type declarations of a C# file: [{ namespace, name, line }]. Handles
 * file-scoped and block namespaces (nested too) by brace depth; strings and
 * comments are stripped first, well enough for declarations.
 */
export function csharpTypes(text) {
  const out = [];
  const stack = []; // { name, depth }
  let fileNs = '';
  let depth = 0;
  let inBlockComment = false;
  text.split('\n').forEach((raw, i) => {
    let line = raw;
    if (inBlockComment) {
      const e = line.indexOf('*/');
      if (e < 0) return;
      line = line.slice(e + 2);
      inBlockComment = false;
    }
    line = line
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/@?"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)'/g, "''")
      .replace(/\/\/.*$/, '');
    const bc = line.indexOf('/*');
    if (bc >= 0) {
      line = line.slice(0, bc);
      inBlockComment = true;
    }
    const ns = line.match(/^\s*namespace\s+([\w.]+)\s*(;|\{|$)/);
    if (ns) {
      if (ns[2] === ';') fileNs = ns[1];
      else stack.push({ name: ns[1], depth });
    }
    const decl = line.match(
      /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|internal|private|protected|sealed|abstract|static|partial|readonly|unsafe|file|new|ref)\s+)*(?:record\s+(?:class|struct)|class|record|struct|interface|enum)\s+([A-Za-z_]\w*)/,
    );
    if (decl) {
      const namespace = [fileNs, ...stack.map((s) => s.name)].filter(Boolean).join('.');
      out.push({ namespace, name: decl[1], line: i + 1 });
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      }
    }
  });
  return out;
}

/**
 * Where a candidate type name is declared among `types` ({ file, namespace,
 * name, line }), trying each split of the dotted name into namespace + type
 * (so `A.B.Order.Total` still finds `A.B.Order`). Nested types use `+`.
 */
export function locateType(candidate, types) {
  const parts = candidate.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const segs = parts[i].split('+');
    const name = segs[segs.length - 1];
    const namespace = parts.slice(0, i).join('.');
    const hit = types.find((t) => t.name === name && t.namespace === namespace);
    if (hit) return hit;
  }
  return undefined;
}

/** The message line that names `fqn` (ArchUnitNET lists one per line), else the message's first line. */
function detailLine(message, fqn) {
  const lines = message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => l.includes(fqn) && l.length < 400);
  return (hit ?? lines[0] ?? '').slice(0, 300);
}

/** A finding for a failed .NET architecture test and one type it names. */
export function netArchFinding(r, fqn, decl) {
  const shortName = r.testName.split('.').pop() || r.testName;
  return {
    ruleId: slug(shortName) || 'netarchtest-rule',
    ruleName: r.testName,
    message: `Architecture test ${shortName} fails for ${fqn}: ${detailLine(r.message, fqn)}`,
    file: decl.file,
    line: decl.line,
    category: 'architecture',
    severity: 'high',
  };
}

// ------------------------------------------------------------------ I/O

/** Result files under root (bounded walk): { junit: [rel], trx: [rel] }. */
export function findResults(root) {
  const junit = [];
  const trx = [];
  let seen = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES || junit.length + trx.length >= MAX_REPORTS) return;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(rel, depth + 1);
      } else if (e.isFile()) {
        if (JUNIT_PATH.test(rel)) junit.push(rel);
        else if (TRX_PATH.test(rel)) trx.push(rel);
      }
    }
  };
  walk('', 0);
  return { junit, trx };
}

const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** A file's text if it is no larger than `max` bytes; UTF-16 TRX decoded. */
function readBounded(path, max) {
  if (statSync(path).size > max) throw new Error(`larger than ${Math.round(max / 1_000_000)} MB`);
  const buf = readFileSync(path);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

/** Whether the first bytes of a file contain `needle` anywhere (cheap pre-filter on large reports). */
function contains(path, needle) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    let carry = '';
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) return false;
      const chunk = carry + buf.subarray(0, n).toString('utf8');
      if (chunk.includes(needle)) return true;
      carry = chunk.slice(-needle.length);
      pos += n;
      if (pos > MAX_REPORT_BYTES) return false;
    }
  } finally {
    closeSync(fd);
  }
}

function staleNotes(tool, stale, rerun) {
  const list = [...stale];
  const notes = list.slice(0, 5).map((f) => `${tool}: stale results for ${f}; rerun the tests (${rerun})`);
  if (list.length > 5) notes.push(`${tool}: ${list.length - 5} more file(s) newer than their test results; rerun the tests (${rerun})`);
  return notes;
}

function runArchUnit(root, files, reports) {
  const rerun = 'mvn test / gradle test';
  if (!reports.length) return { findings: [], notes: [`archunit: no test results; run the tests (${rerun}) so ArchUnit results exist`] };
  const notes = [];
  const findings = [];
  const seen = new Set();
  const stale = new Set();
  let violations = 0;
  let outside = 0;
  for (const rel of reports) {
    const path = join(root, rel);
    let cases;
    try {
      if (!contains(path, 'Architecture Violation')) continue;
      cases = parseJUnit(readBounded(path, MAX_REPORT_BYTES));
    } catch (e) {
      notes.push(`archunit: could not read ${rel} (${e.message})`);
      continue;
    }
    const time = mtime(path);
    for (const c of cases) {
      for (const text of c.texts) {
        for (const v of parseArchUnit(text)) {
          const file = mapJvmFile(v.fileName, packagePath(v.fqn, v.fileName), files);
          const key = `${file}|${v.lineNo}|${v.rule}|${v.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          violations++;
          if (!file) {
            outside++;
            continue;
          }
          if (time < mtime(join(root, file))) {
            stale.add(file);
            continue;
          }
          if (findings.length < MAX_FINDINGS) findings.push(archUnitFinding(v, file));
        }
      }
    }
  }
  notes.push(`archunit: read ${reports.length} test report(s), ${violations} ArchUnit violation(s)${outside ? `, ${outside} outside the reviewed files` : ''}`);
  return { findings, notes: [...notes, ...staleNotes('archunit', stale, rerun)] };
}

function runNetArchTest(root, files, reports) {
  const rerun = 'dotnet test --logger trx';
  if (!reports.length) return { findings: [], notes: [`netarchtest: no test results; run the tests (${rerun}) so architecture test results exist`] };
  const notes = [];
  // The newest result per test wins: TestResults/ keeps every earlier run.
  const latest = new Map();
  for (const rel of reports) {
    const path = join(root, rel);
    let results;
    try {
      results = parseTrx(readBounded(path, MAX_REPORT_BYTES));
    } catch (e) {
      notes.push(`netarchtest: could not read ${rel} (${e.message})`);
      continue;
    }
    const time = mtime(path);
    for (const r of results) {
      const prev = latest.get(r.key);
      if (!prev || prev.time <= time) latest.set(r.key, { ...r, time });
    }
  }
  const failed = [...latest.values()].filter((r) => r.outcome === 'Failed' && isArchTest(r));
  const findings = [];
  const stale = new Set();
  if (failed.length) {
    const types = [];
    for (const file of files) {
      if (!/\.cs$/i.test(file)) continue;
      try {
        for (const t of csharpTypes(readBounded(join(root, file), MAX_SOURCE_BYTES))) types.push({ ...t, file });
      } catch {
        /* unreadable or too large: not judged */
      }
    }
    const seen = new Set();
    for (const r of failed) {
      for (const fqn of candidateTypes(r.message)) {
        const decl = locateType(fqn, types);
        if (!decl) continue;
        const key = `${r.key}|${decl.file}|${decl.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (r.time < mtime(join(root, decl.file))) {
          stale.add(decl.file);
          continue;
        }
        if (findings.length < MAX_FINDINGS) findings.push(netArchFinding(r, fqn, decl));
      }
    }
  }
  notes.push(`netarchtest: read ${reports.length} TRX file(s), ${failed.length} failing architecture test(s)`);
  return { findings, notes: [...notes, ...staleNotes('netarchtest', stale, rerun)] };
}

async function analyze({ root, files, tools = TOOLS }) {
  const found = findResults(root);
  const findings = [];
  const notes = [];
  if (tools.includes('archunit')) {
    const r = runArchUnit(root, files, found.junit);
    findings.push(...r.findings);
    notes.push(...r.notes);
  }
  if (tools.includes('netarchtest')) {
    const r = runNetArchTest(root, files, found.trx);
    findings.push(...r.findings);
    notes.push(...r.notes);
  }
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });

export { analyze };
