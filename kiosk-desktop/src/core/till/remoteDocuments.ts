/**
 * "הדפסת חשבון וקבלה על המדפסת המובנית של קופה אחרת" — the sender's side (P:/specs/bill-print-other-till.md §3–§5, §7א,
 * §10.3–§10.6; pos-android domain/RemotePrintPolicy.kt, hardware/printer/RemoteDocumentPrint.kt `RemoteDocumentFlow`,
 * `remoteDestinationsOf`, `documentJobOf`, hardware/printer/ReceiptChoice.kt `decide` / `decideFor`).
 *
 * A till prints a document — as the cloud lets it — on another till's printer: a receipt printer of type "ענן" whose host is
 * that till ("המדפסת של <שם הקופה>"). The sender draws the page as it always does and hands the host a black-and-white image
 * of it: over the LAN first, through the cloud relay (`kitchen_print_jobs`, kind `document`) when the LAN does not answer. The
 * document stays the sender's — its numbering, its "העתק", its drawer. "נשלח להדפסה ב<קופה>", then "הודפס"; not printed in
 * time, or failed: `remotePrintFallback` — asked ("לא הודפס ב<קופה> — להדפיס כאן?"), printed here, or only said.
 *
 * Everything is set per level in the cloud, and the defaults change nothing: no cloud receipt printer, no remote destination;
 * `remotePrintDocuments` `bill` (the default) sends only a table's bill, which the Windows till does not print. Pure: the
 * parameters, the cloud's printers and the host's answers in; the decisions out. The flow takes its transport, its feedback
 * and its clock as arguments, so the tests drive the timeout without waiting it.
 */

import type { KitchenPrinter } from '../kitchen/config';
import { hostAllowed, remotePrintSettingsOf, remoteWhy, type RemotePrintSettings } from './remotePrint';

export type RemotePrintDocuments = 'bill' | 'bill_receipts' | 'all';
export type RemotePrintFallback = 'ask' | 'local' | 'none';
/** What a page is, for `remotePrintDocuments`. */
export type PrintedDocKind = 'bill' | 'receipt' | 'credit' | 'report' | 'other';

/** The till parameters of remote printing (§7א), merged by the cloud per level. */
export interface RemoteDocSettings extends RemotePrintSettings {
  documents: RemotePrintDocuments;
  fallback: RemotePrintFallback;
  /** "נשלח להדפסה ב<קופה>" and "הודפס" on the sender's screen. A failure is always said. */
  notice: boolean;
  /** The dashboard's "הדפס חשבון" may name another till (live tables, §7). */
  fromDashboard: boolean;
}

function flag(raw: unknown, d: boolean): boolean {
  const v = (raw === undefined || raw === null ? '' : String(raw)).trim().toLowerCase();
  if (v === '') return d;
  if (['true', '1', 'yes', 'on', 'כן', 'פעיל'].includes(v)) return true;
  if (['false', '0', 'no', 'off', 'לא', 'כבוי'].includes(v)) return false;
  return d;
}

/** The remote printing parameters; each missing or unknown one is its default (which changes nothing). */
export function remoteDocSettingsOf(params: Record<string, unknown>): RemoteDocSettings {
  const base = remotePrintSettingsOf(params);
  const d = String(params.remotePrintDocuments ?? '').trim().toLowerCase();
  const documents: RemotePrintDocuments = ['bill_receipts', 'bill-receipts', 'receipts'].includes(d) ? 'bill_receipts' : d === 'all' ? 'all' : 'bill';
  const f = String(params.remotePrintFallback ?? '').trim().toLowerCase();
  const fallback: RemotePrintFallback = f === 'local' ? 'local' : f === 'none' ? 'none' : 'ask';
  return { ...base, documents, fallback, notice: flag(params.remotePrintNotice, true), fromDashboard: flag(params.remotePrintFromDashboard, true) };
}

/**
 * A page of [kind] may go to another till: a bill always (a reprinted one too — still a bill); an original receipt from
 * `bill_receipts`; a copy, a credit note, a report or anything else only with `all`. Off: nothing does.
 */
export function remoteAllows(s: RemoteDocSettings, kind: PrintedDocKind, copy = false): boolean {
  if (!s.enabled) return false;
  switch (kind) {
    case 'bill':
      return true;
    case 'receipt':
      return copy ? s.documents === 'all' : s.documents !== 'bill';
    default:
      return s.documents === 'all';
  }
}

