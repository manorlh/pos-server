/**
 * "תצורת עבודה עם שובר" — the production voucher's till settings, grouped (the owner, 13.10.2026: "תארגן
 * מחדש את הגדרות תצורת עבודת שובר באמצעי תשלום, זה לא נוח").
 *
 * Pure: which group each setting sits in and in what order, its control, a level's own value and the one
 * in force, what a setting depends on (shown dimmed while it does nothing), the summary line per group,
 * the group headers' badges, the "only what this level sets" filter and the groups' open / closed state as
 * remembered per viewer. The component (components/dashboard/vouchers/voucher-work-settings.tsx) only
 * draws them, on the payment methods page and in the till settings dialog alike.
 *
 * The keys, values and defaults stay the server's (lib/voucherTillSettings.ts, lib/voucherRedeemFlow.ts).
 */
import {
  VOUCHER_REDEEM_FLOWS,
  isVoucherRedeemFlow,
  resolveVoucherRedeemFlow,
  resolveVoucherShowUnavailable,
} from './voucherRedeemFlow';
import { VOUCHER_SWITCH_DEFAULT } from './paymentOptions';
import {
  VOUCHER_AUTO_APPLY_VALUES,
  VOUCHER_AUTO_CLOSE_VALUES,
  VOUCHER_BALANCE_CHECK_MODES,
  VOUCHER_PICK_FILTER_VALUES,
  VOUCHER_SHOW_ENTITLEMENT_VALUES,
  VOUCHER_SOUND_VALUES,
  VOUCHER_STATION_PAID_ITEMS_VALUES,
  VOUCHER_STATION_TITLE_MAX,
  VOUCHER_STATION_VALUES,
  VOUCHER_SUCCESS_DISMISS_VALUES,
  VOUCHER_SUCCESS_SCREEN_VALUES,
  VOUCHER_SUCCESS_SECONDS_VALUES,
  isVoucherFastChoiceKey,
  isVoucherFastChoiceValue,
  isVoucherSuccessSeconds,
  resolveVoucherAutoApply,
  resolveVoucherAutoClose,
  resolveVoucherAutoPickSingle,
  resolveVoucherBalanceCheck,
  resolveVoucherFastChoice,
  resolveVoucherGuide,
  resolveVoucherPickFilter,
  resolveVoucherShowEntitlement,
  resolveVoucherSound,
  resolveVoucherStation,
  resolveVoucherStationPaidItems,
  resolveVoucherStationTitle,
  resolveVoucherSuccessDismiss,
  resolveVoucherSuccessScreen,
  resolveVoucherSuccessSeconds,
  voucherFastChoiceValues,
  voucherStationNeedsAdvice,
} from './voucherTillSettings';

/** A layer's values as drafted or stored, or what it inherits: read loosely — junk reads as unset. */
export type VoucherWorkLayer = object | undefined | null;

function read(layer: VoucherWorkLayer, key: string): unknown {
  return layer ? (layer as Record<string, unknown>)[key] : undefined;
}

/** The four groups, in the page's order, and their settings in each. */
export const VOUCHER_WORK_GROUPS = [
  {
    id: 'redeem',
    keys: [
      'voucherRedeemFlow',
      'voucherShowUnavailable',
      // "בחר פריט לשובר" (P:/specs/voucher-station-fast-flows.md §4): the order screen a voucher that
      // needs items opens on its scan.
      'voucherGuide',
      'voucherPickFilter',
      'voucherAutoPickSingle',
      'voucherAutoApply',
      'voucherFastMode',
      'voucherFastAutoClose',
      'voucherShowEntitlement',
      'voucherBalanceCheck',
    ],
  },
  { id: 'close', keys: ['voucherAutoClose', 'voucherSuccessScreen', 'voucherSuccessDismiss', 'voucherSuccessSeconds'] },
  {
    id: 'station',
    keys: [
      'voucherStation',
      'voucherStationPaidItems',
      'voucherStationCamera',
      'voucherStationCameraFacing',
      'voucherStationCatalogSwitch',
      'voucherStationHeader',
      'voucherStationTitle',
    ],
  },
  { id: 'sound', keys: ['voucherSoundApprove', 'voucherSoundReject', 'voucherSoundBoost', 'voucherVibrate'] },
] as const;

