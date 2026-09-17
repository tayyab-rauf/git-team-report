import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { build } from '../src/commands.mjs';

test('E2E synthetic repository: verified rules, grading fairness, and path exclusions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtr-e2e-synthetic-'));
  try {
    execSync('git init -b main', { cwd: dir });
    execSync('git config user.name "Noor Lead"', { cwd: dir });
    execSync('git config user.email "noor@example.com"', { cwd: dir });

    // 1. Angular frontend component with [innerHTML] and Firebase key
    const feCode = `
      // Firebase (Sign in with Google). Public web config — safe in the bundle.
      export const firebase = {
        apiKey: 'AIzaSyA_PublicClientKey123456789012345',
        authDomain: 'isx-uat-987.firebaseapp.com'
      };

      // Safe Angular sanitized binding
      export const template = '<div [innerHTML]="trustedContent"></div>';
    `;
    writeFileSync(join(dir, 'app.component.ts'), feCode);

    // 2. Backend Spring XML with sample credentials in comments and MD5 password encoder
    const beXml = `
      <!--
      Usernames/Passwords are
          rod/koala
          dianne/emu
      -->
      <beans>
        <authentication-provider>
          <password-encoder hash="md5"/>
        </authentication-provider>
      </beans>
    `;
    writeFileSync(join(dir, 'applicationContext-security.xml'), beXml);

    // 3. Substantial code with some subscriptions
    let activeCode = 'import { Component } from "@angular/core";\n';
    for (let i = 0; i < 600; i++) {
      activeCode += `// line ${i}\n`;
    }
    activeCode += 'obs$.subscribe();\n'; // 1 smell in 600 lines
    writeFileSync(join(dir, 'feature.ts'), activeCode);

    // 4. Vendored legacy files in legacy/ directory (5,000 lines)
    mkdirSync(join(dir, 'legacy'), { recursive: true });
    let legacyCode = '// legacy war import\n'.repeat(5000);
    writeFileSync(join(dir, 'legacy/OldApp.java'), legacyCode);

    execSync('git add . && git commit -m "feat(core): initial project scaffold (ISE-101)"', { cwd: dir });

    // Build report with excludePaths for legacy/ and hideGrades true
    const config = {
      period: { start: '2026-01-01' },
      excludePaths: ['legacy/**'],
      hideGrades: false,
      authors: [
        { email: 'noor@example.com', name: 'Noor Lead', gitGrade: '', codeGrade: '' }
      ],
    };
    writeFileSync(join(dir, 'git-team-report.config.json'), JSON.stringify(config, null, 2));

    const outHtml = join(dir, 'report.html');
    await build({
      cwd: dir,
      outPath: outHtml,
      gitleaks: false, // test built-in security rules
      lang: 'java',    // run java rules to check xml weak hash
      noGrades: false,
    });

    const html = readFileSync(outHtml, 'utf8');

    // Assertion 1: Weak MD5 password encoder is flagged as High
    assert.ok(html.includes('password-encoder') && html.includes('md5'), 'MD5 password encoder should be flagged');

    // Assertion 2: Sample credentials (rod/koala) in comments are NOT flagged
    assert.equal(html.includes('rod/koala'), false, 'Sample credentials in comments should be suppressed');

    // Assertion 3: Angular [innerHTML] is NOT flagged as XSS
    assert.equal(html.includes('xss-innerhtml'), false, 'Angular [innerHTML] should not be flagged as XSS');

    // Assertion 4: Legacy directory was excluded from lines count (should be ~600, not 5600)
    assert.ok(!html.includes('+5.6k'), 'Legacy lines should be excluded from stats');

    // Assertion 5: Noor gets a good Code grade (A, A-, B+, or B), not a D
    assert.ok(html.includes('Code</span>A') || html.includes('Code</span>B'), 'Noor should receive an A or B grade for clean density');

    // Now test with --no-grades
    const outNoGrades = join(dir, 'report-no-grades.html');
    await build({
      cwd: dir,
      outPath: outNoGrades,
      gitleaks: false,
      noGrades: true,
    });
    const htmlNoGrades = readFileSync(outNoGrades, 'utf8');
    assert.equal(htmlNoGrades.includes('<div class="grades">'), false, 'Grades should be absent when noGrades is set');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
