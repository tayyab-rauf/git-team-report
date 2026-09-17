# Report Accuracy, Grading Normalization & Ignore System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate false positives (Firebase web API keys, sample credentials, blanket replay/upload/XSS hits), detect weak password encoders (MD5/SHA), normalize code grades by volume density, and support rule/path exclusions and grade hiding.

**Architecture:** Build a dedicated zero-dependency `src/ignore.mjs` helper for path pattern matching and inline comment detection. Refine security rules in `src/security.mjs` and `src/languages.mjs` with post-processing for Firebase keys and sample credentials. Update `src/scan.mjs` and `src/collect.mjs` for density-based code grading and rebalanced git grading. Plumb `excludePaths`, `.git-team-reportignore`, `disabledRules`, and `hideGrades` through `src/commands.mjs`, `bin/cli.mjs`, and `src/render.mjs`.

**Tech Stack:** Node.js (ESM, `node:test`, `node:assert`, `node:fs`, `node:path`, `node:child_process`). Zero runtime dependencies.

## Global Constraints
- `package.json` `dependencies` MUST stay `{}`.
- Node built-ins only (`node:fs`, `node:child_process`, `node:path`, `node:os`, `node:readline`, `node:test`, `node:assert`).
- CSP-safe HTML in `render.mjs` (inline styles/scripts, no external network requests).
- No AI attribution trailer in git commits; use the author's identity.

---

### Task 1: Path & Comment Ignore Engine (`src/ignore.mjs`)

**Files:**
- Create: `src/ignore.mjs`
- Create: `tests/ignore.test.mjs`

**Interfaces:**
- Produces:
  - `createPathMatcher(patterns: string[]): (filePath: string) => boolean`
  - `loadIgnoreFile(cwd: string, filename?: string): string[]`
  - `hasInlineSuppression(line: string, prevLine?: string): boolean`
  - `isSampleOrDocComment(line: string, file?: string): boolean`

- [ ] **Step 1: Write the failing tests in `tests/ignore.test.mjs`**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPathMatcher, hasInlineSuppression, isSampleOrDocComment } from '../src/ignore.mjs';

test('createPathMatcher matches glob wildcards and folder prefixes', () => {
  const matcher = createPathMatcher(['legacy/**', 'vendor/*', '*.min.js', '**/applicationContext-security.xml']);
  assert.equal(matcher('legacy/old/War.java'), true);
  assert.equal(matcher('vendor/bundle.js'), true);
  assert.equal(matcher('src/app/main.min.js'), true);
  assert.equal(matcher('src/main/resources/applicationContext-security.xml'), true);
  assert.equal(matcher('src/app/user.service.ts'), false);
});

test('hasInlineSuppression detects inline and previous-line comment directives', () => {
  assert.equal(hasInlineSuppression('const x = 1; // git-team-report-ignore'), true);
  assert.equal(hasInlineSuppression('<!-- git-team-report-ignore -->'), true);
  assert.equal(hasInlineSuppression('const y = 2;', '// git-team-report-disable-next-line'), true);
  assert.equal(hasInlineSuppression('const z = 3;'), false);
});

