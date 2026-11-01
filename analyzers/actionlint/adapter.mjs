// GitHub Actions correctness: actionlint over changed workflows
// (.github/workflows/*.yml|yaml), with ShellCheck on every `run:` (pyflakes
// off). Workflow syntax, expression type checks, job needs, events, matrix,
// runner labels, reusable workflow calls, action inputs. actionlint only lints
// workflows, so action.yml files are skipped. Fully offline.
//
// actionlint runs from the review root on root-relative paths; it finds the
// repo's .github/actionlint.yaml (runner labels, config variables, ignores)
// itself, next to the .github directory of each workflow.
//
// Severity, by actionlint rule (kind):
//   syntax-check, expression, action, events, glob, job-needs, matrix,
//   workflow-call, permissions, env-var, id, shell-name, if-cond
//                                  -> high   (the workflow fails, never runs,
//                                             or a condition/expression is wrong)
//   runner-label                   -> medium (often a self-hosted label missing
//                                             from .github/actionlint.yaml)
//   deprecated-commands            -> medium (still runs, will break)
//   shellcheck error/warning/info  -> medium, ruleId shellcheck-SC<code>
//                                             (SC2086 unquoted $VAR is info)
//   shellcheck style               -> low
//   anything else                  -> medium
//
// Dropped because zizmor (security-zizmor) reports the same thing:
//   expression "... is potentially untrusted ..." -> zizmor template-injection
//   credentials (hardcoded container passwords)   -> zizmor hardcoded-container-credentials

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const SHELLCHECK = '/usr/local/bin/shellcheck';

const version = process.env.MCR_ROOT ? (await run('actionlint', ['-version'])).stdout.split('\n')[0].trim() : 'actionlint';

const info = { name: 'actionlint', version, languages: ['github-actions'], extensions: ['.yml', '.yaml'] };

const HIGH = new Set(['syntax-check', 'expression', 'action', 'events', 'glob', 'job-needs', 'matrix', 'workflow-call', 'permissions', 'env-var', 'id', 'shell-name', 'if-cond']);

const DOCS = 'https://github.com/rhysd/actionlint/blob/main/docs/checks.md';
const ANCHORS = {
  'syntax-check': 'check-unexpected-keys',
  expression: 'check-type-check-expression',
  action: 'check-action-format',
  events: 'check-webhook-events',
  glob: 'check-glob-pattern',
  'job-needs': 'check-job-deps',
  matrix: 'check-matrix-values',
  'workflow-call': 'check-reusable-workflows',
  permissions: 'permissions',
  'env-var': 'check-env-var-names',
  id: 'check-job-step-ids',
  'shell-name': 'check-shell-names',
  'if-cond': 'if-cond-constant',
  'runner-label': 'check-runner-labels',
  'deprecated-commands': 'check-deprecated-workflow-commands',
  shellcheck: 'check-shellcheck-integ',
};

/** A workflow under .github/workflows/ (actionlint does not lint action.yml on its own). */
export function isWorkflow(file) {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(file);
}

/** Errors zizmor already reports (see the header). */
export function coveredByZizmor(e) {
  return e.kind === 'credentials' || (e.kind === 'expression' && e.message.includes('potentially untrusted'));
}

const SHELLCHECK_MESSAGE = /^shellcheck reported issue in this script: SC(\d+):(\w+):/;

/** actionlint error -> { ruleId, severity, helpUri }. */
export function classify(e) {
  const sc = e.kind === 'shellcheck' ? SHELLCHECK_MESSAGE.exec(e.message) : null;
  if (sc) {
    return {
      ruleId: `shellcheck-SC${sc[1]}`,
      severity: sc[2] === 'style' ? 'low' : 'medium',
      helpUri: `https://www.shellcheck.net/wiki/SC${sc[1]}`,
    };
  }
  const severity = HIGH.has(e.kind) ? 'high' : 'medium'; // runner-label, deprecated-commands, unknown kinds
  return { ruleId: e.kind, severity, helpUri: ANCHORS[e.kind] ? `${DOCS}#${ANCHORS[e.kind]}` : DOCS };
}

const normalize = (p) => p.replace(/^\.\//, '');

/** actionlint `-format '{{json .}}'` -> findings, only for the given files. */
export function toFindings(errors, files) {
  const wanted = new Set(files.map(normalize));
  const findings = [];
  for (const e of errors ?? []) {
    const file = normalize(e.filepath ?? '');
    if (!wanted.has(file) || coveredByZizmor(e)) continue;
    const { ruleId, severity, helpUri } = classify(e);
    findings.push({
      ruleId,
      message: `${e.message} [${e.kind}]`,
      file,
      line: Math.max(1, e.line || 1),
      column: e.column || undefined,
      category: 'correctness',
      severity,
      helpUri,
      ruleName: e.kind,
    });
  }
  return findings;
}

/** stdout of `actionlint -format '{{json .}}'`: a JSON array, `null` or nothing. */
export function parseOutput(stdout) {
  const s = stdout.trim();
  if (s === '' || s === 'null') return [];
  return JSON.parse(s);
}

async function analyze({ root, files }) {
  const inputs = files.filter(isWorkflow).filter((f) => existsSync(join(root, f)));
  if (inputs.length === 0) return { findings: [], notes: [] };
  const args = ['-format', '{{json .}}', '-no-color', `-shellcheck=${SHELLCHECK}`, '-pyflakes=', ...inputs];
  const r = await run('actionlint', args, { cwd: root, env: { PATH: process.env.PATH, HOME: '/tmp' } });
  // 0: no problems, 1: problems found; 2: bad options, 3: fatal.
  if (r.code !== 0 && r.code !== 1) throw new Error(`actionlint failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(-300)}`);
  const errors = parseOutput(r.stdout);
  const dropped = errors.filter(coveredByZizmor).length;
  const notes = [
    ...(dropped ? [`actionlint: ${dropped} finding(s) left to zizmor (untrusted input, hardcoded credentials)`] : []),
    ...r.stderr.split('\n').filter((l) => l.trim()).map((l) => `actionlint: ${l.trim()}`),
  ];
  return { findings: toFindings(errors, inputs), notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
