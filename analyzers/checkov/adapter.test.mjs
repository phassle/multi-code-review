import { describe, expect, it } from 'vitest';
import { grade, isTemplate, parseDocuments, toFindings } from './adapter.mjs';

describe('checkov analyzer', () => {
  it('blocks only on exposure, admin rights, plaintext and secrets', () => {
    expect(grade('CKV_AWS_24', 'Ensure no security groups allow ingress from 0.0.0.0:0 to port 22', ['NETWORKING'])).toEqual({ category: 'security', severity: 'high' });
    expect(grade('CKV_AWS_17', 'Ensure all data stored in RDS is not publicly accessible', ['NETWORKING']).severity).toBe('high');
    expect(grade('CKV_GCP_28', 'Ensure that Cloud Storage bucket is not anonymously or publicly accessible', ['GENERAL_SECURITY']).severity).toBe('high');
    expect(grade('CKV_AZURE_3', "Ensure that 'supportsHttpsTrafficOnly' is set to 'true'", ['NETWORKING']).severity).toBe('high');
    // Public by design for web apps, APIs and Cloud Run; open port 80 and egress are normal.
    expect(grade('CKV_AZURE_222', 'Ensure that Azure Web App public network access is disabled', ['NETWORKING']).severity).toBe('medium');
    expect(grade('CKV_GCP_102', 'Ensure that GCP Cloud Run services are not anonymously or publicly accessible', ['GENERAL_SECURITY']).severity).toBe('medium');
    expect(grade('CKV_AWS_260', 'Ensure no security groups allow ingress from 0.0.0.0:0 to port 80', ['NETWORKING']).severity).toBe('medium');
    expect(grade('CKV_AWS_382', 'Ensure no security groups allow egress from 0.0.0.0:0 to port -1', ['NETWORKING']).severity).toBe('medium');
  });

  it('keeps misconfiguration medium and hardening, logging and tuning low', () => {
    expect(grade('CKV_AWS_16', 'Ensure all data stored in the RDS is securely encrypted at rest', ['ENCRYPTION'])).toEqual({ category: 'security', severity: 'medium' });
    expect(grade('CKV_AWS_145', 'Ensure that S3 buckets are encrypted with KMS by default', ['ENCRYPTION']).severity).toBe('low');
    expect(grade('CKV_AWS_23', 'Ensure every security group and rule has a description', ['NETWORKING']).severity).toBe('low');
    expect(grade('CKV_AWS_18', 'Ensure the S3 bucket has access logging enabled', ['LOGGING']).severity).toBe('low');
  });

  it('files availability and recovery under reliability, whatever checkov calls it', () => {
    expect(grade('CKV_AWS_133', 'Ensure that RDS instances has backup policy', ['BACKUP_AND_RECOVERY'])).toEqual({ category: 'reliability', severity: 'medium' });
    expect(grade('CKV_AWS_293', 'Ensure that AWS database instances have deletion protection enabled', ['GENERAL_SECURITY'])).toEqual({ category: 'reliability', severity: 'medium' });
    expect(grade('CKV_AWS_157', 'Ensure that RDS instances have Multi-AZ enabled', ['NETWORKING'])).toEqual({ category: 'reliability', severity: 'low' });
  });

  it('reads cloud templates, not other JSON and YAML', () => {
    expect(isTemplate("AWSTemplateFormatVersion: '2010-09-09'\nResources: {}")).toBe(true);
    expect(isTemplate('Resources:\n  B:\n    Type: AWS::S3::Bucket')).toBe(true);
    expect(isTemplate('{"$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"}')).toBe(true);
    expect(isTemplate('service: api\nprovider:\n  name: aws\n')).toBe(true);
    expect(isTemplate('{"name": "x", "scripts": {}}')).toBe(false);
    expect(isTemplate('on: push\njobs:\n  b:\n    runs-on: ubuntu-latest')).toBe(false);
  });

  it('parses one or several JSON documents and keeps results in the files under review', () => {
    const check = (id, file, line) => ({ check_id: id, check_name: 'Ensure no security groups allow ingress from 0.0.0.0:0 to port 22', file_abs_path: `/src/r/${file}`, file_path: '/main.tf', file_line_range: [line, line + 7], resource: 'aws_security_group.web', guideline: null });
    const out = `${JSON.stringify({ check_type: 'terraform', results: { failed_checks: [check('CKV_AWS_24', 'infra/main.tf', 13), check('CKV_AWS_24', 'infra/other.tf', 1)] } })}\n${JSON.stringify([{ check_type: 'bicep', results: { failed_checks: [check('CKV_AWS_24', 'infra/main.tf', 13)] } }])}`;
    const docs = parseDocuments(out);
    expect(docs).toHaveLength(2);
    expect(toFindings(docs, '/src/r', new Set(['infra/main.tf']))).toEqual([
      { ruleId: 'CKV_AWS_24', message: 'Ensure no security groups allow ingress from 0.0.0.0:0 to port 22 (aws_security_group.web)', file: 'infra/main.tf', line: 13, endLine: 20, category: 'security', severity: 'high', helpUri: undefined },
    ]);
  });
});
