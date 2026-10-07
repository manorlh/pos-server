/**
 * The module boundary of R2M POS for Windows: one app shell (main/index.ts), one local service
 * layer (main/service.ts — pairing, auth, sync, media cache, printing, payment providers, logs,
 * technician tools; main/update — updates), and ROLE modules on top, chosen by the cloud
 * (core/roles.ts):
 *
 *   kiosk               today's kiosk — the service's own kiosk flow and renderer/kiosk (unchanged)
 *   kds                 roles/kds.ts            + renderer/roles/kds
 *   order_status_board  roles/board.ts          + renderer/roles/board
 *   till                (next version)          + renderer/roles/RolePlaceholder
 *   customer_display    (next version)          + renderer/roles/RolePlaceholder
 *
 * A role module only reads the shared layer through this context; it never opens a shift, writes
 * a document or charges — those stay in the service, for the fiscal roles only.
 */

import type { Api } from '../sync/api';
import type { Kv } from '../db/schema';
import type { AppRole } from '../../shared/roles';

export interface RoleContext {
  api: Api;
  kv: Kv;
  machineId(): string | null;
  log(m: string): void;
}

export interface RoleModule {
  readonly role: AppRole;
  start(): void;
  stop(): void;
}
