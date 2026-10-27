#!/usr/bin/env node
// Command line for multi-code-review: calls the running gateway's MCP tools,
// so a terminal or a CI job can review without an AI assistant. The analyzers
// are only reachable through the gateway, so start it first (setup.sh or aspire).
//
//   node scripts/mcr.mjs review [path] [--base origin/main] [--all] [--json]
//   node scripts/mcr.mjs --help
//
// Exit: 0 passed, 1 blocking findings (or analyzer errors with --strict),
// 2 usage error or the gateway does not answer.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubReview } from './github-review.mjs';

export const USAGE = `Usage: node scripts/mcr.mjs <command> [path] [options]

Commands:
  review      Review the changes since the merge base (or --all files)
  fix-report  What still needs fixing, deciding or can be cleaned up
  triage      Undecided findings grouped by rule
  detect      The repo's stacks and which analyzers cover them
  analyzers   The analyzers the gateway runs

path defaults to the current directory; it must be inside MCR_ROOT.

Options (review, fix-report, triage):
  --base <ref>        Branch or commit to diff against (default: origin/develop, origin/main, …)
  --all               Every file in the repo, not just the diff
  --category <name>   Only this category; repeatable
  --analyzer <name>   Only these analyzers (review only); repeatable
  --preexisting       Also list findings on unchanged lines (never block)
Output:
  --json              Print the JSON result instead of Markdown
  --out <file>        Also write the Markdown report to a file (for a PR comment)
  --strict            Exit 1 when an analyzer fails, not only on blocking findings
  --github-review <file>  Write a GitHub pull request review (summary + line comments) as JSON (review only)
    --commit <sha>        The PR head commit it reviews
    --pr-files <file>     GET /pulls/{n}/files as a JSON array: comment only on lines in the diff
    --skip <file>         JSON array of fingerprints already commented on: not repeated
    --report-url <url>    Where the full report is, e.g. the workflow run
  --url <url>         Gateway (default: http://127.0.0.1:$MCR_PORT, MCR_PORT from .env or 7700)
`;

const COMMANDS = { review: 'run_review', 'fix-report': 'fix_report', triage: 'triage_queue', detect: 'detect_stack', analyzers: 'list_analyzers' };
const VALUE_FLAGS = new Set(['--base', '--category', '--analyzer', '--out', '--url', '--github-review', '--commit', '--pr-files', '--skip', '--report-url']);
const BOOL_FLAGS = new Set(['--all', '--preexisting', '--json', '--strict', '--help', '-h']);

/** argv (without node and script) -> { command, path, flags } or { error }. */
export function parseArgs(argv) {
  const flags = { category: [], analyzer: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) flags[a.replace(/^-+/, '') === 'h' ? 'help' : a.slice(2)] = true;
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      const key = a.slice(2);
      if (Array.isArray(flags[key])) flags[key].push(v);
      else flags[key] = v;
    } else if (a.startsWith('-')) return { error: `unknown option ${a}` };
    else positional.push(a);
  }
  if (flags.help) return { help: true };
  const [command, path, ...rest] = positional;
  if (!command) return { error: 'no command' };
  if (!(command in COMMANDS)) return { error: `unknown command ${command}` };
  if (rest.length) return { error: `unexpected ${rest.join(' ')}` };
  if (flags.analyzer.length && command !== 'review') return { error: '--analyzer only works with review' };
  if (flags['github-review'] && command !== 'review') return { error: '--github-review only works with review' };
  return { command, path, flags };
}

/** The MCP tool and its arguments for a parsed command. */
export function toolCall({ command, flags }, absPath) {
  if (command === 'analyzers') return { name: 'list_analyzers', arguments: {} };
  if (command === 'detect') return { name: 'detect_stack', arguments: { path: absPath } };
  const args = { path: absPath };
  if (flags.base) args.base = flags.base;
  if (flags.all) args.scope = 'all';
  if (flags.category.length) args.categories = flags.category;
  if (flags.preexisting) args.include_preexisting = true;
  if (command === 'review' && flags.analyzer.length) return { name: 'run_analyzer', arguments: { ...args, analyzers: flags.analyzer } };
  return { name: COMMANDS[command], arguments: args };
}

