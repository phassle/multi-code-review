// C# / VB.NET: the Roslyn analyzers (compiler + .NET code analysis) run by
// `dotnet build` on the projects owning the changed files, plus any SARIF a CI
// left in <root>/.mcr/sarif/. No network: the build uses --no-restore, so the
// host must have run `dotnet restore` (obj/project.assets.json in the repo) and
// the host's NuGet package folder must be mounted read-only at the same path.
// The repo is read-only too: mcr.props sends every build output to /tmp.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, serve } from '../_kit/serve.mjs';

const PROPS = fileURLToPath(new URL('./mcr.props', import.meta.url));
const TIMEOUT = Number(process.env.MCR_DOTNET_TIMEOUT_MS ?? 600_000);
const NUGET = process.env.MCR_NUGET_PACKAGES ?? process.env.NUGET_PACKAGES;
const EXTENSIONS = ['.cs', '.vb'];
const PROJECT_FOR = { '.cs': '.csproj', '.vb': '.vbproj' };

const CATEGORY = {
  security: 'security',
  reliability: 'reliability',
  performance: 'reliability',
  usage: 'correctness',
  compiler: 'correctness',
  design: 'architecture',
};

/**
 * Roslyn rules carry a category (rule properties.category); without one the
 * id prefix decides: CS* compiler, CA2xxx reliability/security/usage,
 * CA3xxx/CA5xxx security, CA1xxx design/performance/naming, IDE* style.
 */
export function roslynCategory(ruleId, tag) {
  const known = CATEGORY[String(tag ?? '').toLowerCase()];
  if (known) return known;
  if (tag) return 'best-practices';
  const id = String(ruleId ?? '').toUpperCase();
  if (/^(CS|BC)\d/.test(id)) return 'correctness';
  const ca = /^CA(\d{4})$/.exec(id);
  if (!ca) return 'best-practices';
  const n = Number(ca[1]);
  if (n >= 3000 && n < 4000) return 'security';
  if (n >= 5000 && n < 6000) return 'security';
  if ((n >= 2100 && n < 2200) || (n >= 2300 && n < 2400)) return 'security';
  if (n >= 2000 && n < 2100) return 'reliability';
  if (n >= 2200 && n < 3000) return 'correctness';
  if (n >= 1800 && n < 1900) return 'reliability';
  if (n >= 1000 && n < 1100) return 'architecture';
  return 'best-practices';
}

/** SARIF level -> ours. 'none' (hidden diagnostics) -> null: dropped. */
export function roslynSeverity(level) {
  if (level === 'none') return null;
  if (level === 'error') return 'high';
  if (level === 'note') return 'low';
  return 'medium'; // 'warning', and the SARIF default when level is absent
}

/** file:// URI or relative uri (+ uriBaseId) -> absolute path, or null. */
function locationPath(uri, baseId, bases, root) {
  if (!uri) return null;
  if (uri.startsWith('file:')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  const decoded = decodeURIComponent(uri);
  if (isAbsolute(decoded)) return decoded;
  const base = baseId && bases?.[baseId]?.uri;
  if (base) return resolve(base.startsWith('file:') ? fileURLToPath(base) : base, decoded);
  return resolve(root, decoded);
}

/**
 * A SARIF log (2.1, or 1.0 as older csc writes it) -> findings for the wanted
 * files (paths relative to root). Suppressed results and hidden ones are dropped.
 */
export function parseSarif(log, root, wanted) {
  const keep = wanted ? new Set(wanted) : null;
  const findings = [];
  for (const run of log?.runs ?? []) {
    const rules = new Map();
    const driverRules = run.tool?.driver?.rules;
    if (Array.isArray(driverRules)) for (const r of driverRules) rules.set(r.id, r);
    else if (run.rules && typeof run.rules === 'object') for (const [id, r] of Object.entries(run.rules)) rules.set(id, r);
    for (const r of run.results ?? []) {
      if (Array.isArray(r.suppressions) && r.suppressions.length > 0) continue;
      if (Array.isArray(r.suppressionStates) && r.suppressionStates.length > 0) continue;
      const ruleId = r.ruleId ?? 'unknown';
      const severity = roslynSeverity(r.level);
      if (!severity) continue;
      const loc = r.locations?.[0];
      const artifact = loc?.physicalLocation?.artifactLocation ?? loc?.resultFile;
      const region = loc?.physicalLocation?.region ?? loc?.resultFile?.region ?? {};
      const abs = locationPath(artifact?.uri, artifact?.uriBaseId, run.originalUriBaseIds, root);
      if (!abs) continue;
      const file = relative(root, abs).split(sep).join('/');
      if (file.startsWith('..') || (keep && !keep.has(file))) continue;
      const rule = rules.get(ruleId) ?? {};
      const message = typeof r.message === 'string' ? r.message : (r.message?.text ?? rule.shortDescription?.text ?? ruleId);
      findings.push({
        ruleId,
        message: String(message).trim(),
        file,
        line: region.startLine ?? 1,
        ...(region.endLine ? { endLine: region.endLine } : {}),
        ...(region.startColumn ? { column: region.startColumn } : {}),
        category: roslynCategory(ruleId, rule.properties?.category),
        severity,
        ...(rule.helpUri ? { helpUri: rule.helpUri } : {}),
        ...(rule.name || rule.shortDescription?.text ? { ruleName: rule.name ?? rule.shortDescription.text } : {}),
      });
    }
  }
  return findings;
}

/** Same rule, place and message once (CI SARIF and a fresh build overlap). */
export function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.ruleId}\0${f.file}\0${f.line}\0${f.column ?? ''}\0${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Nearest project walking up from each file (never above root); a .cs file
 * prefers a .csproj, a .vb file a .vbproj. listDir(dir) -> file names.
 * Returns { projects: Map<projectPath, files[]>, orphans: files[] }.
 */
export function owningProjects(root, files, listDir) {
  const projects = new Map();
  const orphans = [];
  for (const f of files) {
    const ext = EXTENSIONS.find((e) => f.endsWith(e));
    let dir = dirname(resolve(root, f));
    let found = null;
    while (!found) {
      const names = listDir(dir).filter((n) => n.endsWith('.csproj') || n.endsWith('.vbproj')).sort();
      found = names.find((n) => n.endsWith(PROJECT_FOR[ext])) ?? names[0];
      if (found) found = join(dir, found);
      else if (dir === root || dirname(dir) === dir || !dir.startsWith(root)) break;
      else dir = dirname(dir);
    }
    if (!found) orphans.push(f);
    else projects.set(found, [...(projects.get(found) ?? []), f]);
  }
  return { projects, orphans };
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function sarifFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((n) => n.endsWith('.sarif') || n.endsWith('.sarif.json'))
    .map((n) => join(dir, n));
}

function readSarif(path, root, wanted, notes) {
  try {
    return parseSarif(JSON.parse(readFileSync(path, 'utf8')), root, wanted);
  } catch (e) {
    notes.push(`roslyn: unreadable SARIF ${relative(root, path)}: ${e.message}`);
    return [];
  }
}

/** Why a project cannot be built offline, or null. */
function restoreProblem(project, rel) {
  const assets = join(dirname(project), 'obj', 'project.assets.json');
  if (!existsSync(assets)) return `${rel}: no obj/project.assets.json; run \`dotnet restore\` on the host`;
  try {
    const folders = Object.keys(JSON.parse(readFileSync(assets, 'utf8')).packageFolders ?? {});
    const missing = folders.filter((f) => !existsSync(f));
    if (missing.length) return `${rel}: NuGet package folder ${missing[0]} is not mounted; mount the host's packages read-only at the same path`;
  } catch {
    return `${rel}: unreadable obj/project.assets.json; run \`dotnet restore\` on the host`;
  }
  return null;
}

/** MSBuild's error lines (deduped, without the trailing project tag). */
export function buildErrors(output) {
  const lines = output.split('\n').filter((l) => /: error [A-Z]+\d+/.test(l)).map((l) => l.replace(/\s+\[[^\]]+\]\s*$/, '').trim());
  return [...new Set(lines)];
}

