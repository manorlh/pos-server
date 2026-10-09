/**
 * The till's screen ↔ engine contract, as a LOCAL TYPED MOCK of `till_web_protocol.json` v0
 * (P:/specs/web-till-spec-v2.md §3.3). The golden file is S0-1's (another agent, branch
 * feat/web-till-s0); until it lands in `kiosk-desktop/protocol/till_web_protocol.json` the
 * screens are written against these types, and test/tillProtocolMock.test.ts checks every op
 * and error named here against the golden file as soon as it is there (it skips until then).
 *
 *  - envelopes: call `{id, op, args, clientOpId}`, reply `{id, ok, value | error}`, event
 *    `{ev, seq, data}`;
 *  - the state comes from the engine (a full `state` on connect, then each change with a higher
 *    `seq`); the screen shows only what the engine said;
 *  - every op that changes something carries a `clientOpId`: sent twice (a reconnect) it is the
 *    same op, never applied twice;
 *  - `hw.*` go from the ENGINE to the host (print bytes, drawer, byte channels); the host answers
 *    with `hw.result`. The screen never asks for hardware itself (§3.1, §9.5).
 *
 * Money is in agorot (integers), as on the APK.
 */

export const TILL_PROTOCOL = 1;
/** Where these names come from until the golden file lands (S0-1). */
export const PROTOCOL_SOURCE = 'local-mock-v0';

/* ----------------------------------------------------------------- envelopes */

export interface EngineCall {
  id: number;
  op: TillOp;
  args?: unknown;
  clientOpId?: string;
}

export interface EngineError {
  code: TillErrorCode;
  /** Hebrew, shown as is. */
  message: string;
  details?: Record<string, unknown>;
}

export type EngineReply = { id: number; ok: true; value?: unknown } | { id: number; ok: false; error: EngineError };

export interface EngineEvent<D = unknown> {
  ev: TillEventName;
  seq: number;
  data: D;
}

export type TillEventName = 'state' | 'hw' | 'toast';

/* --------------------------------------------------------------------- ops */

export const TILL_OPS = [
  'session.hello',
  'session.login',
  'session.logout',
  'catalog.snapshot',
  'sell.add',
  'sell.setQty',
  'sell.remove',
  'sell.discount',
  'sell.clear',
  'sell.department',
  'sell.search',
  'checkout.start',
  'checkout.cash',
  'checkout.card',
  'checkout.cancel',
  'checkout.finish',
  'dialog.answer',
  'doc.history',
  'doc.reprint',
  'doc.refund',
  'shift.open',
  'shift.close',
  'report.x',
  'z.produce',
  'mode.switch',
  'host.idle',
  'hw.result',
] as const;

export type TillOp = (typeof TILL_OPS)[number];

/** Ops that change something: each needs a clientOpId (the engine refuses one without). */
export const MUTATING_OPS: ReadonlySet<TillOp> = new Set<TillOp>([
  'session.login',
  'session.logout',
  'sell.add',
  'sell.setQty',
  'sell.remove',
  'sell.discount',
  'sell.clear',
  'checkout.start',
  'checkout.cash',
  'checkout.card',
  'checkout.cancel',
  'checkout.finish',
  'dialog.answer',
  'doc.reprint',
  'doc.refund',
  'shift.open',
  'shift.close',
  'z.produce',
  'mode.switch',
]);

export interface OpArgs {
  'session.hello': { since?: number; protocol?: number };
  'session.login': { pin: string };
  'session.logout': Record<string, never>;
  'catalog.snapshot': Record<string, never>;
  'sell.add': { productId: string; qty?: number };
  'sell.setQty': { lineId: string; qty: number };
  'sell.remove': { lineId: string };
  'sell.discount': { lineId: string; pct: number };
  'sell.clear': Record<string, never>;
  'sell.department': { departmentId: string | null };
  'sell.search': { text: string };
  'checkout.start': Record<string, never>;
  'checkout.cash': { amountAgorot: number };
  'checkout.card': { amountAgorot?: number };
  'checkout.cancel': Record<string, never>;
  'checkout.finish': Record<string, never>;
  'dialog.answer': { dialogId: string; action: string; answers?: Record<string, string> };
  'doc.history': { limit?: number };
  'doc.reprint': { documentId: string };
  'doc.refund': { documentId: string };
  'shift.open': { openingCashAgorot: number };
  'shift.close': { countedCashAgorot: number };
  'report.x': Record<string, never>;
  'z.produce': Record<string, never>;
  'mode.switch': { to: DeviceRoleName };
  'host.idle': { idle: boolean; busy: boolean };
  'hw.result': HwResult;
}

