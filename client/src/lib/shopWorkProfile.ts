/**
 * "תצורת עבודה של הסניף" (spec: shop-work-config.md §2, §7ב): how a whole shop works with its
 * tills — the Z, a local server (the main till), tables, the kitchen, the customer display,
 * attendance, tips and vouchers — chosen when the shop is created (a step of "הקמת סניף") and
 * edited on the shop page's "תצורת עבודה" section.
 *
 * Stored by the server as `shops.settings.workProfile`. What needs no till is applied at once;
 * the Z type, the main till and the LAN wait for the first till ("⏳"), which the add-device
 * step then offers as the main till / a LAN member / its own Z (lib/workConfig.ts, the device's
 * "תצורת מכשיר").
 *
 * Pure — `npm test` compiles it alone; the calls are in lib/shopWorkProfileApi.ts. The checks
 * here mirror the server's so the editor can say what is missing before saving; the server
 * still decides (and refuses a blocked change with a 409, all or nothing).
 */

// ── The contract (§7ב) ───────────────────────────────────────────────────────

export type ZType = 'per_till' | 'shop_cloud' | 'shop_local';
export type ShopZFrom = 'main_only' | 'main_and_dashboard' | 'any_and_dashboard';
export type ProfileTablesMode = 'off' | 'single' | 'synced' | 'lan';
export type Kitchen = 'printer' | 'kds' | 'both';
/** The shop's tip distribution, as the till settings have it (`tipDistribution`). */
export type ProfileTipDistribution = 'direct' | 'equal_pool' | 'by_sales';
/** "בירור יתרת שובר" (`voucherBalanceCheck`). */
export type BalanceCheck = 'auto' | 'on' | 'off';
/** "שרת מקומי": the main till (a till that sells too), or a dedicated device (P:/specs/dedicated-local-server.md). */
export type LocalServerDevice = 'main_till' | 'dedicated';

export type TemplateId =
  | 'restaurant_tables'
  | 'restaurant_kds'
  | 'quick_counter'
  | 'kiosks'
  | 'independent_till'
  | 'event';

export interface WorkProfile {
  /** The template the profile started from (kept when a field is changed after); null — none. */
  templateId: TemplateId | string | null;
  zType: ZType;
  shopZFrom: ShopZFrom;
  localServer: boolean;
  /** What the local server is: the main till, or "שרת מקומי: מכשיר ייעודי". */
  localServerDevice: LocalServerDevice;
  tablesMode: ProfileTablesMode;
  kitchen: Kitchen;
  customerDisplay: boolean;
  attendance: boolean;
  tips: { enabled: boolean; distribution: ProfileTipDistribution };
  vouchers: { station: boolean; balanceCheck: BalanceCheck };
}

/** The profile's fields — the keys of `status` and `canEdit`. */
export type WorkProfileField = Exclude<keyof WorkProfile, 'templateId'>;

export const WORK_PROFILE_FIELDS: readonly WorkProfileField[] = [
  'zType',
  'shopZFrom',
  'localServer',
  'localServerDevice',
  'tablesMode',
  'kitchen',
  'customerDisplay',
  'attendance',
  'tips',
  'vouchers',
];

export interface WorkProfileTemplate {
  id: TemplateId | string;
  name: string;
  description: string;
  profile: WorkProfile;
}

export type FieldState = 'applied' | 'pending' | 'blocked';

export interface FieldStatus {
  state: FieldState;
  /** pending: when it applies ("יופעל כשתצומד הקופה הראשונה"); blocked: why not, in Hebrew. */
  reason?: string | null;
}

/** `GET` / `PUT /shops/{id}/work-profile`. */
export interface WorkProfileView {
  /**
   * The shop's profile: as saved, else as the shop stands (`stored: false`). null only from a
   * server that sends none.
   */
  profile: WorkProfile | null;
  status: Partial<Record<string, FieldStatus>>;
  canEdit: Partial<Record<string, boolean>>;
  /** false: nothing saved yet — `profile` is the shop as it stands. null: the server did not say. */
  stored: boolean | null;
  /** The shop has tills (then the Z and the local server are the super admin's). */
  hasTills: boolean | null;
  /** `PUT` only: what was written (Hebrew lines); empty — nothing to change. null: not said. */
  changes: string[] | null;
}

/** A refusal of the server: 409 (the rules), 403 (a field not the user's), 422 (not a profile). */
export interface Refusal {
  status: number | null;
  code: string | null;
  message: string | null;
  /** The field the server names (`zType`, `tips.distribution`…), when it does. */
  field: string | null;
}

