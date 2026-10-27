// Ruby: RuboCop (with the rails, rspec and performance plugins) and Brakeman.
// RuboCop uses the repo's .rubocop.yml when it loads here (its config is the
// norm), else a built-in default. Brakeman scans the whole Rails app (it needs
// routes and models for context); only warnings in the requested files are kept.
// Both load Ruby from the repo, which is why the analyzer network has no egress.
//
// MCR_TOOLS picks the tool for this container: "rubocop" (security-rubocop,
// correctness-rubocop, ...: one container per category) or "brakeman"
// (security-brakeman).

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const TOOL = (process.env.MCR_TOOLS ?? 'rubocop').trim();
const DEFAULT_CONFIG = new URL('./default.rubocop.yml', import.meta.url).pathname;

// Cops that guard against unsafe or wrong behaviour rather than style.
const RAILS_SECURITY = new Set(['Rails/OutputSafety', 'Rails/LinkToBlank']);
const RAILS_CORRECTNESS = new Set([
  'Rails/SkipsModelValidations',
  'Rails/SaveBang',
  'Rails/ReversibleMigration',
  'Rails/TransactionExitStatement',
  'Rails/DangerousColumnNames',
  'Rails/UniqueValidationWithoutIndex',
  'Rails/NotNullColumn',
  'Rails/ThreeStateBooleanColumn',
  'Rails/TimeZone',
  'Rails/Date',
  'Rails/HasManyOrHasOneDependent',
  'Rails/InverseOf',
]);

export function rubocopCategory(cop) {
  const department = String(cop ?? '').split('/')[0];
  if (department === 'Security') return 'security';
  if (department === 'Lint') return 'correctness';
  if (department === 'Rails') {
    if (RAILS_SECURITY.has(cop)) return 'security';
    if (RAILS_CORRECTNESS.has(cop)) return 'correctness';
    return 'best-practices';
  }
  if (department === 'RSpec' || department === 'Minitest' || department === 'Capybara' || department === 'FactoryBot') return 'testing';
  if (department === 'Performance') return 'reliability';
  return 'best-practices';
}

export function rubocopSeverity(severity) {
  if (severity === 'fatal' || severity === 'error') return 'high';
  if (severity === 'warning') return 'medium';
  return 'low';
}

const DOCS = { Rails: 'rubocop-rails', RSpec: 'rubocop-rspec', Capybara: 'rubocop-rspec', FactoryBot: 'rubocop-rspec', Performance: 'rubocop-performance' };

export function rubocopHelpUri(cop) {
  const department = cop.split('/')[0];
  if (cop.split('/').length !== 2) return undefined;
  const project = DOCS[department] ?? (/^(?:Bundler|Gemspec|Layout|Lint|Metrics|Migration|Naming|Security|Style)$/.test(department) ? 'rubocop' : undefined);
  if (!project) return undefined;
  return `https://docs.rubocop.org/${project}/cops_${department.toLowerCase()}.html#${cop.toLowerCase().replace('/', '')}`;
}

/** RuboCop's JSON report -> findings with paths relative to root. */
export function parseRubocop(json, root) {
  return (json.files ?? []).flatMap((file) =>
    (file.offenses ?? []).map((o) => ({
      ruleId: o.cop_name,
      // The message starts with "Cop/Name: " when DisplayCopNames is on.
      message: String(o.message ?? o.cop_name).replace(`${o.cop_name}: `, '').trim(),
      file: isAbsolute(file.path) ? relative(root, file.path) : file.path,
      line: o.location?.start_line ?? o.location?.line ?? 1,
      endLine: o.location?.last_line,
      column: o.location?.start_column ?? o.location?.column,
      category: rubocopCategory(o.cop_name),
      severity: rubocopSeverity(o.severity),
      helpUri: rubocopHelpUri(o.cop_name),
    })),
  );
}

const CONFIDENCE = { High: 'high', Medium: 'medium', Weak: 'low' };

