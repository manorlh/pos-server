/**
 * The accessibility checklist of the public templates — an axe-core-like rule set built on what the
 * project already has (no new dependency): it walks an `A11yNode` tree (a11yTree.ts) made from
 * React's static markup in the tests, or from the live preview's DOM in an editor before publishing.
 *
 * Targets WCAG 2.2 AA (plan §17.1: IS 5568 adopts WCAG 2.0 AA; 2.2 AA covers every version). Static
 * checks only — a person still tests with a keyboard and a screen reader; the toolbar never replaces
 * conformance.
 *
 * Impacts as in axe: critical / serious block publication (the server's gate,
 * app/services/digital_legal/gate.py), moderate / minor are warnings.
 *
 * Tailwind-aware rules: `focus-visible` (an element that removes the outline must draw a visible
 * focus), `motion-reduce` (an animation must be `motion-safe:` or have a `motion-reduce:` variant) and
 * `rtl-logical` (physical left/right utilities break RTL ↔ LTR; use start/end).
 */
import { contrastRatio } from './contrast';
import { classList, describe, elements, fromDom, parseHtml, textOf, type A11yNode } from './a11yTree';

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';

export interface A11yRule {
  id: string;
  impact: Impact;
  /** WCAG success criterion (for the report). */
  wcag: string;
  help: string;
  check(root: A11yNode, ctx: RuleContext): A11yNode[];
}

export interface RuleContext {
  byId: Map<string, A11yNode[]>;
  all: A11yNode[];
}

export interface A11yViolation {
  rule: string;
  impact: Impact;
  wcag: string;
  help: string;
  count: number;
  nodes: string[];
}

export interface A11yResult {
  violations: A11yViolation[];
  passes: string[];
}

/** What a publish request sends to the server's gate. */
export interface A11yReport {
  engine: 'runner-a11y';
  version: 1;
  violations: Array<{ rule: string; impact: Impact; count: number }>;
}

const VALID_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'cell', 'checkbox', 'columnheader',
  'combobox', 'complementary', 'contentinfo', 'definition', 'dialog', 'directory', 'document', 'feed', 'figure',
  'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main',
  'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation',
  'none', 'note', 'option', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
  'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab',
  'table', 'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);

const NO_LABEL_INPUTS = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

function isFocusable(n: A11yNode): boolean {
  if ('disabled' in n.attrs) return false;
  const tab = n.attrs.tabindex;
  if (tab !== undefined) return Number(tab) >= 0;
  if (n.tag === 'a') return 'href' in n.attrs;
  if (n.tag === 'input') return n.attrs.type !== 'hidden';
  return n.tag === 'button' || n.tag === 'select' || n.tag === 'textarea' || n.tag === 'summary';
}

function isInteractive(n: A11yNode): boolean {
  return (n.tag === 'a' && 'href' in n.attrs) || n.tag === 'button' || n.tag === 'select' || n.tag === 'textarea' ||
    (n.tag === 'input' && n.attrs.type !== 'hidden') || ['button', 'link', 'checkbox', 'switch', 'menuitem', 'tab'].includes(n.attrs.role ?? '');
}

function ancestors(n: A11yNode): A11yNode[] {
  const out: A11yNode[] = [];
  for (let p = n.parent; p; p = p.parent) out.push(p);
  return out;
}

function labelledByText(n: A11yNode, ctx: RuleContext): string {
  const ids = (n.attrs['aria-labelledby'] ?? '').split(/\s+/).filter(Boolean);
  return ids.map((id) => (ctx.byId.get(id)?.[0] ? textOf(ctx.byId.get(id)![0]) : '')).join(' ').trim();
}

/** A simplified accessible name: aria-labelledby, aria-label, alt (img), content, title. */
export function accessibleName(n: A11yNode, ctx: RuleContext): string {
  const byRef = labelledByText(n, ctx);
  if (byRef) return byRef;
  const label = (n.attrs['aria-label'] ?? '').trim();
  if (label) return label;
  if (n.tag === 'img') return (n.attrs.alt ?? '').trim();
  if (n.tag === 'input' && ['submit', 'button', 'reset'].includes(n.attrs.type ?? '')) return (n.attrs.value ?? '').trim();
  const content = n.children.map(textOf).join('').replace(/\s+/g, ' ').trim();
  if (content) return content;
  return (n.attrs.title ?? '').trim();
}

