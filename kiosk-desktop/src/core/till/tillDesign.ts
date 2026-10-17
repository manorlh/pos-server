/**
 * "עיצוב קופה" on the Windows till (pos-server docs/SPEC_TILL_DESIGN.md; pos-android domain/TillDesign*.kt,
 * domain/FlowDesign.kt, ui/sell/design/TillDesignLocal.kt): the cloud's resolved design for this machine turned into what
 * the till screens draw — `TillState.design` (shared/till/protocol.ts).
 *
 * Nothing of the design's rules is written here: the merge, `forProfile`, the bars, the banknotes, the texts and `flow`
 * are the dashboard's own client/src/lib/tillDesign.ts (`@dash-lib/tillDesign`), which the shared fixtures
 * till_design_contract.json / flow_design_contract.json pin against the server and the Android till
 * (test/tillDesignContract.test.ts runs them here too). What this file adds is the Windows till's side of it:
 *
 *  - the device profile (`tillDesignProfileOf`, Android `deviceProfileOf`): handheld under a 600 dp short side, else a
 *    tablet sideways or upright. The window's size is only known to the screens (and it changes with a resize, a
 *    rotation, a second screen), so the engine sends a view for EACH of the Android till's three profiles and the
 *    renderer picks one with `designFor(state.design, tillDesignProfileOf(widthDp, heightDp))` — a resize never waits
 *    for the engine;
 *  - the "auto" values that only the till knows (Python `legacy_view`): the tile size and the quick order's bar from the
 *    till parameters, the fields from askOrderName / askEatInTakeAway / tablesAskGuests, the dietary words;
 *  - the quick order's bar as drawn (Android `designActionItems` + `designBarButtons`): a tender this till does not
 *    allow left off, a preset discount's button only for a preset this till has (its name when the button has none);
 *  - `look` over the tile-text parameters (Android TillDesignLook.kt: a code set in the design wins; null / "base" /
 *    unknown — the parameter's);
 *  - what the Windows till cannot honour yet (`unsupported`): it has no tables, so whatever lives only on a table.
 *
 * Pure.
 */

import {
  ACTION_LABELS,
  ANDROID_PROFILES,
  FLOW_SHELLS,
  PRESET_ACTION,
  TEMPLATES,
  TEMPLATE_ALIASES,
  TEXT_KEYS,
  TILL_DESIGN_DEFAULTS,
  actionLabelOf,
  actionsFor,
  flowForProfile,
  forProfile,
  legacyQuickActions,
  quickCashNotes,
  resolveFieldMode,
  resolveTileSize,
  resolveTillDesign,
  textOf,
  type ActionItem,
  type FieldMode,
  type ProfileView,
  type Template,
  type TillDesignConfig,
  type TillDesignLayer,
  type TillDesignLegacy,
} from '@dash-lib/tillDesign';
import { normalizeHex, textColorOfParam, themeModeOfParam } from '@dash-lib/posLook';
import { TILE_TEXT_PARAMS, tileTextOf } from './tileText';
import type {
  TillDesignAction,
  TillDesignProfileName,
  TillDesignProfileState,
  TillDesignState,
  TillDesignTexts,
  TillThemeState,
  TileTextState,
} from '../../shared/till/protocol';

// The renderer computes the banknotes for a total of its own (a split, the change keypad) with the same rule.
export { quickCashNotes, resolveTillDesign, TILL_DESIGN_DEFAULTS, type TillDesignConfig };

/** The profiles a Windows / web till chooses between: the Android till's three (the iPad ones are the dashboard preview's). */
export const TILL_DESIGN_PROFILES: readonly TillDesignProfileName[] = ANDROID_PROFILES as TillDesignProfileName[];

/** The handheld's line: a short side under 600 dp (Android TABLET_MIN_SMALLEST_WIDTH_DP, tillLayout.ts the same). */
export const HANDHELD_MAX_SHORT_DP = 600;

