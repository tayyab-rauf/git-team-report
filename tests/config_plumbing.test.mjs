import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/render.mjs';
import { metricsFor } from '../src/collect.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

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
  assert.equal(html.includes('<div class="grades">'), false, 'Grades container should not be rendered when hideGrades is true');
});

test('metricsFor ignores lines in paths matching excludePatterns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtr-metric-test-'));
  try {
    execSync('git init', { cwd: dir });
    execSync('git config user.name "Tester"', { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });

    writeFileSync(join(dir, 'app.ts'), 'console.log("hello");\n'.repeat(10));
    execSync('mkdir -p legacy', { cwd: dir });
    writeFileSync(join(dir, 'legacy/Old.java'), '// old\n'.repeat(1000));

    execSync('git add . && git commit -m "feat: initial commit"', { cwd: dir });

    const git = (cmd) => execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8' });

    // Without exclusion: +1010 lines
    const allMetrics = metricsFor(git, 'test@example.com');
    assert.equal(allMetrics.added, 1010);

    // With legacy/** excluded: only +10 lines
    const filteredMetrics = metricsFor(git, 'test@example.com', { excludePatterns: ['legacy/**'] });
    assert.equal(filteredMetrics.added, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
