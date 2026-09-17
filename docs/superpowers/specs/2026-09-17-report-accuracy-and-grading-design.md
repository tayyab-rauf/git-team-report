# Design Spec: Report Accuracy, Grading Normalization & Ignore System

**Date:** 2026-09-17  
**Status:** Approved by user, ready for implementation planning

---

## 1. Context & Motivation

Real-world usage on both frontend (Angular/TS) and backend (Java/Spring) codebases highlighted four critical pain points:
1. **Security false positives**:
   - Gitleaks/built-in secrets flagging public Firebase web config keys (`AIzaSy...`) with an urgent rotation warning.
   - Flagging sample credentials copied from documentation in comment blocks (e.g. `rod/koala` in Spring Security XML comments).
   - Flagging all standard REST write endpoints (`@PostMapping`, `http.put`/`delete`) under the "Replay" vector.
   - Flagging Angular's safe, sanitized template binding `[innerHTML]` as High-severity XSS.
   - Flagging standard file upload endpoints (`MultipartFile`, `type="file"`) as "LPDoS".
2. **Missed high-severity security issues**:
   - Missing legacy weak password encoders (e.g., `<password-encoder hash="md5"/>`, `<password-encoder hash="sha"/>`, `NoOpPasswordEncoder`, `Md5PasswordEncoder`).
3. **Volume-biased grading**:
   - Absolute smell count thresholds penalize high-output contributors (e.g. 40k lines receiving Code D while 50 lines receiving Code A).
   - Conventional-commit weighting in `suggestGitGrade` marks productive developers with Git D simply for not prefixing commit messages with `feat:`/`fix:`.
   - Lack of an option to disable/hide letter grades entirely.
4. **Lack of exclusions and ignore mechanisms**:
   - Vendored legacy imports (e.g. `legacy/` directory with +273k lines) get credited to the committer and skew team stats.
   - No way to disable specific noisy rules or suppress known safe lines inline.

---

## 2. Goals & Non-Goals

### Goals
- Maintain zero runtime dependencies (`package.json` dependencies remains `{}`).
- Reclassify Firebase web keys in frontend contexts to Low/Info with actionable guidance.
- Ignore sample credentials found in comment blocks.
- Add High-severity detection for weak password encoders and obsolete hash algorithms in Java and XML.
- Remove blanket write-endpoint matching from the Replay vector; restrict Replay to sensitive financial/billing operations.
- Remove Angular `[innerHTML]` template binding from the High XSS rule.
- Downgrade generic file upload to Low/review.
- Make code grading density-based (smells per KLOC) with a small-volume smoothing factor.
- Rebalance the git grade heuristic to reward sustained commit activity.
- Add `hideGrades: true` in config and `--no-grades` CLI flag to omit letter grades from HTML and stdout.
- Add support for `excludePaths` in config, `.git-team-reportignore` file, and inline suppression comments.
- Add support for `disabledRules` in config to turn off any rule by ID or key.

### Non-Goals
- Adding heavy AST parsing or external dependencies. Everything remains fast, regex-based, and zero-dep.
- Overriding gitleaks internals directly; rather, we post-process and filter gitleaks results.

---

## 3. Detailed Technical Design

### 3.1 Security Scanner Refinements (`src/security.mjs` & `src/languages.mjs`)

#### A. Firebase Web Key Post-Processing
In `security.mjs`, after collecting findings (both built-in and Gitleaks):
- Check each finding in the `Secrets` vector.
- If the snippet or matched rule matches GCP API key shape (`AIza[0-9A-Za-z-_]{35}`) or Gitleaks rule `gcp-api-key`:
  - Inspect the target file and context: if it is a client-side file (`.ts`, `.tsx`, `.js`, `.jsx`, `.html`, `.vue`, `environment*.ts`) or if the file contains `firebase` / `authDomain`:
    - Set `severity: 'Low'`.
    - Set `review: true`.
    - Update `snippet`: annotate with `[Firebase/Web Client Key]`.
    - Update `fix`: `"Firebase / client-side Google API keys are public project identifiers. Ensure HTTP referrer / package restrictions and Firebase Security Rules are enforced in Google Cloud Console; rotating is not required unless abused."`

#### B. Comment & Sample User Filtering
In `security.mjs` line scanner:
- Check if the matching line is inside a multi-line comment (`<!-- ... -->` or `/* ... */`) or a single-line comment (`//` or `#`).
- If it is in a comment and matches sample/documentation keywords (e.g. `rod/koala`, `dianne/emu`, `sample`, `example`, `dummy`, `test/test`), skip the finding.
- For Gitleaks findings: if the finding's file line corresponds to a comment block with sample keywords, filter it out.

#### C. Weak Password Encoders & Hashes Rule
Add a new rule to Java security rules (`JAVA_SEC` in `languages.mjs`) and generic security rules:
- **Rule ID**: `java-weak-hash`
- **Vector**: `Secrets` (or `Injection/XSS` / appropriate category)
- **Severity**: `High`
- **Regex**:
  - XML: `<password-encoder\s+[^>]*hash=["'](md5|sha|plaintext|none)["']|<password-encoder\s+[^>]*base64=["']true["']`
  - Java: `\b(NoOpPasswordEncoder|Md5PasswordEncoder|ShaPasswordEncoder)\b|MessageDigest\.getInstance\s*\(\s*["'](MD5|SHA-1|SHA1)["']\s*\)`
- **Fix**: `"Weak/unsalted hashing detected. Migrate to an adaptive password encoder (BCryptPasswordEncoder, Argon2PasswordEncoder, or PBKDF2) and avoid MD5/SHA-1 for password storage or integrity."`

