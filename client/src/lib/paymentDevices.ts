/**
 * "מכשירי תשלום" — several card terminals for a till or tablet WITHOUT built-in clearing (a
 * P18, not an F20). Each device of a shop has a nickname: a Z-Credit PinPad (its PinPad only —
 * the terminal number and password are the branch's Z-Credit settings), a SynqPay terminal, or a
 * Nayax handheld running Agamento on the LAN (HTTP, port 8080, /SPICy). The kiosk keeps its one
 * pinpad. Several devices may share one terminal number.
 *
 * A device belongs to its shop. How a till picks one is a setting (shop = the default for its
 * tills, area, till): "מכשיר קבוע" (`paymentDeviceMode` "fixed" + `fixedPaymentDeviceId`: every
 * card goes there) or "קבוצת מכשירים לבחירה" ("group" + `paymentDeviceGroup`: the cashier picks;
 * empty = every device of the shop). Unset everywhere = a group of every device.
 *
 * The server's rules are in pos-server app/services/payment_devices.py; the checks here mirror
 * them (same error codes, translated by the components from `paymentDevices.errors.<code>` in
 * messages/he.json) so a save is not refused. Pure: only relative imports, so `npm test`
 * compiles it.
 */

import {
  cleanPinpadId,
  cleanSynqpayConnection,
  cleanSynqpayModel,
  cleanSynqpayProtocol,
  cleanSynqpayUsbDevice,
  isTypedSecret,
  isValidPinpadHost,
  isValidSynqpayApiKey,
  isValidSynqpaySerial,
  spicyPathError,
  SYNQPAY_MODEL_LABELS,
  type SynqpayModel,
} from './paymentIntegration';

// ── Values ───────────────────────────────────────────────────────────────────

export type PaymentDeviceKind = 'zcredit_pinpad' | 'synqpay' | 'agamento_lan';
export const PAYMENT_DEVICE_KINDS: readonly PaymentDeviceKind[] = ['agamento_lan', 'zcredit_pinpad', 'synqpay'];

export const AGAMENTO_DEFAULT_PORT = 8080;
export const AGAMENTO_DEFAULT_PATH = '/SPICy';
export const NICKNAME_MAX = 40;
export const SORT_ORDER_MAX = 9999;

/** The settings keys (managed, on the shop / area / till layers). */
export const MULTI_KEY = 'multiPaymentDevices';
export const MODE_KEY = 'paymentDeviceMode';
export const FIXED_KEY = 'fixedPaymentDeviceId';
export const GROUP_KEY = 'paymentDeviceGroup';

export function cleanKind(value: unknown): PaymentDeviceKind | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase().replace(/-/g, '_');
  return (PAYMENT_DEVICE_KINDS as readonly string[]).includes(t) ? (t as PaymentDeviceKind) : null;
}

/** The only device secret: SynqPay's API key (a Z-Credit pinpad's password is the branch's). */
export type DeviceSecretKey = 'synqpayApiKey';

/** Which kinds take an optional terminal number of their own. */
export function kindHasTerminalNumber(kind: PaymentDeviceKind): boolean {
  return kind === 'agamento_lan' || kind === 'synqpay';
}

// ── Server shapes (GET /shops/{id}/payment-devices, GET /machines/{id}/payment-devices) ──

export interface DeviceSecretStatus {
  set: boolean;
  updatedAt?: string | null;
  /** `till_pairing` (a till paired) or `dashboard` (typed). */
  origin?: string | null;
  pairedAt?: string | null;
  pairedByMachineName?: string | null;
  terminalSerial?: string | null;
  rejectedAt?: string | null;
  rejectedByMachineName?: string | null;
}

export type PaymentDeviceConfig = Record<string, string | number | boolean | null | undefined>;

export interface PaymentDevice {
  id: string;
  shopId: string;
  nickname: string;
  kind: PaymentDeviceKind;
  active: boolean;
  sortOrder: number;
  config: PaymentDeviceConfig;
  createdAt?: string | null;
  updatedAt?: string | null;
  secrets: Partial<Record<DeviceSecretKey, DeviceSecretStatus>>;
}