// ── Values, labels, hints ────────────────────────────────────────────────────

export const DEFAULT_PROFILE: WorkProfile = {
  templateId: null,
  zType: 'shop_cloud',
  shopZFrom: 'main_only',
  localServer: false,
  localServerDevice: 'main_till',
  tablesMode: 'off',
  kitchen: 'printer',
  customerDisplay: false,
  attendance: false,
  tips: { enabled: false, distribution: 'direct' },
  vouchers: { station: false, balanceCheck: 'auto' },
};

export interface Choice<V extends string> {
  value: V;
  label: string;
  hint: string;
}

export const Z_TYPE_CHOICES: readonly Choice<ZType>[] = [
  { value: 'per_till', label: 'Z לכל קופה', hint: 'כל קופה מפיקה Z משלה, במספור משלה.' },
  { value: 'shop_cloud', label: 'Z סניפי מהענן', hint: 'Z אחד לכל הסניף, מופק בענן; כל קופה מסתנכרנת מול הענן.' },
  {
    value: 'shop_local',
    label: 'Z סניפי בשרת מקומי',
    hint: 'Z אחד לכל הסניף, מופק בקופה הראשית ברשת המקומית — גם בלי אינטרנט. מחייב שרת מקומי.',
  },
];

export const SHOP_Z_FROM_CHOICES: readonly Choice<ShopZFrom>[] = [
  { value: 'main_only', label: 'הקופה הראשית בלבד', hint: '"סגירת Z סניפי" רק בקופה הראשית.' },
  { value: 'main_and_dashboard', label: 'הקופה הראשית והדשבורד', hint: 'גם מהדשבורד, בעמוד "הפקת דו״ח Z".' },
  { value: 'any_and_dashboard', label: 'כל קופה בסניף והדשבורד', hint: 'כל קופה בסניף יכולה להפיק את ה-Z הסניפי.' },
];

export const TABLES_CHOICES: readonly Choice<ProfileTablesMode>[] = [
  { value: 'off', label: 'כבוי', hint: 'אין שולחנות בסניף.' },
  { value: 'single', label: 'קופה אחת', hint: 'כל קופה מנהלת את השולחנות שלה בלבד; עובד גם בלי אינטרנט.' },
  { value: 'synced', label: 'מסונכרן בין הקופות', hint: 'אותם שולחנות בכל הקופות דרך הענן (צריך אינטרנט כדי לפתוח שולחן).' },
  {
    value: 'lan',
    label: 'רשת מקומית (דרך הקופה הראשית)',
    hint: 'השולחנות נשמרים בקופה הראשית ועובדים מולה ברשת, גם בלי אינטרנט. מחייב שרת מקומי.',
  },
];

export const KITCHEN_CHOICES: readonly Choice<Kitchen>[] = [
  { value: 'printer', label: 'בונים במדפסת', hint: 'הבונים מודפסים במדפסות המטבח לפי הניתוב.' },
  { value: 'kds', label: 'מסך מטבח (KDS)', hint: 'ההזמנות מוצגות במסכי המטבח; את המסכים מגדירים בדף "מסכי מטבח".' },
  { value: 'both', label: 'בונים ומסך מטבח', hint: 'גם בון במדפסת וגם מסך מטבח.' },
];

export const TIP_DISTRIBUTION_CHOICES: readonly Choice<ProfileTipDistribution>[] = [
  { value: 'direct', label: 'ישירה', hint: 'כל קופאי שומר את שלו.' },
  { value: 'equal_pool', label: 'שווה', hint: 'חלוקה שווה בין הקופאים במשמרת.' },
  { value: 'by_sales', label: 'לפי מכירות', hint: 'לפי היקף המכירות של כל קופאי.' },
];

export const BALANCE_CHECK_CHOICES: readonly Choice<BalanceCheck>[] = [
  { value: 'auto', label: 'אוטומטי', hint: 'מופיע בתפריט הקופה כשיש סדרת שוברים פעילה.' },
  { value: 'on', label: 'כן', hint: 'תמיד בתפריט הקופה.' },
  { value: 'off', label: 'לא', hint: 'לא מופיע בקופה.' },
];