/**
 * The design profile of a window `widthDp` × `heightDp` (CSS px = dp) — Android `deviceProfileOf`: a handheld when its
 * shorter side is under 600, else a tablet held sideways (wider than tall) or upright. A square window is upright, as
 * on Android.
 */
export function tillDesignProfileOf(widthDp: number, heightDp: number): TillDesignProfileName {
  if (Math.min(widthDp, heightDp) < HANDHELD_MAX_SHORT_DP) return 'handheld';
  return widthDp > heightDp ? 'tabletLandscape' : 'tabletPortrait';
}

/** What one profile shows with the shared parts: what a screen reads (`designFor`). */
export type TillDesignView = Omit<TillDesignState, 'profiles'> & TillDesignProfileState;

/** The design as the window's profile shows it. */
export function designFor(design: TillDesignState, profile: TillDesignProfileName): TillDesignView {
  const { profiles, ...shared } = design;
  return { ...shared, ...(profiles[profile] ?? profiles.tabletLandscape) };
}

/* ------------------------------------------------------- the stored bundle */

/** `GET /sync/{m}/till-design` as kept on the device (main/till/tillDesign.ts): the bundle's parts and its ETag. */
export interface StoredTillDesign {
  /** The bundle's `config`: the cloud's resolved design for this machine. */
  config: Record<string, unknown>;
  configVersion: string | null;
  /** This till's order-number prefix ("" — none, or a cloud that does not send it). */
  orderNumberPrefix: string;
  updatedAt: string | null;
  /** The answer's ETag, sent back as If-None-Match; null — the cloud sent none. */
  etag: string | null;
}

/** A bundle the till can keep, or null (no config — nothing changes). */
export function bundleOf(body: unknown, etag: string | null): StoredTillDesign | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const config = b.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const v = b.configVersion;
  return {
    config: config as Record<string, unknown>,
    configVersion: typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null,
    // Phase 2 §6.5: absent from an older cloud — "".
    orderNumberPrefix: typeof b.orderNumberPrefix === 'string' ? b.orderNumberPrefix.trim() : '',
    updatedAt: typeof b.updatedAt === 'string' ? b.updatedAt : null,
    etag: etag && etag.trim() ? etag.trim() : null,
  };
}

/**
 * The config a till draws from a stored one: the defaults ⊕ it, sanitised (`resolveTillDesign`) — a section an older
 * cloud does not send is its default, a value this till does not know is dropped (the Android till's tolerant parse).
 */
export function configOf(stored: Pick<StoredTillDesign, 'config'> | null | undefined): TillDesignConfig {
  return stored ? resolveTillDesign(canonicalTemplates(stored.config)) : resolveTillDesign();
}

/**
 * An older template name (TEMPLATE_ALIASES: "classic", "nightBar"…) read as its template before the schema sees it, as
 * the Android till's parse and `forProfile` read it (the schema itself refuses the old names, and would drop them).
 */
function canonicalTemplates(config: Record<string, unknown>): TillDesignLayer {
  const alias = (v: unknown) => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATE_ALIASES, v) ? TEMPLATE_ALIASES[v] : v);
  const out: Record<string, unknown> = { ...config, template: alias(config.template) };
  const profiles = config.profiles;
  if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
    const next: Record<string, unknown> = {};
    for (const [p, over] of Object.entries(profiles as Record<string, unknown>)) {
      next[p] = over && typeof over === 'object' && !Array.isArray(over) ? { ...(over as Record<string, unknown>), template: alias((over as Record<string, unknown>).template) } : over;
    }
    out.profiles = next;
  }
  if (out.template === undefined) delete out.template;
  return out;
}

/* ------------------------------------------------- the till parameters' "auto" */

const TILE_WORDS: Record<string, 'xs' | 's' | 'm' | 'l'> = { 'קטן מאוד': 'xs', קטן: 's', בינוני: 'm', גדול: 'l' };

/** A parameter's yes / no (the cloud's JSON boolean, or its words); null — not set. */
function flag(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return null;
}

