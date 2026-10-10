/**
 * "תצורת עבודה למכשיר" (pos-server docs/SPEC_DEVICE_WORK_CONFIG.md, server
 * app/services/work_config.py): a device's way of working in one place — named presets that
 * write the device-level values (they override the shop), each explained in plain Hebrew (Z,
 * tables, printing, no connection) before saving, and every value with where it comes from.
 *
 * The presets' fixed rules (`PRESET_RULES`) are the server's (`work_config.static_table`), pinned
 * by the shared golden file server/tests/fixtures/work_config_presets_golden.json. Which preset
 * a device may take now, and why not, is the server's answer (`presets[]`). Pure — `npm test`
 * compiles it alone; the calls are in lib/workConfigApi.ts.
 */

export type WorkPresetId =
  | 'shop_z_cloud'
  | 'main_till'
  | 'lan_member'
  | 'remote_shop_z'
  | 'independent'
  | 'own_z'
  | 'kiosk_shop_z'
  | 'kiosk_own_z'
  | 'kds_screen'
  | 'ready_board';

export type WorkRole = 'till' | 'kiosk' | 'kds' | 'order_status_board';

/** A device-level value removed: it inherits again ("חזרה לירושה"). */
export const INHERIT = 'inherit';
/** Not a preset: nothing set on the device — what the shop gives ("לפי הסניף"). */
export const BY_SHOP = 'by_shop';

export const TABLES_OFF = 'כבוי';
export const TABLES_SINGLE = 'קופה אחת';
export const TABLES_SYNCED = 'מסונכרן בין הקופות';
export const TABLES_LAN = 'רשת מקומית (קופה ראשית)';

export interface PresetRule {
  id: WorkPresetId;
  role: WorkRole;
  zMode: 'cloud' | 'till' | null;
  independent: boolean | null;
  /** "מרוחק (דרך הענן)": never, always, or the operator's choice (a kiosk). */
  remote: 'no' | 'yes' | 'option';
  /** true: becomes the shop's main till; false: must not be it; null: not a till. */
  mainTill: boolean | null;
  /** "לא משמש כשרת מקומי": as it is, forced on / off, or the operator's choice. */
  lanServerExcluded: 'keep' | 'on' | 'off' | 'option';
  lanServerExcludedDefault: boolean | null;
  /** The tables choices at the device's level (`inherit` first when inheriting is allowed). */
  tables: string[];
  tablesDefault: string | null;
  /** true: the shop's "רשת מקומית" must be on; false: off; null: either. */
  needsLocalNetwork: boolean | null;
  /** Needs a LAN client — an Android device. */
  lanClientOnly: boolean;
  display: boolean;
}

