/**
 * commands.mjs — the two things the CLI does: `init` (scaffold a config for the
 * current repo) and `build` (pull live git data, render, print the delta).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, dirname, resolve } from 'node:path';
import {
  makeGit, dataThroughDate, firstCommitDate, discoverAuthors,
  metricsFor, commitsSince, suggestGitGrade,
} from './collect.mjs';
import { scanCode, matrixFromScan, codeGradeFrom } from './scan.mjs';
import { scanSecurity, securityMarkdown } from './security.mjs';
import { renderReport } from './render.mjs';

const CONFIG_NAME = 'git-team-report.config.json';
const STATE_DIR = '.git-team-report';
const OUT_NAME = 'git-team-report.html';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const repoNameOf = (git, cwd) => {
  const url = git('config --get remote.origin.url');
  if (url) return basename(url.replace(/\.git$/, ''));
  return basename(resolve(cwd));
};
const ensureRepo = (git) => {
  if (git('rev-parse --is-inside-work-tree') !== 'true') {
    throw new Error('Not a git repository. Run this inside a repo (or pass --cwd <path>).');
  }
};

export function init({ cwd, force }) {
  const git = makeGit(cwd);
  ensureRepo(git);
  const target = join(cwd, CONFIG_NAME);
  if (existsSync(target) && !force) {
    console.log(`  ${CONFIG_NAME} already exists. Use --force to overwrite.`);
    return;
  }
  const discovered = discoverAuthors(git);
  const config = {
    meta: {
      sidebarTitle: 'Team Quality Report',
      heading: 'Team Git & Code Quality Report',
      callout: 'Git numbers are pulled live by <code>git-team-report</code>; grades &amp; findings come from the config file.',
    },
    period: { start: firstCommitDate(git) },
    authors: discovered.map((a) => ({
      email: a.email,
      name: a.name,
      short: a.email,
      domain: '',
      gitGrade: '',
      codeGrade: '',
    })),
    issueMatrix: { columns: [], rows: [], note: '', footnote: '' },
    shipBlockers: [],
    members: {},
    actions: [],
  };
  writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
  console.log(`\n  Wrote ${CONFIG_NAME} with ${discovered.length} authors discovered from git history.`);
  console.log(`  Next: fill in grades / domains / findings, then run:  git-team-report build`);
  console.log(`  See the shipped config/config.example.json for a fully filled-in example.\n`);
}

export function security({ cwd, outPath }) {
  const git = makeGit(cwd);
  ensureRepo(git);
  const repoName = repoNameOf(git, cwd);
  const date = dataThroughDate(git);
  console.log(`  Scanning for security signals…`);
  const result = scanSecurity(git, cwd, { onProgress: (n, t) => process.stdout.write(`\r    ${n}/${t} files`) });
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  const md = securityMarkdown(result, { repoName, date });
  const out = outPath ? resolve(outPath) : join(cwd, 'security-scan.md');
  writeFileSync(out, md);

  const all = Object.values(result.byVector).flat();
  const c = { High: 0, Medium: 0, Low: 0 };
  for (const f of all) c[f.severity]++;
  console.log(`\n  Security scan → ${out}`);
  console.log(`  ${result.files} files · ${all.length} signals · ${c.High} High · ${c.Medium} Medium · ${c.Low} Low\n`);
  for (const [vector, hits] of Object.entries(result.byVector)) {
    console.log(`    ${vector.padEnd(16)} ${hits.length ? hits.length + ' signal(s)' : 'No issues detected'}`);
  }
  console.log(`\n  Items marked (review) in the report need a human to confirm exploitability.\n`);
}

/** Build a zero-config config from git history alone (no config file present). */
function synthConfig(git) {
  return {
    meta: {
      sidebarTitle: 'Team Quality Report',
      heading: 'Team Git & Code Quality Report',
      callout: 'Zero-config report — authors, git stats, and the code-issue matrix are all derived live from the repo. Add a <code>git-team-report.config.json</code> to set grades, findings, and ship-blockers by hand.',
    },
    period: { start: firstCommitDate(git) },
    authors: discoverAuthors(git).map((a) => ({
      email: a.email, name: a.name, short: a.name.split(' ')[0], domain: '', gitGrade: '', codeGrade: '',
    })),
    issueMatrix: null, members: {}, actions: [],
  };
}