/** Brakeman's JSON report -> security findings, only for the requested files. */
export function parseBrakeman(json, files) {
  const wanted = new Set(files);
  return (json.warnings ?? [])
    .filter((w) => wanted.has(w.file))
    .map((w) => ({
      ruleId: w.check_name ?? w.warning_type,
      ruleName: w.warning_type,
      message: `${w.warning_type}: ${w.message}${w.code ? ` (${w.code})` : ''}`,
      file: w.file,
      line: w.line ?? 1,
      category: 'security',
      severity: CONFIDENCE[w.confidence] ?? 'medium',
      helpUri: w.link,
    }));
}

const RUBOCOP_FILE = /\.(?:rb|rake|gemspec|ru)$/;
const RUBOCOP_NAMES = new Set(['Gemfile', 'Rakefile', 'Guardfile', 'Capfile']);

export function rubocopTargets(files) {
  return files.filter((f) => RUBOCOP_FILE.test(f) || RUBOCOP_NAMES.has(basename(f)));
}

/** A Rails app has config/application.rb or at least an app/ directory. */
export function isRailsApp(root) {
  return existsSync(join(root, 'config/application.rb')) || existsSync(join(root, 'app'));
}

async function rubocopRun(root, targets, config) {
  const args = ['--format', 'json', '--force-exclusion', '--cache', 'false', ...(config ? ['--config', config] : []), '--', ...targets];
  const result = await run('rubocop', args, { cwd: root });
  try {
    return { json: JSON.parse(result.stdout), result };
  } catch {
    return { json: null, result };
  }
}

async function rubocop(root, files) {
  const notes = [];
  const targets = rubocopTargets(files);
  if (targets.length === 0) return { findings: [], notes };
  let { json, result } = existsSync(join(root, '.rubocop.yml')) ? await rubocopRun(root, targets) : await rubocopRun(root, targets, DEFAULT_CONFIG);
  if (existsSync(join(root, '.rubocop.yml'))) {
    if (json && result.code !== 2) notes.push("rubocop: using the repo's .rubocop.yml");
    else {
      const reason = (result.stderr || result.stdout).trim().split('\n')[0]?.slice(0, 300);
      notes.push(`rubocop: the repo's .rubocop.yml did not load here (${reason}); used the built-in default config instead.`);
      ({ json, result } = await rubocopRun(root, targets, DEFAULT_CONFIG));
    }
  }
  if (!json) throw new Error(`rubocop failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
  return { findings: parseRubocop(json, root), notes };
}

async function brakeman(root, files) {
  if (!isRailsApp(root)) return { findings: [], notes: ['brakeman skipped: not a Rails app (no config/application.rb or app/).'] };
  if (!files.some((f) => /\.(?:rb|erb|haml|slim|rake)$/.test(f) || basename(f) === 'Gemfile')) return { findings: [], notes: [] };
  const out = `/tmp/brakeman-${process.pid}-${Date.now()}.json`;
  const args = ['-q', '-f', 'json', '--no-pager', '--no-exit-on-warn', '--no-exit-on-error', '--no-progress', '-o', out, '-p', root];
  if (!existsSync(join(root, 'config/application.rb'))) args.push('--force');
  const result = await run('brakeman', args, { cwd: '/tmp' });
  let json;
  try {
    json = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    throw new Error(`brakeman failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
  } finally {
    rmSync(out, { force: true });
  }
  const notes = (json.errors ?? []).slice(0, 10).map((e) => `brakeman: ${e.location ? `${e.location}: ` : ''}${String(e.error ?? '').split('\n')[0]}`);
  return { findings: parseBrakeman(json, files), notes };
}

async function version() {
  const r = await run(TOOL, ['--version']);
  return r.stdout.trim().split('\n')[0] || TOOL;
}

if (process.env.MCR_ROOT) {
  if (TOOL !== 'rubocop' && TOOL !== 'brakeman') throw new Error('MCR_TOOLS must be "rubocop" or "brakeman"');
  const info = {
    name: TOOL,
    version: await version(),
    languages: ['ruby'],
    extensions: ['.rb', '.rake', '.erb', 'Gemfile'],
  };
  serve({ info, analyze: ({ root, files }) => (TOOL === 'brakeman' ? brakeman(root, files) : rubocop(root, files)) });
}
