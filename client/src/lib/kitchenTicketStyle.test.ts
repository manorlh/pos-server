/**
 * Run with `npm test`. "עיצוב בון" — the kitchen ticket's look (lib/kitchenTicketStyle.ts) against the
 * shared golden server/tests/fixtures/kitchen_ticket_designs_golden.json (pos-server
 * tests/test_kitchen_ticket_style.py, byte-identical in pos-android): the templates' looks, the
 * resolved styles, the resolve and the order cases — and the preview: every template, at 58 and 80
 * mm, shows every string the golden makes mandatory; no solid black in any default design; the new
 * classic shorter than the ticket of before; one line per item where it fits, then a hanging indent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BAND_KEYS,
  BAND_STYLES,
  DEFAULT_TEMPLATE,
  FITS,
  GROUP_HEADERS,
  INFO_FIELDS,
  METRICS,
  NOTICE_KINDS,
  NOTICE_SEPARATOR,
  ORDER_BYS,
  ORDER_SAMPLE,
  ORDER_SAMPLE_CATEGORIES,
  ORDER_SAMPLE_COURSES,
  PARAMETER_KEYS,
  SAMPLE_TICKET,
  TEMPLATES,
  TEMPLATE_LABELS,
  blackParts,
  layoutText,
  layoutTicket,
  markMod,
  noticeParts,
  orderLines,
  parseOrderList,
  resolveStyle,
  templateStyle,
  textWidth,
  wrapText,
  type KitchenTicket,
  type Paper,
  type TemplateKey,
  type TicketStyle,
} from './kitchenTicketStyle';

const gold = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'kitchen_ticket_designs_golden.json'), 'utf8'),
);
const PAPERS: Paper[] = [58, 80];

/** The golden's ticket with its explicit nulls, against a sample that leaves them out. */
function sameTicket(ours: KitchenTicket, theirs: Record<string, unknown>) {
  const o = ours as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(theirs)) {
    if (key === 'lines') continue;
    assert.deepEqual(o[key] ?? null, value ?? null, key);
  }
  const lines = theirs.lines as Array<Record<string, unknown>>;
  assert.equal(ours.lines.length, lines.length);
  ours.lines.forEach((line, i) => {
    for (const [key, value] of Object.entries(lines[i])) {
      assert.deepEqual((line as unknown as Record<string, unknown>)[key] ?? null, value ?? null, `${i}.${key}`);
    }
  });
}

function sample(id: string) {
  return gold.samples.find((s: { id: string }) => s.id === id);
}

describe("the look is the golden's", () => {
  it('the templates, classic first and the default, and their labels', () => {
    assert.deepEqual(TEMPLATES, gold.templates);
    assert.equal(DEFAULT_TEMPLATE, gold.defaultTemplate);
    assert.deepEqual(TEMPLATE_LABELS, gold.templateLabels);
  });

  it('the vocabulary, the metrics and the notice kinds', () => {
    assert.deepEqual(INFO_FIELDS, gold.vocabulary.infoFields);
    assert.deepEqual(BAND_KEYS, gold.vocabulary.bandKeys);
    assert.deepEqual(BAND_STYLES, gold.vocabulary.bandStyles);
    assert.deepEqual(FITS, gold.vocabulary.fits);
    assert.deepEqual(ORDER_BYS, gold.vocabulary.orderBys);
    assert.deepEqual(GROUP_HEADERS, gold.vocabulary.groupHeaders);
    assert.deepEqual(METRICS, gold.metrics);
    assert.equal(NOTICE_SEPARATOR, gold.noticeSeparator);
    assert.deepEqual(
      NOTICE_KINDS.map(([kind, prefixes]) => ({ kind, prefixes })),
      gold.noticeKinds,
    );
    assert.equal(PARAMETER_KEYS.length, 15);
  });

  it('each template before the ink saver, and as the cloud sends it with nothing set', () => {
    for (const t of TEMPLATES) {
      assert.deepEqual(templateStyle(t), gold.looks[t], t);
      assert.deepEqual(resolveStyle(t), gold.styles[t], t);
      assert.deepEqual(Object.keys(resolveStyle(t)), Object.keys(gold.styles[t]), t);
      assert.deepEqual(blackParts(templateStyle(t)), gold.blackParts[t], t);
    }
  });

  for (const c of gold.resolveCases) {
    it(`resolves: ${c.id}`, () => {
      const i = c.input;
      assert.deepEqual(
        resolveStyle(i.template, {
          params: i.params, overrides: i.overrides, designId: i.designId, designName: i.designName, printer: i.printer,
        }),
        c.expect,
      );
    });
  }

  it('the samples are the golden\'s', () => {
    sameTicket(SAMPLE_TICKET, sample('preview_table').ticket);
    sameTicket(ORDER_SAMPLE, sample('order_three_courses').ticket);
    assert.deepEqual(ORDER_SAMPLE_COURSES, gold.orderData.courses);
    assert.deepEqual(ORDER_SAMPLE_CATEGORIES, gold.orderData.categories);
  });

  for (const c of gold.orderCases) {
    it(`orders the lines: ${c.id}`, () => {
      const groups = orderLines(ORDER_SAMPLE.lines, { order: c.order, grouping: c.grouping }, c.courses ?? ORDER_SAMPLE_COURSES, ORDER_SAMPLE_CATEGORIES);
      assert.deepEqual(
        groups.map((g) => ({ kind: g.kind, title: g.title, lines: g.lines })),
        c.expect.map((g: { kind: string; title: string | null; lines: number[] }) => ({ kind: g.kind, title: g.title, lines: g.lines })),
      );
    });
  }

  it('the notice prints in the band of each part', () => {
    assert.deepEqual(noticeParts('העתק · הופנה מ: בר · הדפסה חוזרת — ייתכן שכבר הודפס'), [
      ['copy', 'העתק'], ['redirected', 'הופנה מ: בר'], ['resent', 'הדפסה חוזרת — ייתכן שכבר הודפס'],
    ]);
    assert.deepEqual(noticeParts('הערה לשולחן: נר · זרז'), [['tableNote', 'הערה לשולחן: נר'], ['notice', 'זרז']]);
  });
});

