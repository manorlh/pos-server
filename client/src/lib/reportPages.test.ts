/**
 * Every report page has its "ייצוא" (P:\specs\reports-designed-pdf.md §2, §4 "מעבר על כל עמודי
 * הדוחות: בכל אחד יש ייצוא. בדיקה על רשימת העמודים"): walks `app/dashboard/**\/page.tsx`, and
 * each page is either a report whose files render an export control with a report type (the
 * designed PDF's `reportInsights.<type>`), or listed as not a report with its reason.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NOT_REPORT_PAGES, REPORT_PAGES } from './reportPages';

const SRC = join(process.cwd(), 'src');
const DASHBOARD = join(SRC, 'app', 'dashboard');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name === 'page.tsx') out.push(path);
  }
  return out;
}

/** `app/dashboard/shifts/[id]/page.tsx` → `shifts/[id]`; the home page → `''`. */
const routeOf = (file: string) =>
  relative(DASHBOARD, file).split(sep).slice(0, -1).join('/');

const source = (file: string) => readFileSync(join(SRC, ...file.split('/')), 'utf8');

/** A file renders the export bar: a `ReportPage` given an `export`, or one of the bars. */
const EXPORT_CONTROL = [/<ReportPage\b[\s\S]*?\bexport=\{/, /<StandaloneExportBar\b/, /<ReportExportBar\b/];

function allSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) allSources(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe('every dashboard page is a report with an export, or says why not', () => {
  const pages = walk(DASHBOARD).map(routeOf).sort();
  const reports = new Map(REPORT_PAGES.map((p) => [p.route, p]));
  const excluded = new Map(NOT_REPORT_PAGES.map((p) => [p.route, p]));

  it('the walk finds the pages', () => {
    assert.ok(pages.length > 80, `only ${pages.length} pages`);
    assert.ok(pages.includes('') && pages.includes('product-sales'));
  });

  it('each page is listed exactly once', () => {
    const missing = pages.filter((r) => !reports.has(r) && !excluded.has(r));
    assert.deepEqual(missing, [], `pages not listed in lib/reportPages.ts: ${missing.join(', ')}`);
    const both = pages.filter((r) => reports.has(r) && excluded.has(r));
    assert.deepEqual(both, []);
    const stale = [...reports.keys(), ...excluded.keys()].filter((r) => !pages.includes(r));
    assert.deepEqual(stale, [], `listed routes without a page: ${stale.join(', ')}`);
    assert.equal(reports.size, REPORT_PAGES.length, 'a report route listed twice');
    assert.equal(excluded.size, NOT_REPORT_PAGES.length, 'an excluded route listed twice');
  });

  it('an exclusion says why', () => {
    for (const p of NOT_REPORT_PAGES) assert.ok(p.reason.trim().length >= 10, `no reason for ${p.route}`);
  });

  for (const page of REPORT_PAGES) {
    it(`/dashboard/${page.route}: renders "ייצוא" with a report type`, () => {
      assert.ok(page.files.length > 0);
      for (const file of page.files) assert.ok(existsSync(join(SRC, ...file.split('/'))), `missing ${file}`);
      const texts = page.files.map(source);
      for (const [i, text] of texts.entries()) {
        assert.ok(
          EXPORT_CONTROL.some((re) => re.test(text)),
          `${page.files[i]} renders no export bar`,
        );
        assert.match(text, /\breportType\b/, `${page.files[i]}: the export has no reportType (the designed PDF's insights)`);
      }
      for (const key of page.reportKeys) {
        assert.ok(
          texts.some((t) => t.includes(`'${key}'`) || t.includes(`"${key}"`)),
          `reportKey ${key} not found in ${page.files.join(', ')}`,
        );
      }
    });
  }

  it('report keys are unique across the dashboard', () => {
    const keys = REPORT_PAGES.flatMap((p) => p.reportKeys);
    assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), []);
  });
});

describe('one export for every report', () => {
  const files = allSources(SRC);

  it('nothing imports the old Excel-and-print toolbar', () => {
    const users = files
      .filter((f) => /report-export-toolbar['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    assert.deepEqual(users, []);
    assert.equal(existsSync(join(SRC, 'components', 'dashboard', 'report-export-toolbar.tsx')), false);
  });

  it('every file that renders an export bar is a listed report', () => {
    const listed = new Set(REPORT_PAGES.flatMap((p) => p.files));
    const framework = /components[\\/]dashboard[\\/]report-framework[\\/]/;
    const unlisted = files
      .filter((f) => !framework.test(f) && /\.tsx$/.test(f))
      .filter((f) => EXPORT_CONTROL.some((re) => re.test(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .filter((f) => !listed.has(f));
    assert.deepEqual(unlisted, [], 'an export bar outside lib/reportPages.ts: list its page');
  });
});
