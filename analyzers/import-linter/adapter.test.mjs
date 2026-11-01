import { describe, expect, it } from 'vitest';
import {
  configures,
  findConfig,
  groupByConfig,
  importLines,
  moduleFiles,
  moduleOf,
  parseChain,
  parseImport,
  parseReport,
  slug,
  toFindings,
} from './adapter.mjs';

// Real lint-imports 2.15 output (--no-logo, COLUMNS wide) on a src/ layout:
// a direct and a collapsed indirect layers break (extra firsts and lasts), a
// forbidden contract, independence, and acyclic_siblings.
const REPORT = `
---------
Contracts
---------

Analyzed 15 files, 11 dependencies.
-----------------------------------

Shop layers BROKEN
Domain is independent of util BROKEN
Independent api/services BROKEN
No cycles BROKEN

Contracts: 0 kept, 4 broken.


----------------
Broken contracts
----------------

Shop layers
-----------

shop.domain is not allowed to import shop.infra:

- shop.domain.svc -> shop.infra.db (l.5)

- shop.domain.a (l.1)
  & shop.domain.b (l.1)
  & shop.domain.svc -> shop.services.helper (l.2)
  shop.services.helper -> shop.infra (l.1)
                          & shop.infra.db (l.3)

- shop.domain.model -> shop.infra.db (l.4)


shop.domain is not allowed to import shop.api:

- shop.domain.a (l.1)
  & shop.domain.b (l.1)
  & shop.domain.svc -> shop.services.helper (l.2)
  shop.services.helper -> shop.api.views (l.2)


Domain is independent of util
-----------------------------

shop.domain is not allowed to import util:

-   shop.domain.model -> util.helpers (l.5)


Independent api/services
------------------------

shop.api is not allowed to import shop.services:

- shop.api.views -> shop.services.helper (l.1)


shop.services is not allowed to import shop.api:

- shop.services.back -> shop.api.views (l.1, l.3)


No cycles
---------

No cycles are allowed in shop.
It could be made acyclic by removing 2 dependencies:

- .api -> .services (1 import)
- .infra -> .domain (2 imports)

`;

const KEPT = `
---------
Contracts
---------

Analyzed 8 files, 3 dependencies.
---------------------------------

Shop layers KEPT

Contracts: 1 kept, 0 broken.
`;

describe('configures / findConfig', () => {
  const FILES = {
    '.importlinter': '[importlinter]\nroot_package = x\n',
    'svc/setup.cfg': '[metadata]\nname = svc\n',
    'svc/pyproject.toml': '[project]\nname = "svc"\n\n[tool.importlinter]\nroot_packages = ["svc"]\n',
    'lib/setup.cfg': '[flake8]\n',
    'lib/pyproject.toml': '[tool.ruff]\n',
    'ini/setup.cfg': '[importlinter]\nroot_package = ini\n',
    'arr/pyproject.toml': '[[tool.importlinter.contracts]]\nname = "x"\n',
  };
  const read = (f) => FILES[f] ?? null;

  it('needs the import-linter section, except in .importlinter', () => {
    expect(configures('.importlinter', '')).toBe(true);
    expect(configures('setup.cfg', FILES['ini/setup.cfg'])).toBe(true);
    expect(configures('setup.cfg', FILES['svc/setup.cfg'])).toBe(false);
    expect(configures('pyproject.toml', FILES['svc/pyproject.toml'])).toBe(true);
    expect(configures('pyproject.toml', FILES['arr/pyproject.toml'])).toBe(true);
    expect(configures('pyproject.toml', FILES['lib/pyproject.toml'])).toBe(false);
    expect(configures('pyproject.toml', null)).toBe(false);
  });

  it('takes the nearest configuring file, up to the root', () => {
    expect(findConfig('svc/src/svc/a.py', read)).toEqual({ dir: 'svc', name: 'pyproject.toml' });
    expect(findConfig('ini/ini/a.py', read)).toEqual({ dir: 'ini', name: 'setup.cfg' });
    expect(findConfig('lib/x/y.py', read)).toEqual({ dir: '', name: '.importlinter' });
    expect(findConfig('a.py', read)).toEqual({ dir: '', name: '.importlinter' });
    expect(findConfig('a.py', () => null)).toBeNull();
  });

  it('groups .py files by config and lists those without one', () => {
    const { groups, missing } = groupByConfig(['svc/src/svc/a.py', 'svc/b.py', 'README.md', 'x/y.py'], (f) => (f.startsWith('svc/') ? read(f) : null));
    expect([...groups.keys()]).toEqual(['svc/pyproject.toml']);
    expect(groups.get('svc/pyproject.toml').files).toEqual(['svc/src/svc/a.py', 'svc/b.py']);
    expect(missing).toEqual(['x/y.py']);
  });
});

