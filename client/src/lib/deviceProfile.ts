/**
 * "סוג מכשיר" — a device's role (קופה / קיוסק) and model, chosen when it is added
 * (pos-server docs/SPEC_DEVICE_ROLE_MODEL.md).
 *
 * Self-contained on purpose (no `@/` imports): `npm test` compiles it on its own.
 *
 * The capability table mirrors the server's (`app/models/pos_machine.py`
 * `device_capabilities`); the machine page reads the server's own flags from the machine,
 * this table only describes a model before there is a machine (the add dialog). The two
 * tests (here and tests/test_device_profile.py) pin the same table.
 */

export const DEVICE_ROLES = ['till', 'kiosk'] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];

/** SUNMI (pos-server docs/SPEC_SUNMI.md, app/models/sunmi.py): handhelds, PDAs, desktops, the K2 kiosk. */
export const SUNMI_MODEL_IDS = [
  'SUNMI_V1',
  'SUNMI_V2',
  'SUNMI_V2_PRO',
  'SUNMI_V2S',
  'SUNMI_V2S_PLUS',
  'SUNMI_V3',
  'SUNMI_P1',
  'SUNMI_P2',
  'SUNMI_P3',
  'SUNMI_L2',
  'SUNMI_M2',
  'SUNMI_T1',
  'SUNMI_T2',
  'SUNMI_T2_MINI',
  'SUNMI_T2S',
  'SUNMI_T3',
  'SUNMI_D2_MINI',
  'SUNMI_D2S',
  'SUNMI_D2S_PLUS',
  'SUNMI_D3',
  'SUNMI_D3_MINI',
  'SUNMI_K2',
  'SUNMI',
] as const;

/**
 * SynqPay terminals the till runs on (pos-server docs/SPEC_SYNQPAY.md §1.5,
 * app/models/synqpay_devices.py): a terminal of their own, like the F20; their printer needs
 * SynqPay's SDK (PAL) — "בקרוב".
 */
export const SYNQPAY_DEVICE_MODEL_IDS = [
  'SYNQPAY_DX8000',
  'SYNQPAY_DX6000',
  'SYNQPAY_EX8000',
  'SYNQPAY_RX5000',
  'SYNQPAY_S1P2',
  'SYNQPAY_S1U2_M4',
  'SYNQPAY_VERIFONE',
  'SYNQPAY',
] as const;

export const DEVICE_MODEL_IDS = [
  'N55F',
  'MODO',
  'P18',
  'LANDI',
  'FEITIAN_TABLET',
  'GENERIC_ANDROID',
  ...SUNMI_MODEL_IDS,
  ...SYNQPAY_DEVICE_MODEL_IDS,
] as const;
export type DeviceModelId = (typeof DEVICE_MODEL_IDS)[number];

export interface DeviceCapabilities {
  /** Prints on a head of its own. */
  builtinPrinter: boolean;
  /** Charges cards on a terminal of its own (Agamento on the device). */
  builtinTerminal: boolean;
  /** Opens a cash drawer on a port of its own (the SUNMI desktops; elsewhere through a receipt printer). */
  cashDrawerPort: boolean;
  /** The hardware has a printer / drawer the till has no driver for yet: "בקרוב". */
  driverPending: boolean;
  /** The paper its own head takes (58 / 80 mm); null without a head, or a SUNMI the table does not know. */
  paperWidthMm: 58 | 80 | null;
  /** A scan head of its own (not the camera). */
  builtinScanner: boolean;
}

const caps = (builtinPrinter: boolean, builtinTerminal: boolean, driverPending = false): DeviceCapabilities => ({
  builtinPrinter,
  builtinTerminal,
  cashDrawerPort: false,
  driverPending,
  paperWidthMm: builtinPrinter ? 58 : null,
  builtinScanner: false,
});

/** A SUNMI: never a terminal of its own (its P-series EMV reader is not driven), never "בקרוב". */
const sunmi = (paperWidthMm: 58 | 80 | null, cashDrawerPort: boolean, builtinScanner: boolean): DeviceCapabilities => ({
  builtinPrinter: paperWidthMm !== null,
  builtinTerminal: false,
  cashDrawerPort,
  driverPending: false,
  paperWidthMm,
  builtinScanner,
});