export type VoucherWorkGroupId = (typeof VOUCHER_WORK_GROUPS)[number]['id'];
export type VoucherWorkKey = (typeof VOUCHER_WORK_GROUPS)[number]['keys'][number];

export const VOUCHER_WORK_GROUP_IDS: readonly VoucherWorkGroupId[] = VOUCHER_WORK_GROUPS.map((g) => g.id);
/** Every voucher work setting, in the page's order. */
export const VOUCHER_WORK_KEYS: readonly VoucherWorkKey[] = VOUCHER_WORK_GROUPS.flatMap((g) => g.keys);

export function isVoucherWorkKey(key: unknown): key is VoucherWorkKey {
  return typeof key === 'string' && (VOUCHER_WORK_KEYS as readonly string[]).includes(key);
}

export function voucherWorkGroupKeys(group: VoucherWorkGroupId): readonly VoucherWorkKey[] {
  return VOUCHER_WORK_GROUPS.find((g) => g.id === group)!.keys;
}

export function voucherWorkGroupOf(key: VoucherWorkKey): VoucherWorkGroupId {
  return VOUCHER_WORK_GROUPS.find((g) => (g.keys as readonly string[]).includes(key))!.id;
}

/**
 * A setting's control: a row of choices (every string setting, on / off included), a switch for the
 * boolean ones (`voucherShowUnavailable` shown / hidden; `voucherGuide`, `voucherAutoPickSingle` on / off),
 * the seconds 1–10 (numbers) or the station's title (text).
 * Each has "ירושה" beside it; the title's is leaving it empty.
 */
export type VoucherWorkControl =
  | { kind: 'choice'; values: readonly string[] }
  | { kind: 'switch' }
  | { kind: 'seconds'; values: readonly number[] }
  | { kind: 'text'; max: number };

const CHOICE_VALUES: Partial<Record<VoucherWorkKey, readonly string[]>> = {
  voucherRedeemFlow: VOUCHER_REDEEM_FLOWS,
  voucherPickFilter: VOUCHER_PICK_FILTER_VALUES,
  voucherAutoApply: VOUCHER_AUTO_APPLY_VALUES,
  voucherShowEntitlement: VOUCHER_SHOW_ENTITLEMENT_VALUES,
  voucherBalanceCheck: VOUCHER_BALANCE_CHECK_MODES,
  voucherAutoClose: VOUCHER_AUTO_CLOSE_VALUES,
  voucherSuccessScreen: VOUCHER_SUCCESS_SCREEN_VALUES,
  voucherSuccessDismiss: VOUCHER_SUCCESS_DISMISS_VALUES,
  voucherStation: VOUCHER_STATION_VALUES,
  voucherStationPaidItems: VOUCHER_STATION_PAID_ITEMS_VALUES,
  voucherSoundApprove: VOUCHER_SOUND_VALUES,
  voucherSoundReject: VOUCHER_SOUND_VALUES,
};

/** The settings that are JSON booleans (a switch with "ירושה"). */
const SWITCH_KEYS: readonly VoucherWorkKey[] = ['voucherShowUnavailable', 'voucherGuide', 'voucherAutoPickSingle'];

export function voucherWorkControl(key: VoucherWorkKey): VoucherWorkControl {
  if (SWITCH_KEYS.includes(key)) return { kind: 'switch' };
  if (key === 'voucherSuccessSeconds') return { kind: 'seconds', values: VOUCHER_SUCCESS_SECONDS_VALUES };
  if (key === 'voucherStationTitle') return { kind: 'text', max: VOUCHER_STATION_TITLE_MAX };
  if (isVoucherFastChoiceKey(key)) return { kind: 'choice', values: voucherFastChoiceValues(key) };
  return { kind: 'choice', values: CHOICE_VALUES[key]! };
}

