// PHP: PHPStan. The repo's own phpstan.neon(.dist) when it has one (its config
// is the norm), else level 5. A generated wrapper config keeps every cache
// under /tmp. Without vendor/autoload.php the repo is scanned for classes so
// unknown-class noise stays down; `composer install` still improves results.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const PHPSTAN = '/opt/phpstan/phpstan.phar';
const TMP = '/tmp/phpstan';

const version = process.env.MCR_ROOT
  ? (await run('php', [PHPSTAN, '--version', '--no-ansi'])).stdout.trim().split('\n')[0] || 'phpstan'
  : 'phpstan';

const info = { name: 'phpstan', version, languages: ['php'], extensions: ['.php'] };

export const REPO_CONFIGS = ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon'];
const DEFAULT_LEVEL = 5;

const HIGH = ['variable.undefined', 'class.notFound'];

/** PHPStan 2 identifier (e.g. `method.notFound`) -> our category. */
export function phpstanCategory(identifier) {
  const id = String(identifier ?? '');
  if (id === 'deadCode.unreachable') return 'correctness';
  if (/^(deadCode|missingType|unused|phpDoc)/.test(id)) return 'best-practices';
  return 'correctness';
}

export function phpstanSeverity(identifier) {
  const id = String(identifier ?? '');
  if (phpstanCategory(id) === 'best-practices') return 'low';
  return HIGH.includes(id) || id.endsWith('.notFound') ? 'high' : 'medium';
}

const neonString = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The wrapper config: the repo's config (if any) plus our tmpDir, level and scan paths. */
export function wrapperConfig({ root, repoConfig, hasAutoload }) {
  const lines = [];
  if (repoConfig) lines.push('includes:', `  - ${neonString(join(root, repoConfig))}`);
  lines.push('parameters:', `  tmpDir: ${neonString(TMP)}`);
  if (!repoConfig) lines.push(`  level: ${DEFAULT_LEVEL}`, '  treatPhpDocTypesAsCertain: false');
  if (!hasAutoload) {
    lines.push('  scanDirectories:', `    - ${neonString(root)}`);
    lines.push('  excludePaths:', '    analyseAndScan:', `      - ${neonString(`${join(root, 'node_modules')} (?)`)}`);
  }
  return lines.join('\n') + '\n';
}

/** PHPStan's JSON report -> findings with paths relative to root. */
export function parsePhpstan(json, root) {
  return Object.entries(json.files ?? {}).flatMap(([file, entry]) =>
    (entry.messages ?? []).map((m) => {
      const ruleId = m.identifier || 'phpstan';
      const tip = m.tip ? ` (${String(m.tip).replace(/\s+/g, ' ').trim()})` : '';
      return {
        ruleId,
        message: `${String(m.message ?? ruleId).trim()}${tip}`,
        file: isAbsolute(file) ? relative(root, file) : file,
        line: m.line ?? 1,
        category: phpstanCategory(m.identifier),
        severity: phpstanSeverity(m.identifier),
        helpUri: m.identifier ? `https://phpstan.org/error-identifiers/${m.identifier.split('.')[0]}` : undefined,
      };
    }),
  );
}

async function phpstan(root, targets, config, autoload) {
  return run(
    'php',
    [PHPSTAN, 'analyse', '-c', config, '--error-format=json', '--no-progress', '--no-ansi', '--no-interaction', '--memory-limit=1G',
      ...(autoload ? ['--autoload-file', autoload] : []), '--', ...targets],
    { cwd: root, env: { ...process.env, HOME: '/tmp', TMPDIR: '/tmp' } },
  );
}

const parse = (stdout) => {
  try {
    return JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    return undefined;
  }
};

async function analyze({ root, files }) {
  const targets = files.filter((f) => f.endsWith('.php') && existsSync(join(root, f))).map((f) => join(root, f));
  if (targets.length === 0) return { findings: [], notes: [] };
  mkdirSync(TMP, { recursive: true });
  const notes = [];
  const autoload = existsSync(join(root, 'vendor/autoload.php')) ? join(root, 'vendor/autoload.php') : undefined;
  if (!autoload) notes.push('phpstan: no vendor/autoload.php; results improve after `composer install`');
  const repoConfig = REPO_CONFIGS.find((c) => existsSync(join(root, c)));
  const config = join(TMP, `wrapper-${process.pid}-${Date.now()}.neon`);

  writeFileSync(config, wrapperConfig({ root, repoConfig, hasAutoload: !!autoload }));
  let result = await phpstan(root, targets, config, autoload);
  let parsed = parse(result.stdout);
  if (!parsed && repoConfig) {
    // The repo's config often includes extensions from vendor/; fall back to defaults.
    notes.push(`phpstan: the repo's ${repoConfig} failed (${(result.stderr || result.stdout).split(root + '/').join('').replace(/\s+/g, ' ').trim().slice(0, 300)}); used level ${DEFAULT_LEVEL} instead`);
    writeFileSync(config, wrapperConfig({ root, hasAutoload: !!autoload }));
    result = await phpstan(root, targets, config, autoload);
    parsed = parse(result.stdout);
  } else if (repoConfig) notes.push(`phpstan: using the repo's ${repoConfig}`);
  if (!parsed) throw new Error(`phpstan failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 500)}`);
  notes.push(...(parsed.errors ?? []).slice(0, 10).map((e) => `phpstan: ${String(e).split('\n')[0].slice(0, 300)}`));
  return { findings: parsePhpstan(parsed, root), notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
