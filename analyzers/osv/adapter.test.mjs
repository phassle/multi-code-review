import { describe, expect, it } from 'vitest';
import { compareVersions, fixedVersion, locate, lockfileArg, primaryId, severityOf, toFindings } from './adapter.mjs';

const PACKAGE_LOCK = `{
  "name": "demo",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "dependencies": {
        "@types/lodash": "^4.17.15",
        "lodash": "^4.17.15",
        "evil-pkg": "1.0.0"
      }
    },
    "node_modules/@types/lodash": {
      "version": "4.17.15"
    },
    "node_modules/lodash": {
      "version": "4.17.15"
    },
    "node_modules/evil-pkg": {
      "version": "1.0.0"
    }
  }
}`;

const lodash = { name: 'lodash', version: '4.17.15', ecosystem: 'npm' };

const REPORT = {
  results: [
    {
      source: { path: '/repo/web/package-lock.json', type: 'lockfile' },
      packages: [
        {
          package: lodash,
          groups: [
            { ids: ['GHSA-35jh-r3h4-6jhm'], aliases: ['CVE-2021-23337', 'GHSA-35jh-r3h4-6jhm'], max_severity: '7.2' },
            { ids: ['GHSA-29mw-wpgm-hmr9'], aliases: ['CVE-2020-28500', 'GHSA-29mw-wpgm-hmr9'], max_severity: '5.3' },
          ],
          vulnerabilities: [
            {
              id: 'GHSA-35jh-r3h4-6jhm',
              summary: 'Command Injection in lodash',
              database_specific: { severity: 'HIGH' },
              affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
            },
            {
              id: 'GHSA-29mw-wpgm-hmr9',
              details: 'ReDoS in toNumber, trim and trimEnd.\nMore text.',
              database_specific: { severity: 'MODERATE' },
              affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.17.21' }] }] }],
            },
          ],
        },
        {
          package: { name: 'evil-pkg', version: '1.0.0', ecosystem: 'npm' },
          groups: [{ ids: ['MAL-2024-10'], aliases: ['GHSA-9qmj-4phx-2v5v', 'MAL-2024-10'], max_severity: '' }],
          vulnerabilities: [{ id: 'MAL-2024-10', summary: 'Malicious code in evil-pkg (npm)', affected: [{ package: { name: 'evil-pkg', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }] }],
        },
      ],
    },
  ],
};

describe('osv analyzer', () => {
  it('turns osv-scanner JSON into one finding per package and advisory, on the package line', () => {
    const findings = toFindings(REPORT, '/repo', (f) => {
      expect(f).toBe('web/package-lock.json');
      return PACKAGE_LOCK;
    });
    expect(findings).toHaveLength(3);
    const [inj, redos, mal] = findings;
    expect(inj).toMatchObject({ ruleId: 'GHSA-35jh-r3h4-6jhm', file: 'web/package-lock.json', line: 15, category: 'security', severity: 'high', helpUri: 'https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm' });
    expect(inj.message).toContain('lodash@4.17.15');
    expect(inj.message).toContain('Command Injection in lodash');
    expect(inj.message).toContain('CVE-2021-23337');
    expect(inj.message).toContain('Upgrade to 4.17.21');
    expect(redos).toMatchObject({ severity: 'medium', line: 15 });
    expect(redos.message).toContain('ReDoS in toNumber');
    expect(mal).toMatchObject({ ruleId: 'MAL-2024-10', severity: 'high', line: 18 });
    expect(mal.message).toContain('known malicious package');
    expect(mal.message).not.toContain('Upgrade');
  });

  it('keeps a finding when the lockfile cannot be read (line 1)', () => {
    const [f] = toFindings(REPORT, '/repo', () => {
      throw new Error('gone');
    });
    expect(f.line).toBe(1);
  });

  it('rates MAL- high always, then CVSS, then the database rating, else medium', () => {
    expect(severityOf(['MAL-2025-1'], '', undefined)).toBe('high');
    expect(severityOf(['MAL-2025-1'], '1.0', 'LOW')).toBe('high');
    expect(severityOf(['GHSA-x'], '9.8', undefined)).toBe('high');
    expect(severityOf(['GHSA-x'], '7.0', undefined)).toBe('high');
    expect(severityOf(['GHSA-x'], '6.9', undefined)).toBe('medium');
    expect(severityOf(['GHSA-x'], '3.1', undefined)).toBe('low');
    expect(severityOf(['GHSA-x'], '5.0', 'CRITICAL')).toBe('high');
    expect(severityOf(['PYSEC-x'], '', 'MODERATE')).toBe('medium');
    expect(severityOf(['PYSEC-x'], '', 'LOW')).toBe('low');
    expect(severityOf(['PYSEC-x'], '', undefined)).toBe('medium');
  });

  it('picks a stable rule id: MAL-, then GHSA-, then the first id', () => {
    expect(primaryId(['GHSA-a', 'MAL-1'])).toBe('MAL-1');
    expect(primaryId(['PYSEC-1', 'GHSA-a'])).toBe('GHSA-a');
    expect(primaryId(['RUSTSEC-2024-1'])).toBe('RUSTSEC-2024-1');
  });

  it('suggests the lowest fixed version above the installed one', () => {
    const vuln = {
      affected: [
        { package: { name: 'django', ecosystem: 'PyPI' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.2.25' }, { introduced: '4.0' }, { fixed: '4.2.11' }, { introduced: '5.0' }, { fixed: '5.0.3' }] }] },
        { package: { name: 'django', ecosystem: 'PyPI' }, ranges: [{ type: 'GIT', events: [{ fixed: 'abc123' }] }] },
      ],
    };
    expect(fixedVersion(vuln, { name: 'django', version: '4.1.0', ecosystem: 'PyPI' })).toBe('4.2.11');
    expect(fixedVersion(vuln, { name: 'other', version: '4.1.0', ecosystem: 'PyPI' })).toBeUndefined();
    expect(compareVersions('v1.10.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('scans only files osv-scanner understands', () => {
    expect(lockfileArg('web/package-lock.json')).toBe('web/package-lock.json');
    expect(lockfileArg('go.mod')).toBe('go.mod');
    expect(lockfileArg('svc/Cargo.lock')).toBe('svc/Cargo.lock');
    expect(lockfileArg('requirements.txt')).toBe('requirements.txt');
    expect(lockfileArg('requirements-dev.txt')).toBe('requirements.txt:requirements-dev.txt');
    expect(lockfileArg('requirements/base.txt')).toBe('requirements.txt:requirements/base.txt');
    expect(lockfileArg('gradle/verification-metadata.xml')).toBe('gradle/verification-metadata.xml');
    expect(lockfileArg('verification-metadata.xml')).toBeUndefined();
    expect(lockfileArg('package.json')).toBeUndefined();
    expect(lockfileArg('src/app.ts')).toBeUndefined();
    expect(lockfileArg('notes.txt')).toBeUndefined();
  });

  describe('locate', () => {
    it('npm: the package entry, not the root dependency list or a scoped namesake', () => {
      expect(locate(PACKAGE_LOCK, 'lodash', '4.17.15', 'npm')).toBe(15);
      expect(locate(PACKAGE_LOCK, '@types/lodash', '4.17.15', 'npm')).toBe(12);
    });

    it('npm: the nested copy with the matching version', () => {
      const text = '"node_modules/a": {\n  "version": "2.0.0"\n},\n"node_modules/b/node_modules/a": {\n  "version": "1.0.0"\n}';
      expect(locate(text, 'a', '1.0.0', 'npm')).toBe(4);
    });

    it('yarn.lock and pnpm-lock.yaml', () => {
      const yarn = '# yarn lockfile v1\n\nlodash.merge@^4.6.0:\n  version "4.6.2"\n\nlodash@^4.17.0, lodash@^4.17.15:\n  version "4.17.15"\n';
      expect(locate(yarn, 'lodash', '4.17.15', 'npm')).toBe(6);
      const pnpm = 'importers:\n  .:\n    dependencies:\n      lodash:\n        specifier: 4.17.15\n        version: 4.17.15\npackages:\n  lodash@4.17.15:\n    resolution: {integrity: sha512-x}\n';
      expect(locate(pnpm, 'lodash', '4.17.15', 'npm')).toBe(8);
    });

    it('requirements.txt with PyPI name normalisation', () => {
      expect(locate('flask==2.3.3\nPyYAML==5.3\n', 'pyyaml', '5.3', 'PyPI')).toBe(2);
      expect(locate('zope.interface==5.0\nzope-interface-x==1\n', 'zope-interface', '5.0', 'PyPI')).toBe(1);
    });

    it('poetry.lock / Cargo.lock: name line with the version below it', () => {
      const cargo = '[[package]]\nname = "time"\nversion = "0.3.0"\n\n[[package]]\nname = "time"\nversion = "0.1.43"\n';
      expect(locate(cargo, 'time', '0.1.43', 'crates.io')).toBe(6);
    });

    it('Gemfile.lock, go.mod, composer.lock, pom.xml', () => {
      expect(locate('GEM\n  specs:\n    rack (2.2.3)\n    rack-test (1.1.0)\n', 'rack', '2.2.3', 'RubyGems')).toBe(3);
      expect(locate('module x\n\nrequire (\n\tgolang.org/x/net v0.7.0\n)\n', 'golang.org/x/net', '0.7.0', 'Go')).toBe(4);
      expect(locate('{\n  "packages": [\n    {\n      "name": "guzzlehttp/psr7",\n      "version": "1.8.1",\n', 'guzzlehttp/psr7', '1.8.1', 'Packagist')).toBe(4);
      const pom = '<dependency>\n  <groupId>org.apache.logging.log4j</groupId>\n  <artifactId>log4j-core</artifactId>\n  <version>2.14.1</version>\n</dependency>';
      expect(locate(pom, 'org.apache.logging.log4j:log4j-core', '2.14.1', 'Maven')).toBe(3);
    });

    it('falls back to the first line naming the package, then 1', () => {
      expect(locate('x\nlodash: something\n', 'lodash', '9.9.9', 'npm')).toBe(2);
      expect(locate('nothing here\n', 'lodash', '1.0.0', 'npm')).toBe(1);
    });
  });
});
