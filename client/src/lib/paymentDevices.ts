/**
 * "מכשירי תשלום" — several card terminals for a till or tablet WITHOUT built-in clearing (a
 * P18, not an F20). Each device of a shop has a nickname; at card payment the cashier sends the
 * transaction to one of them: a Z-Credit PinPad, a SynqPay terminal, or a Nayax handheld running
 * Agamento on the LAN (HTTP, port 8080, /SPICy). The kiosk keeps its one pinpad.
 *
 * The server's rules are in pos-server app/services/payment_devices.py; the checks here mirror
 * them (same error codes, translated by the component from `paymentDevices.errors.<code>` in
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
export const DEFAULT_KEY = 'defaultPaymentDeviceId';

export function cleanKind(value: unknown): PaymentDeviceKind | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase().replace(/-/g, '_');
  return (PAYMENT_DEVICE_KINDS as readonly string[]).includes(t) ? (t as PaymentDeviceKind) : null;
}

/** The secrets each kind uses (write-only; the server drops any other). */
export const KIND_SECRETS: Record<PaymentDeviceKind, readonly DeviceSecretKey[]> = {
  zcredit_pinpad: ['zcreditPassword'],
  synqpay: ['synqpayApiKey'],
  agamento_lan: [],
};

// ── Server shapes (GET /shops/{id}/payment-devices, GET /machines/{id}/payment-devices) ──

export type DeviceSecretKey = 'zcreditPassword' | 'synqpayApiKey';

export interface DeviceSecretStatus {
  set: boolean;
  updatedAt?: string | null;
  /** SynqPay's key: `till_pairing` (a till paired) or `dashboard` (typed). */
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
  /** The shop's tills that use it; empty = all of them. */
  machineIds: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
  secrets: Partial<Record<DeviceSecretKey, DeviceSecretStatus>>;
}

export interface PaymentDeviceMachine {
  id: string;
  name: string;
  posNumber?: string | null;
  /** A till with clearing of its own (an F20): the feature does not apply to it. */
  hasBuiltinTerminal: boolean;
}

export interface ShopPaymentDevices {
  shopId: string;
  devices: PaymentDevice[];
  machines: PaymentDeviceMachine[];
  /** The shop's own switch; null = it inherits. */
  multiPaymentDevices: boolean | null;
  /** What the shop inherits from its company / tenant; null = nobody sets it (off). */
  multiPaymentDevicesInherited: boolean | null;
  multiPaymentDevicesInheritedSource: 'tenant' | 'company' | null;
  defaultPaymentDeviceId: string | null;
  canEdit: boolean;
}

export interface MachinePaymentDevices {
  machineId: string;
  shopId: string | null;
  hasBuiltinTerminal: boolean;
  isKiosk: boolean;
  /** The devices of its shop that apply to it. */
  devices: PaymentDevice[];
}

/** POST / PUT body. A secret: string = set, null = remove, absent = keep. */
export interface PaymentDeviceInput {
  nickname: string;
  kind: PaymentDeviceKind;
  config: PaymentDeviceConfig;
  machineIds: string[];
  active: boolean;
  sortOrder: number;
  zcreditPassword?: string | null;
  synqpayApiKey?: string | null;
}

// ── The dialog's form ─────────────────────────────────────────────────────────

export interface PaymentDeviceForm {
  nickname: string;
  kind: PaymentDeviceKind;
  // agamento_lan (and SynqPay's host / port)
  host: string;
  port: string;
  path: string;
  https: boolean;
  mac: string;
  terminalNumber: string;
  // zcredit_pinpad
  pinpadId: string;
  mode: '' | 'test' | 'production';
  // synqpay
  model: string;
  connection: '' | 'lan' | 'usb';
  protocol: 'tcp' | 'http';
  tls: boolean;
  usbDevice: string;
  serialNumber: string;
  // where and how
  machineIds: string[];
  active: boolean;
  sortOrder: string;
  /** Typed secrets ('' = untouched: keep what is stored). */
  zcreditPassword: string;
  synqpayApiKey: string;
  /** Remove the stored secret on save. */
  removeZcreditPassword: boolean;
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
    mode: '',
    model: '',
    connection: '',
    protocol: 'tcp',
    tls: false,
    usbDevice: '',
    serialNumber: '',
    machineIds: [],
    active: true,
    sortOrder: '0',
    zcreditPassword: '',
    synqpayApiKey: '',
    removeZcreditPassword: false,
    removeSynqpayApiKey: false,
  };
}

function str(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value : '';
}

/** The form for a stored device (secrets never come back: they stay blank = keep). */
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
    terminalNumber: str(c.terminalNumber),
    pinpadId: str(c.pinpadId),
    mode: c.mode === 'test' || c.mode === 'production' ? c.mode : '',
    model: str(c.model),
    connection: c.connection === 'lan' || c.connection === 'usb' ? c.connection : '',
    protocol: c.protocol === 'http' ? 'http' : 'tcp',
    tls: c.tls === true,
    usbDevice: str(c.usbDevice),
    serialNumber: str(c.serialNumber),
    machineIds: [...(device.machineIds ?? [])],
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
  | 'mode_invalid'
  | 'model_required'
  | 'model_invalid'
  | 'connection_required'
  | 'connection_invalid'
  | 'protocol_invalid'
  | 'usb_device_invalid'
  | 'serial_invalid'
  | 'sort_order_invalid'
  | 'machine_not_in_shop'
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
  | 'mode'
  | 'model'
  | 'connection'
  | 'protocol'
  | 'usbDevice'
  | 'serialNumber'
  | 'sortOrder'
  | 'machineIds'
  | 'zcreditPassword'
  | 'synqpayApiKey';

