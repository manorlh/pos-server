/**
 * "דוחות Z" from the cloud on the Windows till (core/till/cloudZ.ts has the rules; pos-android ui/reports/CloudZScreen.kt
 * `CloudZViewModel`): opened behind "דוחות בקופה" (VIEW_REPORTS — the engine's gate: allowed, a manager's code, or no),
 * the shop's Zs listed from the cloud, each printed as the cloud lays it out — its summary, a till's detail, every till's
 * detail apart (a cancel between them), or the ticked ones in a sequence. The cloud calls are made in the engine's `later`
 * one document at a time, so "ביטול" gets in between two of them as on Android.
 *
 * Electron-free; the printing is a dependency (the tests, and the engine's choice of where a report prints).
 */

import type { ZDoc } from '../../core/printDocs';
import {
  CLOUD_Z_LIMIT,
  CLOUD_Z_PERMISSION,
  CLOUD_Z_SUMMARY,
  CLOUD_Z_TEXT,
  cloudPrintDocumentOf,
  cloudZListOf,
  cloudZPaper,
  cloudZView,
  failedPaymentsOnCloudPaper,
  printDocumentPath,
  printSequenceMessage,
  sequenceOrder,
  tillLabel,
  tillsInOrder,
  type CloudZItem,
  type CloudZState,
  type CloudZTill,
} from '../../core/till/cloudZ';
import type { TillContext, TillFeature } from './tillContext';

export const CLOUD_Z_OPS = [
  'cloudZ.open',
  'cloudZ.close',
  'cloudZ.toggle',
  'cloudZ.selectAll',
  'cloudZ.print',
  'cloudZ.printSequence',
  'cloudZ.printSummary',
  'cloudZ.printTills',
  'cloudZ.dismissChoice',
  'cloudZ.cancelTills',
] as const;

export const CLOUD_Z_MUTATING = ['cloudZ.print', 'cloudZ.printSequence', 'cloudZ.printSummary', 'cloudZ.printTills'] as const;

/** A report on paper: its print job's id (null — it went elsewhere or was asked about). Throws why it did not print. */
export type CloudZPrint = (doc: ZDoc, refId: string, title: string) => string | null;

export interface TillCloudZDeps {
  /** Where this till's reports print. Default: the till's own receipt printer (its print queue); none set — "אין מדפסת…". */
  print?: CloudZPrint;
}

class NotPrinted extends Error {}

export class TillCloudZ implements TillFeature {
  readonly key = 'cloudZ';
  readonly ops = CLOUD_Z_OPS;
  readonly mutating = CLOUD_Z_MUTATING;

  /** Who opened it (through the gate): the screen is theirs; another operator sees nothing until they open it. */
  private openedBy: string | null = null;
  private loading = false;
  private loaded = false;
  private unsupported = false;
  private items: CloudZItem[] = [];
  private message: string | null = null;
  private selected = new Set<string>();
  private printingId: string | null = null;
  private sequenceProgress: string | null = null;
  private choosingFor: CloudZItem | null = null;
  private tillProgress: string | null = null;
  private tillProgressDetail: string | null = null;
  private cancelling = false;
  private cancelRequested = false;
  /** A load's ticket: an older answer never overwrites a newer one (or a close). */
  private generation = 0;

  constructor(
    private readonly c: TillContext,
    private readonly deps: TillCloudZDeps = {},
  ) {}

  /** An older cloud answered 404 for the list: the menu row should not be offered (never a dead button). */
  available(): boolean {
    return !this.unsupported;
  }

  state(): CloudZState | undefined {
    const op = this.c.operator();
    if (!op || this.openedBy !== op.id) return undefined;
    return cloudZView({
      loading: this.loading,
      loaded: this.loaded,
      unsupported: this.unsupported,
      items: this.items,
      message: this.message,
      selected: this.selected,
      printingId: this.printingId,
      sequenceProgress: this.sequenceProgress,
      choosingFor: this.choosingFor,
      tillProgress: this.tillProgress,
      tillProgressDetail: this.tillProgressDetail,
      cancelling: this.cancelling,
    });
  }

