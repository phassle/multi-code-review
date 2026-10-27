// Aspire TypeScript AppHost for multi-code-review.
//
//   aspire start            (from the repo root)
//
// Docker Compose still runs the containers: it gives the analyzers their
// internal, no-egress network, which Aspire's own container network does not.
// Aspire wraps it: one `stack` resource runs `docker compose up`, and every
// container gets its own resource with its own logs, so `aspire logs <name>`
// and the dashboard show each analyzer separately. `review-mcp` carries the
// MCP endpoint, its health check and links.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder } from './.aspire/modules/aspire.mjs';
import { activeProfiles, CATALOG } from '../gateway/src/catalog.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, '.env');

function envValue(name: string): string | undefined {
    if (!existsSync(ENV_FILE)) return undefined;
    const line = readFileSync(ENV_FILE, 'utf8').split('\n').reverse().find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
}

// No .env yet: scan the codebase once (setup.sh --dry-run writes the profiles).
if (envValue('COMPOSE_PROFILES') === undefined) {
    execFileSync(join(ROOT, 'setup.sh'), ['--dry-run'], { cwd: ROOT, stdio: 'inherit' });
}

const profiles = activeProfiles(envValue('COMPOSE_PROFILES'));
const port = Number(envValue('MCR_PORT') ?? 7700);
const containers = CATALOG.filter((e) => profiles.includes(e.profile));

const builder = await createBuilder();

// The whole compose stack. Stopping it in Aspire stops every container.
const stack = await builder
    .addExecutable('stack', 'docker', ROOT, ['compose', 'up', '--build', '--remove-orphans'])
    .withIconName('Stack')
    .withCommand('rescan', 'Rescan codebase', async () => {
        try {
            execFileSync(join(ROOT, 'setup.sh'), ['--dry-run'], { cwd: ROOT, stdio: 'ignore' });
            return { success: true, message: `Profiles now: ${envValue('COMPOSE_PROFILES') || 'core only'}. Restart the AppHost to apply.` };
        } catch (e) {
            return { success: false, errorMessage: (e as Error).message };
        }
    });

/** Follows one container's logs; re-attaches when compose recreates it. */
function follow(name: string): string[] {
    return ['-c', `while true; do docker inspect ${name} >/dev/null 2>&1 && docker logs -f ${name} 2>&1; sleep 2; done`];
}

// The gateway: MCP endpoint, health and links for agents and the dashboard.
await builder
    .addExecutable('review-mcp', 'sh', ROOT, follow('review-mcp'))
    .withParentRelationship(stack)
    .withHttpEndpoint({ name: 'http', port, targetPort: port })
    .withEndpointCallback('http', async (endpoint) => {
        await endpoint.isProxied.set(false);
    })
    .withHttpHealthCheck({ path: '/healthz' })
    .withMcpServer({ path: '/mcp' })
    .withUrl(`http://127.0.0.1:${port}/mcp`, { displayText: 'MCP endpoint' })
    .withUrl(`http://127.0.0.1:${port}/healthz`, { displayText: 'Health (analyzers, judge)' })
    .withIconName('PlugConnected');

// Review pages kept for MCR_REPORT_TTL_DAYS; only the gateway talks to it.
await builder
    .addExecutable('report-store', 'sh', ROOT, follow('report-store'))
    .withParentRelationship(stack)
    .withIconName('Archive');

for (const c of containers) {
    await builder
        .addExecutable(c.name, 'sh', ROOT, follow(c.name))
        .withParentRelationship(stack)
        .withIconName(c.tool === 'llm' ? 'BrainCircuit' : 'Bug');
}

await builder.build().run();
