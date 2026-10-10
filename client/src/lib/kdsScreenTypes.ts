/**
 * The KDS and "מסך מוכן / לא מוכן" screens' data, shared by every host that shows them: the Windows
 * app (kiosk-desktop — its shell sends these over `window.r2m`; kiosk-desktop/src/shared/roles.ts
 * re-exports them) and the browser screens at `/kds` and `/board` (lib/screenWebService.ts). The
 * shapes are the cloud's (server app/services/kds.py `board`, `order_out`, `task_out`).
 *
 * Self-contained on purpose (no `@/` imports): the node tests and kiosk-desktop compile it as is.
 */

/* --------------------------------------------------------- order status board */

export interface BoardNumber {
  number: string;
  /** ISO: released (preparing) / became ready (ready). */
  since: string | null;
}

/** "מסך מוכן / לא מוכן": pickup numbers only — never a name, a phone or a note. */
export interface BoardView {
  shopName: string | null;
  preparing: BoardNumber[];
  ready: BoardNumber[];
  /** The last good answer (epoch ms), or null when there never was one. */
  updatedAt: number | null;
  /** No answer from the cloud lately: the last board is shown, with a note. */
  offline: boolean;
  /** The cloud does not (or no longer) know this device as a board screen. */
  notConfigured: boolean;
  /** How the board looks, from its KDS screen in the dashboard (`kds_devices.display`); null = the defaults. */
  display?: BoardDisplay | null;
}

/**
 * The screens' look — `kds_devices.display` v2 (server app/services/kds_display.py, docs/SPEC_KDS.md
 * §13.4.3, §14): the screen's own, else the shop's default for its kind, else null (today's look).
 * One stored object carries both groups; a board reads the board's keys, a kitchen screen the KDS's.
 */
export type ScreenThemeName = 'dark' | 'light' | 'contrast' | 'brand';
/** The board's look (dashboard ← מסכי מטבח ← the pickup screen; pickupBoard.ts `boardDisplayOf`). */
export type BoardThemeName = ScreenThemeName;

/** "שני טורים" (today) · "מוכן עכשיו" · "רשת מספרים" · "מספרים ומדיה" · "פס מספרים על מדיה". */
export type BoardLayout = 'columns' | 'spotlight' | 'grid' | 'split' | 'ticker';

/** A picture / video of the board's media panel — a kiosk MediaRef (`POST /kiosks/media`) and its time on screen. */
export interface BoardMedia {
  url: string;
  kind: 'image' | 'video';
  sha256: string | null;
  bytes: number | null;
  durationSec: number;
}

export interface BoardDisplay {
  theme: BoardThemeName;
  /** "#rrggbb": the ready column and the announcement (the brand theme's colour); null = the theme's own. */
  accent: string | null;
  /** The chime on a number turning ready. */
  sound: boolean;
  /** The "בהכנה" column (off: only the ready numbers, full width). */
  showPreparing: boolean;
  /** A title over the board (the shop's name when empty). */
  title: string | null;
  boardLayout: BoardLayout;
  /** A ready number leaves the board after this many minutes (the cloud applies it); null = until handed over. */
  readyMinutes: number | null;
  /** The media panel ("split", "ticker"); empty = the promo text on the accent. */
  media: BoardMedia[];
  promoText: string | null;
}

/** "כרטיסים" (today) · "טורים לפי תחנה / מנה" · "מסילה" · "רשימה" · "כרטיסים גדולים". */
export type KdsLayout = 'tickets' | 'columns' | 'rail' | 'list' | 'big';
export type KdsColumnsBy = 'station' | 'course';
export type KdsDensity = 'compact' | 'normal' | 'large';
export type KdsSoundTone = 'chime' | 'bell' | 'knock' | 'beep' | 'off';
/** A new order · a cancellation / note to see · an order turning late. */
export type KdsSoundEvent = 'new' | 'change' | 'late';
export type KdsField = 'table' | 'name' | 'waiter' | 'guests' | 'course' | 'notes' | 'allergens' | 'modifiers';

export interface KdsDisplay {
  theme: ScreenThemeName;
  /** "#rrggbb": the kitchen's accent (start / handover, the new-order glow); null = the theme's own. */
  accent: string | null;
  layout: KdsLayout;
  columnsBy: KdsColumnsBy;
  density: KdsDensity;
  /** 0.8 – 1.6: everything below the header, bigger or smaller. */
  fontScale: number;
  /** The card's colour by its age (off: the minutes only). */
  ageColors: boolean;
  /** The screen's own thresholds (both or neither); null = the stations' (`stationSettings`). */
  warnMinutes: number | null;
  lateMinutes: number | null;
  fields: Record<KdsField, boolean>;
  sounds: Record<KdsSoundEvent, KdsSoundTone>;
  /** The header's clock and counts. */
  clock: boolean;
  counts: boolean;
}

