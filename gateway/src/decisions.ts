// What a team decided about findings, kept in the reviewed repo at
// .mcr/decisions.yml. This is how the review learns a codebase: a decision is
// matched on later reviews, so an accepted norm break informs instead of
// blocking, a rule the team does not follow goes quiet, and a "fix" stays on
// the list until the finding is gone. Pure, apart from the YAML text in/out.

import { parseDocument, YAMLSeq, isSeq } from 'yaml';
import { z } from 'zod';
import { toolOf, type Finding } from './findings.ts';

export const DECISIONS_FILE = '.mcr/decisions.yml';

export const ACTIONS = ['fix', 'accept', 'false-positive', 'disable'] as const;
export type Action = (typeof ACTIONS)[number];

const decisionSchema = z.object({
  id: z.string().regex(/^D-\d{4,}$/),
  action: z.enum(ACTIONS),
  match: z.object({
    rule: z.string().min(1), // tool:ruleId, e.g. semgrep:<rule> or eslint/<rule> under ts
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    paths: z.array(z.string().min(1)).min(1).optional(),
  }),
  reason: z.string().min(3),
  ref: z.string().optional(),
  decided_by: z.string().optional(),
  decided_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type Decision = z.infer<typeof decisionSchema>;

export interface AppliedDecision {
  id: string;
  action: Action;
  reason: string;
  ref?: string;
}

export function ruleKey(f: Pick<Finding, 'analyzer' | 'ruleId'>): string {
  return `${toolOf(f.analyzer)}:${f.ruleId}`;
}

type GlobToken = { lit: string } | '*' | '?' | '**' | '**/';

function tokenize(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      tokens.push(glob[i + 2] === '/' ? '**/' : '**');
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*' || c === '?') tokens.push(c);
    else {
      const last = tokens.at(-1);
      if (typeof last === 'object') last.lit += c;
      else tokens.push({ lit: c });
    }
  }
  return tokens;
}

/**
 * Does `path` match `glob`? `**` crosses directories (`**\/` also matches none), `*` and `?` do not.
 * No regular expressions: a table over (token, position), so time is tokens × path length whatever the pattern.
 */
export function matchGlob(glob: string, path: string): boolean {
  const tokens = tokenize(glob);
  const n = path.length;
  // next[p]: do tokens t+1.. match path[p..]? Built from the last token back.
  let next = new Uint8Array(n + 1);
  next[n] = 1;
  for (let t = tokens.length - 1; t >= 0; t--) {
    const tok = tokens[t] as GlobToken;
    const cur = new Uint8Array(n + 1);
    let afterSlash = 0; // for '**/': some '/' at q >= p with next[q + 1]
    for (let p = n; p >= 0; p--) {
      if (typeof tok === 'object') cur[p] = path.startsWith(tok.lit, p) && next[p + tok.lit.length] ? 1 : 0;
      else if (tok === '?') cur[p] = p < n && path[p] !== '/' && next[p + 1] ? 1 : 0;
      else if (tok === '*') cur[p] = next[p] || (p < n && path[p] !== '/' && cur[p + 1]) ? 1 : 0;
      else if (tok === '**') cur[p] = next[p] || (p < n && cur[p + 1]) ? 1 : 0;
      else {
        if (p < n && path[p] === '/' && next[p + 1]) afterSlash = 1;
        cur[p] = next[p] || afterSlash ? 1 : 0;
      }
    }
    next = cur;
  }
  return next[0] === 1;
}

export function parseDecisions(text: string | undefined): { decisions: Decision[]; notes: string[] } {
  if (!text?.trim()) return { decisions: [], notes: [] };
  const doc = parseDocument(text);
  if (doc.errors.length) return { decisions: [], notes: [`${DECISIONS_FILE}: ${doc.errors[0]?.message}`] };
  const raw = (doc.toJS() as { decisions?: unknown[] } | null)?.decisions ?? [];
  const decisions: Decision[] = [];
  const notes: string[] = [];
  for (const [i, entry] of raw.entries()) {
    const parsed = decisionSchema.safeParse(entry);
    if (parsed.success) decisions.push(parsed.data);
    else notes.push(`${DECISIONS_FILE}: entry ${i + 1} ignored: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  }
  return { decisions, notes };
}

function specificity(d: Decision): number {
  if (d.match.fingerprint) return 0;
  if (d.match.paths) return 1;
  return 2;
}

/** The most specific live decision for a finding: one occurrence, then paths, then the whole repo. */
export function matchDecision(
  f: Pick<Finding, 'analyzer' | 'ruleId' | 'file' | 'fingerprint'>,
  decisions: Decision[],
  today: string,
): Decision | undefined {
  const key = ruleKey(f);
  return decisions
    .filter((d) => d.match.rule === key)
    .filter((d) => !d.expires_on || d.expires_on >= today)
    .filter((d) => !d.match.fingerprint || d.match.fingerprint === f.fingerprint)
    .filter((d) => !d.match.paths || d.match.paths.some((p) => matchGlob(p, f.file)))
    .sort((a, b) => specificity(a) - specificity(b))[0];
}

export interface Applied {
  findings: Finding[];
  /** Hidden by a `disable` decision. */
  suppressed: number;
  /** Decision ids that matched at least one finding. */
  used: Set<string>;
  notes: string[];
}

export function applyDecisions(findings: Finding[], decisions: Decision[], today: string): Applied {
  const used = new Set<string>();
  const out: Finding[] = [];
  let suppressed = 0;
  for (const f of findings) {
    const d = matchDecision(f, decisions, today);
    if (!d) {
      out.push(f);
      continue;
    }
    used.add(d.id);
    if (d.action === 'disable') {
      suppressed++;
      continue;
    }
    const decision: AppliedDecision = { id: d.id, action: d.action, reason: d.reason, ...(d.ref ? { ref: d.ref } : {}) };
    const accepted = d.action === 'accept' || d.action === 'false-positive';
    out.push({ ...f, decision, blocking: accepted ? false : f.blocking });
  }
  const notes = decisions
    .filter((d) => d.expires_on && d.expires_on < today)
    .map((d) => `${d.id} expired on ${d.expires_on}; its findings are back. Renew or remove it.`);
  return { findings: out, suppressed, used, notes };
}

export interface NewDecision {
  action: Action;
  rule: string;
  /** Present: this one occurrence. */
  fingerprint?: string;
  paths?: string[];
  reason: string;
  ref?: string;
  decided_by?: string;
  expires_on?: string;
}

function nextNumber(decisions: Array<{ id?: unknown }>): number {
  const numbers = decisions.map((d) => (typeof d.id === 'string' ? Number(/^D-(\d+)$/.exec(d.id)?.[1] ?? 0) : 0));
  return Math.max(0, ...numbers) + 1;
}

const HEADER = `# multi-code-review decisions. Reviewed like code; matched on every review.
# action: fix (keep on the to-fix list) | accept (norm broken on purpose: inform, never block)
#         false-positive (the tool is wrong here) | disable (this rule does not apply: hide it)
# match:  rule (analyzer:ruleId), plus fingerprint (one occurrence) or paths (globs).
`;

/** Appends decisions to the file's text, keeping its comments and order. Returns the new text and the ids. */
export function appendDecisions(existing: string | undefined, additions: NewDecision[], today: string): { text: string; ids: string[] } {
  const doc = parseDocument(existing?.trim() ? existing : `${HEADER}version: 1\ndecisions: []\n`);
  let seq = doc.get('decisions');
  if (!isSeq(seq)) {
    seq = new YAMLSeq();
    doc.set('decisions', seq);
  }
  const list = seq as YAMLSeq;
  const plain = (list.toJSON() as Array<{ id?: unknown }>) ?? [];
  let n = nextNumber(plain);
  const ids: string[] = [];
  for (const a of additions) {
    const id = `D-${String(n++).padStart(4, '0')}`;
    ids.push(id);
    const entry: Decision = {
      id,
      action: a.action,
      match: {
        rule: a.rule,
        ...(a.fingerprint ? { fingerprint: a.fingerprint } : {}),
        ...(a.paths?.length ? { paths: a.paths } : {}),
      },
      reason: a.reason,
      ...(a.ref ? { ref: a.ref } : {}),
      ...(a.decided_by ? { decided_by: a.decided_by } : {}),
      decided_on: today,
      ...(a.expires_on ? { expires_on: a.expires_on } : {}),
    };
    decisionSchema.parse(entry);
    list.add(doc.createNode(entry));
  }
  if (list.items.length > 0) list.flow = false;
  return { text: doc.toString({ lineWidth: 0 }), ids };
}

export interface TriageGroup {
  rule: string;
  category: Finding['category'];
  severity: Finding['severity'];
  count: number;
  blocking: number;
  files: string[];
  findings: Array<Pick<Finding, 'id' | 'file' | 'line' | 'message'>>;
  /** Why deciding this at rule or paths level may be better than one by one. */
  suggestion?: string;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/** Undecided findings, one group per rule, most severe and most frequent first: the triage agenda. */
export function triageGroups(findings: Finding[], decisions: Decision[]): TriageGroup[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.decision) continue;
    const key = ruleKey(f);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.entries()]
    .map(([rule, fs]): TriageGroup => {
      const files = [...new Set(fs.map((f) => f.file))].sort();
      const severity = fs.map((f) => f.severity).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0] ?? 'low';
      const pastAccepts = decisions.filter((d) => d.match.rule === rule && d.match.fingerprint && d.action !== 'fix').length;
      let suggestion: string | undefined;
      if (pastAccepts >= 3) suggestion = `${pastAccepts} occurrences of this rule were already accepted one by one; consider one decision for the rule or for paths.`;
      else if (files.length >= 3) suggestion = `Spread over ${files.length} files; one decision for the rule or for paths may fit.`;
      return {
        rule,
        category: fs[0]?.category ?? 'best-practices',
        severity,
        count: fs.length,
        blocking: fs.filter((f) => f.blocking).length,
        files,
        findings: fs.map(({ id, file, line, message }) => ({ id, file, line, message: message.split('\n')[0] ?? '' })),
        ...(suggestion ? { suggestion } : {}),
      };
    })
    .sort((a, b) => b.blocking - a.blocking || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);
}
