/**
 * "ניהול קטלוג" on the Windows till — pos-android domain/CatalogAdmin.kt, ui/catalogadmin/AdminProductFilter.kt,
 * CatalogAdminScreen.kt / ViewModel's rules, MachineCatalogViewModel.kt (P:/specs/till-catalog-management.md): the four
 * parameters, what the screen lists (the cloud's `catalogAdminView`, else auto: the till's menu, else the shop), the row tags,
 * the one filter row (state, channel, categories with counts, "הצג גם מוצרים שלא בתחום"), each action's gate decided before
 * the tap (allowed / "באישור מנהל" / hidden / greyed with the reason), the product page's diff (only what changed is sent —
 * the price alone is CATALOG_PRICE, anything else CATALOG_EDIT), the availability levels, "קטלוג למסוף" (this till's own list)
 * and the picture rules. Pure: the service (main/till/tillCatalogAdmin.ts) does the I/O, the screen draws the state.
 * Every Hebrew line is the Android till's (res/values/strings*.xml), word for word.
 */

import { decideSoldOut, itemBlocksOf, rowAvailable } from '@dash-lib/kioskSoldOut';
import { formatShekelSign, ofShekels } from '../money';
import { applyMenu, menuOf, resolveTillMenu, type MenuInput } from './menus';
import type { PriceLevel } from './tillPriceLevel';

/* ------------------------------------------------------------------------------------------------------------ words */

