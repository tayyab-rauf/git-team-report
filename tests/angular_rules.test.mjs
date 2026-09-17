/**
 * Block (multi-line) rule support and the Angular/template packs.
 *
 * The regression these lock down: a per-line scan cannot see a construct that
 * spans lines, and a naive regex cannot see Angular's property-binding syntax.
 * Both produced enormous false-positive counts before they were measured
 * (`@for` missing `track`: 405 reported, 1 real — that rule was dropped).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { scanCode } from '../src/scan.mjs';
import { LANGUAGES, resolvePack } from '../src/languages.mjs';

const ME = 'alice@ex.com';
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'gtr-ng-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.name "Alice"', { cwd: dir });
  execSync(`git config user.email "${ME}"`, { cwd: dir });
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  execSync('git add -A', { cwd: dir });
  execSync('git commit -q -m "feat: x"', { cwd: dir });
  return dir;
}
const git = (dir) => (cmd) => {
  try { return execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8' }).trim(); } catch { return ''; }
};
const counts = (dir, pack) => scanCode(git(dir), dir,
  { rules: pack.codeRules, globs: pack.codeGlobs }).byEmail[ME] || {};

test('a block rule matches across lines, where a per-line rule cannot', () => {
  const dir = repo({ 'a.ts': 'try {\n  go();\n} catch (e) {\n}\n' });
  try {
    const perLine = scanCode(git(dir), dir, { rules: [{ key: 'x', label: 'x', re: /catch\s*(\([^)]*\))?\s*\{\s*\}/ }] });
    const block = scanCode(git(dir), dir, { rules: [{ key: 'x', label: 'x', block: true, re: /catch\s*(\([^)]*\))?\s*\{\s*\}/ }] });
    assert.equal((perLine.byEmail[ME] || {}).x, undefined, 'per-line cannot see the split construct');
    assert.equal(block.byEmail[ME].x, 1, 'the block rule sees it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('block rule attributes to the line the match starts on, and honours suppression', () => {
  const dir = repo({
    'a.ts': 'const x = 1;\ntry { go(); } catch (e) {\n}\n',
    'b.ts': '// git-team-report-disable-next-line\ntry { go(); } catch (e) {\n}\n',
  });
  try {
    const rule = [{ key: 'ec', label: 'ec', block: true, re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/ }];
    const r = scanCode(git(dir), dir, { rules: rule });
    assert.equal(r.byEmail[ME].ec, 1, 'the suppressed one is skipped, the other counted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('templates are scanned at all (codeGlobs used to be ts/js only)', () => {
  const dir = repo({ 'app.html': '<div>TODO: fix</div>\n' });
  try {
    const { pack } = resolvePack(git(dir));
    assert.ok(pack.codeGlobs.includes('*.html'), 'html must be in the merged globs');
    assert.equal(counts(dir, pack).todo, 1, 'a template smell is counted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('img/button rules understand Angular property bindings', () => {
  const dir = repo({
    'a.html': [
      '<img src="a.png">',                       // flagged
      '<img src="b.png" alt="b">',               // fine
      '<img src="c.png" [alt]="label">',         // fine — binding, not a literal attr
      '<img\n  src="d.png"\n  [attr.alt]="l">',  // fine — spans lines
      '<button (click)="go()">go</button>',      // flagged
      '<button type="button">ok</button>',       // fine
      '<button [type]="kind()">ok</button>',     // fine — binding
    ].join('\n') + '\n',
  });
  try {
    const c = counts(dir, LANGUAGES.html);
    assert.equal(c.imgalt, 1, 'only the genuinely alt-less img');
    assert.equal(c.btntype, 1, 'only the genuinely type-less button');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OnPush rule distinguishes components that set changeDetection', () => {
  const dir = repo({
    'a.component.ts': [
      "@Component({ selector: 'a', template: '' })",
      'export class A {}',
      "@Component({\n  selector: 'b',\n  changeDetection: ChangeDetectionStrategy.OnPush,\n})",
      'export class B {}',
    ].join('\n') + '\n',
  });
  try {
    assert.equal(counts(dir, LANGUAGES.typescript).onpush, 1, 'only the component without OnPush');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deep-import rule ignores shallow relative imports', () => {
  const dir = repo({
    'a.ts': ["import a from './a';", "import b from '../b';", "import c from '../../../c';",
      "import d from '../../../../d';", "import e from '../../../../../e';"].join('\n') + '\n',
  });
  try {
    assert.equal(counts(dir, LANGUAGES.typescript).deepimport, 2, 'only 4+ levels deep');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('merged packs keep template rules off .ts and Angular rules off .html', () => {
  const dir = repo({
    'a.ts': "const s = '<button>x</button>';\n",   // a string, not a template
    'a.html': '<div (click)="constructor(private x: Y)">x</div>\n',
  });
  try {
    const { pack } = resolvePack(git(dir));
    const c = counts(dir, pack);
    assert.ok(!c.btntype, 'template rule must not fire inside a .ts string');
    assert.ok(!c.ctordi, 'a TS rule must not fire inside a template');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
