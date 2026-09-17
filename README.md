# git-team-report

Generate a graphical **team git & code-quality report** from any git repository — as a single self-contained HTML page.

**Works with zero config.** Point it at any repo and it auto-discovers authors, pulls live git stats, and **scans the code for quality issues** (`any` types, `console.*`, bare subscriptions, unguarded DOM, TODO/FIXME, non-null assertions, oversized files) — attributing each hit to an author with `git blame`. It even derives first-pass **grades**. A config is *optional*: add one only to override grades or add hand-written findings, ship-blockers, and prose. Each build prints only the **delta since the last build**, so refreshing is a glance, not a re-analysis.

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

### Security signal scan

```bash
git-team-report security            # writes security-scan.md
```

Greps for signals of **six vulnerability vectors** and reports each with a
`file:line`, the snippet, a risk level, a recommended fix, and the **developer who
wrote the line** (via `git blame`) plus an owner tally per group:

1. **ReDoS** — nested-quantifier regexes, dynamic `new RegExp`
2. **Secrets** — hardcoded keys/tokens, private-key blocks, AWS IDs, non-public env vars reaching the client
3. **Injection/XSS** — `bypassSecurityTrust*`, `innerHTML`/`v-html`/`dangerouslySetInnerHTML`, `eval`, NoSQL operators
4. **LPDoS** — file inputs / `FileReader` without size bounds
5. **Clipboard** — `navigator.clipboard` / paste handlers (pastejacking)
6. **Replay** — sensitive `POST/PUT/DELETE` mutations lacking idempotency keys

In the HTML report the Security section is **tabbed by engine** — *All*, *Built-in*,
*gitleaks*, *Semgrep* — so you can look at each source's findings separately (an engine
that ran but found nothing shows as "clean"). Tabs are pure CSS (no JS).

> These are **signals, not confirmed vulnerabilities.** Grep finds the sink; it can't
> tell if the input is attacker-controlled, length-bounded, or sanitized downstream.
> Findings that need that judgment are marked _(review)_.