/** 1 when the review blocks (or, with strict, an analyzer failed); else 0. */
export function exitCode(command, result, strict) {
  if (command !== 'review' || !result) return 0;
  if (result.blocking > 0) return 1;
  if (strict && result.analyzers?.some((a) => a.error)) return 1;
  return 0;
}

// A review with LLM reviewers on a large diff takes minutes; a silent socket this long is a hung gateway.
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function gatewayUrl(flag) {
  if (flag) return flag.replace(/\/$/, '');
  const envFile = join(ROOT, '.env');
  const fromEnv = existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith('MCR_PORT='))?.slice(9).trim() : undefined;
  return `http://127.0.0.1:${process.env.MCR_PORT ?? fromEnv ?? '7700'}`;
}

/** One JSON-RPC call over node:http: reviews with LLM reviewers can outlast fetch's 300 s header timeout. */
function rpc(base, method, params, id, timeoutMs) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return new Promise((ok, fail) => {
    const req = request(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          const msg = JSON.parse(text);
          if (msg.error) fail(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else ok(msg.result);
        } catch {
          fail(new Error(`HTTP ${res.statusCode} from ${base}/mcp: ${text.slice(0, 200)}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
    req.on('error', fail);
    req.end(body);
  });
}

/** The full findings a PR review shows (get_finding per id), then the review itself. */
async function prReview(base, review, flags) {
  const ids = review.findings.filter((f) => !f.preexisting && !/^(accept|false-positive) /.test(f.decision ?? '')).map((f) => f.id);
  const findings = [];
  for (const [i, id] of ids.entries()) {
    const r = await rpc(base, 'tools/call', { name: 'get_finding', arguments: { id } }, 10 + i, 30_000);
    const text = r?.content?.find((c) => c.type === 'text')?.text;
    if (!r?.isError && text) findings.push(JSON.parse(text).finding);
  }
  const readJson = (file) => (file ? JSON.parse(readFileSync(file, 'utf8')) : undefined);
  const skip = readJson(flags.skip);
  return githubReview(review, findings, { commit: flags.commit, prFiles: readJson(flags['pr-files']), reportUrl: flags['report-url'], skip: skip && new Set(skip) });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`mcr: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { command, flags } = parsed;
  let absPath;
  try {
    absPath = realpathSync(resolve(parsed.path ?? '.'));
  } catch {
    process.stderr.write(`mcr: no such path ${parsed.path}\n`);
    return 2;
  }
  const base = gatewayUrl(flags.url);
  try {
    await rpc(base, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcr-cli', version: '1' } }, 1, 10_000);
  } catch (e) {
    process.stderr.write(`mcr: the gateway does not answer on ${base} (${e.message}). Start it: ./setup.sh or aspire start in ${ROOT}\n`);
    return 2;
  }
  if (command === 'review') process.stderr.write(`mcr: reviewing ${absPath} …\n`);
  let result;
  try {
    result = await rpc(base, 'tools/call', toolCall(parsed, absPath), 2, REVIEW_TIMEOUT_MS);
  } catch (e) {
    process.stderr.write(`mcr: ${e.message}\n`);
    return 2;
  }
  const texts = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
  if (result?.isError) {
    process.stderr.write(`mcr: ${texts.join('\n')}\n`);
    return 2;
  }
  // Tools return Markdown first and JSON last; list_analyzers returns only JSON.
  const markdown = texts.length > 1 ? texts[0] : undefined;
  let json;
  try {
    json = JSON.parse(texts.at(-1) ?? 'null');
  } catch {
    json = undefined;
  }
  if (flags.out && markdown) writeFileSync(flags.out, `${markdown}\n`);
  if (flags['github-review'] && json) {
    try {
      writeFileSync(flags['github-review'], JSON.stringify(await prReview(base, json, flags)));
    } catch (e) {
      process.stderr.write(`mcr: --github-review: ${e.message}\n`);
      return 2;
    }
  }
  process.stdout.write(`${flags.json || !markdown ? JSON.stringify(json, null, 2) : markdown}\n`);
  const failed = json?.analyzers?.filter((a) => a.error) ?? [];
  if (command === 'review' && failed.length) process.stderr.write(`mcr: analyzers failed: ${failed.map((a) => a.name).join(', ')}\n`);
  return exitCode(command, json, flags.strict);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
