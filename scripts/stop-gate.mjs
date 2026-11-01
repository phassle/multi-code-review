// Claude Code Stop hook: an agent may not call its work done while the review
// blocks. When the agent stops, this reviews the repo it worked in (through
// the running gateway, via scripts/mcr.mjs) and, on blocking findings, sends
// them back so the agent keeps working. Zero dependencies.
//
// Opt-in per repo, in .mcr/settings.yml:
//
//   agent:
//     gate: true
//
// or for every repo with MCR_GATE=1 (MCR_GATE=0 turns it off everywhere).
//
// It never traps the agent: no gateway, a repo outside MCR_ROOT or a failed
// review lets it stop with a note, and after MAX_ROUNDS blocked stops in a row
// it hands over to the user. The agent is told to fix findings, never to
// silence them: decisions are the user's (triage_queue, record_decisions).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_ROUNDS = 3;
const MAX_LISTED = 20;
const MCR = join(dirname(fileURLToPath(import.meta.url)), 'mcr.mjs');

/** Whether the gate is on: MCR_GATE wins, else `agent: gate: true` in .mcr/settings.yml. */
export function gateEnabled(settingsText, env = {}) {
  const flag = (env.MCR_GATE ?? '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(flag)) return true;
  if (['0', 'false', 'off', 'no'].includes(flag)) return false;
  if (!settingsText) return false;
  // A small YAML subset is enough: `agent:` then an indented `gate: true`.
  const block = /^agent:[ \t]*(?:#.*)?\n((?:[ \t]+.*\n?|[ \t]*\n)*)/m.exec(settingsText);
  return !!block && /^[ \t]+gate:[ \t]*(?:true|yes|on)\b/m.test(block[1]);
}

/** What the agent is told when the review blocks. */
export function blockReason(review) {
  const blocking = (review.findings ?? []).filter((f) => f.blocking);
  // run_review's JSON lists findings compactly (`rule`, no message); the full shape has analyzer and ruleId.
  const lines = blocking.slice(0, MAX_LISTED).map((f) => `- [${f.category}] ${f.rule ?? `${f.analyzer}:${f.ruleId}`} ${f.file}:${f.line} (${f.id})${f.message ? `: ${f.message}` : ''}`);
  if (blocking.length > MAX_LISTED) lines.push(`- … and ${blocking.length - MAX_LISTED} more (run_review or fix_report lists them all)`);
  return [
    `multi-code-review blocks this change: ${review.blocking} blocking finding(s) in ${review.repoRoot}.`,
    ...lines,
    '',
    'Fix them, then finish again; the review reruns. get_finding gives the detail and code.',
    'If a finding is intended or the tool is wrong, do not silence it or edit .mcr/decisions.yml yourself: ask the user, then record their decision with triage_queue / record_decisions.',
  ].join('\n');
}

/** Blocked stops in a row for this session: counts up while the hook keeps the agent going, resets otherwise. */
export function nextRound(previous, stopHookActive) {
  return stopHookActive ? previous + 1 : 1;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function say(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return; // not called by Claude Code
  }
  const cwd = input.cwd || process.cwd();
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return;
  const settingsFile = join(root, '.mcr', 'settings.yml');
  if (!gateEnabled(existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : undefined, process.env)) return;

  const counter = join(tmpdir(), `mcr-gate-${String(input.session_id ?? 'none').replace(/[^\w-]/g, '')}`);
  const previous = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) || 0 : 0;
  const round = nextRound(previous, input.stop_hook_active === true);

  const r = spawnSync(process.execPath, [MCR, 'review', root, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) {
    rmSync(counter, { force: true });
    return;
  }
  if (r.status !== 1) {
    rmSync(counter, { force: true });
    say({ systemMessage: `multi-code-review gate skipped: ${(r.stderr || r.error?.message || 'review failed').trim().split('\n').at(-1)}` });
    return;
  }
  let review;
  try {
    review = JSON.parse(r.stdout);
  } catch {
    say({ systemMessage: 'multi-code-review gate skipped: unreadable review output' });
    return;
  }
  if (round > MAX_ROUNDS) {
    rmSync(counter, { force: true });
    say({ systemMessage: `multi-code-review still blocks after ${MAX_ROUNDS} rounds (${review.blocking} finding(s)); over to you: fix_report or triage_queue.` });
    return;
  }
  writeFileSync(counter, String(round));
  say({ decision: 'block', reason: blockReason(review) });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
