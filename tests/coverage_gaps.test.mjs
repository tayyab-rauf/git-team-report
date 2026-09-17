/**
 * Regression tests for the six monitoring gaps: things the scanners used to never
 * look at, or numbers they derived from the wrong denominator. Each test asserts
 * the *coverage*, not the exact count — rules will keep evolving.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { scanSecurity, SECURITY_GLOBS, CONFIG_GLOBS } from '../src/security.mjs';
import { scanCode, codeGradeFrom } from '../src/scan.mjs';
import { resolvePack, LANGUAGES, mergePacks } from '../src/languages.mjs';
import { metricsFor } from '../src/collect.mjs';
import { build } from '../src/commands.mjs';

/** Make a throwaway repo; `files` is { path: contents }, committed as `who`. */
function repo(files, who = ['Alice', 'alice@ex.com']) {
  const dir = mkdtempSync(join(tmpdir(), 'gtr-gaps-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync(`git config user.name "${who[0]}"`, { cwd: dir });
  execSync(`git config user.email "${who[1]}"`, { cwd: dir });
  commit(dir, files);
  return dir;
}
function commit(dir, files, msg = 'feat: x') {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  execSync('git add -A', { cwd: dir });
  execSync(`git commit -q -m "${msg}"`, { cwd: dir });
}
const git = (dir) => (cmd) => {
  try { return execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8' }).trim(); } catch { return ''; }
};

test('gap 1: gitleaks augments the Secrets vector instead of replacing it', () => {
  const dir = repo({ 'App.java': 'class A { Object e = new NoOpPasswordEncoder(); }\n' });
  try {
    const g = git(dir);
    const pack = LANGUAGES.java;
    const opts = { rules: pack.secRules, globs: pack.secGlobs };
    const off = scanSecurity(g, dir, { ...opts, gitleaks: false });
    const ids = (r) => (r.byVector['Secrets'] || []).map((f) => f.id);
    assert.ok(ids(off).includes('java-weak-hash'), 'built-in rule should fire with gitleaks off');

    // With gitleaks ON the built-in finding must survive. Skip if gitleaks is absent:
    // the merge is what we are testing, not the binary.
    let hasGitleaks = true;
    try { execSync('gitleaks version', { stdio: 'ignore' }); } catch { hasGitleaks = false; }
    if (!hasGitleaks) return;
    const on = scanSecurity(g, dir, { ...opts, gitleaks: true });
    assert.ok(ids(on).includes('java-weak-hash'), 'gitleaks must not delete built-in Secrets findings');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gap 2: secrets are scanned in env/config/deploy files, not just source', () => {
  const dir = repo({
    '.env': 'DB_PASSWORD="sup3rsecretvalue123456"\n',
    '.env.local': 'API_KEY=abcdef1234567890xyz\n',   // unquoted: the common env form
    'config.json': '{ "client_secret": "zzzzzzzzzzzzzzzzzzzzzz" }\n',
    'deploy.sh': 'export TOKEN="hunter2hunter2hunter2"\n',
    'src/app.ts': 'const a: any = 1;\n',
  });
  try {
    for (const g of ['*.env*', '*.json', '*.sh']) assert.ok(CONFIG_GLOBS.includes(g), `${g} should be scanned`);
    assert.ok(SECURITY_GLOBS.includes('*.env*'), 'default globs should include env files');
    const res = scanSecurity(git(dir), dir, { gitleaks: false });
    const files = new Set((res.byVector['Secrets'] || []).map((f) => f.file));
    for (const f of ['.env', '.env.local', 'config.json', 'deploy.sh']) {
      assert.ok(files.has(f), `secret in ${f} should be found`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gap 3: every language present is scanned, without cross-contamination', () => {
  const dir = repo({
    'src/app.ts': 'const a: any = 1;\nif (x == "y") {}\n',      // TS smell + a Java-rule lookalike
    'src/util.py': '# TODO: fix\npassword = "averylongpasswordvalue"\n',
    'Svc.java': 'class S { void f(){ System.out.println("x"); } }\n',
  });
  try {
    const g = git(dir);
    const { pack } = resolvePack(g);
    const code = scanCode(g, dir, { rules: pack.codeRules, globs: pack.codeGlobs });
    const mine = code.byEmail['alice@ex.com'] || {};
    assert.ok(code.files >= 3, `all three languages should be scanned, got ${code.files}`);
    assert.equal(mine.any, 1, 'TypeScript rules still fire');
    assert.equal(mine.sysout, 1, 'Java rules fire in the same run');
    assert.equal(mine.todo, 1, 'generic pack covers Python');
    assert.ok(!mine.streq, 'Java string-compare rule must not fire inside .ts');
    // one row per smell, not one per pack
    const keys = code.rules.map((r) => r.key);
    assert.equal(keys.length, new Set(keys).size, 'merged packs must not duplicate rule rows');

    const sec = scanSecurity(g, dir, { rules: pack.secRules, globs: pack.secGlobs, gitleaks: false });
    const files = new Set((sec.byVector['Secrets'] || []).map((f) => f.file));
    assert.ok(files.has('src/util.py'), 'Python secret should be found in a TS-dominant repo');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gap 3b: an explicit --lang stays a single pack', () => {
  const dir = repo({ 'a.ts': 'const a: any = 1;\n' });
  try {
    const { pack, source } = resolvePack(git(dir), 'java');
    assert.equal(source, 'explicit');
    assert.equal(pack.id, 'java');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gap 4: code grade uses lines owned at HEAD, so churn cannot launder it', () => {
  const dir = repo({ 'src/a.ts': Array.from({ length: 40 }, (_, i) => `const v${i}: any = ${i}; // TODO`).join('\n') + '\n' });
  try {
    const g = git(dir);
    // a huge committed lockfile must not change the grade — it is not owned source
    commit(dir, { 'package-lock.json': JSON.stringify({ pad: Array(20000).fill('x') }, null, 2) }, 'chore: lock');
    const scan = scanCode(g, dir);
    const owned = scan.linesByEmail['alice@ex.com'];
    const everAdded = metricsFor(g, 'alice@ex.com').added;
    assert.ok(owned > 0 && owned <= 45, `owned lines should be the source lines, got ${owned}`);
    assert.ok(everAdded > owned * 10, 'lines-ever-added is inflated by the lockfile — the old denominator');
    assert.notEqual(
      codeGradeFrom(scan.byEmail['alice@ex.com'], owned).grade,
      codeGradeFrom(scan.byEmail['alice@ex.com'], everAdded).grade,
      'the two denominators must disagree here, or this test proves nothing',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gap 5: authors missing from the config are reported, not silently dropped', async () => {
  const dir = repo({ 'a.ts': 'const a = 1;\n' });
  try {
    execSync('git config user.email "bob@ex.com"', { cwd: dir });
    execSync('git config user.name "Bob"', { cwd: dir });
    commit(dir, { 'b.ts': 'const b = 2;\n' }, 'feat: b');
    writeFileSync(join(dir, 'git-team-report.config.json'), JSON.stringify({
      period: { start: '2000-01-01' },
      authors: [{ email: 'alice@ex.com', name: 'Alice', short: 'Alice' }],
    }));
    const said = [];
    const log = console.log;
    console.log = (...a) => said.push(a.join(' '));
    try {
      await build({ cwd: dir, outPath: join(dir, 'o.html'), scan: false, security: false, prompt: false });
    } finally { console.log = log; }
    const out = said.join('\n');
    assert.match(out, /missing from the config/i);
    assert.match(out, /bob@ex\.com/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gap 6: period.start actually bounds the numbers', () => {
  const dir = repo({ 'a.ts': 'const a = 1;\n' });
  try {
    const g = git(dir);
    assert.ok(metricsFor(g, 'alice@ex.com').commits > 0, 'all-time still counts');
    // keep the date inside git's approxidate range — past ~2038 it silently
    // fails to parse and the filter is dropped altogether.
    const future = metricsFor(g, 'alice@ex.com', { since: '2030-01-01' });
    assert.equal(future.commits, 0, 'commits outside the period must not be counted');
    assert.equal(future.added, 0, 'lines outside the period must not be counted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gap 7: vendored/minified bundles are not attributed to anyone', () => {
  const realLine = 'console.log("mine");\n';
  const minified = 'var a=1;'.repeat(400) + 'console.log(1);console.log(2);\n'; // one >2000-char line
  const dir = repo({
    'src/app.ts': realLine,
    'src/assets/charting_library/bundles/lib.js': minified,
    'vendor/thing.js': 'console.log("vendored");\n',
    'scripts/build.mjs': 'console.log("progress");\n',   // a CLI script's own output
  });
  try {
    const scan = scanCode(git(dir), dir);
    assert.equal(scan.byEmail['alice@ex.com'].console, 1, 'only the one line of real app code counts');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mergePacks: one pack in, same pack out', () => {
  assert.equal(mergePacks([LANGUAGES.java]), LANGUAGES.java);
});
