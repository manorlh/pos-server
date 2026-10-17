/**
 * "עיצובים שמורים לקיוסק" — the design groups (pos-server app/services/kiosk_designs.py GROUPS, the same ids,
 * order and paths; server/tests/test_kiosk_designs.py compares them). Pure: no imports.
 */
type Layer = Record<string, unknown>;

/** The server's GROUPS (app/services/kiosk_designs.py), same ids and order. */
export type KioskDesignGroupId = 'look' | 'layout' | 'landscape' | 'attract' | 'texts' | 'motion' | 'sizes' | 'flow' | 'ticker';

export interface KioskDesignGroup {
  id: KioskDesignGroupId;
  label: string;
  hint: string;
  paths: string[];
  default: boolean;
}

/** The catalogue as the server sends it (`groups`), with this copy for before it answers. */
export const KIOSK_DESIGN_GROUPS: KioskDesignGroup[] = [
  { id: 'look', label: 'מראה וצבעים', hint: 'סגנון ממשק, צבעים, גופן, רקע, לוגו, תמונות מסכים ותמונות מחלקות.', paths: ['theme', 'screenImages', 'payment.waitLogo', 'catalog.categoryImages', 'catalog.categoryIconIds', 'catalog.categoryImagesFromCatalog'], default: true },
  { id: 'layout', label: 'מבנה הקיוסק', hint: 'תבנית, תפריט, כרטיס מוצר, סל, הוספה מהירה ומסך סיום.', paths: ['layout'], default: true },
  { id: 'landscape', label: 'עיצוב לרוחב', hint: 'ההגדרות שחלות רק כשהמסך לרוחב.', paths: ['landscape'], default: true },
  { id: 'attract', label: 'מסך פתיחה', hint: 'סרטונים ותמונות, כפתור "הזמינו כאן", ברוכים הבאים וזמן לכל שקופית.', paths: ['attract', 'timers.attractSlideSec'], default: true },
  { id: 'texts', label: 'טקסטים', hint: 'כל הטקסטים ללקוח בכל השפות והודעת הסיום.', paths: ['texts', 'textsByLang', 'success'], default: true },
  { id: 'motion', label: 'הנפשות', hint: 'מנוע ההנפשות, מהירות ומעברים.', paths: ['motion'], default: true },
  { id: 'sizes', label: 'גדלים', hint: 'גודל כרטיסי לקחת / לשבת.', paths: ['general.serviceCardSize', 'general.serviceIconSize', 'general.serviceCardMaxWidth', 'general.serviceCardHeight'], default: true },
  { id: 'flow', label: 'זרימה', hint: 'דילוג על הסל, מיקום ואופן בחירת לקחת / לשבת, חיפוש, מחלקה אחת בכל פעם ודילוג על בחירת אמצעי תשלום.', paths: ['general.skipCart', 'general.servicePlacement', 'general.serviceSelect', 'general.searchEnabled', 'catalog.oneCategory', 'payment.paymentChooserSkip'], default: true },
  { id: 'ticker', label: 'כיתוב רץ', hint: 'הכיתוב הרץ, מיקומו וצבעיו.', paths: ['ticker'], default: false },
];

export const DEFAULT_DESIGN_GROUPS: KioskDesignGroupId[] = KIOSK_DESIGN_GROUPS.filter((g) => g.default).map((g) => g.id);

/** The editor's sections a design can hold something in (the rest is operational and never saved in one). */
export const DESIGN_SECTION_GROUPS: Record<string, KioskDesignGroupId[]> = {
  general: ['sizes', 'flow'],
  appearance: ['look', 'layout', 'landscape'],
  texts: ['texts'],
  motion: ['motion'],
  attract: ['attract'],
  catalog: ['look', 'flow'],
  messages: ['texts', 'ticker'],
};

export function designSections(groups: readonly string[]): string[] {
  return Object.entries(DESIGN_SECTION_GROUPS)
    .filter(([, gs]) => gs.some((g) => groups.includes(g)))
    .map(([key]) => key);
}

/** Only the groups' paths of a layer — what the server keeps of it. */
export function pickDesignLayer(layer: Layer, groups: readonly string[]): Layer {
  const out: Record<string, unknown> = {};
  for (const g of KIOSK_DESIGN_GROUPS) {
    if (!groups.includes(g.id)) continue;
    for (const path of g.paths) {
      const keys = path.split('.');
      let node: unknown = layer;
      for (const k of keys) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[k] : undefined;
      if (node === undefined || node === null) continue;
      let target = out;
      for (const k of keys.slice(0, -1)) {
        target[k] = (target[k] as Record<string, unknown>) ?? {};
        target = target[k] as Record<string, unknown>;
      }
      target[keys[keys.length - 1]] = node;
    }
  }
  return out;
}

