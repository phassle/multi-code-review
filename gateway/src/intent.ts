// What a change is meant to do: the caller's words (the task, a PR
// description, a ticket) or, without them, the branch's commit messages.
// Model reviewers get it to check the change against it. Pure.

/** Enough for a PR description or a ticket; keeps the LLM prompt budget for code. */
export const MAX_INTENT_CHARS = 4000;

export interface Intent {
  text: string;
  /** caller: passed to run_review. commits: the commit messages since the merge base. */
  source: 'caller' | 'commits';
}

/** Git trailers and bot noise that say nothing about the intent. */
const NOISE = /^(co-authored-by|signed-off-by|reviewed-by|change-id|🤖 generated with)\b/i;

function cap(text: string): string {
  return text.length <= MAX_INTENT_CHARS ? text : `${text.slice(0, MAX_INTENT_CHARS - 1)}…`;
}

/** Commit messages (newest first, as git log gives them) as one oldest-first list; merges and fixups dropped. */
export function fromCommits(messages: string[]): string {
  // Subject -> the longest body seen for it; Map keeps first-seen (oldest) order.
  const bodies = new Map<string, string>();
  for (const raw of [...messages].reverse()) {
    const lines = raw.trim().split('\n').filter((l) => !NOISE.test(l.trim()));
    const subject = lines[0]?.trim() ?? '';
    if (!subject || /^(merge (branch|pull request|remote-tracking)|fixup!|squash!)/i.test(subject)) continue;
    const body = lines.slice(1).join('\n').trim();
    if (body.length >= (bodies.get(subject)?.length ?? 0)) bodies.set(subject, body);
  }
  return [...bodies].map(([subject, body]) => (body ? `- ${subject}\n${body.replace(/^/gm, '  ')}` : `- ${subject}`)).join('\n');
}

/** The caller's intent when given, else the commits'; undefined when there is neither. */
export function intentOf(given: string | undefined, commitMessages: string[]): Intent | undefined {
  const caller = given?.trim();
  if (caller) return { text: cap(caller), source: 'caller' };
  const commits = fromCommits(commitMessages);
  return commits ? { text: cap(commits), source: 'commits' } : undefined;
}