export const CATALOG_ADMIN_TEXT = {
  title: 'ניהול קטלוג',
  products: 'מוצרים',
  categories: 'קטגוריות',
  addProduct: 'מוצר חדש',
  addCategory: 'קטגוריה חדשה',
  editCategory: 'עריכת קטגוריה',
  fieldName: 'שם',
  fieldPrice: 'מחיר',
  fieldCategory: 'קטגוריה',
  fieldBarcode: 'ברקוד',
  fieldSku: 'מק״ט',
  fieldDescription: 'תיאור',
  fieldStock: 'כמות במלאי',
  fieldOpenPrice: 'מחיר פתוח (הקופאי מקליד סכום)',
  fieldWeighed: 'נמכר במשקל',
  fieldUnit: 'יחידת מידה',
  fieldPrintTicket: 'הדפס שובר (שובר לכל יחידה)',
  skuAuto: 'יוקצה אוטומטית בשמירה',
  pickCategory: 'בחרו קטגוריה',
  noCategories: 'אין קטגוריות. צרו קטגוריה קודם.',
  save: 'שמירה',
  saving: 'שומר…',
  saved: 'נשמר',
  close: 'סגור',
  cancel: 'ביטול',
  back: 'חזרה',
  search: 'חיפוש לפי שם, ברקוד או מק״ט',
  clear: 'נקה',
  more: 'עוד',
  empty: 'אין מוצרים להצגה',
  nameRequired: 'צריך שם',
  priceInvalid: 'מחיר לא תקין',
  categoryRequired: 'צריך לבחור קטגוריה',
  sharedReadonly: 'המוצר נמכר גם בסניפים אחרים, ולכן אפשר לשנות כאן רק מחיר וזמינות.',
  needsNetwork: 'ניהול קטלוג דורש חיבור לענן, כי הענן הוא מקור האמת.',
  activeButton: 'פעיל / לא פעיל',
  activeSaved: 'עודכן — הקופות יסתנכרנו',
  inactiveTag: 'לא פעיל',
  scopeAction: 'פעולה',
  scopeWhere: 'היכן',
  scopeMachine: 'בקופה זו',
  scopeArea: 'בנקודת המכירה',
  scopeShop: 'בכל הסניף',
  scopeNoArea: '(הקופה אינה משויכת לנקודת מכירה)',
  makeInactive: 'הפוך ללא פעיל',
  makeActive: 'הפוך לפעיל',
  makeInherit: 'החזר לברירת המחדל (לפי הרמה שמעל)',
  permanent: 'חסימה קבועה',
  permanentHint: 'לא תיפתח אוטומטית אחרי Z, גם כשההגדרה בענן פותחת פריטים',
  ticketOverrides: (mode: string) => `גובר על ההגדרה בענן (${mode}) — הפריט יעודכן בענן בשמירה.`,
  ticketConfirmTitle: 'שינוי הגדרת שובר',
  ticketConfirmOn: (mode: string) =>
    `בענן מוגדר לפריט: ${mode}. הפעלה כאן תגבור על ההגדרה בענן — הפריט יעודכן בענן לשובר לכל יחידה, וההגדרה הקודמת (כולל זו של המחלקה) לא תחול עליו יותר. להמשיך?`,
  ticketConfirmOff: (mode: string) => `בענן מוגדר לפריט: ${mode}. כיבוי כאן יגבור על ההגדרה בענן — הפריט יעודכן בענן ללא שובר, גם אם המחלקה שלו מדפיסה שוברים. להמשיך?`,
  ticketConfirmGo: 'כן, עדכן',
  ticketModeOff: 'ללא שובר',
  ticketModeUnit: 'שובר לכל יחידה',
  ticketModeLine: 'שובר לכל פריט',
  ticketModeSale: 'שובר אחד לעסקה',
  notAllowed: 'אין הרשאה לפעולה הזו',
  availabilityRefused: 'הענן סירב לשינוי הזמינות — הקופה חזרה למצב שבענן',
  availabilityQueued: 'נשמר בקופה ויישלח לענן כשתחזור הרשת',
  bulkPartial: (ok: number, failed: number) => `עודכנו ${ok}, לא עודכנו ${failed} (מוצר משותף או שגיאה)`,
  selectedCount: (n: number) => `${n} נבחרו`,
  scopeLine: (label: string, n: number) => `${label} · ${n} מוצרים`,
  selectMany: 'בחירת כמה מוצרים',
  scopeShopLabel: 'קטלוג הסניף',
  scopeTillLabel: 'מוצרי הקופה',
  scopeMenuLabel: (name: string) => `תפריט: ${name}`,
  scopeMenuUnnamed: 'תפריט הקופה',
  affectsShop: 'ישפיע על כל הסניף',
  affectsArea: 'ישפיע על כל נקודת המכירה',
  affectsMachine: 'ישפיע על הקופה הזו בלבד',
  tagSoldOut: 'אזל',
  tagBlocked: 'חסום',
  tagOutOfScope: 'לא בנקודה הזו',
  tagOutOfScopeLong: 'המוצר לא נמכר בנקודה הזו (מחוץ לתחום הניהול של הקופה)',
  tagShared: 'משותף',
  showOutOfScope: 'הצג גם מוצרים שלא בתחום',
  stateAny: 'מצב: הכל',
  stateActive: 'פעילים',
  stateInactive: 'לא פעילים',
  stateSoldOut: 'אזל / חסום',
  selectAll: 'בחר הכל',
  selectNone: 'נקה בחירה',
  soldOutToday: 'אזל להיום',
  moveCategory: 'שינוי מחלקה',
  needsApproval: 'באישור מנהל',
  affectsShared: 'מוצר משותף לכמה סניפים: מכאן אפשר לשנות רק מחיר וזמינות',
  sectionAvailability: 'זמינות',
  affectsOfflineOk: 'חל בקופה מיד, גם בלי רשת, ונשלח לענן כשיש',
  blockMore: 'חסום / אזל — לפי ערוץ, רמה וזמן',
  affectsBlock: 'נשמר בענן ומגיע לכל המכשירים שבחרת',
  sectionPrice: 'מחיר',
  affectsPrice: 'המחיר ישתנה בכל הסניף, כולל כל נקודות המכירה',
  affectsNeedsNetwork: 'דורש רשת',
  sectionDetails: 'פרטי המוצר',
  affectsMaster: 'שם, ברקוד, מחלקה ותמונה משנים את המוצר עצמו — רק כשהוא משויך לסניף הזה בלבד. דורש רשת',
  approvedBy: (name: string) => `מאושר על ידי ${name}`,
  filterAll: 'הכל',
  filterAnyChannel: 'כל הערוצים',
  fieldChannel: 'היכן הפריט נמכר',
  channelAll: 'קופות וקיוסק',
  channelKioskOnly: 'קיוסק בלבד',
  channelPosOnly: 'קופות בלבד',
  channelHintKioskOnly: 'לא יוצג במסך המכירה של הקופות (גם לא בחיפוש) — רק בקיוסק',
  channelHintPosOnly: 'לא יוצג בקיוסק — רק בקופות',
  // The product's picture (ProductPhotoPicker / ProductPhoto).
  photoTitle: 'תמונה',
  photoUpload: 'העלה מהמכשיר',
  photoRemove: 'הסר תמונה',
  photoUndo: 'ביטול השינוי',
  photoNone: 'אין תמונה',
  photoNew: 'תמונה חדשה — תישמר בלחיצה על שמור',
  photoRemoving: 'התמונה תוסר בלחיצה על שמור',
  photoRemoveBackground: 'הסר רקע',
  photoEnhance: 'שפר תמונה',
  photoUnreadable: 'לא ניתן לקרוא את התמונה',
  photoWorking: 'מכין את התמונה…',
  photoNotSaved: (why: string) => `הפריט נשמר, אבל התמונה לא נשמרה (${why})`,
  photoFailed: (status: number) => `התמונה לא נשמרה (HTTP ${status})`,
  photoOffline: 'אין חיבור לענן — התמונה לא נשלחה.',
  photoShared: 'המוצר משותף לכמה סניפים — את התמונה שלו משנים בענן.',
  photoSaved: 'התמונה נשמרה',
  photoRemoveConfirmTitle: 'להסיר את התמונה?',
  // "קטלוג למסוף" (MachineCatalogScreen).
  machineTab: 'קטלוג למסוף',
  machineModeAll: 'כל מוצרי הסניף',
  machineModeAllHint: 'הקופה מוכרת את כל קטלוג הסניף, כולל מוצרים שיתווספו לסניף בעתיד.',
  machineModeSelected: 'מוצרים נבחרים בלבד',
  machineModeSelectedHint: 'הקופה מציגה רק את המוצרים המסומנים. מוצרים שיתווספו לסניף בעתיד לא יתווספו לקופה אוטומטית.',
  machineCount: (selected: number, total: number) => `${selected} מתוך ${total} מוצרים`,
  machineGeneralNote: 'הפריט הכללי של המחשבון תמיד זמין בקופה. מוצר מסומן שנעול יוצג כנעול.',
  machineEmptyWarning: 'לא סומנו מוצרים: הקופה תציג רק את הפריט הכללי.',
  machineSearch: 'חיפוש לפי שם, מק״ט או ברקוד',
  machineSelectAll: 'סמן הכל',
  machineClear: 'נקה',
  machineNoCategory: 'ללא קטגוריה',
  machineLocked: 'נעול',
  machineUnsaved: 'יש שינויים שלא נשמרו',
  machineDiscard: 'בטל',
  machineSave: 'שמור',
  machineSaved: 'הקטלוג של הקופה נשמר בענן ועודכן בקופה.',
  machineOffline: 'אין חיבור לענן, והשינוי לא נשמר. הוא לא נשמר לשליחה מאוחרת: נסו שוב כשיש חיבור.',
  machineRefused: 'חלק מהמוצרים המסומנים כבר לא בקטלוג הסניף. הקטלוג רוענן: בדקו ושמרו שוב.',
  machineManagerOnly: 'רק מנהל/ת יכול/ה לצפות בקטלוג של הקופה ולשנות אותו.',
  machineAskManager: 'אישור מנהל',
  /** "חסום / אזל" (the item-block sheet). */
  blockAction: 'חסום / אזל',
  openFromTile: 'פתח בניהול קטלוג',
} as const;

const T = CATALOG_ADMIN_TEXT;

