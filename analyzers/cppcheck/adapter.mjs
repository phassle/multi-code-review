// C/C++: cppcheck, run on the given files only (no project, no includes), so
// it stays fast and needs no build. The repo's suppressions list is honoured
// when it has one. Memory-safety bugs with a security CWE are security, leaks
// and performance/portability are reliability, the rest follows cppcheck's
// own severity.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, isAbsolute, relative } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const version = (await run('cppcheck', ['--version'])).stdout.trim() || 'cppcheck';

const EXTENSIONS = ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'];
const info = { name: 'cppcheck', version, languages: ['c', 'cpp'], extensions: EXTENSIONS };

// A suppressions list (id[:file[:line]] per line). `.cppcheck` is cppcheck's GUI
// project file (XML), not a list, so it is not read.
const REPO_SUPPRESSIONS = ['cppcheck-suppressions.txt', '.cppcheck-suppressions', 'config/cppcheck-suppressions.txt'];

/** Ids about the run, not the code: reported as notes, never as findings. */
const TOOL_IDS = /^(syntaxError|unknownMacro|internalError|internalAstError|preprocessorErrorDirective|toomanyconfigs|cppcheckError|checkersReport|missingInclude\w*|noValidConfiguration)$/;

/** CWEs that make a memory-safety finding a security finding. */
export const SECURITY_CWES = new Set([119, 120, 121, 122, 125, 134, 190, 415, 416, 476, 562, 676, 787, 788]);

/** cppcheck ids that are security issues whatever their CWE. */
const SECURITY_IDS = /^(bufferAccessOutOfBounds|arrayIndexOutOfBounds\w*|negativeIndex|outOfBounds|pointerOutOfBounds\w*|nullPointer\w*|uninitvar|uninitdata|doubleFree|deallocuse|useAfterFree|invalidLifetime|danglingLifetime|danglingTemp\w*|returnDanglingLifetime|invalidFunctionArg\w*|wrongPrintfScanfArg\w*|invalidScanfArg\w*|invalidPrintfArgType\w*|invalidscanf|insecureCmdLineArgs|getsCalled|obsoleteFunctions\w*|prohibited\w*|bufferNotZeroTerminated|terminateStrncpy|sizeofwithnumericparameter)$/;

const LEAK_IDS = /^(memleak\w*|resourceLeak|leakNoVarFunctionCall|leakReturnValNotUsed|leakUnsafeArgAlloc|publicAllocationError|deallocret|mismatchAllocDealloc)$/;

/** cppcheck id + severity + CWE -> our category. */
export function cppcheckCategory(id, severity, cwe) {
  if (LEAK_IDS.test(id)) return 'reliability';
  if (SECURITY_IDS.test(id) || (severity === 'error' && SECURITY_CWES.has(Number(cwe)))) return 'security';
  if (severity === 'error' || severity === 'warning') return 'correctness';
  if (severity === 'performance' || severity === 'portability') return 'reliability';
  return 'best-practices';
}

export function cppcheckSeverity(severity) {
  return severity === 'error' ? 'high' : severity === 'warning' ? 'medium' : 'low';
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10)) : (ENTITIES[e] ?? m),
  );
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

/** cppcheck's --xml-version=2 report -> raw errors with their locations (first is primary). */
export function parseCppcheckXml(xml) {
  const errors = [];
  for (const m of String(xml).matchAll(/<error\s([^>]*?)(\/>|>([\s\S]*?)<\/error>)/g)) {
    const locations = [...(m[3] ?? '').matchAll(/<location\s([^>]*?)\/?>/g)].map((l) => attrs(l[1]));
    errors.push({ ...attrs(m[1]), locations });
  }
  return errors;
}

const rel = (root, file) => (isAbsolute(file) ? relative(root, file) : file);

/** Raw errors -> findings with paths relative to root; tool/config errors are dropped. */
export function toFindings(errors, root) {
  const findings = [];
  for (const e of errors) {
    const loc = e.locations[0];
    if (!loc?.file || TOOL_IDS.test(e.id) || e.severity === 'none' || e.severity === 'debug') continue;
    findings.push({
      ruleId: e.id,
      message: e.verbose || e.msg || e.id,
      file: rel(root, loc.file),
      line: Number(loc.line) || 1,
      ...(Number(loc.column) ? { column: Number(loc.column) } : {}),
      category: cppcheckCategory(e.id, e.severity, e.cwe),
      severity: cppcheckSeverity(e.severity),
      ...(e.cwe ? { ruleName: `CWE-${e.cwe}` } : {}),
    });
  }
  return findings;
}

async function analyze({ root, files }) {
  const targets = files.filter((f) => EXTENSIONS.some((x) => f.toLowerCase().endsWith(x)));
  if (targets.length === 0) return { findings: [], notes: [] };
  const work = `/tmp/cppcheck-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(join(work, 'build'), { recursive: true });
    const list = join(work, 'files.txt');
    writeFileSync(list, targets.map((f) => join(root, f)).join('\n'));
    const own = REPO_SUPPRESSIONS.find((s) => existsSync(join(root, s)));
    const jobs = Math.max(1, Math.min(availableParallelism(), targets.length, 8));
    const result = await run(
      'cppcheck',
      [
        '--enable=warning,style,performance,portability',
        '--xml',
        '--xml-version=2',
        '--quiet',
        '--suppress=missingIncludeSystem',
        '--suppress=missingInclude',
        '--suppress=unmatchedSuppression',
        '--suppress=checkersReport',
        `--cppcheck-build-dir=${join(work, 'build')}`,
        `-j${jobs}`,
        ...(own ? [`--suppressions-list=${join(root, own)}`] : []),
        `--file-list=${list}`,
      ],
      { cwd: root },
    );
    if (!result.stderr.includes('<results')) {
      throw new Error(`cppcheck failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 500)}`);
    }
    const errors = parseCppcheckXml(result.stderr);
    const notes = errors
      .filter((e) => TOOL_IDS.test(e.id))
      .slice(0, 10)
      .map((e) => `cppcheck ${e.id}${e.locations[0]?.file ? ` in ${rel(root, e.locations[0].file)}` : ''}: ${e.msg}`);
    if (own) notes.push(`cppcheck: using the repo's suppressions ${own}`);
    return { findings: toFindings(errors, root), notes };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.env.MCR_ROOT) serve({ info, analyze });