/** Whether [v] is a value a layer keeps for [key] — its own setting; anything else reads as "inherits". */
export function isVoucherWorkValue(key: VoucherWorkKey, v: unknown): boolean {
  if (isVoucherFastChoiceKey(key)) return isVoucherFastChoiceValue(key, v);
  const control = voucherWorkControl(key);
  if (control.kind === 'switch') return typeof v === 'boolean';
  if (control.kind === 'seconds') return isVoucherSuccessSeconds(v);
  // A title as typed is this level's even while too long: the form says so, and the server refuses it.
  if (control.kind === 'text') return typeof v === 'string';
  return typeof v === 'string' && control.values.includes(v);
}

/** The value in force at a level: [own], else [inherited], else the default — as the till would get it. */
export function resolveVoucherWorkValue(key: VoucherWorkKey, own: unknown, inherited: unknown): string | number | boolean {
  if (isVoucherFastChoiceKey(key)) return resolveVoucherFastChoice(key, own, inherited);
  switch (key) {
    case 'voucherRedeemFlow':
      return resolveVoucherRedeemFlow(own, inherited);
    case 'voucherShowUnavailable':
      return resolveVoucherShowUnavailable(own, inherited);
    case 'voucherGuide':
      return resolveVoucherGuide(own, inherited);
    case 'voucherPickFilter':
      return resolveVoucherPickFilter(own, inherited);
    case 'voucherAutoPickSingle':
      return resolveVoucherAutoPickSingle(own, inherited);
    case 'voucherAutoApply':
      return resolveVoucherAutoApply(own, inherited);
    case 'voucherShowEntitlement':
      return resolveVoucherShowEntitlement(own, inherited);
    case 'voucherBalanceCheck':
      return resolveVoucherBalanceCheck(own, inherited);
    case 'voucherAutoClose':
      return resolveVoucherAutoClose(own, inherited);
    case 'voucherSuccessScreen':
      return resolveVoucherSuccessScreen(own, inherited);
    case 'voucherSuccessSeconds':
      return resolveVoucherSuccessSeconds(own, inherited);
    case 'voucherSuccessDismiss':
      return resolveVoucherSuccessDismiss(own, inherited);
    case 'voucherStation':
      return resolveVoucherStation(own, inherited);
    case 'voucherStationPaidItems':
      return resolveVoucherStationPaidItems(own, inherited);
    case 'voucherStationTitle':
      return resolveVoucherStationTitle(own, inherited);
    case 'voucherSoundApprove':
    case 'voucherSoundReject':
      return resolveVoucherSound(own, inherited);
  }
  throw new Error(`unknown voucher work setting: ${String(key)}`);
}

export type VoucherWorkValues = Record<VoucherWorkKey, string | number | boolean>;

/** Every setting in force at a level: its own value (drafted), else what it inherits, else the default. */
export function voucherWorkEffective(own: VoucherWorkLayer, inherited: VoucherWorkLayer): VoucherWorkValues {
  const out = {} as VoucherWorkValues;
  for (const key of VOUCHER_WORK_KEYS) {
    const mine = read(own, key);
    out[key] = resolveVoucherWorkValue(key, isVoucherWorkValue(key, mine) ? mine : undefined, read(inherited, key));
  }
  return out;
}

/** The settings this level sets itself, in the page's order (of [keys], every one by default). */
export function voucherWorkOwnKeys(own: VoucherWorkLayer, keys: readonly VoucherWorkKey[] = VOUCHER_WORK_KEYS): VoucherWorkKey[] {
  return keys.filter((key) => isVoucherWorkValue(key, read(own, key)));
}

/** The rows a group shows: all of them, or with "הצג רק מה שהוגדר ברמה הזו" only this level's own. */
export function voucherWorkVisibleKeys(group: VoucherWorkGroupId, own: VoucherWorkLayer, onlyOwn: boolean): VoucherWorkKey[] {
  const keys = voucherWorkGroupKeys(group);
  return onlyOwn ? voucherWorkOwnKeys(own, keys) : [...keys];
}