export type PaymentDeviceMode = 'fixed' | 'group';

/** How a till picks a device now, from its merged layers (the server's `till_choice`). */
export interface TillChoice {
  enabled: boolean;
  mode: PaymentDeviceMode;
  /** The fixed device when it is one of the shop's. */
  fixedDeviceId: string | null;
  /** The group, filtered to the shop's devices; null = every device of the shop. */
  groupDeviceIds: string[] | null;
}

export interface PaymentDeviceMachine {
  id: string;
  name: string;
  posNumber?: string | null;
  /** A till with clearing of its own (an F20): the feature does not apply to it. */
  hasBuiltinTerminal: boolean;
  choice: TillChoice;
  /** The till's own layer sets the switch or its device choice (else it follows the shop). */
  ownChoice: boolean;
}

export interface ShopPaymentDevices {
  shopId: string;
  devices: PaymentDevice[];
  /** The shop's non-kiosk tills, each with how it picks a device now. */
  machines: PaymentDeviceMachine[];
  /** The shop's own switch; null = it inherits. */
  multiPaymentDevices: boolean | null;
  /** What the shop inherits from its company / tenant; null = nobody sets it (off). */
  multiPaymentDevicesInherited: boolean | null;
  multiPaymentDevicesInheritedSource: 'tenant' | 'company' | null;
  /** The shop's own choice — the default for its tills; null = not set. */
  paymentDeviceMode: PaymentDeviceMode | null;
  fixedPaymentDeviceId: string | null;
  paymentDeviceGroup: string[] | null;
  canEdit: boolean;
}

export interface MachinePaymentDevices {
  machineId: string;
  shopId: string | null;
  hasBuiltinTerminal: boolean;
  isKiosk: boolean;
  /** Its shop's devices (none for a kiosk). */
  devices: PaymentDevice[];
}

/** POST / PUT body. The secret: string = set, null = remove, absent = keep. */
export interface PaymentDeviceInput {
  nickname: string;
  kind: PaymentDeviceKind;
  config: PaymentDeviceConfig;
  active: boolean;
  sortOrder: number;
  synqpayApiKey?: string | null;
}

// ── The dialog's form ─────────────────────────────────────────────────────────

export interface PaymentDeviceForm {
  nickname: string;
  kind: PaymentDeviceKind;
  // agamento_lan (and SynqPay's host / port); the terminal number for both
  host: string;
  port: string;
  path: string;
  https: boolean;
  mac: string;
  terminalNumber: string;
  // zcredit_pinpad
  pinpadId: string;
  // synqpay
  model: string;
  connection: '' | 'lan' | 'usb';
  protocol: 'tcp' | 'http';
  tls: boolean;
  usbDevice: string;
  serialNumber: string;
  active: boolean;
  sortOrder: string;
  /** Typed key ('' = untouched: keep what is stored). */
  synqpayApiKey: string;
  /** Remove the stored key on save. */
  removeSynqpayApiKey: boolean;
}

export function emptyDeviceForm(kind: PaymentDeviceKind = 'agamento_lan'): PaymentDeviceForm {
  return {
    nickname: '',
    kind,
    host: '',
    port: '',
    path: '',
    https: false,
    mac: '',
    terminalNumber: '',
    pinpadId: '',
    model: '',
    connection: '',
    protocol: 'tcp',
    tls: false,
    usbDevice: '',
    serialNumber: '',
    active: true,
    sortOrder: '0',
    synqpayApiKey: '',
    removeSynqpayApiKey: false,
  };
}

function str(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value : '';
}

