/**
 * "תור הדפסה" and "מדפסת חלופית" on the Windows till (pos-android ui/kitchen/PrinterFailoverHost.kt, KitchenPrintBanner.kt,
 * PrintQueueScreen.kt; core/kitchen/failover.ts): the kitchen tickets that need a person, from the device's kitchen queue
 * (main/kitchen/kitchenService.ts):
 *
 *  - the red strip over the sell screen ("בון לא הודפס במדפסת מטבח — …") and the queue screen (per ticket: "הדפס שוב",
 *    "העבר למדפסת אחרת", "סמן כטופל" with a manager's code), the redirects in force with "בטל הפניה";
 *  - the question, where the till's `unprintedBonAlert` is on and `printerFailoverPrompt` is not off (Android's gate): the
 *    oldest ticket first, "לשלוח את הבון ל…" each printer this till reaches with its light, "לשלוח לשם גם את הבאים (15 דק׳)",
 *    "נסה שוב", "השאר בתור" — never over another question or a payment.
 *
 * Electron-free.
 */

import { BON_ALERT_PARAM, FAILOVER_PARAM, FAILOVER_TEXT, bonAlertOn, candidates, failoverEnabled, hhmm, mayRedirect, shouldAsk, ticketTitleOf, type Light } from '../../core/kitchen/failover';
import type { KitchenJob } from '../../core/kitchen/queue';
import { TILL_PRINTER_ID } from '../../core/kitchen/routing';
import type { TillContext } from './tillContext';

export interface PrintQueueView {
  /** The red strip's words (null: nothing waits for a person). */
  banner: string | null;
  count: number;
  redirects: Array<{ fromId: string; text: string }>;
}

export interface PrintQueueRow {
  id: string;
  title: string;
  printer: string;
  state: string;
  error: string | null;
  at: number;
  canMove: boolean;
}

export class TillPrintQueue {
  /** What each ticket's question was last answered at (its attempts); "השאר בתור" — never again. */
  private readonly answered = new Map<string, number>();
  private asking: string | null = null;

  constructor(private readonly c: TillContext) {}

  private kitchen() {
    return this.c.svc.kitchen;
  }

  private params() {
    return this.c.svc.cloud.parameters();
  }

  /** The tickets a person should see (test pages included in the count, as Android's strip). */
  attention(): KitchenJob[] {
    return this.kitchen().attention();
  }

  view(): PrintQueueView | undefined {
    const att = this.attention();
    const now = this.c.now();
    const redirects = this.kitchen()
      .redirects()
      .map((r) => ({ fromId: r.fromId, text: FAILOVER_TEXT.chip(r.fromName, r.toId === TILL_PRINTER_ID || r.toId === 'local' ? FAILOVER_TEXT.ownPrinter : r.toName, hhmm(r.until)) }));
    if (att.length === 0 && redirects.length === 0) return undefined;
    void now;
    return { banner: att.length === 0 ? null : att.length === 1 ? FAILOVER_TEXT.bannerOne : FAILOVER_TEXT.bannerMany(att.length), count: att.length, redirects };
  }

  /** The queue screen's rows: what needs a person, the oldest first. */
  rows(): PrintQueueRow[] {
    return this.attention()
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((j) => ({
        id: j.id,
        title: ticketTitleOf(j),
        printer: j.printerName,
        state: j.state,
        error: j.lastError,
        at: j.createdAt,
        canMove: mayRedirect(j),
      }));
  }

