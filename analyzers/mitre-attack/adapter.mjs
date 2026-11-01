// MITRE ATT&CK: code that carries out an adversary technique (backdoors,
// persistence, defense evasion, exfiltration, supply-chain install hooks).
// semgrep and the linters look for vulnerabilities, gitleaks for secrets; this
// looks for intent. Each rule is a line pattern tagged with its technique, so
// ruleIds (`T1059.004-reverse-shell`) stay stable for decisions. Pure Node,
// no tool binary: it reads any text file in milliseconds.
//
// High is kept for patterns that have almost no honest use in a code base;
// the rest is medium (worth a look, never blocking at the default level).
// Test and fixture files are one step lower, and prose (Markdown, text) is
// skipped: install docs are full of piped installers.
//
// Some patterns spell a literal as a character class (`cur[l]`) so that this
// file does not match its own rules.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { serve } from '../_kit/serve.mjs';

const info = { name: 'mitre-attack', version: 'mitre-attack-v18', languages: ['any'], extensions: ['*'] };

const MAX_BYTES = 1_000_000;
const MAX_LINE = 4_000;
const PROSE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|testdata|examples?)\/|[._-](test|spec)\.[^/]+$/i;

/**
 * id: <technique>-<slug>; technique: ATT&CK id; pattern: per line;
 * files: only these paths (default any). Messages say what the line does and
 * what an honest version would look like.
 */