export const DEVICE_MODEL_CAPABILITIES: Record<DeviceModelId, DeviceCapabilities> = {
  N55F: caps(true, true),
  MODO: caps(false, true),
  P18: caps(false, false),
  LANDI: caps(false, false, true),
  FEITIAN_TABLET: caps(false, false, true),
  GENERIC_ANDROID: caps(false, false),
  SUNMI_V1: sunmi(58, false, false),
  SUNMI_V2: sunmi(58, false, false),
  SUNMI_V2_PRO: sunmi(58, false, true),
  SUNMI_V2S: sunmi(58, false, false),
  SUNMI_V2S_PLUS: sunmi(80, false, true),
  SUNMI_V3: sunmi(58, false, true),
  SUNMI_P1: sunmi(58, false, false),
  SUNMI_P2: sunmi(58, false, false),
  SUNMI_P3: sunmi(58, false, false),
  SUNMI_L2: sunmi(null, false, true),
  SUNMI_M2: sunmi(null, false, false),
  SUNMI_T1: sunmi(80, true, false),
  SUNMI_T2: sunmi(80, true, false),
  SUNMI_T2_MINI: sunmi(80, true, false),
  SUNMI_T2S: sunmi(80, true, false),
  SUNMI_T3: sunmi(80, true, false),
  SUNMI_D2_MINI: sunmi(58, true, false),
  SUNMI_D2S: sunmi(58, true, false),
  SUNMI_D2S_PLUS: sunmi(80, true, false),
  SUNMI_D3: sunmi(80, true, false),
  SUNMI_D3_MINI: sunmi(58, true, false),
  SUNMI_K2: sunmi(80, false, true),
  // Not in the table: prints if its print service answers, at the width it reports.
  SUNMI: { ...sunmi(null, false, false), builtinPrinter: true },
  // SynqPay: the terminal is the device (Local Mode); no till receipts on its head yet (SDK).
  SYNQPAY_DX8000: caps(false, true, true),
  SYNQPAY_DX6000: caps(false, true, true),
  SYNQPAY_EX8000: caps(false, true, true),
  SYNQPAY_RX5000: caps(false, true, true),
  SYNQPAY_S1P2: caps(false, true, true),
  SYNQPAY_S1U2_M4: caps(false, true, true),
  SYNQPAY_VERIFONE: caps(false, true, true),
  SYNQPAY: caps(false, true, true),
};

/** A model this build knows, else null. */
export function deviceModelIdOf(value: unknown): DeviceModelId | null {
  const s = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return (DEVICE_MODEL_IDS as readonly string[]).includes(s) ? (s as DeviceModelId) : null;
}

/**
 * A model's flags; an unknown / unrecorded model reads as a 55F, as the server reads it.
 * "מכשירי הסליקה הם חיצוניים": a kiosk has no built-in terminal whatever the model — it
 * charges on an external pinpad on the network.
 */
export function capabilitiesOf(model: unknown, opts: { kiosk?: boolean } = {}): DeviceCapabilities {
  const id = deviceModelIdOf(model);
  const table = id ? DEVICE_MODEL_CAPABILITIES[id] : DEVICE_MODEL_CAPABILITIES.N55F;
  return opts.kiosk ? { ...table, builtinTerminal: false } : table;
}

/**
 * A kiosk with no pinpad address at any level: it cannot take a card (the machine page
 * warns). Not for a kiosk explicitly on Z-Credit, which needs no pinpad address.
 */
export function kioskPinpadMissing(m: {
  deviceRole?: unknown;
  pinpadAddressMissing?: boolean;
  paymentIntegration?: unknown;
}): boolean {
  return m.deviceRole === 'kiosk' && m.pinpadAddressMissing === true && m.paymentIntegration !== 'zcredit';
}

/**
 * The pinpad address as the server will take it (app/services/payment_terminal.py): an
 * IPv4 address or a host name, no scheme / port / path. '' is fine (set it later).
 */
export function pinpadHostError(host: string): 'invalid' | null {
  const text = host.trim();
  if (!text) return null;
  if (text.length > 253) return 'invalid';
  const labels = text.split('.');
  if (labels.every((l) => /^\d+$/.test(l))) {
    return labels.length === 4 && labels.every((l) => Number(l) <= 255 && String(Number(l)) === l) ? null : 'invalid';
  }
  return labels.every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l)) ? null : 'invalid';
}

/** The pinpad port: '' (SPICy's own 8080) or 1–65535. */
export function pinpadPortError(port: string): 'invalid' | null {
  const text = port.trim();
  if (!text) return null;
  const n = Number(text);
  return /^\d+$/.test(text) && n >= 1 && n <= 65535 ? null : 'invalid';
}

/** "till" | "kiosk", else null (absent on an older server; "kds" is not a role). */
export function deviceRoleOf(value: unknown): DeviceRole | null {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (DEVICE_ROLES as readonly string[]).includes(s) ? (s as DeviceRole) : null;
}

