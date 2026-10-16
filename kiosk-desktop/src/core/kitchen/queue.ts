/**
 * The life of one kitchen print job on this device — one ticket for one printer. The port of pos-android
 * hardware/kitchen/KitchenQueue.kt (the reliability audit of 13.10.2026: "שלא יהיו כפילויות בבונים … או בונים שלא
 * יצאו"):
 *
 * ```
 * HELD ──released──▶ PENDING      (a KDS-only shop's fallback ticket, held while the KDS is asked)
 * PENDING ──claimed──▶ PRINTING ──bytes going out──▶ SENDING ──printed──▶ DONE   (kept 24 h, for a reprint)
 *    │  ╲──nothing sent (off, no paper, cover open, no cloud)───────────────▶ PENDING (attempts+1, backoff — forever)
 *    │   ╲─refused (no address, the cloud refused the job…)────────────────▶ FAILED  (a person decides)
 *    │    ╲─cut short after bytes went out / paper ran out on it ──────────▶ FAILED "uncertain" (never sent again by itself)
 *    └──handed to the print server / the cloud──▶ RELAYED ──printed there──▶ DONE
 *                                                    └──failed / expired there──▶ FAILED
 *                                                    └──the host does not have it──▶ PENDING (again, the same id, marked)
 * PRINTING found at start-up: nothing went to the printer yet — PENDING again.
 * SENDING found at start-up: it may have printed — FAILED "uncertain", for a person.
 * ```
 *
 * Nothing is dropped by the machine and nothing is printed twice by it: a job leaves the queue only printed (and
 * 24 h old) or handled by a person, and a job that may already be on paper is never sent again without one. Every
 * hand-over carries the job's id — the LAN host and the cloud print one id once. Pure: every transition takes the
 * time and returns the new job.
 */

import type { JobRoute } from './routing';

export type JobState = 'held' | 'pending' | 'printing' | 'sending' | 'relayed' | 'done' | 'failed';
export type JobKind = 'ticket' | 'copy' | 'test' | 'reprint';

export interface KitchenJob {
  id: string;
  printerId: string;
  printerName: string;
  /** The printer as it was when the job was made (the config now wins when it still has it). */
  printerJson: string;
  /** The ticket (WireTicket) with this printer's lines. */
  ticketJson: string;
  route: JobRoute;
  kind: JobKind;
  state: JobState;
  attempts: number;
  lastError: string | null;
  queuedAt: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  finishedAt: number | null;
  /** lan | cloud (handed over), printer (confirmed on paper), self (handed back by the cloud: this device hosts now). */
  relayVia: string | null;
  /** Over the LAN: the host that took it, "address:port" — asked first, even after the print server moved. */
  relayHost: string | null;
  /** A job printed here for another device: the cloud's copy it answers. */
  relayJobId: string | null;
  /** The answer owed to the cloud for [relayJobId] (done | failed | printing). */
  ackStatus: string | null;
  /** 1: it came over the LAN from another device. */
  lanOrigin: number;
  /** 1: a person handled it ("סמן כטופל" / "בטל בון"). */
  dismissed: number;
  discardReason: string | null;
  /** What it belongs to: the kiosk order / the till document (its bon's status follows the jobs). */
  refId: string | null;
}

export const FIRST_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 60_000;
/** Up to this much is added to every retry, so devices that failed together do not retry together. */
export const JITTER_MS = 2_000;
/** A relayed job nobody could be asked about for this long: the host is silent (it stays with the host). */
export const RELAY_WINDOW_MS = 6 * 60_000;
/** Handed over and still not printed after this long: the staff are told ([SLOW]). */
export const RELAY_SLOW_MS = 60_000;
export const SLOW = 'slow';
/** How often the sender asks about a job it handed to a host (LAN or cloud). */
export const RELAY_POLL_MS = 5_000;
/** Printed (or discarded) jobs are kept this long, for a reprint. */
export const KEEP_FINISHED_MS = 24 * 60 * 60_000;