/** The catalog codes (PermissionService Perm) and their labels ("אין לך הרשאה: …"). */
export const CATALOG_PERM = {
  VIEW: 'CATALOG_VIEW',
  AVAILABILITY: 'CATALOG_AVAILABILITY',
  PRICE: 'CATALOG_PRICE',
  EDIT: 'CATALOG_EDIT',
  CREATE: 'CATALOG_CREATE',
  WRITE: 'CATALOG_WRITE',
} as const;

export const CATALOG_PERM_LABEL: Record<string, string> = {
  CATALOG_WRITE: 'עריכת קטלוג',
  CATALOG_VIEW: 'ניהול קטלוג — כניסה וצפייה',
  CATALOG_AVAILABILITY: 'ניהול קטלוג — פעיל / לא פעיל ואזל',
  CATALOG_PRICE: 'ניהול קטלוג — שינוי מחיר',
  CATALOG_EDIT: 'ניהול קטלוג — עריכת מוצר',
  CATALOG_CREATE: 'ניהול קטלוג — מוצר ומחלקה חדשים',
};

/** PermissionService.deniedText (DenyWhy.ROLE). */
export const catalogDeniedText = (code: string): string => `אין לך הרשאה: ${CATALOG_PERM_LABEL[code] ?? code}`;

/* ------------------------------------------------------------------------------------------------------- parameters */

export const CATALOG_PARAMS = {
  ENABLED: 'catalogAdminEnabled',
  SCOPE: 'catalogAdminScope',
  CREATE_FROM_TILL: 'catalogCreateFromTill',
  WITHOUT_SHIFT: 'catalogWithoutShift',
  VIEW: 'catalogAdminView',
  /** "תמונת מוצר מהקופה" (PARAM_PRODUCT_PHOTO). */
  PHOTO: 'productPhotoFromTill',
} as const;

/** On unless the value says false (`false`, "false", any case). */
export function onUnlessFalse(v: unknown): boolean {
  if (v === false) return false;
  return !(typeof v === 'string' && v.trim().toLowerCase() === 'false');
}

export interface CatalogAdminSettings {
  enabled: boolean;
  scope: 'auto' | 'area' | 'shop' | 'till';
  createFromTill: boolean;
  /** True: a manager may open the screen with no shift open ("manager"); false: "never". */
  managerWithoutShift: boolean;
  /** "תמונת מוצר מהקופה". */
  photoFromTill: boolean;
}

export const DEFAULT_CATALOG_SETTINGS: CatalogAdminSettings = { enabled: true, scope: 'auto', createFromTill: true, managerWithoutShift: true, photoFromTill: true };

/** CatalogAdminSettings.of: the parameters with the contract's defaults (§6.1). */
export function catalogSettingsOf(params: Record<string, unknown>): CatalogAdminSettings {
  const scopeRaw = typeof params[CATALOG_PARAMS.SCOPE] === 'string' ? (params[CATALOG_PARAMS.SCOPE] as string).trim().toLowerCase() : '';
  const without = params[CATALOG_PARAMS.WITHOUT_SHIFT];
  return {
    enabled: onUnlessFalse(params[CATALOG_PARAMS.ENABLED]),
    scope: (['auto', 'area', 'shop', 'till'] as const).find((s) => s === scopeRaw) ?? 'auto',
    createFromTill: onUnlessFalse(params[CATALOG_PARAMS.CREATE_FROM_TILL]),
    managerWithoutShift: !(typeof without === 'string' && without.trim().toLowerCase() === 'never'),
    photoFromTill: onUnlessFalse(params[CATALOG_PARAMS.PHOTO]),
  };
}

/* ------------------------------------------------------------------------------------------------ the scope listed */

export type CatalogViewScope = 'menu' | 'shop' | 'till';

export interface CatalogAdminView {
  scope: CatalogViewScope;
  menuId: string | null;
  label: string | null;
  /** False: an older cloud sent no `catalogAdminView`; the till fell back to auto. */
  fromCloud: boolean;
}

/** The cloud's `catalogAdminView` (an object, or its JSON text); null when absent or unreadable. */
export function parseCatalogView(raw: unknown): CatalogAdminView | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t.startsWith('{')) return null;
    try {
      o = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const scope = typeof r.scope === 'string' ? r.scope.trim().toLowerCase() : '';
  if (scope !== 'menu' && scope !== 'shop' && scope !== 'till') return null;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return { scope, menuId: s(r.menuId), label: s(r.label), fromCloud: true };
}

/** The view: the cloud's when it sent one; else auto — the menu active here now, else the whole shop. */
export function resolveCatalogView(viewRaw: unknown, menuBlock: unknown, now: Date): CatalogAdminView {
  const parsed = parseCatalogView(viewRaw);
  if (parsed) return parsed;
  const menu = resolveTillMenu(menuBlock, now);
  if (menu.mode === 'menu' && menu.menuId) return { scope: 'menu', menuId: menu.menuId, label: menu.menuName ? `תפריט: ${menu.menuName}` : null, fromCloud: false };
  return { scope: 'shop', menuId: null, label: null, fromCloud: false };
}

/** The bar's label: the cloud's, else by the scope. */
export function scopeLabel(view: CatalogAdminView, menuName: string | null): string {
  if (view.label) return view.label;
  if (view.scope === 'shop') return T.scopeShopLabel;
  if (view.scope === 'till') return T.scopeTillLabel;
  return menuName ? T.scopeMenuLabel(menuName) : T.scopeMenuUnnamed;
}

export type AvailabilityScope = 'machine' | 'area' | 'shop';

/** The level a "פעיל / לא פעיל" or "אזל" starts at: what the screen lists. */
export function defaultScopeFor(view: CatalogAdminView, hasArea: boolean): AvailabilityScope {
  if (view.scope === 'shop') return 'shop';
  if (view.scope === 'till') return 'machine';
  return hasArea ? 'area' : 'machine';
}

/** "ישפיע על …" for a level. */
export function scopeEffect(scope: AvailabilityScope): string {
  return scope === 'shop' ? T.affectsShop : scope === 'area' ? T.affectsArea : T.affectsMachine;
}