export function build({ cwd, configPath, outPath, full, scan = true }) {
  const git = makeGit(cwd);
  ensureRepo(git);

  const cfgFile = configPath ? resolve(configPath) : join(cwd, CONFIG_NAME);
  const hasConfig = existsSync(cfgFile);
  const config = hasConfig ? readJson(cfgFile) : synthConfig(git);
  if (!hasConfig) console.log(`\n  No config found — running zero-config (authors + issue matrix auto-derived).`);
  const repoName = repoNameOf(git, cwd);
  const throughDate = dataThroughDate(git);

  const stateFile = join(cwd, STATE_DIR, 'state.json');
  const prev = !full && existsSync(stateFile) ? readJson(stateFile) : null;
  const lastDate = prev?.compiledDate || config.period?.start || firstCommitDate(git);

  // collect git metrics
  const metrics = new Map();
  for (const a of config.authors) metrics.set(a.email, metricsFor(git, a.email));

  // auto code-quality scan (blame-attributed) unless disabled
  let scanResult = null;
  if (scan) {
    console.log(`  Scanning source for code smells (git blame attribution)…`);
    scanResult = scanCode(git, cwd, { onProgress: (n, t) => process.stdout.write(`\r    blamed ${n}/${t} files`) });
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
  }

  // fill grades/matrix that the config didn't specify; remember which were auto
  const cardAuthors = config.authors.filter((a) => !a.hideFromCards && metrics.get(a.email).commits > 0);
  const autoGrade = {};
  for (const a of config.authors) {
    autoGrade[a.email] = { git: !a.gitGrade, code: !a.codeGrade && !!scanResult };
    if (!a.gitGrade) a.gitGrade = suggestGitGrade(metrics.get(a.email));
    if (!a.codeGrade && scanResult) a.codeGrade = codeGradeFrom(scanResult.byEmail[a.email]).grade;
  }
  if (scanResult && (!config.issueMatrix || !config.issueMatrix.rows?.length)) {
    config.issueMatrix = matrixFromScan(scanResult, cardAuthors);
  }

  // render
  const html = renderReport(config, metrics, { repoName, throughDate });
  const out = outPath ? resolve(outPath) : join(cwd, OUT_NAME);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);

  // footprint + delta
  const active = config.authors.map((a) => ({ a, m: metrics.get(a.email) })).filter((x) => x.m.commits > 0);
  const snapshot = Object.fromEntries(active.map(({ a, m }) => [a.email, { commits: m.commits, added: m.added, deleted: m.deleted, lastActive: m.lastActive }]));
  mkdirSync(join(cwd, STATE_DIR), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ compiledDate: throughDate, previousCompiledDate: lastDate, snapshot }, null, 2) + '\n');

  // report to stdout
  console.log(`\n  Report written → ${out}`);
  console.log(`  Footprint: last compiled ${lastDate}  →  now ${throughDate}\n`);
  console.log(`  Delta since ${lastDate}:`);
  const rows = active.map(({ a, m }) => ({
    name: a.name,
    commits: m.commits,
    since: commitsSince(git, a.email, lastDate),
    vsSnap: prev?.snapshot?.[a.email]?.commits != null ? m.commits - prev.snapshot[a.email].commits : null,
    grades: `${a.gitGrade}${autoGrade[a.email]?.git ? '*' : ''}/${a.codeGrade || '—'}${autoGrade[a.email]?.code ? '*' : ''}`,
  })).sort((x, y) => y.since - x.since);
  for (const r of rows) {
    const vs = r.vsSnap != null ? `  (+${r.vsSnap} vs last build)` : '';
    console.log(`    ${r.name.padEnd(20)} ${String(r.commits).padStart(5)} total   ${(r.since > 0 ? '+' + r.since + ' new' : 'no new').padEnd(10)}  Git/Code ${r.grades}${vs}`);
  }
  if (scanResult) console.log(`\n  Scanned ${scanResult.files} source files · ${scanResult.largeFiles} over 200 lines.`);
  console.log(`  Grades marked * are auto-derived (git heuristic / blame scan) — set them in a config to override.`);
  console.log('');
}
