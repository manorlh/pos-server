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
}
