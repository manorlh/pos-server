/**
 * "הדפסה בקופה אחרת" — the Windows till's pages on another till's printer (P:/specs/bill-print-other-till.md §3–§5, §7א,
 * §9ב, §10.3–§10.6; pos-android hardware/printer/RemoteDocumentPrint.kt, ExternalReceiptPrinter.kt `SwitchingReceiptPrinter`,
 * hardware/kitchen/KitchenPrintService.kt `documentTransport`). The rules are core/till/remoteDocuments.ts; this module is
 * their wiring:
 *
 *  - every page the till prints (a receipt and its copy, a credit note, X / Z, "דוח X סניפי") asks here first
 *    (`KioskService.setRemoteDocuments`): as before, on another till's printer ("המדפסת של <שם הקופה>" — a cloud receipt
 *    printer another till hosts, as `remotePrintDocuments` allows the page), or "באיזו מדפסת להדפיס?";
 *  - a page that goes there is drawn here at the host's paper width (384 / 576 dots), one bit a dot, as a PNG
 *    (core/monoPng.ts), and handed over the LAN to the host's print port first (`POST /kitchen/jobs`, the shop's print
 *    secret), through the cloud relay when the LAN does not answer (`POST /sync/{m}/print-jobs`) — by the same id;
 *  - "נשלח להדפסה ב<קופה>", then "הודפס"; not printed in `remotePrintTimeoutSec` — taken back, and `remotePrintFallback`:
 *    "לא הודפס ב<קופה> — להדפיס כאן?", printed here by itself, or only said;
 *  - a cash sale's receipt there: the drawer there as `remotePrintDrawer` says (§9ב, main/till/tillDrawer.ts) — the sale's
 *    own drawer here opens as before. The document stays this till's: its number, its "העתק".
 *
 * Electron-free; the transport, the clock and the sleep are injectable (the tests).
 */

import { randomUUID } from 'node:crypto';
import { centreOn, receiptContentWidth, toMono, trimBottom, type MonoBitmap } from '../../core/escpos';
import { DEFAULT_LAN_PORT, type KitchenPrinter } from '../../core/kitchen/config';
import { lanTargetOf } from '../../core/kitchen/routing';
import { encodeMonoPng } from '../../core/monoPng';
import type { PrintDoc } from '../../core/printDocs';
import {
  ANSWER_TIMEOUT_MS,
  LOCAL_DESTINATION,
  MAX_IMAGE_BYTES,
  REMOTE_DOC_TEXT,
  REMOTE_FLOW,
  RemoteDocumentFlow,
  RemotePrintFailed,
  documentJobOf,
  hostLabel,
  remoteAllows,
  remoteDestinationsOf,
  remoteDocSettingsOf,
  remoteImageWidthDots,
  remoteJobStateOf,
  remoteRouteOf,
  type DocumentJob,
  type PrintedPage,
  type RemoteDestination,
  type RemoteDocumentTransport,
  type RemoteHandOver,
  type RemoteHost,
  type RemoteJobState,
  type RemoteOutcome,
  type RemotePrintFeedback,
} from '../../core/till/remoteDocuments';
import { lanCall as defaultLanCall, type LanCall } from '../kitchen/kitchenNet';
import type { TillContext } from './tillContext';

/** The settings-table keys (Android ReceiptChoice.KEY_TILL / KEY_DEFAULT): this till's own choice, and the question's memory. */
export const TILL_PRINTER_KEY = 'receipt.tillPrinter';
export const DEFAULT_PRINTER_KEY = 'receipt.defaultPrinter';

/** What the service asks of the till for each page (KioskService.setRemoteDocuments). */
export interface RemoteDocumentsRouter {
  /**
   * [page] ([doc] as drawn): printed here now by [local] (its print job's id), or handed elsewhere / asked about — null.
   * [local] prints it on this till's own printer, as before.
   */
  print(page: PrintedPage, doc: PrintDoc, local: () => string | null): string | null;
}

export interface TillRemotePrintOptions {
  transport?: RemoteDocumentTransport;
  lanCall?: LanCall;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** The page as the host's dots (tests: no renderer window). */
  draw?: (doc: PrintDoc, widthDots: number) => Promise<MonoBitmap>;
}

