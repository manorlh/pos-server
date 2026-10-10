/**
 * Run with `npm test`. The "שוברים" page (sidebar קטלוג ← שוברים, app/dashboard/vouchers/page.tsx) heads itself with the
 * page's real title — the sidebar's own label (`nav.vouchers`) — not `vouchers.title`, which is the voucher's PRINT title
 * ("כותרת להדפסה": the table's column and the form's field). The page showed the latter as its heading.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'src');
const messages = JSON.parse(readFileSync(join(root, 'messages', 'he.json'), 'utf8')) as { nav: Record<string, string>; vouchers: Record<string, string> };
const page = readFileSync(join(root, 'app', 'dashboard', 'vouchers', 'page.tsx'), 'utf8');
const nav = readFileSync(join(root, 'lib', 'navigation.ts'), 'utf8');

describe('the vouchers page heading', () => {
  it('the sidebar entry is "שוברים" (nav.vouchers); the print title is another text', () => {
    assert.match(nav, /href: '\/dashboard\/vouchers', labelKey: 'vouchers'/);
    assert.equal(messages.nav.vouchers, 'שוברים');
    assert.equal(messages.vouchers.title, 'כותרת להדפסה');
  });

  it('heads the page, its export and its sheet with the sidebar label', () => {
    assert.match(page, /const tn = useTranslations\('nav'\)/);
    assert.match(page, /<h1 className="text-2xl font-bold">\{tn\('vouchers'\)\}<\/h1>/);
    assert.match(page, /<ReportExportToolbar\s+title=\{tn\('vouchers'\)\}/);
    assert.match(page, /name: tn\('vouchers'\)/);
  });

  it('keeps the print title where it belongs: the list\'s column and the form\'s field, never a heading', () => {
    assert.doesNotMatch(page, /<h1[^>]*>\{t\('title'\)\}/);
    assert.match(page, /<TableHead>\{t\('title'\)\}<\/TableHead>/);
    assert.match(page, /<Label>\{t\('title'\)\}<\/Label>/);
  });
});