export type DeviceFormErrors = Partial<Record<DeviceFormField, DeviceErrorCode>>;

export interface ValidateContext {
  /** The other devices' nicknames in the shop (not the one edited). */
  otherNicknames?: readonly string[];
  /** The shop's tills; a chosen id outside them is refused. */
  machineIds?: readonly string[];
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

  const terminal = form.terminalNumber.trim();
  if (terminal && !isValidTerminalNumber(terminal)) errors.terminalNumber = 'terminal_number_invalid';

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
    if (form.mode && form.mode !== 'test' && form.mode !== 'production') errors.mode = 'mode_invalid';
    if (isTypedSecret(form.zcreditPassword) && !secretOk(form.zcreditPassword)) errors.zcreditPassword = 'secret_invalid';
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
  if (ctx.machineIds && form.machineIds.some((id) => !ctx.machineIds!.includes(id))) {
    errors.machineIds = 'machine_not_in_shop';
  }
  return errors;
}

export function hasDeviceErrors(errors: DeviceFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The POST / PUT body from a valid form: the kind's config only (an address typed as a URL
 * split), the tills that still exist, and only the secrets to change — a typed one, or `null`
 * when "remove" was chosen; nothing for "keep".
 */
export function deviceInput(form: PaymentDeviceForm, opts: { machineIds?: readonly string[] } = {}): PaymentDeviceInput {
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
    if (terminal) config.terminalNumber = terminal;
    if (form.mode) config.mode = form.mode;
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
  const known = opts.machineIds;
  const machineIds = [...new Set(form.machineIds)].filter((id) => !known || known.includes(id));
  const order = Number(form.sortOrder.trim() || '0');
  const out: PaymentDeviceInput = {
    nickname: form.nickname.split(/\s+/).filter(Boolean).join(' '),
    kind,
    config,
    machineIds,
    active: form.active,
    sortOrder: Number.isInteger(order) ? order : 0,
  };
  if (kind === 'zcredit_pinpad') {
    if (isTypedSecret(form.zcreditPassword)) out.zcreditPassword = form.zcreditPassword.trim();
    else if (form.removeZcreditPassword) out.zcreditPassword = null;
  }
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

/** For every till of the shop (no list), or for the tills listed. */
export function appliesTo(device: Pick<PaymentDevice, 'machineIds'>, machineId: string): boolean {
  const ids = device.machineIds ?? [];
  return ids.length === 0 || ids.some((id) => id.toLowerCase() === machineId.toLowerCase());
}

/** The devices a till may default to (they apply to it), in the till's order. */
export function defaultDeviceChoices(devices: readonly PaymentDevice[], machineId?: string | null): PaymentDevice[] {
  return sortDevices(machineId ? devices.filter((d) => appliesTo(d, machineId)) : devices);
}

/**
 * A short, language-neutral description of where the device is: "192.168.1.20:8080",
 * "PinPad 123456 · 0882…", "Ingenico DX8000 · 192.168.1.40:9000", "Ingenico DX8000 · USB".
 */
export function connectionSummary(device: Pick<PaymentDevice, 'kind' | 'config'>): string {
  const c = device.config ?? {};
  if (device.kind === 'agamento_lan') {
    const port = str(c.port) || String(AGAMENTO_DEFAULT_PORT);
    const path = str(c.path);
    const scheme = c.https === true ? 'https://' : '';
    return `${scheme}${str(c.host)}:${port}${path && path !== AGAMENTO_DEFAULT_PATH ? path : ''}`;
  }
  if (device.kind === 'zcredit_pinpad') {
    const parts = [`PinPad ${str(c.pinpadId)}`];
    if (str(c.terminalNumber)) parts.push(str(c.terminalNumber));
    return parts.join(' · ');
  }
  const model = cleanSynqpayModel(c.model);
  const name = model ? SYNQPAY_MODEL_LABELS[model] : str(c.model) || 'SynqPay';
  if (c.connection === 'usb') return `${name} · USB`;
  const port = str(c.port);
  return `${name} · ${str(c.host)}${port ? `:${port}` : ''}`;
}

/**
 * The names of the tills a device is for, in the shop's order; null = every till of the shop
 * (no list). Ids no longer the shop's tills are skipped.
 */
export function deviceTillNames(
  device: Pick<PaymentDevice, 'machineIds'>,
  machines: readonly Pick<PaymentDeviceMachine, 'id' | 'name'>[],
): string[] | null {
  const ids = device.machineIds ?? [];
  if (ids.length === 0) return null;
  const wanted = new Set(ids.map((id) => id.toLowerCase()));
  return machines.filter((m) => wanted.has(m.id.toLowerCase())).map((m) => m.name);
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
  machineIds: 'machineIds',
  sortOrder: 'sortOrder',
  zcreditPassword: 'zcreditPassword',
  synqpayApiKey: 'synqpayApiKey',
  'config.host': 'host',
  'config.port': 'port',
  'config.path': 'path',
  'config.mac': 'mac',
  'config.terminalNumber': 'terminalNumber',
  'config.pinpadId': 'pinpadId',
  'config.mode': 'mode',
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
