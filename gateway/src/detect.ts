// What a codebase is made of, and which analyzers that calls for. Input is a
// list of file paths (from a directory walk or git); output is the stacks
// found, the compose profiles to start, and per stack and category which tool
// covers it, or that only the model does. Pure.

import { activeProfiles, CATALOG, UNIVERSAL_TOOLS, type Profile } from './catalog.ts';
import { CATEGORIES, type Category } from './findings.ts';

export interface StackDef {
  id: string;
  label: string;
  extensions: string[];
  /** Exact basenames or suffixes (starting with '.') that mark a project root. */
  manifests: string[];
  /** The profile with this stack's own analyzers, if there is one yet. */
  profile?: Profile;
  /** Extensions the core semgrep rules cover for this stack. */
  semgrep: string[];
  /** Tools to add next, shown when a category has no analyzer. */
  next: string;
}

/** CloudFormation/SAM, Serverless and ARM templates by their usual names; checkov reads them (and any .tf, .bicep). */
const CLOUD_TEMPLATES = ['template.yaml', 'template.yml', 'serverless.yml', 'serverless.yaml', 'azuredeploy.json', 'mainTemplate.json'];

/** Marker for those templates: their extension (.yaml, .json) alone says nothing. */
const CLOUD_TEMPLATE = 'cloud-template';

/** Files that may be a cloud template under any name; the caller reads them and asks isCloudTemplate. */
export const TEMPLATE_CANDIDATES = ['.json', '.yaml', '.yml', '.template'];

/**
 * Does this text look like a CloudFormation/SAM, Serverless or ARM template?
 * The checkov adapter (analyzers/checkov/adapter.mjs, isTemplate) uses the
 * same test to pick the files it scans; keep the two in step.
 */
