/**
 * "אשף הקמת מוצר" — the ready-made preparations a new dish starts from: its "בלי" list,
 * its choices, its add-ons (with "הרבה / מעט / בצד" where that is how they are ordered)
 * and its quick notes. Everything here is only a starting point: the wizard shows it,
 * the manager edits it, and only what is left is created.
 */
import type { GroupKind } from './menuApi';

export interface WizardOption {
  name: string;
  price: number;
  /** The most of this option in one dish; null: the group's limit only. */
  maxQty: number | null;
  isDefault?: boolean;
  /** Also a product of its own in the catalog (sold alone too), linked to the option. */
  alsoProduct?: boolean;
  /** An existing product this option is (its stock and its kitchen follow it). */
  linkedProductId?: string | null;
}

export interface WizardGroup {
  key: string;
  name: string;
  kind: GroupKind;
  /** 1: must be answered before the dish is added ("חובה"). */
  minSelect: number;
  maxSelect: number | null;
  allowQuantity: boolean;
  /** Ordered "הרבה" / "מעט" / "בצד" — "הרבה חלב", "רוטב בצד". */
  allowPre: boolean;
  options: WizardOption[];
}

export type WizardTemplateId = 'burger' | 'coffee';

export interface WizardTemplate {
  id: WizardTemplateId;
  groups: WizardGroup[];
  notes: string[];
}

let seq = 0;
export const newKey = () => `g${Date.now().toString(36)}${(seq++).toString(36)}`;

const opt = (name: string, price = 0, extra: Partial<WizardOption> = {}): WizardOption => ({
  name, price, maxQty: null, ...extra,
});

/** The templates, named for the dish they were written for. */
export function wizardTemplate(id: WizardTemplateId): WizardTemplate {
  if (id === 'burger') {
    return {
      id,
      groups: [
        {
          key: newKey(), name: 'בלי', kind: 'removal', minSelect: 0, maxSelect: null,
          allowQuantity: false, allowPre: false,
          options: ['חסה', 'עגבנייה', 'בצל', 'חמוצים', 'רוטב', 'גבינה'].map((n) => opt(n)),
        },
        {
          key: newKey(), name: 'מידת עשייה', kind: 'choice', minSelect: 1, maxSelect: 1,
          allowQuantity: false, allowPre: false,
          options: [opt('מדיום', 0, { isDefault: true }), opt('מדיום-וול'), opt('וול דאן')],
        },
        {
          key: newKey(), name: 'רטבים', kind: 'addon', minSelect: 0, maxSelect: null,
          allowQuantity: false, allowPre: true,
          options: ['קטשופ', 'מיונז', 'איולי', 'צ׳ילי', 'ברביקיו'].map((n) => opt(n)),
        },
        {
          key: newKey(), name: 'תוספות להמבורגר', kind: 'addon', minSelect: 0, maxSelect: null,
          allowQuantity: true, allowPre: false,
          options: [
            opt('ביצת עין', 5, { maxQty: 2 }),
            opt('בייקון', 6, { maxQty: 2 }),
            opt('גבינה צהובה', 4, { maxQty: 2 }),
            opt('פטריות', 4, { maxQty: 2 }),
            opt('בצל מקורמל', 3, { maxQty: 2 }),
          ],
        },
      ],
      notes: ['להכין ראשון', 'חתוך לחצי', 'רוטב בצד', 'בלי מלח', 'עשוי היטב'],
    };
  }
  return {
    id,
    groups: [
      {
        key: newKey(), name: 'סוג חלב', kind: 'choice', minSelect: 1, maxSelect: 1,
        allowQuantity: false, allowPre: false,
        options: [opt('רגיל', 0, { isDefault: true }), opt('סויה'), opt('שקדים', 2), opt('שיבולת שועל', 2), opt('נטול לקטוז')],
      },
      {
        key: newKey(), name: 'חוזק', kind: 'choice', minSelect: 0, maxSelect: 1,
        allowQuantity: false, allowPre: false,
        options: [opt('חלש'), opt('רגיל', 0, { isDefault: true }), opt('חזק'), opt('כפול', 3)],
      },
      {
        key: newKey(), name: 'טמפרטורה', kind: 'choice', minSelect: 0, maxSelect: 1,
        allowQuantity: false, allowPre: false,
        options: [opt('רותח'), opt('רגיל', 0, { isDefault: true }), opt('פושר')],
      },
      {
        key: newKey(), name: 'תוספות לקפה', kind: 'addon', minSelect: 0, maxSelect: null,
        allowQuantity: false, allowPre: true,
        options: ['חלב', 'קצף', 'סוכר', 'סוכרזית', 'קינמון'].map((n) => opt(n)),
      },
      {
        key: newKey(), name: 'בלי', kind: 'removal', minSelect: 0, maxSelect: null,
        allowQuantity: false, allowPre: false,
        options: ['קצף', 'סוכר'].map((n) => opt(n)),
      },
    ],
    notes: ['בכוס זכוכית', 'בכוס חד פעמית', 'לקחת', 'על קרח', 'חלב בצד'],
  };
}

/** An empty group of [kind], to fill in. */
export function blankGroup(kind: GroupKind): WizardGroup {
  return {
    key: newKey(),
    name: kind === 'removal' ? 'בלי' : kind === 'choice' ? '' : 'תוספות',
    kind,
    minSelect: kind === 'choice' ? 1 : 0,
    maxSelect: kind === 'choice' ? 1 : null,
    allowQuantity: kind === 'addon',
    allowPre: false,
    options: [],
  };
}

/** What a word looks like on the kitchen ticket: "בלי חסה", "הרבה חלב", "רוטב בצד". */
export function preview(group: WizardGroup, option: WizardOption): string[] {
  if (group.kind === 'removal') return [`בלי ${option.name}`];
  if (group.allowPre) return [`מעט ${option.name}`, `הרבה ${option.name}`, `${option.name} בצד`];
  return [option.name];
}
