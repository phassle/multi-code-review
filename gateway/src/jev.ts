// The TypeSafe System One API (Jev). Only the gateway calls it; analyzers have
// no route out. Off unless the typesafe_api_key secret holds a key.

import { readFileSync } from 'node:fs';
import type { Answer, Ask, JudgeRequest } from './judge.ts';

const URL_ = process.env.MCR_JEV_URL ?? 'https://api.typesafe.ai/v1/systemone';
// Pinned, so a verdict can be replayed.
export const JEV_MODEL = process.env.MCR_JEV_MODEL ?? 'jev-1.13.0';
const KEY_FILE = process.env.MCR_JEV_KEY_FILE ?? '/run/secrets/typesafe_api_key';
const TIMEOUT_MS = Number(process.env.MCR_JEV_TIMEOUT_MS ?? 10_000);

function key(): string | undefined {
  try {
    return readFileSync(KEY_FILE, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function jevEnabled(): boolean {
  return process.env.MCR_JEV !== 'off' && key() !== undefined;
}

export const askJev: Ask = async (req: JudgeRequest) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key()}` },
      body: JSON.stringify({ model: JEV_MODEL, state: req.state, questions: req.questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { answers: Record<string, Answer> }).answers;
  }
};

/** Run tasks with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}
