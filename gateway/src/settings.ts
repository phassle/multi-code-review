// How hard to review each category, set per repo in .mcr/settings.yml (with a
// default for every repo from MCR_LEVELS). Pure, apart from the YAML text in.
//
//   review:
//     security: maximum
//     testing: minimum
//     best-practices: off
//
// off       not reviewed
// minimum   analyzers only; only high severity shown; high blocks
// medium    analyzers + LLM reviewer (not on trivial diffs); high and medium shown; high blocks   (default)
// maximum   analyzers + LLM reviewer on every diff; everything shown; high and medium block

import { parse } from 'yaml';
import { z } from 'zod';
import { CATEGORIES, type Category, type Severity } from './findings.ts';

export const SETTINGS_FILE = '.mcr/settings.yml';
export const LEVELS = ['off', 'minimum', 'medium', 'maximum'] as const;
export type Level = (typeof LEVELS)[number];
export type Levels = Record<Category, Level>;

const schema = z.object({
  review: z.record(z.string(), z.enum(LEVELS)).optional(),
});

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function defaultLevels(spec?: string): { levels: Levels; notes: string[] } {
  const levels = Object.fromEntries(CATEGORIES.map((c) => [c, 'medium'])) as Levels;
  const notes: string[] = [];
  for (const part of (spec ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [cat, level] = part.split('=').map((s) => s.trim());
    if ((CATEGORIES as readonly string[]).includes(cat ?? '') && (LEVELS as readonly string[]).includes(level ?? '')) levels[cat as Category] = level as Level;
    else notes.push(`MCR_LEVELS: ignored "${part}"`);
  }
  return { levels, notes };
}

/** The repo's settings over the defaults. A broken file keeps the defaults and says why. */
export function parseSettings(text: string | undefined, defaults: Levels): { levels: Levels; notes: string[] } {
  const levels = { ...defaults };
  if (!text?.trim()) return { levels, notes: [] };
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { levels, notes: [`${SETTINGS_FILE}: not valid YAML (${(e as Error).message.split('\n')[0]}); using defaults`] };
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) return { levels, notes: [`${SETTINGS_FILE}: levels must be one of ${LEVELS.join(', ')}; using defaults`] };
  const notes: string[] = [];
  for (const [cat, level] of Object.entries(parsed.data.review ?? {})) {
    if ((CATEGORIES as readonly string[]).includes(cat)) levels[cat as Category] = level;
    else notes.push(`${SETTINGS_FILE}: unknown category "${cat}"`);
  }
  return { levels, notes };
}

/** Whether an analyzer runs: never for an off category; the model reviewer not at minimum, and on trivial diffs only at maximum. */
export function runs(level: Level, model: boolean, trivial: boolean): boolean {
  if (level === 'off') return false;
  if (!model) return true;
  if (level === 'minimum') return false;
  return !trivial || level === 'maximum';
}

/** The lowest severity that blocks at this level. */
export function blocksFrom(level: Level): Severity {
  return level === 'maximum' ? 'medium' : 'high';
}

/** The lowest severity shown at this level. */
export function shownFrom(level: Level): Severity | null {
  return level === 'off' ? null : level === 'minimum' ? 'high' : level === 'medium' ? 'medium' : 'low';
}

export function blocks(level: Level, severity: Severity): boolean {
  return RANK[severity] <= RANK[blocksFrom(level)];
}

export function shown(level: Level, severity: Severity): boolean {
  const from = shownFrom(level);
  return from !== null && RANK[severity] <= RANK[from];
}

export function levelsLine(levels: Levels): string {
  return CATEGORIES.map((c) => `${c} ${levels[c]}`).join(' · ');
}