export const LOCAL_SERVER_DEVICE_CHOICES: readonly Choice<LocalServerDevice>[] = [
  { value: 'main_till', label: 'קופה ראשית', hint: 'אחת הקופות היא השרת: היא מוכרת, וכל הסניף נשען עליה.' },
  {
    value: 'dedicated',
    label: 'שרת מקומי: מכשיר ייעודי',
    hint: 'מכשיר אנדרואיד שלא מוכר ועומד בצד: שולחנות, הדפסות ו-Z סניפי. מוסיפים אותו כ"שרת מקומי" בהוספת מכשיר.',
  },
];

export const FIELD_LABELS: Record<WorkProfileField, string> = {
  zType: 'סוג Z',
  shopZFrom: 'מי מפיק Z סניפי',
  localServer: 'שרת מקומי (קופה ראשית)',
  localServerDevice: 'שרת מקומי — איזה מכשיר',
  tablesMode: 'ניהול שולחנות',
  kitchen: 'מטבח',
  customerDisplay: 'מסך לקוח',
  attendance: 'נוכחות עובדים',
  tips: 'טיפים',
  vouchers: 'שוברי הפקה',
};

/** One line under each field: what it decides. */
export const FIELD_HINTS: Record<WorkProfileField, string> = {
  zType: 'איך נסגר היום: Z לכל קופה, או Z אחד לכל הסניף.',
  shopZFrom: 'מאיפה מותר להפיק את ה-Z הסניפי.',
  localServer:
    'קופה אחת שכל הסניף נשען עליה ברשת: שולחנות, הדפסות ו-Z סניפי, גם בלי אינטרנט. נקבע לפי סוג ה-Z: דלוק רק ב"Z סניפי בשרת מקומי". הקופה הראשונה שתצומד תוצע כקופה הראשית.',
  localServerDevice:
    'קופה ראשית, או מכשיר ייעודי שאינו קופה. מכשיר ייעודי שמצמידים לסניף הופך לשרת, ואם קופה הייתה השרת — השרת עובר ממנה אליו.',
  tablesMode: 'איפה נשמרים השולחנות וההזמנות הפתוחות.',
  kitchen: 'לאן הולכות ההזמנות למטבח.',
  customerDisplay: 'מסך שני מול הלקוח: הסל, הסכום והתשלום.',
  attendance: 'כניסה ויציאה של עובדים בקופה, ודוח נוכחות בדשבורד.',
  tips: 'הוספת טיפ בתשלום, ואיך מחלקים את הטיפים בין הקופאים.',
  vouchers: 'עמדת שובר (מסך סריקה בלבד) ובירור יתרת שובר בקופה.',
};

/** The groups the editor shows, in order. */
export const FIELD_GROUPS: readonly { id: string; title: string; fields: readonly WorkProfileField[] }[] = [
  { id: 'z', title: 'Z ושרת מקומי', fields: ['zType', 'shopZFrom', 'localServer', 'localServerDevice'] },
  { id: 'service', title: 'שולחנות ומטבח', fields: ['tablesMode', 'kitchen'] },
  { id: 'extras', title: 'בקופה', fields: ['customerDisplay', 'attendance', 'tips', 'vouchers'] },
];

/** Shown on a field the current user may not change (`canEdit` false). */
export const SUPER_ADMIN_ONLY = 'רק מנהל-על';

function labelOf<V extends string>(choices: readonly Choice<V>[], v: V): string {
  return choices.find((c) => c.value === v)?.label ?? v;
}

/** A field's value in words. */
export function fieldValueText(field: WorkProfileField, p: WorkProfile): string {
  switch (field) {
    case 'zType':
      return labelOf(Z_TYPE_CHOICES, p.zType);
    case 'shopZFrom':
      return p.zType === 'per_till' ? 'לא רלוונטי (Z לכל קופה)' : labelOf(SHOP_Z_FROM_CHOICES, p.shopZFrom);
    case 'localServer':
      return p.localServer ? 'כן' : 'לא';
    case 'localServerDevice':
      return p.localServer ? labelOf(LOCAL_SERVER_DEVICE_CHOICES, p.localServerDevice) : 'לא רלוונטי (אין שרת מקומי)';
    case 'tablesMode':
      return labelOf(TABLES_CHOICES, p.tablesMode);
    case 'kitchen':
      return labelOf(KITCHEN_CHOICES, p.kitchen);
    case 'customerDisplay':
    case 'attendance':
      return p[field] ? 'דלוק' : 'כבוי';
    case 'tips':
      return p.tips.enabled ? `דלוק · חלוקה ${labelOf(TIP_DISTRIBUTION_CHOICES, p.tips.distribution)}` : 'כבוי';
    case 'vouchers':
      return `עמדת שובר ${p.vouchers.station ? 'דלוקה' : 'כבויה'} · בירור יתרה ${labelOf(BALANCE_CHECK_CHOICES, p.vouchers.balanceCheck)}`;
  }
}