/** The form for a stored device (the secret never comes back: it stays blank = keep). */
export function deviceForm(device: PaymentDevice): PaymentDeviceForm {
  const c = device.config ?? {};
  const kind = cleanKind(device.kind) ?? 'agamento_lan';
  const port = str(c.port);
  return {
    ...emptyDeviceForm(kind),
    nickname: device.nickname ?? '',
    host: str(c.host),
    // An Agamento port at its default shows empty (= the default) again.
    port: kind === 'agamento_lan' && port === String(AGAMENTO_DEFAULT_PORT) ? '' : port,
    path: kind === 'agamento_lan' && str(c.path) === AGAMENTO_DEFAULT_PATH ? '' : str(c.path),
    https: c.https === true,
    mac: str(c.mac),
    terminalNumber: kindHasTerminalNumber(kind) ? str(c.terminalNumber) : '',
    pinpadId: str(c.pinpadId),
    model: str(c.model),
    connection: c.connection === 'lan' || c.connection === 'usb' ? c.connection : '',
    protocol: c.protocol === 'http' ? 'http' : 'tcp',
    tls: c.tls === true,
    usbDevice: str(c.usbDevice),
    serialNumber: str(c.serialNumber),
    active: device.active !== false,
    sortOrder: String(device.sortOrder ?? 0),
  };
}

// ── Values the server normalises ──────────────────────────────────────────────

/**
 * "http://192.168.1.20:8080/SPICy" typed into the host field, split as the server does. Parts
 * not in the text are undefined; a scheme other than http(s) is null (refused).
 */
export function splitAddress(
  text: string,
): { host: string; port?: string; path?: string; https?: boolean } | null {
  let rest = text.trim();
  let https: boolean | undefined;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(rest);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
    https = scheme === 'https';
    rest = m[2];
  }
  let path: string | undefined;
  const slash = rest.indexOf('/');
  if (slash >= 0) {
    const tail = rest.slice(slash + 1);
    rest = rest.slice(0, slash);
    path = tail ? `/${tail}` : undefined;
  }
  let port: string | undefined;
  const colon = rest.lastIndexOf(':');
  if (colon >= 0) {
    port = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { host: rest, port, path, https };
}

/** A MAC in any common spelling as "aa:bb:cc:dd:ee:ff"; null when it is not one. */
export function normalizeMac(value: string): string | null {
  const hex = value.trim().toLowerCase().replace(/[:\-.\s]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return hex.match(/../g)!.join(':');
}

export function isValidTerminalNumber(value: string): boolean {
  return /^[0-9]{1,20}$/.test(value.trim());
}

/** A port typed as digits, 1–65535. */
export function cleanPort(value: string): number | null {
  const t = value.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 65535 ? n : null;
}

/** A secret the server stores: up to 200 characters, no control characters. */
function secretOk(value: string): boolean {
  return value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value.trim());
}

// ── Validation ───────────────────────────────────────────────────────────────

/** The server's codes (app/services/payment_devices.py), the same strings. */
export type DeviceErrorCode =
  | 'nickname_required'
  | 'nickname_too_long'
  | 'nickname_invalid'
  | 'nickname_taken'
  | 'kind_required'
  | 'kind_invalid'
  | 'host_required'
  | 'host_invalid'
  | 'port_invalid'
  | 'path_invalid'
  | 'mac_invalid'
  | 'terminal_number_invalid'
  | 'pinpad_required'
  | 'pinpad_invalid'
  | 'model_required'
  | 'model_invalid'
  | 'connection_required'
  | 'connection_invalid'
  | 'protocol_invalid'
  | 'usb_device_invalid'
  | 'serial_invalid'
  | 'sort_order_invalid'
  | 'secret_invalid'
  | 'synqpay_key_invalid';

export type DeviceFormField =
  | 'nickname'
  | 'kind'
  | 'host'
  | 'port'
  | 'path'
  | 'mac'
  | 'terminalNumber'
  | 'pinpadId'
  | 'model'
  | 'connection'
  | 'protocol'
  | 'usbDevice'
  | 'serialNumber'
  | 'sortOrder'
  | 'synqpayApiKey';

export type DeviceFormErrors = Partial<Record<DeviceFormField, DeviceErrorCode>>;

