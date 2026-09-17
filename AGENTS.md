# AGENTS.md — context for AI agents working on `git-team-report`

This file orients an AI coding agent (Claude Code, Cursor, etc.) to this project so it
can extend or debug it safely. Read it before editing. It reflects the code as of the
latest commit; if code and this file disagree, trust the code and update this file.

---

## 1. What this tool is

A **zero-dependency Node CLI** that generates a graphical **team git & code-quality
report** (plus a security scan) from any git repository, as a single self-contained
HTML file. Its guiding split:

- **Numbers are derived live from git on every run** — commits, lines, conventional-commit
  %, ticket links, monthly cadence, last-active, and (via `git blame`) per-line code
  attribution. These are free and deterministic; never hand-maintained.
- **Judgment lives in a config** — grades, hand-written findings, ship-blockers, prose.
  Optional: if absent, the tool runs "zero-config" and auto-derives everything.

Design values (preserve these):
1. **Zero runtime dependencies.** `package.json` `dependencies` MUST stay `{}`. Use only
   Node built-ins (`node:fs`, `node:child_process`, `node:path`, `node:os`, `node:readline`).
2. **Numbers = live git; judgment = config.** Don't bake team-specific data into code.
3. **Signals, not verdicts.** Scanners emit *candidates*; findings needing human judgment
   are flagged `review: true`. Never claim certainty grep can't support.
4. **Consent-first side effects.** Installing tools prompts (defaults to no), never in CI.
5. **Everything self-contained + CSP-safe** in the HTML output (inline CSS/JS, no external
   fetches) — the report is often published as a sandboxed artifact.

---

## 2. Repo layout

```
bin/cli.mjs        Arg parsing + command dispatch (init | build | security). Entry/bin.
src/
  collect.mjs      Live git metrics per author; git-grade heuristic; author discovery.
  scan.mjs         Code-quality smell scan (grep + git blame attribution); code-grade
                   heuristic (density-based); issue-matrix builder. Exports DEFAULT_RULES/DEFAULT_GLOBS (TS).
  security.mjs     6-vector security signal scan; built-in rules; gitleaks integration
                   (Secrets vector); SECURITY_GLOBS/SECRET_RULES exports; Markdown report.
  semgrep.mjs      Optional Semgrep (SAST) runner; maps results into vectors; blame attrib.
  languages.mjs    Per-language rule PACKS (typescript/java/flutter/generic) + auto-detect.
  ignore.mjs       Path exclusion matching (glob wildcards), .git-team-reportignore loader,
                   inline comment directives (git-team-report-ignore), and the shared
                   GENERATED_EXCLUDE / isMinified() used by BOTH scanners.
  tools.mjs        Detect + (with consent) install gitleaks/semgrep; interactive prompt.
  render.mjs       STYLE (GitHub-themed CSS) + renderReport(): the whole HTML page,
                   incl. the tabbed Security section.
  commands.mjs     Orchestration for init/build/security; footprint (delta) logic.
config/config.example.json   Filled-in example (real newwebinfo data) — the config schema.
report/…           (present in the origin repo's history; the live editorial layer example)
README.md          User docs.  GUIDE.md  Teammate quick-start.
```

Module dependency direction: `commands.mjs` → {collect, scan, security(→semgrep), languages(→scan,security), tools, render, ignore}. `languages.mjs` imports the TS defaults from scan/security to build the `typescript` pack — do NOT create a cycle back from scan/security into languages.

---

## 3. Data flow

**`build`** (`commands.build`, async):
1. Load config file if present, else `synthConfig(git)` (authors from `git shortlog`).
2. `resolvePack(git, lang || config.language)` → language pack. Auto mode merges every
   detected language's pack **plus `generic`** (`mergePacks`); each pack's rules are
   scoped to its own globs so they can't cross-fire. `--lang`/`config.language` forces one.
