/**
 * collect.mjs — live git metrics. No LLM, no network: just git, run against the
 * target repo. Every number in the report comes from here so a refresh never
 * requires re-deriving anything by hand.
 */
import { execSync } from 'node:child_process';

const CONV_RE = /^(feat|fix|refactor|chore|docs|style|test|perf|build|ci)(\(.+\))?:/;

export function makeGit(cwd) {
  return (args) => {
    try {
      return execSync(`git ${args}`, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
    } catch {
      return '';
    }
  };
}

/** Latest commit date across ALL branches — the report's "data-through" date. */
export function dataThroughDate(git) {
  return git(`log --all -1 --format=%ad --date=short`) || new Date().toISOString().slice(0, 10);
}

/** Earliest commit date across all branches — default period start. */
export function firstCommitDate(git) {
  const all = git(`log --all --format=%ad --date=short`).split('\n').filter(Boolean).sort();
  return all[0] || new Date().toISOString().slice(0, 10);
}

/** Discover authors from history: [{ name, email, commits }] sorted by volume, merged by email. */
export function discoverAuthors(git) {
  const raw = git(`shortlog -sne --all`)
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(.+?)\s+<(.+?)>$/))
    .filter(Boolean)
    .map((m) => ({ commits: parseInt(m[1], 10), name: m[2].trim(), email: m[3].trim().toLowerCase() }));

  const map = new Map();
  for (const entry of raw) {
    if (!map.has(entry.email)) {
      map.set(entry.email, { commits: entry.commits, name: entry.name, email: entry.email });
    } else {
      map.get(entry.email).commits += entry.commits;
    }
  }

  return Array.from(map.values()).sort((a, b) => b.commits - a.commits);
}

/** All git metrics for one author (matched by email/name substring). */
export function metricsFor(git, email) {
  const esc = String(email).replace(/"/g, '');
  const commits = parseInt(git(`rev-list --all --count --author="${esc}"`) || '0', 10);
  const subjects = git(`log --all --author="${esc}" --format=%s`).split('\n').filter(Boolean);
  const conv = subjects.filter((s) => CONV_RE.test(s)).length;
  const mi = subjects.filter((s) => /([A-Za-z]{2,}-\d+|#\d+)/.test(s)).length;

  let added = 0, deleted = 0;
  for (const line of git(`log --all --author="${esc}" --pretty=tformat: --numstat`).split('\n')) {
    const [a, d] = line.split('\t');
    if (a && a !== '-') added += parseInt(a, 10) || 0;
    if (d && d !== '-') deleted += parseInt(d, 10) || 0;
  }

  const months = {};
  for (const m of git(`log --all --author="${esc}" --format=%ad --date=format:%Y-%m`).split('\n').filter(Boolean)) {
    months[m] = (months[m] || 0) + 1;
  }

  const lastActive = git(`log --all --author="${esc}" --format=%ad --date=short -1`) || null;

  return {
    commits, conv, mi, added, deleted, months, lastActive,
    convPct: commits ? Math.round((conv / commits) * 100) : 0,
    miPct: commits ? Math.round((mi / commits) * 100) : 0,
  };
}

/** New commits by an author since a given date (the incremental "delta"). */
export function commitsSince(git, email, sinceDate) {
  const esc = String(email).replace(/"/g, '');
  return parseInt(git(`rev-list --all --count --author="${esc}" --since="${sinceDate} 00:00:00"`) || '0', 10);
}

/**
 * Optional heuristic that SUGGESTS a git grade when the config leaves it blank.
 * Grading is editorial — this is only a hint printed in the delta, never written
 * into the report on its own.
 */
export function suggestGitGrade({ commits, convPct, miPct }) {
  let score = 15 + (convPct / 100) * 40 + (miPct / 100) * 30 + Math.min(commits / 50, 1) * 15;
  const bands = [[80, 'A'], [72, 'A-'], [66, 'B+'], [58, 'B'], [52, 'B-'], [46, 'C+'], [40, 'C'], [34, 'C-']];
  for (const [min, g] of bands) if (score >= min) return g;
  return 'D';
}
