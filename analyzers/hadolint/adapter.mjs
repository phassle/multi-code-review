// Dockerfiles: hadolint, with ShellCheck on every RUN. The repo's own
// .hadolint.yaml is used when it has one (hadolint reads it from the cwd).

import { run, serve } from '../_kit/serve.mjs';

const version = process.env.MCR_ROOT ? (await run('hadolint', ['--version'])).stdout.trim() : 'hadolint';

const info = { name: 'hadolint', version, languages: ['dockerfile'], extensions: ['Dockerfile', 'Dockerfile.', '.dockerfile', '.Dockerfile'] };

/** hadolint level -> severity. Errors are broken builds or images (DL3000, DL3024), so they block. */
export const SEVERITY = { error: 'high', warning: 'medium', info: 'low', style: 'low' };

export function helpUri(code) {
  return code.startsWith('SC') ? `https://www.shellcheck.net/wiki/${code}` : `https://github.com/hadolint/hadolint/wiki/${code}`;
}

/** hadolint JSON -> findings. */
export function toFindings(report) {
  return report.map((r) => ({
    ruleId: r.code,
    message: r.message,
    file: r.file,
    line: r.line,
    column: r.column || undefined,
    category: 'best-practices',
    severity: SEVERITY[r.level] ?? 'medium',
    helpUri: helpUri(r.code),
  }));
}

export function isDockerfile(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return base === 'Dockerfile' || base.startsWith('Dockerfile.') || base.endsWith('.dockerfile') || base.endsWith('.Dockerfile');
}

async function analyze({ root, files }) {
  const dockerfiles = files.filter(isDockerfile);
  if (dockerfiles.length === 0) return { findings: [], notes: [] };
  const r = await run('hadolint', ['--format', 'json', '--no-fail', ...dockerfiles], { cwd: root });
  if (!r.stdout.trim().startsWith('[')) throw new Error(`hadolint failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`);
  return { findings: toFindings(JSON.parse(r.stdout)), notes: [] };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
