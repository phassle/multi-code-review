#!/usr/bin/env node
// Where multi-code-review answers and what it offers: MCP URL, tools,
// running analyzers and judge, and the Aspire dashboard link when it runs
// under Aspire. Markdown on stdout; exit 1 when the gateway does not answer.
//
//   node scripts/status.mjs [--json]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(ROOT, '.env');
const fromEnv = (k) => (existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() : undefined);
const port = process.env.MCR_PORT ?? fromEnv('MCR_PORT') ?? '7700';
const base = `http://127.0.0.1:${port}`;

async function rpc(method, params, id) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  return (await res.json()).result;
}

function dashboard() {
  try {
    const all = JSON.parse(execFileSync('aspire', ['ps', '--format', 'Json', '--non-interactive', '--nologo'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return all.find((a) => a.appHostPath === join(ROOT, 'aspire-apphost', 'apphost.mts'))?.dashboardUrl;
  } catch {
    return undefined;
  }
}

let health;
try {
  health = await (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3_000) })).json();
} catch {
  console.log(`multi-code-review is not running on ${base}. Start it: \`aspire start\` (or \`./setup.sh\`) in ${ROOT}`);
  process.exit(1);
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'status', version: '1' } }, 1);
const tools = (await rpc('tools/list', {}, 2))?.tools ?? [];
const dash = dashboard();
const status = { mcp: `${base}/mcp`, reports: `${base}/reports`, health: `${base}/healthz`, dashboard: dash ?? null, profiles: health.profiles, judge: health.judge, analyzers: health.analyzers, tools: tools.map((t) => ({ name: t.name, title: t.title ?? t.name, description: t.description })) };

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(status, null, 2));
} else {
  const lines = [
    '## multi-code-review is running',
    '',
    `- **MCP:** ${status.mcp}  (add: \`claude mcp add --transport http multi-code-review ${status.mcp}\`)`,
    `- **Reports:** ${base}/reports (one readable page per review)`,
    `- **Dashboard:** ${dash ?? 'not under Aspire (started with ./setup.sh): run `aspire start` for logs in a dashboard'}`,
    `- **Profiles:** ${health.profiles.join(', ')} · **Judge:** ${health.judge ?? 'off'} · **Analyzers:** ${health.analyzers.length}`,
    '',
    '| Tool | What it does |',
    '|---|---|',
    ...tools.map((t) => `| \`${t.name}\` | ${String(t.description ?? '').split('. ')[0].replace(/\|/g, '\\|')} |`),
    '',
    `Analyzers: ${health.analyzers.join(', ')}`,
  ];
  console.log(lines.join('\n'));
}
