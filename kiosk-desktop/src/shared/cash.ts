/**
 * The cash host's local staff screen ("מסך צוות", P:/specs/cash-paylink.md §5): what the shell shows
 * on the box's own screen (when one is attached) and the actions it takes — behind a manager's code
 * (the kiosk's KIOSK_UNLOCK, checked offline against the synced roster).
 */

import type { StationAlert } from '../core/cash/alerts';
import type { StationStatus } from '../core/cash/lanProtocol';
import type { TxView } from '../core/cash/tx';

export interface CashStationStaffView {
  stationId: string;
  name: string;
  location: string | null;
  serial: string;
  simulator: boolean;
  status: StationStatus;
  alerts: StationAlert[];
  denominations: Array<{ valueAgorot: number; kind: 'coin' | 'note'; count: number; accurate: boolean; level: string | null; isLow: boolean }>;
  cashbox: { notes: number; coins: number; valueAgorot: number; nearFull: boolean; full: boolean } | null;
  changeAvailableAgorot: number;
  clients: Array<{ machineId: string; name: string; kind: string }>;
  recent: TxView[];
  moves: Array<{ id: string; kind: string; amountAgorot: number; at: number; note: string | null; by: { name: string | null } | null }>;
  maintenance: boolean;
  /** "מילוי דרך המקבל" runs. */
  refillVia: boolean;
}

export interface CashHostView {
  hostId: string | null;
  lanAddress: string | null;
  port: number;
  cloudOnline: boolean;
  lastPullAt: number | null;
  uploadError: string | null;
  pendingUploads: number;
  stations: CashStationStaffView[];
  /** A manager's code was entered (5 minutes). */
  unlocked: boolean;
  staffName: string | null;
}

export type CashStaffOp =
  | 'refill'
  | 'float'
  | 'count'
  | 'collect'
  | 'dump'
  | 'deliver_pending'
  | 'ext_return'
  | 'ext_stack'
  | 'maintenance_on'
  | 'maintenance_off'
  | 'reset_alerts'
  | 'refill_via_start'
  | 'refill_via_stop'
  /** The simulator only: a customer puts a coin / note in, takes a bill. */
  | 'sim_insert'
  | 'sim_take';

export interface CashStaffAction {
  stationId: string;
  op: CashStaffOp;
  pieces?: Array<{ valueAgorot: number; count: number }>;
  countedAgorot?: number | null;
  valueAgorot?: number | null;
  notes?: number | null;
  note?: string | null;
}

export interface CashStaffResult {
  ok: boolean;
  message: string;
}
