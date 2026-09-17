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