function hasLabel(n: A11yNode, ctx: RuleContext): boolean {
  if (labelledByText(n, ctx) || (n.attrs['aria-label'] ?? '').trim() || (n.attrs.title ?? '').trim()) return true;
  if (ancestors(n).some((a) => a.tag === 'label' && textOf(a).trim())) return true;
  const id = n.attrs.id;
  return !!id && ctx.all.some((x) => x.tag === 'label' && x.attrs.for === id && textOf(x).trim() !== '');
}

const FOCUS_REMOVERS = ['outline-none', 'focus:outline-none', 'focus-visible:outline-none'];

function drawsFocus(cls: string[]): boolean {
  return cls.some(
    (c) =>
      /^(focus|focus-visible):(ring|outline|border|shadow|underline|bg-)/.test(c) &&
      !/^(focus|focus-visible):(outline-none|ring-0|ring-transparent|border-transparent|shadow-none)$/.test(c),
  );
}

const PHYSICAL = /^(?:[a-z-]+:)*-?(ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|text-left|text-right|float-left|float-right|scroll-ml|scroll-mr)(-|$)/;

function styleMap(n: A11yNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (n.attrs.style ?? '').split(';')) {
    const k = part.indexOf(':');
    if (k > 0) out[part.slice(0, k).trim().toLowerCase()] = part.slice(k + 1).trim();
  }
  return out;
}

