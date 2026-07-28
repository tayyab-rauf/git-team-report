/**
 * security.mjs — greppable signals for six vulnerability vectors.
 *
 * IMPORTANT: this is a *signal scanner*, not a proof of exploitability. Grep can
 * find a dangerous sink, a secret-shaped string, or a scary regex; it cannot
 * decide whether the input is attacker-controlled, whether a length bound exists
 * elsewhere, or whether pasted text is sanitized downstream. Rules carry a
 * `review` flag when a human must confirm. Treat High/Medium as "look here first".
 */
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.html', '*.vue'];
// Exclude tests, type decls, build output, and — critically — vendored/generated
// assets (charting libs, polyfills, bundles). Those are minified third-party code
// and produce almost nothing but false positives.
const EXCLUDE = /(node_modules|\.spec\.|\.test\.|\.d\.ts$|dist\/|build\/|coverage\/|\.min\.|\.bundle\.|package-lock|\.map$|\/assets\/|charting_library|tradingview|vendor\/|polyfill)/i;
// Minified/generated files have absurdly long lines — skip them entirely.
const MINIFIED_LINE = 2000;

/**
 * Each rule: { id, vector, severity, re, fix, review?, pathInclude?, pathExclude? }
 * `re` runs per line. Keep patterns conservative to limit false positives.
 */
