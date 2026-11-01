import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyze,
  attrs,
  candidateTypes,
  csharpTypes,
  findResults,
  infoFor,
  isArchTest,
  locateType,
  mapJvmFile,
  packagePath,
  parseArchUnit,
  parseJUnit,
  parseTrx,
  toolsFrom,
} from './adapter.mjs';

const ARCH_MSG =
  "Architecture Violation [Priority: MEDIUM] - Rule 'no classes that reside in a package '..domain..' should depend on classes that reside in a package '..web..'' was violated (2 times):\n" +
  'Method <com.acme.domain.Order.toDto()> has return type <com.acme.web.OrderDto> in (Order.java:0)\n' +
  'Method <com.acme.domain.Order.toDto()> calls constructor <com.acme.web.OrderDto.<init>(java.lang.String)> in (Order.java:42)';

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\n/g, '&#10;');

const SUREFIRE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.acme.ArchitectureTest" tests="3" failures="1" errors="0" skipped="0">
  <testcase name="services_should_be_fine" classname="com.acme.ArchitectureTest" time="0.01"/>
  <testcase name="domain_should_not_depend_on_web" classname="com.acme.ArchitectureTest" time="0.61">
    <failure message="${xmlEsc(ARCH_MSG)}" type="java.lang.AssertionError"><![CDATA[java.lang.AssertionError: ${ARCH_MSG}
	at com.tngtech.archunit.lang.ArchRule$Assertions.assertNoViolation(ArchRule.java:94)
	at com.acme.ArchitectureTest.domain_should_not_depend_on_web(ArchitectureTest.java:20)
]]></failure>
  </testcase>
  <testcase name="plain_failure" classname="com.acme.MathTest" time="0.01">
    <failure message="expected: &lt;2&gt; but was: &lt;3&gt;" type="org.opentest4j.AssertionFailedError">at com.acme.MathTest.plain(MathTest.java:12)</failure>
  </testcase>
</testsuite>
`;

const LOW_MSG =
  "Architecture Violation [Priority: LOW] - Rule 'classes that have simple name ending with 'Controller' should reside in a package '..web..'' was violated (1 times):\n" +
  'Class <com.acme.api.UserController> does not reside in a package \'..web..\' in (UserController.kt:0)';

const trx = (results, defs) => `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="1" name="run" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>${results}</Results>
  <TestDefinitions>${defs}</TestDefinitions>
</TestRun>`;

const NETARCH_TRX = trx(
  `
    <UnitTestResult executionId="e1" testId="t1" testName="MyApp.ArchTests.LayerTests.Domain_ShouldNotDependOn_Infrastructure" outcome="Failed" testType="x" testListId="y">
      <Output><ErrorInfo>
        <Message>Domain depends on infrastructure: MyApp.Domain.Order, MyApp.Domain.Customer
Expected: True
Actual:   False</Message>
        <StackTrace>   at MyApp.ArchTests.LayerTests.Domain_ShouldNotDependOn_Infrastructure() in /src/tests/LayerTests.cs:line 20</StackTrace>
      </ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult executionId="e2" testId="t2" testName="MyApp.Tests.MathTests.Adds" outcome="Failed">
      <Output><ErrorInfo><Message>Assert.Equal() Failure: MyApp.Domain.Order total was 3</Message></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult executionId="e3" testId="t3" testName="MyApp.ArchTests.LayerTests.Passes" outcome="Passed"/>`,
  `
    <UnitTest name="Domain_ShouldNotDependOn_Infrastructure" id="t1"><TestMethod codeBase="x.dll" className="MyApp.ArchTests.LayerTests" name="Domain_ShouldNotDependOn_Infrastructure"/></UnitTest>
    <UnitTest name="Adds" id="t2"><TestMethod codeBase="x.dll" className="MyApp.Tests.MathTests" name="Adds"/></UnitTest>
    <UnitTest name="Passes" id="t3"><TestMethod codeBase="x.dll" className="MyApp.ArchTests.LayerTests" name="Passes"/></UnitTest>`,
);

const ARCHUNITNET_MSG = `"Types that reside in namespace with full name "MyApp.Domain" should not depend on Types that reside in namespace with full name "MyApp.Web"" failed:
	MyApp.Domain.Order does depend on MyApp.Web.OrderDto`;

const ORDER_CS = `using System;
using MyApp.Infrastructure;