/** It may have printed (cut short after bytes went out, or the paper ran out on it). */
export const UNCERTAIN = 'uncertain';
export const NO_PAPER = 'no_paper';
export const COVER_OPEN = 'cover_open';
export const PRINTER_ERROR = 'printer_error';
/** A KDS-only shop's fallback ticket, held while its release is on the way ("hold:kds:<releaseId>"). */
export const KDS_HOLD_PREFIX = 'hold:kds:';
/** The KDS did not take the order and the printer fallback is off: a person decides. */
export const KDS_NOT_TAKEN = 'kds_not_taken';
/** [KitchenJob.relayVia] of a DONE job its printer confirmed (status read before and after). */
export const CONFIRMED = 'printer';
export const SELF = 'self';
/** [KitchenJob.lastError] of a relayed job nobody could be asked about for [RELAY_WINDOW_MS]. */
export const HOST_SILENT = 'print host not answering';

const CODES = new Set([UNCERTAIN, NO_PAPER, COVER_OPEN, PRINTER_ERROR, KDS_NOT_TAKEN, SLOW]);

/* ------------------------------------------------------------------ why a try failed */

/** Nowhere to send it (no address, the cloud refused the job, the printer is not reachable from here): a person's. */
export class KitchenJobRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KitchenJobRefused';
  }
}

/** It may be on paper (cut short after bytes went out, or the paper ran out on it): a person's, never resent. */
export class PrintUncertain extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrintUncertain';
  }
}

/** The printer answered that it cannot print now ([code]); nothing was sent. Retried by the queue. */
export class PrinterNotReady extends Error {
  constructor(
    readonly code: string,
    where: string,
  ) {
    super(`${code}: ${where}`);
    this.name = 'PrinterNotReady';
  }
}

/**
 * The request reached the LAN host but its answer did not come back: the host may have taken the job. The sender
 * then never prints it itself as well — only the cloud may carry it on, by the same id, which the host prints once.
 */
export class LanAnswerLost extends Error {
  constructor(message: string) {
    super(`print host did not answer: ${message}`);
    this.name = 'LanAnswerLost';
  }
}

export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  let delay = FIRST_BACKOFF_MS;
  for (let i = 1; i < attempts; i++) delay = Math.min(delay * 2, MAX_BACKOFF_MS);
  return delay;
}

/** "no_paper: 192.168.1.50:9100" → "no_paper"; a free-text error → null. */
export function codeOf(lastError: string | null): string | null {
  if (!lastError) return null;
  const head = lastError.split(':')[0].trim();
  if (CODES.has(head)) return head;
  if (lastError.startsWith(KDS_HOLD_PREFIX)) return KDS_HOLD_PREFIX;
  return null;
}

/** [code] and what more is known, as kept in [KitchenJob.lastError]. */
export function reason(code: string, detail: string | null | undefined): string {
  return detail && detail.trim() ? `${code}: ${detail.slice(0, 300)}` : code;
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The words kept with a failed try, and whether the queue may try again by itself. */
export function classify(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof KitchenJobRefused) return { message: describe(error), retryable: false };
  if (error instanceof PrintUncertain) return { message: reason(UNCERTAIN, error.message), retryable: false };
  if (error instanceof PrinterNotReady) return { message: error.message || error.code, retryable: true };
  return { message: describe(error), retryable: true };
}

/* ------------------------------------------------------------------ transitions */

export function isDue(job: KitchenJob, now: number): boolean {
  return (job.state === 'pending' || job.state === 'relayed') && job.nextAttemptAt <= now;
}

export const printing = (job: KitchenJob, now: number): KitchenJob => ({ ...job, state: 'printing', updatedAt: now });

/** The bytes are going to the printer now: from here a death leaves it [UNCERTAIN]. */
export const sending = (job: KitchenJob, now: number): KitchenJob => ({ ...job, state: 'sending', updatedAt: now });

/** Printed. [confirmed]: the printer said so (its status before and after), not only took the bytes. */
export function printed(job: KitchenJob, now: number, confirmed = false): KitchenJob {
  return {
    ...job,
    state: 'done',
    lastError: null,
    updatedAt: now,
    finishedAt: now,
    relayVia: confirmed ? CONFIRMED : job.relayVia === 'lan' || job.relayVia === 'cloud' ? job.relayVia : null,
  };
}

/** Handed to a print host ([via] lan | cloud; [host]: over the LAN, the one that took it); asked about again soon. */
export function relayed(job: KitchenJob, now: number, via: 'lan' | 'cloud', host: string | null = null): KitchenJob {
  return { ...job, state: 'relayed', relayVia: via, relayHost: via === 'lan' ? host : null, lastError: null, nextAttemptAt: now + RELAY_POLL_MS, updatedAt: now };
}