export const SECURITY_RULES = [
  // 1 — ReDoS
  { id: 'redos-nested-quant', vector: 'ReDoS', severity: 'Medium', review: true,
    re: /\/[^/\n]*\([^)\n]*[+*][^)\n]*\)[+*][^/\n]*\//,
    fix: 'Rewrite to avoid nested quantifiers (e.g. `(a+)+`); anchor the pattern and cap input length before matching (e.g. reject inputs over N chars).' },
  { id: 'redos-user-input', vector: 'ReDoS', severity: 'Low', review: true,
    re: /new RegExp\(/,
    fix: 'Dynamic RegExp from variables is risky if the source is user-controlled. Validate/escape the input and bound its length.' },

  // 2 — Secret / credential leakage
  { id: 'secret-assign', vector: 'Secrets', severity: 'High', review: true,
    re: /\b(api[_-]?key|secret|passwd|password|token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"][^'"]{12,}['"]/i,
    pathExclude: /\.html$/,
    fix: 'Move to an env var / secret manager; never commit literal secrets. Rotate anything that was committed.' },
  { id: 'secret-privkey', vector: 'Secrets', severity: 'High',
    re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    fix: 'Remove the private key from the repo and rotate it immediately.' },
  { id: 'secret-aws', vector: 'Secrets', severity: 'High',
    re: /\bAKIA[0-9A-Z]{16}\b/,
    fix: 'AWS access key ID committed — revoke/rotate now and move to a secret store.' },
  { id: 'secret-nonpublic-env', vector: 'Secrets', severity: 'Medium', review: true,
    re: /process\.env\[?['"]?(?!(NG_APP_|ANGULAR_APP_|NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NODE_ENV|PORT))[A-Z][A-Z0-9_]{2,}/,
    pathInclude: /(component|\.page\.|\/app\/|src\/app\/|browser)/i,
    fix: 'Private env vars must not reach browser bundles. Expose only public-prefixed vars client-side; keep secrets server-only (BFF).' },

  // 3 — Injection / XSS
  { id: 'xss-bypass', vector: 'Injection/XSS', severity: 'High', review: true,
    re: /bypassSecurityTrust(Html|Url|ResourceUrl|Script|Style)\s*\(/,
    fix: 'Avoid bypassing Angular sanitization on untrusted input. If unavoidable, sanitize/allowlist first and confine to trusted, non-user data.' },
  { id: 'xss-innerhtml', vector: 'Injection/XSS', severity: 'High', review: true,
    re: /\.(innerHTML|outerHTML)\s*=|\[innerHTML\]|dangerouslySetInnerHTML|\bv-html\b/,
    fix: 'Render via text binding, or sanitize with DomSanitizer / DOMPurify before injecting HTML.' },
  { id: 'xss-eval', vector: 'Injection/XSS', severity: 'High',
    re: /\beval\s*\(|new Function\s*\(|document\.write\s*\(/,
    fix: 'Remove eval / new Function / document.write; use a parser or safe DOM APIs.' },
  { id: 'nosqli-operator', vector: 'Injection/XSS', severity: 'Medium', review: true,
    re: /\$(ne|gt|lt|gte|lte|in|nin|where|regex)\b|\{\s*\$[a-z]+\s*:/,
    fix: 'Validate/coerce request bodies with a schema before querying; reject objects where scalars are expected to block operator injection.' },

  // 4 — Large-Payload DoS
  { id: 'lpdos-file', vector: 'LPDoS', severity: 'Medium', review: true,
    re: /type\s*=\s*['"]file['"]|new FileReader\(|\.files\[|readAs(DataURL|ArrayBuffer|Text)\(/,
    fix: 'Enforce a max File.size and count client-side before upload; reject oversized files before the network request. Also bound array/string lengths on rich inputs.' },

  // 5 — Clipboard / pastejacking
  { id: 'clipboard', vector: 'Clipboard', severity: 'Medium', review: true,
    re: /navigator\.clipboard|clipboardData|\(paste\)|onPaste|addEventListener\(\s*['"]paste['"]/,
    fix: 'When rendering/executing pasted content, strip zero-width & control chars (e.g. /[\\u200B-\\u200D\\uFEFF\\u0000-\\u001F]/g) and treat it as untrusted text.' },

  // 6 — Replay / idempotency
  { id: 'replay-mutation', vector: 'Replay', severity: 'Low', review: true,
    re: /\.(post|put|patch|delete)\s*\(/i,
    pathInclude: /(service|api|checkout|payment|reset|order|pay)/i,
    fix: 'For sensitive mutations (payment/reset/checkout), add a client-generated idempotency key / nonce header and disable the trigger button while in flight.' },
];

const clip = (s, n = 160) => { s = s.trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

/** Parse `git blame --line-porcelain` → array where index i = { name, email } of output line i. */
function blameAuthors(git, file) {
  const out = git(`blame --line-porcelain -w -- "${file}"`);
  if (!out) return [];
  const arr = [];
  let name = 'unknown', email = 'unknown';
  for (const line of out.split('\n')) {
    if (line.startsWith('author-mail ')) email = line.slice(12).replace(/[<>]/g, '').trim();
    else if (line.startsWith('author ')) name = line.slice(7).trim();
    else if (line[0] === '\t') arr.push({ name, email });
  }
  return arr;
}

/**
 * Scan tracked files. Returns findings grouped by vector:
 *   { byVector: { ReDoS: [ {file,line,severity,snippet,fix,review,id} ], ... }, files }
 */
export function scanSecurity(git, cwd, { rules = SECURITY_RULES, onProgress, gitleaks = true } = {}) {
  const listed = git(`ls-files -- ${GLOBS.map((g) => `"${g}"`).join(' ')}`)
    .split('\n').filter(Boolean).filter((f) => !EXCLUDE.test(f));

  const byVector = {};
  for (const r of rules) (byVector[r.vector] ??= []);

  let scanned = 0;
  for (const file of listed) {
    let lines;
    try { lines = readFileSync(join(cwd, file), 'utf8').split('\n'); } catch { continue; }
    if (lines.some((l) => l.length > MINIFIED_LINE)) { scanned++; continue; } // minified/generated — skip
    let blame = null; // lazily blamed on first hit, then reused for this file
    const ensureBlame = () => (blame ??= blameAuthors(git, file));
    for (const rule of rules) {
      if (rule.pathInclude && !rule.pathInclude.test(file)) continue;
      if (rule.pathExclude && rule.pathExclude.test(file)) continue;
      for (let i = 0; i < lines.length; i++) {
        if (rule.re.test(lines[i])) {
          const who = ensureBlame()[i] || { name: 'unknown', email: '' };
          byVector[rule.vector].push({
            id: rule.id, file, line: i + 1, severity: rule.severity,
            snippet: clip(lines[i]), fix: rule.fix, review: !!rule.review,
            author: who.name, authorEmail: who.email,
          });
        }
      }
    }
    scanned++;
    if (onProgress && scanned % 100 === 0) onProgress(scanned, listed.length);
  }

  // Secrets: prefer gitleaks (history-aware, richer rules) when available.
  let secretsEngine = 'built-in patterns (working tree only)';
  if (gitleaks) {
    const gl = runGitleaks(cwd);
    if (gl) { byVector['Secrets'] = gl.findings; secretsEngine = `gitleaks ${gl.version} (full git history)`; }
  }

  return { byVector, files: listed.length, secretsEngine };
}

/**
 * Optional gitleaks integration for the Secrets vector. gitleaks is a dedicated
 * secrets scanner with 150+ rules + entropy detection that scans the FULL git
 * history (not just the working tree) and reports the introducing commit's author.
 * If the binary is present we use it; otherwise we fall back to the regex rules
 * above. We run with --redact so raw secrets never touch the report.
 */
function gitleaksVersion(cwd) {
  try { return execSync('gitleaks version', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function runGitleaks(cwd) {
  const version = gitleaksVersion(cwd);
  if (!version) return null;
  const tmp = join(tmpdir(), `gtr-gitleaks-${process.pid}.json`);
  // `detect` (classic) and `git` (newer CLI) both scan history; try in order.
  const variants = [
    `gitleaks detect --source "${cwd}" --report-format json --report-path "${tmp}" --redact --exit-code 0 --no-banner`,
    `gitleaks git "${cwd}" --report-format json --report-path "${tmp}" --redact --exit-code 0 --no-banner`,
  ];
  for (const cmd of variants) {
    try {
      execSync(cmd, { cwd, stdio: 'ignore', maxBuffer: 64 * 1024 * 1024 });
      if (!existsSync(tmp)) continue;
      const raw = readFileSync(tmp, 'utf8').trim();
      rmSync(tmp, { force: true });
      const data = raw ? JSON.parse(raw) : [];
      const findings = (Array.isArray(data) ? data : []).map((f) => ({
        id: `gitleaks:${f.RuleID || 'secret'}`, file: f.File, line: f.StartLine || 0, severity: 'High',
        snippet: `${f.RuleID || 'secret'} — ${(f.Description || 'potential secret')}`.slice(0, 160),
        fix: 'Rotate the exposed credential immediately and purge it from git history (git filter-repo / BFG); load secrets from env/secret manager. (gitleaks scans full history — this may be in an old commit, not the current file.)',
        review: true, author: f.Author || 'unknown', authorEmail: f.Email || '',
      }));
      return { version, findings };
    } catch { try { rmSync(tmp, { force: true }); } catch {} }
  }
  return null;
}

const VECTORS = ['ReDoS', 'Secrets', 'Injection/XSS', 'LPDoS', 'Clipboard', 'Replay'];
const SEV_RANK = { High: 0, Medium: 1, Low: 2 };

/** Render a structured Markdown report (file:line, snippet, risk, fix). */
export function securityMarkdown(result, { repoName, date }) {
  const total = Object.values(result.byVector).flat().length;
  const counts = { High: 0, Medium: 0, Low: 0 };
  for (const f of Object.values(result.byVector).flat()) counts[f.severity]++;

  let md = `# Security Signal Scan — ${repoName}\n\n`;
  md += `> ${date} · scanned ${result.files} files · **${total}** candidate signals `;
  md += `(${counts.High} High · ${counts.Medium} Medium · ${counts.Low} Low)\n\n`;
  md += `> ⚠️ Signals, not confirmed vulnerabilities. Items marked _(review)_ need a human to confirm exploitability (user-controlled input? bound present? sanitized downstream?).\n`;
  md += `> Secrets engine: **${result.secretsEngine || 'built-in patterns'}**.\n\n`;

  for (const vector of VECTORS) {
    const hits = (result.byVector[vector] || []).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    md += `## ${vector}\n\n`;
    if (!hits.length) { md += `No issues detected.\n\n`; continue; }
    // group identical fixes so we print the recommendation once per rule
    const byId = {};
    for (const h of hits) (byId[h.id] ??= []).push(h);
    for (const [, group] of Object.entries(byId)) {
      const g0 = group[0];
      md += `**${g0.severity}${g0.review ? ' _(review)_' : ''}** — ${group.length} location${group.length > 1 ? 's' : ''}:\n\n`;
      for (const h of group.slice(0, 20)) {
        md += `- \`${h.file}:${h.line}\` — **${h.author}**\n  \`\`\`\n  ${h.snippet}\n  \`\`\`\n`;
      }
      if (group.length > 20) md += `- …and ${group.length - 20} more\n`;
      // who owns these lines (by git blame)
      const tally = {};
      for (const h of group) tally[h.author] = (tally[h.author] || 0) + 1;
      const owners = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join(', ');
      md += `\n  **Owner(s):** ${owners}\n  **Fix:** ${g0.fix}\n\n`;
    }
  }
  return md;
}
