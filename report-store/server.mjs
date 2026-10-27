// report-store: keeps the readable review pages (HTML with code excerpts) for
// MCR_REPORT_TTL_DAYS (default 7), on the `reports` volume. Only the gateway
// reaches it (internal network `reports`); no host port, no other client.
//
//   PUT /reports/R-xxxxxxxx  { meta, html }  -> 204
//   GET /reports/R-xxxxxxxx                  -> { meta, html } or 404 (also when expired)
//   GET /reports                             -> [meta], newest first
//   GET /healthz

import { createServer } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expired, ID, MAX_BYTES, ttlMs, validate } from './store.mjs';

const DIR = process.env.MCR_REPORT_DIR ?? '/data';
const TTL = ttlMs(process.env.MCR_REPORT_TTL_DAYS);
const PORT = Number(process.env.PORT ?? 8080);
const LIST_LIMIT = 200;

mkdirSync(DIR, { recursive: true });
const file = (id) => join(DIR, `${id}.json`);

function read(id) {
  try {
    const doc = JSON.parse(readFileSync(file(id), 'utf8'));
    if (!expired(doc.meta?.storedAt, Date.now(), TTL)) return doc;
    rmSync(file(id), { force: true });
  } catch {
    // Missing or unreadable: not there.
  }
  return undefined;
}

/** Delete every report past its TTL; returns how many. */
function sweep() {
  let n = 0;
  for (const name of readdirSync(DIR)) {
    const id = name.replace(/\.json$/, '');
    if (!ID.test(id)) continue;
    // mtime is when it was stored; read() also checks the stored time.
    if (expired(statSync(join(DIR, name)).mtimeMs, Date.now(), TTL) || !read(id)) {
      rmSync(join(DIR, name), { force: true });
      n++;
    }
  }
  return n;
}

function list() {
  return readdirSync(DIR)
    .map((name) => name.replace(/\.json$/, ''))
    .filter((id) => ID.test(id))
    .map((id) => read(id)?.meta)
    .filter(Boolean)
    .sort((a, b) => b.storedAt - a.storedAt)
    .slice(0, LIST_LIMIT);
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BYTES) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const json = (res, status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

createServer(async (req, res) => {
  try {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/healthz') return json(res, 200, { ok: true, ttlDays: TTL / 86_400_000 });
    if (req.method === 'GET' && url === '/reports') return json(res, 200, list());
    const id = url.startsWith('/reports/') ? url.slice('/reports/'.length) : '';
    if (!ID.test(id)) return json(res, 404, { error: 'not found' });
    if (req.method === 'GET') {
      const doc = read(id);
      return doc ? json(res, 200, doc) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'PUT') {
      const checked = validate(id, await body(req), Date.now());
      if (checked.error) return json(res, 400, { error: checked.error });
      // Write then rename: a reader never sees half a report.
      const tmp = `${file(id)}.tmp`;
      writeFileSync(tmp, JSON.stringify(checked.doc), { mode: 0o600 });
      renameSync(tmp, file(id));
      return res.writeHead(204).end();
    }
    res.writeHead(405).end();
  } catch (e) {
    json(res, e.status ?? 400, { error: e.status ? e.message : 'bad request' });
  }
}).listen(PORT, () => {
  console.log(`report-store on :${PORT}; ${DIR}; reports kept ${TTL / 86_400_000} days; swept ${sweep()} expired`);
  setInterval(() => {
    const n = sweep();
    if (n) console.log(`report-store: deleted ${n} expired report(s)`);
  }, 60 * 60 * 1000).unref();
});