// ── Templates (§2.2) ─────────────────────────────────────────────────────────

function profileOf(templateId: TemplateId, over: Partial<WorkProfile>): WorkProfile {
  return {
    ...DEFAULT_PROFILE,
    ...over,
    templateId,
    tips: { ...DEFAULT_PROFILE.tips, ...(over.tips ?? {}) },
    vouchers: { ...DEFAULT_PROFILE.vouchers, ...(over.vouchers ?? {}) },
  };
}

/**
 * The six templates, as the spec's table has them and the server words them — used when the
 * server has no `GET /work-profile/templates` yet (or it fails). The server's list wins when it
 * answers; the profiles are pinned to its golden file (server/tests/fixtures/shop_work_templates.json).
 */
export const LOCAL_TEMPLATES: readonly WorkProfileTemplate[] = [
  {
    id: 'restaurant_tables',
    name: 'מסעדה עם שולחנות',
    description:
      'Z סניפי בשרת מקומי: הקופה הראשית מנהלת את השולחנות ברשת המקומית ומפיקה את ה-Z של כל הסניף, גם בלי אינטרנט. הבונים יוצאים במדפסות.',
    profile: profileOf('restaurant_tables', { zType: 'shop_local', localServer: true, tablesMode: 'lan', kitchen: 'printer' }),
  },
  {
    id: 'restaurant_kds',
    name: 'מסעדה עם מסך מטבח',
    description:
      'כמו מסעדה עם שולחנות — שרת מקומי ושולחנות ברשת המקומית — וההזמנות מגיעות למסך מטבח (KDS) במקום לבונים.',
    profile: profileOf('restaurant_kds', { zType: 'shop_local', localServer: true, tablesMode: 'lan', kitchen: 'kds' }),
  },
  {
    id: 'quick_counter',
    name: 'דוכן / קופה מהירה',
    description: 'מכירה מהירה בלי שולחנות. Z סניפי אחד לכל הקופות מהענן, והבונים יוצאים במדפסות.',
    profile: profileOf('quick_counter', { zType: 'shop_cloud', localServer: false, tablesMode: 'off', kitchen: 'printer' }),
  },
  {
    id: 'kiosks',
    name: 'קיוסקים',
    description: 'עמדות הזמנה עצמית בלי שולחנות. Z סניפי מהענן, וההזמנות מגיעות למסך מטבח (KDS).',
    profile: profileOf('kiosks', { zType: 'shop_cloud', localServer: false, tablesMode: 'off', kitchen: 'kds' }),
  },
  {
    id: 'independent_till',
    name: 'קופה עצמאית',
    description: 'כל קופה מפיקה Z משלה ומנהלת את השולחנות שלה בעצמה. הבונים יוצאים במדפסות.',
    profile: profileOf('independent_till', { zType: 'per_till', localServer: false, tablesMode: 'single', kitchen: 'printer' }),
  },
  {
    id: 'event',
    name: 'אירוע / הפקה',
    description: 'אירוע או הפקה עם שוברים: עמדת שובר דלוקה, Z סניפי מהענן, בלי שולחנות, והבונים יוצאים במדפסות.',
    profile: profileOf('event', {
      zType: 'shop_cloud',
      localServer: false,
      tablesMode: 'off',
      kitchen: 'printer',
      vouchers: { station: true, balanceCheck: 'auto' },
    }),
  },
];

// ── Reading what the server sends ────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function pick<V extends string>(choices: readonly Choice<V>[], v: unknown, fallback: V): V {
  return choices.some((c) => c.value === v) ? (v as V) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** A profile from anything: each value kept when valid, else `base`'s. */
