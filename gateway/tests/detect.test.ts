import { describe, expect, it } from 'vitest';
import { activeProfiles, MODEL_TOOLS, registryFor, UNIVERSAL_TOOLS } from '../src/catalog.ts';
import { detect, detectionMarkdown, isCloudTemplate, missingProfiles } from '../src/detect.ts';

const many = (dir: string, ext: string, n: number) => Array.from({ length: n }, (_, i) => `${dir}/f${i}${ext}`);

describe('stack detection', () => {
  it('finds a Next.js repo and asks for the node profile', () => {
    const d = detect(['package.json', 'tsconfig.json', ...many('src', '.ts', 20), 'Dockerfile']);
    expect(d.stacks.map((s) => s.id)).toEqual(['node', 'infra']);
    expect(d.profiles).toEqual(['core', 'node', 'infra']);
    const node = d.stacks[0]!;
    expect(node.coverage.correctness).toEqual(['correctness-semgrep', 'correctness-eslint', 'correctness-tsc']);
  });

  it('starts infra for Dockerfile variants, and claims hadolint only where there are Dockerfiles', () => {
    const variants = detect(['package.json', ...many('src', '.ts', 10), 'api/Dockerfile.prod', 'web/app.dockerfile']);
    expect(variants.profiles).toContain('infra');
    const infra = variants.stacks.find((s) => s.id === 'infra');
    expect(infra?.coverage['best-practices']).toContain('best-practices-hadolint');
    // semgrep only reads the exact name Dockerfile, so it does not cover the variants.
    expect(infra?.coverage.security).not.toContain('security-semgrep');
    const terraform = detect(many('infra', '.tf', 5));
    expect(terraform.stacks.find((s) => s.id === 'infra')?.coverage['best-practices']).not.toContain('best-practices-hadolint');
  });

  it('finds every stack of a polyglot codebase, and says where only the model covers a category', () => {
    const d = detect([
      'datamanager/pom.xml', ...many('datamanager/src', '.java', 30),
      'web/package.json', ...many('web/src', '.js', 10),
      'spacemanager/net.sln', ...many('spacemanager/Net', '.cs', 8),
      ...many('spacemanager/core', '.cpp', 40),
      'tools/one.rb',
    ]);
    expect(d.stacks.map((s) => s.id)).toEqual(['cpp', 'jvm', 'node', 'dotnet']);
    expect(d.profiles).toEqual(['core', 'node', 'jvm', 'dotnet', 'cpp']);
    const jvm = d.stacks.find((s) => s.id === 'jvm')!;
    expect(jvm.projects).toEqual(['datamanager']);
    expect(jvm.coverage.security).toEqual(['security-semgrep', 'security-gitleaks', 'security-pmd']);
    expect(jvm.coverage.testing).toEqual([]);
    const cpp = d.stacks.find((s) => s.id === 'cpp')!;
    expect(cpp.coverage.security).toEqual(['security-gitleaks', 'security-cppcheck']); // semgrep's C rules do not read .cpp
    expect(cpp.coverage.architecture).toEqual([]);
    expect(detectionMarkdown(d)).toContain('clang-tidy');
  });

  it('covers Kotlin with detekt, and claims PMD only where there is Java', () => {
    const kotlin = detect(['settings.gradle.kts', 'app/build.gradle.kts', ...many('app/src/main/kotlin', '.kt', 10)]);
    expect(kotlin.profiles).toEqual(['core', 'jvm']);
    const kt = kotlin.stacks[0]!;
    expect(kt.coverage.correctness).toEqual(['correctness-semgrep', 'correctness-detekt']);
    expect(kt.coverage.security).toEqual(['security-semgrep', 'security-gitleaks']);
    expect(kt.coverage.architecture).toEqual([]);
    const java = detect(['pom.xml', ...many('src', '.java', 5)]).stacks[0]!;
    expect(java.coverage.reliability).toEqual(['reliability-semgrep', 'reliability-pmd']);
    const mixed = detect(['build.gradle.kts', ...many('src', '.java', 3), ...many('src', '.kt', 3)]).stacks[0]!;
    expect(mixed.coverage.correctness).toEqual(['correctness-semgrep', 'correctness-pmd', 'correctness-detekt']);
  });

  it('covers cloud IaC with checkov: Terraform, Bicep and templates by name, not any YAML', () => {
    const tf = detect(many('infra/aws', '.tf', 5)).stacks.find((s) => s.id === 'infra')!;
    expect(tf.coverage.security).toEqual(['security-gitleaks', 'security-checkov']);
    expect(tf.coverage.reliability).toEqual(['reliability-checkov']);
    const sam = detect(['template.yaml', 'samconfig.toml', ...many('src', '.py', 5)]);
    expect(sam.profiles).toContain('infra');
    expect(sam.stacks.find((s) => s.id === 'infra')!.coverage.security).toContain('security-checkov');
    const ci = detect(['package.json', ...many('src', '.ts', 5), '.github/workflows/ci.yml', 'Dockerfile']).stacks.find((s) => s.id === 'infra')!;
    expect(ci.coverage.security).not.toContain('security-checkov');
  });

  it('starts infra for a single Terraform or Bicep file, and for templates found by content', () => {
    expect(detect(['README.md', 'infra/main.tf']).profiles).toEqual(['core', 'infra']);
    expect(detect(['deploy/app.bicep']).profiles).toEqual(['core', 'infra']);
    const named = detect(['ops/network-stack.yml', 'ops/foo.template'], undefined, new Set(['ops/network-stack.yml', 'ops/foo.template']));
    expect(named.profiles).toEqual(['core', 'infra']);
    expect(named.stacks[0]!.coverage.security).toContain('security-checkov');
    // Without the content check, an arbitrary YAML file is not infrastructure.
    expect(detect(['ops/network-stack.yml']).profiles).toEqual(['core']);
  });

  it('recognises cloud templates by content, as the checkov adapter does', () => {
    expect(isCloudTemplate("AWSTemplateFormatVersion: '2010-09-09'\nResources: {}")).toBe(true);
    expect(isCloudTemplate('Resources:\n  B:\n    Type: AWS::S3::Bucket')).toBe(true);
    expect(isCloudTemplate('{"$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"}')).toBe(true);
    expect(isCloudTemplate('service: api\nprovider:\n  name: aws\n')).toBe(true);
    expect(isCloudTemplate('{"name": "x", "scripts": {}}')).toBe(false);
    expect(isCloudTemplate('services:\n  web:\n    image: nginx')).toBe(false);
  });

  it('lets the llm profile cover every category of every stack', () => {
    const d = detect(many('core', '.cpp', 10), ['core', 'llm']);
    expect(d.stacks[0]!.coverage.testing).toEqual(['testing-llm']);
  });

  it('names the profiles a change needs that are not running', () => {
    const d = detect(['pom.xml', 'A.java']);
    expect(missingProfiles(d, ['core', 'node'])).toEqual(['jvm']);
    expect(missingProfiles(d, ['core', 'jvm'])).toEqual([]);
  });
});

describe('catalog', () => {
  it('always runs core and builds the registry for the running profiles', () => {
    // gitleaks covers every language but is not a model: it runs at every level and on trivial diffs.
    expect(UNIVERSAL_TOOLS.has('gitleaks') && !MODEL_TOOLS.has('gitleaks')).toBe(true);
    expect(activeProfiles('')).toEqual(['core']);
    expect(activeProfiles('jvm, bogus')).toEqual(['core', 'jvm']);
    expect(registryFor(['core']).split(',')).toEqual([
      'security-semgrep=http://security-semgrep:8080',
      'best-practices-semgrep=http://best-practices-semgrep:8080',
      'correctness-semgrep=http://correctness-semgrep:8080',
      'reliability-semgrep=http://reliability-semgrep:8080',
      'security-gitleaks=http://security-gitleaks:8080',
    ]);
  });
});
