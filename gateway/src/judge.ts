// Small typed judgments about a review, asked of a System One model (Jev):
// is a finding a real problem, is an LLM finding speculative, how risky is a
// diff. This file builds the questions and turns answers into policy; the
// policy lives here, in code, not in the model. Pure.
//
// The model may only take blocking away (never add it), never alone for
// security, and every answer is kept on the finding so a verdict can be
// explained and replayed.

import type { Decision } from './decisions.ts';
import { toolOf, type Finding } from './findings.ts';

export type Noul = { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };
export type Score = { type: 'score'; instructions: unknown; criteria: unknown[] };
export type Question = Noul | Score;
export interface JudgeRequest {
  state: unknown;
  questions: Record<string, Question>;
}
export type Answer = { type: 'noul'; noul: number } | { type: 'score'; score: number; confidence: number; probabilities?: unknown };
export type Ask = (req: JudgeRequest) => Promise<Record<string, Answer>>;

export interface Assessment {
  model: string;
  /** P(the finding is a real problem). */
  pReal: number;
  /** For model findings: P(concrete), P(speculative), P(style preference). */
  concrete?: number;
  speculative?: number;
  style?: number;
  verdict: 'real' | 'likely-false-positive' | 'speculative' | 'unsure';
}

/** Jev reads at most 32k tokens per request (state + longest question). Stay well under, estimating ~3 chars per token for code. */
export const JEV_MAX_TOKENS = 32_000;
const JEV_BUDGET_CHARS = Math.floor(JEV_MAX_TOKENS * 0.6 * 3);

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 3);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} …(${text.length - max} more chars)`;
}

/** Long lines (minified code, data) are cut, then lines furthest from the flagged ones go until the code fits. */
export function fitCode(code: string, maxChars: number): string {
  let lines = code.split('\n').map((l) => clip(l, 400));
  while (lines.join('\n').length > maxChars && lines.length > 3) {
    const marked = lines.findIndex((l) => l.startsWith('>>'));
    const centre = marked < 0 ? Math.floor(lines.length / 2) : marked;
    lines = centre > lines.length - 1 - centre ? lines.slice(1) : lines.slice(0, -1);
  }
  return clip(lines.join('\n'), maxChars);
}

export const POLICY = {
  /** Below this P(real), a non-security blocking analyzer finding needs a human to confirm instead of blocking. */
  unblockBelow: 0.15,
  /** Model findings below this P(real), or failing a speculation check, become info. */
  modelRealBelow: 0.4,
  /** At or above this P(real), a model finding is kept even if it also looks speculative. */
  keepRealAbove: 0.7,
  speculativeAbove: 0.7,
  styleAbove: 0.7,
  concreteBelow: 0.3,
  /** At most this many findings are judged per review, most severe first. */
  maxFindings: 60,
};

function pathKind(file: string): string {
  if (/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|Test\.java$|Tests?\.cs$/.test(file)) return 'test code';
  if (/(^|\/)(migrations?)\//i.test(file)) return 'database migration';
  if (/(^|\/)(examples?|samples?|docs?|scripts?|tools?)\//.test(file)) return 'example, docs or tooling';
  return 'application code';
}

export function isModelFinding(f: Finding): boolean {
  return toolOf(f.analyzer) === 'llm' || f.analyzer.startsWith('llm');
}

/** Questions for one finding: the code around it and what the team said about the rule before. */
export function findingRequest(f: Finding, code: string, decisions: Decision[]): JudgeRequest {
  const rule = `${toolOf(f.analyzer)}:${f.ruleId}`;
  const past = decisions.filter((d) => d.match.rule === rule).slice(0, 5).map((d) => ({ action: d.action, reason: clip(d.reason, 300) }));
  const finding = { reported_by: isModelFinding(f) ? 'an LLM reviewer' : `the static analyzer ${toolOf(f.analyzer)}`, rule: f.ruleId, category: f.category, severity: f.severity, message: clip(f.message, 2_000), file: f.file, line: f.line, file_kind: pathKind(f.file) };
  const state = {
    finding,
    code: fitCode(code, JEV_BUDGET_CHARS - JSON.stringify({ finding, past }).length),
    ...(past.length ? { team_decisions_on_this_rule: past } : {}),
  };
  const questions: Record<string, Question> = {
    real: {
      type: 'noul',
      instructions: 'Is `finding` a real problem in `code` (the flagged line is marked with >>) that a careful reviewer of this repository would want fixed or consciously accepted? Take `finding.file_kind` and any `team_decisions_on_this_rule` into account.',
      criteria: {
        true: 'The flagged code really has the problem the message describes, in this context.',
        false: 'A false positive: the pattern matches but the problem does not apply here (input is trusted or constant, it is test or example code where it is harmless, it is already handled nearby, or the team has said this rule does not apply).',
      },
    },
  };
  if (isModelFinding(f)) {
    questions.concrete = { type: 'noul', instructions: 'Does `finding.message` point to a specific behavior of the code at the flagged line in `code`, rather than a general concern?' };
    questions.speculative = { type: 'noul', instructions: 'Does `finding.message` depend on assumptions about code or behavior that `code` does not show (how callers use it, what inputs arrive, how other systems behave)?' };
    questions.style = { type: 'noul', instructions: 'Is `finding.message` a matter of style, naming or personal preference rather than a defect or risk?' };
  }
  return { state, questions };
}

const num = (a: Answer | undefined): number | undefined => (a?.type === 'noul' ? a.noul : undefined);

/** Apply the policy to one finding. Returns the finding with its assessment and, maybe, less blocking or lower severity. */
export function applyAssessment(f: Finding, answers: Record<string, Answer>, model: string): Finding {
  const pReal = num(answers.real);
  if (pReal === undefined) return f;
  const a: Assessment = { model, pReal, concrete: num(answers.concrete), speculative: num(answers.speculative), style: num(answers.style), verdict: pReal >= 0.6 ? 'real' : 'unsure' };
  if (isModelFinding(f)) {
    // Speculation and style demote only findings the model is not already sure are real.
    const unsure = pReal < POLICY.keepRealAbove;
    const spec =
      pReal < POLICY.modelRealBelow ||
      (unsure && (a.speculative ?? 0) > POLICY.speculativeAbove) ||
      (a.style ?? 0) > POLICY.styleAbove ||
      (a.concrete ?? 1) < POLICY.concreteBelow;
    if (spec) return { ...f, severity: 'low', blocking: false, assessment: { ...a, verdict: 'speculative' } };
    return { ...f, assessment: a };
  }
  if (pReal < POLICY.unblockBelow) {
    // Security keeps its floor: the model never alone lets a security finding through.
    const unblock = f.blocking && !f.decision && f.category !== 'security';
    return { ...f, blocking: unblock ? false : f.blocking, assessment: { ...a, verdict: 'likely-false-positive' } };
  }
  return { ...f, assessment: a };
}

/** Which findings to judge: new, undecided, most severe first, capped. */
export function toJudge(findings: Finding[]): Finding[] {
  const order = { high: 0, medium: 1, low: 2 };
  return findings
    .filter((f) => f.isNew && !f.decision)
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || order[a.severity] - order[b.severity])
    .slice(0, POLICY.maxFindings);
}

/** ±radius lines around the finding, the flagged lines marked with >>. */
export function codeAround(lines: string[], line: number, endLine = line, radius = 15): string {
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, endLine + radius);
  return lines
    .slice(from - 1, to)
    .map((t, i) => `${from + i >= line && from + i <= endLine ? '>>' : '  '}${String(from + i).padStart(5)}| ${t}`)
    .join('\n');
}

// --- Risk tier of a diff: decides whether the LLM reviewers run. ---

export type Tier = 'trivial' | 'lite' | 'full';

export interface DiffSummary {
  files: Array<{ path: string; changedLines: number | 'new file' }>;
  totalChangedLines: number;
}

const SENSITIVE = /(^|\/)(auth|security|crypto|permission|acl|payment|billing|migrations?|schema|secrets?)(\/|[._-])|\.sql$|Dockerfile$|\.github\/workflows\//i;

/** Without the model: by size and sensitive paths (Cloudflare's thresholds). */
export function tierByRules(d: DiffSummary): Tier {
  if (d.files.some((f) => SENSITIVE.test(f.path)) || d.totalChangedLines > 100 || d.files.length > 50) return 'full';
  if (d.totalChangedLines <= 10 && d.files.length <= 20) return 'trivial';
  return 'lite';
}

export function tierRequest(d: DiffSummary): JudgeRequest {
  // Most-changed files first, as many as fit Jev's budget.
  const files = [...d.files].sort((a, b) => (b.changedLines === 'new file' ? 1e9 : b.changedLines) - (a.changedLines === 'new file' ? 1e9 : a.changedLines));
  const kept: DiffSummary['files'] = [];
  let size = 0;
  for (const f of files) {
    size += f.path.length + 40;
    if (size > JEV_BUDGET_CHARS) break;
    kept.push(f);
  }
  return {
    state: { diff: { files: kept, total_files: d.files.length, total_changed_lines: d.totalChangedLines } },
    questions: {
      risk: {
        type: 'score',
        instructions: 'How much could the change in `diff` break or endanger the product, judging from which files change and how much?',
        criteria: [
          'No behavior change: documentation, comments, formatting, test fixtures or copy text only.',
          'A local behavior change in ordinary application code, with no authentication, authorization, money, persistence schema, concurrency or public API involved.',
          'Touches authentication or authorization, secrets, payments, database schema or migrations, concurrency, infrastructure or CI, or a public API contract.',
        ],
      },
    },
  };
}

/** The model's tier, but never below the rules' tier for sensitive paths, and only trusted when confident. */
export function tierFrom(d: DiffSummary, answer: Answer | undefined): Tier {
  const byRules = tierByRules(d);
  if (answer?.type !== 'score' || answer.confidence < 0.6) return byRules;
  const byModel: Tier = answer.score < 0.5 ? 'trivial' : answer.score < 1.5 ? 'lite' : 'full';
  const rank = { trivial: 0, lite: 1, full: 2 };
  // Sensitive paths stay full; otherwise the model may lower a size-based tier by one step at most.
  if (byRules === 'full' && d.files.some((f) => SENSITIVE.test(f.path))) return 'full';
  return rank[byModel] < rank[byRules] - 1 ? (['trivial', 'lite', 'full'] as const)[rank[byRules] - 1]! : byModel;
}