export const RULES = [
  {
    id: 'T1059.004-reverse-shell',
    technique: 'T1059.004',
    name: 'Reverse shell',
    severity: 'high',
    // Shell I/O wired to a socket, not just a socket: `echo > /dev/tcp/db/5432` is a port check, a bare pty.spawn a local shell.
    pattern: /\b(?:ba|z|da)?sh\s+-i\b[^\n]*\/dev\/(?:tcp|udp)\/|\/dev\/(?:tcp|udp)\/[\w.$-]+\/\d+[^\n]*\b0>&1|\b(?:nc|ncat|netcat)\b[^\n]*\s(?:-e|-c|--exec|--sh-exec)\s+\S*(?:sh|cmd(?:\.exe)?)\b|\bsocat\b[^\n]*\bexec:[^\n]*\b(?:sh|bash)\b|\bdup2\([^\n]*(?:\bpty\.spaw[n]\(|\b(?:subprocess\.call|os\.exec\w*)\(\s*\[?\s*["']\/bin\/(?:ba)?sh)/i,
    message: 'Hands a shell to a remote host (reverse shell). Remove it; remote administration belongs in an authenticated, audited channel.',
  },
  {
    id: 'T1059-download-execute',
    technique: 'T1059',
    name: 'Download and execute',
    severity: 'medium',
    pattern: /\b(?:cur[l]|wge[t])\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\b(?:ie[x]|Invoke-Expressio[n])\b[^\n]*\b(?:DownloadString|DownloadFile|Invoke-WebRequest|iwr|irm|Invoke-RestMethod)\b|\b(?:DownloadString|Invoke-WebRequest|iwr|irm)\b[^\n]*\|\s*(?:ie[x]|Invoke-Expressio[n])\b/i,
    message: 'Runs a script fetched over the network without checking it. Pin a version and verify a checksum or signature before running it.',
  },
  {
    id: 'T1059.001-encoded-powershell',
    technique: 'T1059.001',
    name: 'Encoded PowerShell',
    severity: 'high',
    pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}/i,
    message: 'Runs a base64-encoded PowerShell command, which hides what it does from review. Write the command out in plain text.',
  },
  {
    id: 'T1195.002-install-hook',
    technique: 'T1195.002',
    name: 'Package install hook reaching out',
    severity: 'high',
    files: /(^|\/)package\.json$/,
    pattern: /"(?:(?:pre|post)?install|prepar[e])"\s*:\s*"[^"]*(?:\b(?:curl|wget|nc|powershell)\b|https?:\/\/|base64|\beval\b)/i,
    message: 'An install hook fetches or runs code on every machine that installs this package (supply-chain vector). Move it to an explicit script users run themselves.',
  },
  {
    id: 'T1195.002-setup-py-network',
    technique: 'T1195.002',
    name: 'setup.py reaching out',
    severity: 'high',
    files: /(^|\/)setup\.py$/,
    pattern: /\b(?:urlope[n]|urlretriev[e]|requests\.(?:get|post)|httpx\.(?:get|post)|socket\.socket|http\.client\.HTTPS?Connection)\s*\(|\b(?:os\.system|subprocess\.\w+|Popen)\s*\([^\n]*\b(?:cur[l]|wge[t]|powershell)\b/,
    message: 'setup.py talks to the network, so installing the package runs a download on every machine (supply-chain vector). Declare dependencies instead, or ship the data in the package.',
  },
  {
    id: 'T1195.002-build-script',
    technique: 'T1195.002',
    name: 'Build script downloading or shelling out',
    severity: 'medium',
    files: /(^|\/)build\.rs$/,
    pattern: /Command::new\(\s*"(?:cur[l]|wge[t]|sh|bash|powershell|pwsh|cmd)"|\b(?:ureq|reqwest)::(?:get|blocking|Client)|TcpStream::connect/,
    message: 'build.rs downloads or runs a shell during `cargo build`, on every machine that builds this crate. Vendor the input or verify it by checksum.',
  },
  {
    id: 'T1027-decode-eval',
    technique: 'T1027',
    name: 'Executes decoded payload',
    severity: 'high',
    pattern: /\b(?:eval|exec|Function|assert)\s*\(\s*(?:[\w.]+\.)?(?:atob|b64decode|base64_decode|decodebytes|gzinflate|gzuncompress|str_rot13|decompress|unhexlify|fromCharCode)\s*\(|\b(?:eval|Function)\s*\(\s*Buffer\.from\([^)]*["'](?:base64|hex)["']/i,
    message: 'Executes a payload that is decoded at run time, so the code that runs is not the code reviewed. Check in the plain source instead.',
  },
  {
    id: 'T1505.003-web-shell',
    technique: 'T1505.003',
    name: 'Web shell',
    severity: 'high',
    pattern: /\b(?:eval|assert|system|exec|shell_exec|passthru|popen|proc_open)\s*\(\s*(?:base64_decode\s*\(\s*)?\$_(?:GET|POST|REQUEST|COOKIE|SERVER)\b|Runtime\.getRuntime\(\)\.exec\(\s*request\.getParameter\(/i,
    message: 'Runs a command or code taken straight from the request (web shell). Remove it; never pass request input to an interpreter.',
  },
  {
    id: 'T1070-clear-traces',
    technique: 'T1070',
    name: 'Indicator removal',
    severity: 'high',
    pattern: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b|\bHISTFILE=\/dev\/null\b|\bHISTSIZE=0\b|\brm\s+(?:-\w+\s+)*\/var\/log\/|(?:^|[;&|]\s*|\s)(?:>|truncate\s+-s\s*0)\s*\/var\/log\/|\bwevtutil(?:\.exe)?\s+cl\b|\bClear-EventLog\b/i,
    message: 'Erases logs or shell history, which hides activity from incident response. Use log rotation and retention settings instead.',
  },
  {
    id: 'T1562.001-disable-defenses',
    technique: 'T1562.001',
    name: 'Impair defenses',
    severity: 'high',
    pattern: /\bsetenforce\s+0\b|\bSet-MpPreference\b[^\n]*-Disable\w*\s+\$?true|\bsystemctl\s+(?:stop|disable|mask)\s+(?:auditd|apparmor|firewalld|ufw|falco|osqueryd|crowdstrike|falcon-sensor)\b|\bufw\s+disable\b|\biptables\s+-F\b|\bauditctl\s+-e\s*0\b|\bnetsh\s+(?:adv)?firewall\s+set\s+\w+\s+state\s+off\b/i,
    message: 'Turns off a security control (SELinux, AV, audit, firewall). Scope the exception narrowly in configuration instead of disabling it.',
  },
  {
    id: 'T1098.004-ssh-authorized-keys',
    technique: 'T1098.004',
    name: 'SSH authorized keys',
    severity: 'high',
    // Writes only: shell redirection or tee to a path, write APIs, open() in a write mode. Reads and comparisons are fine.
    pattern: /(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?(?:~|\$HOME|\$\{HOME\}|\/)[^\s"']*authorized[_]keys|\b(?:appendFile|writeFile|appendFileSync|writeFileSync|WriteAllText|AppendAllText)\b[^\n]*authorized[_]keys|authorized[_]keys[^\n]*\.(?:write_text|write)\(|\bopen\([^\n]*authorized[_]keys[^\n]*,\s*["'][^"']*[aw+]/i,
    message: 'Writes an SSH key into authorized_keys, granting lasting login access. Provision keys through your access-management system.',
  },
  {
    id: 'T1136-root-account',
    technique: 'T1136.001',
    name: 'Create root-equivalent account',
    severity: 'high',
    pattern: /\buseradd\b[^\n]*\s-o\b[^\n]*\s-u\s*0\b|\buseradd\b[^\n]*\s-u\s*0\b[^\n]*\s-o\b|:0:0:[^\n]*>>\s*\/etc\/passwd/i,
    message: 'Creates an account with uid 0 (a hidden root). Remove it.',
  },
  {
    id: 'T1496-cryptominer',
    technique: 'T1496',
    name: 'Resource hijacking',
    severity: 'high',
    pattern: /stratum\+(?:tcp|ssl|tls):\/\/|\bxmrig\b|\bcoinhive\b|\bminexmr\b|\bnicehash\b/i,
    message: 'References a cryptocurrency miner or mining pool. Remove it unless mining is this project\'s purpose.',
  },
  {
    id: 'T1567-exfil-service',
    technique: 'T1567',
    name: 'Exfiltration endpoint',
    severity: 'high',
    pattern: /\b(?:[\w-]+\.)?(?:webhook\.site|requestbin\.(?:com|net)|pipedream\.net|burpcollaborator\.net|oastify\.com|interact\.sh|oast\.(?:pro|live|site|online|fun|me)|canarytokens\.com|dnslog\.cn)\b/i,
    message: 'Sends data to a request-capture or out-of-band testing service, a common exfiltration channel. Use an endpoint you own.',
  },
  {
    id: 'T1567-paste-or-chat-webhook',
    technique: 'T1567',
    name: 'Paste site or chat webhook',
    severity: 'medium',
    pattern: /\b(?:pastebin\.com|paste\.ee|hastebin\.com|transfer\.sh|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|ngrok(?:-free)?\.(?:io|app))\b/i,
    message: 'Talks to a paste site, tunnel or chat webhook. Fine for notifications you own; confirm no repository, user or environment data goes there.',
  },
  {
    id: 'T1552.001-credential-files',
    technique: 'T1552.001',
    name: 'Reads credential stores',
    severity: 'medium',
    pattern: /(?:\.aws\/credentials|\.ssh\/id_(?:rsa|dsa|ecdsa|ed25519)\b(?!\.pub)|\/etc\/shadow\b|\.git-credential[s]\b|\.docker\/config\.json|\.kube\/config\b|Login[ ]Data\b|\bfind-generic-password\b|\bfind-internet-password\b|\bmimikatz\b|\bsekurlsa::)/i,
    message: 'Reads a credential store (cloud keys, SSH keys, shadow file, browser or keychain passwords). Take credentials from the environment or SDK default chain instead.',
  },
  {
    id: 'T1552-env-dump',
    technique: 'T1552',
    name: 'Dumps the whole environment',
    severity: 'medium',
    pattern: /JSON\.stringify\(\s*process\.env\s*\)|\b(?:dict|json\.dumps)\(\s*os\.environ\s*\)|\bSystem\.getenv\(\)\s*\.toString\(\)|\bEnvironment\.GetEnvironmentVariables\(\)\s*\.ToString|\bprintenv\s*\|\s*(?:curl|nc|base64)\b/i,
    message: 'Serializes every environment variable, secrets included; the first step of most credential-stealing packages. Read only the variables you need.',
  },
  {
    id: 'T1053.003-cron',
    technique: 'T1053.003',
    name: 'Cron persistence',
    severity: 'medium',
    pattern: /\|\s*crontab\s+-\s*(?:$|[;&|)])|(?:>>?|\btee\b[^\n]*)\s*\/(?:etc\/cron\.\w+|etc\/crontab|var\/spool\/cron)\b/i,
    message: 'Installs a cron job from code. Declare scheduled work in your deployment config so it is visible and reviewed.',
  },
  {
    id: 'T1543.002-systemd-service',
    technique: 'T1543.002',
    name: 'Systemd service persistence',
    severity: 'medium',
    pattern: /(?:>>?|\btee\b[^\n]*|\b(?:cp|mv|install)\b[^\n]*\s)\s*\/(?:etc|lib|usr\/lib)\/systemd\/system\/|~?\/\.config\/systemd\/user\//i,
    message: 'Writes a systemd unit from code (persistence). Ship units through packaging or config management instead.',
  },
  {
    id: 'T1546.004-shell-profile',
    technique: 'T1546.004',
    name: 'Shell profile modification',
    severity: 'medium',
    pattern: /(?:>>|\btee\s+-a\b[^\n]*|\b(?:appendFil[e]|appendFileSyn[c])\b[^\n]*)\s*["']?(?:~|\$HOME|\$\{HOME\}|\/root|\/home\/\w+)?\/?\.(?:bash[r]c|bash_profile|profile|zshrc|zprofile|zshenv)\b|>>\s*\/etc\/(?:profile|bash\.bashrc|zshrc)\b/i,
    message: 'Appends to a shell startup file, so code runs on every login. Ask the user to add it, or print the line for them.',
  },
  {
    id: 'T1547.001-run-key',
    technique: 'T1547.001',
    name: 'Registry run key',
    severity: 'medium',
    pattern: /\\Microsoft\\Windows\\CurrentVersion\\(?:Run|RunOnce|RunServices)\b|\\Winlogon\\(?:Userinit|Shell)\b/i,
    message: 'Writes a Windows autostart registry key (persistence). Use an installer-registered service or scheduled task instead.',
  },
  {
    id: 'T1548.001-setuid',
    technique: 'T1548.001',
    name: 'Setuid bit',
    severity: 'medium',
    pattern: /\bchmod\s+(?:[ugoa]*\+[rwx]*s|[0-7]?[4-7][0-7]{3})\s/,
    message: 'Sets the setuid/setgid bit, letting any user run the file with its owner\'s rights. Grant the specific capability instead.',
  },
  {
    id: 'T1105-fetch-chmod-run',
    technique: 'T1105',
    name: 'Ingress tool transfer',
    severity: 'medium',
    pattern: /\b(?:curl|wget)\b[^\n]*(?:-o|-O|>)\s*\S*(?:\/tmp|\/dev\/shm|\/var\/tmp)\/[^\n]*&&\s*chmod\s+\+?[0-7]*x?/i,
    message: 'Downloads a binary into a temp directory and makes it executable. Verify a checksum or install it through a package manager.',
  },
];

const LOWER = { high: 'medium', medium: 'low', low: 'low' };

export function helpUri(technique) {
  return `https://attack.mitre.org/techniques/${technique.replace('.', '/')}/`;
}

/** Findings for one file's text. */
export function scan(file, text) {
  if (PROSE.test(file)) return [];
  const test = TEST_PATH.test(file);
  const rules = RULES.filter((r) => !r.files || r.files.test(file));
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) : lines[i];
    for (const r of rules) {
      const m = r.pattern.exec(line);
      if (!m) continue;
      findings.push({
        ruleId: r.id,
        ruleName: `${r.technique} ${r.name}`,
        message: `ATT&CK ${r.technique} (${r.name}): ${r.message}`,
        file,
        line: i + 1,
        column: m.index + 1,
        category: 'security',
        severity: test ? LOWER[r.severity] : r.severity,
        helpUri: helpUri(r.technique),
      });
    }
  }
  return findings;
}

/** Text of a file, or null for binaries and anything over MAX_BYTES (checked before reading, and bounded). */
function readText(path) {
  if (statSync(path).size > MAX_BYTES) return null;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_BYTES || buf.subarray(0, Math.min(n, 8000)).includes(0)) return null;
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

async function analyze({ root, files }) {
  const findings = [];
  const skipped = [];
  for (const f of files) {
    let text;
    try {
      text = readText(`${root}/${f}`);
    } catch {
      continue; // deleted or unreadable
    }
    if (text === null) skipped.push(f);
    else for (const x of scan(f, text)) findings.push(x); // a loop: push(...) has an argument limit
  }
  return { findings, notes: skipped.length ? [`mitre-attack: skipped ${skipped.length} binary or >1 MB file(s)`] : [] };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
