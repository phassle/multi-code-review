// Secrets: gitleaks over the files under review (any language). Only those
// files are scanned: they are linked into a scratch dir, which gitleaks reads
// with --follow-symlinks. Secrets are redacted before they leave the
// container. The repo's own .gitleaks.toml is used when it has one; gitleaks
// runs from the repo root, so its `[extend] path` resolves as it does there.

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const version = process.env.MCR_ROOT ? (await run('gitleaks', ['version'])).stdout.trim() : 'gitleaks';

const info = { name: 'gitleaks', version, languages: ['any'], extensions: ['*'] };

/** Relative path of a reported file: gitleaks gives the scratch link or, following it, the file in the repo. */
export function relPath(file, scratch, root) {
  for (const base of [scratch, root]) if (file.startsWith(`${base}/`)) return file.slice(base.length + 1);
  return file;
}

/** gitleaks JSON report -> findings. */
export function toFindings(report, scratch, root) {
  return report.map((r) => ({
    ruleId: r.RuleID,
    message: `Possible secret (${r.Description || r.RuleID}). Remove it, rotate it, and load it from the environment or a secret store.`,
    file: relPath(r.File, scratch, root),
    line: r.StartLine,
    endLine: r.EndLine > r.StartLine ? r.EndLine : undefined,
    column: r.StartColumn || undefined,
    category: 'security',
    // A leaked secret is exposed the moment it is pushed.
    severity: 'high',
    helpUri: 'https://github.com/gitleaks/gitleaks',
  }));
}

async function analyze({ root, files }) {
  if (files.length === 0) return { findings: [], notes: [] };
  const scratch = `/tmp/gitleaks-${process.pid}-${Date.now()}`;
  const report = `${scratch}.json`;
  try {
    for (const f of files) {
      mkdirSync(dirname(join(scratch, f)), { recursive: true });
      symlinkSync(join(root, f), join(scratch, f));
    }
    const config = existsSync(join(root, '.gitleaks.toml')) ? ['--config', join(root, '.gitleaks.toml')] : [];
    const r = await run('gitleaks', ['dir', scratch, '--follow-symlinks', '--redact', '--no-banner', '--exit-code', '0', '--report-format', 'json', '--report-path', report, ...config], { cwd: root });
    if (r.code !== 0) throw new Error(`gitleaks failed (exit ${r.code}): ${r.stderr.slice(0, 300)}`);
    const findings = toFindings(JSON.parse(readFileSync(report, 'utf8') || '[]'), scratch, root);
    return { findings, notes: config.length ? ['gitleaks: using the repo\'s .gitleaks.toml'] : [] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(report, { force: true });
  }
}

if (process.env.MCR_ROOT) serve({ info, analyze });
