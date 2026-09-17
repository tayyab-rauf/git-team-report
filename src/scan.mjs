/**
 * scan.mjs — automatic code-quality audit. No config required.
 *
 * Greps tracked source files for a set of smells, then attributes each hit to an
 * author with `git blame` (line-level, against HEAD — the current state of the
 * code). This is what lets the tool produce a real issue matrix + code grades on
 * ANY repo, instead of only rendering hand-written findings.
 *
 * Rules are TS/Angular-flavoured by default but are plain regex + path filters,
 * so a config can override `scan.rules` for other stacks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPathMatcher, hasInlineSuppression } from './ignore.mjs';

/** Default smell rules. Each: key, label, regex, optional path include/exclude. */
export const DEFAULT_RULES = [
  { key: 'any',     label: '<code>any</code> types',      re: /(:\s*any\b|\bas any\b|<any>)/ },
  { key: 'console', label: '<code>console.*</code>',      re: /\bconsole\.(log|error|warn|info|debug)\b/,
    pathExclude: /(server|main|bootstrap|\.spec\.|polyfills)/i },
  { key: 'subs',    label: 'Bare subscriptions',          re: /\.subscribe\(/ },
  { key: 'dom',     label: 'Unguarded DOM',               re: /\b(window|document)\.(?!.*isPlatformBrowser)/,
    pathExclude: /(server|main|bootstrap)/i },
  { key: 'todo',    label: 'TODO / FIXME',                re: /\b(TODO|FIXME)\b/ },
  { key: 'nonnull', label: 'Non-null <code>!.</code>',    re: /[\w\)\]]!\./ },
];

export const DEFAULT_GLOBS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];
const DEFAULT_EXCLUDE = /(node_modules|\.spec\.|\.d\.ts$|\.test\.|dist\/|\.min\.)/;
const LARGE_FILE_LINES = 200;

/** Parse `git blame --line-porcelain` → array where index i = author email of output line i. */
function blameEmails(git, file) {
  const out = git(`blame --line-porcelain -w -- "${file}"`);
  if (!out) return [];
  const emails = [];
  let cur = 'unknown';
  for (const line of out.split('\n')) {
    if (line.startsWith('author-mail ')) cur = line.slice(12).replace(/[<>]/g, '').trim();
    else if (line[0] === '\t') emails.push(cur);
  }
  return emails;
}

/**
 * Scan the repo. Returns:
 *   { byEmail: { email: { any: n, console: n, ... , large: n } }, rules, files, largeFiles }
 * Only blames a file when it actually contains a hit (lazy + cached), so cost
 * scales with smells found, not repo size.
 */
export function scanCode(git, cwd, { rules = DEFAULT_RULES, globs = DEFAULT_GLOBS, onProgress, disabledRules = [], excludePaths = [] } = {}) {
  const pathExcluded = createPathMatcher(excludePaths);
  const activeRules = rules.filter((r) => !disabledRules.includes(r.key) && !disabledRules.includes(r.id));

  const listed = git(`ls-files -- ${globs.map((g) => `"${g}"`).join(' ')}`)
    .split('\n').filter(Boolean).filter((f) => !DEFAULT_EXCLUDE.test(f) && !pathExcluded(f));

  const byEmail = {};
  const bump = (email, key, n = 1) => {
    byEmail[email] ??= {};
    byEmail[email][key] = (byEmail[email][key] || 0) + n;
  };

  let scanned = 0, largeFiles = 0;
  for (const file of listed) {
    let content;
    try { content = readFileSync(join(cwd, file), 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    let blame = null; // lazily fetched on first hit in this file
    const ensureBlame = () => (blame ??= blameEmails(git, file));

    for (const rule of activeRules) {
      if (rule.pathInclude && !rule.pathInclude.test(file)) continue;
      if (rule.pathExclude && rule.pathExclude.test(file)) continue;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const prevLine = i > 0 ? lines[i - 1] : '';
        if (hasInlineSuppression(line, prevLine)) continue;
        if (rule.re.test(line)) {
          const em = ensureBlame()[i] || 'unknown';
          bump(em, rule.key);
        }
      }
    }

    // large-file smell → attributed to the file's majority-blame author
    if (lines.length > LARGE_FILE_LINES && !disabledRules.includes('large')) {
      largeFiles++;
      const em = ensureBlame();
      if (em.length) {
        const tally = {};
        for (const e of em) tally[e] = (tally[e] || 0) + 1;
        const owner = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
        bump(owner, 'large');
      }
    }

    scanned++;
    if (onProgress && scanned % 50 === 0) onProgress(scanned, listed.length);
  }

  const resultRules = disabledRules.includes('large')
    ? activeRules
    : [...activeRules, { key: 'large', label: `Files &gt; ${LARGE_FILE_LINES} lines` }];

  return { byEmail, rules: resultRules, files: listed.length, largeFiles };
}

/** Weighted score normalized by volume density → a Code grade. */
export function codeGradeFrom(counts = {}, linesAttributed = 0) {
  const w = {
    any: 2, console: 3, subs: 1, dom: 2, todo: 1, nonnull: 1, large: 2,
    // java
    sysout: 2, stacktrace: 1, emptycatch: 2, streq: 1,
    // dart
    print: 2, nullassert: 1, ignore: 1,
  };
  const score = Object.entries(counts).reduce((s, [k, n]) => s + (w[k] || 1) * n, 0);
  // Density per 1,000 lines (KLOC) with a 500-line smoothing denominator
  const density = (score / (Math.max(0, linesAttributed) + 500)) * 1000;
  const bands = [
    [1.5, 'A'],
    [3.5, 'A-'],
    [6.0, 'B+'],
    [10.0, 'B'],
    [15.0, 'B-'],
    [22.0, 'C+'],
    [30.0, 'C'],
    [40.0, 'C-'],
  ];
  let grade = 'D';
  for (const [max, g] of bands) {
    if (density <= max) { grade = g; break; }
  }
  return { grade, score, density };
}

/** Build a render-ready issueMatrix from scan results for the given authors. */
export function matrixFromScan(scan, authors, langLabel) {
  const cols = authors.filter((a) => !a.hideFromCards);
  return {
    note: `Auto-scanned from HEAD via <code>git blame</code> across ${scan.files}${langLabel ? ` ${langLabel}` : ''} source files. The number is always shown — color only reinforces magnitude.`,
    footnote: `Heuristic grep-level attribution — treat as a signal, not a verdict. Override any cell (or a whole grade) in the config.`,
    columns: cols.map((a) => a.short || a.name),
    rows: scan.rules.map((r) => ({
      label: r.label,
      values: cols.map((a) => String((scan.byEmail[a.email] || {})[r.key] || 0)),
    })),
  };
}
