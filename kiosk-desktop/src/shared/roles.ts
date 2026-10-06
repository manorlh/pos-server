/**
 * The shell's contract with the screens (R2M POS for Windows): which ROLE this device plays, the
 * update status, and the data of the role screens that are not the kiosk (the KDS and the order
 * status board). The kiosk role keeps its own bridge (shared/bridge.ts) unchanged.
 *
 * The role is never chosen on the PC: it is what the cloud says the machine is — set when the
 * device is added in the dashboard ("הוספת מכשיר": קופה / קיוסק / מסך מטבח / מסך מוכן) and taken at
 * pairing (core/roles.ts).
 */

/** What this Windows device is. `till` and `customer_display` are scaffolding (not built yet). */
export type AppRole = 'kiosk' | 'till' | 'kds' | 'order_status_board' | 'customer_display';

export type UpdatePhase = 'idle' | 'checking' | 'up_to_date' | 'downloading' | 'ready' | 'installing' | 'failed';

export interface UpdateView {
  /** The running build. */
  current: string;
  phase: UpdatePhase;
  /** The release the cloud offers (versionName), when there is one. */
  available: string | null;
  /** 0..1 while downloading. */
  progress: number | null;
  /** Why it waits / failed, in Hebrew (shown to the technician as is). */
  message: string | null;
  lastCheckAt: number | null;
  /** The cloud's assignment: install by itself (when idle / in the window), or only by "התקן עכשיו". */
  autoInstall: boolean;
  /** "HH:MM" local, from the assignment (or kiosk.json); null = whenever the device is idle. */
  installWindow: { start: string; end: string } | null;
}

export interface ShellView {
  /** null while the role is not known yet (just paired, machines/me not read). */
  role: AppRole | null;
  /** A fiscal role (kiosk, till) issues documents; a screen (KDS, board) never does. */
  fiscal: boolean;
  appVersion: string;
  machineName: string | null;
  shopName: string | null;
  online: boolean;
  update: UpdateView;
}

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
}

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

export interface ShellEvents {
  view: ShellView;
  board: BoardView;
  kds: KdsView;
}

/** `window.r2m` (preload): the shell's own door, next to `window.kiosk`. */
export interface ShellBridge {
  view(): Promise<ShellView>;
  board(): Promise<BoardView>;
  kds(): Promise<KdsView>;
  kdsAction(action: KdsActionInput): Promise<{ ok: boolean; message?: string }>;
  /** A touch on a role screen (the update waits for a quiet device). */
  activity(): void;
  on<K extends keyof ShellEvents>(event: K, fn: (payload: ShellEvents[K]) => void): () => void;
}