export interface ValidateContext {
  /** The other devices' nicknames in the shop (not the one edited). */
  otherNicknames?: readonly string[];
}

/** Field → error code for the dialog; empty = valid. Mirrors the server's checks. */
export function validateDeviceForm(form: PaymentDeviceForm, ctx: ValidateContext = {}): DeviceFormErrors {
  const errors: DeviceFormErrors = {};
  const nickname = form.nickname.split(/\s+/).filter(Boolean).join(' ');
  if (!nickname) errors.nickname = 'nickname_required';
  else if (nickname.length > NICKNAME_MAX) errors.nickname = 'nickname_too_long';
  else if ((ctx.otherNicknames ?? []).some((n) => n.trim().toLowerCase() === nickname.toLowerCase())) {
    errors.nickname = 'nickname_taken';
  }
  const kind = cleanKind(form.kind);
  if (!kind) {
    errors.kind = 'kind_required';
    return errors;
  }

  // Optional, and never unique: several devices may share one terminal number.
  const terminal = form.terminalNumber.trim();
  if (kindHasTerminalNumber(kind) && terminal && !isValidTerminalNumber(terminal)) {
    errors.terminalNumber = 'terminal_number_invalid';
  }

  if (kind === 'agamento_lan') {
    const typed = form.host.trim();
    const split = typed ? splitAddress(typed) : null;
    if (!typed) errors.host = 'host_required';
    else if (split === null) errors.host = 'host_invalid';
    else if (!split.host) errors.host = 'host_required';
    else if (!isValidPinpadHost(split.host)) errors.host = 'host_invalid';
    const port = form.port.trim() || split?.port || '';
    if (port && cleanPort(port) === null) errors.port = 'port_invalid';
    const path = form.path.trim() || split?.path || '';
    if (path && spicyPathError(path) !== null) errors.path = 'path_invalid';
    if (form.mac.trim() && normalizeMac(form.mac) === null) errors.mac = 'mac_invalid';
  } else if (kind === 'zcredit_pinpad') {
    if (!form.pinpadId.trim()) errors.pinpadId = 'pinpad_required';
    else if (cleanPinpadId(form.pinpadId) === null) errors.pinpadId = 'pinpad_invalid';
  } else {
    if (!form.model.trim()) errors.model = 'model_required';
    else if (cleanSynqpayModel(form.model) === null) errors.model = 'model_invalid';
    const connection = form.connection ? cleanSynqpayConnection(form.connection) : null;
    if (!form.connection) errors.connection = 'connection_required';
    else if (connection === null) errors.connection = 'connection_invalid';
    if (connection === 'lan') {
      if (!form.host.trim()) errors.host = 'host_required';
      else if (!isValidPinpadHost(form.host)) errors.host = 'host_invalid';
    }
    if (cleanSynqpayProtocol(form.protocol) === null) errors.protocol = 'protocol_invalid';
    if (form.port.trim() && cleanPort(form.port) === null) errors.port = 'port_invalid';
    if (form.usbDevice.trim() && cleanSynqpayUsbDevice(form.usbDevice) === null) errors.usbDevice = 'usb_device_invalid';
    if (form.serialNumber.trim() && !isValidSynqpaySerial(form.serialNumber)) errors.serialNumber = 'serial_invalid';
    if (isTypedSecret(form.synqpayApiKey)) {
      if (!secretOk(form.synqpayApiKey)) errors.synqpayApiKey = 'secret_invalid';
      else if (!isValidSynqpayApiKey(form.synqpayApiKey)) errors.synqpayApiKey = 'synqpay_key_invalid';
    }
  }

  const order = form.sortOrder.trim();
  if (order !== '' && !(/^\d{1,4}$/.test(order) && Number(order) <= SORT_ORDER_MAX)) errors.sortOrder = 'sort_order_invalid';
  return errors;
}