const version = (await run('dotnet', ['--version'])).stdout.trim() || 'dotnet';

const info = { name: 'roslyn', version: `dotnet-sdk ${version}`, languages: ['csharp', 'vbnet'], extensions: EXTENSIONS };

let seq = 0;

async function analyze({ root, files }) {
  const targets = files.filter((f) => EXTENSIONS.some((e) => f.endsWith(e)));
  if (targets.length === 0) return { findings: [], notes: [] };
  const notes = [];
  const findings = [];

  const ci = sarifFiles(join(root, '.mcr', 'sarif'));
  for (const s of ci) findings.push(...readSarif(s, root, targets, notes));
  if (ci.length) notes.push(`roslyn: imported ${ci.length} SARIF file(s) from .mcr/sarif`);

  const { projects, orphans } = owningProjects(root, targets, listDir);
  if (orphans.length) notes.push(`roslyn: no .csproj/.vbproj owns ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ', ...' : ''}`);

  const out = `/tmp/mcr-roslyn-${process.pid}-${++seq}`;
  mkdirSync(out, { recursive: true });
  try {
    for (const [project, owned] of projects) {
      const rel = relative(root, project);
      const problem = restoreProblem(project, rel);
      if (problem) {
        notes.push(`roslyn: skipped ${problem}`);
        continue;
      }
      const started = Date.now();
      const result = await run(
        'dotnet',
        [
          'build', project, '--no-restore', '-nologo', '--disable-build-servers', '-nodeReuse:false', '-v:q', '-clp:NoSummary',
          `-p:CustomAfterDirectoryBuildProps=${PROPS}`, `-p:McrOut=${out}`,
          '-p:EnforceCodeStyleInBuild=false', '-p:TreatWarningsAsErrors=false', '-p:CodeAnalysisTreatWarningsAsErrors=false',
          '-p:RunAnalyzersDuringBuild=true', '-p:UseSharedCompilation=false', '-p:UseAppHost=false',
        ],
        { cwd: '/tmp', timeout: TIMEOUT, env: { ...process.env, ...(NUGET ? { NUGET_PACKAGES: NUGET } : {}) } },
      );
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (result.code !== 0) {
        const errors = buildErrors(result.stdout + result.stderr).filter((l) => !/: error (CS|BC)\d+/.test(l));
        const why = result.code === null ? `timed out after ${TIMEOUT} ms` : errors[0] ?? `exit ${result.code}`;
        const hint = errors.some((l) => /NETSDK1004|NETSDK1064|NU1101|NU1100|NETSDK1047/.test(l)) ? ' (run `dotnet restore` on the host and mount its NuGet packages)' : '';
        notes.push(`roslyn: build of ${rel} failed in ${secs}s: ${why.slice(0, 300)}${hint}`);
      } else console.log(`roslyn: built ${rel} in ${secs}s for ${owned.length} file(s)`);
    }
    for (const s of sarifFiles(out)) findings.push(...readSarif(s, root, targets, notes));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return { findings: dedupe(findings), notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
