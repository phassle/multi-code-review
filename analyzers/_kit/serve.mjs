// The analyzer contract, shared by every analyzer image. Zero dependencies.
//
//   GET  /info     -> { name, version, languages, categories, extensions }
//   POST /analyze  { root, files, changes? } -> SARIF 2.1.0 log
//
// `root` is an absolute path inside MCR_ROOT (mounted read-only at the same
// path as on the host); `files` are paths relative to it; `changes` maps a file
// to its changed line ranges ([[from, to], ...] or "all"), for diff reviewers. Each SARIF result
// carries properties.category (one of CATEGORIES) and properties.severity
// (high | medium | low). An adapter only has to produce findings; this file
// turns them into SARIF and serves them.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const CATEGORIES = [
  'security',
  'architecture',
  'best-practices',
  'testing',
  'correctness',
  'reliability',
];

const MAX_BODY = 1_000_000;
// The gateway gives up on /analyze after MCR_ANALYZE_TIMEOUT_MS (300 s); a tool
// still running after that only burns CPU, so it is killed.
const TOOL_TIMEOUT_MS = Number(process.env.MCR_TOOL_TIMEOUT_MS ?? 300_000);

/** Runs a command without a shell; resolves with exit code, stdout and stderr. Killed after `timeoutMs`. */
export function run(cmd, args, { timeoutMs = TOOL_TIMEOUT_MS, ...opts } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: -1, stdout: '', stderr: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString();
      done(
        timedOut
          ? { code: -1, stdout: '', stderr: `${cmd} killed after ${timeoutMs / 1000} s (MCR_TOOL_TIMEOUT_MS)\n${stderr}` }
          : { code, stdout: Buffer.concat(out).toString(), stderr },
      );
    });
  });
}

/** Rejects roots outside MCR_ROOT and file paths that escape the root. */
export function checkRequest(body, mcrRoot) {
  if (!body || typeof body.root !== 'string' || !isAbsolute(body.root)) {
    throw new Error('root must be an absolute path');
  }
  const root = realpathSync(body.root);
  const allowed = realpathSync(mcrRoot);
  if (root !== allowed && !root.startsWith(allowed + sep)) {
    throw new Error(`root is outside MCR_ROOT (${mcrRoot})`);
  }
  const files = Array.isArray(body.files) ? body.files.filter((f) => typeof f === 'string') : [];
  for (const f of files) {
    const rel = relative(root, resolve(root, f));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`file escapes root: ${f}`);
  }
  const changes = {};
  if (body.changes && typeof body.changes === 'object') {
    for (const f of files) {
      const c = body.changes[f];
      if (c === 'all' || (Array.isArray(c) && c.every((r) => Array.isArray(r) && r.length === 2 && r.every(Number.isInteger)))) changes[f] = c;
    }
  }
  return { root, files, changes };
}

/**
 * findings: { ruleId, message, file, line, endLine?, column?, category,
 *             severity, helpUri?, ruleName? }
 * notes:    strings for toolExecutionNotifications (skipped files, missing deps).
 */
export function toSarif(info, findings, notes = []) {
  const rules = new Map();
  for (const f of findings) {
    if (!rules.has(f.ruleId)) {
      rules.set(f.ruleId, {
        id: f.ruleId,
        ...(f.ruleName ? { name: f.ruleName } : {}),
        ...(f.helpUri ? { helpUri: f.helpUri } : {}),
      });
    }
  }
  const level = { high: 'error', medium: 'warning', low: 'note' };
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: info.name, version: info.version, rules: [...rules.values()] } },
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: notes.map((text) => ({ message: { text }, level: 'warning' })),
          },
        ],
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          level: level[f.severity] ?? 'warning',
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: {
                  startLine: f.line,
                  ...(f.endLine ? { endLine: f.endLine } : {}),
                  ...(f.column ? { startColumn: f.column } : {}),
                },
              },
            },
          ],
          properties: { category: f.category, severity: f.severity },
        })),
      },
    ],
  };
}

function readJson(req) {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        done(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch (e) {
        fail(e);
      }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * adapter: { info, analyze({ root, files, category }) -> { findings, notes } }
 *
 * One container reviews one category (MCR_CATEGORY) and is named after it,
 * e.g. security-semgrep. The same image can run as several containers, one per
 * category; findings outside the container's category are dropped here.
 */
export function serve(adapter) {
  const mcrRoot = process.env.MCR_ROOT;
  if (!mcrRoot) throw new Error('MCR_ROOT is not set');
  const category = process.env.MCR_CATEGORY;
  if (!CATEGORIES.includes(category)) throw new Error(`MCR_CATEGORY must be one of ${CATEGORIES.join(', ')}`);
  const info = {
    ...adapter.info,
    name: process.env.MCR_NAME ?? `${category}-${adapter.info.name}`,
    tool: adapter.info.name,
    category,
    categories: [category],
  };
  const port = Number(process.env.PORT ?? 8080);
  createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/info') return send(res, 200, info);
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'POST' && req.url === '/analyze') {
        const request = checkRequest(await readJson(req), mcrRoot);
        const started = Date.now();
        const result = await adapter.analyze({ ...request, category });
        const findings = result.findings.filter((f) => f.category === category);
        console.log(`${info.name}: ${findings.length} findings in ${Date.now() - started} ms`);
        return send(res, 200, toSarif(info, findings, result.notes));
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error(`${info.name}: ${e.message}`);
      send(res, 400, { error: e.message });
    }
  }).listen(port, () => console.log(`${info.name} listening on :${port}`));
}