export function normalizeProfile(raw: unknown, base: WorkProfile = DEFAULT_PROFILE): WorkProfile {
  const r = isObject(raw) ? raw : {};
  const tips = isObject(r.tips) ? r.tips : {};
  const vouchers = isObject(r.vouchers) ? r.vouchers : {};
  const templateId = typeof r.templateId === 'string' && r.templateId ? r.templateId : r.templateId === null ? null : base.templateId;
  return {
    templateId,
    zType: pick(Z_TYPE_CHOICES, r.zType, base.zType),
    shopZFrom: pick(SHOP_Z_FROM_CHOICES, r.shopZFrom, base.shopZFrom),
    localServer: bool(r.localServer, base.localServer),
    // An older server says nothing of it: the main till, as every profile before the field.
    localServerDevice: pick(LOCAL_SERVER_DEVICE_CHOICES, r.localServerDevice, base.localServerDevice),
    tablesMode: pick(TABLES_CHOICES, r.tablesMode, base.tablesMode),
    kitchen: pick(KITCHEN_CHOICES, r.kitchen, base.kitchen),
    customerDisplay: bool(r.customerDisplay, base.customerDisplay),
    attendance: bool(r.attendance, base.attendance),
    tips: {
      enabled: bool(tips.enabled, base.tips.enabled),
      distribution: pick(TIP_DISTRIBUTION_CHOICES, tips.distribution, base.tips.distribution),
    },
    vouchers: {
      station: bool(vouchers.station, base.vouchers.station),
      balanceCheck: pick(BALANCE_CHECK_CHOICES, vouchers.balanceCheck, base.vouchers.balanceCheck),
    },
  };
}

function normalizeStatus(raw: unknown): Partial<Record<string, FieldStatus>> {
  const out: Partial<Record<string, FieldStatus>> = {};
  if (!isObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!isObject(v)) continue;
    const state = v.state === 'applied' || v.state === 'pending' || v.state === 'blocked' ? v.state : null;
    if (!state) continue;
    out[k] = { state, reason: typeof v.reason === 'string' && v.reason.trim() ? v.reason : null };
  }
  return out;
}

function normalizeCanEdit(raw: unknown): Partial<Record<string, boolean>> {
  const out: Partial<Record<string, boolean>> = {};
  if (!isObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'boolean') out[k] = v;
  return out;
}

/** `GET` / `PUT /shops/{id}/work-profile`, defensively. */
export function normalizeView(raw: unknown): WorkProfileView {
  const r = isObject(raw) ? raw : {};
  return {
    profile: isObject(r.profile) ? normalizeProfile(r.profile) : null,
    status: normalizeStatus(r.status),
    canEdit: normalizeCanEdit(r.canEdit),
    stored: typeof r.stored === 'boolean' ? r.stored : null,
    hasTills: typeof r.hasTills === 'boolean' ? r.hasTills : null,
    changes: Array.isArray(r.changes) ? r.changes.filter((c): c is string => typeof c === 'string') : null,
  };
}

function refusalBody(raw: unknown, status: number | null): Refusal | null {
  if (!isObject(raw)) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  // 403 `work_profile_forbidden` names its fields as a list (`fields`): the first is shown.
  const fields = Array.isArray(raw.fields) ? raw.fields.map(str).filter((f): f is string => !!f) : [];
  return { status, code: str(raw.code), message: str(raw.message), field: str(raw.field) ?? fields[0] ?? null };
}

/** A failed `PUT` (or any call) as the server words it: `{detail: {code, message, field}}`. */
export function refusalOf(err: unknown): Refusal | null {
  const res = isObject(err) && isObject(err.response) ? err.response : null;
  if (!res) return null;
  const status = typeof res.status === 'number' ? res.status : null;
  const data = isObject(res.data) ? res.data : null;
  return refusalBody(data?.detail, status) ?? (status != null ? { status, code: null, message: null, field: null } : null);
}

/** The field a refusal names, in words ("סוג Z"), when it is one of the profile's. */
export function refusalFieldLabel(r: Refusal | null | undefined): string | null {
  const top = r?.field?.split('.')[0];
  return top && (WORK_PROFILE_FIELDS as readonly string[]).includes(top) ? FIELD_LABELS[top as WorkProfileField] : null;
}

/**
 * The server's templates (`GET /work-profile/templates`), or the local copy when it has none.
 * `local` says which — the editor notes it.
 */
export function templatesOrFallback(raw: unknown): { templates: WorkProfileTemplate[]; local: boolean } {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.templates) ? raw.templates : null;
  const out: WorkProfileTemplate[] = [];
  for (const item of list ?? []) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id) continue;
    const local = LOCAL_TEMPLATES.find((t) => t.id === item.id);
    out.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : local?.name ?? item.id,
      description:
        typeof item.description === 'string' ? item.description : local?.description ?? '',
      profile: { ...normalizeProfile(item.profile, local?.profile ?? DEFAULT_PROFILE), templateId: item.id },
    });
  }
  return out.length ? { templates: out, local: false } : { templates: LOCAL_TEMPLATES.map((t) => ({ ...t })), local: true };
}