/** The server's table, as is (the golden file). */
export const PRESET_RULES: PresetRule[] = [
  {
    id: 'shop_z_cloud', role: 'till', zMode: 'cloud', independent: false, remote: 'no', mainTill: false,
    lanServerExcluded: 'keep', lanServerExcludedDefault: null, tables: [INHERIT, TABLES_SYNCED, TABLES_SINGLE],
    tablesDefault: INHERIT, needsLocalNetwork: false, lanClientOnly: false, display: false,
  },
  {
    id: 'main_till', role: 'till', zMode: 'cloud', independent: false, remote: 'no', mainTill: true,
    lanServerExcluded: 'off', lanServerExcludedDefault: null, tables: [INHERIT], tablesDefault: INHERIT,
    needsLocalNetwork: true, lanClientOnly: true, display: false,
  },
  {
    id: 'lan_member', role: 'till', zMode: 'cloud', independent: false, remote: 'no', mainTill: false,
    lanServerExcluded: 'option', lanServerExcludedDefault: null,
    tables: [INHERIT, TABLES_LAN, TABLES_SINGLE, TABLES_OFF], tablesDefault: INHERIT,
    needsLocalNetwork: true, lanClientOnly: true, display: false,
  },
  {
    id: 'remote_shop_z', role: 'till', zMode: 'cloud', independent: false, remote: 'yes', mainTill: false,
    lanServerExcluded: 'on', lanServerExcludedDefault: null, tables: [TABLES_OFF, TABLES_SINGLE],
    tablesDefault: TABLES_OFF, needsLocalNetwork: true, lanClientOnly: false, display: false,
  },
  {
    id: 'independent', role: 'till', zMode: 'till', independent: true, remote: 'no', mainTill: false,
    lanServerExcluded: 'keep', lanServerExcludedDefault: null, tables: [TABLES_OFF, TABLES_SINGLE],
    tablesDefault: TABLES_OFF, needsLocalNetwork: null, lanClientOnly: false, display: false,
  },
  {
    id: 'own_z', role: 'till', zMode: 'till', independent: false, remote: 'no', mainTill: false,
    lanServerExcluded: 'option', lanServerExcludedDefault: null,
    tables: [INHERIT, TABLES_OFF, TABLES_SINGLE, TABLES_SYNCED, TABLES_LAN], tablesDefault: INHERIT,
    needsLocalNetwork: null, lanClientOnly: false, display: false,
  },
  {
    id: 'kiosk_shop_z', role: 'kiosk', zMode: 'cloud', independent: false, remote: 'option', mainTill: false,
    lanServerExcluded: 'option', lanServerExcludedDefault: true, tables: [], tablesDefault: null,
    needsLocalNetwork: null, lanClientOnly: false, display: false,
  },
  {
    id: 'kiosk_own_z', role: 'kiosk', zMode: 'till', independent: true, remote: 'no', mainTill: false,
    lanServerExcluded: 'keep', lanServerExcludedDefault: null, tables: [], tablesDefault: null,
    needsLocalNetwork: null, lanClientOnly: false, display: false,
  },
  {
    id: 'kds_screen', role: 'kds', zMode: null, independent: null, remote: 'no', mainTill: null,
    lanServerExcluded: 'keep', lanServerExcludedDefault: null, tables: [], tablesDefault: null,
    needsLocalNetwork: null, lanClientOnly: false, display: true,
  },
  {
    id: 'ready_board', role: 'order_status_board', zMode: null, independent: null, remote: 'no', mainTill: null,
    lanServerExcluded: 'keep', lanServerExcludedDefault: null, tables: [], tablesDefault: null,
    needsLocalNetwork: null, lanClientOnly: false, display: true,
  },
];

export const PRESET_LABELS: Record<WorkPresetId, string> = {
  shop_z_cloud: 'קופה בזד סניפי — ענן',
  main_till: 'קופה ראשית (שרת מקומי)',
  lan_member: 'קופה ברשת המקומית',
  remote_shop_z: 'קופה מרוחקת בזד הסניפי',
  independent: 'קופה עצמאית',
  own_z: 'Z בקופה, בתוך הסניף',
  kiosk_shop_z: 'קיוסק בזד סניפי',
  kiosk_own_z: 'קיוסק עם Z משלו',
  kds_screen: 'מסך KDS',
  ready_board: 'מסך מוכן',
};

/** One line under each preset: when it is the right one. */
export const PRESET_HINTS: Record<WorkPresetId, string> = {
  shop_z_cloud: 'סניף בלי שרת מקומי: כל קופה מסתנכרנת מול הענן, ו-Z אחד לכל הסניף.',
  main_till: 'הקופה שכל הסניף נשען עליה ברשת: שולחנות, הדפסות ו-Z סניפי — גם בלי אינטרנט.',
  lan_member: 'קופה רגילה בסניף שעובד עם שרת מקומי: נשענת על הקופה הראשית ברשת.',
  remote_shop_z: 'במקום אחר (או בלי רשת הסניף): חלק מה-Z הסניפי, אבל מסתנכרנת לבד מול הענן.',
  independent: 'Z ומספור משלה, מחוץ ל-Z הסניפי ומחוץ לרשת המקומית.',
  own_z: 'Z משלה, אבל נשארת ברשת המקומית (שולחנות והדפסות דרך הסניף).',
  kiosk_shop_z: 'הקיוסק נכלל ב-Z של הסניף; בסוף היום רק סגירת משמרת.',
  kiosk_own_z: 'הקיוסק מפיק Z עצמאי משלו.',
  kds_screen: 'מסך מטבח — לא קופה.',
  ready_board: 'מסך מספרי הזמנות בהכנה / מוכנות — לא קופה.',
};

export const WORKFLOW_TARGET_LABELS: Record<string, string> = {
  printer: 'מדפסת',
  kds: 'KDS',
  kds_view: 'KDS לצפייה',
  expo: 'Expo',
  pickup_screen: 'מסך איסוף',
};

export function ruleOf(id: string | null | undefined): PresetRule | null {
  return PRESET_RULES.find((r) => r.id === id) ?? null;
}

export function presetsForRole(role: string | null | undefined): PresetRule[] {
  return PRESET_RULES.filter((r) => r.role === (role || 'till'));
}