/**
 * Why a setting does nothing at this level right now (it is shown dimmed, still editable), or null:
 * the station's settings while the voucher station is off; "סגירה לבד במצב מהיר" while the fast mode is
 * off; which camera while the station's camera is off; the title while the header shows no text; how
 * the success screen closes, and its seconds, while it is off; the seconds while the cashier closes it
 * with "אישור" (`voucherSuccessDismiss` "confirm"); the boost while both sounds are off.
 */
export type VoucherWorkDependency =
  | 'stationOff'
  | 'fastModeOff'
  | 'cameraOff'
  | 'headerNoText'
  | 'successScreenOff'
  | 'dismissConfirm'
  | 'soundsOff';

export function voucherWorkDependency(key: VoucherWorkKey, effective: VoucherWorkValues): VoucherWorkDependency | null {
  if (voucherWorkGroupOf(key) === 'station' && key !== 'voucherStation' && effective.voucherStation !== 'on') {
    return 'stationOff';
  }
  if (key === 'voucherFastAutoClose' && effective.voucherFastMode === 'off') return 'fastModeOff';
  if (key === 'voucherStationCameraFacing' && effective.voucherStationCamera === 'off') return 'cameraOff';
  if (key === 'voucherStationTitle' && effective.voucherStationHeader !== 'text' && effective.voucherStationHeader !== 'both') {
    return 'headerNoText';
  }
  if ((key === 'voucherSuccessSeconds' || key === 'voucherSuccessDismiss') && effective.voucherSuccessScreen === 'off') {
    return 'successScreenOff';
  }
  if (key === 'voucherSuccessSeconds' && effective.voucherSuccessDismiss === 'confirm') return 'dismissConfirm';
  if (key === 'voucherSoundBoost' && effective.voucherSoundApprove === 'off' && effective.voucherSoundReject === 'off') {
    return 'soundsOff';
  }
  return null;
}

/**
 * One phrase of a summary line or a group header's badge, as an i18n key: `summary.<key>.<value>`, and for
 * the seconds `summary.seconds` with `{n}`. `sounds` joins the approve and reject sounds: both / approve /
 * reject / none. A boolean setting's value reads as `on` / `off`.
 */
export interface VoucherWorkPhrase {
  key: VoucherWorkKey | 'sounds';
  value: string;
}

function soundsPhrase(effective: VoucherWorkValues): VoucherWorkPhrase {
  const approve = effective.voucherSoundApprove === 'on';
  const reject = effective.voucherSoundReject === 'on';
  return { key: 'sounds', value: approve && reject ? 'both' : approve ? 'approve' : reject ? 'reject' : 'none' };
}

const phrase = (effective: VoucherWorkValues, key: VoucherWorkKey): VoucherWorkPhrase => {
  const v = effective[key];
  return { key, value: typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v) };
};

/**
 * A group's line in the summary, in plain words: what is in force at this level. A phrase that changes
 * nothing is left out (the fast mode's close while it is off, how the success screen closes without
 * one, the station's details while it is off, which camera with none, the boost with no sound). The
 * success screen closing by itself reads as its seconds ("נסגר לבד אחרי 3 שניות"); on "אישור", as that.
 */