/**
 * What `POST /shops` says of the new shop's profile (`workProfileStatus`): the per-field status,
 * whether it came as the map itself or inside a `{profile, status, canEdit}` view. Null when absent.
 */
export interface CreatedWorkProfile {
  status: Partial<Record<string, FieldStatus>>;
  profile: WorkProfile | null;
  /** false: the profile was refused (the shop was created anyway) — `refused` says why. */
  applied: boolean | null;
  refused: Refusal | null;
}

/**
 * What `POST /shops` says of the new shop's profile (`workProfileStatus`): the `GET` view with
 * `applied` and, when it was not applied, `refused` — or the status map alone. Null when absent.
 */
export function createdWorkProfileOf(data: unknown): CreatedWorkProfile | null {
  if (!isObject(data)) return null;
  const raw = data.workProfileStatus;
  if (!isObject(raw)) return null;
  const sent = isObject(data.workProfile) ? normalizeProfile(data.workProfile) : null;
  if (isObject(raw.status) || 'applied' in raw || 'refused' in raw) {
    const refused = isObject(raw.refused)
      ? refusalBody(raw.refused, typeof raw.refused.status === 'number' ? raw.refused.status : null)
      : null;
    return {
      status: normalizeStatus(raw.status),
      profile: isObject(raw.profile) ? normalizeProfile(raw.profile) : sent,
      applied: typeof raw.applied === 'boolean' ? raw.applied : refused ? false : null,
      refused,
    };
  }
  return { status: normalizeStatus(raw), profile: sent, applied: null, refused: null };
}

// ── Editing ──────────────────────────────────────────────────────────────────

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The fields where `b` differs from `a` (the template id aside). */
export function profileChanges(a: WorkProfile, b: WorkProfile): WorkProfileField[] {
  return WORK_PROFILE_FIELDS.filter((f) => !sameValue(a[f], b[f]));
}

/** The fields changed since the template was applied. */
export function diffFromTemplate(p: WorkProfile, template: WorkProfileTemplate | null | undefined): WorkProfileField[] {
  return template ? profileChanges(template.profile, p) : [];
}

/** The template a profile is exactly, if any (a profile saved before `templateId`, or copied). */
export function matchingTemplate(
  p: WorkProfile,
  templates: readonly WorkProfileTemplate[],
): WorkProfileTemplate | null {
  return templates.find((t) => profileChanges(t.profile, p).length === 0) ?? null;
}

/**
 * The template's values over `base`. Fields the user may not change (`locked`) keep `base`'s —
 * on the shop page a distributor applies a template to what is theirs to change.
 */
export function applyTemplate(
  template: WorkProfileTemplate,
  base: WorkProfile = DEFAULT_PROFILE,
  locked: (f: WorkProfileField) => boolean = () => false,
): WorkProfile {
  const next = normalizeProfile(template.profile, base);
  const out: WorkProfile = { ...next, templateId: template.id };
  for (const f of WORK_PROFILE_FIELDS) if (locked(f)) (out as unknown as Record<string, unknown>)[f] = base[f];
  return out;
}

/**
 * One field changed, and what follows from it so the profile stays valid. The server's rules
 * (spec "שינויים בחוזה" 1): a local server is the main till with "רשת מקומית" on, and then the main
 * till produces the shop Z — so `localServer` is on exactly with "Z סניפי בשרת מקומי"; and tables
 * on the LAN live on that main till. The editor makes the local server follow the Z choice:
 * - "Z סניפי בשרת מקומי" → the local server on;
 * - another Z type → the local server off, and tables on the LAN move to "מסונכרן בין הקופות".
 * (`localServer` set directly moves the Z the same way.) Tables on the LAN cascade nothing: the
 * editor offers them only with the local server on. A field in `locked` is never changed by the
 * cascade, and then nothing else moves with it (the check says what is missing).
 */
export function withField<K extends WorkProfileField>(
  p: WorkProfile,
  field: K,
  value: WorkProfile[K],
  locked: (f: WorkProfileField) => boolean = () => false,
): WorkProfile {
  const out: WorkProfile = { ...p, [field]: value };
  // The Z type and the local server move together, or not at all.
  const free = (...fs: WorkProfileField[]) => fs.every((f) => f === field || !locked(f));
  const goesLocal = (field === 'zType' && value === 'shop_local') || (field === 'localServer' && value === true);
  const leavesLocal = (field === 'zType' && value !== 'shop_local') || (field === 'localServer' && value === false);
  if (goesLocal && free('zType', 'localServer')) {
    out.localServer = true;
    out.zType = 'shop_local';
  } else if (leavesLocal && free('zType', 'localServer')) {
    out.localServer = false;
    // No local server, so no dedicated one either.
    if (free('localServerDevice')) out.localServerDevice = 'main_till';
    if (out.zType === 'shop_local') out.zType = 'shop_cloud';
    if (out.tablesMode === 'lan' && free('tablesMode')) out.tablesMode = 'synced';
  }
  return out;
}