/* ------------------------------------------------------------------------------------------------------ products */

export type SalesChannel = 'all' | 'kiosk_only' | 'pos_only';
export const SALES_CHANNELS: readonly SalesChannel[] = ['all', 'kiosk_only', 'pos_only'];

/** SalesChannel.fromWire: anything unknown (or none) is "all". */
export function salesChannelOf(v: unknown): SalesChannel {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'kiosk_only' || s === 'pos_only' ? s : 'all';
}

export function channelLabel(c: SalesChannel): string {
  return c === 'kiosk_only' ? T.channelKioskOnly : c === 'pos_only' ? T.channelPosOnly : T.channelAll;
}

export function channelHint(c: SalesChannel): string | null {
  return c === 'kiosk_only' ? T.channelHintKioskOnly : c === 'pos_only' ? T.channelHintPosOnly : null;
}

/** A product of the till's stored catalog (the cloud's row), as the screen reads it. */
export interface AdminProduct {
  id: string;
  name: string;
  price: number;
  categoryId: string;
  sku: string;
  barcode: string | null;
  description: string | null;
  isAvailable: boolean;
  shopListed: boolean;
  isGeneral: boolean;
  inMachineCatalog: boolean;
  salesChannel: SalesChannel;
  isOpenPrice: boolean;
  isWeighed: boolean;
  unitLabel: string | null;
  stockQuantity: number;
  trackStock: boolean;
  ticketMode: string | null;
  imageUrl: string | null;
  blocks: unknown;
}

