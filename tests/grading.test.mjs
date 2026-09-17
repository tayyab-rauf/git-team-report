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