describe('the preview shows everything the kitchen must see', () => {
  for (const s of gold.samples) {
    for (const template of TEMPLATES) {
      for (const paper of PAPERS) {
        it(`${s.id} · ${template} · ${paper} mm`, () => {
          const style = gold.styles[template] as TicketStyle;
          const layout = layoutTicket(s.ticket as KitchenTicket, style, {
            paper, printerName: s.printerName, copy: s.copy, copies: s.copies,
            courses: ORDER_SAMPLE_COURSES, categories: ORDER_SAMPLE_CATEGORIES, timeZone: gold.timeZone,
          });
          const said = layoutText(layout);
          for (const must of [...s.mustAppear.all, ...(s.mustAppear.byTemplate[template] ?? [])]) {
            assert.ok(said.includes(must), `${must} — not in: ${said}`);
          }
          // Nothing drawn past the paper's edge.
          for (const op of layout.ops) {
            if (op.type === 'rect') assert.ok(op.x >= 0 && op.x + op.w <= layout.width + 0.5, JSON.stringify(op));
          }
        });
      }
    }
  }
});

describe('no black, shorter, one line where it fits (§7, §8)', () => {
  const draw = (template: TemplateKey, paper: Paper, params: Record<string, unknown> = {}, ticket: KitchenTicket = SAMPLE_TICKET) =>
    layoutTicket(ticket, resolveStyle(template, { params }), {
      paper, printerName: 'מטבח', courses: ORDER_SAMPLE_COURSES, categories: ORDER_SAMPLE_CATEGORIES,
    });

  it('every default design reads 0% solid black; the legacy with the ink saver off does not', () => {
    for (const t of TEMPLATES) for (const p of PAPERS) assert.equal(draw(t, p).blackPct, 0, `${t} ${p}`);
    assert.ok(draw('classic_legacy', 80, { kitchenTicketInkSaver: false }).blackPct > 5);
    // A design's explicit fill, with its ink saver off, is the only black.
    const filled = resolveStyle('large', { overrides: { inkSaver: false, bands: { addition: 'fill' } } });
    assert.ok(layoutTicket(SAMPLE_TICKET, filled, { paper: 80 }).blackPct > 0);
  });

  it('the new classic is clearly shorter than the ticket of before, compact shorter still', () => {
    for (const p of PAPERS) {
      const legacy = draw('classic_legacy', p).lengthCm;
      const classic = draw('classic', p).lengthCm;
      assert.ok(classic <= legacy * 0.8, `${p}: ${classic} vs ${legacy}`);
      assert.ok(draw('compact', p).lengthCm < classic, `${p}`);
    }
  });

  it('a 30-character name fits one line at 80 mm; at 58 mm it wraps under the name, not the quantity', () => {
    const name = 'דלתון לבן - סדרת אסופה | בקבוק';
    assert.equal(name.length, 30);
    const ticket: KitchenTicket = { source: 'table', tableName: '1', createdAt: '2026-10-14T17:14:00Z', lines: [{ name, quantity: 1 }] };
    const rows = (paper: Paper) =>
      draw('classic', paper, {}, ticket).ops.filter((op) => op.type === 'text' && (name.startsWith(op.text) || name.endsWith(op.text)));
    assert.equal(rows(80).length, 1);
    const wrapped = rows(58);
    assert.equal(wrapped.length, 2);
    const [first, second] = wrapped as Array<{ x: number }>;
    assert.equal(second.x, first.x, 'the continuation hangs under the name');
    const qty = draw('classic', 58, {}, ticket).ops.find((op) => op.type === 'text' && op.text === '1×') as { x: number };
    assert.ok(qty.x > first.x, 'the quantity has its own column');
  });

  it('choices on the item\'s line after " · ", smaller, when they fit, else indented', () => {
    const inline = draw('classic', 80);
    assert.ok(layoutText(inline).includes('סלט ירוק · + אבוקדו · בלי בצל'));
    const run = inline.ops.find((op) => op.type === 'text' && op.text === '· + אבוקדו · בלי בצל');
    const name = inline.ops.find((op) => op.type === 'text' && op.text === 'סלט ירוק');
    assert.ok(run && name && run.type === 'text' && name.type === 'text');
    assert.equal(run.y, name.y, 'the same line');
    assert.ok(run.size < name.size && run.x < name.x, 'smaller, after the name');
    const indented = draw('classic', 80, { kitchenTicketInlineMods: false });
    assert.ok(!layoutText(indented).includes('סלט ירוק · +'));
    assert.ok(indented.ops.some((op) => op.type === 'text' && op.text === '+ אבוקדו'));
    // Every run that starts at the right stays inside the paper.
    for (const p of PAPERS) {
      for (const op of draw('classic', p).ops) {
        if (op.type === 'text' && op.align === 'start') assert.ok(op.x - textWidth(op.text, op.size, op.bold) >= -1, `${p}: ${op.text}`);
      }
    }
  });

  it('the order preview: three courses sorted live', () => {
    const text = (params: Record<string, unknown>) => layoutText(draw('classic', 80, params, ORDER_SAMPLE));
    const byCourse = text({ kitchenTicketOrder: 'course' });
    const at = (s: string, w: string) => s.indexOf(w);
    assert.ok(byCourse.includes('── ראשונות ──'));
    assert.ok(at(byCourse, 'חומוס') < at(byCourse, 'סטייק סינטה') && at(byCourse, 'סטייק סינטה') < at(byCourse, 'עוגת שוקולד'));
    assert.ok(at(byCourse, 'עוגת שוקולד') < at(byCourse, 'לימונדה'), 'no course: last');
    const added = text({});
    assert.ok(at(added, 'עוגת שוקולד') < at(added, 'חומוס') && !added.includes('── ראשונות ──'));
    const custom = text({
      kitchenTicketOrder: 'custom',
      kitchenTicketOrderList: `category:${ORDER_SAMPLE_CATEGORIES[0].id},course:${ORDER_SAMPLE_COURSES[2].id}`,
    });
    assert.ok(at(custom, 'לימונדה') < at(custom, 'עוגת שוקולד') && at(custom, 'עוגת שוקולד') < at(custom, 'חומוס'));
  });

  it('helpers: marks, wrapping, the order list', () => {
    assert.equal(markMod('+ גבינה', false, 'plusminus'), '+ גבינה');
    assert.equal(markMod('בלי בצל', true, 'plusminus'), '− בצל');
    assert.equal(markMod('+ גבינה', false, 'words'), 'עם גבינה');
    assert.equal(markMod('בלי בצל', true, 'bullets'), '• בלי בצל');
    assert.deepEqual(wrapText('a b', 20, 1000), ['a b']);
    assert.ok(wrapText('אאאאאאאאאאאאאאאאאאאא', 20, 50).length > 1);
    assert.deepEqual(parseOrderList('course:C0000000-0000-4000-8000-000000000001'), [
      { kind: 'course', id: 'c0000000-0000-4000-8000-000000000001' },
    ]);
    assert.equal(parseOrderList('dish:c0000000-0000-4000-8000-000000000001'), null);
    assert.equal(parseOrderList('course:c0000000-0000-4000-8000-000000000001,course:c0000000-0000-4000-8000-000000000001'), null);
  });
});