3. Load ignore patterns from config `excludePaths`, `.git-team-reportignore`, and `--exclude`.
4. Per author: `metricsFor(git, email, { excludePatterns, since })` → commits/lines/conv/mi/
   cadence/lastActive. `since` = `config.period.start`, so the header's window is the
   window the numbers describe. Authors in git but absent from the config are printed as a
   warning (they'd otherwise vanish from the report entirely).
5. If `scan`: `scanCode(git, cwd, {rules: pack.codeRules, globs: pack.codeGlobs, disabledRules, excludePaths})` →
   blame-attributed smell counts + `linesByEmail` (lines each author owns at HEAD) →
   `matrixFromScan` (only if config has no issueMatrix).
6. Fill blank grades: git via `suggestGitGrade`, code via `codeGradeFrom(counts, scan.linesByEmail[email])`
   — density per line **owned**, not per line ever added, so lockfiles and churn can't
   launder a grade (density-based, marked auto `*`).
7. If `doSecurity`: `ensureTool('gitleaks')` (+ `ensureTool('semgrep')` if `--semgrep`),
   then `scanSecurity(..., {disabledRules, excludePaths})`. Post-processes Firebase web keys to Low and filters sample comments.
8. `renderReport(config, metrics, {repoName, throughDate, security})` → write HTML (honors `hideGrades`).
9. Write footprint `.git-team-report/state.json`; print the delta since last compile.

**`security`** = steps 2 + 7 + `securityMarkdown` → `security-scan.md`.

**Footprint / incremental delta:** `state.json` stores `compiledDate` + a per-author
snapshot. Each run recomputes numbers fully (git is fast) but prints only what changed
since `compiledDate` — that's the token/time saver, not a correctness mechanism.

---

## 4. Commands & flags (see `bin/cli.mjs`)

- `init` — scaffold `git-team-report.config.json` from discovered authors.
- `build` — team + code-quality + security → `git-team-report.html`.
- `security` — 6-vector scan → `security-scan.md`.
- Flags: `--cwd`, `--config`, `--out`, `--full` (ignore footprint), `--no-scan`,
  `--no-security`, `--no-grades`, `--exclude <pattern>`, `--disable-rule <id>`,
  `--lang <typescript|java|flutter|generic>`, `--no-gitleaks`,
  `--semgrep`, `--install-tools` (auto-yes), `--no-prompt`.

---

## 5. Config schema (the editorial layer)

See `config/config.example.json`. Keys: `meta{title,heading,sidebarTitle,callout}`,
`period.start`, `language`, `excludePaths[]`, `disabledRules[]`, `hideGrades: boolean`,
`authors[{email,name,short,domain,gitGrade,codeGrade,highlight,badge{kind:up|tick|warn,text},hideFromCards}]`,
`issueMatrix{columns,rows,note,footnote}`, `shipBlockers[{id,sev:crit|high|med,path,desc,owner}]`,
`members{<email>:{headline,note,sections[{h4,items[]}]}}`, `actions[{tier:t1|t2|t3|t0,
title,items[{text,owner}]}]`. Author match is by `email` substring against git.
`desc/text/items` accept inline HTML (emitted as-is; escape untrusted input).

---

## 6. Language packs (`languages.mjs`)

Each pack = `{ id,label,detect,codeGlobs,codeRules,secGlobs,secRules }`. Auto-detected by
counting tracked files per extension (`ts/tsx`→typescript, `java`→java, `dart`→flutter,
else generic). Override via `--lang` or `config.language`.

**To add a language:** add a pack to `LANGUAGES`, add its extension→id to `EXT_LANG`,
define code rules (`{key,label,re,pathInclude?,pathExclude?}`) and security rules
(`{id,vector,severity,re,fix,review?,pathInclude?,pathExclude?}` where vector ∈ the six),
and add weights for its code-rule `key`s in `scan.js codeGradeFrom`. Reuse `SECRET_RULES`
for secrets and spread `CONFIG_GLOBS` into `secGlobs` (env/config/IaC files carry secrets
in every language). Keep regexes conservative (grep-level; false positives erode trust).

Rules run per-line only on files matched by the pack's globs, so language rules don't
cross-contaminate. `mergePacks` preserves that by rewriting each rule's `pathInclude` to
a matcher over its own pack's globs (`pathInclude` is only ever consumed as `.test(file)`,
so a `{test}` object is a valid one); same-key rules across packs are merged into one row
with an OR'd scope.

---

## 7. Optional external engines

- **gitleaks** (Secrets vector): auto-used if on PATH (`security.mjs runGitleaks`). Scans
  full git history, `--redact`, maps commit author. It **augments** the built-in rules —
  never assign over `byVector.Secrets`, that silently dropped `java-weak-hash` and
  `secret-nonpublic-env`. Same-`file:line` duplicates are dropped. `--no-gitleaks` forces
  built-ins only. NOTE: gitleaks reports **per-commit occurrences**, so a
  long-lived secret shows many times — counts look inflated. A dedupe-by-rule+file option
  is a known TODO.