/** The tables choices the editor offers: "רשת מקומית" only with the local server on. */
export function tablesChoiceDisabled(p: WorkProfile, v: ProfileTablesMode): boolean {
  return v === 'lan' && !p.localServer;
}

export interface ProfileIssue {
  field: WorkProfileField;
  code:
    | 'shop_local_needs_local_server'
    | 'local_server_needs_shop_local'
    | 'lan_tables_need_local_server'
    | 'dedicated_needs_local_server';
  message: string;
}

/**
 * What the server refuses (422 `work_profile_invalid`) before anything is saved — the editor
 * says it first, on the field the server names.
 */
export function validateProfile(p: WorkProfile): ProfileIssue[] {
  const out: ProfileIssue[] = [];
  if (p.zType === 'shop_local' && !p.localServer) {
    out.push({
      field: 'localServer',
      code: 'shop_local_needs_local_server',
      message: '"Z סניפי בשרת מקומי" מופק בקופה הראשית — הפעילו "שרת מקומי", או בחרו סוג Z אחר.',
    });
  }
  if (p.localServer && p.zType !== 'shop_local') {
    out.push({
      field: 'localServer',
      code: 'local_server_needs_shop_local',
      message: 'שרת מקומי פועל רק עם "Z סניפי בשרת מקומי": כשהרשת המקומית דלוקה, הקופה הראשית מפיקה את ה-Z של הסניף.',
    });
  }
  if (p.localServerDevice === 'dedicated' && !p.localServer) {
    out.push({
      field: 'localServerDevice',
      code: 'dedicated_needs_local_server',
      message: '"שרת מקומי: מכשיר ייעודי" הוא סוג של שרת מקומי — בחרו "Z סניפי בשרת מקומי", או "קופה ראשית".',
    });
  }
  if (p.tablesMode === 'lan' && !p.localServer) {
    out.push({
      field: 'tablesMode',
      code: 'lan_tables_need_local_server',
      message: 'שולחנות ב"רשת מקומית" עובדים דרך הקופה הראשית — הפעילו "שרת מקומי", או בחרו "מסונכרן בין הקופות".',
    });
  }
  return out;
}

// ── Creating a shop (§7ב: `POST /shops`) ─────────────────────────────────────

export type CreateChoice =
  /** "דלג": the shop as today, no profile. */
  | { kind: 'skip' }
  /** A template and/or fields chosen here. */
  | { kind: 'profile'; profile: WorkProfile }
  /**
   * "העתק תצורה מסניף קיים": the server copies it (`copyWorkProfileFromShopId`) — unless a field
   * was changed after copying (`edited`), and then the profile as edited is sent.
   */
  | { kind: 'copy'; shopId: string; profile: WorkProfile | null; edited: boolean };

export function createPayloadOf(
  choice: CreateChoice,
): { workProfile?: WorkProfile; copyWorkProfileFromShopId?: string } {
  switch (choice.kind) {
    case 'skip':
      return {};
    case 'profile':
      return { workProfile: choice.profile };
    case 'copy':
      return choice.edited && choice.profile ? { workProfile: choice.profile } : { copyWorkProfileFromShopId: choice.shopId };
  }
}

export interface SummaryLine {
  field: WorkProfileField;
  label: string;
  value: string;
  /** When it applies, or what it waits for. */
  note: string | null;
}

/**
 * "סיכום לפני שמירה" (§2.3) for a new shop — no tills yet: what is set at once, and what waits
 * for the first till (the Z type, the main till and the LAN).
 */
