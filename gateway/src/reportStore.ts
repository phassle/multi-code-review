// Client for the report-store container (I/O): readable review pages kept for
// MCR_REPORT_TTL_DAYS, so links work after a gateway restart and after the
// reviewed repo is gone. Without MCR_REPORT_STORE there is no store and
// reports live in the gateway's memory only.

import type { ReportMeta } from './html.ts';

const TIMEOUT_MS = 5_000;

export interface ReportStore {
  put(meta: ReportMeta, html: string): Promise<void>;
  get(id: string): Promise<string | undefined>;
  list(): Promise<ReportMeta[]>;
  ttlDays(): Promise<number | undefined>;
}

export function reportStore(baseUrl: string | undefined): ReportStore | undefined {
  if (!baseUrl) return undefined;
  const base = baseUrl.replace(/\/$/, '');
  const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let ttl: number | undefined;
  return {
    async put(meta, html) {
      const res = await call(`/reports/${meta.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ meta, html }) });
      if (!res.ok) throw new Error(`report-store: HTTP ${res.status} for ${meta.id}`);
    },
    async get(id) {
      const res = await call(`/reports/${id}`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`report-store: HTTP ${res.status} for ${id}`);
      return ((await res.json()) as { html?: string }).html;
    },
    async list() {
      const res = await call('/reports');
      if (!res.ok) throw new Error(`report-store: HTTP ${res.status}`);
      return (await res.json()) as ReportMeta[];
    },
    async ttlDays() {
      if (ttl === undefined) {
        const res = await call('/healthz');
        if (res.ok) ttl = ((await res.json()) as { ttlDays?: number }).ttlDays;
      }
      return ttl;
    },
  };
}
