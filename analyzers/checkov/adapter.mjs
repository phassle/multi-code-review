// Cloud infrastructure as code (AWS, Azure, GCP): checkov, offline. Terraform
// is scanned per directory (a module is the unit; cross-resource checks need
// it) and only results in the files under review are kept; Bicep, ARM,
// CloudFormation/SAM and Serverless templates are scanned per file. Offline,
// checkov reports no severity, so ours comes from the check's categories
// (dumped at build by checks.py) and its name: public exposure is high,
// security misconfiguration medium, logging and tuning low. The repo's own
// .checkov.yaml is used when it has one; inline `checkov:skip=` comments work.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, serve } from '../_kit/serve.mjs';

const CHECKS_FILE = process.env.CHECKOV_CHECKS ?? fileURLToPath(new URL('./checks.json', import.meta.url));
const CHECKS = existsSync(CHECKS_FILE) ? JSON.parse(readFileSync(CHECKS_FILE, 'utf8')) : {};

const version = process.env.MCR_ROOT ? `checkov ${(await run('checkov', ['--version'])).stdout.trim()}` : 'checkov';

const TEMPLATE_EXTENSIONS = ['.json', '.yaml', '.yml', '.template'];
const info = { name: 'checkov', version, languages: ['terraform', 'bicep', 'arm', 'cloudformation', 'serverless'], extensions: ['.tf', '.bicep', ...TEMPLATE_EXTENSIONS] };

const REPO_CONFIGS = ['.checkov.yaml', '.checkov.yml'];
const BASE_ARGS = ['-o', 'json', '--quiet', '--compact', '--skip-download'];

/** Exploitable as written: data open to anyone, admin ports open to the internet, admin rights, plaintext, secrets in code. */
const EXPOSED = /ingress from 0\.0\.0\.0[:/]0 to port (20|21|22|3389|-1)\b|ssh access from 0\.0\.0\.0|from 0\.0\.0\.0\/0 \(ANY IP\)|publicly accessible|publicly available|public access|not public\b|public (read|write)|anonymous|allUsers|administrative privileges|admin privileges|wildcard \(\*\) principal|public access through wildcards|httpsTrafficOnly|hard-?coded/i;

/** Public by design for many services (web apps, APIs, Cloud Run): worth a look, not a block. */
const OFTEN_INTENDED = /public network access|public networking|public IPs?\b|public IP address|public endpoint|Cloud Run|API Portal|API management|Public Access block|block public access|public access prevention|Control Plane/i;

const MEDIUM = new Set(['GENERAL_SECURITY', 'NETWORKING', 'ENCRYPTION', 'IAM', 'SECRETS', 'APPLICATION_SECURITY', 'KUBERNETES']);

/** Hardening beyond the provider's secure default (own keys, extra layers, descriptions): low. */
const HARDENING = /\bKMS\b|customer[- ]managed|\bCMK\b|double encryption|infrastructure encryption|description|tags?\b|IAM authentication|attached to another resource/i;

/** Availability and recovery, whatever checkov files them under (it puts Multi-AZ under networking). */
const RELIABILITY = /multi-?az|replication|replica|zone.redundan|geo.redundan|deletion protection|backup|point.in.time|versioning|soft delete|purge protection|lifecycle/i;

/** Losing data when these are off; replication, multi-AZ and the like are cost decisions. */
const RELIABILITY_MEDIUM = /deletion protection|backup|point.in.time|soft delete|purge protection/i;

/** checkov's categories for a check, upper-cased (a few graph checks spell them differently). */
export function categoriesOf(checkId) {
  return (CHECKS[checkId]?.categories ?? []).map((c) => String(c).toUpperCase());
}

/** A check -> our category and severity. */
export function grade(checkId, name, categories = categoriesOf(checkId)) {
  if (categories.includes('BACKUP_AND_RECOVERY') || RELIABILITY.test(name)) {
    return { category: 'reliability', severity: RELIABILITY_MEDIUM.test(name) ? 'medium' : 'low' };
  }
  if (categories.includes('CONVENTION')) return { category: 'best-practices', severity: 'low' };
  if (EXPOSED.test(name) && !OFTEN_INTENDED.test(name)) return { category: 'security', severity: 'high' };
  return { category: 'security', severity: categories.some((c) => MEDIUM.has(c)) && !HARDENING.test(name) ? 'medium' : 'low' };
}