/**
 * The "auto" values as this till's parameters set them — pos-server `legacy_view` (the dashboard gets it from the
 * server; the till reads its own parameters): the tile sizes, the quick bar, the fields, the tables' look, the dietary
 * words and the product text.
 */
export function legacyOf(params: Record<string, unknown> | null | undefined): TillDesignLegacy {
  const p = params ?? {};
  const word = (key: string) => {
    const v = p[key];
    return typeof v === 'string' ? (TILE_WORDS[v.trim()] ?? null) : null;
  };
  const mapStyle = p.tablesMapStyle;
  const tt = tileTextOf(p);
  return {
    tileSize: {
      quick: word('productTileSize') ?? 'm',
      quickTablet: word('productTileSizeTablet') ?? word('productTileSize') ?? 'm',
      table: word('productTileSizeTables') ?? 'm',
      tableTablet: word('productTileSizeTabletTables') ?? word('productTileSizeTables') ?? 'm',
    },
    quickActions: legacyQuickActions(p),
    fields: {
      customerName: flag(p.askOrderName) ? 'required' : 'off',
      serviceType: flag(p.askEatInTakeAway) ? 'required' : 'off',
      guests: flag(p.tablesAskGuests) ? 'required' : 'off',
    },
    tables: {
      mapStyle: typeof mapStyle === 'string' && mapStyle.startsWith('מודרני') ? 'modern' : 'classic',
      showChairs: flag(p.tablesShowChairs) === false ? 'hide' : 'show',
    },
    coursesEnabled: flag(p.coursesEnabled) === true,
    showDietaryMarks: flag(p.showDietaryMarks) === true,
    productText: { productNameFit: tt.fit, productNameMaxLines: tt.maxLines, productNameMinTextSize: tt.minSize, productInfoBadge: tt.infoBadge },
  };
}

/* ---------------------------------------------------------------- look */

const LOOK_WORDS: Record<'fit' | 'minSize' | 'infoBadge', readonly string[]> = {
  fit: ['fit', 'wrap', 'clip'],
  minSize: ['s', 'm', 'l'],
  infoBadge: ['auto', 'always', 'off'],
};

/**
 * The tile-text parameters with the design's `look` over them — Android TillLook.parse + applyTo: a value the design
 * sets (one of the vocabulary; the lines 1–4, a number or its digits) replaces the parameter of the same name; absent,
 * null, "", "base" ("כמו הבסיס") or unknown leaves the parameter's. The default design changes nothing.
 */
export function withLook(params: Record<string, unknown> | null | undefined, cfg: Pick<TillDesignConfig, 'look'> | null | undefined): Record<string, unknown> {
  const p = params ?? {};
  const look = cfg?.look as Record<string, unknown> | undefined;
  if (!look || typeof look !== 'object') return p;
  const out: Record<string, unknown> = { ...p };
  let changed = false;
  const word = (key: 'fit' | 'minSize' | 'infoBadge') => {
    const raw = look[TILE_TEXT_PARAMS[key]];
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (LOOK_WORDS[key].includes(v)) {
      out[TILE_TEXT_PARAMS[key]] = v;
      changed = true;
    }
  };
  word('fit');
  word('minSize');
  word('infoBadge');
  const rawLines = look[TILE_TEXT_PARAMS.maxLines];
  const lines = typeof rawLines === 'number' ? rawLines : typeof rawLines === 'string' && /^\s*\d+\s*$/.test(rawLines) ? Number(rawLines) : Number.NaN;
  if (Number.isInteger(lines) && lines >= 1 && lines <= 4) {
    out[TILE_TEXT_PARAMS.maxLines] = lines;
    changed = true;
  }
  return changed ? out : p;
}