export function isCloudTemplate(text: string): boolean {
  return /AWSTemplateFormatVersion|Transform:\s*['"]?AWS::Serverless|"Type"\s*:\s*"AWS::|\bType:\s*['"]?AWS::|deploymentTemplate\.json|^provider:\s*$[\s\S]*^\s+name:\s*aws/m.test(text);
}

export const STACKS: StackDef[] = [
  { id: 'node', label: 'JavaScript / TypeScript', extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'], manifests: ['package.json', 'tsconfig.json'], profile: 'node', semgrep: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], next: 'dependency-cruiser (architecture)' },
  { id: 'jvm', label: 'Java / Kotlin / Scala', extensions: ['.java', '.kt', '.kts', '.scala'], manifests: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.sbt'], profile: 'jvm', semgrep: ['.java', '.kt', '.kts', '.scala'], next: 'SpotBugs + Find Security Bugs (needs a build), ArchUnit' },
  { id: 'dotnet', label: 'C# / .NET', extensions: ['.cs', '.fs', '.vb'], manifests: ['.csproj', '.vbproj', '.fsproj', '.sln', '.slnx', 'Directory.Build.props'], profile: 'dotnet', semgrep: ['.cs'], next: 'NetArchTest / ArchUnitNET (architecture tests in the repo)' },
  { id: 'python', label: 'Python', extensions: ['.py'], manifests: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'], profile: 'python', semgrep: ['.py'], next: 'import-linter (architecture)' },
  { id: 'go', label: 'Go', extensions: ['.go'], manifests: ['go.mod'], profile: 'go', semgrep: ['.go'], next: 'go-arch-lint (architecture)' },
  { id: 'ruby', label: 'Ruby', extensions: ['.rb', '.rake', '.erb'], manifests: ['Gemfile', '.gemspec'], profile: 'ruby', semgrep: ['.rb'], next: 'packwerk (architecture)' },
  { id: 'php', label: 'PHP', extensions: ['.php'], manifests: ['composer.json'], profile: 'php', semgrep: ['.php'], next: 'deptrac (architecture), Psalm taint analysis (security)' },
  { id: 'rust', label: 'Rust', extensions: ['.rs'], manifests: ['Cargo.toml'], semgrep: ['.rs'], next: 'clippy (needs a build)' },
  { id: 'cpp', label: 'C / C++', extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'], manifests: ['CMakeLists.txt', '.vcxproj', 'Makefile'], profile: 'cpp', semgrep: ['.c'], next: 'clang-tidy (needs compile_commands.json)' },
  { id: 'swift', label: 'Swift', extensions: ['.swift'], manifests: ['Package.swift', '.xcodeproj'], semgrep: ['.swift'], next: 'SwiftLint' },
  { id: 'infra', label: 'Docker / CI / cloud IaC', extensions: ['.tf', '.bicep'], manifests: ['Dockerfile', 'docker-compose.yml', 'compose.yaml', ...CLOUD_TEMPLATES], profile: 'infra', semgrep: ['Dockerfile', '.yml', '.yaml'], next: 'zizmor (GitHub Actions)' },
];

/** A stack counts when it has a manifest or at least this many files. */
const MIN_FILES = 5;

/** Files that are infrastructure as code whatever else is around them: one is enough. */
const IAC = new Set(['.tf', '.bicep', CLOUD_TEMPLATE]);

export interface Stack {
  id: string;
  label: string;
  files: number;
  /** Directories (relative) holding a manifest: the projects of this stack. */
  projects: string[];
  profile?: Profile;
  /** Per category: the analyzers that cover it, empty when only the model does. */
  coverage: Record<Category, string[]>;
  next: string;
}

export interface Detection {
  files: number;
  stacks: Stack[];
  /** Profiles to start: core plus every detected stack's own. */
  profiles: Profile[];
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '.' : path.slice(0, i);
}

function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

/** Marker for Dockerfile.prod, api.dockerfile: hadolint reads them, semgrep does not. */
const DOCKERFILE_VARIANT = 'Dockerfile.*';

/** Dockerfile, Dockerfile.prod, api.dockerfile: what hadolint lints. */
export function isDockerfile(path: string): boolean {
  const base = basename(path);
  return base === 'Dockerfile' || base.startsWith('Dockerfile.') || /\.dockerfile$/i.test(base);
}

/** What a file counts as for coverage: its extension, or a marker where that is not enough. */
function fileKind(path: string, ext: string, template: boolean): string {
  if (basename(path) !== 'Dockerfile' && isDockerfile(path)) return DOCKERFILE_VARIANT;
  if (template) return CLOUD_TEMPLATE;
  return ext || basename(path);
}

function isManifest(def: StackDef, path: string): boolean {
  const base = basename(path);
  if (def.id === 'infra' && isDockerfile(path)) return true;
  return def.manifests.some((m) => (m.startsWith('.') ? base.endsWith(m) : base === m));
}

function owns(def: StackDef, path: string, ext: string, template: boolean): boolean {
  if (def.extensions.includes(ext)) return true;
  // Workflows and compose files are YAML, but YAML alone is not an infra stack.
  return def.id === 'infra' && (isDockerfile(path) || path.includes('.github/workflows/') || template);
}

/**
 * Stack tools that read only part of their stack: they cover it only when
 * those files are there. A Kotlin-only repo is not covered by PMD, Terraform
 * or workflows alone not by hadolint (semgrep reads only the exact name
 * `Dockerfile`, so variants count for hadolint alone).
 */
const TOOL_FILES: Record<string, string[]> = {
  pmd: ['.java'],
  detekt: ['.kt', '.kts'],
  hadolint: ['Dockerfile', DOCKERFILE_VARIANT],
  checkov: ['.tf', '.bicep', CLOUD_TEMPLATE],
};

/** Analyzers per category for a stack, given the profiles that run. */
export function coverageOf(def: StackDef, profiles: Profile[], filesWithExt: Set<string>): Record<Category, string[]> {
  const semgrepCovers = def.semgrep.some((e) => filesWithExt.has(e));
  const coverage = Object.fromEntries(CATEGORIES.map((c) => [c, [] as string[]])) as Record<Category, string[]>;
  for (const entry of CATALOG) {
    if (!profiles.includes(entry.profile)) continue;
    const reads = TOOL_FILES[entry.tool];
    if (reads && !reads.some((e) => filesWithExt.has(e))) continue;
    const mine = entry.profile === def.profile || UNIVERSAL_TOOLS.has(entry.tool) || (entry.tool === 'semgrep' && semgrepCovers);
    if (mine) coverage[entry.category].push(entry.name);
  }
  return coverage;
}

/**
 * `templates`: paths the caller read and found to be cloud templates
 * (isCloudTemplate); the usual template names count without it.
 */
export function detect(paths: string[], runningProfiles?: Profile[], templates: ReadonlySet<string> = new Set()): Detection {
  const found = STACKS.map((def) => ({ def, files: 0, projects: new Set<string>(), exts: new Set<string>() }));
  for (const path of paths) {
    const ext = extname(path);
    const template = templates.has(path) || CLOUD_TEMPLATES.includes(basename(path));
    for (const s of found) {
      if (isManifest(s.def, path)) s.projects.add(dirname(path));
      if (owns(s.def, path, ext, template)) {
        s.files++;
        s.exts.add(fileKind(path, ext, template));
      }
    }
  }
  const present = found.filter((s) => s.files >= MIN_FILES || (s.projects.size > 0 && s.files > 0) || [...s.exts].some((e) => IAC.has(e)));
  const wanted = activeProfiles(present.flatMap((s) => (s.def.profile ? [s.def.profile] : [])).join(','));
  const profiles = runningProfiles ?? wanted;
  const stacks = present
    .sort((a, b) => b.files - a.files)
    .map((s) => ({
      id: s.def.id,
      label: s.def.label,
      files: s.files,
      projects: [...s.projects].sort(),
      profile: s.def.profile,
      coverage: coverageOf(s.def, profiles, s.exts),
      next: s.def.next,
    }));
  return { files: paths.length, stacks, profiles: wanted };
}

/** Profiles a detection needs that are not running. */
export function missingProfiles(detection: Detection, running: Profile[]): Profile[] {
  return detection.profiles.filter((p) => !running.includes(p));
}

const MARK = { covered: '✅', model: '—' };

/** The setup report: stacks, and per category which analyzer covers it or that the model does. */
export function detectionMarkdown(detection: Detection, title = 'Codebase'): string {
  const lines = [`## ${title}: ${detection.files} files`, ''];
  if (detection.stacks.length === 0) return [...lines, 'No known stack found.'].join('\n');
  lines.push(`| Stack | Files | ${CATEGORIES.join(' | ')} |`, `|---|---:|${CATEGORIES.map(() => '---').join('|')}|`);
  for (const s of detection.stacks) {
    const cells = CATEGORIES.map((c) => (s.coverage[c].length ? `${MARK.covered} ${s.coverage[c].map((n) => n.slice(c.length + 1)).join(', ')}` : MARK.model));
    lines.push(`| ${s.label} | ${s.files} | ${cells.join(' | ')} |`);
  }
  lines.push('', `${MARK.covered} analyzer · ${MARK.model} no analyzer: the harness model reviews it`, '', `**Profiles:** ${detection.profiles.join(', ')}`);
  const gaps = detection.stacks.filter((s) => CATEGORIES.some((c) => s.coverage[c].length === 0));
  if (gaps.length) {
    lines.push('', '**Next analyzers to add:**');
    for (const s of gaps) lines.push(`- ${s.label}: ${s.next}`);
  }
  return lines.join('\n');
}