/** What a page is (PrintedDocument): its kind, its own number, a copy, its code, its title — and a sale's cash (§9ב). */
export interface PrintedPage {
  kind: PrintedDocKind;
  /** The document's own number as printed (a report: none). */
  number?: string | null;
  /** A copy — "העתק" is drawn on it already. */
  copy?: boolean;
  /** The till's own code for it (a document type "320"…); null — the kind's word. */
  code?: string | null;
  /** "קבלה 1043", for the notices and "בעיות". */
  title?: string | null;
  /** A sale's own receipt: the sale, and the cash its payment moved (another till's drawer may open for it, §9ב). */
  saleId?: string | null;
  cashAgorot?: number | null;
  /** The sale's document type and number, for that drawer's job. */
  documentType?: number | null;
  documentNumber?: number | null;
}

/** `remotePrintDocuments`' class as the cloud checks it (pos-server remote_print.py): a bill; an original receipt; else other. */
export function pageCategory(p: PrintedPage): 'bill' | 'receipt' | 'other' {
  if (p.kind === 'bill') return 'bill';
  if (p.kind === 'receipt' && !p.copy) return 'receipt';
  return 'other';
}

/**
 * Another till that prints this till's documents: the cloud receipt printer it hosts ([printerId]; null — the till itself),
 * its paper, and where it takes jobs on the shop's LAN as it last reported it.
 */
export interface RemoteHost {
  printerId: string | null;
  machineId: string;
  machineName: string | null;
  /** 58 or 80 (mm): the image is drawn at its width ([remoteImageWidthDots]). */
  paperWidth: 58 | 80;
  lanAddress: string | null;
  lanPort: number | null;
  /** Its printer has a cash drawer (§9ב); null — not said, the host decides. */
  drawer: boolean | null;
}

/** How the notices name it ("המדפסת של בר"). */
export const hostLabel = (h: Pick<RemoteHost, 'machineName' | 'machineId'>): string => h.machineName?.trim() || h.machineId;

/** The image's width for a host's paper: 384 dots on 58 mm, 576 on 80 mm (203 dpi heads). */
export const remoteImageWidthDots = (paperWidth: number): number => (paperWidth === 58 ? 384 : 576);

/** The cloud's `scope` of a receipt printer: this very till first, then its area, then the shop's. */
export function receiptPrinterRank(scope: string | null | undefined): number {
  const s = (scope ?? '').trim().toLowerCase();
  return s === 'machine' ? 0 : s === 'area' ? 1 : 2;
}

/** "המדפסת של <שם הקופה>": one of the destinations a page can go to. */
export interface RemoteDestination {
  id: string;
  /** "המדפסת של <שם הקופה>". */
  name: string;
  /** Set to this very till (the cloud's `scope: machine`): it wins over the till's own printer for a page that may go there. */
  assigned: boolean;
  host: RemoteHost;
}

/** The id of this till's own printer among the destinations ("מדפסת הקופה"). */
export const LOCAL_DESTINATION = 'local';
/** This till's own choice ("מדפסת לקבלות ולמסמכים"): "לשאול בכל פעם". */
export const TILL_CHOICE_ASK = 'ask';

/**
 * The cloud receipt printers other tills print for this one, as destinations: hosted by another till (never this one),
 * allowed by `remotePrintHosts`, its host's build relaying documents (`hostDocumentRelay` not false — else the dashboard
 * says "נדרש עדכון" and it is never offered), this till's own first (rank); none while `remotePrintEnabled` is off.
 */
export function remoteDestinationsOf(printers: readonly KitchenPrinter[], s: RemotePrintSettings, myMachineId: string | null): RemoteDestination[] {
  if (!s.enabled) return [];
  return printers
    .filter((p) => p.purpose === 'receipt' && p.type === 'cloud' && !p.isHost)
    .filter((p) => !!p.hostMachineId && p.hostMachineId !== myMachineId)
    .filter((p) => hostAllowed(s, p.hostMachineId, p.hostMachineName))
    .filter((p) => p.hostDocumentRelay !== false)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => receiptPrinterRank(a.p.scope) - receiptPrinterRank(b.p.scope) || a.i - b.i)
    .map(({ p }) => {
      const host: RemoteHost = {
        printerId: p.id,
        machineId: p.hostMachineId!,
        machineName: p.hostMachineName?.trim() || p.name,
        paperWidth: p.paperWidth === 58 ? 58 : 80,
        lanAddress: p.hostLanAddress?.trim() || null,
        lanPort: p.hostLanPort,
        // A cloud printer's drawer is the host's printer's (§9ב).
        drawer: p.cashDrawer,
      };
      return { id: p.id, name: REMOTE_DOC_TEXT.dest(hostLabel(host)), assigned: receiptPrinterRank(p.scope) === 0, host };
    });
}