/**
 * The till parameters with the design over them where the two overlap and the Windows till reads the parameter —
 * Android applyTillDesign (domain/TillDesignOverlay.kt), so every rule that reads the parameters (the order's details,
 * the tiles' text) honours the design, the clean template included:
 *
 *     fields.customerName  askOrderName      off / optional → false, required → true ("auto": the parameter's)
 *     fields.serviceType   askEatInTakeAway  the same (optional is the designed screens', never asked before payment)
 *     look.*               the tile-text parameters of the same names (`withLook`)
 *
 * The tables' overlaps (tablesAskGuests, tablesMapStyle, tablesShowChairs) are not read on Windows; the colours and the
 * menu order are the screens' (`TillState.design`). The default design returns `params` itself.
 */
export function designParameters(params: Record<string, unknown> | null | undefined, cfg: Pick<TillDesignConfig, 'fields' | 'look'> | null | undefined): Record<string, unknown> {
  const base = params ?? {};
  if (!cfg) return base;
  let out = withLook(base, cfg);
  const set = (key: string, mode: FieldMode | undefined) => {
    const v = mode === 'off' || mode === 'optional' ? 'false' : mode === 'required' ? 'true' : null;
    if (v === null || String(out[key] ?? '').trim().toLowerCase() === v) return;
    if (out === base) out = { ...base };
    out[key] = v;
  };
  set('askOrderName', cfg.fields?.customerName);
  set('askEatInTakeAway', cfg.fields?.serviceType);
  return out;
}

/** The tiles' text as the till shows it: the design's `look` over the parameters (`TillState.tileText` too). */
export function lookOf(params: Record<string, unknown> | null | undefined, cfg: Pick<TillDesignConfig, 'look'> | null | undefined): TileTextState {
  return tileTextOf(withLook(params, cfg));
}

/* ------------------------------------------------------------- the theme */

/**
 * The till's colours — Android applyTillDesign's precedence: the design's accent (#RRGGBB) over the settings'
 * `brandPrimaryColor` (null / "brand": the settings'), the design's light / dark over the till parameter `themeMode`
 * ("auto": the parameter's — "כהה" / "dark", "בהיר" / "light", else the system's), and the parameter `textColor`.
 */
export function themeOf(
  cfg: Pick<TillDesignConfig, 'colors'> | null | undefined,
  params: Record<string, unknown> | null | undefined,
  settings: Record<string, unknown> | null | undefined,
): TillThemeState {
  const p = params ?? {};
  const mode = cfg?.colors?.mode;
  return {
    brand: normalizeHex(cfg?.colors?.accent) ?? normalizeHex((settings ?? {}).brandPrimaryColor),
    mode: mode === 'light' || mode === 'dark' ? mode : themeModeOfParam(p.themeMode),
    textColor: textColorOfParam(p.textColor),
  };
}

/* ------------------------------------------------------------- the bar */

/** The tenders this till takes now (Android `allowed` PaymentOptions): a tender's button is left off without it. */
export interface DesignTenders {
  /** "אשראי מהיר": a card at all (not "ללא אשראי") and the parameter `fastCard` not off. */
  fastCard: boolean;
  /** "מזומן מהיר": the parameter `fastCash` not off. */
  fastCash: boolean;
  /** "מזומן עם עודף" / "שטרות". */
  cash: boolean;
}

/** The tenders as the parameters set them (`fastCard` / `fastCash` not off), and the card as the till has it. */
export function tendersOf(params: Record<string, unknown> | null | undefined, card = true): DesignTenders {
  const p = params ?? {};
  return { fastCard: card && flag(p.fastCard) !== false, fastCash: flag(p.fastCash) !== false, cash: true };
}

/** A preset discount this till has (its id and name): a design's preset button names it. */
export interface DesignPreset {
  id: string;
  name: string;
}

/**
 * A quick order's bar as drawn (Android designActionItems + designBarButtons): the profile's or the base's list, else
 * the template's own ("עגינת תשלום"), else the till parameters'; a tender not taken here left off; a preset's button
 * kept only for a preset this till has (`presets` null — not known: kept), its label its own or the preset's name;
 * "pay" the primary one. "שטרות" stays one item — the notes are `quickCash.offered`.
 */
