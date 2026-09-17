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
import { runSemgrep } from './semgrep.mjs';
import { createPathMatcher, hasInlineSuppression, isSampleOrDocComment, GENERATED_EXCLUDE, isMinified } from './ignore.mjs';

/**
 * Files that carry secrets regardless of the repo's language: env files, config,
 * CI/deploy scripts, IaC. Every language pack scans these in addition to its own
 * source globs — a leaked credential is not a TypeScript problem.
 */
export const CONFIG_GLOBS = [
  '*.env*', '*.json', '*.yml', '*.yaml', '*.properties', '*.ini', '*.cfg',
  '*.conf', '*.toml', '*.sh', '*.xml', '*Dockerfile*', '*.tf',
];
export const SECURITY_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.html', '*.vue', ...CONFIG_GLOBS];
// Tests, type decls, build output, and vendored/generated assets live in
// ignore.mjs GENERATED_EXCLUDE — shared with the code scanner.
const EXCLUDE = GENERATED_EXCLUDE;

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
  // Identifiers carry prefixes/suffixes (DB_PASSWORD, myApiKey) and JSON quotes its
  // keys ("client_secret": …) — anchoring on \b at both ends missed all of that.
  { id: 'secret-assign', vector: 'Secrets', severity: 'High', review: true,
    re: /[A-Za-z0-9_-]*(api[_-]?key|secret|passwd|password|token|credentials?|private[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*['"][^'"]{12,}['"]/i,
    pathExclude: /\.html$/,
    fix: 'Move to an env var / secret manager; never commit literal secrets. Rotate anything that was committed.' },
  // .env / .properties / shell values are usually unquoted, so the rule above cannot
  // see them. Scoped to config files, and skips references ($VAR, ${{ secrets.X }}).
  { id: 'secret-config-assign', vector: 'Secrets', severity: 'High', review: true,
    re: /[A-Za-z0-9_-]*(api[_-]?key|secret|passwd|password|token|credentials?)[A-Za-z0-9_-]*\s*[:=]\s*(?!["'\s$#{<%])[^\s"'#]{12,}/i,
    pathInclude: /\.(env|properties|ini|cfg|conf|toml|ya?ml|sh)(\.|$)|(^|\/)\.env/i,
    fix: 'Move the value to a secret manager and reference it ($VAR / vault lookup). Rotate anything that was committed.' },
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
    re: /\.(innerHTML|outerHTML)\s*=|dangerouslySetInnerHTML|\bv-html\b/,
    fix: 'Render via text binding, or sanitize with DomSanitizer / DOMPurify before injecting HTML.' },
  { id: 'xss-eval', vector: 'Injection/XSS', severity: 'High',
    re: /\beval\s*\(|new Function\s*\(|document\.write\s*\(/,
    fix: 'Remove eval / new Function / document.write; use a parser or safe DOM APIs.' },
  { id: 'nosqli-operator', vector: 'Injection/XSS', severity: 'Medium', review: true,
    re: /\$(ne|gt|lt|gte|lte|in|nin|where|regex)\b|\{\s*\$[a-z]+\s*:/,
    fix: 'Validate/coerce request bodies with a schema before querying; reject objects where scalars are expected to block operator injection.' },

  // 4 — Large-Payload DoS
  { id: 'lpdos-file', vector: 'LPDoS', severity: 'Low', review: true,
    re: /type\s*=\s*['"]file['"]|new FileReader\(|\.files\[|readAs(DataURL|ArrayBuffer|Text)\(/,
    fix: 'Enforce a max File.size and count client-side before upload; reject oversized files before the network request. Also bound array/string lengths on rich inputs.' },

  // 5 — Clipboard / pastejacking
  { id: 'clipboard', vector: 'Clipboard', severity: 'Medium', review: true,
    re: /navigator\.clipboard|clipboardData|\(paste\)|onPaste|addEventListener\(\s*['"]paste['"]/,
    fix: 'When rendering/executing pasted content, strip zero-width & control chars (e.g. /[\\u200B-\\u200D\\uFEFF\\u0000-\\u001F]/g) and treat it as untrusted text.' },

  // 6 — Replay / idempotency
  { id: 'replay-mutation', vector: 'Replay', severity: 'Low', review: true,
    re: /\.(post|put|patch|delete)\s*\(/i,
    pathInclude: /(checkout|payment|charge|billing|transfer|payout|refund)/i,
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
/** The secret-detection rules alone — reused by non-web language packs. */
export const SECRET_RULES = SECURITY_RULES.filter((r) => r.vector === 'Secrets');

export function scanSecurity(git, cwd, { rules = SECURITY_RULES, globs = SECURITY_GLOBS, onProgress, gitleaks = true, semgrep = false, disabledRules = [], excludePaths = [] } = {}) {
  const pathExcluded = createPathMatcher(excludePaths);
  const activeRules = rules.filter((r) => !disabledRules.includes(r.id) && !disabledRules.includes(r.key));

  const listed = git(`ls-files -- ${globs.map((g) => `"${g}"`).join(' ')}`)
    .split('\n').filter(Boolean).filter((f) => !EXCLUDE.test(f) && !pathExcluded(f));

  const byVector = {};
  for (const r of rules) (byVector[r.vector] ??= []);

  let scanned = 0;
  for (const file of listed) {
    let lines;
    try { lines = readFileSync(join(cwd, file), 'utf8').split('\n'); } catch { continue; }
    if (isMinified(lines)) { scanned++; continue; } // minified/generated — skip
    let blame = null; // lazily blamed on first hit, then reused for this file
    const ensureBlame = () => (blame ??= blameAuthors(git, file));
    for (const rule of activeRules) {
      if (rule.pathInclude && !rule.pathInclude.test(file)) continue;
      if (rule.pathExclude && rule.pathExclude.test(file)) continue;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const prevLine = i > 0 ? lines[i - 1] : '';
        if (hasInlineSuppression(line, prevLine)) continue;
        if (isSampleOrDocComment(line, file)) continue;
        if (rule.re.test(line)) {
          const who = ensureBlame()[i] || { name: 'unknown', email: '' };
          byVector[rule.vector].push({
            id: rule.id, file, line: i + 1, severity: rule.severity,
            snippet: clip(line), fix: rule.fix, review: !!rule.review,
            author: who.name, authorEmail: who.email, source: 'built-in',
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
    if (gl) {
      // AUGMENT, never replace: gitleaks knows entropy + history, but it does not
      // know our rules (weak password encoders, private env vars reaching the
      // browser). Assigning over byVector.Secrets silently dropped those.
      const glLines = new Set(gl.findings.map((f) => `${f.file}:${f.line}`));
      byVector['Secrets'] = [
        ...(byVector['Secrets'] || []).filter((f) => !glLines.has(`${f.file}:${f.line}`)),
        ...gl.findings,
      ];
      secretsEngine = `gitleaks ${gl.version} (full git history) + built-in rules`;
    }
  }

  // SAST vectors: augment with Semgrep when opted in and installed.
  let sastEngine = null;
  if (semgrep) {
    const sg = runSemgrep(git, cwd);
    if (sg) {
      for (const f of sg.findings) (byVector[f.vector] ??= []).push(f);
      sastEngine = `semgrep ${sg.version}`;
    }
  }

  // Post-process all vectors for exclusions, disabled rules, sample comments, and Firebase keys
  for (const vec of Object.keys(byVector)) {
    byVector[vec] = byVector[vec].filter((f) => {
      if (pathExcluded(f.file)) return false;
      if (disabledRules.includes(f.id)) return false;
      if (isSampleOrDocComment(f.snippet, f.file)) return false;
      return true;
    });
  }

  if (byVector['Secrets']) {
    for (const f of byVector['Secrets']) {
      const isGcpKey = /AIza[0-9A-Za-z-_]{30,45}/.test(f.snippet) || (f.id && f.id.includes('gcp-api-key'));
      if (isGcpKey) {
        const isClientFile = /\.(ts|tsx|js|jsx|html|vue)$/i.test(f.file) || /environment/i.test(f.file);
        let fileText = '';
        try { fileText = readFileSync(join(cwd, f.file), 'utf8'); } catch {}
        const isFirebase = /firebase|authDomain/i.test(fileText) || /firebase|authDomain/i.test(f.snippet);
        if (isClientFile || isFirebase) {
          f.severity = 'Low';
          f.review = true;
          if (!f.snippet.startsWith('[Firebase/Web Client Key]')) {
            f.snippet = `[Firebase/Web Client Key] ${f.snippet}`;
          }
          f.fix = 'Firebase / client-side Google API key is a public project identifier. Ensure HTTP referrer / package restrictions and Firebase Security Rules are enforced in Google Cloud Console; rotating is not required unless abused.';
        }
      }
    }
  }

  return { byVector, files: listed.length, secretsEngine, sastEngine };
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
      const seen = new Set();
      const findings = [];
      for (const f of Array.isArray(data) ? data : []) {
        const key = `${f.RuleID || 'secret'}:${f.File}:${f.StartLine || 0}:${f.Secret || f.Match || f.Description || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          id: `gitleaks:${f.RuleID || 'secret'}`, file: f.File, line: f.StartLine || 0, severity: 'High',
          snippet: `${f.RuleID || 'secret'} — ${(f.Description || 'potential secret')}`.slice(0, 160),
          fix: 'Rotate the exposed credential immediately and purge it from git history (git filter-repo / BFG); load secrets from env/secret manager. (gitleaks scans full history — this may be in an old commit, not the current file.)',
          review: true, author: f.Author || 'unknown', authorEmail: f.Email || '', source: 'gitleaks',
        });
      }
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
  md += `> Secrets engine: **${result.secretsEngine || 'built-in patterns'}**`;
  md += result.sastEngine ? ` · SAST: **${result.sastEngine}**.\n\n` : `.\n\n`;

  const vectors = [...VECTORS, ...Object.keys(result.byVector).filter((v) => !VECTORS.includes(v))];
  for (const vector of vectors) {
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