/** Where a page goes: this till's printer (as before), another till's, or the employee is asked among [choices]. */
export type RemoteRoute =
  | { kind: 'local' }
  | { kind: 'remote'; destination: RemoteDestination }
  | { kind: 'ask'; choices: Array<{ id: string; name: string }> };

/**
 * Pure (ReceiptChoice.decideFor on a till with one printer of its own at most): a page among this till's own printer
 * ([hasOwn], "מדפסת הקופה") and the remote [destinations]. [eligible]: this page may go to another till
 * (`remotePrintDocuments`, `remotePrintEnabled`). [tillChoice]: "מדפסת לקבלות ולמסמכים" chosen on this till (a destination id,
 * [LOCAL_DESTINATION], or [TILL_CHOICE_ASK]); [defaultId]: the question's "זכור לקופה הזו".
 *
 *  - not eligible, or nothing remote: as before;
 *  - with a printer of its own: the till's choice; a printer the cloud assigned to this very till (over a remembered default
 *    that is neither local nor assigned); the remembered default; else as before — another till's printer never brings the
 *    question by itself (only "לשאול בכל פעם" asks);
 *  - with none (printWithoutReceiptPrinter): the till's choice or the remembered default, else one the cloud assigned to it,
 *    else the employee is asked among them.
 */
export function remoteRouteOf(o: { hasOwn: boolean; destinations: readonly RemoteDestination[]; eligible: boolean; tillChoice?: string | null; defaultId?: string | null }): RemoteRoute {
  const { destinations } = o;
  const choice = o.tillChoice?.trim() || null;
  const byId = (id: string | null | undefined) => (id ? (destinations.find((d) => d.id === id) ?? null) : null);
  if (!o.eligible || destinations.length === 0) return { kind: 'local' };
  const own = { id: LOCAL_DESTINATION, name: REMOTE_DOC_TEXT.local };
  if (!o.hasOwn) {
    const preferred = (choice === TILL_CHOICE_ASK ? null : (byId(choice) ?? byId(o.defaultId))) ?? (choice === TILL_CHOICE_ASK ? null : (destinations.find((d) => d.assigned) ?? null));
    if (preferred) return { kind: 'remote', destination: preferred };
    return { kind: 'ask', choices: destinations.map((d) => ({ id: d.id, name: d.name })) };
  }
  if (choice === TILL_CHOICE_ASK) return { kind: 'ask', choices: [own, ...destinations.map((d) => ({ id: d.id, name: d.name }))] };
  if (choice === LOCAL_DESTINATION) return { kind: 'local' };
  const chosen = byId(choice);
  if (chosen) return { kind: 'remote', destination: chosen };
  const rememberedLocal = o.defaultId === LOCAL_DESTINATION;
  const remembered = byId(o.defaultId);
  const assigned = destinations.find((d) => d.assigned) ?? null;
  if (assigned && !rememberedLocal && (remembered === null || !remembered.assigned)) return { kind: 'remote', destination: assigned };
  if (remembered) return { kind: 'remote', destination: remembered };
  return { kind: 'local' };
}

/** What the sender does when the host did not print. */
export type RemoteFallbackAction = 'ask' | 'print_here' | 'notice';

/** `remotePrintFallback` on a till that has a printer of its own ([hasLocalPrinter]) or not — then it can only be said. */
export function remoteFallbackOf(mode: RemotePrintFallback, hasLocalPrinter: boolean): RemoteFallbackAction {
  if (!hasLocalPrinter) return 'notice';
  return mode === 'ask' ? 'ask' : mode === 'local' ? 'print_here' : 'notice';
}

/** A document handed to a host, as the sender last heard of it. */
export type RemoteJobState = { kind: 'waiting' } | { kind: 'printed' } | { kind: 'failed'; reason: string | null };

/** A status as the host (`/kitchen/jobs/status`) or the cloud (`print-jobs/status`) words it; "unknown" from the host — gone. */
export function remoteJobStateOf(status: string | null | undefined, error: string | null | undefined, lan: boolean): RemoteJobState {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'done':
      return { kind: 'printed' };
    case 'failed':
    case 'expired':
    case 'cancelled':
    case 'canceled':
      return { kind: 'failed', reason: error ?? status ?? null };
    case 'unknown':
      return lan ? { kind: 'failed', reason: error ?? 'unknown' } : { kind: 'waiting' };
    default:
      return { kind: 'waiting' };
  }
}

