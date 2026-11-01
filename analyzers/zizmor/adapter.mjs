// GitHub Actions: zizmor over changed workflows (.github/workflows/*.yml) and
// composite actions (action.yml), fully offline (--offline, no token, so the
// online audits such as known-vulnerable-actions are off). Template injection,
// excessive permissions, unpinned actions, pull_request_target misuse,
// credential persistence and the rest of the regular persona.
//
// zizmor runs from the review root on root-relative paths. The repo's own
// .github/zizmor.yml or zizmor.yml (with its ignore rules) is passed with
// --config when the review root has one: zizmor's own discovery looks only at
// the enclosing git root, which misses it when the review root is a
// subdirectory. Without one, zizmor's discovery applies. Inline
// `# zizmor: ignore[...]` comments are honored either way.
//
// Severity, from zizmor's severity and confidence:
//   High + confidence High/Medium -> high (blocks on a changed line)
//   High + confidence Low         -> medium
//   Medium                        -> medium
//   Low / Informational / Unknown -> low

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const version = process.env.MCR_ROOT ? (await run('zizmor', ['--version'])).stdout.trim() : 'zizmor';

const info = { name: 'zizmor', version, languages: ['github-actions'], extensions: ['.yml', '.yaml'] };

/** zizmor determinations -> severity (see the header). */
export function severity({ severity: s, confidence: c } = {}) {
  if (s === 'High') return c === 'High' || c === 'Medium' ? 'high' : 'medium';
  if (s === 'Medium') return 'medium';
  return 'low';
}

/** A workflow under .github/workflows/ or a composite action definition. */
export function isActionsFile(file) {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || /(^|\/)action\.ya?ml$/.test(file);
}

function localPath(location) {
  return location?.symbolic?.key?.Local?.verbatim_path;
}

/** zizmor --format json-v1 -> findings. Locations are 0-based; the Primary one is reported. */
export function toFindings(report) {
  const findings = [];
  for (const r of report) {
    if (r.ignored) continue;
    const loc = r.locations?.find((l) => l.symbolic?.kind === 'Primary') ?? r.locations?.[0];
    const file = localPath(loc);
    const span = loc?.concrete?.location;
    if (!file || !span) continue;
    const line = span.start_point.row + 1;
    // An end at column 0 is the start of the next line, i.e. the block ends on the line before.
    const end = span.end_point.column === 0 ? span.end_point.row : span.end_point.row + 1;
    const annotation = loc.symbolic.annotation;
    const d = r.determinations ?? {};
    findings.push({
      ruleId: r.ident,
      message: `${r.desc}${annotation ? `: ${annotation}` : ''} (zizmor confidence: ${d.confidence ?? 'Unknown'})`,
      file,
      line,
      endLine: end > line ? end : undefined,
      column: span.start_point.column + 1,
      category: 'security',
      severity: severity(d),
      helpUri: `https://docs.zizmor.sh/audits/#${r.ident}`,
      ruleName: r.desc,
    });
  }
  return findings;
}

/** zizmor skips inputs it cannot parse with a warning; turn those (and any other warnings) into notes. */
export function notesFrom(inputs, stderr) {
  const done = new Set([...stderr.matchAll(/completed (\S+)/g)].map((m) => m[1]));
  const warnings = [...stderr.matchAll(/\bWARN\b.*?::\w+: (.*)/g)].map((m) => `zizmor: ${m[1].trim()}`);
  const skipped = inputs.filter((f) => !done.has(f)).map((f) => `zizmor: skipped ${f} (not a valid workflow or action)`);
  return [...skipped, ...warnings];
}

async function analyze({ root, files }) {
  const inputs = files.filter(isActionsFile).filter((f) => existsSync(join(root, f)));
  if (inputs.length === 0) return { findings: [], notes: [] };
  const config = ['.github/zizmor.yml', 'zizmor.yml'].find((c) => existsSync(join(root, c)));
  // --no-exit-codes: 0 whether or not there are findings, non-zero only when zizmor itself fails.
  const args = ['--offline', '--no-progress', '--no-exit-codes', '--color', 'never', '--format', 'json-v1', ...(config ? ['--config', config] : []), ...inputs];
  const r = await run('zizmor', args, {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: '/tmp' },
  });
  if (r.code !== 0 || !r.stdout.trim().startsWith('[')) throw new Error(`zizmor failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(-300)}`);
  return { findings: toFindings(JSON.parse(r.stdout)), notes: [...(config ? [`zizmor: using the repo's ${config}`] : []), ...notesFrom(inputs, r.stderr)] };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