export interface AdminCategory {
  id: string;
  name: string;
  isActive: boolean;
  ticketMode: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

/** The cloud's catalog row; null for a row without an id or one deleted. */
export function adminProductOf(r: Record<string, unknown>): AdminProduct | null {
  const id = text(r.id);
  if (!id || r.deleted === true) return null;
  return {
    id,
    name: text(r.name) ?? '',
    price: num(r.price) ?? 0,
    categoryId: text(r.categoryId) ?? '',
    sku: text(r.sku) ?? '',
    barcode: text(r.barcode),
    description: text(r.description),
    isAvailable: rowAvailable(r as Parameters<typeof rowAvailable>[0]),
    shopListed: r.shopListed !== false,
    isGeneral: r.isGeneral === true,
    inMachineCatalog: r.inMachineCatalog !== false,
    salesChannel: salesChannelOf(r.salesChannel),
    isOpenPrice: r.isOpenPrice === true,
    isWeighed: r.isWeighed === true,
    unitLabel: text(r.unitLabel),
    stockQuantity: Math.trunc(num(r.stockQuantity) ?? 0),
    trackStock: r.trackStock === true,
    ticketMode: text(r.ticketMode),
    imageUrl: text(r.imageUrl),
    blocks: r.blocks,
  };
}

export function adminCategoryOf(r: Record<string, unknown>): AdminCategory | null {
  const id = text(r.id);
  if (!id || r.deleted === true) return null;
  return { id, name: text(r.name) ?? '', isActive: r.isActive !== false, ticketMode: text(r.ticketMode) };
}

/** The search: the name (any case), the barcode, or the SKU (matchesAdminQuery). */
export function matchesAdminQuery(p: Pick<AdminProduct, 'name' | 'barcode' | 'sku'>, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const lq = q.toLowerCase();
  return p.name.toLowerCase().includes(lq) || (p.barcode?.includes(q) ?? false) || p.sku.toLowerCase().includes(lq);
}

/** AdminProductFilter: a category (null = הכל), a channel (null = every one) and the search, all three together. */
export interface AdminProductFilter {
  categoryId: string | null;
  channel: SalesChannel | null;
  query: string;
}

export const NO_FILTER: AdminProductFilter = { categoryId: null, channel: null, query: '' };
/** The "הכל" chip's key in `filterCounts`. */
export const ALL_KEY = '';

const inCategory = (f: AdminProductFilter, p: AdminProduct) => f.categoryId === null || p.categoryId === f.categoryId;
const onChannel = (f: AdminProductFilter, p: AdminProduct) => f.channel === null || p.salesChannel === f.channel;

export function applyFilter(f: AdminProductFilter, products: readonly AdminProduct[]): AdminProduct[] {
  return products.filter((p) => inCategory(f, p) && onChannel(f, p) && matchesAdminQuery(p, f.query));
}

/** The count on each category chip with the channel and the search as they are; [ALL_KEY] is "הכל"'s. */
export function filterCounts(f: AdminProductFilter, products: readonly AdminProduct[]): Record<string, number> {
  const shown = products.filter((p) => onChannel(f, p) && matchesAdminQuery(p, f.query));
  const out: Record<string, number> = {};
  for (const p of shown) out[p.categoryId] = (out[p.categoryId] ?? 0) + 1;
  out[ALL_KEY] = shown.length;
  return out;
}

/** The chips: every category that holds a product, in the order given — and the chosen one even when empty. */
export function filterChips(f: AdminProductFilter, categories: readonly AdminCategory[], products: readonly AdminProduct[]): AdminCategory[] {
  const used = new Set(products.map((p) => p.categoryId));
  return categories.filter((c) => used.has(c.id) || c.id === f.categoryId);
}

/** Tapping a chip: the category, or back to all when it is the chosen one. */
export function toggleCategory(f: AdminProductFilter, id: string | null): AdminProductFilter {
  return { ...f, categoryId: id === null || id === f.categoryId ? null : id };
}

export function toggleChannel(f: AdminProductFilter, c: SalesChannel | null): AdminProductFilter {
  return { ...f, channel: c === null || c === f.channel ? null : c };
}

/** A chosen category that is gone chooses nothing. */
export function validFilter(f: AdminProductFilter, categories: readonly AdminCategory[]): AdminProductFilter {
  return f.categoryId === null || categories.some((c) => c.id === f.categoryId) ? f : { ...f, categoryId: null };
}

/* -------------------------------------------------------------------------------------------- scope, tags, rows */

export type MachineCatalogMode = 'all' | 'selected';

/** MachineCatalog.Mode.fromWire: anything but "selected" is all. */
export function machineModeOf(v: unknown): MachineCatalogMode {
  return typeof v === 'string' && v.trim().toLowerCase() === 'selected' ? 'selected' : 'all';
}

/** MachineCatalog.onThisTill. */
export function onThisTill(mode: MachineCatalogMode, inMachineCatalog: boolean, isGeneral: boolean): boolean {
  return isGeneral || mode !== 'selected' || inMachineCatalog;
}

/**
 * CatalogAdminList.inScope: the products the view covers (not the general item) — shop: what the shop lists; menu: the
 * menu's items among them (a menu the till does not hold: the shop); till: the till's menu when it names one, else its list.
 */
export function inScope(products: readonly AdminProduct[], view: CatalogAdminView, menuBlock: unknown, mode: MachineCatalogMode): Set<string> {
  const listed = products.filter((p) => p.shopListed && !p.isGeneral);
  const menuItems = (menuId: string | null): Set<string> | null => {
    const menu = menuOf(menuBlock, menuId);
    if (menu === null) return null;
    const inputs: MenuInput[] = listed.map((p) => ({ id: p.id, categoryId: p.categoryId || null, priceAgorot: 0 }));
    const placed = new Set(applyMenu(menu, inputs).products.map((x) => x.id));
    return new Set(listed.filter((p) => placed.has(p.id)).map((p) => p.id));
  };
  const all = () => new Set(listed.map((p) => p.id));
  if (view.scope === 'shop') return all();
  if (view.scope === 'menu') return menuItems(view.menuId) ?? all();
  return menuItems(view.menuId) ?? new Set(listed.filter((p) => onThisTill(mode, p.inMachineCatalog, false)).map((p) => p.id));
}

export type CatalogTag = 'inactive' | 'sold_out' | 'blocked' | 'out_of_scope' | 'shared';

export const TAG_LABEL: Record<CatalogTag, string> = {
  inactive: T.inactiveTag,
  sold_out: T.tagSoldOut,
  blocked: T.tagBlocked,
  out_of_scope: T.tagOutOfScope,
  shared: T.tagShared,
};

/** A row's tags, in the order shown. */
export function tagsOf(p: AdminProduct, scoped: boolean, shared: boolean, nowMs: number): CatalogTag[] {
  const out: CatalogTag[] = [];
  if (!p.isAvailable) out.push('inactive');
  const blocks = itemBlocksOf(p.blocks);
  if (blocks.length > 0) {
    const s = decideSoldOut(blocks, nowMs).state;
    if (s === 'blocked') out.push('blocked');
    else if (s === 'sold_out') out.push('sold_out');
  }
  if (!scoped) out.push('out_of_scope');
  if (shared) out.push('shared');
  return out;
}

export interface CatalogAdminRow {
  product: AdminProduct;
  inScope: boolean;
  tags: CatalogTag[];
}

/** The rows: those in scope (and with [showOutOfScope] the rest after them), each with its tags. */
export function catalogRows(products: readonly AdminProduct[], scoped: ReadonlySet<string>, showOutOfScope: boolean, shared: ReadonlySet<string>, nowMs: number): CatalogAdminRow[] {
  const candidates = products.filter((p) => !p.isGeneral);
  const inside = candidates.filter((p) => scoped.has(p.id));
  const outside = candidates.filter((p) => !scoped.has(p.id));
  return (showOutOfScope ? [...inside, ...outside] : inside).map((p) => {
    const ins = scoped.has(p.id);
    return { product: p, inScope: ins, tags: tagsOf(p, ins, shared.has(p.id), nowMs) };
  });
}

export type StateFilter = 'any' | 'active' | 'inactive' | 'sold_out';
export const STATE_FILTERS: readonly StateFilter[] = ['any', 'active', 'inactive', 'sold_out'];
export const STATE_LABEL: Record<StateFilter, string> = { any: T.stateAny, active: T.stateActive, inactive: T.stateInactive, sold_out: T.stateSoldOut };

export function matchesState(row: Pick<CatalogAdminRow, 'tags'>, s: StateFilter): boolean {
  if (s === 'active') return !row.tags.includes('inactive');
  if (s === 'inactive') return row.tags.includes('inactive');
  if (s === 'sold_out') return row.tags.includes('sold_out') || row.tags.includes('blocked');
  return true;
}

/* -------------------------------------------------------------------------------------------------------- gates */

export type CatalogAction = 'availability' | 'price' | 'edit' | 'create';

export const ACTION_CODE: Record<CatalogAction, string> = {
  availability: CATALOG_PERM.AVAILABILITY,
  price: CATALOG_PERM.PRICE,
  edit: CATALOG_PERM.EDIT,
  create: CATALOG_PERM.CREATE,
};

/** How an action is offered, decided before anyone taps it. */
export type CatalogGate = { kind: 'allowed' } | { kind: 'approval' } | { kind: 'hidden' } | { kind: 'disabled'; reason: string };

export const offered = (g: CatalogGate) => g.kind !== 'hidden';
export const usable = (g: CatalogGate) => g.kind === 'allowed' || g.kind === 'approval';

/** "כשאין הרשאה" as the catalog reads it (`permissionsDeniedUi` / legacyUi): hide, or show greyed with the reason. */
export type CatalogDeniedUi = 'hide' | 'disable';

/**
 * CatalogAdminRules.gate: [decision] is the operator's own answer for the action's code; an approval the screen already
 * holds for it ([held]) is approval enough; "הוספת מוצרים מהקופה" off hides "+".
 */
export function catalogGate(action: CatalogAction, decision: 'allowed' | 'approval' | 'denied', deniedUi: CatalogDeniedUi, settings: CatalogAdminSettings, held = false): CatalogGate {
  if (action === 'create' && !settings.createFromTill) return { kind: 'hidden' };
  if (decision === 'allowed') return { kind: 'allowed' };
  if (decision === 'approval') return held ? { kind: 'allowed' } : { kind: 'approval' };
  return deniedUi === 'hide' ? { kind: 'hidden' } : { kind: 'disabled', reason: catalogDeniedText(ACTION_CODE[action]) };
}

/** The roster row the "manager" check reads. */
export interface CatalogUserFacts {
  role: string | null;
  /** The cloud sent permissions for the user (a role profile from the cloud). */
  fromCloud: boolean;
  tillRoleKey: string | null;
  /** The user's own answer for CATALOG_EDIT. */
  editState: 'allow' | 'approval' | 'deny';
}

/** CatalogAdminRules.isManager: the shop manager's role (legacy or the cloud's "manager"), or one that edits alone. */
export function isCatalogManager(u: CatalogUserFacts | null): boolean {
  if (!u) return false;
  if ((u.role ?? '').trim().toLowerCase() === 'shop_manager' && !u.fromCloud) return true;
  if (u.tillRoleKey === 'manager' || u.tillRoleKey === 'legacy_manager') return true;
  return u.editState === 'allow';
}

/**
 * CatalogAdminRules.entryShown: whether "ניהול קטלוג" is in the menu (and "פתח בניהול קטלוג" on a tile) — never with
 * `catalogAdminEnabled` off; with no shift, only a manager under `catalogWithoutShift = manager`; CATALOG_VIEW denied —
 * hidden when the till hides denials (else shown, and the tap says why).
 */
export function entryShown(settings: CatalogAdminSettings, shiftOpen: boolean, user: CatalogUserFacts | null, viewDecision: 'allowed' | 'approval' | 'denied', deniedUi: CatalogDeniedUi): boolean {
  if (!settings.enabled || !user) return false;
  if (!shiftOpen && !(settings.managerWithoutShift && isCatalogManager(user))) return false;
  return !(viewDecision === 'denied' && deniedUi === 'hide');
}

/** The actions an edit needs: the price alone is PRICE; anything else, EDIT. */
export function actionsFor(priceChanged: boolean, otherChanged: boolean): CatalogAction[] {
  const out: CatalogAction[] = [];
  if (priceChanged) out.push('price');
  if (otherChanged) out.push('edit');
  return out;
}

/* ---------------------------------------------------------------------------------------------- the product page */

/** What the product form collects (ProductDraft). */
export interface ProductDraft {
  name: string;
  price: string;
  categoryId: string;
  sku: string;
  barcode: string;
  description: string;
  stockQuantity: string;
  isOpenPrice: boolean;
  isWeighed: boolean;
  unitLabel: string;
  printTicket: boolean;
  salesChannel: SalesChannel;
}

export type TicketMode = 'off' | 'per_unit' | 'per_line' | 'per_sale';

export function ticketModeOf(v: unknown): TicketMode | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'off' || s === 'per_unit' || s === 'per_line' || s === 'per_sale' ? s : null;
}