- **Semgrep** (SAST): **opt-in** `--semgrep` (heavier, fetches rule packs). `semgrep.mjs`
  runs it, maps findings into vectors (+ catch-all `SAST (other)`), blame-attributes.
  Config via `$GTR_SEMGREP_CONFIG` (default `p/security-audit`). Strong for Java; weak/
  experimental for Dart.
- **tools.mjs**: when a wanted engine is missing, offers to install it (brew/pipx/pip/go),
  default **no**, never installs in non-interactive/CI (prints the command instead).
  `--install-tools` = auto-yes; `--no-prompt` = suppress.

Findings carry `source: 'built-in' | 'gitleaks' | 'semgrep'`; the HTML Security section is
**tabbed by source** (All / Built-in / gitleaks / Semgrep). A tab exists for each engine
that *ran* (found-nothing → "clean").

---

## 8. Rendering & the Security tabs (IMPORTANT gotcha)

`render.mjs` builds one self-contained HTML page. The Security tabs use **inline JS**
(a `DOMContentLoaded`/`readyState`-guarded toggle querying `.tabs`). We tried a pure-CSS
`:checked ~ sibling` tab hack first — it rendered **blank panels** in some browsers, so it
was replaced. Do NOT revert to the CSS-only approach. If you touch the tabs, **re-verify
in a real browser** (headless Chrome, auto-click a tab, assert the target `.tabpanel`
gains `.active`) — this was regression-tested that way.

Theme: GitHub-style tokens, light/dark via `prefers-color-scheme` + `:root[data-theme]`.
Charts (commit bars, month heatmap, issue matrix) are single-hue/sequential with numbers
always shown — never color-only encoding. Keep it CSP-safe: inline everything, no CDNs.

---

## 9. Testing conventions (no test framework — zero-dep)

- **Language detection/rules:** create a throwaway git repo in a temp dir, add files with
  known smells, run the CLI, assert counts/labels.
- **gitleaks/semgrep integration:** stub a fake binary on `PATH` that answers `version`
  and writes a known JSON report to `--report-path`/`-o`; assert mapping + attribution.
- **Tabs / any DOM behavior:** headless Chrome (`--headless=new --dump-dom
  --virtual-time-budget=…`), inject an auto-click, assert resulting classes.
- Always sanity-grep generated HTML for `undefined`, `NaN`, `${` (note: real code snippets
  legitimately contain `${…}` — those are escaped text, not template bugs).

---

## 10. Known issues / TODO

- **npm publish readiness.** `package.json` now includes `author`, `repository`, `homepage`, and `bugs` metadata. Publishing to the npm registry (`npx git-team-report`) is ready so users can run `npx git-team-report` directly instead of `npx github:tayyab-rauf/git-team-report`.
- **Windows + spaced username:** `npx github:…` can fail with `EPERM … mkdir 'C:\Users\M'` (path truncated at a space in the npm/npx layer — NOT this tool's code). Workarounds: clone + `node bin/cli.mjs`, `npm config set cache C:\npm-cache`, or publish to npm registry.
- **gitleaks per-commit dedupe** implemented in `src/security.mjs` by unique finding signature `(RuleID:File:StartLine:Match)`.
- **Semgrep Dart support** is weak.
- **Grades are heuristic** first-passes; the config is meant to override them.
- `period.start` past ~2038 silently fails git's date parser, so the window is dropped.
- Vendored/generated code (`/assets/`, `vendor/`, `.bundle.`, minified) is excluded from
  **both** scanners via `ignore.mjs GENERATED_EXCLUDE` + `isMinified()`. It used to be
  security-only, so a minified charting bundle scored hundreds of code smells against
  whoever committed it (real case: 102 `console.*` where the source had 7). If you add a
  scanner, use that list — don't write a second one.
- Merged packs scan every language, but `detectLanguage` only *counts* ts/java/dart —
  a Python-only repo resolves to `generic` (TODO + secrets), which is by design.

---

## 11. Guardrails for agents

- Keep `dependencies` empty. No TypeScript, no build step — plain ESM `.mjs`, Node ≥18.
- Don't hardcode any team's people/data into `src/` — that belongs in a config.
- Don't print raw secrets; keep gitleaks `--redact` and secret-rule snippets non-revealing.
- Preserve the consent-first install behavior; never auto-install without `--install-tools`
  or an interactive yes.
- After changing rendering/tabs, verify in a real browser before committing.
- This is the author's own tool published under their GitHub; commits use their identity
  and **no AI-attribution trailer**.
