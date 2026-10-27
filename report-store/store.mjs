// Pure rules of the report store: ids, metadata, and when a report has expired.

export const ID = /^R-[0-9a-f]{8}$/;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TTL_DAYS = 7;
/** A stored report is one HTML page with code in it: cap what one PUT may hold. */
export const MAX_BYTES = 20 * 1024 * 1024;

/** MCR_REPORT_TTL_DAYS -> milliseconds; anything not a positive number gives the default. */
export function ttlMs(raw) {
  const days = Number(raw);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS) * DAY_MS;
}

export function expired(storedAt, now, ttl) {
  return !(storedAt > 0) || now - storedAt >= ttl;
}

/** The body of PUT /reports/:id, checked: { meta, html }. Returns an error message or the document to store. */
export function validate(id, body, now) {
  if (!ID.test(id)) return { error: 'bad id' };
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const { meta, html } = body;
  if (typeof html !== 'string' || !html.startsWith('<!doctype html>')) return { error: 'html must be a page' };
  if (!meta || typeof meta !== 'object') return { error: 'meta must be an object' };
  const m = {
    id,
    repoRoot: String(meta.repoRoot ?? ''),
    scope: meta.scope === 'all' ? 'all' : 'diff',
    base: String(meta.base ?? ''),
    blocking: Number(meta.blocking) || 0,
    findings: Number(meta.findings) || 0,
    storedAt: now,
  };
  return { doc: { meta: m, html } };
}