/** A document a host took: `lan` (the host at [endpoint]) or `cloud`. */
export interface RemoteHandOver {
  id: string;
  via: 'lan' | 'cloud';
  endpoint?: { address: string; port: number } | null;
}

/** How a document reaches a host, and what became of it (main/till/tillRemotePrint.ts on the till; faked in the tests). */
export interface RemoteDocumentTransport {
  /** LAN first, then the cloud; throws when neither took it ([RemotePrintFailed] with the cloud's refusal). */
  handOver(target: RemoteHost, job: DocumentJob): Promise<RemoteHandOver>;
  /** Waiting when nobody could be asked. */
  state(handed: RemoteHandOver): Promise<RemoteJobState>;
  /** Taken back before it started printing: true — it will never print there. */
  withdraw(handed: RemoteHandOver): Promise<boolean>;
}

/** What the sender's employee sees and answers. */
export interface RemotePrintFeedback {
  sent(host: string): void;
  printed(host: string): void;
  printedHere(host: string, reason: string | null): void;
  failed(host: string, reason: string | null): void;
  /** "לא הודפס ב<קופה> — להדפיס כאן?"; false when nobody answers. */
  askPrintHere(host: string, reason: string | null): Promise<boolean>;
}

export type RemoteOutcome = 'printed' | 'printed_here' | 'not_printed';

/** A document no host took: why (the cloud's refusal code, "not_sent", "too_large"). */
export class RemotePrintFailed extends Error {
  constructor(readonly reason: string) {
    super(`not printed on the other till: ${reason}`);
    this.name = 'RemotePrintFailed';
  }
}

export const REMOTE_FLOW = { POLL_MS: 1_500, TIMEOUT: 'timeout', NOT_SENT: 'not_sent', TOO_LARGE: 'too_large' } as const;
/** A PNG larger than this is not sent (the relay's cap is 512 KB, base64 and all). */
export const MAX_IMAGE_BYTES = 360_000;
/** How long "להדפיס כאן?" waits for an answer before it is a no. */
export const ANSWER_TIMEOUT_MS = 60_000;

/** One document's way, over its transport, its feedback and its clock. */
export class RemoteDocumentFlow {
  constructor(
    private readonly transport: RemoteDocumentTransport,
    private readonly feedback: RemotePrintFeedback,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly pollMs: number = REMOTE_FLOW.POLL_MS,
  ) {}