// ── The server's view ────────────────────────────────────────────────────────

export type ValueSource =
  | 'machine'
  | 'device'
  | 'area'
  | 'shop'
  | 'company'
  | 'default'
  | 'none'
  | 'inactive'
  | 'inherited'
  | 'independent'
  | 'auto'
  | 'fixed';

export interface ParamValue<T = unknown> {
  value: T;
  source: ValueSource | string;
  own?: T | null;
  inherited?: T | null;
  inheritedSource?: ValueSource | string | null;
  options?: string[] | null;
  label?: string | null;
}

export interface PresetAvailability {
  id: WorkPresetId;
  label: string;
  available: boolean;
  reason: string | null;
  message: string | null;
  turnsOnLocalNetwork?: boolean;
  movesMainTillFrom?: { machineId: string; posNumber?: string | null; name?: string | null } | null;
}

export interface WorkConfigView {
  machineId: string | null;
  shopId: string | null;
  role: WorkRole | string;
  platform: string;
  fiscal: boolean;
  canEdit: boolean;
  canEditPrinting: boolean;
  shop: {
    name?: string | null;
    localNetwork: boolean;
    localMode: boolean;
    mainTill: { machineId: string; posNumber?: string | null; name?: string | null } | null;
  } | null;
  currentPreset: WorkPresetId | null;
  inheritedPreset: WorkPresetId;
  isInherited: boolean;
  values: {
    zMode: ParamValue<'cloud' | 'till'>;
    independent: ParamValue<boolean>;
    link: ParamValue<'lan' | 'remote'> & { applies?: boolean };
    mainTill: ParamValue<boolean>;
    lanServerExcluded: ParamValue<boolean> & { suggested?: boolean; applies?: boolean };
    tablesMode: ParamValue<string | null>;
    receiptPrinter: ParamValue<string | null> | null;
    workflowTargets: ParamValue<string[]> | null;
    workflowEnabled?: boolean;
  };
  presets: PresetAvailability[];
  pairing?: PairingOutcome | null;
  changes?: string[];
}

export interface PairingOutcome {
  preset: WorkPresetId | null;
  plan: Record<string, unknown> | null;
  applied: boolean | null;
  changes?: string[];
  detail?: string | null;
  message?: string | null;
  at?: string | null;
}

// ── Where a value comes from ─────────────────────────────────────────────────

/** "נקבע במכשיר" / "לפי הסניף" / "לפי החברה"… */
export function sourceLabel(source: string | null | undefined): string {
  switch (source) {
    case 'machine':
    case 'device':
      return 'נקבע במכשיר';
    case 'area':
      return 'לפי נקודת המכירה';
    case 'shop':
    case 'inherited':
      return 'לפי הסניף';
    case 'company':
      return 'לפי החברה';
    case 'default':
      return 'ברירת מחדל';
    case 'independent':
      return 'קופה עצמאית — רק מרמת המכשיר';
    case 'auto':
      return 'אוטומטי (מסך מטבח)';
    case 'fixed':
      return 'קבוע (Windows)';
    case 'inactive':
      return 'הפרמטר כבוי';
    default:
      return 'לא נקבע';
  }
}

/** Set on the device itself — "חזרה לירושה" may take it back. */
export function isOwn(source: string | null | undefined): boolean {
  return source === 'machine' || source === 'device';
}

export function tablesChoiceLabel(choice: string, inherited?: string | null): string {
  if (choice === INHERIT) return inherited ? `לפי הסניף (${inherited})` : 'לפי הסניף';
  return choice;
}

export function targetsText(targets: string[] | null | undefined): string {
  if (!targets || !targets.length) return '—';
  return targets.map((t) => WORKFLOW_TARGET_LABELS[t] ?? t).join(' · ');
}

// ── The draft the editor holds ───────────────────────────────────────────────

export interface WorkConfigDraft {
  /** A preset, or `by_shop` — nothing set ("לפי הסניף"). */
  preset: WorkPresetId | typeof BY_SHOP;
  tablesMode: string | null;
  lanServerExcluded: boolean | null;
  link: 'lan' | 'remote';
  enableLocalNetwork: boolean;
  /** "מתקדם": null — untouched; `inherit` — back to the shop's. */
  receiptPrinter: string | null;
  workflowTargets: string[] | typeof INHERIT | null;
}

export const EMPTY_DRAFT: WorkConfigDraft = {
  preset: BY_SHOP,
  tablesMode: null,
  lanServerExcluded: null,
  link: 'lan',
  enableLocalNetwork: false,
  receiptPrinter: null,
  workflowTargets: null,
};

