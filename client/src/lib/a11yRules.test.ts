/**
 * Run with `npm test`. The accessibility rule set (lib/a11yRules.ts) and its tree (lib/a11yTree.ts):
 * each rule catches its failure and passes its fix, so a clean run of a public template means
 * something.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { auditDom, auditHtml, blockingViolations, toA11yReport, A11Y_RULES } from './a11yRules';
import { parseHtml, textOf } from './a11yTree';

function rulesHit(html: string): string[] {
  return auditHtml(html).violations.map((v) => v.rule).sort();
}

function hits(rule: string, html: string): number {
  return auditHtml(html, { only: [rule] }).violations[0]?.count ?? 0;
}

describe('a11y tree', () => {
  it('parses React markup: void elements, entities, attributes, raw text', () => {
    const root = parseHtml('<div id="a" class="x y"><img src="a.png" alt="Tom &amp; Jerry"/><p>a &lt; b &#x27;q&#x27;</p><br/><style>p>a{}</style><span>end</span></div>');
    const div = root.children[0];
    assert.equal(div.tag, 'div');
    assert.equal(div.attrs.class, 'x y');
    assert.deepEqual(div.children.map((c) => c.tag), ['img', 'p', 'br', 'style', 'span']);
    assert.equal(div.children[0].attrs.alt, 'Tom & Jerry');
    assert.equal(textOf(div.children[1]), "a < b 'q'");
    assert.equal(textOf(div), "Tom & Jerrya < b 'q'end");
  });

  it('skips text inside aria-hidden', () => {
    const root = parseHtml('<button><span aria-hidden="true">×</span></button>');
    assert.equal(textOf(root), '');
  });
});

describe('a11y rules', () => {
  it('every rule has an id, impact, WCAG reference and Hebrew help', () => {
    const ids = new Set<string>();
    for (const r of A11Y_RULES) {
      assert.ok(!ids.has(r.id), r.id);
      ids.add(r.id);
      assert.ok(['critical', 'serious', 'moderate', 'minor'].includes(r.impact));
      assert.ok(r.wcag && /[֐-׿]/.test(r.help), r.id);
    }
    assert.ok(ids.size >= 18);
  });

  it('image-alt: an image needs alt (empty = decorative)', () => {
    assert.equal(hits('image-alt', '<img src="a"/>'), 1);
    assert.equal(hits('image-alt', '<img src="a" alt=""/><img src="b" alt="שקשוקה"/>'), 0);
  });

  it('button-name / link-name: an accessible name from text, aria-label, labelledby or an img alt', () => {
    assert.equal(hits('button-name', '<button></button><button><svg aria-hidden="true"></svg></button>'), 2);
    assert.equal(hits('button-name', '<button>שמירה</button><button aria-label="סגירה">×</button><button><img alt="חיפוש" src="s"/></button><span id="l">x</span><button aria-labelledby="l"></button>'), 0);
    assert.equal(hits('link-name', '<a href="/x"></a>'), 1);
    assert.equal(hits('link-name', '<a href="/x">תפריט</a><a>no href is not a link</a>'), 0);
  });

  it('label: placeholder is not a label; label[for], wrapping label and aria-label are', () => {
    assert.equal(hits('label', '<input type="text" placeholder="שם"/><select></select><textarea></textarea>'), 3);
    assert.equal(
      hits('label', '<label for="n">שם</label><input id="n"/><label>טלפון <input type="tel"/></label><input aria-label="חיפוש"/><input type="hidden"/><input type="submit" value="שלח"/>'),
      0,
    );
  });

  it('aria: valid roles, references that exist, no focusable inside aria-hidden, no positive tabindex', () => {
    assert.equal(hits('aria-valid-role', '<div role="buton"></div>'), 1);
    assert.equal(hits('aria-valid-role', '<div role="dialog" aria-label="x"></div>'), 0);
    assert.equal(hits('aria-refs', '<p aria-describedby="missing">x</p>'), 1);
    assert.equal(hits('aria-refs', '<p id="d">d</p><input aria-describedby="d" aria-label="x"/>'), 0);
    assert.equal(hits('aria-hidden-focus', '<div aria-hidden="true"><a href="/">x</a></div>'), 1);
    assert.equal(hits('aria-hidden-focus', '<div aria-hidden="true"><svg></svg><button disabled="">x</button></div>'), 0);
    assert.equal(hits('tabindex', '<div tabindex="2">x</div>'), 1);
    assert.equal(hits('tabindex', '<div tabindex="-1">x</div><div tabindex="0">y</div>'), 0);
  });

  it('dialog-name, nested-interactive, listitem, form-error', () => {
    assert.equal(hits('dialog-name', '<div role="dialog"></div>'), 1);
    assert.equal(hits('dialog-name', '<div role="dialog" aria-labelledby="t"><h2 id="t">הגדרות</h2></div>'), 0);
    assert.equal(hits('nested-interactive', '<a href="/"><button>x</button></a>'), 1);
    assert.equal(hits('listitem', '<div><li>x</li></div>'), 1);
    assert.equal(hits('listitem', '<ul><li>x</li></ul>'), 0);
    assert.equal(hits('form-error', '<input aria-label="x" aria-invalid="true"/>'), 1);
    assert.equal(hits('form-error', '<input aria-label="x" aria-invalid="true" aria-describedby="e"/><p id="e">שגוי</p>'), 0);
  });

  it('focus-visible: removing the outline needs a visible focus style', () => {
    assert.equal(hits('focus-visible', '<button class="outline-none">x</button>'), 1);
    assert.equal(hits('focus-visible', '<button class="outline-none focus-visible:ring-0">x</button>'), 1);
    assert.equal(hits('focus-visible', '<button class="outline-none focus-visible:ring-2">x</button><button class="focus-visible:outline">y</button>'), 0);
  });

  it('motion-reduce: an animation is motion-safe or has a motion-reduce variant', () => {
    assert.equal(hits('motion-reduce', '<span class="animate-spin">x</span>'), 1);
    assert.equal(hits('motion-reduce', '<span class="motion-safe:animate-spin">x</span><span class="animate-pulse motion-reduce:animate-none">y</span><span class="animate-none">z</span>'), 0);
  });

  it('rtl-logical: physical left / right utilities are flagged, logical ones pass', () => {
    assert.equal(hits('rtl-logical', '<div class="ml-2 text-left md:pr-4">x</div>'), 1);
    assert.equal(hits('rtl-logical', '<div class="ms-2 text-start md:pe-4 start-0 inset-x-0 rounded-lg">x</div>'), 0);
  });

  it('color-contrast: inline colours below 4.5:1 with text', () => {
    assert.equal(hits('color-contrast', '<span style="color:#9CA3AF;background-color:#FFFFFF">טקסט</span>'), 1);
    assert.equal(hits('color-contrast', '<span style="color:#111827;background-color:#FFFFFF">טקסט</span><span aria-hidden="true" style="color:#eee;background-color:#fff">Aa</span>'), 0);
  });

  it('heading-order and page-root', () => {
    assert.equal(hits('heading-order', '<h1>a</h1><h3>b</h3>'), 1);
    assert.equal(hits('heading-order', '<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2>'), 0);
    assert.equal(hits('page-root', '<div data-public-root=""><p>x</p></div>'), 1);
    assert.equal(hits('page-root', '<div data-public-root="" lang="he" dir="rtl"><main id="m">x</main></div>'), 0);
  });

  it('auditDom reads a live DOM-shaped tree (the editor preview) into the server report', () => {
    const el = (tag: string, attrs: Record<string, string>, children: unknown[] = []) => ({
      nodeType: 1,
      nodeName: tag.toUpperCase(),
      textContent: null,
      attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
      childNodes: children,
    });
    const text = (t: string) => ({ nodeType: 3, nodeName: '#text', textContent: t, childNodes: [] });
    const preview = el('div', { 'data-public-root': '', lang: 'he', dir: 'rtl' }, [el('main', {}, [el('img', { src: 'x' }), text('שלום')])]);
    const { result, report } = auditDom(preview as never);
    assert.deepEqual(result.violations.map((v) => v.rule), ['image-alt']);
    assert.deepEqual(report.violations, [{ rule: 'image-alt', impact: 'critical', count: 1 }]);
  });

  it('duplicate ids', () => {
    assert.equal(hits('duplicate-id', '<p id="a">1</p><p id="a">2</p>'), 1);
  });

  it('report: blocking = critical / serious; the server-side summary shape', () => {
    const result = auditHtml('<img src="x"/><h1>a</h1><h3>b</h3>');
    assert.deepEqual(rulesHit('<img src="x"/><h1>a</h1><h3>b</h3>'), ['heading-order', 'image-alt']);
    assert.deepEqual(blockingViolations(result).map((v) => v.rule), ['image-alt']);
    const report = toA11yReport(result);
    assert.equal(report.engine, 'runner-a11y');
    assert.deepEqual(report.violations.map((v) => [v.rule, v.impact, v.count]), [
      ['image-alt', 'critical', 1],
      ['heading-order', 'moderate', 1],
    ]);
  });
});