namespace MyApp.Domain;

/// <summary>An order.</summary>
public sealed class Order
{
    public decimal Total { get; set; }
}
`;

const CUSTOMER_CS = `namespace MyApp
{
    namespace Domain
    {
        internal record Customer(string Name);
    }

    public class Customer { }
}
`;

describe('tool selection', () => {
  it('picks known tools from MCR_TOOLS', () => {
    expect(toolsFrom('archunit')).toEqual(['archunit']);
    expect(toolsFrom(' netarchtest ')).toEqual(['netarchtest']);
    expect(toolsFrom(undefined)).toEqual(['archunit', 'netarchtest']);
    expect(toolsFrom('archunit,bogus')).toEqual(['archunit']);
  });
  it('info reflects the tools', () => {
    expect(infoFor(['archunit'])).toMatchObject({ name: 'archunit', languages: ['java', 'kotlin'], extensions: ['.java', '.kt'] });
    expect(infoFor(['netarchtest'])).toMatchObject({ name: 'netarchtest', languages: ['csharp'], extensions: ['.cs'] });
  });
});

describe('ArchUnit parsing', () => {
  it('reads attributes without dynamic regexes', () => {
    expect(attrs(` name="a &amp; b" classname='c'`)).toEqual({ name: 'a & b', classname: 'c' });
  });

  it('keeps only failed testcases, with message and body', () => {
    const cases = parseJUnit(SUREFIRE);
    expect(cases.map((c) => c.name)).toEqual(['domain_should_not_depend_on_web', 'plain_failure']);
    expect(cases[0].texts[0]).toBe(ARCH_MSG);
    expect(cases[0].texts[1]).toContain('ArchRule$Assertions');
  });

  it('parses header and violation lines, stopping at the stack trace', () => {
    const [, body] = parseJUnit(SUREFIRE)[0].texts;
    const v = parseArchUnit(body);
    expect(v).toHaveLength(2);
    expect(v[1]).toEqual({
      priority: 'MEDIUM',
      rule: "no classes that reside in a package '..domain..' should depend on classes that reside in a package '..web..'",
      line: 'Method <com.acme.domain.Order.toDto()> calls constructor <com.acme.web.OrderDto.<init>(java.lang.String)> in (Order.java:42)',
      fqn: 'com.acme.domain.Order.toDto',
      fileName: 'Order.java',
      lineNo: 42,
    });
  });

  it('ignores failures without ArchUnit text', () => {
    expect(parseArchUnit(parseJUnit(SUREFIRE)[1].texts.join('\n'))).toEqual([]);
  });

  it('derives the package path, also for inner classes', () => {
    expect(packagePath('com.acme.domain.Order.toDto', 'Order.java')).toBe('com/acme/domain');
    expect(packagePath('com.acme.domain.Order$Line', 'Order.java')).toBe('com/acme/domain');
    expect(packagePath(undefined, 'Order.java')).toBeUndefined();
  });

  it('maps to the reviewed file by package path, preferring src/*/java', () => {
    const files = ['legacy/com/acme/domain/Order.java', 'core/src/main/java/com/acme/domain/Order.java', 'other/src/main/java/com/acme/other/Order.java'];
    expect(mapJvmFile('Order.java', 'com/acme/domain', files)).toBe('core/src/main/java/com/acme/domain/Order.java');
    expect(mapJvmFile('Order.java', 'com/acme/nope', files)).toBeUndefined();
    expect(mapJvmFile('UserController.kt', 'com/acme/api', ['app/src/main/kotlin/api/UserController.kt'])).toBe('app/src/main/kotlin/api/UserController.kt');
  });
});

describe('NetArchTest parsing', () => {
  it('reads results with their class names', () => {
    const r = parseTrx(NETARCH_TRX);
    expect(r.map((x) => [x.className, x.outcome])).toEqual([
      ['MyApp.ArchTests.LayerTests', 'Failed'],
      ['MyApp.Tests.MathTests', 'Failed'],
      ['MyApp.ArchTests.LayerTests', 'Passed'],
    ]);
    expect(r[0].message).toContain('MyApp.Domain.Order, MyApp.Domain.Customer');
  });

  it('only architecture tests count', () => {
    const [arch, plain] = parseTrx(NETARCH_TRX);
    expect(isArchTest(arch)).toBe(true);
    expect(isArchTest(plain)).toBe(false);
    expect(isArchTest({ className: 'X.Tests', testName: 'Rules', message: ARCHUNITNET_MSG, stackTrace: '' })).toBe(true);
    expect(isArchTest({ className: 'X.Tests', testName: 'Check', message: 'Assert.True(result.IsSuccessful) failed', stackTrace: '' })).toBe(true);
    expect(isArchTest({ className: 'X.SearchTests', testName: 'Finds', message: 'nope', stackTrace: '' })).toBe(false);
  });

  it('extracts candidate type names', () => {
    expect(candidateTypes(ARCHUNITNET_MSG)).toEqual(expect.arrayContaining(['MyApp.Domain', 'MyApp.Web', 'MyApp.Domain.Order', 'MyApp.Web.OrderDto']));
    expect(candidateTypes('Repo`1 MyApp.Data.Repo`1+Item')).toEqual(['MyApp.Data.Repo+Item']);
  });

  it('finds declarations in file-scoped and nested block namespaces', () => {
    expect(csharpTypes(ORDER_CS)).toEqual([{ namespace: 'MyApp.Domain', name: 'Order', line: 7 }]);
    expect(csharpTypes(CUSTOMER_CS)).toEqual([
      { namespace: 'MyApp.Domain', name: 'Customer', line: 5 },
      { namespace: 'MyApp', name: 'Customer', line: 8 },
    ]);
  });

  it('locates a type by namespace and name, also from member names', () => {
    const types = [
      { file: 'a.cs', namespace: 'MyApp.Domain', name: 'Order', line: 7 },
      { file: 'b.cs', namespace: 'MyApp', name: 'Customer', line: 8 },
    ];
    expect(locateType('MyApp.Domain.Order', types)?.file).toBe('a.cs');
    expect(locateType('MyApp.Domain.Order.Total', types)?.file).toBe('a.cs');
    expect(locateType('Other.Domain.Order', types)).toBeUndefined();
    expect(locateType('Assert.True', types)).toBeUndefined();
  });
});

describe('analyze (temp repo)', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const write = (rel, text, time) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
    if (time) utimesSync(join(dir, rel), time, time);
  };

  it('archunit: findings in reviewed files only, LOW priority is medium, stale skipped', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcr-arch-'));
    const order = 'src/main/java/com/acme/domain/Order.java';
    const ctrl = 'src/main/kotlin/com/acme/api/UserController.kt';
    write(order, 'x\n'.repeat(50), 1000);
    write(ctrl, 'x\n', 3000);
    write('target/surefire-reports/TEST-com.acme.ArchitectureTest.xml', SUREFIRE, 2000);
    write(
      'build/test-results/test/TEST-com.acme.KotlinArchTest.xml',
      `<testsuite><testcase name="ctrl" classname="com.acme.KotlinArchTest"><failure message="${xmlEsc(LOW_MSG)}"/></testcase></testsuite>`,
      2000,
    );
    write('node_modules/x/target/surefire-reports/TEST-x.xml', SUREFIRE, 2000);
    expect(findResults(dir).junit.sort()).toEqual(['build/test-results/test/TEST-com.acme.KotlinArchTest.xml', 'target/surefire-reports/TEST-com.acme.ArchitectureTest.xml']);

    const { findings, notes } = await analyze({ root: dir, files: [order, ctrl], tools: ['archunit'] });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      ruleId: 'no-classes-that-reside-in-a-package-domain-should-depend-on',
      file: order,
      line: 1,
      category: 'architecture',
      severity: 'high',
    });
    expect(findings[1]).toMatchObject({ file: order, line: 42 });
    expect(notes).toContain(`archunit: stale results for ${ctrl}; rerun the tests (mvn test / gradle test)`);

    write(ctrl, 'x\n', 1000);
    const again = await analyze({ root: dir, files: [ctrl], tools: ['archunit'] });
    expect(again.findings).toEqual([expect.objectContaining({ file: ctrl, line: 1, severity: 'medium' })]);
    expect(again.notes[0]).toContain('2 outside the reviewed files');
  });

  it('netarchtest: maps failing types, ignores plain failures, newest run wins, stale skipped', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcr-arch-'));
    write('src/Domain/Order.cs', ORDER_CS, 1000);
    write('src/Domain/Customer.cs', CUSTOMER_CS, 3000);
    write('src/Web/OrderDto.cs', 'namespace MyApp.Web;\npublic class OrderDto {}\n', 1000);
    write('tests/ArchTests/TestResults/old.trx', trx(
      `<UnitTestResult testId="t9" testName="Rules" outcome="Failed"><Output><ErrorInfo><Message>${xmlEsc(ARCHUNITNET_MSG)}</Message></ErrorInfo></Output></UnitTestResult>`,
      `<UnitTest id="t9"><TestMethod className="MyApp.ArchTests.Rules" name="Rules"/></UnitTest>`,
    ), 1500);
    write('tests/ArchTests/TestResults/new.trx', trx(
      `<UnitTestResult testId="t9" testName="Rules" outcome="Passed"/>`,
      `<UnitTest id="t9"><TestMethod className="MyApp.ArchTests.Rules" name="Rules"/></UnitTest>`,
    ), 2500);
    write('tests/ArchTests/TestResults/layers.trx', NETARCH_TRX, 2000);

    const files = ['src/Domain/Order.cs', 'src/Domain/Customer.cs'];
    const { findings, notes } = await analyze({ root: dir, files, tools: ['netarchtest'] });
    expect(findings).toEqual([
      {
        ruleId: 'domain-shouldnotdependon-infrastructure',
        ruleName: 'MyApp.ArchTests.LayerTests.Domain_ShouldNotDependOn_Infrastructure',
        message: 'Architecture test Domain_ShouldNotDependOn_Infrastructure fails for MyApp.Domain.Order: Domain depends on infrastructure: MyApp.Domain.Order, MyApp.Domain.Customer',
        file: 'src/Domain/Order.cs',
        line: 7,
        category: 'architecture',
        severity: 'high',
      },
    ]);
    expect(notes).toContain('netarchtest: stale results for src/Domain/Customer.cs; rerun the tests (dotnet test --logger trx)');
    expect(notes).toContain('netarchtest: read 3 TRX file(s), 1 failing architecture test(s)');
  });

  it('netarchtest: ArchUnitNET message picks the violation line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcr-arch-'));
    write('src/Domain/Order.cs', ORDER_CS, 1000);
    write('TestResults/r.trx', trx(
      `<UnitTestResult testId="t1" testName="DomainRules" outcome="Failed"><Output><ErrorInfo><Message>${xmlEsc(ARCHUNITNET_MSG)}</Message></ErrorInfo></Output></UnitTestResult>`,
      `<UnitTest id="t1"><TestMethod className="MyApp.Tests.Rules" name="DomainRules"/></UnitTest>`,
    ), 2000);
    const { findings } = await analyze({ root: dir, files: ['src/Domain/Order.cs'], tools: ['netarchtest'] });
    expect(findings).toEqual([expect.objectContaining({ line: 7, message: 'Architecture test DomainRules fails for MyApp.Domain.Order: MyApp.Domain.Order does depend on MyApp.Web.OrderDto' })]);
  });

  it('no results: a note per tool, tool selection respected', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcr-arch-'));
    write('src/a.cs', 'x\n');
    expect((await analyze({ root: dir, files: ['src/a.cs'], tools: ['archunit'] })).notes).toEqual([
      'archunit: no test results; run the tests (mvn test / gradle test) so ArchUnit results exist',
    ]);
    expect(await analyze({ root: dir, files: ['src/a.cs'], tools: ['netarchtest'] })).toEqual({
      findings: [],
      notes: ['netarchtest: no test results; run the tests (dotnet test --logger trx) so architecture test results exist'],
    });
  });
});