export function creationSummary(p: WorkProfile): { now: SummaryLine[]; waiting: SummaryLine[] } {
  const line = (field: WorkProfileField, note: string | null = null): SummaryLine => ({
    field,
    label: FIELD_LABELS[field],
    value: fieldValueText(field, p),
    note,
  });
  const waiting: SummaryLine[] = [];
  const now: SummaryLine[] = [];
  waiting.push(
    line(
      'zType',
      p.zType === 'shop_local'
        ? 'יופעל כשתצומד הקופה הראשונה — היא תוצע כקופה הראשית.'
        : p.zType === 'per_till'
          ? 'כל קופה שתצומד תוצע עם Z משלה.'
          : 'כל קופה שתצומד תוצע ב-Z הסניפי מהענן.',
    ),
  );
  if (p.localServer && p.localServerDevice === 'dedicated') {
    waiting.push(line('localServer', 'השרת הוא מכשיר ייעודי: הוסיפו "שרת מקומי" (הוספת מכשיר), וצימוד שלו יפעיל את הרשת המקומית.'));
    waiting.push(line('localServerDevice', 'קופה לא תוצע כקופה ראשית — השרת המקומי הוא המארח.'));
  } else if (p.localServer) {
    waiting.push(line('localServer', 'הקופה הראשונה שתצומד תוצע כקופה ראשית, והרשת המקומית תופעל איתה.'));
  } else {
    now.push(line('localServer'));
  }
  if (p.zType !== 'per_till') now.push(line('shopZFrom'));
  now.push(line('tablesMode', p.tablesMode === 'lan' ? 'נקבע עכשיו; עובד דרך הקופה הראשית כשתצומד.' : null));
  now.push(line('kitchen', p.kitchen === 'printer' ? null : 'את מסכי המטבח מצמידים ומגדירים בדף "מסכי מטבח".'));
  now.push(line('customerDisplay'), line('attendance'), line('tips'), line('vouchers'));
  return { now, waiting };
}

// ── The server's view: status and permissions ────────────────────────────────

const STATE_RANK: Record<FieldState, number> = { applied: 0, pending: 1, blocked: 2 };

/**
 * A field's status: its own key, else the worst of its sub-keys (`tips.enabled`…), with the first
 * reason found. Null when the server says nothing of it.
 */
export function fieldStatus(
  status: Partial<Record<string, FieldStatus>> | null | undefined,
  field: WorkProfileField,
): FieldStatus | null {
  if (!status) return null;
  const own = status[field];
  if (own) return own;
  const subs = Object.entries(status)
    .filter(([k, v]) => !!v && k.startsWith(`${field}.`))
    .map(([, v]) => v as FieldStatus);
  if (!subs.length) return null;
  const worst = subs.reduce((a, b) => (STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a));
  const reason = worst.reason ?? subs.find((s) => s.state === worst.state && s.reason)?.reason ?? null;
  return { state: worst.state, reason };
}

/**
 * Whether the user may change a field: its own key, else all its sub-keys. A field the server
 * says nothing of is editable — the server still refuses what is not the user's.
 */
export function fieldEditable(canEdit: Partial<Record<string, boolean>> | null | undefined, field: WorkProfileField): boolean {
  if (!canEdit) return true;
  const own = canEdit[field];
  if (typeof own === 'boolean') return own;
  const subs = Object.entries(canEdit).filter(([k]) => k.startsWith(`${field}.`));
  return subs.length ? subs.every(([, v]) => v !== false) : true;
}

export const STATE_LABELS: Record<FieldState, string> = {
  applied: '✓ הוחל',
  pending: '⏳ ממתין',
  blocked: '⚠ לא הוחל',
};

/** "7 הוחלו · 2 ממתינים · 1 לא הוחל" — over the profile's fields only. */
export function statusCounts(status: Partial<Record<string, FieldStatus>> | null | undefined): Record<FieldState, number> {
  const out: Record<FieldState, number> = { applied: 0, pending: 0, blocked: 0 };
  for (const f of WORK_PROFILE_FIELDS) {
    const s = fieldStatus(status, f);
    if (s) out[s.state] += 1;
  }
  return out;
}

export function statusCountsText(counts: Record<FieldState, number>): string {
  const parts: string[] = [];
  if (counts.applied) parts.push(`${counts.applied} הוחלו`);
  if (counts.pending) parts.push(`${counts.pending} ממתינים לקופה`);
  if (counts.blocked) parts.push(`${counts.blocked} לא הוחלו`);
  return parts.join(' · ');
}

/** The profile as the user may send it: the fields they may not change keep the saved values. */
export function editableOnly(
  draft: WorkProfile,
  saved: WorkProfile,
  canEdit: Partial<Record<string, boolean>> | null | undefined,
): WorkProfile {
  const out: WorkProfile = { ...draft };
  for (const f of WORK_PROFILE_FIELDS) {
    if (!fieldEditable(canEdit, f)) (out as unknown as Record<string, unknown>)[f] = saved[f];
  }
  return out;
}