export const A11Y_RULES: A11yRule[] = [
  {
    id: 'image-alt', impact: 'critical', wcag: '1.1.1',
    help: 'כל תמונה צריכה טקסט חלופי (alt), או alt="" כשהיא קישוטית.',
    check: (_r, ctx) => ctx.all.filter((n) => n.tag === 'img' && !('alt' in n.attrs) && !['presentation', 'none'].includes(n.attrs.role ?? '')),
  },
  {
    id: 'role-img-alt', impact: 'serious', wcag: '1.1.1',
    help: 'רכיב עם role="img" צריך aria-label או aria-labelledby.',
    check: (_r, ctx) => ctx.all.filter((n) => n.attrs.role === 'img' && n.tag !== 'img' && !accessibleName(n, ctx) && n.attrs['aria-hidden'] !== 'true'),
  },
  {
    id: 'button-name', impact: 'critical', wcag: '4.1.2',
    help: 'לכפתור צריך להיות שם נגיש (טקסט או aria-label).',
    check: (_r, ctx) => ctx.all.filter((n) => (n.tag === 'button' || n.attrs.role === 'button') && !accessibleName(n, ctx)),
  },
  {
    id: 'link-name', impact: 'serious', wcag: '2.4.4',
    help: 'לקישור צריך להיות טקסט שמסביר לאן הוא מוביל.',
    check: (_r, ctx) => ctx.all.filter((n) => n.tag === 'a' && 'href' in n.attrs && !accessibleName(n, ctx)),
  },
  {
    id: 'label', impact: 'critical', wcag: '1.3.1, 4.1.2',
    help: 'לכל שדה בטופס צריכה להיות תווית (label, aria-label או aria-labelledby). placeholder אינו תווית.',
    check: (_r, ctx) =>
      ctx.all.filter(
        (n) =>
          ((n.tag === 'input' && !NO_LABEL_INPUTS.has(n.attrs.type ?? 'text')) ||
            n.tag === 'select' ||
            n.tag === 'textarea' ||
            (['checkbox', 'switch', 'textbox', 'combobox', 'slider', 'radio'].includes(n.attrs.role ?? '') && n.tag !== 'input')) &&
          !hasLabel(n, ctx) && !(n.attrs.role && accessibleName(n, ctx)),
      ),
  },
  {
    id: 'aria-valid-role', impact: 'serious', wcag: '4.1.2',
    help: 'ערך role חייב להיות תפקיד ARIA תקין.',
    check: (_r, ctx) => ctx.all.filter((n) => n.attrs.role !== undefined && !n.attrs.role.split(/\s+/).every((r) => VALID_ROLES.has(r))),
  },
  {
    id: 'aria-refs', impact: 'serious', wcag: '1.3.1',
    help: 'aria-labelledby / aria-describedby / aria-controls חייבים להפנות למזהה שקיים בעמוד.',
    check: (_r, ctx) =>
      ctx.all.filter((n) =>
        ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-errormessage'].some((a) =>
          (n.attrs[a] ?? '').split(/\s+/).filter(Boolean).some((id) => !ctx.byId.has(id)),
        ),
      ),
  },
  {
    id: 'duplicate-id', impact: 'moderate', wcag: '4.1.1',
    help: 'מזהה (id) צריך להופיע פעם אחת בעמוד.',
    check: (_r, ctx) => [...ctx.byId.values()].filter((list) => list.length > 1).map((list) => list[1]),
  },
  {
    id: 'aria-hidden-focus', impact: 'serious', wcag: '4.1.2',
    help: 'אזור aria-hidden="true" לא יכיל רכיב שאפשר להגיע אליו במקלדת.',
    check: (_r, ctx) => ctx.all.filter((n) => isFocusable(n) && [n, ...ancestors(n)].some((a) => a.attrs['aria-hidden'] === 'true')),
  },
  {
    id: 'tabindex', impact: 'serious', wcag: '2.4.3',
    help: 'אין להשתמש ב-tabindex חיובי — הוא משבש את סדר המעבר במקלדת.',
    check: (_r, ctx) => ctx.all.filter((n) => n.attrs.tabindex !== undefined && Number(n.attrs.tabindex) > 0),
  },
  {
    id: 'dialog-name', impact: 'serious', wcag: '4.1.2',
    help: 'חלון (role="dialog") צריך שם — aria-labelledby או aria-label.',
    check: (_r, ctx) => ctx.all.filter((n) => ['dialog', 'alertdialog'].includes(n.attrs.role ?? '') && !accessibleName(n, ctx)),
  },
  {
    id: 'nested-interactive', impact: 'serious', wcag: '4.1.2',
    help: 'אין לשים רכיב אינטראקטיבי בתוך כפתור או קישור.',
    check: (_r, ctx) => ctx.all.filter((n) => isInteractive(n) && ancestors(n).some((a) => a.tag === 'button' || (a.tag === 'a' && 'href' in a.attrs))),
  },
  {
    id: 'listitem', impact: 'serious', wcag: '1.3.1',
    help: 'פריט רשימה (li) צריך להיות בתוך ul או ol.',
    check: (_r, ctx) => ctx.all.filter((n) => n.tag === 'li' && !['ul', 'ol', 'menu'].includes(n.parent?.tag ?? '') && n.parent?.attrs.role !== 'list'),
  },
  {
    id: 'form-error', impact: 'serious', wcag: '3.3.1',
    help: 'שדה שגוי (aria-invalid) צריך להפנות להודעת השגיאה (aria-describedby / aria-errormessage).',
    check: (_r, ctx) =>
      ctx.all.filter((n) => n.attrs['aria-invalid'] === 'true' && !n.attrs['aria-describedby'] && !n.attrs['aria-errormessage']),
  },
  {
    id: 'focus-visible', impact: 'serious', wcag: '2.4.7',
    help: 'רכיב שמבטל את מסגרת הפוקוס חייב להציג פוקוס אחר (focus-visible:ring / outline).',
    check: (_r, ctx) => ctx.all.filter((n) => {
      const cls = classList(n);
      return cls.some((c) => FOCUS_REMOVERS.includes(c)) && !drawsFocus(cls);
    }),
  },
  {
    id: 'motion-reduce', impact: 'serious', wcag: '2.3.3, 2.2.2',
    help: 'אנימציה צריכה להיות motion-safe: או לכבד את "הפחתת תנועה" (motion-reduce:).',
    check: (_r, ctx) => ctx.all.filter((n) => {
      const cls = classList(n);
      const animated = cls.some((c) => /^animate-(?!none)/.test(c));
      return animated && !cls.some((c) => c.startsWith('motion-reduce:'));
    }),
  },
  {
    id: 'color-contrast', impact: 'serious', wcag: '1.4.3',
    help: 'צבע טקסט ורקע (בסגנון המוטבע) צריכים ניגודיות של 4.5:1 לפחות.',
    check: (_r, ctx) => ctx.all.filter((n) => {
      const s = styleMap(n);
      if (!s.color || !(s['background-color'] || s.background)) return false;
      if (!textOf(n).trim()) return false;
      const ratio = contrastRatio(s.color, s['background-color'] || s.background);
      return ratio !== null && ratio + 1e-9 < 4.5;
    }),
  },
  {
    id: 'heading-order', impact: 'moderate', wcag: '1.3.1',
    help: 'רמות הכותרות יורדות בהדרגה (אחרי h1 בא h2, לא h3).',
    check: (_r, ctx) => {
      const out: A11yNode[] = [];
      let last = 0;
      for (const n of ctx.all) {
        const m = /^h([1-6])$/.exec(n.tag);
        if (!m) continue;
        const level = Number(m[1]);
        if (last && level > last + 1) out.push(n);
        last = level;
      }
      return out;
    },
  },
  {
    id: 'page-root', impact: 'serious', wcag: '3.1.1, 2.4.1',
    help: 'שורש עמוד ציבורי (data-public-root) צריך lang, dir ואזור main.',
    check: (_r, ctx) => ctx.all.filter((n) => 'data-public-root' in n.attrs &&
      (!n.attrs.lang || !['rtl', 'ltr'].includes(n.attrs.dir ?? '') || !elements(n).some((x) => x.tag === 'main' || x.attrs.role === 'main'))),
  },
  {
    id: 'rtl-logical', impact: 'moderate', wcag: '1.3.2',
    help: 'במקום שמאל/ימין פיזיים (ml-, pr-, text-left…) יש להשתמש ב-start/end (ms-, pe-, text-start…) כדי שהעמוד יעבוד ב-RTL וב-LTR.',
    check: (_r, ctx) => ctx.all.filter((n) => classList(n).some((c) => PHYSICAL.test(c))),
  },
];