test('isSampleOrDocComment detects sample credentials in comments', () => {
  assert.equal(isSampleOrDocComment('    rod/koala'), true);
  assert.equal(isSampleOrDocComment('    <!-- Usernames/Passwords are rod/koala -->'), true);
  assert.equal(isSampleOrDocComment('password = "realSecret12345"'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ignore.test.mjs`  
Expected: FAIL ("Cannot find module '../src/ignore.mjs'")

- [ ] **Step 3: Implement `src/ignore.mjs`**

```javascript
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Convert simple glob pattern to RegExp */
function globToRegex(pattern) {
  let p = pattern.trim().replace(/\\/g, '/');
  if (!p) return null;
  // normalize leading ./
  if (p.startsWith('./')) p = p.slice(2);
  const reStr = p
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`(^|/)${reStr}($|/)`);
}

export function createPathMatcher(patterns = []) {
  const regexes = patterns.map(globToRegex).filter(Boolean);
  return (filePath) => {
    if (!filePath || !regexes.length) return false;
    const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    return regexes.some((re) => re.test(norm));
  };
}

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

export function isSampleOrDocComment(line = '', file = '') {
  const isComment = /^\s*(<!--|\/\*|\*|\/\/|#)/.test(line) || /-->|\*\//.test(line);
  return SAMPLE_CRED_PATTERNS.some((re) => re.test(line)) && (isComment || file.endsWith('.xml') || file.endsWith('.md'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ignore.test.mjs`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ignore.mjs tests/ignore.test.mjs
git commit -m "feat: add path and comment ignore engine"
```

---

### Task 2: Security Rule Refinements & Weak Password Encoder Detection

**Files:**
- Modify: `src/security.mjs`
- Modify: `src/languages.mjs`
- Create: `tests/security_rules.test.mjs`

**Interfaces:**
- Consumes: `createPathMatcher`, `hasInlineSuppression`, `isSampleOrDocComment` from `src/ignore.mjs`
- Produces: Updated `SECURITY_RULES`, `JAVA_SEC`, and `scanSecurity` with `disabledRules` filtering and Firebase / comment post-processing.

- [ ] **Step 1: Write the failing tests in `tests/security_rules.test.mjs`**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES } from '../src/languages.mjs';
import { SECURITY_RULES } from '../src/security.mjs';

test('Java security rules include weak password encoder / MD5 detection', () => {
  const javaSec = LANGUAGES.java.secRules;
  const weakHashRule = javaSec.find((r) => r.id === 'java-weak-hash');
  assert.ok(weakHashRule, 'java-weak-hash rule must exist');
  assert.equal(weakHashRule.severity, 'High');
  assert.ok(weakHashRule.re.test('<password-encoder hash="md5"/>'));
  assert.ok(weakHashRule.re.test('MessageDigest.getInstance("MD5")'));
  assert.ok(weakHashRule.re.test('new Md5PasswordEncoder()'));
});

test('XSS innerHTML rule does not flag Angular [innerHTML] binding', () => {
  const xssRule = SECURITY_RULES.find((r) => r.id === 'xss-innerhtml');
  assert.ok(xssRule, 'xss-innerhtml rule must exist');
  assert.equal(xssRule.re.test('<div [innerHTML]="trustedContent"></div>'), false);
  assert.equal(xssRule.re.test('element.innerHTML = userInput;'), true);
  assert.equal(xssRule.re.test('<div dangerouslySetInnerHTML={{ __html: x }}></div>'), true);
});

test('Replay rule does not blanket flag standard @PostMapping in Java', () => {
  const javaSec = LANGUAGES.java.secRules;
  const hasBlanket = javaSec.some((r) => r.id === 'java-mutation' && r.re.test('@PostMapping("/users")'));
  assert.equal(hasBlanket, false, 'Blanket @PostMapping mutation rule must be removed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security_rules.test.mjs`  
Expected: FAIL

- [ ] **Step 3: Update `src/security.mjs` and `src/languages.mjs`**
  - In `src/security.mjs`:
    - Refine `xss-innerhtml`: change regex to `/\.(innerHTML|outerHTML)\s*=|dangerouslySetInnerHTML|\bv-html\b/`.
    - Change `lpdos-file` severity to `'Low'`.
    - Refine `replay-mutation`: restrict `pathInclude` to `/(checkout|payment|charge|billing|transfer|payout|refund)/i`.
    - In `scanSecurity`:
      - Accept `disabledRules = []`, `excludePaths = []`.
      - Check inline suppression comments via `hasInlineSuppression`.
      - Check comment sample credentials via `isSampleOrDocComment`.
      - Post-process Firebase keys in `Secrets` findings (if `AIza[0-9A-Za-z-_]{35}` or `gcp-api-key` in web bundle or alongside `firebase`), downgrade severity to `'Low'` and update `fix`.
  - In `src/languages.mjs`:
    - Remove `java-mutation` blanket rule.
    - Change `java-upload` severity to `'Low'`.
    - Add `java-weak-hash` rule:
      ```javascript
      { id: 'java-weak-hash', vector: 'Secrets', severity: 'High', review: true,
        re: /<password-encoder\s+[^>]*hash=["'](md5|sha|plaintext|none)["']|<password-encoder\s+[^>]*base64=["']true["']|\b(NoOpPasswordEncoder|Md5PasswordEncoder|ShaPasswordEncoder)\b|MessageDigest\.getInstance\s*\(\s*["'](MD5|SHA-1|SHA1)["']\s*\)/,
        fix: 'Migrate to modern salted hashing (e.g. BCryptPasswordEncoder, Argon2PasswordEncoder) instead of legacy unsalted MD5/SHA.' },
      ```
    - In `dart-mutation`, restrict `pathInclude` to `/(checkout|payment|charge|billing|transfer|payout|refund)/i`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/security_rules.test.mjs`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/security.mjs src/languages.mjs tests/security_rules.test.mjs
git commit -m "feat: refine security rules, add weak password encoder detection, reduce false positives"
```

---

### Task 3: Volume-Normalized Code Grading & Rebalanced Git Grade

**Files:**
- Modify: `src/scan.mjs`
- Modify: `src/collect.mjs`
- Create: `tests/grading.test.mjs`

**Interfaces:**
- Consumes: `counts` and `linesAttributed` in `codeGradeFrom`
- Produces: Normalized Code Grade (`A` to `D`) and rebalanced `suggestGitGrade`.

- [ ] **Step 1: Write the failing tests in `tests/grading.test.mjs`**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { codeGradeFrom } from '../src/scan.mjs';
import { suggestGitGrade } from '../src/collect.mjs';

test('codeGradeFrom calculates density fairly for high-volume vs low-volume authors', () => {
  // Noor: 40,800 lines with 130 smells should not get a D
  const highVol = codeGradeFrom({ subs: 126, todo: 4 }, 40800);
  assert.ok(['A', 'A-', 'B+', 'B'].includes(highVol.grade), `Expected B or higher, got ${highVol.grade}`);

  // Small volume author: 50 lines with 0 smells gets A
  const cleanSmall = codeGradeFrom({}, 50);
  assert.equal(cleanSmall.grade, 'A');

  // Small volume author with 2 smells doesn't unfairly plunge to F/D
  const smallWith2 = codeGradeFrom({ subs: 2 }, 50);
  assert.ok(['A-', 'B+'].includes(smallWith2.grade), `Expected A- or B+, got ${smallWith2.grade}`);
});

test('suggestGitGrade does not assign D to high-commit authors without conventional commits', () => {
  // Author with 69 commits but low conventional commit % (3%)
  const grade = suggestGitGrade({ commits: 69, convPct: 3, miPct: 0 });
  assert.ok(['B-', 'B', 'B+'].includes(grade), `Expected B- range for high activity, got ${grade}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/grading.test.mjs`  
Expected: FAIL

- [ ] **Step 3: Update `src/scan.mjs` and `src/collect.mjs`**
  - In `src/scan.mjs`:
    - Update `codeGradeFrom(counts = {}, linesAttributed = 0)`:
      Calculate `score = Object.entries(counts).reduce((s, [k, n]) => s + (w[k] || 1) * n, 0);`
      Calculate `density = (score / (Math.max(0, linesAttributed) + 500)) * 1000;`
      Evaluate against density bands:
      `[[1.5, 'A'], [3.5, 'A-'], [6.0, 'B+'], [10.0, 'B'], [15.0, 'B-'], [22.0, 'C+'], [30.0, 'C'], [40.0, 'C-']]`
      Return `{ grade, score, density }`.
    - Also in `scanCode`: support `disabledRules` array and inline suppression check (`hasInlineSuppression`).
  - In `src/collect.mjs`:
    - Update `suggestGitGrade({ commits, convPct, miPct })`:
      `const baseScore = 20;`
      `const volumeScore = Math.min(commits / 30, 1) * 35;`
      `const convScore = (convPct / 100) * 25;`
      `const miScore = (miPct / 100) * 20;`
      `const score = baseScore + volumeScore + convScore + miScore;`
      Bands: `[[80, 'A'], [72, 'A-'], [66, 'B+'], [58, 'B'], [52, 'B-'], [46, 'C+'], [40, 'C'], [34, 'C-']]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/grading.test.mjs`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scan.mjs src/collect.mjs tests/grading.test.mjs
git commit -m "feat: normalize code grades by volume density and rebalance git grades"
```

---

### Task 4: CLI & Config Plumbing (Exclusions, Disabled Rules, Hide Grades)

**Files:**
- Modify: `src/commands.mjs`
- Modify: `src/render.mjs`
- Modify: `bin/cli.mjs`
- Modify: `src/collect.mjs`
- Create: `tests/config_plumbing.test.mjs`

**Interfaces:**
- Consumes: `createPathMatcher`, `loadIgnoreFile` from `src/ignore.mjs`
- Produces: CLI flags `--no-grades`, `--exclude`, config fields `excludePaths`, `disabledRules`, `hideGrades`.

- [ ] **Step 1: Write the failing tests in `tests/config_plumbing.test.mjs`**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/render.mjs';

test('renderReport hides grade badges when hideGrades is true', () => {
  const config = {
    meta: { heading: 'Test' },
    period: { start: '2026-01-01' },
    hideGrades: true,
    authors: [{ email: 'test@example.com', name: 'Test User', gitGrade: 'A', codeGrade: 'B' }],
    issueMatrix: null,
    members: {},
    actions: [],
  };
  const metrics = new Map([
    ['test@example.com', { commits: 10, convPct: 100, miPct: 100, added: 100, deleted: 10, months: {}, lastActive: '2026-01-02' }]
  ]);
  const html = renderReport(config, metrics, { repoName: 'test', throughDate: '2026-01-02' });
  assert.equal(html.includes('badge grade'), false, 'Grade badges should not be rendered when hideGrades is true');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config_plumbing.test.mjs`  
Expected: FAIL

- [ ] **Step 3: Update `src/commands.mjs`, `src/render.mjs`, `bin/cli.mjs`, and `src/collect.mjs`**
  - In `bin/cli.mjs`:
    - Add `--no-grades` (or `--hide-grades`) flag.
    - Add `--exclude <pattern>` (repeatable or comma-separated).
    - Pass these into `commands.build` and `commands.security`.
  - In `src/commands.mjs`:
    - Merge `config.excludePaths || []`, `.git-team-reportignore` file, and CLI `--exclude` into a single path matcher.
    - Merge `config.disabledRules || []`.
    - If `--no-grades` passed, set `config.hideGrades = true`.
    - Pass `pathMatcher` and `disabledRules` to `scanCode` and `scanSecurity`.
    - In `collect.mjs` `metricsFor`: filter lines from `git log --numstat` when the file path matches the exclusion matcher.
    - Pass `metrics.get(a.email).added` as `linesAttributed` into `codeGradeFrom(scanResult.byEmail[a.email], linesAttributed)`.
  - In `src/render.mjs`:
    - When `config.hideGrades` is true: omit rendering `.grade` badges on author cards and table headers.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config_plumbing.test.mjs`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands.mjs src/render.mjs bin/cli.mjs src/collect.mjs tests/config_plumbing.test.mjs
git commit -m "feat: plumb excludePaths, disabledRules, and hideGrades through CLI and render"
```

---

### Task 5: End-to-End Verification & Docs Update

**Files:**
- Create: `tests/e2e_synthetic.test.mjs`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `config/config.example.json`

- [ ] **Step 1: Write E2E test on synthetic repo**

Create a temporary git repository with:
- A Firebase config file (`environment.ts`) with `apiKey: 'AIzaSyTest123456789012345678901234567'`
- An XML file with `<!-- rod/koala -->` and `<password-encoder hash="md5"/>`
- An Angular template with `<div [innerHTML]="html"></div>`
- A vendored file in `legacy/Old.java` with 5,000 lines
- Run `git-team-report build` with `excludePaths: ["legacy/**"]`
- Assert:
  - Firebase key is downgraded to Low and marked `[Firebase/Web Client Key]`
  - Sample `rod/koala` comment is not flagged
  - `<password-encoder hash="md5"/>` is flagged as High severity
  - Angular `[innerHTML]` is not flagged as XSS
  - `legacy/Old.java` is excluded from scanned files and line volume counts.

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/e2e_synthetic.test.mjs`  
Expected: PASS

- [ ] **Step 3: Update documentation and example config**
  - Update `config/config.example.json` to showcase `excludePaths`, `disabledRules`, and `hideGrades`.
  - Update `AGENTS.md` to document the new precision rules, density grading, and ignore systems.
  - Update `README.md` with the new CLI flags and config options.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e_synthetic.test.mjs AGENTS.md README.md config/config.example.json
git commit -m "docs: update AGENTS.md, README, and config example for accuracy and ignore features"
```
