/**
 * What the till engine (main/till/engine.ts) hands the modules that add a feature to it — the drawer (tillDrawer.ts), the
 * employee's one device (userSessions.ts), the change owed and the cash credits (tillCash.ts): who is signed in, the roster,
 * the engine's own refusals, questions (its `dialog`, part of the state — the screens show what the engine asks), toasts,
 * and a way to say the state changed. The modules hold their own state; the engine stays the one door the screens talk to.
 */

import type { BcryptCompare } from '../../core/desktopExit';
import type { RosterUser } from '../../core/till/staff';
import type { EngineDialog, TillErrorCode } from '../../shared/till/protocol';
import type { KioskService } from '../service';

/** Someone who approved with their code: their id and name (and, from the roster, their profile). */
export interface ApproverRef {
  id: string;
  name: string;
}

/** A question the engine asks (a manager's code, a confirmation, a choice) — answered with `dialog.answer`. */
export interface DialogSpec {
  kind: EngineDialog['kind'];
  title: string;
  body: string;
  fields: EngineDialog['fields'];
  actions: EngineDialog['actions'];
  /** A permission a manager's code must hold (checked against the roster); null — none (a confirmation, or `verify`). */
  code?: string | null;
  /** A check of the typed code of its own (the drawer's approver: allowed it within their limits, and the drawer approval). */
  verify?: (pin: string) => Promise<{ ok: true; by: ApproverRef } | { ok: false; message: string }>;
  /** "approve" with a code checked (by `code` or `verify`), or a confirmation's "approve". */
  resume?: (approver: ApproverRef | null) => unknown;
  /** Every action but "cancel", when the dialog is a choice (its actions are the choices). */
  onAction?: (action: string, answers: Record<string, string>) => unknown;
  /** "cancel" (or the dialog dismissed). */
  onCancel?: () => unknown;
  /** Unanswered for this long: closed, and `onTimeout` runs. */
  expiresInMs?: number;
  onTimeout?: () => unknown;
}

export interface TillContext {
  readonly svc: KioskService;
  readonly compare: BcryptCompare;
  now(): number;
  log(m: string): void;
  /** The employee signed in (and not locked), or null. */
  operator(): RosterUser | null;
  /** The employee signed in, or the refusal "יש להתחבר לקופה". */
  signedIn(): RosterUser;
  roster(): RosterUser[];
  shopId(): string | null;
  /** Throws the engine's refusal (the reply's error). */
  refuse(code: TillErrorCode, message?: string, details?: Record<string, unknown>): never;
  /** Ask: the dialog is in the state until answered (or it expires). */
  ask(d: DialogSpec): { dialogId: string };
  toast(text: string, tone?: 'info' | 'error' | 'ok'): void;
  /** Something the screens show changed: a new state goes out. */
  changed(): void;
  /** Work that continues after an op returned, serialised with the ops (never between two steps of another). */
  later<T>(fn: () => Promise<T> | T): Promise<T>;
  /** A payment is on (the checkout taking tenders or waiting on the card, or a card at the terminal). */
  paying(): boolean;
  /** A question is on the screen now (a new one would take its place): a module's own question waits for it. */
  dialogOpen?(): boolean;
  /**
   * The engine's permission gate (Android PermissionGate): `allowed` runs `resume(null)` at once; `approval` asks a manager's
   * code (only someone allowed it alone within their own limits) and runs `resume(approver)` when it is typed — the call
   * returns `{dialogId}` then; `denied` refuses "אין לך הרשאה: …" (or, with `askOnDeny`, asks a manager too). Every override
   * goes into the drawer's audit as the engine's own gates do.
   */
  gate(code: string, resume: (approver: ApproverRef | null) => unknown, opts?: GateOptions): unknown;
  /** The operator's own answer for `code` now (the acting profile: "כשאין הרשאה" = לבקש קוד מנהל included). */
  decide(code: string, opts?: { amount?: number | null; percent?: number | null }): 'allowed' | 'approval' | 'denied';
  /** The codes whose options the screens leave out for this operator ("כשאין הרשאה" = להסתיר, the engine's `session.hidden`). */
  hiddenCodes(): string[];
  /**
   * Another op of the engine, carried out INSIDE the op (or the `later` work) running now — the same rules and gates as from
   * a screen (e.g. `sell.add`, `checkout.start`, `checkout.voucher`). Never from outside an op: it does not queue.
   */
  run(op: string, args?: Record<string, unknown>): Promise<unknown>;
}

/**
 * A feature module the engine carries (registered with `engine.register`): its ops — routed to `apply` — and its slice of the
 * state, under `key` (omitted while `state()` says undefined). The engine stays the one door: the ops keep their
 * clientOpId bookkeeping, the touch, the refusal envelope.
 */
export interface TillFeature {
  readonly key: string;
  readonly ops: readonly string[];
  /** The ops that change something (each needs a clientOpId, never applied twice). */
  readonly mutating: readonly string[];
  apply(op: string, args: Record<string, unknown>): unknown;
  state(): unknown;
  stop?(): void;
}

export interface GateOptions {
  askOnDeny?: boolean;
  title?: string;
  body?: string;
  /** The money at stake (₪), held to the role's and the approver's limits. */
  amount?: number | null;
  percent?: number | null;
  /** A setting waives the second person (never turns a denial into an allowance). */
  relax?: boolean;
  /** A setting asks a second person even when the role allows it. */
  force?: boolean;
}