export function hasDeviceErrors(errors: DeviceFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The POST / PUT body from a valid form: the kind's config only (an address typed as a URL
 * split; a pinpad's PinPad alone), and the key only to change — a typed one, or `null` when
 * "remove" was chosen; nothing for "keep".
 */
export function deviceInput(form: PaymentDeviceForm): PaymentDeviceInput {
  const kind = cleanKind(form.kind) ?? 'agamento_lan';
  const config: PaymentDeviceConfig = {};
  const terminal = form.terminalNumber.trim();
  if (kind === 'agamento_lan') {
    const split = splitAddress(form.host) ?? { host: form.host.trim() };
    config.host = split.host.trim();
    const port = cleanPort(form.port.trim() || split.port || '');
    config.port = port ?? AGAMENTO_DEFAULT_PORT;
    config.path = form.path.trim() || split.path || AGAMENTO_DEFAULT_PATH;
    config.https = form.https || split.https === true;
    const mac = normalizeMac(form.mac);
    if (mac) config.mac = mac;
    if (terminal) config.terminalNumber = terminal;
  } else if (kind === 'zcredit_pinpad') {
    config.pinpadId = cleanPinpadId(form.pinpadId) ?? form.pinpadId.trim();
  } else {
    config.model = (cleanSynqpayModel(form.model) ?? form.model.trim()) as SynqpayModel;
    const connection = cleanSynqpayConnection(form.connection) ?? 'lan';
    config.connection = connection;
    if (connection === 'lan') config.host = form.host.trim();
    config.protocol = cleanSynqpayProtocol(form.protocol) ?? 'tcp';
    const port = cleanPort(form.port);
    if (port !== null) config.port = port;
    config.tls = form.tls;
    const usb = form.usbDevice.trim() ? cleanSynqpayUsbDevice(form.usbDevice) : null;
    if (usb) config.usbDevice = usb;
    if (form.serialNumber.trim()) config.serialNumber = form.serialNumber.trim();
    if (terminal) config.terminalNumber = terminal;
  }
  const order = Number(form.sortOrder.trim() || '0');
  const out: PaymentDeviceInput = {
    nickname: form.nickname.split(/\s+/).filter(Boolean).join(' '),
    kind,
    config,
    active: form.active,
    sortOrder: Number.isInteger(order) ? order : 0,
  };
  if (kind === 'synqpay') {
    if (isTypedSecret(form.synqpayApiKey)) out.synqpayApiKey = form.synqpayApiKey.trim();
    else if (form.removeSynqpayApiKey) out.synqpayApiKey = null;
  }
  return out;
}

// ── Lists and labels ──────────────────────────────────────────────────────────

/** As the till orders them: sort order, then nickname. */
export function sortDevices<T extends Pick<PaymentDevice, 'sortOrder' | 'nickname' | 'id'>>(devices: readonly T[]): T[] {
  return [...devices].sort((a, b) => {
    const order = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (order !== 0) return order;
    const na = (a.nickname ?? '').toLowerCase();
    const nb = (b.nickname ?? '').toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * A short, language-neutral description of where the device is: "192.168.1.20:8080",
 * "PinPad 123456", "Ingenico DX8000 · 192.168.1.40:9000", "Ingenico DX8000 · USB"; a terminal
 * number of its own after " · #".
 */
export function connectionSummary(device: Pick<PaymentDevice, 'kind' | 'config'>): string {
  const c = device.config ?? {};
  const terminal = kindHasTerminalNumber(device.kind) && str(c.terminalNumber) ? ` · #${str(c.terminalNumber)}` : '';
  if (device.kind === 'agamento_lan') {
    const port = str(c.port) || String(AGAMENTO_DEFAULT_PORT);
    const path = str(c.path);
    const scheme = c.https === true ? 'https://' : '';
    return `${scheme}${str(c.host)}:${port}${path && path !== AGAMENTO_DEFAULT_PATH ? path : ''}${terminal}`;
  }
  if (device.kind === 'zcredit_pinpad') return `PinPad ${str(c.pinpadId)}`;
  const model = cleanSynqpayModel(c.model);
  const name = model ? SYNQPAY_MODEL_LABELS[model] : str(c.model) || 'SynqPay';
  if (c.connection === 'usb') return `${name} · USB${terminal}`;
  const port = str(c.port);
  return `${name} · ${str(c.host)}${port ? `:${port}` : ''}${terminal}`;
}

// ── The switch (`multiPaymentDevices`) ────────────────────────────────────────

/** A layer's own switch as the three-way control shows it. */
export type TriState = 'inherit' | 'on' | 'off';

export function triStateOf(value: unknown): TriState {
  return value === true ? 'on' : value === false ? 'off' : 'inherit';
}

/** What to write for a choice: `null` = remove this layer's value (inherit again). */
export function triStateValue(state: TriState): boolean | null {
  return state === 'on' ? true : state === 'off' ? false : null;
}

/** On at this layer as drafted: its own value, else what it inherits, else off. */
export function effectiveSwitch(own: unknown, inherited: unknown): boolean {
  if (typeof own === 'boolean') return own;
  return inherited === true;
}

// ── How a till picks its device (mode / fixed / group) ────────────────────────

/** The "אופן בחירת המכשיר" control: as the level above, a fixed device, or a group. */
export type ModeChoice = 'inherit' | PaymentDeviceMode;

export function cleanMode(value: unknown): PaymentDeviceMode | null {
  return value === 'fixed' || value === 'group' ? value : null;
}

export function modeChoiceOf(value: unknown): ModeChoice {
  return cleanMode(value) ?? 'inherit';
}

/** A stored / sent group as ids (lower case, once each); null when not a list (= not set). */
export function cleanGroup(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const id = v.trim().toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** One layer's own device choice, as edited. `null` = this layer does not set it. */
export interface DeviceChoiceDraft {
  mode: PaymentDeviceMode | null;
  fixedId: string | null;
  group: string[] | null;
}

export function choiceDraftOf(settings: { [key: string]: unknown } | null | undefined): DeviceChoiceDraft {
  const s = settings ?? {};
  return {
    mode: cleanMode(s[MODE_KEY]),
    fixedId: typeof s[FIXED_KEY] === 'string' && s[FIXED_KEY] ? (s[FIXED_KEY] as string) : null,
    group: cleanGroup(s[GROUP_KEY]),
  };
}

/**
 * The draft after picking a mode: "as the level above" clears the layer's whole choice; a fixed
 * device drops this layer's group, a group drops its fixed device (neither is read then).
 */
export function withModeChoice(draft: DeviceChoiceDraft, choice: ModeChoice): DeviceChoiceDraft {
  if (choice === 'inherit') return { mode: null, fixedId: null, group: null };
  if (choice === 'fixed') return { ...draft, mode: 'fixed', group: null };
  return { ...draft, mode: 'group', fixedId: null };
}

/**
 * A device ticked on / off in the group. The group starts from what is shown (this layer's own,
 * else the one inherited, else nothing = every device) and keeps the devices' order.
 */
export function toggleGroup(
  shown: readonly string[] | null,
  id: string,
  on: boolean,
  order: readonly string[],
): string[] {
  const set = new Set((shown ?? []).map((x) => x.toLowerCase()));
  if (on) set.add(id.toLowerCase());
  else set.delete(id.toLowerCase());
  return order.map((x) => x.toLowerCase()).filter((x) => set.has(x));
}

/** The settings PATCH keys of a draft (`null` = inherit again). */
export function choicePatch(draft: DeviceChoiceDraft): {
  paymentDeviceMode: PaymentDeviceMode | null;
  fixedPaymentDeviceId: string | null;
  paymentDeviceGroup: string[] | null;
} {
  return { paymentDeviceMode: draft.mode, fixedPaymentDeviceId: draft.fixedId, paymentDeviceGroup: draft.group };
}

export function sameChoice(a: DeviceChoiceDraft, b: DeviceChoiceDraft): boolean {
  const g = (x: string[] | null) => (x === null ? 'null' : x.join(','));
  return a.mode === b.mode && a.fixedId === b.fixedId && g(a.group) === g(b.group);
}

export type ChoiceErrorCode = 'fixed_payment_device_required' | 'payment_device_not_in_shop';

/**
 * What the server would refuse: a "fixed" mode with no device (own, or [inheritedFixedId] from
 * above), or an id that is not one of the shop's devices ([deviceIds]). Null = fine.
 */
export function choiceError(
  draft: DeviceChoiceDraft,
  inheritedFixedId: string | null | undefined,
  deviceIds: readonly string[],
): ChoiceErrorCode | null {
  const ids = new Set(deviceIds.map((x) => x.toLowerCase()));
  if (draft.fixedId && !ids.has(draft.fixedId.toLowerCase())) return 'payment_device_not_in_shop';
  if ((draft.group ?? []).some((g) => !ids.has(g.toLowerCase()))) return 'payment_device_not_in_shop';
  if (draft.mode === 'fixed' && !draft.fixedId && !inheritedFixedId) return 'fixed_payment_device_required';
  return null;
}

/** How a till's summary line reads (`TillChoice` with its hardware). */
export type TillSummaryState = 'builtin' | 'off' | 'fixed' | 'fixed_missing' | 'group_all' | 'group';

export interface TillSummary {
  state: TillSummaryState;
  /** The devices it uses, in the till's order (fixed: one; group: the group's). */
  devices: PaymentDevice[];
}

export function tillSummary(
  machine: Pick<PaymentDeviceMachine, 'hasBuiltinTerminal' | 'choice'>,
  devices: readonly PaymentDevice[],
): TillSummary {
  if (machine.hasBuiltinTerminal) return { state: 'builtin', devices: [] };
  const c = machine.choice;
  if (!c?.enabled) return { state: 'off', devices: [] };
  const byId = new Map(devices.map((d) => [d.id.toLowerCase(), d]));
  if (c.mode === 'fixed') {
    const d = c.fixedDeviceId ? byId.get(c.fixedDeviceId.toLowerCase()) : undefined;
    return d ? { state: 'fixed', devices: [d] } : { state: 'fixed_missing', devices: [] };
  }
  if (!c.groupDeviceIds || c.groupDeviceIds.length === 0) return { state: 'group_all', devices: sortDevices(devices) };
  const wanted = new Set(c.groupDeviceIds.map((x) => x.toLowerCase()));
  return { state: 'group', devices: sortDevices(devices.filter((d) => wanted.has(d.id.toLowerCase()))) };
}

// ── Server answers ───────────────────────────────────────────────────────────

export interface DeviceServerError {
  code: string;
  /** The form field the server named ("nickname", "host"…), when it maps to one. */
  field: DeviceFormField | null;
  /** The server's Hebrew. */
  msg: string | null;
}

const SERVER_FIELDS: Record<string, DeviceFormField> = {
  nickname: 'nickname',
  kind: 'kind',
  sortOrder: 'sortOrder',
  synqpayApiKey: 'synqpayApiKey',
  'config.host': 'host',
  'config.port': 'port',
  'config.path': 'path',
  'config.mac': 'mac',
  'config.terminalNumber': 'terminalNumber',
  'config.pinpadId': 'pinpadId',
  'config.model': 'model',
  'config.connection': 'connection',
  'config.protocol': 'protocol',
  'config.usbDevice': 'usbDevice',
  'config.serialNumber': 'serialNumber',
};

/** A refusal of this feature (`{detail: {code, msg, field?}}`), or null for any other error. */
export function deviceServerError(err: unknown): DeviceServerError | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const { code, msg, field } = detail as { code?: unknown; msg?: unknown; field?: unknown };
  if (typeof code !== 'string' || !code) return null;
  return {
    code,
    field: typeof field === 'string' && field in SERVER_FIELDS ? SERVER_FIELDS[field] : null,
    msg: typeof msg === 'string' && msg.trim() ? msg : null,
  };
}