/**
 * The editor's starting point for a preset: the device's own values where the preset offers
 * them, else the preset's defaults (a new device: the defaults).
 */
export function draftFor(
  id: WorkPresetId | typeof BY_SHOP,
  view: Pick<WorkConfigView, 'values' | 'shop'> | null,
  base: WorkConfigDraft = EMPTY_DRAFT,
): WorkConfigDraft {
  const rule = ruleOf(id);
  const out: WorkConfigDraft = { ...base, preset: id, tablesMode: null, lanServerExcluded: null, enableLocalNetwork: false };
  if (!rule) return out;
  if (rule.tables.length) {
    const own = view?.values.tablesMode?.own ?? null;
    out.tablesMode =
      own != null && rule.tables.includes(own)
        ? own
        : own == null && rule.tables.includes(INHERIT)
          ? INHERIT
          : rule.tablesDefault;
  }
  if (rule.lanServerExcluded === 'option') {
    // Set on the device: as it is. Else the preset's default (a kiosk: on), else the suggestion
    // (a kiosk / a handheld) or what it reads now (a till showing a KDS screen).
    const flag = view?.values.lanServerExcluded;
    out.lanServerExcluded =
      flag && isOwn(flag.source)
        ? !!flag.value
        : rule.lanServerExcludedDefault ?? (!!flag?.suggested || !!flag?.value);
  }
  if (rule.remote === 'option') out.link = view?.values.link?.value === 'remote' ? 'remote' : 'lan';
  if (rule.id === 'main_till') out.enableLocalNetwork = !(view?.shop?.localNetwork ?? false);
  return out;
}

/**
 * The plan to send (`PUT /machines/{id}/work-config`, or a pairing code's `workConfig`).
 * `by_shop`: on a device — back to the shop's default (`preset: "inherit"`); when adding one —
 * nothing (the new device is that already). Null when nothing is to be sent.
 */
export function planOf(d: WorkConfigDraft, mode: 'device' | 'pairing'): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  const rule = ruleOf(d.preset);
  if (d.preset === BY_SHOP) {
    if (mode === 'device') body.preset = INHERIT;
    // "מתקדם": the tables at the device's level, the rest as the shop gives it.
    if (d.tablesMode) body.tablesMode = d.tablesMode;
  } else if (rule) {
    body.preset = rule.id;
    if (rule.tables.length && d.tablesMode) body.tablesMode = d.tablesMode;
    if (rule.lanServerExcluded === 'option' && d.lanServerExcluded !== null) body.lanServerExcluded = d.lanServerExcluded;
    if (rule.remote === 'option') body.link = d.link;
    if (rule.id === 'main_till' && d.enableLocalNetwork) body.enableLocalNetwork = true;
  }
  if (d.receiptPrinter !== null) body.receiptPrinter = d.receiptPrinter;
  if (d.workflowTargets !== null) body.workflowTargets = d.workflowTargets;
  return Object.keys(body).length ? body : null;
}

/** A shop manager's part of a plan: the receipt printer and the KDS targets. Null when empty. */
export function printingOnly(plan: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!plan) return null;
  const out: Record<string, unknown> = {};
  for (const k of ['receiptPrinter', 'workflowTargets']) if (k in plan) out[k] = plan[k];
  return Object.keys(out).length ? out : null;
}

/** Changes only the super admin makes (the server refuses anyone else): the Z, the LAN, the tables. */
export function needsSuperAdmin(plan: Record<string, unknown> | null): boolean {
  if (!plan) return false;
  return ['preset', 'tablesMode', 'lanServerExcluded', 'link', 'enableLocalNetwork'].some((k) => k in plan);
}

/** What the editor must still get before saving; null when nothing is missing. */
export function draftError(d: WorkConfigDraft, view: Pick<WorkConfigView, 'shop'> | null): string | null {
  const rule = ruleOf(d.preset);
  // Without the view (the dialog's footer) only what the draft alone tells; the server checks the rest.
  if (rule?.id === 'main_till' && view && !(view.shop?.localNetwork ?? false) && !d.enableLocalNetwork) {
    return 'קופה ראשית מפעילה את "רשת מקומית" בסניף — סמנו את האפשרות כדי להמשיך.';
  }
  if (Array.isArray(d.workflowTargets) && d.workflowTargets.length === 0) return 'בחרו לפחות יעד KDS אחד.';
  return null;
}