/* ------------------------------------------------------------------- errors */

export const TILL_ERRORS = {
  // The spec's own (§3.3).
  not_engine_holder: 'המכשיר הזה אינו מחזיק את מנוע הקופה',
  till_in_use_elsewhere: 'הקופה פתוחה במכשיר אחר',
  protocol_mismatch: 'נדרש עדכון — המסך והמנוע בגרסאות שונות',
  engine_offline: 'מנוע הקופה לא זמין',
  manager_required: 'נדרש אישור מנהל',
  permission_denied: 'אין הרשאה לפעולה הזו',
  mode_switch_busy: 'אי אפשר לעבור באמצע הזמנה או תשלום',
  role_not_allowed: 'המעבר לא הותר למכשיר הזה',
  role_switch_open_shift: 'יש משמרת פתוחה — סגרו אותה לפני המעבר',
  // The skeleton's (named here until the golden file decides).
  invalid_args: 'בקשה לא תקינה',
  unknown_op: 'פעולה לא מוכרת',
  missing_client_op_id: 'פעולה בלי מזהה (clientOpId)',
  cart_empty: 'הסל ריק',
  shift_closed: 'יש לפתוח משמרת',
  shift_open: 'המשמרת כבר פתוחה',
  checkout_busy: 'יש תשלום פתוח',
  terminal_unavailable: 'אין מסופון זמין במכשיר הזה',
  card_in_flight: 'עסקת אשראי בתהליך — אי אפשר לבטל עכשיו',
  wrong_pin: 'קוד שגוי',
  not_implemented: 'עוד לא בשלד הזה',
  z_not_in_demo: 'Z לא מופק במצב הדגמה',
} as const;

export type TillErrorCode = keyof typeof TILL_ERRORS;

export function engineError(code: TillErrorCode, details?: Record<string, unknown>): EngineError {
  return details ? { code, message: TILL_ERRORS[code], details } : { code, message: TILL_ERRORS[code] };
}

/* -------------------------------------------------------------------- state */

export type DeviceRoleName = 'till' | 'kiosk' | 'kds' | 'board' | 'display';

export interface Cashier {
  id: string;
  name: string;
}

export interface SessionState {
  cashier: Cashier | null;
  locked: boolean;
  /** The effective permissions (the engine decides; the screen only hides what is not there). */
  permissions: string[];
  /** A demo engine: nothing it issues is a fiscal document. */
  demo: boolean;
}

export interface Department {
  id: string;
  name: string;
  color: string;
}

export interface Product {
  id: string;
  departmentId: string;
  name: string;
  priceAgorot: number;
  /** Short label for a tile without a picture. */
  short?: string;
}

export interface Catalog {
  version: number;
  departments: Department[];
  products: Product[];
}

export interface CartLine {
  lineId: string;
  productId: string;
  name: string;
  qty: number;
  unitAgorot: number;
  discountPct: number;
  totalAgorot: number;
}

export interface SellState {
  catalogVersion: number;
  departmentId: string | null;
  search: string;
  lines: CartLine[];
  itemCount: number;
  totalAgorot: number;
  /** The VAT inside the total. */
  vatAgorot: number;
}

export type CheckoutPhase = 'idle' | 'tender' | 'card_waiting' | 'done';

export interface CheckoutLeg {
  method: 'cash' | 'card';
  amountAgorot: number;
  status: 'approved' | 'pending';
}

export interface CheckoutState {
  phase: CheckoutPhase;
  totalAgorot: number;
  paidAgorot: number;
  dueAgorot: number;
  changeAgorot: number;
  legs: CheckoutLeg[];
  /** The engine's reference of the issued document (a demo one says so). */
  documentRef: string | null;
}

