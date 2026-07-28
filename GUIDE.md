# Quick Guide — git-team-report

A 2-minute guide for anyone who wants to run the report on their repo.

## What it does

Point it at any git repo and it produces two things, entirely from your local git
history and source — **no server, no login, no data leaves your machine**:

1. **A team report** (`git-team-report.html`) — a single self-contained web page:
   commits/lines per author, monthly activity heatmap, an auto-scanned code-quality
   issue matrix (blame-attributed), and first-pass Git/Code grades.
2. **A security scan** (`security-scan.md`) — signals for 6 vulnerability vectors
   (ReDoS, secret leakage, injection/XSS, large-payload DoS, clipboard/pastejacking,
   replay), each with file:line, the snippet, a risk level, and a suggested fix.

## Prerequisites

- **Node.js 18+** (`node -v`)
- Run it **inside a git repo** (or point at one with `--cwd`)

## Run it (30 seconds, no install)

```bash
cd /path/to/your/repo

# team report  → git-team-report.html
npx github:tayyab-rauf/git-team-report build

# security scan → security-scan.md
npx github:tayyab-rauf/git-team-report security
```

Prefer installing?

```bash
npm i -g git-team-report      # if published to npm
# then just: git-team-report build   |   git-team-report security
```

Both commands work with **zero configuration** — authors, stats, the issue matrix,
and grades are all derived automatically.

## Where the report goes & how to open it

| Command | Output file | Open with |
|---------|-------------|-----------|
| `build` | `git-team-report.html` | double-click it, or `open git-team-report.html` (macOS) / `xdg-open` (Linux) / `start` (Windows) |
| `security` | `security-scan.md` | any Markdown viewer, or your editor / GitHub preview |

Each `build` also prints a short **delta** in the terminal — how many commits each
person added since the last run — so repeat runs are a glance, not a re-read.

## How to read the report

- **Team overview** — one card per author with **Git** and **Code** grade pills
  (A = green … D = red) and their commit/line stats.
- **Activity cadence** — commits per month; darker = busier. Spots who's stalled.
- **Issue matrix** — code smells (`any`, `console`, bare subscriptions, unguarded
  DOM, TODOs, non-null `!.`, large files), counted per author. The **number is
  always shown**; color just reinforces it.
- **Ship-blockers / Member detail / Action plan** — only appear if you add a config
  (see below); otherwise the report is stats + matrix + auto grades.

> **Grades marked `*` (and every auto matrix) are heuristic** — a fast first pass,
> not a verdict. In the **security** report, findings tagged **_(review)_** need a
> human to confirm exploitability (is the input user-controlled? length-bounded?
> sanitized downstream?). Vendored/minified code (`assets/`, bundles) is skipped.

## Optional: make the grades & findings yours

The auto output is a starting point. To hand-write grades, ship-blockers, per-member
notes, and prose:

```bash
npx github:tayyab-rauf/git-team-report init   # writes git-team-report.config.json
# edit that file (see config/config.example.json for a full example)
npx github:tayyab-rauf/git-team-report build  # now uses your config
```

Anything you set in the config **overrides** the auto values; anything you leave
blank stays auto. Git numbers always refresh live on every build.

## Housekeeping

The tool writes `git-team-report.html`, `security-scan.md`, and a small
`.git-team-report/` state folder into your repo. Add them to your `.gitignore` if
you don't want them committed:

```
git-team-report.html
security-scan.md
.git-team-report/
```

## Commands at a glance

| Command | What it does |
|---------|--------------|
| `build` | Team report → `git-team-report.html` (+ terminal delta) |
| `security` | 6-vector security scan → `security-scan.md` |
| `init` | Scaffold `git-team-report.config.json` from your git history |

Flags: `--cwd <path>` (target another repo) · `--out <file>` (change output path)
· `--no-scan` (build faster, git stats only) · `--full` (ignore the saved delta).
