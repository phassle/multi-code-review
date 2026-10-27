// Every analyzer container this repo can run, grouped in compose profiles.
// `core` always runs; a language profile starts when ./setup finds its stack;
// `llm` starts when an LLM API key is configured, and reviews every language.
// compose.yaml must list the same services (tests/catalog.test.ts checks it).
// Pure data.

import type { Category } from './findings.ts';

export const PROFILES = ['core', 'node', 'jvm', 'dotnet', 'php', 'cpp', 'python', 'ruby', 'go', 'infra', 'llm'] as const;
export type Profile = (typeof PROFILES)[number];

export interface CatalogEntry {
  /** <category>-<tool>, also the compose service and host name. */
  name: string;
  tool: string;
  category: Category;
  profile: Profile;
}

function entries(tool: string, profile: Profile, categories: Category[]): CatalogEntry[] {
  return categories.map((category) => ({ name: `${category}-${tool}`, tool, category, profile }));
}

export const CATALOG: CatalogEntry[] = [
  ...entries('semgrep', 'core', ['security', 'best-practices', 'correctness', 'reliability']),
  ...entries('gitleaks', 'core', ['security']),
  ...entries('eslint', 'node', ['security', 'architecture', 'best-practices', 'testing', 'correctness', 'reliability']),
  ...entries('tsc', 'node', ['correctness']),
  ...entries('pmd', 'jvm', ['security', 'architecture', 'best-practices', 'correctness', 'reliability']),
  ...entries('roslyn', 'dotnet', ['security', 'architecture', 'best-practices', 'correctness', 'reliability']),
  ...entries('detekt', 'jvm', ['best-practices', 'correctness', 'reliability']),
  ...entries('phpstan', 'php', ['best-practices', 'correctness']),
  ...entries('cppcheck', 'cpp', ['security', 'best-practices', 'correctness', 'reliability']),
  ...entries('bandit', 'python', ['security']),
  ...entries('ruff', 'python', ['best-practices', 'testing', 'correctness', 'reliability']),
  ...entries('rubocop', 'ruby', ['security', 'best-practices', 'testing', 'correctness', 'reliability']),
  ...entries('brakeman', 'ruby', ['security']),
  ...entries('golangci-lint', 'go', ['security', 'best-practices', 'correctness', 'reliability']),
  ...entries('hadolint', 'infra', ['best-practices']),
  ...entries('checkov', 'infra', ['security', 'reliability']),
  ...entries('llm', 'llm', ['security', 'architecture', 'best-practices', 'testing', 'correctness', 'reliability']),
];

/** Tools that read any language: they cover every stack. */
export const UNIVERSAL_TOOLS = new Set(['llm', 'gitleaks']);

/** Model reviewers: skipped at level minimum and on trivial diffs (settings.ts `runs`). Deterministic tools always run. */
export const MODEL_TOOLS = new Set(['llm']);

/** Profiles from a COMPOSE_PROFILES-style list; core is always on, unknown names are ignored. */
export function activeProfiles(spec: string | undefined): Profile[] {
  const named = (spec ?? '').split(',').map((p) => p.trim());
  return PROFILES.filter((p) => p === 'core' || named.includes(p));
}

/** The MCR_ANALYZERS registry string for these profiles. */
export function registryFor(profiles: Profile[]): string {
  return CATALOG.filter((e) => profiles.includes(e.profile))
    .map((e) => `${e.name}=http://${e.name}:8080`)
    .join(',');
}