// ── What a preset means, in plain Hebrew ─────────────────────────────────────

export interface Meaning {
  z: string;
  tables: string;
  printing: string;
  offline: string;
  /** What changes for the whole shop (amber in the editor). */
  shop: string[];
}

export interface MeaningContext {
  localNetwork: boolean;
  /** "לפי הסניף" of the tables, as the shop gives it. */
  inheritedTables?: string | null;
  /** The shop's main till now, if another device. */
  mainTillLabel?: string | null;
}

function tablesText(choice: string | null, inherited?: string | null): string {
  switch (choice) {
    case TABLES_OFF:
      return 'כבוי — אין שולחנות במכשיר.';
    case TABLES_SINGLE:
      return 'קופה אחת — שולחנות של המכשיר הזה בלבד, עובדים גם בלי אינטרנט.';
    case TABLES_SYNCED:
      return 'מסונכרן בין הקופות — אותם שולחנות בכל הקופות דרך הענן (צריך אינטרנט כדי לפתוח שולחן).';
    case TABLES_LAN:
      return 'רשת מקומית — השולחנות נשמרים בקופה הראשית ועובדים מולה ברשת, גם בלי אינטרנט.';
    case INHERIT:
    case null:
      return inherited ? `לפי הסניף — היום: ${inherited}.` : 'לפי הסניף.';
    default:
      return choice;
  }
}