describe('parsing', () => {
  it('parses one import line', () => {
    expect(parseImport('shop.a -> shop.b (l.12)')).toEqual({ importer: 'shop.a', imported: 'shop.b', lines: [12] });
    expect(parseImport('shop.a (l.1, l.3)')).toEqual({ importer: 'shop.a', imported: undefined, lines: [1, 3] });
    expect(parseImport('.api -> .services (2 imports)')).toMatchObject({ importer: '.api', imported: '.services', count: 2 });
    expect(parseImport('shop.domain is not allowed to import shop.infra:')).toBeNull();
    expect(parseImport('Analyzed 8 files, 3 dependencies.')).toBeNull();
  });

  it('expands collapsed chains', () => {
    const links = parseChain([
      '- shop.domain.a (l.1)',
      '  & shop.domain.b (l.1)',
      '  & shop.domain.svc -> shop.services.helper (l.2)',
      '  shop.services.helper -> shop.infra (l.1)',
      '                          & shop.infra.db (l.3)',
    ]);
    expect(links.map((l) => `${l.importer}>${l.imported}@${l.lines}`)).toEqual([
      'shop.domain.a>shop.services.helper@1',
      'shop.domain.b>shop.services.helper@1',
      'shop.domain.svc>shop.services.helper@2',
      'shop.services.helper>shop.infra@1',
      'shop.services.helper>shop.infra.db@3',
    ]);
  });

  it('reads broken contracts, headers, chains and acyclic edges', () => {
    const r = parseReport(REPORT);
    expect(r.map((c) => c.contract)).toEqual(['Shop layers', 'Domain is independent of util', 'Independent api/services', 'No cycles']);
    expect(r[0].groups.map((g) => [g.header, g.chains.length])).toEqual([
      ['shop.domain is not allowed to import shop.infra', 3],
      ['shop.domain is not allowed to import shop.api', 1],
    ]);
    expect(r[1].groups[0].chains[0]).toEqual([{ importer: 'shop.domain.model', imported: 'util.helpers', lines: [5] }]);
    expect(r[3].cycles).toEqual({
      ancestor: 'shop',
      edges: [
        { importer: 'shop.api', imported: 'shop.services', count: 1 },
        { importer: 'shop.infra', imported: 'shop.domain', count: 2 },
      ],
    });
  });

  it('finds nothing when every contract is kept or there is no report', () => {
    expect(parseReport(KEPT)).toEqual([]);
    expect(parseReport('Could not find package \'shop\' in your Python path.\n')).toEqual([]);
  });

  it('slugs contract names', () => {
    expect(slug('Shop layers')).toBe('shop-layers');
    expect(slug('Independent api/services')).toBe('independent-api-services');
    expect(slug('  ')).toBe('contract');
  });
});

describe('modules and files', () => {
  it('maps modules to files under the bases and back', () => {
    expect(moduleFiles('shop.a', ['src', ''])).toEqual(['src/shop/a.py', 'src/shop/a/__init__.py', 'shop/a.py', 'shop/a/__init__.py']);
    expect(moduleOf('svc/src/shop/api/__init__.py', ['svc/src', 'svc'])).toBe('shop.api');
    expect(moduleOf('svc/shop/x.py', ['svc/src', 'svc'])).toBe('shop.x');
    expect(moduleOf('other/x.py', ['svc'])).toBeNull();
    expect(moduleOf('svc/my-scripts/x.py', ['svc'])).toBeNull();
  });

  it('finds import lines by name, not by prefix', () => {
    const src = 'import shop.servicesx\nfrom shop.services import helper\nimport json\nfrom ..services import back\nx = "shop.services"\n';
    expect(importLines(src, 'shop.services')).toEqual([2, 4]);
  });
});

describe('toFindings', () => {
  const bases = ['src', ''];
  const wanted = new Set(['src/shop/domain/svc.py', 'src/shop/domain/a.py', 'src/shop/services/helper.py', 'src/shop/services/back.py', 'src/shop/api/views.py', 'src/shop/infra/db.py']);
  const SOURCES = {
    'src/shop/api/views.py': 'from shop.services import helper\n',
    'src/shop/infra/db.py': '"""DB."""\nfrom shop.domain import model\nfrom shop import domain\n',
  };
  const findings = toFindings(parseReport(REPORT), { bases, wanted, read: (f) => SOURCES[f] ?? null });
  const at = (file) => findings.filter((f) => f.file === file).map((f) => `${f.ruleId}@${f.line}`);

  it('lands each broken import on its line in the importing file, high', () => {
    expect(at('src/shop/domain/svc.py')).toEqual(['shop-layers@5', 'shop-layers@2']);
    expect(at('src/shop/domain/a.py')).toEqual(['shop-layers@1']);
    expect(findings.find((x) => x.file === 'src/shop/domain/a.py').message).toContain('import shop.infra; shop.domain is not allowed to import shop.api.');
    expect(at('src/shop/services/helper.py')).toEqual(['shop-layers@1', 'shop-layers@3', 'shop-layers@2']);
    expect(at('src/shop/services/back.py')).toEqual(['independent-api-services@1', 'independent-api-services@3']);
    expect(findings.every((f) => f.severity === 'high' && f.category === 'architecture')).toBe(true);
    const f = findings.find((x) => x.file === 'src/shop/domain/svc.py' && x.line === 5);
    expect(f).toMatchObject({ ruleName: 'Shop layers' });
    expect(f.message).toBe('Contract "Shop layers" is broken: shop.domain is not allowed to import shop.infra. shop.domain.svc imports shop.infra.db. lint-imports fails on this.');
    expect(findings.find((x) => x.file === 'src/shop/services/helper.py' && x.line === 3).message).toContain('one step of an indirect import chain');
  });

  it('reports only files under review', () => {
    expect(at('src/shop/domain/model.py')).toEqual([]);
    expect(at('src/shop/domain/b.py')).toEqual([]);
  });

  it('puts acyclic edges on the lines that import the sibling', () => {
    expect(at('src/shop/api/views.py')).toEqual(['independent-api-services@1', 'no-cycles@1']);
    expect(at('src/shop/infra/db.py')).toEqual(['no-cycles@2']);
    expect(findings.find((x) => x.ruleId === 'no-cycles' && x.file === 'src/shop/infra/db.py').message).toContain('shop.infra -> shop.domain (2 imports)');
  });
});
