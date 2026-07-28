/**
 * semgrep.mjs — optional Semgrep (SAST) integration for the code-pattern vectors
 * (injection/XSS, ReDoS, and other insecure patterns). Analogous to the gitleaks
 * hook for Secrets: if `semgrep` is installed and the user opts in (--semgrep), we
 * shell out, map its findings into the report's vectors, and attribute each line
 * via git blame. Opt-in (not auto) because Semgrep is heavier than gitleaks and
 * fetches its rule packs on first run.
 */
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

export const SAST_VECTOR = 'SAST (other)';
const SEV = { ERROR: 'High', WARNING: 'Medium', INFO: 'Low' };

export function semgrepVersion(cwd) {
  try { return execSync('semgrep --version', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; }
  catch { return null; }
}

/** Route a Semgrep result into one of the report's vectors by keyword. */
function mapVector(r) {
  const meta = r.extra?.metadata || {};
  const s = `${r.check_id || ''} ${r.extra?.message || ''} ${meta.category || ''} ${[].concat(meta.cwe || []).join(' ')} ${[].concat(meta.owasp || []).join(' ')}`.toLowerCase();
  if (/xss|cross-site|innerhtml|sanitiz|dom-based|trustedhtml/.test(s)) return 'Injection/XSS';
  if (/sql|nosql|injection|command|ssti|template-?injection|\beval\b|deserial/.test(s)) return 'Injection/XSS';
  if (/redos|regular expression|catastrophic|\bregex\b/.test(s)) return 'ReDoS';
  if (/clipboard|paste/.test(s)) return 'Clipboard';
  if (/\bdos\b|denial[- ]of[- ]service|payload size|size limit/.test(s)) return 'LPDoS';
  return SAST_VECTOR;
}

function blameAuthors(git, file) {
  const out = git(`blame --line-porcelain -w -- "${file}"`);
  if (!out) return [];
  const arr = []; let name = 'unknown';
  for (const line of out.split('\n')) {
    if (line.startsWith('author ') && !line.startsWith('author-mail') && !line.startsWith('author-time') && !line.startsWith('author-tz')) name = line.slice(7).trim();
    else if (line[0] === '\t') arr.push(name);
  }
  return arr;
}

/**
 * Run Semgrep and return { version, findings } mapped to report vectors, or null
 * if semgrep isn't installed / the run failed (→ caller keeps built-in results).
 * Config defaults to the security-audit pack; override via $GTR_SEMGREP_CONFIG
 * (comma-separated, e.g. "p/security-audit,p/xss").
 */
export function runSemgrep(git, cwd, { config } = {}) {
  const version = semgrepVersion(cwd);
  if (!version) return null;
  const cfg = (config || process.env.GTR_SEMGREP_CONFIG || 'p/security-audit').split(',').map((c) => `--config ${c.trim()}`).join(' ');
  const tmp = join(tmpdir(), `gtr-semgrep-${process.pid}.json`);
  try {
    // semgrep exits 1 when it finds issues → still writes -o; catch and read the file.
    execSync(`semgrep ${cfg} --json --quiet --timeout 120 -o "${tmp}" .`, { cwd, stdio: 'ignore', maxBuffer: 256 * 1024 * 1024 });
  } catch { /* findings cause non-zero exit; report file is what matters */ }
  if (!existsSync(tmp)) return null; // couldn't produce output (e.g. offline, bad config) → fall back
  let data;
  try { data = JSON.parse(readFileSync(tmp, 'utf8') || '{}'); } catch { data = {}; }
  rmSync(tmp, { force: true });

  const cache = {};
  const authorOf = (file, line) => {
    if (!(file in cache)) cache[file] = blameAuthors(git, file);
    return (cache[file][line - 1]) || 'unknown';
  };

  const findings = (data.results || []).map((r) => {
    const file = r.path, line = r.start?.line || 0;
    return {
      vector: mapVector(r), id: `semgrep:${r.check_id || 'rule'}`, file, line,
      severity: SEV[r.extra?.severity] || 'Medium',
      snippet: `${(r.check_id || '').split('.').pop()}: ${(r.extra?.message || '').replace(/\s+/g, ' ').trim()}`.slice(0, 180),
      fix: 'Apply the remediation from this Semgrep rule (see its rule id / references).',
      review: true, author: authorOf(file, line), authorEmail: '',
    };
  });
  return { version, findings };
}