  /** The printers [jobId] may go to, each with its light (this till's own: its print queue's last word). */
  choices(jobId: string): Array<{ id: string; label: string }> {
    const job = this.kitchen().job(jobId);
    if (!job) return [];
    const failed = this.kitchen().printerOfJob(job);
    if (!failed) return [];
    const own = this.c.svc.hasOwnReceiptPrinter();
    const health = new Map<string, Light>();
    if (own) {
      const h = this.c.svc.printQueue.health();
      health.set(TILL_PRINTER_ID, h === 'ok' ? 'ok' : h === 'unknown' ? null : 'error');
    }
    return candidates(failed, this.kitchen().failoverPrinters(own), health).map(({ printer, light }) => ({
      id: printer.id,
      label: `${printer.id === TILL_PRINTER_ID ? FAILOVER_TEXT.ownPrinter : printer.name} · ${light === 'ok' ? FAILOVER_TEXT.light.ok : light === 'warn' ? FAILOVER_TEXT.light.warn : light === 'error' ? FAILOVER_TEXT.light.error : FAILOVER_TEXT.light.none}`,
    }));
  }

  private by() {
    const op = this.c.operator();
    return op ? { id: op.id, name: [op.firstName, op.lastName].filter(Boolean).join(' ') || op.username } : null;
  }

  /** "העבר למדפסת אחרת" / the question's printer: moved, or why not (busy, gone). */
  move(jobId: string, toId: string, alsoNext: boolean): string {
    const r = this.kitchen().moveToPrinter(jobId, toId, alsoNext, this.by());
    if (r === 'busy') return FAILOVER_TEXT.busy;
    if (r === 'gone') return FAILOVER_TEXT.noOther;
    this.answered.delete(jobId);
    const name = toId === TILL_PRINTER_ID ? FAILOVER_TEXT.ownPrinter : (this.kitchen().config().printers.find((p) => p.id === toId)?.name ?? toId);
    return FAILOVER_TEXT.moved(name);
  }

  retry(jobId: string): boolean {
    this.answered.delete(jobId);
    return this.kitchen().retry(jobId);
  }

  /** The question, when it is due: the oldest ticket it is due for, never over another question or a payment. */
  prompt(): void {
    const params = this.params();
    if (!bonAlertOn(params[BON_ALERT_PARAM]) || !failoverEnabled(params[FAILOVER_PARAM])) return;
    // A question another took the place of: asked again.
    if (this.asking && !this.c.dialogOpen?.()) this.asking = null;
    if (!this.c.operator() || this.c.paying() || this.c.dialogOpen?.() || this.asking) return;
    const job = this.attention()
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .find((j) => shouldAsk(j, true, this.answered));
    if (!job) return;
    const choices = this.choices(job.id);
    this.asking = job.id;
    const attempts = job.attempts;
    const done = () => {
      this.asking = null;
    };
    this.c.ask({
      kind: 'confirm',
      title: FAILOVER_TEXT.title(job.printerName),
      body: `${ticketTitleOf(job)} · ${FAILOVER_TEXT.error(job.lastError ?? '—')}\n${choices.length > 0 ? FAILOVER_TEXT.body : FAILOVER_TEXT.none}`,
      fields: choices.length > 0 ? [{ name: 'alsoNext', label: FAILOVER_TEXT.alsoNext, kind: 'check' }] : [],
      actions: [
        ...choices.map((ch) => ({ id: `to:${ch.id}`, label: ch.label })),
        { id: 'retry', label: FAILOVER_TEXT.retry, primary: true },
        { id: 'keep', label: FAILOVER_TEXT.keep },
      ],
      onAction: (action, answers) => {
        done();
        if (action === 'retry') {
          this.retry(job.id);
          return undefined;
        }
        if (action === 'keep') {
          this.answered.set(job.id, Number.MAX_SAFE_INTEGER);
          return undefined;
        }
        const text = this.move(job.id, action.replace(/^to:/, ''), answers.alsoNext === 'true');
        // Printing right now: asked again after its try.
        if (text === FAILOVER_TEXT.busy) this.answered.set(job.id, attempts);
        this.c.toast(text, text === FAILOVER_TEXT.busy ? 'error' : 'ok');
        return undefined;
      },
      onCancel: () => {
        done();
        this.answered.set(job.id, Number.MAX_SAFE_INTEGER);
        return undefined;
      },
    });
  }
}