/** Does this JSON/YAML file look like a cloud template checkov reads (not package.json, CI or compose)? Same test as isCloudTemplate in gateway/src/detect.ts. */
export function isTemplate(text) {
  return /AWSTemplateFormatVersion|Transform:\s*['"]?AWS::Serverless|"Type"\s*:\s*"AWS::|\bType:\s*['"]?AWS::|deploymentTemplate\.json|^provider:\s*$[\s\S]*^\s+name:\s*aws/m.test(text);
}

/** checkov prints one JSON document per run, a list when several frameworks ran. */
export function parseDocuments(stdout) {
  const docs = [];
  let i = 0;
  const text = stdout.trim();
  while (i < text.length) {
    // Find the end of one top-level value by tracking depth outside strings.
    let depth = 0;
    let inString = false;
    let j = i;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    const value = JSON.parse(text.slice(i, j + 1));
    docs.push(...(Array.isArray(value) ? value : [value]));
    i = j + 1;
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  return docs;
}

function relativePath(check, root) {
  const abs = check.file_abs_path;
  if (abs && abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  return String(check.repo_file_path ?? check.file_path ?? '').replace(/^\/+/, '');
}

/** checkov reports -> findings in `wanted` files, one per check and resource. */
export function toFindings(docs, root, wanted) {
  const seen = new Set();
  const findings = [];
  for (const doc of docs) {
    for (const c of doc.results?.failed_checks ?? []) {
      const file = relativePath(c, root);
      if (!wanted.has(file)) continue;
      const [line, endLine] = c.file_line_range ?? [1, undefined];
      const key = `${c.check_id}|${file}|${line}|${c.resource}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { category, severity } = grade(c.check_id, c.check_name);
      findings.push({
        ruleId: c.check_id,
        message: c.resource ? `${c.check_name} (${c.resource})` : c.check_name,
        file,
        line: line || 1,
        endLine: endLine || undefined,
        category,
        severity,
        helpUri: c.guideline || undefined,
      });
    }
  }
  return findings;
}

async function scan(root, args) {
  const r = await run('checkov', [...args, ...BASE_ARGS], { cwd: root });
  // Exit 1 means failed checks; no JSON means checkov itself failed.
  if (!r.stdout.trim()) throw new Error(`checkov failed (exit ${r.code}): ${(r.stderr || '').slice(0, 500)}`);
  return parseDocuments(r.stdout);
}

async function analyze({ root, files }) {
  const terraform = files.filter((f) => f.endsWith('.tf'));
  const templates = files.filter((f) => f.endsWith('.bicep') || (TEMPLATE_EXTENSIONS.some((e) => f.endsWith(e)) && isTemplate(readFileSync(join(root, f), 'utf8'))));
  if (terraform.length === 0 && templates.length === 0) return { findings: [], notes: [] };
  const own = REPO_CONFIGS.find((c) => existsSync(join(root, c)));
  const config = own ? ['--config-file', join(root, own)] : [];
  const runs = [];
  if (terraform.length) {
    const dirs = [...new Set(terraform.map((f) => dirname(f)))];
    // One run per module directory (checkov merges several -d into one graph),
    // one at a time: each is a Python process of a few hundred MB.
    runs.push((async () => {
      const docs = [];
      for (const d of dirs) docs.push(...(await scan(root, ['-d', d, '--framework', 'terraform', ...config])));
      return docs;
    })());
  }
  if (templates.length) runs.push(scan(root, [...templates.flatMap((f) => ['-f', f]), '--framework', 'cloudformation', 'arm', 'bicep', 'serverless', ...config]));
  const docs = (await Promise.all(runs)).flat();
  const notes = own ? [`checkov: using the repo's config ${own}`] : [];
  return { findings: toFindings(docs, root, new Set([...terraform, ...templates])), notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