/** The whole stored look (both groups) — what the dashboard edits and saves. */
export type ScreenDisplay = BoardDisplay & KdsDisplay;

/* ------------------------------------------------------------------------- KDS */

/** One item at one station (server app/services/kds.py `task_out`). */
export interface KdsTask {
  id: string;
  orderId: string;
  roundNo: number;
  stationId: string | null;
  stationName: string | null;
  targetKind: 'prep' | 'view' | string;
  required: boolean;
  lineKey: string;
  name: string;
  mods: string[];
  removals: string[];
  notes: string | null;
  allergies: string[];
  important: boolean;
  seat: string | null;
  course: string | null;
  mealName: string | null;
  orderedQty: number;
  cancelledQty: number;
  preparedQty: number;
  activeQty: number;
  release: 'hold' | 'released' | string;
  state: 'queued' | 'preparing' | 'ready' | string;
  version: number;
  releasedAt: string | null;
  startedAt: string | null;
  readyAt: string | null;
  /** The till printed this round on a fallback printer: "כבר הוכן" / "להכין" (resolve_fallback). */
  fallbackPrinted?: boolean;
  fallbackResolved?: boolean;
  /** Prepared before a cancellation reached the station (recorded). */
  overPrepared?: boolean;
  remakeReason?: string | null;
  /** This screen acted on it and the cloud has not confirmed yet (shown applied). */
  pending?: boolean;
}

/** A cancellation / note change the kitchen must see (`change_out`). */
export interface KdsChange {
  id: string;
  taskId: string | null;
  stationId: string | null;
  kind: string;
  qty: number | null;
  text: string | null;
  requiresAck: boolean;
  acked: boolean;
  createdAt: string | null;
}

/** One order on the screen (`order_out`). */
export interface KdsOrder {
  id: string;
  source: string;
  displayRef: string | null;
  tableRef: string | null;
  zoneName: string | null;
  serviceType: string | null;
  guests: number | null;
  waiterName: string | null;
  pickupName: string | null;
  orderNote: string | null;
  pickupNumber: number | null;
  /**
   * A kiosk order's label as its slip printed it — "A-17", or "17" with the kiosk's "מספר בלבד";
   * absent for any other order. The card's headline over `#pickupNumber`.
   */
  pickupLabel?: string | null;
  workflowMode: string;
  paid: boolean;
  status: string;
  priority: number | null;
  groupState: string | null;
  readyAt: string | null;
  allReady: boolean;
  requireExpo: boolean;
  requireStart: boolean;
  trackHandover: boolean;
  viewOnly: boolean;
  firstReleasedAt: string | null;
  createdAt: string | null;
  version: number;
  tasks: KdsTask[];
  changes: KdsChange[];
  otherStations?: string[];
  priorityReason?: string | null;
  /** Ready for pickup before every station was done: the reason given. */
  groupOverride?: string | null;
  /** This screen acted on it and the cloud has not confirmed yet (shown applied). */
  pending?: boolean;
}

export interface KdsDeviceInfo {
  id: string;
  name: string;
  /** station | expo | manager (pickup is the board role). */
  role: string;
  stations: Array<{ id: string; name: string }>;
}

export interface KdsView {
  device: KdsDeviceInfo | null;
  shopName: string | null;
  orders: KdsOrder[];
  stationSettings: Record<string, { targetKind: string; warnMinutes: number; lateMinutes: number }>;
  updatedAt: number | null;
  offline: boolean;
  /** Actions taken here that the cloud has not confirmed yet (shown applied). */
  pendingActions: number;
  /** The last action the cloud refused, in Hebrew. */
  lastError: string | null;
  /** Clock offset (server − local, ms) so the timers count from the cloud's times. */
  serverOffsetMs: number;
  /** The cloud does not (or no longer) know this machine as a KDS screen (403 not_a_kds_device). */
  notConfigured?: boolean;
  /** How the screen looks (the device's `display`, screenLook.ts `kdsDisplayOf`); null = today's look. */
  display?: KdsDisplay | null;
}

export type KdsActionType =
  | 'start'
  | 'item_ready'
  | 'undo_ready'
  | 'station_ready'
  | 'ack_change'
  | 'ready_for_pickup'
  | 'undo_pickup'
  | 'handover'
  | 'priority'
  | 'resolve_fallback';

/** A screen action; the shell adds its idempotency id, the time and the expected version. */
export interface KdsActionInput {
  type: KdsActionType;
  taskId?: string;
  orderId?: string;
  changeId?: string;
  stationId?: string;
  priority?: number;
  /** Required by `priority` and by an overriding `ready_for_pickup`. */
  reason?: string;
  /** `ready_for_pickup` before every station is done (expo / manager, with a reason). */
  override?: boolean;
  /** `resolve_fallback`: already prepared, or prepare it now. */
  resolution?: 'prepared' | 'prepare';
}
