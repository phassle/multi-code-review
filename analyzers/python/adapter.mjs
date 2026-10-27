// Python: Ruff and Bandit. Each uses the repo's own config when it has one
// (its config is the norm); without one, Ruff runs a curated default rule set
// and Bandit its full plugin set.
//
// MCR_TOOLS picks the tool for this container: "ruff" (correctness-ruff,
// security-ruff, reliability-ruff, ...: one container per category, each
// keeping only the Ruff findings in its category) or "bandit" (security-bandit).
// Ruff's S rules are a port of Bandit, so security-ruff and security-bandit
// overlap; deduplication is left to the gateway.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const TOOL = (process.env.MCR_TOOLS ?? 'ruff').trim();
if (process.env.MCR_ROOT && !['ruff', 'bandit'].includes(TOOL)) throw new Error('MCR_TOOLS must be "ruff" or "bandit"');

const version = process.env.MCR_ROOT ? (await run(TOOL, ['--version'])).stdout.trim().split('\n')[0] : TOOL;

const info = { name: TOOL, version, languages: ['python'], extensions: ['.py', '.pyi'] };

const PYTHON = /\.pyi?$/;

export const DEFAULT_RUFF_SELECT = 'E9,E722,F,B,S,ASYNC,BLE,PT,SIM,UP,PL,RUF,TRY';

// --- Ruff -------------------------------------------------------------------

/** True when the repo configures Ruff itself (ruff.toml, .ruff.toml or pyproject [tool.ruff]). */
export function hasRuffConfig(exists, read) {
  if (exists('ruff.toml') || exists('.ruff.toml')) return true;
  return exists('pyproject.toml') && /^\[tool\.ruff(?:\.[^\]]*)?\]/m.test(read('pyproject.toml'));
}

export function ruffArgs(ownConfig, files) {
  return ['check', '--output-format', 'json', '--no-cache', '--force-exclude', ...(ownConfig ? [] : ['--select', DEFAULT_RUFF_SELECT]), '--', ...files];
}

/** The rule's linter prefix: "S608" -> "S", "PLE0101" -> "PLE", "SIM102" -> "SIM". */
function prefix(code) {
  return /^[A-Z]+/.exec(code)?.[0] ?? '';
}

const isSyntax = (code) => !code || code === 'invalid-syntax' || /^E9\d\d$/.test(code);

export function ruffCategory(code) {
  if (isSyntax(code)) return 'correctness';
  if (code === 'E722') return 'reliability'; // bare except
  switch (prefix(code)) {
    case 'S':
      return 'security';
    case 'F':
    case 'PLE':
    case 'B':
      return 'correctness';
    case 'ASYNC':
    case 'BLE':
    case 'TRY':
      return 'reliability';
    case 'PT':
      return 'testing';
    default:
      return 'best-practices';
  }
}

// Injection-class Bandit ports: shell=True, os.system/popen, eval/exec, SQL built from strings.
const RUFF_HIGH = new Set(['S102', 'S307', 'S602', 'S604', 'S605', 'S608', 'S701', 'F821', 'F822', 'F823']);
// Unused code, and the S rules Bandit itself rates low (assert, try-except-pass, random, subprocess import).
const RUFF_LOW = new Set(['F401', 'F811', 'F841', 'S101', 'S110', 'S112', 'S311', 'S404']);

export function ruffSeverity(code) {
  if (isSyntax(code) || RUFF_HIGH.has(code) || prefix(code) === 'PLE') return 'high';
  if (RUFF_LOW.has(code)) return 'low';
  return code === 'E722' || ['S', 'F', 'B', 'ASYNC', 'BLE', 'TRY'].includes(prefix(code)) ? 'medium' : 'low';
}

/** Ruff's JSON output -> findings with paths relative to root. */
export function parseRuff(json, root) {
  return json.map((m) => {
    const code = m.code && m.code !== 'invalid-syntax' ? m.code : 'syntax-error';
    return {
      ruleId: code,
      message: m.message,
      file: relPath(m.filename, root),
      line: m.location?.row ?? 1,
      endLine: m.end_location?.row,
      column: m.location?.column,
      category: ruffCategory(m.code),
      severity: ruffSeverity(m.code),
      helpUri: m.url ?? undefined,
      ruleName: m.name ?? undefined,
    };
  });
}

async function ruff(root, files) {
  const own = hasRuffConfig((f) => existsSync(join(root, f)), (f) => readFileSync(join(root, f), 'utf8'));
  const result = await run('ruff', ruffArgs(own, files), { cwd: root });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`ruff failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
  }
  return { findings: parseRuff(parsed, root), notes: own ? ["ruff: using the repo's config"] : [] };
}

// --- Bandit -----------------------------------------------------------------

/** Bandit config args: pyproject [tool.bandit], a YAML config, or a legacy .bandit INI. */
export function banditConfigArgs(exists, read) {
  if (exists('pyproject.toml') && /^\[tool\.bandit(?:\.[^\]]*)?\]/m.test(read('pyproject.toml'))) return ['-c', 'pyproject.toml'];
  for (const f of ['bandit.yaml', 'bandit.yml', '.bandit.yaml', '.bandit.yml']) if (exists(f)) return ['-c', f];
  if (exists('.bandit')) return ['--ini', '.bandit'];
  return [];
}

const STEPS = ['low', 'medium', 'high'];

/** Bandit severity, one step lower when Bandit itself has low confidence. */
export function banditSeverity(severity, confidence) {
  const i = Math.max(0, STEPS.indexOf(String(severity).toLowerCase()));
  return STEPS[String(confidence).toUpperCase() === 'LOW' ? Math.max(0, i - 1) : i];
}

/** Bandit's JSON report -> findings with paths relative to root. */
export function parseBandit(json, root) {
  return (json.results ?? []).map((r) => ({
    ruleId: r.test_id,
    message: r.issue_cwe?.id ? `${r.issue_text} (CWE-${r.issue_cwe.id})` : r.issue_text,
    file: relPath(r.filename, root),
    line: r.line_number ?? 1,
    endLine: Array.isArray(r.line_range) && r.line_range.length ? Math.max(...r.line_range) : undefined,
    column: Number.isInteger(r.col_offset) ? r.col_offset + 1 : undefined,
    category: 'security',
    severity: banditSeverity(r.issue_severity, r.issue_confidence),
    helpUri: r.more_info,
    ruleName: r.test_name,
  }));
}

async function bandit(root, files) {
  const config = banditConfigArgs((f) => existsSync(join(root, f)), (f) => readFileSync(join(root, f), 'utf8'));
  const result = await run('bandit', ['-f', 'json', '-q', ...config, '--', ...files], { cwd: root });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`bandit failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
  }
  const notes = (parsed.errors ?? []).slice(0, 10).map((e) => `bandit: ${relPath(e.filename ?? '', root)}: ${e.reason}`);
  if (config.length) notes.push(`bandit: using the repo's config ${config[1]}`);
  return { findings: parseBandit(parsed, root), notes };
}

// ---------------------------------------------------------------------------

function relPath(file, root) {
  return isAbsolute(file) ? relative(root, file) : normalize(file);
}

async function analyze({ root, files }) {
  const targets = files.filter((f) => PYTHON.test(f));
  if (targets.length === 0) return { findings: [], notes: [] };
  return TOOL === 'bandit' ? bandit(root, targets) : ruff(root, targets);
}

if (process.env.MCR_ROOT) serve({ info, analyze });