export function quickBar(view: ProfileView, cfg: TillDesignConfig, legacy: TillDesignLegacy, tenders: DesignTenders, presets: readonly DesignPreset[] | null): TillDesignAction[] {
  const out: TillDesignAction[] = [];
  for (const item of actionsFor(view, 'quick', legacy) as ActionItem[]) {
    if (item.action === 'fastCard' && !tenders.fastCard) continue;
    if (item.action === 'fastCash' && !tenders.fastCash) continue;
    if ((item.action === 'cashWithChange' || item.action === 'cashNotes') && !tenders.cash) continue;
    const presetId = item.action === PRESET_ACTION && typeof item.presetId === 'string' && item.presetId ? item.presetId : null;
    if (presetId) {
      const preset = presets ? presets.find((p) => p.id === presetId) : null;
      if (presets && !preset) continue;
      const own = item.label?.trim();
      out.push({ action: item.action, label: own || preset?.name || ACTION_LABELS[item.action], primary: false, presetId });
      continue;
    }
    out.push({ action: item.action, label: actionLabelOf(item, cfg), primary: item.action === 'pay' });
  }
  return out;
}

/* ------------------------------------------------- what Windows cannot do yet */

/** A template's features that live only on a table (Android draws them in table mode only). */
const TABLE_FEATURES = ['seatCards', 'seatPicker', 'courseLanes'] as const;
/** A quick bar's buttons the Windows till has no screen for yet ("לקוח" — the club is "בקרוב"). */
const QUICK_ACTIONS_NOT_HERE = ['customer'] as const;

/**
 * What the design sets that the Windows till does not honour (yet) — it has no tables, no order number at open, no
 * club and no till Motion Engine — by path, for the log and the technician (nothing here changes what is drawn: the
 * screens draw the quick order as Android's quick order does). Only what is SET (not today's defaults) is named:
 *
 *  - `template.courses`             "לוח מנות" is clean on a quick order (Android templateDrawn);
 *  - `features.<f>`                 seat cards / the seat picker / course lanes: a table's;
 *  - `actionBar.table`              the table's bar (the base's or a profile's);
 *  - `actionBar.quick.customer`     "לקוח" on the quick bar;
 *  - `fields.guests`, `tables.*`, `courses.*`, `hints.fireHints`  the tables' own settings;
 *  - `flow.home`, `flow.firstStep`, `flow.askGuests`  "זרימה" starting from the tables / asking the guests;
 *  - `orderNumber.atOpen`           "מספר הזמנה כבר בפתיחה": the engine numbers no order at open yet;
 *  - `motion`                       "הנפשות" with a preset that animates (the kiosk's Motion Engine on the till).
 */
export function unsupportedOf(cfg: TillDesignConfig, views: readonly ProfileView[]): string[] {
  const out = new Set<string>();
  const d = TILL_DESIGN_DEFAULTS;
  for (const v of views) {
    if (v.template === 'courses') out.add('template.courses');
    for (const f of TABLE_FEATURES) if (v.features.includes(f)) out.add(`features.${f}`);
    for (const a of QUICK_ACTIONS_NOT_HERE) if (v.actions.quick.some((i) => i.action === a)) out.add(`actionBar.quick.${a}`);
  }
  const ownTableBar = cfg.actionBar.table.length > 0 || ANDROID_PROFILES.some((p) => Array.isArray(cfg.profiles?.[p]?.actionBar?.table));
  if (ownTableBar) out.add('actionBar.table');
  if (cfg.fields.guests !== 'auto') out.add('fields.guests');
  if (cfg.tables.mapStyle !== d.tables.mapStyle) out.add('tables.mapStyle');
  if (cfg.tables.showChairs !== d.tables.showChairs) out.add('tables.showChairs');
  if (cfg.courses.fireGapMinutes !== d.courses.fireGapMinutes) out.add('courses.fireGapMinutes');
  if (cfg.courses.autoFireFirst !== d.courses.autoFireFirst) out.add('courses.autoFireFirst');
  if (cfg.hints?.fireHints) out.add('hints.fireHints');
  const flow = cfg.flow;
  if (flow?.home === 'tables') out.add('flow.home');
  if (flow?.firstStep === 'table') out.add('flow.firstStep');
  if (flow?.askGuests && flow.askGuests !== 'auto') out.add('flow.askGuests');
  if (cfg.orderNumber.atOpen) out.add('orderNumber.atOpen');
  // "legacy" (none set) and "ללא הנפשות" move nothing: only a preset that animates is not honoured here.
  const preset = (cfg.motion as { preset?: unknown } | undefined)?.preset;
  if (typeof preset === 'string' && preset !== 'legacy' && preset !== 'none') out.add('motion');
  return Array.from(out).sort();
}