/**
 * A try failed and nothing reached paper: retried with backoff for as long as it takes — until it prints or a person
 * handles it — unless [retryable] is false (nowhere to send it, or it may already have printed), which fails it at
 * once for a person.
 */
export function attemptFailed(job: KitchenJob, now: number, error: string, retryable = true, jitterMs = 0): KitchenJob {
  const attempts = job.attempts + 1;
  if (!retryable) return { ...job, state: 'failed', attempts, lastError: error, updatedAt: now, finishedAt: now };
  return {
    ...job,
    state: 'pending',
    attempts,
    lastError: error,
    nextAttemptAt: now + backoffMs(attempts) + Math.max(0, Math.min(JITTER_MS, jitterMs)),
    updatedAt: now,
  };
}

/** A failed try, applied: [classify] and [attemptFailed] together. */
export function afterFailure(job: KitchenJob, now: number, error: unknown, jitterMs = 0): KitchenJob {
  const { message, retryable } = classify(error);
  return attemptFailed(job, now, message, retryable, jitterMs);
}

/**
 * What the print host (or the cloud) says about a job handed to it: pending | printing | done | failed | expired |
 * unknown, or null when it could not be asked. Never failed here by the clock: a job the host may hold can still print
 * there. "unknown" — the host does not have it — goes again (the same id).
 */
export function relayStatus(job: KitchenJob, now: number, status: string | null, error: string | null): KitchenJob {
  if (status === 'done') return printed(job, now);
  if (status === 'failed' || status === 'expired') return { ...job, state: 'failed', lastError: error ?? status, updatedAt: now, finishedAt: now };
  if (status === 'unknown') return { ...job, state: 'pending', relayVia: null, relayHost: null, nextAttemptAt: now, updatedAt: now };
  const late = now - job.queuedAt >= RELAY_SLOW_MS;
  const silentTooLong = status === null && now - job.queuedAt >= RELAY_WINDOW_MS;
  const lastError = status === null && error !== null ? error : silentTooLong ? HOST_SILENT : late && error !== null ? error : late ? SLOW : null;
  return { ...job, nextAttemptAt: now + RELAY_POLL_MS, updatedAt: now, lastError };
}

/** [next] is [old] sent again because the host it went to does not have it: the ticket goes marked "ייתכן שכבר הודפס". */
export function resentAfterHostLoss(old: KitchenJob, next: KitchenJob): boolean {
  return old.state === 'relayed' && next.state === 'pending' && next.relayVia === null;
}

/** The person's "נסה שוב": a fresh start. */
export function retryNow(job: KitchenJob, now: number): KitchenJob {
  return { ...job, state: 'pending', attempts: 0, nextAttemptAt: now, queuedAt: now, relayVia: null, relayHost: null, lastError: null, dismissed: 0, discardReason: null, updatedAt: now, finishedAt: null };
}

/** It may be on paper already: a person may still send it again — marked "ייתכן שכבר הודפס", never as a new order. */
export function mayBeOnPaper(job: KitchenJob): boolean {
  return job.state === 'failed' && codeOf(job.lastError) === UNCERTAIN;
}

/** "סמן כטופל" / "בטל בון" — by a person, with why. The only way a ticket leaves the queue unprinted. */
export function discarded(job: KitchenJob, now: number, why: string): KitchenJob {
  return { ...job, state: job.state === 'done' ? 'done' : 'failed', dismissed: 1, discardReason: why.trim().slice(0, 200), updatedAt: now, finishedAt: job.finishedAt ?? now };
}

/** A job as this device finds it when it starts again. */
export function recovered(job: KitchenJob, now: number): KitchenJob {
  if (job.state === 'printing') return { ...job, state: 'pending', nextAttemptAt: now, updatedAt: now };
  if (job.state === 'sending') return { ...job, state: 'failed', attempts: job.attempts + 1, updatedAt: now, finishedAt: now, lastError: reason(UNCERTAIN, 'the till stopped while it printed') };
  return job;
}

/** A held job released: due now, as if just queued. */
export function released(job: KitchenJob, now: number): KitchenJob {
  return { ...job, state: 'pending', lastError: null, nextAttemptAt: now, queuedAt: now, updatedAt: now };
}