/** TicketMode.resolve: the product's own wins; else its category's; else off. */
export function resolveTicketMode(productMode: unknown, categoryMode: unknown): TicketMode {
  return ticketModeOf(productMode) ?? ticketModeOf(categoryMode) ?? 'off';
}

export function ticketModeLabel(m: TicketMode): string {
  return m === 'per_unit' ? T.ticketModeUnit : m === 'per_line' ? T.ticketModeLine : m === 'per_sale' ? T.ticketModeSale : T.ticketModeOff;
}

/** ProductDraft.of: the form for [p] as it is now. */
export function draftOf(p: AdminProduct, printTicket: boolean): ProductDraft {
  return {
    name: p.name,
    price: p.price.toFixed(2),
    categoryId: p.categoryId,
    sku: p.sku,
    barcode: p.barcode ?? '',
    description: p.description ?? '',
    stockQuantity: p.trackStock || p.stockQuantity !== 0 ? String(p.stockQuantity) : '',
    isOpenPrice: p.isOpenPrice,
    isWeighed: p.isWeighed,
    unitLabel: p.unitLabel ?? '',
    printTicket,
    salesChannel: p.salesChannel,
  };
}

/** A new product's form: the first category. */
export function emptyDraft(firstCategoryId: string | null): ProductDraft {
  return { name: '', price: '', categoryId: firstCategoryId ?? '', sku: '', barcode: '', description: '', stockQuantity: '', isOpenPrice: false, isWeighed: false, unitLabel: '', printTicket: false, salesChannel: 'all' };
}

/** The product page's fields as edited, against the product: only what changed (CatalogEdit). */
export interface CatalogEdit {
  name?: string;
  price?: number;
  categoryId?: string;
  description?: string;
  barcode?: string;
  isOpenPrice?: boolean;
  isWeighed?: boolean;
  unitLabel?: string;
  stockQuantity?: number;
}

export const priceChanged = (e: CatalogEdit) => e.price !== undefined;
export const otherChanged = (e: CatalogEdit) =>
  e.name !== undefined || e.categoryId !== undefined || e.description !== undefined || e.barcode !== undefined || e.isOpenPrice !== undefined || e.isWeighed !== undefined || e.unitLabel !== undefined || e.stockQuantity !== undefined;

