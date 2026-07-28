# git-team-report

Generate a graphical **team git & code-quality report** from any git repository — as a single self-contained HTML page.

The trick that keeps it cheap to maintain: **numbers are pulled live from git on every build** (commits, lines, conventional-commit %, ticket links, monthly cadence, last-active), while **grades and code findings live in a config file you edit**. Each build also prints only the **delta since the last build**, so refreshing is a glance, not a re-analysis.

![sections: overview cards · commit bars · activity heatmap · issue matrix · ship-blockers · per-member detail · action plan](examples/report.html)

## Install / run

Zero dependencies. Node ≥ 18.

```bash
# one-off, no install
npx git-team-report init
npx git-team-report build

# or install globally
npm i -g git-team-report
```

## Usage

```bash
# 1. inside your repo — scaffold a config from your git history
git-team-report init

# 2. edit git-team-report.config.json — fill in grades, domains, findings
#    (see config/config.example.json for a complete example)

# 3. build the report
git-team-report build
# → writes git-team-report.html and prints what changed since last time
```

Open `git-team-report.html` in a browser, or publish/serve it however you like — it's one file with inline CSS, theme-aware (light/dark), responsive, no external assets.

### Commands & flags

| | |
|---|---|
| `init` | Discover authors via `git shortlog` and write `git-team-report.config.json` |
| `build` | Pull live metrics, render the HTML, print the delta, save the footprint |
| `--cwd <path>` | Run against another repo (default: current dir) |
| `--config <file>` | Config path (default: `./git-team-report.config.json`) |
| `--out <file>` | Output HTML path (default: `./git-team-report.html`) |
| `--full` | Ignore the saved footprint; recompute from the period start |
| `--force` | (`init`) overwrite an existing config |

## How it splits work (why it's cheap)

| Auto (live from git, every build) | Editorial (config, changes rarely) |
|---|---|
| commits, lines +/−, conventional %, ticket links | Git & Code **grades** |
| monthly cadence, last-active date | code-quality **issue matrix** |
| ranking, activity heatmap, the delta | **ship-blockers**, per-member **findings**, **action plan** |

The footprint (`.git-team-report/state.json`) records the last compiled date and a
snapshot, so `build` shows only what moved. When `git-team-report` leaves a grade
blank, it prints a **git-grade hint** from a simple heuristic — a starting point,
not a verdict (grading stays a human call).

## Config shape

```jsonc
{
  "meta":   { "heading": "...", "callout": "<html>" },
  "period": { "start": "YYYY-MM-DD" },
  "authors": [
    { "email": "a@x.com", "name": "A B", "short": "a@",
      "domain": "what they own", "gitGrade": "B", "codeGrade": "A-",
      "highlight": true, "badge": { "kind": "up|tick|warn", "text": "..." } }
  ],
  "issueMatrix": { "columns": ["A","B"], "rows": [ { "label": "any types", "values": ["7","0"] } ] },
  "shipBlockers": [ { "id": "C1", "sev": "crit|high|med", "path": "file:line", "desc": "<html>", "owner": "A" } ],
  "members": { "a@x.com": { "headline": "...", "sections": [ { "h4": "...", "items": ["<html>"] } ], "note": "..." } },
  "actions": [ { "tier": "t1|t2|t3|t0", "title": "...", "items": [ { "text": "<html>", "owner": "A" } ] } ]
}
```

Author matching is by the `email` string (matched against git's author email/name).
`desc`/`text`/`items` accept inline HTML (e.g. `<code>`, `<b>`) — they are emitted as-is.

## Notes

- **All branches** are counted (`git log --all`); totals can exceed `main` when work lives on unmerged branches.
- Line counts include lockfiles/vendored files unless you filter them in git.
- Code-quality numbers (the issue matrix) are yours to supply — the tool doesn't run a blame audit for you; it renders and refreshes what you record.

## License

MIT
