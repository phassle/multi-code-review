// Kotlin: detekt, without type resolution (no classpath). The repo's own
// config when it has one (its config is the norm, on top of detekt's defaults),
// else the defaults plus defaults.yml. The rule set in the SARIF rule id
// (detekt.<ruleset>.<Rule>) decides our category.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, serve } from '../_kit/serve.mjs';

const JAR = process.env.DETEKT_JAR ?? '/opt/detekt/detekt-cli.jar';
const DEFAULTS = fileURLToPath(new URL('./defaults.yml', import.meta.url));
const EXTENSIONS = ['.kt', '.kts'];

const version = (await run('java', ['-jar', JAR, '--version'])).stdout.trim().split('\n').pop() || 'detekt';

const info = { name: 'detekt', version, languages: ['kotlin'], extensions: EXTENSIONS };

const REPO_CONFIGS = ['detekt.yml', 'detekt.yaml', '.detekt.yml', '.detekt.yaml', 'config/detekt/detekt.yml', 'config/detekt/detekt.yaml'];

const CATEGORY = {
  'potential-bugs': 'correctness',
  coroutines: 'reliability',
  exceptions: 'reliability',
  performance: 'reliability',
  security: 'security',
};

/** Rule sets whose findings are mostly cosmetic: low unless detekt says error. */
const COSMETIC = new Set(['style', 'naming', 'comments', 'complexity', 'empty-blocks', 'formatting', 'libraries', 'ruleauthors']);

/** 'detekt.potential-bugs.UnsafeCast' -> { ruleset: 'potential-bugs', rule: 'UnsafeCast' } */
export function splitRuleId(id) {
  const parts = String(id ?? '').split('.');
  if (parts[0] === 'detekt') parts.shift();
  const rule = parts.pop() ?? '';
  return { ruleset: parts.join('.'), rule };
}

export function detektCategory(ruleset) {
  return CATEGORY[ruleset] ?? 'best-practices';
}

/** SARIF level -> severity; detekt reports nearly everything as warning. */
export function detektSeverity(level, ruleset) {
  if (level === 'error') return 'high';
  if (level === 'note' || level === 'none') return 'low';
  return COSMETIC.has(ruleset) ? 'low' : 'medium';
}

function toRelative(uri, root, base) {
  let path = String(uri ?? '');
  if (path.startsWith('file:')) path = fileURLToPath(path);
  else if (!isAbsolute(path) && base) path = join(base, path);
  return isAbsolute(path) ? relative(root, path) : path;
}

/** detekt's SARIF report -> findings with paths relative to root. */
export function parseDetekt(sarif, root) {
  return (sarif.runs ?? []).flatMap((r) => {
    const helpUris = new Map((r.tool?.driver?.rules ?? []).map((rule) => [rule.id, rule.helpUri]));
    const baseUri = r.originalUriBaseIds?.['%SRCROOT%']?.uri;
    const base = baseUri?.startsWith('file:') ? fileURLToPath(baseUri) : undefined;
    return (r.results ?? []).map((res) => {
      const { ruleset, rule } = splitRuleId(res.ruleId);
      const loc = res.locations?.[0]?.physicalLocation ?? {};
      const region = loc.region ?? {};
      return {
        ruleId: rule,
        message: String(res.message?.text ?? rule).trim(),
        file: toRelative(loc.artifactLocation?.uri, root, base),
        line: region.startLine ?? 1,
        endLine: region.endLine,
        column: region.startColumn,
        category: detektCategory(ruleset),
        severity: detektSeverity(res.level, ruleset),
        helpUri: helpUris.get(res.ruleId),
      };
    });
  });
}

async function analyze({ root, files }) {
  const targets = files.filter((f) => EXTENSIONS.some((e) => f.endsWith(e)) && existsSync(join(root, f)));
  if (targets.length === 0) return { findings: [], notes: [] };
  const own = REPO_CONFIGS.find((c) => existsSync(join(root, c)));
  const report = `/tmp/detekt-${process.pid}-${Date.now()}.sarif`;
  const args = [
    '-jar', JAR,
    '--input', targets.map((f) => join(root, f)).join(','),
    '--base-path', root,
    '--config', own ? join(root, own) : DEFAULTS,
    '--build-upon-default-config',
    '--report', `sarif:${report}`,
  ];
  const result = await run('java', args, { cwd: '/tmp' });
  // Exit 2 means "issues found"; anything else without a report is a failure.
  if (!existsSync(report)) throw new Error(`detekt failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 500)}`);
  let sarif;
  try {
    sarif = JSON.parse(readFileSync(report, 'utf8'));
  } finally {
    rmSync(report, { force: true });
  }
  const notes = [];
  if (own) notes.push(`detekt: using the repo's config ${own}`);
  if (result.code !== 0 && result.code !== 2) notes.push(`detekt exited ${result.code}: ${result.stderr.split('\n')[0]}`);
  return { findings: parseDetekt(sarif, root), notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