  stop(): void {
    this.cancelRequested = true;
    this.generation += 1;
  }

  apply(op: string, a: Record<string, unknown>): unknown {
    switch (op) {
      case 'cloudZ.open':
        return this.open();
      case 'cloudZ.close':
        this.close();
        return undefined;
      case 'cloudZ.toggle':
        return this.toggle(this.idArg(a));
      case 'cloudZ.selectAll':
        this.mine();
        this.selected = this.selected.size === this.items.length ? new Set() : new Set(this.items.map((z) => z.id));
        return undefined;
      case 'cloudZ.print':
        return this.print(this.item(this.idArg(a)));
      case 'cloudZ.printSequence':
        return this.printSequence();
      case 'cloudZ.printSummary':
        return this.printSummary(this.item(this.idArg(a)));
      case 'cloudZ.printTills': {
        const z = this.item(this.idArg(a));
        const all = tillsInOrder(z.tills ?? []);
        let tills: CloudZTill[] = all;
        if (a.machineIds !== undefined) {
          if (!Array.isArray(a.machineIds) || a.machineIds.some((x) => typeof x !== 'string')) return this.c.refuse('invalid_args');
          const ids = new Set(a.machineIds as string[]);
          tills = all.filter((t) => ids.has(t.machineId));
          if (tills.length !== ids.size) return this.c.refuse('invalid_args');
        }
        return this.printTills(z, tills);
      }
      case 'cloudZ.dismissChoice':
        this.mine();
        this.choosingFor = null;
        return undefined;
      case 'cloudZ.cancelTills':
        this.mine();
        if (this.tillProgress === null) return undefined;
        this.cancelRequested = true;
        this.cancelling = true;
        return undefined;
      default:
        return this.c.refuse('unknown_op');
    }
  }

  /* ------------------------------------------------------------------ opening */

  /** "דוחות Z": through "דוחות בקופה", then the list from the cloud (asked afresh on every visit, as Android). */
  private open(): unknown {
    const user = this.c.signedIn();
    return this.c.gate(
      CLOUD_Z_PERMISSION,
      () => {
        if (this.openedBy !== user.id) this.reset();
        this.openedBy = user.id;
        this.load();
        return undefined;
      },
      { body: CLOUD_Z_TEXT.title },
    );
  }

  private close() {
    this.openedBy = null;
    this.reset();
  }

  private reset() {
    this.generation += 1;
    this.cancelRequested = true;
    this.loading = false;
    this.loaded = false;
    this.items = [];
    this.message = null;
    this.selected = new Set();
    this.printingId = null;
    this.sequenceProgress = null;
    this.choosingFor = null;
    this.tillProgress = null;
    this.tillProgressDetail = null;
    this.cancelling = false;
  }

  private load() {
    const m = this.c.svc.machineId;
    this.loading = true;
    this.message = null;
    const gen = ++this.generation;
    void this.c
      .later(async () => {
        const r = m ? await this.c.svc.api.get(`sync/${m}/z-reports?limit=${CLOUD_Z_LIMIT}&offset=0`, { timeoutMs: 20_000 }) : ({ kind: 'offline' } as const);
        if (gen !== this.generation) return;
        this.loading = false;
        this.loaded = true;
        if (r.kind === 'ok') {
          this.unsupported = false;
          this.items = cloudZListOf(r.body).items;
          // Ticks of Zs no longer listed go.
          this.selected = new Set([...this.selected].filter((id) => this.items.some((z) => z.id === id)));
          this.message = null;
        } else {
          // A cloud without the route: the row goes (core/till/cloudZ.ts — never a dead button); the screen says why.
          if (r.kind === 'refused' && r.status === 404) this.unsupported = true;
          this.items = [];
          this.selected = new Set();
          this.message = CLOUD_Z_TEXT.unavailable;
        }
        this.c.changed();
      })
      .catch((e: unknown) => {
        this.c.log(`cloud Z list: ${String(e)}`);
        if (gen !== this.generation) return;
        this.loading = false;
        this.loaded = true;
        this.message = CLOUD_Z_TEXT.unavailable;
        this.c.changed();
      });
  }