export function presetMeaning(id: WorkPresetId | typeof BY_SHOP, d: WorkConfigDraft, ctx: MeaningContext): Meaning {
  const tables = tablesText(d.tablesMode, ctx.inheritedTables);
  const notServer = d.lanServerExcluded
    ? ' לעולם לא ישמש כשרת המקומי של הסניף ("לא משמש כשרת מקומי"); מדפסת שמחוברת אליו עדיין מדפיסה לכולם.'
    : '';
  switch (id) {
    case 'shop_z_cloud':
      return {
        z: 'Z סניפי: המשמרות שלו נכללות ב-Z אחד של כל הסניף, שמופק בענן.',
        tables,
        printing: 'מדפיס בעצמו, או דרך שרת ההדפסות של הסניף לפי הגדרות המדפסות.',
        offline: 'בלי אינטרנט ממשיך למכור ושומר את המסמכים; הם עולים לענן כשהחיבור חוזר, וה-Z הסניפי מחכה להם.',
        shop: [],
      };
    case 'main_till': {
      const shop: string[] = [];
      if (ctx.mainTillLabel) shop.push(`${ctx.mainTillLabel} תפסיק להיות הקופה הראשית של הסניף.`);
      if (!ctx.localNetwork) shop.push('יופעל "רשת מקומית" בסניף: מעכשיו ה-Z הסניפי מופק בקופה הזו ולא בענן.');
      return {
        z: 'מפיקה את ה-Z הסניפי של כל הסניף ברשת המקומית — גם בלי אינטרנט — וסוגרת בו את המשמרות של שאר הקופות.',
        tables: 'שרת השולחנות של הסניף: במצב «רשת מקומית (קופה ראשית)» כל השולחנות וההזמנות נשמרים בה.',
        printing: 'שרת ההדפסות של הסניף: שאר הקופות שולחות אליה בונים והיא מדפיסה אותם, גם בלי אינטרנט.',
        offline: 'הסניף ממשיך לעבוד מולה בלי אינטרנט (שולחנות, הדפסות, Z סניפי); היא מעדכנת את הענן בזמן אמת כשיש חיבור.',
        shop,
      };
    }
    case 'lan_member':
      return {
        z: 'Z סניפי: הקופה הראשית סוגרת את המשמרת שלה ברשת המקומית, ב-Z אחד לכל הסניף.',
        tables,
        printing: `מדפיס דרך שרת ההדפסות של הסניף ברשת.${notServer}`,
        offline: 'בלי אינטרנט ממשיך לעבוד מול הקופה הראשית ברשת המקומית. בלי רשת מקומית — ה-Z הסניפי מחכה לו.',
        shop: [],
      };
    case 'remote_shop_z':
      return {
        z: 'Z סניפי, אבל לא ברשת המקומית: כשהקופה הראשית מפיקה Z היא מבקשת דרך הענן, המכשיר סוגר את המשמרת שלו ושולח את החלק שלו — וה-Z הסניפי מחכה לו.',
        tables,
        printing: 'מדפיס בעצמו; בונים למטבח של הסניף עוברים דרך הענן לשרת ההדפסות. לא משמש כשרת מקומי.',
        offline: 'בלי אינטרנט ממשיך למכור; ה-Z הסניפי ימתין לו עד שיתחבר לענן ויסגור.',
        shop: [],
      };
    case 'independent':
      return {
        z: 'Z משלו ובמספור משלו (רצף חדש מ-Z 1). לא חלק מה-Z הסניפי ולא נסגר על ידי הקופה הראשית.',
        tables,
        printing: 'מדפיס בעצמו — לא משתמש בשרת ההדפסות של הסניף ולא משמש כשרת.',
        offline: 'Z בלי חיבור — לפי "סגירת Z ללא חיבור לענן"; אחרת ה-Z מחכה לחיבור.',
        shop: [],
      };
    case 'own_z':
      return {
        z: 'Z משלו (במספור של הקופה), מחוץ ל-Z הסניפי — אבל נשאר ברשת המקומית של הסניף.',
        tables,
        printing: `מדפיס דרך שרת ההדפסות של הסניף.${notServer}`,
        offline: 'Z בלי חיבור — לפי "סגירת Z ללא חיבור לענן"; השולחנות וההדפסות ממשיכים ברשת.',
        shop: [],
      };
    case 'kiosk_shop_z':
      return {
        z:
          'חלק מה-Z הסניפי: בסוף היום רק "סגירת משמרת", וה-Z של הסניף כולל אותו' +
          (ctx.localNetwork
            ? d.link === 'remote'
              ? ' — נסגר דרך הענן (מרוחק).'
              : ' — הקופה הראשית סוגרת אותו ברשת.'
            : '.'),
        tables: 'אין שולחנות בקיוסק.',
        printing: `בון ומספר איסוף במדפסת שלו או במדפסות המטבח.${notServer}`,
        offline: 'ההזמנות והמסמכים נשמרים בקיוסק ועולים לענן כשהחיבור חוזר.',
        shop: [],
      };
    case 'kiosk_own_z':
      return {
        z: 'Z עצמאי: "הפקת Z" לקיוסק בלבד, במספור משלו; לא חלק מה-Z הסניפי.',
        tables: 'אין שולחנות בקיוסק.',
        printing: 'מדפיס בעצמו; בונים למטבח — ישירות, או דרך הענן לשרת ההדפסות של הסניף.',
        offline: 'ההזמנות והמסמכים נשמרים בקיוסק ועולים לענן כשהחיבור חוזר.',
        shop: [],
      };
    case 'kds_screen':
      return {
        z: 'לא קופה: אין מכירות, משמרות, Z או תשלומים.',
        tables: '—',
        printing: 'מציג את ההזמנות לפי העמדות (מגדירים בעמוד מסכי המטבח).',
        offline: 'מקבל את ההזמנות מהענן; כשהמסך לא זמין הקופות מדפיסות את הבון במדפסות הגיבוי (אם מוגדר).',
        shop: [],
      };
    case 'ready_board':
      return {
        z: 'לא קופה: אין מכירות, משמרות, Z או תשלומים.',
        tables: '—',
        printing: 'מציג מספרי הזמנות בהכנה ומוכנות לאיסוף.',
        offline: 'מתעדכן מהענן; בלי חיבור המסך לא מתעדכן.',
        shop: [],
      };
    default:
      return {
        z: 'לפי הסניף: בזד הסניפי, כמו כל מכשיר חדש בסניף.',
        tables: tablesText(null, ctx.inheritedTables),
        printing: 'לפי הגדרות המדפסות של הסניף.',
        offline: ctx.localNetwork
          ? 'הסניף עובד ברשת מקומית: בלי אינטרנט ממשיך מול הקופה הראשית.'
          : 'בלי אינטרנט ממשיך למכור; המסמכים עולים לענן כשהחיבור חוזר.',
        shop: [],
      };
  }
}

/** The pairing's outcome as the dialog / the device page say it. */
export function pairingOutcomeText(o: PairingOutcome | null | undefined): { tone: 'ok' | 'bad'; text: string } | null {
  if (!o || o.applied == null) return null;
  const name = o.preset ? PRESET_LABELS[o.preset] ?? o.preset : 'ההגדרות שנבחרו';
  if (o.applied) return { tone: 'ok', text: `תצורת העבודה "${name}" הוחלה על המכשיר.` };
  return { tone: 'bad', text: `תצורת העבודה "${name}" שנבחרה בהוספה לא הוחלה: ${o.message ?? 'סיבה לא ידועה'}` };
}