/** A typed price ("12,5" → 12.5); null when it is not a number. */
export function parsePrice(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** CatalogEdit.diff. */
export function diffEdit(
  p: AdminProduct,
  f: Pick<ProductDraft, 'name' | 'price' | 'categoryId' | 'description' | 'barcode' | 'isOpenPrice' | 'isWeighed' | 'unitLabel'> & { stock: string },
): CatalogEdit {
  const out: CatalogEdit = {};
  const name = f.name.trim();
  if (name && name !== p.name) out.name = name;
  const price = parsePrice(f.price);
  if (price !== null && Math.abs(price - p.price) > 0.0001) out.price = price;
  if (f.categoryId.trim() && f.categoryId !== p.categoryId) out.categoryId = f.categoryId;
  const description = f.description.trim();
  if (description !== (p.description ?? '').trim() && description) out.description = description;
  const barcode = f.barcode.trim();
  if (barcode !== (p.barcode ?? '')) out.barcode = barcode;
  if (f.isOpenPrice !== p.isOpenPrice) out.isOpenPrice = f.isOpenPrice;
  if (f.isWeighed !== p.isWeighed) out.isWeighed = f.isWeighed;
  const unit = f.unitLabel.trim();
  if (f.isWeighed && unit && unit !== (p.unitLabel ?? '')) out.unitLabel = unit;
  const st = f.stock.trim();
  const sn = st === '' ? NaN : Number(st);
  if (st && Number.isFinite(sn) && sn >= 0 && Number.isInteger(sn) && sn !== p.stockQuantity) out.stockQuantity = sn;
  return out;
}

/** The `PUT /sync/{m}/products/{id}` body: only what changed (ProductPatchRequest, nulls omitted). */
export function patchOf(e: CatalogEdit, extra: { ticketMode?: string | null; salesChannel?: SalesChannel | null } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined) out[k] = v;
  if (extra.ticketMode) out.ticketMode = extra.ticketMode;
  if (extra.salesChannel) out.salesChannel = extra.salesChannel;
  return out;
}

/** What the "+ מוצר חדש" form posts (ProductWriteRequest, nulls omitted). */
export function createBody(d: ProductDraft): Record<string, unknown> {
  const orNull = (s: string) => (s.trim() ? s.trim() : null);
  const stock = d.stockQuantity.trim() === '' ? NaN : Number(d.stockQuantity.trim());
  const body: Record<string, unknown> = { name: d.name.trim(), price: parsePrice(d.price) ?? 0, categoryId: d.categoryId };
  const sku = orNull(d.sku);
  if (sku) body.sku = sku;
  const description = orNull(d.description);
  if (description) body.description = description;
  const barcode = orNull(d.barcode);
  if (barcode) body.barcode = barcode;
  if (Number.isFinite(stock) && stock >= 0 && Number.isInteger(stock)) body.stockQuantity = stock;
  if (d.isOpenPrice) body.isOpenPrice = true;
  if (d.isWeighed) body.isWeighed = true;
  const unit = orNull(d.unitLabel);
  if (unit && d.isWeighed) body.unitLabel = unit;
  if (d.printTicket) body.ticketMode = 'per_unit';
  body.salesChannel = d.salesChannel;
  return body;
}

/** The form's check before saving: the name, a price ≥ 0, a category. */
export function draftError(d: Pick<ProductDraft, 'name' | 'price' | 'categoryId'>): string | null {
  const price = parsePrice(d.price);
  if (!d.name.trim()) return T.nameRequired;
  if (price === null || price < 0) return T.priceInvalid;
  if (!d.categoryId.trim()) return T.categoryRequired;
  return null;
}

/** "5" → "5.00", "5,5" → "5.50"; null for anything that is not a price. */
export function twoDecimals(input: string): string | null {
  const n = parsePrice(input);
  if (n === null || n < 0) return null;
  return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** The price on a row: "₪12.50". */
export const priceText = (shekels: number): string => formatShekelSign(ofShekels(shekels));

/* ----------------------------------------------------------------------------------------------- availability */

/** "פעיל / לא פעיל" and "אזל" as asked (AvailabilityChange). */
export type AvailabilityChange = 'off' | 'on' | 'inherit' | 'sold_out_today';

/** The `PUT …/availability` body (ScopedActiveRequest) for a change at a level — as the till's lock queue sends it. */
export function availabilityBody(change: AvailabilityChange, scope: AvailabilityScope, permanent: boolean | null, atIso: string | null): Record<string, unknown> {
  const locked = change === 'off' || change === 'sold_out_today';
  const perm = change === 'off' ? (permanent ?? false) : change === 'sold_out_today' ? false : null;
  const body: Record<string, unknown> = { scope, active: locked ? false : change === 'on' ? true : null };
  if (locked && perm !== null) body.permanent = perm;
  if (locked && atIso) body.blockedAt = atIso;
  return body;
}

/** Whether the change takes the product off this till at once (the local lock). */
export const lockedBy = (change: AvailabilityChange) => change === 'off' || change === 'sold_out_today';

/* --------------------------------------------------------------------------------------- "קטלוג למסוף" (this till) */

export interface MachineGroup {
  categoryId: string;
  name: string | null;
  products: AdminProduct[];
}

/** The checklist: every product but the general item, by category in the till's order, narrowed by the search. */
export function machineGroups(products: readonly AdminProduct[], categories: readonly AdminCategory[], query: string): MachineGroup[] {
  const q = query.trim().toLowerCase();
  const eligible = products.filter((p) => !p.isGeneral).filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.barcode?.toLowerCase().includes(q) ?? false));
  const order = new Map(categories.map((c, i) => [c.id, i]));
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const by = new Map<string, AdminProduct[]>();
  for (const p of eligible) {
    const list = by.get(p.categoryId);
    if (list) list.push(p);
    else by.set(p.categoryId, [p]);
  }
  return [...by.entries()]
    .map(([id, rows]) => ({ categoryId: id, name: names.get(id) ?? null, products: rows.slice().sort((a, b) => cmp(a.name, b.name)) }))
    .sort((a, b) => (order.get(a.categoryId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.categoryId) ?? Number.MAX_SAFE_INTEGER) || cmp(a.name ?? '', b.name ?? ''));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** "12 מתוך 40": ticked out of the products the shop sells, the general item aside. */
export function machineCount(selected: ReadonlySet<string>, products: readonly Pick<AdminProduct, 'id' | 'isGeneral'>[]): { selected: number; total: number } {
  const eligible = products.filter((p) => !p.isGeneral);
  return { selected: eligible.filter((p) => selected.has(p.id)).length, total: eligible.length };
}

/** MachineCatalog.listToSend: every non-general product ticked, sorted (the same choice → the same request). */
export function machineListToSend(selected: ReadonlySet<string>, products: readonly Pick<AdminProduct, 'id' | 'isGeneral'>[]): string[] {
  return products
    .filter((p) => !p.isGeneral && selected.has(p.id))
    .map((p) => p.id)
    .sort(cmp);
}