/* ------------------------------------------------------------- the view */

export interface DesignInputs {
  /** The till parameters (`GET /sync/{m}/parameters`). */
  parameters: Record<string, unknown> | null | undefined;
  configVersion?: string | null;
  orderNumberPrefix?: string;
  tenders?: DesignTenders;
  /** The till's preset discounts; null — not known (a preset's button is kept). */
  presets?: readonly DesignPreset[] | null;
  /** The quick order's total now (agorot): the banknotes offered over it. */
  totalAgorot?: number;
}

function profileState(cfg: TillDesignConfig, profile: TillDesignProfileName, view: ProfileView, legacy: TillDesignLegacy, tenders: DesignTenders, presets: readonly DesignPreset[] | null): TillDesignProfileState {
  const shell = flowForProfile(cfg, profile).shell;
  return {
    profile,
    template: view.template,
    // A quick order is all the Windows till has: "לוח מנות" draws clean there (Android templateDrawn).
    drawn: view.template === 'courses' ? 'clean' : view.template,
    tileSize: resolveTileSize(view, 'quick', legacy),
    tileStyle: view.tileStyle,
    density: view.density,
    billPosition: view.billPosition.quick,
    billStyle: view.billStyle,
    summaryCollapsible: view.summaryCollapsible,
    categoryBar: view.categoryBar,
    columns: view.columns,
    images: view.images,
    textSize: view.textSize,
    features: view.features.filter((f) => !(TABLE_FEATURES as readonly string[]).includes(f)),
    actionBar: quickBar(view, cfg, legacy, tenders, presets),
    shell: (FLOW_SHELLS as readonly string[]).includes(shell) ? shell : 'classic',
  };
}

/**
 * The part of the view that does not move with the order (everything but the banknotes over the total): what the
 * engine caches per config and parameters (`withTotal` adds the notes on each state).
 */
