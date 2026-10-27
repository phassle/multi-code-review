// The analyzer registry: MCR_ANALYZERS="security-semgrep=http://security-semgrep:8080,...".
// Each analyzer answers GET /info and POST /analyze (see analyzers/_kit/serve.mjs).

import { extname, basename } from 'node:path';

export interface AnalyzerInfo {
  /** <category>-<tool>, e.g. security-semgrep. */
  name: string;
  tool?: string;
  /** The one category this analyzer reviews. */
  category?: string;
  version: string;
  languages: string[];
  categories: string[];
  extensions: string[];
}

export interface Analyzer {
  name: string;
  url: string;
}

const ANALYZE_TIMEOUT_MS = Number(process.env.MCR_ANALYZE_TIMEOUT_MS ?? 300_000);

export function parseRegistry(spec: string | undefined): Analyzer[] {
  return (spec ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, url] = entry.split('=');
      if (!name || !url) throw new Error(`bad MCR_ANALYZERS entry: ${entry}`);
      return { name, url: url.replace(/\/$/, '') };
    });
}

/** Files an analyzer handles: by extension, by exact basename (Dockerfile), by basename prefix ending in "." (Dockerfile.), or all of them ("*"). */
export function filesFor(info: AnalyzerInfo, files: string[]): string[] {
  if (info.extensions.includes('*')) return files;
  const prefixes = info.extensions.filter((e) => e.length > 1 && e.endsWith('.') && !e.startsWith('.'));
  return files.filter((f) => info.extensions.includes(extname(f)) || info.extensions.includes(basename(f)) || prefixes.some((p) => basename(f).startsWith(p)));
}

export async function infoOf(a: Analyzer): Promise<AnalyzerInfo | { name: string; error: string }> {
  try {
    const res = await fetch(`${a.url}/info`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { name: a.name, error: `HTTP ${res.status}` };
    return { ...((await res.json()) as AnalyzerInfo), name: a.name };
  } catch (e) {
    return { name: a.name, error: `unreachable: ${(e as Error).message}` };
  }
}

/** Changed line ranges per file, for analyzers that review the diff itself (llm). */
export type ChangedRanges = Record<string, Array<[number, number]> | 'all'>;

export async function analyze(a: Analyzer, root: string, files: string[], changes?: ChangedRanges): Promise<unknown> {
  const res = await fetch(`${a.url}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, files, ...(changes ? { changes } : {}) }),
    signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: { error?: string } | undefined;
  try {
    body = JSON.parse(text) as { error?: string };
  } catch {
    body = undefined;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error ?? text.slice(0, 300)}`);
  if (body === undefined) throw new Error(`HTTP ${res.status}: not JSON: ${text.slice(0, 300)}`);
  return body;
}