**Secrets use [gitleaks](https://github.com/gitleaks/gitleaks) when available.** If the
`gitleaks` binary is on `PATH`, it *augments* the Secrets vector — 150+ curated rules,
entropy detection, and a scan of the **full git history** (catches secrets in old
commits, not just the working tree), with the introducing commit's author. The built-in
rules keep running alongside it, since they catch things gitleaks does not (weak password
encoders, private env vars reaching the browser bundle); findings on the same line are
deduplicated. Runs with `--redact`, so raw secrets never enter the report. No gitleaks
installed → built-in patterns only (working tree). Force that with `--no-gitleaks`. The
report states which engines ran.

**Secrets are hunted outside source too.** Every pack also scans `.env*`, `.json`,
`.yml`/`.yaml`, `.properties`, `.ini`/`.cfg`/`.conf`, `.toml`, `.xml`, `.sh`, `.tf` and
`Dockerfile*` — quoted (`API_KEY="…"`) and unquoted (`API_KEY=…`) forms both. References
like `$VAR` and `${{ secrets.X }}` are not flagged.

**Deeper SAST via [Semgrep](https://semgrep.dev) — opt-in.** Pass `--semgrep` and, if the
`semgrep` binary is installed, its findings are mapped into the report's vectors
(injection/XSS, ReDoS, …) with a catch-all **SAST (other)** group, each blame-attributed.
Off by default because Semgrep is heavier and fetches rule packs on first run; set the
rule set with `$GTR_SEMGREP_CONFIG` (default `p/security-audit`). Not installed → the
flag is a graceful no-op and the built-in heuristics stand.

**Missing tool? It offers to install.** When gitleaks (or semgrep, with `--semgrep`)
isn't found, an **interactive** run asks whether to install it for a stronger scan and,
on _yes_, runs the right command for your machine (brew / pipx / pip / go) then scans.
Consent-first: the prompt **defaults to no**, non-interactive/CI runs never install (they
just print the command), and any failure falls back to the built-in scan. Skip the
question with `--no-prompt`; auto-install without asking (e.g. in a script) with
`--install-tools`.

### Language packs

**Both scanners skip code you didn't write.** `node_modules`, `dist/`, `build/`,
`coverage/`, `vendor/`, `assets/`, `.bundle.`/`.min.` files, source maps, lockfiles and
anything with a line over 2,000 characters (i.e. minified) are excluded before blame runs
— otherwise a vendored bundle scores hundreds of "smells" against whoever committed it.
`console.*` is also not counted under `scripts/` or `tools/`, where printing is the point.
Anything else project-specific belongs in `excludePaths` or `.git-team-reportignore`.

The code-quality and security scanners are **language-aware**. On each run the tool
detects *every* language present in the repo and merges their packs, so a polyglot repo
is fully scanned rather than only its dominant language — each pack's rules stay scoped
to that pack's files, so Java rules never fire inside `.ts`. The `generic` pack is always
included, which is what covers Python/Go/Ruby/… files and the config files above. Force a
single pack with `--lang`.

| Pack (`--lang`) | Detected by | Code-quality rules | Security rules |
|---|---|---|---|
| `typescript` (default) | `.ts` / `.tsx` | `any`, `console`, bare `subscribe`, unguarded DOM, non-null `!.`, TODO, large files, missing `OnPush`, nested `subscribe`, `@ts-ignore`, deep relative imports, constructor DI, empty catch | XSS/`bypassSecurityTrust`/`innerHTML`, NoSQL ops, ReDoS, clipboard, LPDoS, replay, secrets |
| `html` | `.html` / `.vue` | `<img>` without alt, `<button>` without type, legacy `*ngIf`/`*ngFor`, TODO | secrets, XSS |
| `java` | `.java` | `System.out/err`, `printStackTrace`, empty catch, `==` on strings, TODO, large files | SQL-concat, `Runtime.exec`/`ProcessBuilder`, unsafe deserialization, `MultipartFile`, mutation mappings, secrets |
| `flutter` | `.dart` | `print()`, null-assertion `!`, `// ignore:`, TODO, large files | `innerHtml`, `Clipboard`, mutation calls, secrets |
| `generic` | anything else | TODO, large files | secret patterns |

- **Git stats, grades, activity, authors** are language-agnostic — they work everywhere.
- **gitleaks** (secrets) and **Semgrep** (SAST, incl. strong Java rules) work across
  languages regardless of the pack, and layer on top when installed.
- The report states which pack was used; `git-team-report build --lang java` forces it,
  or set `"language": "java"` in the config.

### Commands & flags

| | |
|---|---|
| `init` | Discover authors via `git shortlog` and write `git-team-report.config.json` |
| `build` | Pull live metrics, auto-scan code quality, render the HTML, print the delta |
| `security` | Scan the 6 vulnerability vectors → structured Markdown report |
| `--no-scan` | (`build`) skip the code-quality blame scan (git stats only) |
| `--no-security` | (`build`) skip the security scan section in the HTML report |
| `--no-grades` | omit letter grade badges from the report (cards & tables) |
| `--exclude <pattern>` | exclude paths from line stats & scans (e.g. `legacy/**`, `vendor/**`) |
| `--disable-rule <id>` | disable a specific smell or security rule (e.g. `lpdos-file`) |
| `--lang <id>` | force a language pack: `typescript` / `java` / `flutter` / `generic` |
| `--no-gitleaks` | force built-in secret patterns even if gitleaks is installed |
| `--semgrep` | also run Semgrep SAST (needs semgrep installed; slower) |
| `--cwd <path>` | Run against another repo (default: current dir) |
| `--config <file>` | Config path (default: `./git-team-report.config.json`) |
| `--out <file>` | Output HTML path (default: `./git-team-report.html`) |
| `--full` | Ignore the saved footprint; recompute from the period start |
| `--force` | (`init`) overwrite an existing config |

### Exclusions and Inline Suppression

- **Path exclusions**: Add `"excludePaths": ["legacy/**", "vendor/**"]` to `git-team-report.config.json`, or create a `.git-team-reportignore` file in your repository root.
- **Rule disabling**: Add `"disabledRules": ["java-mutation", "lpdos-file"]` to your config.
- **Inline suppression**: Add `// git-team-report-ignore` or `<!-- git-team-report-ignore -->` (or `git-team-report-disable-next-line`) to suppress findings on a specific line.

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
  "period": { "start": "YYYY-MM-DD" },   // bounds every git number in the report
  "excludePaths": ["legacy/**", "vendor/**"],
  "disabledRules": [],
  "hideGrades": false,
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
