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