export function designState(cfg: TillDesignConfig, inputs: DesignInputs): TillDesignState {
  const params = inputs.parameters ?? {};
  const legacy = legacyOf(params);
  const tenders = inputs.tenders ?? tendersOf(params);
  const presets = inputs.presets ?? null;
  const views = TILL_DESIGN_PROFILES.map((p) => forProfile(cfg, p));
  const profiles = {} as Record<TillDesignProfileName, TillDesignProfileState>;
  TILL_DESIGN_PROFILES.forEach((p, i) => {
    profiles[p] = profileState(cfg, p, views[i], legacy, tenders, presets);
  });
  const texts = {} as TillDesignTexts;
  for (const key of TEXT_KEYS) texts[key] = textOf(cfg, key);
  const field = (mode: FieldMode, own: 'off' | 'required') => resolveFieldMode(mode, own);
  const flow = flowForProfile(cfg, 'tabletLandscape');
  const accent = cfg.colors.accent;
  const notes = cfg.quickCash.notes.slice();
  const count = cfg.quickCash.count;
  return {
    configVersion: inputs.configVersion ?? null,
    profiles,
    // null = the brand colour (brandPrimaryColor); "brand" is the same over a parent's accent.
    colors: { accent: typeof accent === 'string' && /^#[0-9A-Fa-f]{6}$/.test(accent) ? accent : null, mode: cfg.colors.mode },
    quickCash: { notes, count, offered: quickCashNotes(Math.max(0, inputs.totalAgorot ?? 0), notes, count) },
    bar: { ...cfg.bar, quantityPresets: cfg.bar.quantityPresets.slice(), favorites: cfg.bar.favorites.slice() },
    menu: { categoryOrder: cfg.menu.categoryOrder.slice(), productOrder: cfg.menu.productOrder.slice(), hiddenCategories: cfg.menu.hiddenCategories.slice() },
    texts,
    fields: {
      customerName: field(cfg.fields.customerName, legacy.fields.customerName),
      serviceType: field(cfg.fields.serviceType, legacy.fields.serviceType),
      guests: field(cfg.fields.guests, legacy.fields.guests),
    },
    behavior: { ...cfg.behavior },
    payDock: { ...cfg.payDock },
    night: { ...cfg.night },
    visual: { descriptionLines: cfg.visual.descriptionLines, dietary: cfg.visual.dietary === 'auto' ? (legacy.showDietaryMarks ? 'show' : 'hide') : cfg.visual.dietary },
    professional: { ...cfg.professional },
    orderNumber: { atOpen: cfg.orderNumber.atOpen, prefix: cfg.orderNumber.atOpen ? (inputs.orderNumberPrefix ?? '') : '' },
    look: lookOf(params, cfg),
    flow: { home: flow.home, firstStep: flow.firstStep, askGuests: flow.askGuests, notes: flow.notes, pickupName: flow.pickupName, background: flow.background },
    unsupported: unsupportedOf(cfg, views),
  };
}

/** `state` with the banknotes offered over `totalAgorot` (the rest as it is — a new object only when they differ). */
export function withTotal(state: TillDesignState, totalAgorot: number): TillDesignState {
  const offered = quickCashNotes(Math.max(0, totalAgorot), state.quickCash.notes, state.quickCash.count);
  const same = offered.length === state.quickCash.offered.length && offered.every((n, i) => n === state.quickCash.offered[i]);
  return same ? state : { ...state, quickCash: { ...state.quickCash, offered } };
}

/** The default design (nothing set anywhere — today's screens) for a till with these parameters. */
export function defaultDesignState(parameters: Record<string, unknown> | null = null): TillDesignState {
  return designState(resolveTillDesign(), { parameters });
}

/* ------------------------------------------------------------- the demo */

/** `?design=` words: a template, or "flow" ("זרימה" on every profile over clean). */
export const DEMO_DESIGNS: readonly string[] = [...TEMPLATES, 'flow'];

/**
 * The demo's design from the page's query (`npm run dev:web` → /app.html?design=night&accent=%23E11D48&mode=dark): the
 * defaults with that template (flow: `flow.shell` "flow" over clean), the accent (#RRGGBB, the "#" optional) and the
 * colour mode. Null when the query names no design, accent or mode (the demo then shows the defaults).
 */
export function demoDesignConfig(search: string | null | undefined): TillDesignConfig | null {
  if (!search) return null;
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search);
  } catch {
    return null;
  }
  const word = (q.get('design') ?? '').trim();
  const accentRaw = (q.get('accent') ?? '').trim();
  const modeRaw = (q.get('mode') ?? '').trim().toLowerCase();
  const layer: Record<string, unknown> = {};
  if (word === 'flow') layer.flow = { shell: 'flow' };
  else if ((TEMPLATES as readonly string[]).includes(word)) layer.template = word as Template;
  const accent = accentRaw ? (accentRaw.startsWith('#') ? accentRaw : `#${accentRaw}`) : '';
  const colors: Record<string, unknown> = {};
  if (/^#[0-9A-Fa-f]{6}$/.test(accent)) colors.accent = accent.toUpperCase();
  if (modeRaw === 'dark' || modeRaw === 'light') colors.mode = modeRaw;
  if (Object.keys(colors).length > 0) layer.colors = colors;
  return Object.keys(layer).length > 0 ? resolveTillDesign(layer) : null;
}