export type DeviceModelWarning =
  /** Pairing kept the model the device named, not the one chosen when it was added. */
  | { kind: 'pairingOverride'; chosen: DeviceModelId; stored: DeviceModelId }
  /** The device named itself another model than the one recorded now (chosen afterwards). */
  | { kind: 'deviceDisagrees'; reported: DeviceModelId; stored: DeviceModelId | null }
  | null;

/**
 * What the machine page warns about the model, if anything. Pairing lets the device's own
 * word win (a P18 is a P18 whatever the code said) — never silently: the choice is kept
 * (`deviceModelChosen`) and shown beside it.
 */
export function deviceModelWarning(m: {
  deviceModel?: unknown;
  deviceModelChosen?: unknown;
  deviceModelReported?: unknown;
}): DeviceModelWarning {
  const stored = deviceModelIdOf(m.deviceModel);
  const chosen = deviceModelIdOf(m.deviceModelChosen);
  const reported = deviceModelIdOf(m.deviceModelReported);
  if (reported && reported !== stored) return { kind: 'deviceDisagrees', reported, stored };
  if (chosen && stored && chosen !== stored) return { kind: 'pairingOverride', chosen, stored };
  return null;
}

export interface AddDeviceDraft {
  role: DeviceRole | '';
  model: DeviceModelId | '';
  machineCode: string;
  companyId: string;
  shopId: string;
}

/** The first thing the add dialog still needs before a code can be generated, or null. */
export function addDeviceMissing(d: AddDeviceDraft): 'role' | 'model' | 'machineCode' | 'shop' | null {
  if (!d.role) return 'role';
  if (!d.model) return 'model';
  if (!d.machineCode.trim()) return 'machineCode';
  // A kiosk opens in one shop: its code is pre-assigned (the server says so too).
  if (d.role === 'kiosk' && (!d.companyId || !d.shopId)) return 'shop';
  return null;
}

export interface KioskDraft {
  name: string;
  controllerMachineIds: string[];
  lockDevice: boolean;
  /** "מסופון חיצוני ברשת": the pinpad's address, '' = set elsewhere / later. */
  pinpadHost: string;
  /** '' = SPICy's own port (8080). */
  pinpadPort: string;
}

/** The kiosk part of a request body: its options, and the pinpad when an address is typed. */
function kioskBody(kiosk: KioskDraft): Record<string, unknown> {
  const host = kiosk.pinpadHost.trim();
  const port = kiosk.pinpadPort.trim();
  return {
    ...(kiosk.name.trim() ? { name: kiosk.name.trim() } : {}),
    controllerMachineIds: kiosk.controllerMachineIds,
    lockDevice: kiosk.lockDevice,
    ...(host ? { pinpadHost: host, ...(port ? { pinpadPort: Number(port) } : {}) } : {}),
  };
}

/** A typed pinpad address the server would refuse (checked before sending). */
export function kioskDraftError(kiosk: KioskDraft): 'pinpadHost' | 'pinpadPort' | null {
  if (pinpadHostError(kiosk.pinpadHost)) return 'pinpadHost';
  if (kiosk.pinpadHost.trim() && pinpadPortError(kiosk.pinpadPort)) return 'pinpadPort';
  return null;
}

/** `POST /pairing/generate`'s body for the draft (call once `addDeviceMissing` is null). */
export function pairingRequestBody(d: AddDeviceDraft, kiosk: KioskDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    deviceRole: d.role,
    deviceModel: d.model,
    ...(d.companyId ? { companyId: d.companyId } : {}),
    ...(d.shopId ? { shopId: d.shopId } : {}),
  };
  if (d.role === 'kiosk') body.kiosk = kioskBody(kiosk);
  return body;
}

/** `PUT /machines/{id}/device-profile`'s body: only what changed. Null when nothing did. */
export function deviceProfileBody(
  current: { role: DeviceRole; model: DeviceModelId | null },
  next: { role: DeviceRole; model: DeviceModelId | null },
  kiosk: KioskDraft,
): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  if (next.model && next.model !== current.model) body.deviceModel = next.model;
  if (next.role !== current.role) {
    body.deviceRole = next.role;
    if (next.role === 'kiosk') body.kiosk = kioskBody(kiosk);
  }
  return Object.keys(body).length ? body : null;
}

/**
 * The server's own Hebrew `message` of a refusal (`{"detail": code, "message": …}`), else
 * null — the caller then falls back to its generic error.
 */
export function deviceProfileErrorMessage(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const message = (data as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return null;
}

/** The refusal's code (`detail`), when it is one. */
export function deviceProfileErrorCode(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  const detail = data && typeof data === 'object' ? (data as { detail?: unknown }).detail : null;
  return typeof detail === 'string' ? detail : null;
}