  /* ------------------------------------------------------------------ choosing */

  /** The screen is the operator's (opened through the gate). */
  private mine() {
    const user = this.c.signedIn();
    if (this.openedBy !== user.id) return this.c.refuse('permission_denied');
    return user;
  }

  private idArg(a: Record<string, unknown>): string {
    const id = a.id;
    if (typeof id !== 'string' || !id.trim()) return this.c.refuse('invalid_args');
    return id;
  }

  private item(id: string): CloudZItem {
    this.mine();
    const z = this.items.find((x) => x.id === id);
    if (!z) return this.c.refuse('invalid_args');
    return z;
  }

  private toggle(id: string) {
    this.item(id);
    if (this.printingId !== null) return undefined;
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.selected = new Set(this.selected);
    return undefined;
  }

  private get busy(): boolean {
    return this.printingId !== null || this.tillProgress !== null;
  }

  /* ------------------------------------------------------------------ printing */

  /** One document: fetched from the cloud, the failed payments off the paper by the parameter, printed. Null — printed. */
  private async printDocument(z: CloudZItem, part: string | null, till: string | null): Promise<string | null> {
    const m = this.c.svc.machineId;
    if (!m) return CLOUD_Z_TEXT.failedOther(CLOUD_Z_TEXT.offline);
    const r = await this.c.svc.api.get(printDocumentPath(m, z.id, { part, till }), { timeoutMs: 30_000 });
    if (r.kind === 'offline') return CLOUD_Z_TEXT.failedOther(CLOUD_Z_TEXT.offline);
    if (r.kind === 'refused') return CLOUD_Z_TEXT.failedOther(`HTTP ${r.status}`);
    const doc = cloudPrintDocumentOf(r.body);
    if (!doc) return CLOUD_Z_TEXT.failedOther(CLOUD_Z_TEXT.unavailable);
    const svc = this.c.svc;
    const paper = cloudZPaper(failedPaymentsOnCloudPaper(svc.cloud.parameters(), doc), (svc.settingsMap().brandReceiptLogoUrl as string | null | undefined) ?? null);
    const refId = `cloudz:${z.id}:${part ?? till ?? 'all'}:${this.c.now()}`;
    const title = [doc.title, doc.number !== null ? `#${doc.number}` : null].filter(Boolean).join(' ') || CLOUD_Z_TEXT.number(z.number ?? 0);
    try {
      this.printer()(paper, refId, title);
      return null;
    } catch (e) {
      return e instanceof NotPrinted ? e.message : CLOUD_Z_TEXT.failedOther(e instanceof Error ? e.message : String(e));
    }
  }

  private printer(): CloudZPrint {
    if (this.deps.print) return this.deps.print;
    const svc = this.c.svc;
    return (doc, refId) => {
      if (!svc.hasOwnReceiptPrinter()) throw new NotPrinted(CLOUD_Z_TEXT.noPrinter);
      return svc.printQueue.enqueue('z', refId, doc);
    };
  }

  /** printOne: the Z (or its part) printed; the message says it when it did not. True — printed. */
  private async printOne(z: CloudZItem, part: string | null, till: string | null = null): Promise<boolean> {
    const gen = this.generation;
    const why = await this.c.later(async () => {
      if (gen !== this.generation) return null;
      this.printingId = z.id;
      this.message = null;
      this.c.changed();
      return this.printDocument(z, part, till);
    });
    if (gen !== this.generation) return false;
    await this.c.later(() => {
      this.printingId = null;
      this.message = why === null ? null : CLOUD_Z_TEXT.notPrinted(why);
      this.c.changed();
    });
    return why === null;
  }

