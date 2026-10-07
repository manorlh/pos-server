/**
 * The role screens' door to their host — what the KDS and the "מסך מוכן / לא מוכן" screens read and
 * do, wherever they run:
 *
 *  - the Windows app: its shell over `window.r2m` (kiosk-desktop/src/shared/roles.ts `ShellBridge`,
 *    which has this shape and more);
 *  - the browser screens at `/kds` and `/board` (lib/screenWebService.ts `bridge()`), or their demo.
 *
 * Rule for every file under kiosk-shared/roles: React, lucide-react and the pure `lib/` files only
 * (no Next.js, no next-intl, no dashboard API) — kiosk-desktop renders them as they are.
 */

import type { BoardView, KdsActionInput, KdsView } from '@/lib/kdsScreenTypes';

export interface RoleScreenEvents {
  kds: KdsView;
  board: BoardView;
}

export interface RoleScreenBridge {
  kds(): Promise<KdsView>;
  kdsAction(action: KdsActionInput): Promise<{ ok: boolean; message?: string }>;
  board(): Promise<BoardView>;
  /** A touch on a role screen (the Windows updater waits for a quiet device). */
  activity(): void;
  on<K extends keyof RoleScreenEvents>(event: K, fn: (payload: RoleScreenEvents[K]) => void): () => void;
}