/** A held job whose release did not go through and that now needs a person: FAILED with [code] — shown, never printed by itself. */
export function surfaced(job: KitchenJob, now: number, code: string, detail: string | null): KitchenJob {
  return { ...job, state: 'failed', updatedAt: now, finishedAt: now, lastError: reason(code, detail) };
}

/** The staff should see it: waiting after a failed try, failed and not handled, or at a host that stopped answering. */
export function needsAttention(job: KitchenJob): boolean {
  return job.dismissed === 0 && ((job.state === 'pending' && job.attempts > 0) || job.state === 'failed' || (job.state === 'relayed' && job.lastError !== null));
}

/** May be deleted now: printed or discarded, older than [KEEP_FINISHED_MS], nothing owed to the cloud. */
export function purgeable(job: KitchenJob, now: number): boolean {
  if (job.finishedAt === null || now - job.finishedAt < KEEP_FINISHED_MS || job.ackStatus !== null) return false;
  return job.state === 'done' || (job.state === 'failed' && job.dismissed === 1);
}

/** The cloud hands this device a job it already has (printed here, the ack lost; or it came over the LAN first). */
export function relayedAgain(existing: KitchenJob, relayId: string): KitchenJob | null {
  const finished = existing.state === 'done' || existing.state === 'failed';
  if (finished && existing.ackStatus === null) return { ...existing, relayJobId: relayId, ackStatus: existing.state };
  if (!finished && existing.relayJobId === null) return { ...existing, relayJobId: relayId };
  return null;
}

/** A job of this device's own handed back to it by the cloud: it is the print host now — printed here. */
export function takenBackAsHost(existing: KitchenJob, relayId: string, now: number, ticketJson: string | null): KitchenJob | null {
  if (existing.state !== 'relayed' || existing.relayVia !== 'cloud' || existing.lanOrigin !== 0 || existing.relayJobId !== null) return null;
  return { ...existing, state: 'pending', route: 'DIRECT', relayJobId: relayId, relayVia: SELF, relayHost: null, lastError: null, nextAttemptAt: now, updatedAt: now, ticketJson: ticketJson ?? existing.ticketJson };
}

/* ------------------------------------------------------------------ the LAN host it went to */

export interface LanHostRef {
  address: string;
  port: number;
}

/** "address:port" as [KitchenJob.relayHost] keeps it (an IPv6 address has colons of its own). */
export function relayHostOf(t: LanHostRef): string {
  return `${t.address}:${t.port}`;
}

export function relayTargetOf(relayHost: string | null): LanHostRef | null {
  const raw = relayHost?.trim();
  if (!raw) return null;
  const cut = raw.lastIndexOf(':');
  if (cut <= 0) return null;
  const port = Number(raw.slice(cut + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  return { address: raw.slice(0, cut), port };
}

/** Where to ask about a job handed over the LAN: the host that took it first, then the printer's host now when another. */
export function relayAskOrder(recorded: LanHostRef | null, current: LanHostRef | null): LanHostRef[] {
  const out: LanHostRef[] = [];
  const first = recorded ?? current;
  if (first) out.push(first);
  if (recorded && current && (current.address !== recorded.address || current.port !== recorded.port)) out.push(current);
  return out;
}

/** One line for the device log when a job finishes: where its time went. Null while it is not finished. */
export function timingLine(job: KitchenJob): string | null {
  if (job.state !== 'done' && job.state !== 'failed') return null;
  const queued = Math.max(0, job.queuedAt - job.createdAt);
  const finished = job.finishedAt !== null ? Math.max(0, job.finishedAt - job.queuedAt) : null;
  const tries = job.attempts + (job.state === 'done' ? 1 : 0);
  const via = job.relayVia ? `/${job.relayVia}` : '';
  return `bon timing: ${job.printerName} [${job.route.toLowerCase()}${via}] ${job.state} — created→queued ${queued} ms, queued→finished ${finished ?? '-'} ms, tries ${tries} (${job.kind} ${job.id.slice(0, 8)})`;
}

/** The kiosk order's bon, from its jobs: printed only when every printer confirmed; sent when every job left this device. */
export function bonJobState(job: KitchenJob | null): 'queued' | 'sending' | 'sent' | 'printed' | 'failed' {
  if (!job) return 'failed';
  if (job.state === 'done') return job.relayVia === CONFIRMED ? 'printed' : 'sent';
  if (job.state === 'failed') return 'failed';
  if (job.state === 'sending' || job.state === 'printing') return 'sending';
  return 'queued';
}