#### D. Replay Vector Retargeting
- In `languages.mjs`: remove `java-mutation` (which matched `@(PostMapping|PutMapping|DeleteMapping)`).
- In `security.mjs`: update `replay-mutation`:
  - Narrow `re`: only match mutation methods on endpoints with payment/financial intent:
    `re: /\.(post|put|patch|delete)\s*\(/i`
    `pathInclude: /(checkout|payment|charge|billing|transfer|payout|refund)/i`
- In `languages.mjs`: update `dart-mutation`:
  - `pathInclude: /(checkout|payment|charge|billing|transfer|payout|refund)/i`

#### E. LPDoS File Upload Downgrade
- In `security.mjs`: rule `lpdos-file` severity changed from `Medium` to `Low`.
- In `languages.mjs`: rule `java-upload` severity changed from `Medium` to `Low`.
- Fix message clarifies that server-side configurations (`spring.servlet.multipart.max-file-size`) mitigate this when present.

#### F. Angular `[innerHTML]` vs XSS
- In `security.mjs`: update `xss-innerhtml`:
  - Remove `\[innerHTML\]` (Angular's template property binding, safely sanitized by DomSanitizer).
  - Keep: `\.(innerHTML|outerHTML)\s*=|dangerouslySetInnerHTML|\bv-html\b`.
  - Keep `xss-bypass` for `bypassSecurityTrust(Html|Url|ResourceUrl|Script|Style)\s*\(` as `High` severity.

---

### 3.2 Fair Grading & Omission Option (`src/scan.mjs`, `src/collect.mjs`, `src/render.mjs`)

#### A. Density-Based Code Grading (`codeGradeFrom`)
In `scan.mjs`:
```js
export function codeGradeFrom(counts = {}, linesAttributed = 0) {
  const w = {
    any: 2, console: 3, subs: 1, dom: 2, todo: 1, nonnull: 1, large: 2,
    sysout: 2, stacktrace: 1, emptycatch: 2, streq: 1,
    print: 2, nullassert: 1, ignore: 1,
  };
  const score = Object.entries(counts).reduce((s, [k, n]) => s + (w[k] || 1) * n, 0);
  // Density per 1,000 lines (KLOC) with a smoothing denominator
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
```
Lines attributed for an author is passed from `metrics.added` (or blamed line count).

#### B. Rebalanced Git Grade Heuristic (`suggestGitGrade`)
In `collect.mjs`:
```js
export function suggestGitGrade({ commits, convPct, miPct }) {
  const baseScore = 20;
  const volumeScore = Math.min(commits / 30, 1) * 35; // up to 35 pts for 30+ commits
  const convScore = (convPct / 100) * 25;             // up to 25 pts
  const miScore = (miPct / 100) * 20;                 // up to 20 pts
  const score = baseScore + volumeScore + convScore + miScore;

  const bands = [[80, 'A'], [72, 'A-'], [66, 'B+'], [58, 'B'], [52, 'B-'], [46, 'C+'], [40, 'C'], [34, 'C-']];
  for (const [min, g] of bands) if (score >= min) return g;
  return 'D';
}
```

#### C. Disabling / Hiding Letter Grades
- `git-team-report.config.json` supports `"hideGrades": true`.
- CLI supports `--no-grades` (or `--hide-grades`).
- In `render.mjs`: when `config.hideGrades` is true, omit the `.grade` badge pills in member cards and summary tables.

---

### 3.3 Exclusion & Ignore System (`src/commands.mjs`, `src/collect.mjs`, `src/scan.mjs`, `src/security.mjs`)

#### A. Path Exclusions
- Config property: `excludePaths: ["legacy/**", "vendor/**"]`.
- File: `.git-team-reportignore` (lines parsed as globs/patterns).
- Combined into a compiled matcher `isPathExcluded(filePath)`.
- Applied in:
  1. `collect.mjs`: `metricsFor(git, email, { excludePatterns })`: excludes diff lines from `git log --numstat` when path matches exclude pattern.
  2. `scan.mjs`: `scanCode`: skips files matching exclude patterns.
  3. `security.mjs`: `scanSecurity`: skips files matching exclude patterns, and filters out any Gitleaks/Semgrep findings whose file matches an exclude pattern.

#### B. Disabled Rules
- Config property: `disabledRules: ["java-mutation", "lpdos-file"]`.
- In `scanCode` and `scanSecurity`: skip rules matching any id in `disabledRules`. Filter any Semgrep/Gitleaks findings matching those rule IDs.

#### C. Inline Suppression Comments
- Support inline markers:
  - `git-team-report-ignore`
  - `git-team-report-disable-line`
  - `git-team-report-disable-next-line`
- In `scanCode` and `scanSecurity`: if the line (or previous line for next-line variant) contains these tokens, ignore hits on that line.

---

## 4. Verification Plan

1. **Unit / Integration Tests**:
   - Create a test script in a temporary git directory to verify:
     - Firebase `AIzaSy...` key downgraded to Low and annotated in web context.
     - Sample credentials in comments skipped.
     - Weak MD5 password encoder flagged as High in XML and Java.
     - Angular `[innerHTML]` not flagged as XSS.
     - `codeGradeFrom` gives fair grades to high-volume authors (e.g. 40k lines with 130 smells gets B+ instead of D).
     - Excluded paths (`legacy/**`) not counted in line stats or blamed.
     - `disabledRules` successfully suppresses matching findings.
     - `hideGrades: true` renders clean HTML without grade badges.
2. **Regression Testing**:
   - Test `bin/cli.mjs build` and `security` on the repository itself.
   - Run HTML DOM inspection (headless Chrome / text verification) to ensure no breakage in rendering or tabs.