  /** "הדפס": a shop Z over tills asks what to print; one without the tills listed prints whole. */
  private print(z: CloudZItem) {
    if (this.busy) return undefined;
    if (z.tills && z.tills.length > 0) {
      this.choosingFor = z;
      return undefined;
    }
    void this.printOne(z, null)
      .then((ok) => {
        if (!ok) return;
        return this.c.later(() => {
          this.message = CLOUD_Z_TEXT.printed(z.number ?? 0);
          this.c.changed();
        });
      })
      .catch((e: unknown) => this.c.log(`cloud Z print: ${String(e)}`));
    return undefined;
  }

  private printSummary(z: CloudZItem) {
    this.choosingFor = null;
    if (this.busy) return undefined;
    void this.printOne(z, CLOUD_Z_SUMMARY)
      .then((ok) => {
        if (!ok) return;
        return this.c.later(() => {
          this.message = CLOUD_Z_TEXT.printed(z.number ?? 0);
          this.c.changed();
        });
      })
      .catch((e: unknown) => this.c.log(`cloud Z summary: ${String(e)}`));
    return undefined;
  }

  /** "הדפס רצף": the ticked Zs one after another, in Z-number order — each its own print; a failure stops the rest. */
  private printSequence() {
    this.mine();
    if (this.busy || this.selected.size === 0) return undefined;
    const chosen = sequenceOrder(this.items, this.selected);
    const gen = this.generation;
    void (async () => {
      let printed = 0;
      for (let i = 0; i < chosen.length; i++) {
        if (gen !== this.generation) return;
        const z = chosen[i];
        await this.c.later(() => {
          this.sequenceProgress = `${i + 1}/${chosen.length}`;
          this.c.changed();
        });
        if (await this.printOne(z, z.tills && z.tills.length > 0 ? CLOUD_Z_SUMMARY : null)) printed++;
        else break;
      }
      if (gen !== this.generation) return;
      await this.c.later(() => {
        // A run that stopped says why — "הודפסו 0 מתוך 2" alone tells nobody what to fix.
        const failure = printed < chosen.length ? this.message : null;
        this.sequenceProgress = null;
        if (printed === chosen.length) this.selected = new Set();
        this.message = failure ? CLOUD_Z_TEXT.sequenceFailed(printed, chosen.length, failure) : CLOUD_Z_TEXT.sequenceDone(printed, chosen.length);
        this.c.changed();
      });
    })().catch((e: unknown) => this.c.log(`cloud Z sequence: ${String(e)}`));
    return undefined;
  }

  /** These tills' details, each its own document, in till-number order; "ביטול" stops between them. */
  private printTills(z: CloudZItem, tills: CloudZTill[]) {
    if (tills.length === 0 || this.busy) return undefined;
    const ordered = tillsInOrder(tills);
    this.cancelRequested = false;
    this.cancelling = false;
    this.choosingFor = null;
    this.printingId = z.id;
    this.message = null;
    const gen = this.generation;
    void (async () => {
      let printed = 0;
      let error: string | null = null;
      let cancelled = false;
      for (let i = 0; i < ordered.length; i++) {
        if (gen !== this.generation) return;
        if (this.cancelRequested) {
          cancelled = true;
          break;
        }
        const till = ordered[i];
        const why = await this.c.later(async () => {
          this.tillProgress = CLOUD_Z_TEXT.printingTill(i + 1, ordered.length);
          this.tillProgressDetail = tillLabel(till);
          this.c.changed();
          return this.printDocument(z, null, till.machineId);
        });
        if (why !== null) {
          error = why;
          break;
        }
        printed++;
      }
      if (gen !== this.generation) return;
      await this.c.later(() => {
        this.printingId = null;
        this.tillProgress = null;
        this.tillProgressDetail = null;
        this.cancelling = false;
        this.cancelRequested = false;
        this.message = printSequenceMessage({ printed, total: ordered.length, cancelled, error });
        this.c.changed();
      });
    })().catch((e: unknown) => this.c.log(`cloud Z tills: ${String(e)}`));
    return undefined;
  }
}