/** What is stored now: the ticked rows the cloud said are on the list. */
export function savedMachineSelection(products: readonly AdminProduct[]): string[] {
  return products.filter((p) => !p.isGeneral && p.inMachineCatalog).map((p) => p.id);
}

/* ------------------------------------------------------------------------------------------------------ picture */

/** The side of the square sent (PHOTO_SIDE), and the JPEG quality (PHOTO_JPEG_QUALITY). */
export const PHOTO_SIDE = 800;
export const PHOTO_JPEG_QUALITY = 0.85;
/** The cloud's limit for an upload (routers/images.py `_MAX_SIZE_BYTES`). */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** DEFAULT_KEEP_BACKGROUND / DEFAULT_ENHANCE: the background cut out and the picture enhanced unless switched off. */
export const DEFAULT_KEEP_BACKGROUND = false;
export const DEFAULT_ENHANCE = true;

export type PhotoFormat = { mime: 'image/jpeg' | 'image/png' | 'image/webp'; uploadName: string };

/** photoFormatOf: by the signature; null — not a picture the till sends (JPEG, PNG, WEBP). */
export function photoFormatOf(bytes: Uint8Array): PhotoFormat | null {
  const at = (i: number) => (i < bytes.length ? bytes[i] : -1);
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return { mime: 'image/png', uploadName: 'product.png' };
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return { mime: 'image/webp', uploadName: 'product.webp' };
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { mime: 'image/jpeg', uploadName: 'product.jpg' };
  return null;
}

/** The square cut of a picture (squareCrop, centred) and the side it is sent at (photoOutputSide). */
export function squareCrop(width: number, height: number, offset = 0.5): { left: number; top: number; side: number; out: number } {
  const side = Math.max(1, Math.min(width, height));
  const f = Number.isNaN(offset) ? 0.5 : Math.min(1, Math.max(0, offset));
  const left = width >= height ? Math.min(Math.max(0, Math.round((width - side) * f)), Math.max(0, width - side)) : 0;
  const top = width >= height ? 0 : Math.min(Math.max(0, Math.round((height - side) * f)), Math.max(0, height - side));
  return { left, top, side, out: Math.max(1, Math.min(side, PHOTO_SIDE)) };
}

/* ------------------------------------------------------------------------------------------------ the cloud's word */

/** The cloud refused a master field on a product other shops sell (403 `shared_product_master_readonly`). */
export function sharedRefusal(status: number, body: unknown): boolean {
  if (status !== 403) return false;
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return s.includes('readonly');
}

/* --------------------------------------------------------------------------------------------------- the state */

/** How an action is drawn: offered at all, usable now, "באישור מנהל", the reason it is greyed. */
export interface GateView {
  offered: boolean;
  usable: boolean;
  approval: boolean;
  reason: string | null;
}

export function gateView(g: CatalogGate): GateView {
  return { offered: offered(g), usable: usable(g), approval: g.kind === 'approval', reason: g.kind === 'disabled' ? g.reason : null };
}

export interface CatalogRowView {
  id: string;
  name: string;
  price: string;
  imageUrl: string | null;
  inScope: boolean;
  tags: Array<{ tag: CatalogTag; label: string }>;
  /** Where it is sold, when not everywhere. */
  channel: string | null;
}

export interface CatalogChip {
  key: string;
  label: string;
  on: boolean;
}

export interface CatalogScopeOption {
  key: AvailabilityScope;
  label: string;
  affects: string;
  enabled: boolean;
}

export interface CatalogPageView {
  /** Moves on each opening: the screen's form starts again. */
  key: string;
  mode: 'edit' | 'new';
  productId: string | null;
  title: string;
  draft: ProductDraft;
  isAvailable: boolean;
  outOfScope: boolean;
  shared: boolean;
  imageUrl: string | null;
  /** The cloud's ticket mode label, and whether it prints one now. */
  cloudTicket: string;
  cloudPrintTicket: boolean;
  gates: { availability: GateView; price: GateView; edit: GateView; block: boolean };
  availabilityAffects: string;
  photoEnabled: boolean;
}

export interface CatalogPriceAsk {
  title: string;
  choices: Array<{ level: PriceLevel; label: string; refusal: string | null; enabled: boolean }>;
  preselected: PriceLevel | null;
}

export interface MachineCatalogView {
  authorized: boolean;
  mode: MachineCatalogMode;
  /** The products on the list now (saved). */
  selected: string[];
  groups: Array<{ categoryId: string; name: string; products: Array<{ id: string; name: string; code: string; locked: boolean }> }>;
  total: number;
}

export interface CatalogAdminState {
  /** "ניהול קטלוג" is in the menu for the operator now (entryShown). */
  entryShown: boolean;
  open: boolean;
  panel: 'products' | 'categories' | 'till';
  title: string;
  scopeLine: string;
  busy: boolean;
  note: { text: string; tone: 'ok' | 'error' | 'info' } | null;
  /** "מאושר על ידי <מנהל>": an approval the screen holds (tap to give it back). */
  approvedBy: string | null;
  gates: { availability: GateView; price: GateView; edit: GateView; create: GateView };
  /** Several products may be chosen ("בחירת כמה מוצרים"). */
  canSelect: boolean;
  filter: { query: string; categoryId: string | null; channel: SalesChannel | null; state: StateFilter; showOutOfScope: boolean };
  offerOutOfScope: boolean;
  stateChips: CatalogChip[];
  channelChips: CatalogChip[];
  categoryChips: CatalogChip[];
  rows: CatalogRowView[];
  /** All the rows the filter matches (the list shows the first `rows.length`). */
  total: number;
  hasArea: boolean;
  availabilityScope: AvailabilityScope;
  scopeOptions: CatalogScopeOption[];
  categories: Array<{ id: string; name: string; inactive: boolean }>;
  page: CatalogPageView | null;
  priceAsk: CatalogPriceAsk | null;
  machine: MachineCatalogView | null;
}
