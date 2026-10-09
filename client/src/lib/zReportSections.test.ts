import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { agorot, zSectionLines, type ZReportSections, type ZSectionsLabels } from './zReportSections';

// Compiled into client/.test-build: the fixture is the server's (the same bytes as the till's),
// the words are the page's own (he.json).
const ROOT = join(__dirname, '..');
const FIXTURE = join(ROOT, '..', 'server', 'tests', 'fixtures', 'z_report_v2_golden.json');
const HE = join(ROOT, 'src', 'messages', 'he.json');

interface GoldenCase {
  name: string;
  exempt?: boolean;
  expected: ZReportSections;
  lines: [string, [string, string, boolean][]][];
}

function cases(): GoldenCase[] {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')).cases as GoldenCase[];
}

function labels(): ZSectionsLabels {
  return JSON.parse(readFileSync(HE, 'utf8')).zReports.reportSections.labels as ZSectionsLabels;
}

test('the golden fixture is here (the server checkout this page ships with)', () => {
  assert.ok(existsSync(FIXTURE), FIXTURE);
});

test('every golden case prints the lines the till and the cloud print, word for word', () => {
  const L = labels();
  for (const c of cases()) {
    assert.deepEqual(zSectionLines(c.expected, L, { exempt: c.exempt ?? false }), c.lines, c.name);
  }
});

test("the owner's example: no count lines when counting is not required", () => {
  const golden = cases().find((c) => c.name === 'golden')!;
  const blocks = zSectionLines(golden.expected, labels());
  const drawer = blocks.find(([title]) => title === 'התאמת מגירת מזומן')!;
  assert.deepEqual(drawer[1].map(([label]) => label), ['קופה פותחת', 'תקבולי מזומן כולל טיפ', 'מזומן צפוי']);
  const sales = blocks.find(([title]) => title === 'מכירות (כולל מע״מ, ללא טיפ)')!;
  assert.equal(sales[1][3][1], '15.00');
});

test('no sections, no lines', () => {
  assert.deepEqual(zSectionLines(null, labels()), []);
});

test('money to agorot, half away from zero', () => {
  assert.equal(agorot('12.30'), 1230);
  assert.equal(agorot('-0.50'), -50);
  assert.equal(agorot('1.005'), 101);
  assert.equal(agorot(null), null);
  assert.equal(agorot('x'), null);
});
