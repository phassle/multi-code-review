import { describe, expect, it } from 'vitest';
import { cppcheckCategory, cppcheckSeverity, parseCppcheckXml, toFindings, unescapeXml } from './adapter.mjs';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<results version="2">
    <cppcheck version="2.14.2"/>
    <errors>
        <error id="arrayIndexOutOfBounds" severity="error" msg="Array &apos;a[10]&apos; accessed at index 10, which is out of bounds." verbose="Array &apos;a[10]&apos; accessed at index 10, which is out of bounds." cwe="788" file0="/src/acme/main.cpp">
            <location file="/src/acme/main.cpp" line="9" column="6" info="Array index out of bounds"/>
            <symbol>a</symbol>
        </error>
        <error id="memleak" severity="error" msg="Memory leak: buf" verbose="Memory leak: buf" cwe="401" file0="/src/acme/main.cpp">
            <location file="/src/acme/main.cpp" line="21" column="1"/>
        </error>
        <error id="passedByValue" severity="performance" msg="short" verbose="Function parameter &quot;s&quot; should be passed by const reference." cwe="398" file0="/src/acme/main.cpp">
            <location file="/src/acme/main.cpp" line="42" column="34"/>
        </error>
        <error id="syntaxError" severity="error" msg="syntax error" verbose="syntax error" file0="/src/acme/b.c">
            <location file="/src/acme/b.c" line="3" column="1"/>
        </error>
        <error id="missingIncludeSystem" severity="information" msg="Include file not found" verbose="Include file not found"/>
    </errors>
</results>`;

describe('cppcheck analyzer', () => {
  it('maps ids, severities and CWEs onto our categories', () => {
    expect(cppcheckCategory('arrayIndexOutOfBounds', 'error', 788)).toBe('security');
    expect(cppcheckCategory('nullPointerRedundantCheck', 'warning', 476)).toBe('security');
    expect(cppcheckCategory('someNewCheck', 'error', 416)).toBe('security');
    expect(cppcheckCategory('getsCalled', 'warning', 477)).toBe('security');
    expect(cppcheckCategory('memleak', 'error', 401)).toBe('reliability');
    expect(cppcheckCategory('resourceLeak', 'error', 775)).toBe('reliability');
    expect(cppcheckCategory('zerodiv', 'error', 369)).toBe('correctness');
    expect(cppcheckCategory('selfAssignment', 'warning', 398)).toBe('correctness');
    expect(cppcheckCategory('passedByValue', 'performance', 398)).toBe('reliability');
    expect(cppcheckCategory('AssignmentAddressToInteger', 'portability', 758)).toBe('reliability');
    expect(cppcheckCategory('variableScope', 'style', 398)).toBe('best-practices');
    expect(cppcheckSeverity('error')).toBe('high');
    expect(cppcheckSeverity('warning')).toBe('medium');
    expect(cppcheckSeverity('style')).toBe('low');
  });

  it('unescapes XML entities', () => {
    expect(unescapeXml('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos; &#65;&#x42;')).toBe(`<a> & "b" 'c' AB`);
  });

  it('parses the XML report into findings relative to the root, without tool errors', () => {
    const errors = parseCppcheckXml(XML);
    expect(errors).toHaveLength(5);
    expect(toFindings(errors, '/src/acme')).toEqual([
      { ruleId: 'arrayIndexOutOfBounds', message: "Array 'a[10]' accessed at index 10, which is out of bounds.", file: 'main.cpp', line: 9, column: 6, category: 'security', severity: 'high', ruleName: 'CWE-788' },
      { ruleId: 'memleak', message: 'Memory leak: buf', file: 'main.cpp', line: 21, column: 1, category: 'reliability', severity: 'high', ruleName: 'CWE-401' },
      { ruleId: 'passedByValue', message: 'Function parameter "s" should be passed by const reference.', file: 'main.cpp', line: 42, column: 34, category: 'reliability', severity: 'low', ruleName: 'CWE-398' },
    ]);
  });
});
