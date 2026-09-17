/**
 * ignore.mjs — path exclusion matching and inline finding suppression.
 *
 * Supports:
 * - Glob wildcards (e.g. `legacy/**`, `vendor/*`, `*.min.js`, `** /secret.xml`)
 * - Loading .git-team-reportignore file
 * - Inline source code comment directives (`git-team-report-ignore`, `git-team-report-disable-line`, `git-team-report-disable-next-line`)
 * - Heuristics for skipping sample/documentation credentials in comment blocks
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Convert a glob pattern to RegExp */
function globToRegex(pattern) {
  let p = pattern.trim().replace(/\\/g, '/');
  if (!p) return null;
  if (p.startsWith('./')) p = p.slice(2);
  // Trailing slash e.g. "legacy/" matches directory prefix
  if (p.endsWith('/')) p = p + '**';

  const reStr = p
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`(^|/)${reStr}($|/)`);
}

/**
 * Given a list of glob/path patterns, returns a function that tests if a path matches.
 */
export function createPathMatcher(patterns = []) {
  const regexes = (Array.isArray(patterns) ? patterns : [patterns])
    .filter(Boolean)
    .map(globToRegex)
    .filter(Boolean);

  return (filePath) => {
    if (!filePath || !regexes.length) return false;
    const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    return regexes.some((re) => re.test(norm));
  };
}

/**
 * Load ignore patterns from .git-team-reportignore if present.
 */
export function loadIgnoreFile(cwd, filename = '.git-team-reportignore') {
  const p = join(cwd, filename);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Checks whether a line or its preceding line contains an inline suppression directive.
 */
export function hasInlineSuppression(line = '', prevLine = '') {
  const supRe = /\b(git-team-report-ignore|git-team-report-disable-line)\b/;
  const nextRe = /\bgit-team-report-disable-next-line\b/;
  return supRe.test(line) || nextRe.test(prevLine);
}

const SAMPLE_CRED_PATTERNS = [
  /rod\s*\/\s*koala/i,
  /dianne\s*\/\s*emu/i,
  /scott\s*\/\s*tiger/i,
  /\b(sample|example|dummy|placeholder)\b/i,
];

/**
 * Detects if a hit occurred inside sample/documentation text in a comment.
 */
export function isSampleOrDocComment(line = '', file = '') {
  const isExplicitSampleCred = /rod\s*\/\s*koala|dianne\s*\/\s*emu|scott\s*\/\s*tiger/i.test(line);
  if (isExplicitSampleCred) return true;
  const isComment = /^\s*(<!--|\/\*|\*|\/\/|#)/.test(line) || /-->|\*\//.test(line);
  return SAMPLE_CRED_PATTERNS.some((re) => re.test(line)) && (isComment || file.endsWith('.xml') || file.endsWith('.md'));
}
