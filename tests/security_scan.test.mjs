import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSecurity } from '../src/security.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

test('scanSecurity downgrades Firebase web API key and suppresses sample comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtr-sec-test-'));
  try {
    execSync('git init', { cwd: dir });
    execSync('git config user.name "Tester"', { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });

    // 1. Firebase client config
    const fbCode = `
      // Firebase public config
      export const firebase = {
        apiKey: 'AIzaSyA123456789012345678901234567890',
        authDomain: 'my-app.firebaseapp.com'
      };
    `;
    writeFileSync(join(dir, 'environment.ts'), fbCode);

    // 2. Doc comment sample credentials
    const xmlDoc = `
      <!--
      Usernames/Passwords are
          rod/koala
          dianne/emu
      -->
      <root></root>
    `;
    writeFileSync(join(dir, 'security.xml'), xmlDoc);

    // 3. Inline suppression comment
    const suppressed = `
      const badSecret = 'secret_key_123456789012345'; // git-team-report-ignore
    `;
    writeFileSync(join(dir, 'suppressed.ts'), suppressed);

    execSync('git add . && git commit -m "init"', { cwd: dir });

    const git = (cmd) => execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8' });
    const result = scanSecurity(git, dir, { gitleaks: false });

    // Check Firebase key
    const secrets = result.byVector['Secrets'] || [];
    const fbFinding = secrets.find((f) => f.file === 'environment.ts');
    assert.ok(fbFinding, 'Firebase key should be present');
    assert.equal(fbFinding.severity, 'Low', 'Firebase key should be downgraded to Low');
    assert.ok(fbFinding.snippet.includes('[Firebase/Web Client Key]'));

    // Check doc sample comments
    const sampleFinding = secrets.find((f) => f.file === 'security.xml');
    assert.equal(sampleFinding, undefined, 'Sample credentials in doc comments should be skipped');

    // Check inline suppression
    const suppFinding = secrets.find((f) => f.file === 'suppressed.ts');
    assert.equal(suppFinding, undefined, 'Suppressed line should be ignored');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
