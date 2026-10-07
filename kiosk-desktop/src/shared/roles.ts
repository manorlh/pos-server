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

/* ------------------------------------------------- the KDS and the order status board */

// The role screens' data is shared with the browser screens at `/kds` and `/board` on the
// dashboard's site: the types live in client/src/lib/kdsScreenTypes.ts (the cloud's shapes).
import type { BoardView, KdsActionInput, KdsView } from '@dash-lib/kdsScreenTypes';

export type {
  BoardDisplay,
  BoardNumber,
  BoardThemeName,
  BoardView,
  KdsActionInput,
  KdsActionType,
  KdsChange,
  KdsDeviceInfo,
  KdsOrder,
  KdsTask,
  KdsView,
} from '@dash-lib/kdsScreenTypes';

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
  /** "הפעלה כגשר לדפדפן" (an unpaired device): restarts as the bridge (main/shell/mode.ts). */
  becomeBridge?(): Promise<{ ok: boolean; message?: string }>;
  on<K extends keyof ShellEvents>(event: K, fn: (payload: ShellEvents[K]) => void): () => void;
}