export interface ShiftState {
  open: boolean;
  number: number | null;
  openedAt: string | null;
  openingCashAgorot: number;
  salesCount: number;
  salesAgorot: number;
  cashAgorot: number;
  cardAgorot: number;
}

export interface ZState {
  lastNumber: number | null;
  canProduce: boolean;
  /** Why not (Hebrew), when it cannot. */
  reason: string | null;
}

export interface HealthState {
  cloud: 'online' | 'offline' | 'demo';
  printer: 'ok' | 'none' | 'error';
  terminal: 'ok' | 'none' | 'busy';
  outbox: number;
}

export interface DialogField {
  name: string;
  label: string;
  kind: 'pin' | 'text';
}

export interface EngineDialog {
  id: string;
  kind: 'manager_approval' | 'confirm';
  title: string;
  body: string;
  fields: DialogField[];
  actions: Array<{ id: string; label: string; primary?: boolean }>;
}

export interface ModeState {
  role: DeviceRoleName;
  current: DeviceRoleName;
  /** Empty: no switch button, no menu (owner's rule, §6.2). */
  rolesAllowed: DeviceRoleName[];
}

export interface TillState {
  protocol: number;
  session: SessionState;
  sell: SellState;
  checkout: CheckoutState;
  shift: ShiftState;
  z: ZState;
  health: HealthState;
  dialog: EngineDialog | null;
  mode: ModeState;
}

export interface XReport {
  shiftNumber: number | null;
  salesCount: number;
  salesAgorot: number;
  cashAgorot: number;
  cardAgorot: number;
  expectedCashAgorot: number;
  demo: boolean;
}

/** The engine's answer to `session.hello`: the protocol it speaks, and the state (full, or since). */
export interface HelloReply {
  protocol: number;
  seq: number;
  state: TillState;
}

/**
 * One engine as a transport sees it: the mock in this tree, the IPC door of the Windows shell
 * (main/roles/till.ts), and later the JVM over stdio, the cloud over WebSocket, the APK in-process.
 */
export interface EngineEndpoint {
  hello(since?: number): HelloReply | Promise<HelloReply>;
  call(call: EngineCall): Promise<EngineReply>;
  on(fn: (event: EngineEvent) => void): () => void;
}

/**
 * Whether the till is in the middle of something — the update and the role switch wait for it
 * (§6.3, §8.2): a cart, a payment, an engine dialog, a card in the terminal.
 */
export function tillBusy(s: TillState): boolean {
  return s.sell.lines.length > 0 || s.checkout.phase !== 'idle' || s.dialog !== null || s.health.terminal === 'busy';
}

/* -------------------------------------------------------- hw.* (engine → host) */

export type HwJobKind = 'receipt' | 'bon' | 'report' | 'test' | 'drawer';

export type HwRequest =
  | { type: 'hw.print'; requestId: string; jobId: string; target: string; bytesB64: string; kind: HwJobKind; ticket?: string }
  | { type: 'hw.drawer'; requestId: string; target: string; ticket?: string }
  | {
      type: 'hw.channel.open';
      requestId: string;
      kind: 'tcp' | 'tls' | 'https-request' | 'serial';
      address: string;
      tls?: { pinSha256?: string };
      serial?: { baudRate: number };
      ticket?: string;
    }
  | { type: 'hw.channel.write'; requestId: string; channelId: string; bytesB64: string }
  | { type: 'hw.channel.read'; requestId: string; channelId: string; max?: number; timeoutMs?: number }
  | { type: 'hw.channel.close'; requestId: string; channelId: string }
  | { type: 'hw.systemPrint'; requestId: string; pngB64?: string; pdfB64?: string };

export type HwErrorCode = 'unsupported' | 'no_device' | 'offline' | 'refused' | 'timeout' | 'io' | 'unknown_channel' | 'not_permitted';

export interface HwResult {
  requestId: string;
  ok: boolean;
  code?: HwErrorCode;
  message?: string;
  channelId?: string;
  bytesB64?: string;
}