export function voucherWorkSummary(group: VoucherWorkGroupId, effective: VoucherWorkValues): VoucherWorkPhrase[] {
  const p = (key: VoucherWorkKey) => phrase(effective, key);
  switch (group) {
    case 'redeem':
      return [
        p('voucherRedeemFlow'),
        p('voucherGuide'),
        p('voucherPickFilter'),
        p('voucherAutoPickSingle'),
        p('voucherAutoApply'),
        p('voucherFastMode'),
        ...(effective.voucherFastMode === 'off' ? [] : [p('voucherFastAutoClose')]),
        p('voucherShowEntitlement'),
        p('voucherBalanceCheck'),
      ];
    case 'close':
      return [
        p('voucherAutoClose'),
        p('voucherSuccessScreen'),
        ...(effective.voucherSuccessScreen === 'off'
          ? []
          : [effective.voucherSuccessDismiss === 'confirm' ? p('voucherSuccessDismiss') : p('voucherSuccessSeconds')]),
      ];
    case 'station':
      if (effective.voucherStation !== 'on') return [p('voucherStation')];
      return [
        p('voucherStation'),
        p('voucherStationPaidItems'),
        p('voucherStationCamera'),
        ...(effective.voucherStationCamera === 'off' ? [] : [p('voucherStationCameraFacing')]),
        p('voucherStationCatalogSwitch'),
        p('voucherStationHeader'),
      ];
    case 'sound': {
      const sounds = soundsPhrase(effective);
      return [sounds, ...(sounds.value === 'none' ? [] : [p('voucherSoundBoost')]), p('voucherVibrate')];
    }
  }
}

/** The short badges on a group's header (closed or open): the one or two things that matter most. */
export function voucherWorkBadges(group: VoucherWorkGroupId, effective: VoucherWorkValues): VoucherWorkPhrase[] {
  const p = (key: VoucherWorkKey) => phrase(effective, key);
  switch (group) {
    case 'redeem':
      return [p('voucherFastMode'), p('voucherAutoApply')];
    case 'close':
      return [p('voucherAutoClose'), p('voucherSuccessScreen')];
    case 'station':
      return effective.voucherStation === 'on' ? [p('voucherStation'), p('voucherStationCamera')] : [p('voucherStation')];
    case 'sound':
      return [soundsPhrase(effective), p('voucherVibrate')];
  }
}

/**
 * "מומלץ לעמדת שובר" at this level as drafted (lib/voucherTillSettings.ts voucherStationNeedsAdvice): the
 * station on with "פריטים קודם", or with the voucher neither scanned nor typed (`payVoucherEnabled` /
 * `payVoucherManualEnabled`: own, else inherited, else on).
 */
export function voucherWorkStationAdvice(own: VoucherWorkLayer, inherited: VoucherWorkLayer): boolean {
  const switchOn = (key: 'payVoucherEnabled' | 'payVoucherManualEnabled') => {
    const mine = read(own, key);
    if (typeof mine === 'boolean') return mine;
    const inh = read(inherited, key);
    return typeof inh === 'boolean' ? inh : VOUCHER_SWITCH_DEFAULT;
  };
  const effective = voucherWorkEffective(own, inherited);
  return voucherStationNeedsAdvice(
    effective.voucherStation === 'on' ? 'on' : 'off',
    isVoucherRedeemFlow(effective.voucherRedeemFlow) ? effective.voucherRedeemFlow : 'items_first',
    switchOn('payVoucherEnabled'),
    switchOn('payVoucherManualEnabled'),
  );
}

// ── Open / closed groups, remembered per viewer (localStorage, read and written by the component) ──

export const VOUCHER_WORK_OPEN_STORAGE_KEY = 'r2m.voucherWorkSettings.open.v1';

export type VoucherWorkOpen = Record<VoucherWorkGroupId, boolean>;

/** The first group open, the rest closed. */
export const VOUCHER_WORK_OPEN_DEFAULT: Readonly<VoucherWorkOpen> = { redeem: true, close: false, station: false, sound: false };

/** What was remembered, over the default: only a known group's true / false counts; anything else is ignored. */
export function parseVoucherWorkOpen(raw: string | null | undefined): VoucherWorkOpen {
  const out: VoucherWorkOpen = { ...VOUCHER_WORK_OPEN_DEFAULT };
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const id of VOUCHER_WORK_GROUP_IDS) {
    const v = (parsed as Record<string, unknown>)[id];
    if (typeof v === 'boolean') out[id] = v;
  }
  return out;
}

export function toggleVoucherWorkOpen(open: VoucherWorkOpen, group: VoucherWorkGroupId): VoucherWorkOpen {
  return { ...open, [group]: !open[group] };
}