export function ruleContext(root: A11yNode): RuleContext {
  const all = elements(root);
  const byId = new Map<string, A11yNode[]>();
  for (const n of all) {
    const id = n.attrs.id;
    if (id) byId.set(id, [...(byId.get(id) ?? []), n]);
  }
  return { all, byId };
}

export function runA11yRules(root: A11yNode, opts: { only?: string[]; exclude?: string[] } = {}): A11yResult {
  const ctx = ruleContext(root);
  const violations: A11yViolation[] = [];
  const passes: string[] = [];
  for (const rule of A11Y_RULES) {
    if (opts.only && !opts.only.includes(rule.id)) continue;
    if (opts.exclude?.includes(rule.id)) continue;
    const hits = rule.check(root, ctx);
    if (hits.length) {
      violations.push({ rule: rule.id, impact: rule.impact, wcag: rule.wcag, help: rule.help, count: hits.length, nodes: hits.slice(0, 5).map(describe) });
    } else {
      passes.push(rule.id);
    }
  }
  return { violations, passes };
}

export function blockingViolations(result: A11yResult): A11yViolation[] {
  return result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

/** The summary a publish request sends (the server's gate blocks critical / serious). */
export function toA11yReport(result: A11yResult): A11yReport {
  return {
    engine: 'runner-a11y',
    version: 1,
    violations: result.violations.map((v) => ({ rule: v.rule, impact: v.impact, count: v.count })),
  };
}

/**
 * The shared checklist for component tests: static markup (React's `renderToStaticMarkup`) → the
 * rule results. Every public template's test runs its renders through this (see
 * publicA11y.test.tsx) and expects no violation at all — warnings included.
 */
export function auditHtml(html: string, opts: { only?: string[]; exclude?: string[] } = {}): A11yResult {
  return runA11yRules(parseHtml(html), opts);
}

/**
 * An editor's pre-publish check: the live preview's DOM (with the real data) → the report its
 * publish request sends (`a11yReport`); the server's gate blocks critical / serious violations.
 */
export function auditDom(element: Parameters<typeof fromDom>[0]): { result: A11yResult; report: A11yReport } {
  const result = runA11yRules(fromDom(element));
  return { result, report: toA11yReport(result) };
}

/** One line per violation, for an assertion message. */
export function formatViolations(result: A11yResult): string {
  return result.violations.map((v) => `${v.impact} ${v.rule} ×${v.count}: ${v.nodes.join(' | ')}`).join('\n');
}