  /** To a host; "נשלח להדפסה ב<קופה>" when it took it (`remotePrintNotice`). */
  async handOver(target: RemoteHost, job: DocumentJob, s: RemoteDocSettings): Promise<{ ok: true; handed: RemoteHandOver } | { ok: false; error: unknown }> {
    try {
      const handed = await this.transport.handOver(target, job);
      if (s.notice) this.feedback.sent(hostLabel(target));
      return { ok: true, handed };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /** Until the host printed it, failed it, or `remotePrintTimeoutSec` from [startedAt] passed (taken back); not printed — the fallback. */
  async follow(handed: RemoteHandOver, target: RemoteHost, s: RemoteDocSettings, startedAt: number, local: (() => Promise<boolean>) | null, canAsk = true): Promise<RemoteOutcome> {
    const st = await this.await(handed, s.timeoutSec * 1000, startedAt);
    if (st.kind === 'printed') {
      if (s.notice) this.feedback.printed(hostLabel(target));
      return 'printed';
    }
    return this.fallback(target, s, st.kind === 'failed' ? st.reason : REMOTE_FLOW.TIMEOUT, local, canAsk);
  }

  /** Not printed at [target]: asked, printed here, or said — as `remotePrintFallback` and [local] allow. */
  async fallback(target: RemoteHost, s: RemoteDocSettings, reason: string | null, local: (() => Promise<boolean>) | null, canAsk = true): Promise<RemoteOutcome> {
    const label = hostLabel(target);
    switch (remoteFallbackOf(s.fallback, local !== null)) {
      case 'notice':
        this.feedback.failed(label, reason);
        return 'not_printed';
      case 'print_here':
        return this.printHere(label, reason, local!);
      case 'ask':
        if (!canAsk) {
          this.feedback.failed(label, reason);
          return 'not_printed';
        }
        if (await this.feedback.askPrintHere(label, reason)) return this.printHere(label, reason, local!);
        return 'not_printed';
    }
  }

  private async printHere(label: string, reason: string | null, local: () => Promise<boolean>): Promise<RemoteOutcome> {
    let ok = false;
    try {
      ok = await local();
    } catch {
      ok = false;
    }
    if (ok) {
      this.feedback.printedHere(label, reason);
      return 'printed_here';
    }
    this.feedback.failed(label, reason);
    return 'not_printed';
  }

  /** The host's answer, asked every [pollMs] until [timeoutMs] from [startedAt]; none by then — taken back, and asked once more. */
  async await(handed: RemoteHandOver, timeoutMs: number, startedAt: number): Promise<RemoteJobState> {
    const deadline = startedAt + timeoutMs;
    let st: RemoteJobState = { kind: 'waiting' };
    while (st.kind === 'waiting') {
      const left = deadline - this.now();
      if (left <= 0) break;
      await this.sleep(Math.min(this.pollMs, left));
      st = await this.ask(handed);
    }
    if (st.kind === 'waiting') {
      let withdrawn = false;
      try {
        withdrawn = await this.transport.withdraw(handed);
      } catch {
        withdrawn = false;
      }
      if (!withdrawn) st = await this.ask(handed);
    }
    return st;
  }

  private async ask(handed: RemoteHandOver): Promise<RemoteJobState> {
    try {
      return await this.transport.state(handed);
    } catch {
      return { kind: 'waiting' };
    }
  }
}

/** `POST /sync/{m}/print-jobs` (kind `document`) and `POST /kitchen/jobs` on the host's LAN port (§10.3). */
export interface DocumentJob {
  id: string;
  kind: 'document';
  printerId: string | null;
  /** No printer named: the till that prints it. */
  targetMachineId: string | null;
  document: {
    category: 'bill' | 'receipt' | 'other';
    type: string;
    number: string | null;
    copy: boolean;
    title: string | null;
    paperWidth: 58 | 80;
    widthDots: number;
    heightDots: number;
    encoding: 'png';
    image: string;
    sourceMachineId: string | null;
  };
}

/** A document job: the page's 1-bit PNG ([pngB64]) for [target], as this till ([sourceMachineId]) sends it. */
export function documentJobOf(id: string, target: RemoteHost, image: { width: number; height: number }, pngB64: string, page: PrintedPage, sourceMachineId: string | null): DocumentJob {
  const clip = (v: string | null | undefined, n: number) => (v && v.trim() ? v.trim().slice(0, n) : null);
  return {
    id,
    kind: 'document',
    printerId: target.printerId,
    targetMachineId: target.printerId === null ? target.machineId : null,
    document: {
      category: pageCategory(page),
      type: (page.code?.trim() || page.kind).slice(0, 16),
      number: clip(page.number, 40),
      copy: page.copy === true,
      title: clip(page.title, 120),
      paperWidth: target.paperWidth,
      widthDots: image.width,
      heightDots: image.height,
      encoding: 'png',
      image: pngB64,
      sourceMachineId,
    },
  };
}

/** Android's words (strings_remote_print.xml remote_print_*). */
export const REMOTE_DOC_TEXT = {
  dest: (host: string) => `המדפסת של ${host}`,
  local: 'מדפסת הקופה',
  sent: (host: string) => `נשלח להדפסה ב${host}`,
  printed: (host: string) => `הודפס ב${host}`,
  printedHere: (host: string) => `לא הודפס ב${host} — הודפס כאן`,
  failed: (host: string, why: string) => `לא הודפס ב${host}: ${why}`,
  hostFailed: (source: string, why: string) => `מסמך מ${source} לא הודפס כאן: ${why}`,
  askTitle: (host: string) => `לא הודפס ב${host} — להדפיס כאן?`,
  askYes: 'הדפס כאן',
  askNo: 'לא',
  whichTitle: 'באיזו מדפסת להדפיס?',
  cancel: 'ביטול',
  /** "ההדפסה בקופה אחרת" on the till's printer card: what goes there. */
  scope: (what: string) => `במדפסת של קופה אחרת מודפסים: ${what}. שאר המסמכים — במדפסת של הקופה הזו.`,
  scopeOf: (d: RemotePrintDocuments) => (d === 'bill' ? 'חשבונות' : d === 'bill_receipts' ? 'חשבונות, קבלות וחשבוניות' : 'כל המסמכים'),
  /** The host's reason, in words (remote_print_why_*). */
  why: (reason: string | null | undefined) => remoteWhy(reason ?? null),
} as const;