const LAN_CONNECT_MS = 1_500;
const LAN_READ_MS = 6_000;

export class TillRemotePrint implements RemoteDocumentsRouter, RemotePrintFeedback {
  private readonly transport: RemoteDocumentTransport;
  private readonly lan: LanCall;
  /** A cash sale's receipt whose drawer there was decided (§9ב): once per sale. */
  private readonly drawerDone = new Set<string>();

  constructor(
    private readonly c: TillContext,
    private readonly o: TillRemotePrintOptions & { remoteAfterCash?: (host: RemoteHost, page: PrintedPage) => void } = {},
  ) {
    this.lan = o.lanCall ?? defaultLanCall;
    this.transport = o.transport ?? this.cloudAndLan();
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  start() {
    this.c.svc.setRemoteDocuments(this);
  }

  stop() {
    this.c.svc.setRemoteDocuments(null);
  }

  /* ------------------------------------------------------------------ where a page goes */

  /** The remote destinations as the cloud's printers give them now (none while `remotePrintEnabled` is off). */
  destinations(): RemoteDestination[] {
    const svc = this.c.svc;
    return remoteDestinationsOf(svc.kitchen.config().printers, remoteDocSettingsOf(svc.cloud.parameters()), svc.machineId);
  }

  /** "מדפסת לקבלות ולמסמכים" chosen on this till, and the question's "זכור לקופה הזו". */
  private choices(): { tillChoice: string | null; defaultId: string | null } {
    const kv = this.c.svc.kv;
    return { tillChoice: kv.get(TILL_PRINTER_KEY), defaultId: kv.get(DEFAULT_PRINTER_KEY) };
  }

  print(page: PrintedPage, doc: PrintDoc, local: () => string | null): string | null {
    const svc = this.c.svc;
    const destinations = this.destinations();
    if (destinations.length === 0) return local();
    const s = remoteDocSettingsOf(svc.cloud.parameters());
    const hasOwn = svc.hasOwnReceiptPrinter();
    const route = remoteRouteOf({ hasOwn, destinations, eligible: remoteAllows(s, page.kind, page.copy === true), ...this.choices() });
    switch (route.kind) {
      case 'local':
        return local();
      case 'remote':
        void this.send(route.destination, page, doc, hasOwn ? local : null);
        return null;
      case 'ask':
        this.askWhere(route.choices, destinations, page, doc, hasOwn ? local : null);
        return null;
    }
  }

  /**
   * [fn] once no other question is on the screen (a drawer's "לפתוח מגירה?" right after the sale): a question never takes
   * another's place. Gives up after [ANSWER_TIMEOUT_MS] — [onGiveUp].
   */
  private whenNoDialog(fn: () => void, onGiveUp: () => void) {
    const until = this.now() + ANSWER_TIMEOUT_MS;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const attempt = async (): Promise<void> => {
      const open = await this.c.later(() => {
        if (this.c.dialogOpen?.()) return true;
        fn();
        this.c.changed();
        return false;
      });
      if (!open) return;
      if (this.now() >= until) return onGiveUp();
      await sleep(500);
      return attempt();
    };
    void attempt().catch((e: unknown) => this.c.log(`remote print: a question — ${String(e)}`));
  }

  /** "באיזו מדפסת להדפיס?" — each printer by name; the answer is remembered for this till ("זכור לקופה הזו", ticked). */
  private askWhere(choices: Array<{ id: string; name: string }>, destinations: RemoteDestination[], page: PrintedPage, doc: PrintDoc, local: (() => string | null) | null) {
    this.whenNoDialog(() => this.askWhereNow(choices, destinations, page, doc, local), () => undefined);
  }

  private askWhereNow(choices: Array<{ id: string; name: string }>, destinations: RemoteDestination[], page: PrintedPage, doc: PrintDoc, local: (() => string | null) | null) {
    this.c.ask({
      kind: 'confirm',
      title: REMOTE_DOC_TEXT.whichTitle,
      body: page.title ?? '',
      fields: [],
      actions: [...choices.map((ch, i) => ({ id: `printer:${ch.id}`, label: ch.name, primary: i === 0 })), { id: 'cancel', label: REMOTE_DOC_TEXT.cancel }],
      onAction: (action) => {
        const id = action.replace(/^printer:/, '');
        this.c.svc.kv.set(DEFAULT_PRINTER_KEY, id);
        if (id === LOCAL_DESTINATION) {
          local?.();
          return undefined;
        }
        const d = destinations.find((x) => x.id === id);
        if (d) void this.send(d, page, doc, local);
        return undefined;
      },
      onCancel: () => undefined,
      expiresInMs: ANSWER_TIMEOUT_MS,
      onTimeout: () => undefined,
    });
  }

  /* ------------------------------------------------------------------ the way there */

  /**
   * [doc] on [destination]'s printer: drawn at its paper's width, handed over, followed in the background; nowhere took it —
   * the fallback at once ([local]: this till's own printer; null — it has none). How it ended.
   */
  async send(destination: RemoteDestination, page: PrintedPage, doc: PrintDoc, local: (() => string | null) | null): Promise<RemoteOutcome> {
    const svc = this.c.svc;
    const s = remoteDocSettingsOf(svc.cloud.parameters());
    const target = destination.host;
    const flow = new RemoteDocumentFlow(this.transport, this, () => this.now(), this.o.sleep, this.o.pollMs);
    const startedAt = this.now();
    const here = local ? async () => local() !== null : null;
    let png: Buffer | null = null;
    let bmp: MonoBitmap | null = null;
    try {
      bmp = await this.draw(doc, remoteImageWidthDots(target.paperWidth));
      png = encodeMonoPng(bmp);
    } catch (e) {
      this.c.log(`remote print: the page could not be drawn for ${hostLabel(target)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!png || !bmp || png.length > MAX_IMAGE_BYTES) {
      if (png) this.c.log(`remote print: page of ${png.length} bytes is over the cap — not sent to ${hostLabel(target)}`);
      return flow.fallback(target, s, REMOTE_FLOW.TOO_LARGE, here);
    }
    const job = documentJobOf(randomUUID(), target, bmp, png.toString('base64'), page, svc.machineId);
    const handed = await flow.handOver(target, job, s);
    if (!handed.ok) {
      const reason = handed.error instanceof RemotePrintFailed ? handed.error.reason : REMOTE_FLOW.NOT_SENT;
      this.c.log(`remote print: ${hostLabel(target)} not reached (${handed.error instanceof Error ? handed.error.message : String(handed.error)})`);
      return flow.fallback(target, s, reason, here);
    }
    this.c.log(`remote print: ${job.document.category}/${job.document.type}${job.document.number ? ` ${job.document.number}` : ''} handed to ${hostLabel(target)} via ${handed.handed.via} (${png.length} bytes)`);
    // A cash sale's receipt there: its drawer, as remotePrintDrawer says (§9ב) — the sale's own, never a copy.
    if (page.saleId && (page.cashAgorot ?? 0) > 0 && !page.copy && !this.drawerDone.has(page.saleId)) {
      this.drawerDone.add(page.saleId);
      while (this.drawerDone.size > 50) this.drawerDone.delete(this.drawerDone.values().next().value as string);
      try {
        this.o.remoteAfterCash?.(target, page);
      } catch (e) {
        this.c.log(`remote print: the drawer there — ${String(e)}`);
      }
    }
    const outcome = await flow.follow(handed.handed, target, s, startedAt, here).catch((e: unknown) => {
      this.c.log(`remote print: following ${job.id}: ${String(e)}`);
      return 'not_printed' as const;
    });
    this.c.log(`remote print: ${job.id} at ${hostLabel(target)}: ${outcome}`);
    return outcome;
  }

  /** The page as this till draws it, at [widthDots] (its content centred, as the local receipt is). */
  private async draw(doc: PrintDoc, widthDots: number): Promise<MonoBitmap> {
    if (this.o.draw) return this.o.draw(doc, widthDots);
    const renderer = this.c.svc.printQueue.pageRenderer;
    if (!renderer) throw new Error('no renderer');
    const page = await renderer(doc, receiptContentWidth(widthDots));
    return centreOn(trimBottom(toMono(page.rgba, page.width, page.height), 24), widthDots);
  }

  /* ------------------------------------------------------------------ what the employee sees */

  private say(text: string, tone: 'info' | 'error' | 'ok') {
    void this.c.later(() => {
      this.c.toast(text, tone);
      this.c.changed();
    });
  }

  sent(host: string) {
    this.say(REMOTE_DOC_TEXT.sent(host), 'info');
  }

  printed(host: string) {
    this.say(REMOTE_DOC_TEXT.printed(host), 'ok');
  }

  printedHere(host: string) {
    this.say(REMOTE_DOC_TEXT.printedHere(host), 'info');
  }

  failed(host: string, reason: string | null) {
    this.say(REMOTE_DOC_TEXT.failed(host, REMOTE_DOC_TEXT.why(reason)), 'error');
  }

  /** "לא הודפס ב<קופה> — להדפיס כאן?" — "הדפס כאן" / "לא"; unanswered in a minute, a no. */
  askPrintHere(host: string, reason: string | null): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const giveUp = () => {
        this.failed(host, reason);
        resolve(false);
      };
      this.whenNoDialog(() => {
        // Nobody signed in at this till: nobody to ask — not printed here, said.
        if (!this.c.operator()) {
          giveUp();
          return;
        }
        this.c.ask({
          kind: 'confirm',
          title: REMOTE_DOC_TEXT.askTitle(host),
          body: REMOTE_DOC_TEXT.why(reason),
          fields: [],
          actions: [
            { id: 'here', label: REMOTE_DOC_TEXT.askYes, primary: true },
            { id: 'no', label: REMOTE_DOC_TEXT.askNo },
          ],
          onAction: (action) => resolve(action === 'here'),
          onCancel: () => resolve(false),
          expiresInMs: ANSWER_TIMEOUT_MS,
          onTimeout: () => resolve(false),
        });
      }, giveUp);
    });
  }

  /* ------------------------------------------------------------------ the transport */

  /** LAN first (the host's print port, the shop's print secret), then the cloud relay — by the same id. */
  private cloudAndLan(): RemoteDocumentTransport {
    const svc = this.c.svc;
    const machine = () => svc.machineId;
    const caller = () => {
      const m = svc.machineId;
      return m ? { id: m, name: svc.cloud.machine()?.machineName ?? null } : null;
    };
    const lanOf = (target: RemoteHost): { address: string; port: number; secret: string } | null => {
      const config = svc.kitchen.config();
      const secret = config.printSecret;
      if (!secret || !svc.kitchen.lanReachable()) return null;
      const printer: KitchenPrinter | null = target.printerId ? (config.printers.find((p) => p.id === target.printerId) ?? null) : null;
      const via = printer ? lanTargetOf(printer, config.printHost) : null;
      if (via) return { ...via, secret };
      if (target.lanAddress && config.printHost?.offLan !== true) return { address: target.lanAddress, port: target.lanPort ?? DEFAULT_LAN_PORT, secret };
      return null;
    };
    const endpoints = new Map<string, { address: string; port: number; secret: string }>();
    const detailCode = (body: unknown, status: number): string => {
      const d = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : null;
      if (d && typeof d === 'object' && typeof (d as { code?: unknown }).code === 'string') return (d as { code: string }).code;
      if (typeof d === 'string' && d) return d;
      return `HTTP ${status}`;
    };
    return {
      handOver: async (target: RemoteHost, job: DocumentJob): Promise<RemoteHandOver> => {
        const lan = lanOf(target);
        if (lan) {
          const printer = target.printerId ? (svc.kitchen.config().printers.find((p) => p.id === target.printerId) ?? null) : null;
          const timeoutSec = remoteDocSettingsOf(svc.cloud.parameters()).timeoutSec;
          const name = svc.cloud.machine()?.machineName ?? null;
          const body = { ...job, ...(printer ? { printer } : {}), document: { ...job.document, ...(name ? { sourceName: name } : {}), timeoutSec } };
          try {
            const reply = await this.lan(lan, lan.secret, 'POST', '/kitchen/jobs', body, { caller: caller(), connectMs: LAN_CONNECT_MS, readMs: LAN_READ_MS });
            if (reply.status >= 200 && reply.status < 300) {
              endpoints.set(job.id, lan);
              return { id: job.id, via: 'lan', endpoint: { address: lan.address, port: lan.port } };
            }
            this.c.log(`remote print: ${hostLabel(target)} answered HTTP ${reply.status} on the LAN — via the cloud`);
          } catch (e) {
            this.c.log(`remote print: ${hostLabel(target)} not reached on the LAN (${e instanceof Error ? e.message : String(e)}) — via the cloud`);
          }
        }
        const m = machine();
        if (!m) throw new Error('not paired');
        const r = await svc.api.post(`sync/${m}/print-jobs`, job, { timeoutMs: 15_000 });
        if (r.kind === 'ok') return { id: job.id, via: 'cloud' };
        if (r.kind === 'offline') throw new Error(`cloud offline: ${r.reason}`);
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new RemotePrintFailed(detailCode(r.body, r.status));
        throw new Error(`document HTTP ${r.status}`);
      },
      state: async (handed: RemoteHandOver): Promise<RemoteJobState> => {
        if (handed.via === 'lan') {
          const lan = endpoints.get(handed.id);
          if (!lan) return { kind: 'waiting' };
          const reply = await this.lan(lan, lan.secret, 'GET', `/kitchen/jobs/status?ids=${encodeURIComponent(handed.id)}`, null, { caller: caller(), connectMs: LAN_CONNECT_MS, readMs: 4_000 });
          if (reply.status !== 200) return { kind: 'waiting' };
          const j = jobsOf(reply.body).find((x) => x.id === handed.id);
          return remoteJobStateOf(j?.status ?? null, j?.error ?? null, true);
        }
        const m = machine();
        if (!m) return { kind: 'waiting' };
        const r = await svc.api.get(`sync/${m}/print-jobs/status?ids=${encodeURIComponent(handed.id)}`, { timeoutMs: 8_000 });
        if (r.kind !== 'ok') return { kind: 'waiting' };
        const j = jobsOf(r.body).find((x) => x.id === handed.id);
        return remoteJobStateOf(j?.status ?? null, j?.error ?? null, false);
      },
      withdraw: async (handed: RemoteHandOver): Promise<boolean> => {
        if (handed.via === 'lan') {
          const lan = endpoints.get(handed.id);
          if (!lan) return false;
          const reply = await this.lan(lan, lan.secret, 'POST', `/kitchen/jobs/cancel?ids=${encodeURIComponent(handed.id)}`, {}, { caller: caller(), connectMs: LAN_CONNECT_MS, readMs: 4_000 });
          if (reply.status !== 200) return false;
          const j = jobsOf(reply.body).find((x) => x.id === handed.id);
          return !!j && j.status === 'failed' && j.error === 'cancelled';
        }
        const m = machine();
        if (!m) return false;
        const r = await svc.api.post(`sync/${m}/print-jobs/${encodeURIComponent(handed.id)}/cancel`, {}, { timeoutMs: 8_000 });
        return r.kind === 'ok' && !!r.body && typeof r.body === 'object' && (r.body as { cancelled?: unknown }).cancelled === true;
      },
    };
  }
}

/** `{jobs: [{id, status, error}]}` — the host's and the cloud's status answers alike. */
function jobsOf(body: unknown): Array<{ id: string; status: string | null; error: string | null }> {
  const jobs = body && typeof body === 'object' ? (body as { jobs?: unknown }).jobs : null;
  if (!Array.isArray(jobs)) return [];
  return jobs
    .filter((j): j is Record<string, unknown> => !!j && typeof j === 'object')
    .map((j) => ({ id: String(j.id ?? ''), status: typeof j.status === 'string' ? j.status : null, error: typeof j.error === 'string' ? j.error : null }));
}
