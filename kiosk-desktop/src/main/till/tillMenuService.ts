/**
 * The ☰ menu's own engine work on the Windows till (core/till/tillMenu.ts builds the rows; P:/specs/windows-till-menu-parity.md):
 *
 *  - the profile card: the role's name ("תפקידים והרשאות" — the till role's own name, else "מנהל/ת חנות" / "קופאי/ת"), the
 *    shop and the till's number, and the details a tap shows (Android `TillIdentityBlock`: company, shop, till number, its
 *    name, the version);
 *  - "סנכרון מול הענן": the same run as the background beat and pulls (SyncEngine.syncNow, the admin's "סנכרן עכשיו"), in
 *    place — how it went, when the till last synced, what still waits to go up;
 *  - "עדכון גרסה": the release the cloud assigned (the updater's view), installed on "התקן" after one confirmation (the app
 *    restarts into it) — the same install the technician's "התקן עכשיו" runs;
 *  - "תמיכה מרחוק": TeamViewer QuickSupport (core/technician.ts QUICKSUPPORT_PATHS), or the Android sentence that it is missing;
 *  - the reports folder from the till's own records (core/till/localReports.ts) and a Z's copy.
 */

import type { LocalReportKind, LocalReportView, ReportPreset, TillMenuState } from '../../shared/till/protocol';
import { docsIn, presetOf, productSalesReport, reportWindow, shiftsReport, tillZsReport, tipsReport, workerReport, type ReportDoc, type ReportShift } from '../../core/till/localReports';
import { lineNet } from '../../core/till/vouchers';
import { ofShekels } from '../../core/money';
import { xDocOf, tipMethodOf, type DocDraft } from '../fiscal/ledger';
import type { TillContext } from './tillContext';

export const MENU_SERVICE_TEXT = {
  supportMissing: 'TeamViewer QuickSupport אינו מותקן במכשיר',
  supportOpened: 'TeamViewer QuickSupport נפתח',
  updateTitle: (v: string) => `להתקין את גרסה ${v}?`,
  updateBody: 'האפליקציה תיסגר ותופעל מחדש בגרסה החדשה. עסקה פתוחה בסל לא תישמר.',
  updateInstall: 'התקן',
  updateNotReady: 'העדכון עדיין לא מוכן להתקנה — הוא יורד ברקע',
  cancel: 'ביטול',
  syncDone: 'הסנכרון הושלם',
  syncOffline: 'אין חיבור לענן',
  zCopy: (n: string) => `נשלח להדפסה: ${n} (העתק)`,
  zMissing: 'הדוח לא נמצא בקופה',
  roleManager: 'מנהל/ת חנות',
  roleCashier: 'קופאי/ת',
  company: 'חברה',
  shop: 'סניף',
  posNumber: 'מספר קופה',
  machineName: 'שם קופה',
  version: 'גרסה',
} as const;

const LAST_SYNC = 'till.menu.lastSyncAt';
const pad = (n: number) => String(n).padStart(2, '0');
/** `2026-10-17 21:04`, the local wall clock (formatLocalStamp). */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A document as the range reports read it: each line's money as booked (a credit line: what it credits). */
export function reportDocOf(d: DocDraft): ReportDoc {
  const x = xDocOf(d);
  return {
    status: d.status,
    documentType: d.documentType,
    createdAt: d.createdAt,
    cashierId: d.cashierId,
    cashierName: d.cashierName ?? null,
    lines: d.lines.map((l) => ({ productId: l.productId, name: l.name, sku: l.sku, qty: l.qty, agorot: typeof l.creditAgorot === 'number' ? l.creditAgorot : lineNet(l) })),
    payments: x.payments,
    tipAgorot: d.totals.tipAgorot ?? 0,
    tipMethod: tipMethodOf(d),
  };
}

export interface TillMenuDeps {
  /** A Z-only till (no shifts in the UI). */
  zOnly(): boolean;
  /** zMode = till. */
  tillZMode(): boolean;
  /** The open shift's figures now (net agorot, documents), for its row in "היסטוריית משמרות". */
  openShiftFigures(shiftId: string): { netAgorot: number; transactions: number } | null;
}

export class TillMenuService {
  private syncRunning = false;
  private syncError: string | null = null;
  /** The report on the screen (asked, and let through "דוחות בקופה"). */
  private current: LocalReportView | null = null;

  constructor(
    private readonly c: TillContext,
    private readonly d: TillMenuDeps,
  ) {}

  state(): TillMenuState {
    const svc = this.c.svc;
    const me = svc.cloud.machine();
    const user = this.c.operator();
    const roleName = user ? (user.tillRoleName?.trim() ? user.tillRoleName.trim() : user.role.trim().toLowerCase() === 'shop_manager' ? MENU_SERVICE_TEXT.roleManager : MENU_SERVICE_TEXT.roleCashier) : null;
    const identity: Array<{ label: string; value: string } | null> = [
      me?.companyName ? { label: MENU_SERVICE_TEXT.company, value: me.companyName } : null,
      me?.shopName ? { label: MENU_SERVICE_TEXT.shop, value: me.shopName } : null,
      me?.posNumber ? { label: MENU_SERVICE_TEXT.posNumber, value: String(me.posNumber) } : null,
      me?.machineName ? { label: MENU_SERVICE_TEXT.machineName, value: me.machineName } : null,
      { label: MENU_SERVICE_TEXT.version, value: svc.appVersion },
    ];
    const lastOk = svc.sync.status.lastBeatOkAt ?? (Number(svc.kv.get(LAST_SYNC)) || null);
    const u = svc.updateView();
    const update: TillMenuState['update'] =
      u && u.available && u.available !== u.current
        ? {
            version: u.available,
            phase: u.phase === 'ready' ? 'ready' : u.phase === 'installing' ? 'installing' : u.phase === 'downloading' ? 'downloading' : u.phase === 'failed' ? 'failed' : 'available',
            message: u.message,
          }
        : null;
    return {
      roleName,
      shopName: me?.shopName ?? null,
      posNumber: me?.posNumber ? String(me.posNumber) : null,
      identity: identity.filter((x): x is { label: string; value: string } => x !== null),
      sync: { running: this.syncRunning, lastAt: lastOk ? localStamp(lastOk) : null, error: this.syncError, waiting: svc.outbox.count() },
      update,
      showTillZHistory: this.d.tillZMode() || svc.tillZ.list(1).length > 0,
      support: true,
      report: this.current,
    };
  }

  /** "סנכרון מול הענן": in place, the menu left open; the row says how it went. */
  sync(): void {
    this.c.signedIn();
    if (this.syncRunning) return;
    this.syncRunning = true;
    this.syncError = null;
    this.c.changed();
    const svc = this.c.svc;
    void (async () => {
      try {
        await svc.sync.syncNow();
        await svc.syncMedia().catch(() => undefined);
        if (svc.isOffline) this.syncError = MENU_SERVICE_TEXT.syncOffline;
        else {
          svc.kv.set(LAST_SYNC, String(this.c.now()));
          this.syncError = null;
        }
      } catch (e) {
        this.syncError = e instanceof Error ? e.message : String(e);
      } finally {
        this.syncRunning = false;
        this.c.changed();
      }
    })();
  }

  /** "עדכון גרסה": ready — "להתקין את גרסה …?", then the install (the app restarts); not yet — said so. */
  update(): unknown {
    this.c.signedIn();
    const u = this.c.svc.updateView();
    if (!u || !u.available) return undefined;
    if (u.phase !== 'ready') {
      this.c.toast(MENU_SERVICE_TEXT.updateNotReady, 'info');
      return undefined;
    }
    if (this.c.paying()) return undefined;
    return this.c.ask({
      kind: 'confirm',
      title: MENU_SERVICE_TEXT.updateTitle(u.available),
      body: MENU_SERVICE_TEXT.updateBody,
      fields: [],
      actions: [
        { id: 'approve', label: MENU_SERVICE_TEXT.updateInstall, primary: true },
        { id: 'cancel', label: MENU_SERVICE_TEXT.cancel },
      ],
      resume: () =>
        void this.c.svc.installUpdate().then((r) => {
          if (!r.ok && r.message) this.c.toast(r.message, 'error');
        }),
    });
  }

  /** "תמיכה מרחוק": QuickSupport opened, or the sentence that it is not installed. */
  async support(): Promise<void> {
    this.c.signedIn();
    const launched = await this.c.svc.launchQuickSupport().catch(() => null);
    this.c.toast(launched ? MENU_SERVICE_TEXT.supportOpened : MENU_SERVICE_TEXT.supportMissing, launched ? 'ok' : 'error');
  }

  /** A new report is asked: the last one is off the screen until this one is let through. */
  clearReport(): void {
    this.current = null;
  }

  /** The report asked, built now and put in the state (the screen draws it). */
  open(kind: LocalReportKind, presetRaw: unknown): LocalReportView {
    this.current = this.report(kind, presetRaw);
    this.c.changed();
    return this.current;
  }

  /** A report of the "דוחות" folder, from the till's own records. */
  report(kind: LocalReportKind, presetRaw: unknown): LocalReportView {
    this.c.signedIn();
    const svc = this.c.svc;
    if (kind === 'shifts') {
      const rows: ReportShift[] = svc.ledger.recentShifts(60).map((s) => {
        let net: number | null = null;
        let tx: number | null = null;
        if (s.status === 'open') {
          const f = this.d.openShiftFigures(s.id);
          net = f?.netAgorot ?? null;
          tx = f?.transactions ?? null;
        } else if (s.close_payload) {
          try {
            const till = (JSON.parse(s.close_payload) as { till?: Record<string, unknown> }).till ?? null;
            if (till) {
              const n = (k: string) => (typeof till[k] === 'number' ? (till[k] as number) : 0);
              net = ofShekels(n('totalSales') - n('totalDiscounts') - n('totalRefunds'));
              tx = typeof till.transactionsCount === 'number' ? (till.transactionsCount as number) : null;
            }
          } catch {
            /* an unreadable close: no figures */
          }
        }
        return {
          number: s.sequence_number,
          businessDate: s.business_date,
          openedAt: s.opened_at,
          closedAt: s.closed_at,
          openedByName: s.opened_by_name,
          status: s.status,
          zNumber: s.z_number,
          inZ: !!s.z_report_id,
          netAgorot: net,
          transactions: tx,
        };
      });
      return shiftsReport(rows, this.d.zOnly());
    }
    if (kind === 'tillZs') return tillZsReport(svc.tillZ.list(60));
    const preset: ReportPreset = presetOf(presetRaw);
    const w = reportWindow(preset, new Date(this.c.now()));
    const docs = docsIn(svc.ledger.docsBetween(w.from.toISOString(), w.to.toISOString()).map(reportDocOf), w.from, w.to);
    if (kind === 'products') return productSalesReport(docs, preset, w.label);
    if (kind === 'workers') return workerReport(docs, preset, w.label);
    return tipsReport(docs, preset, w.label);
  }

  /** "הדפס שוב" on a Z of "דוחות Z": a copy. */
  reprintZ(id: string): void {
    this.c.signedIn();
    const z = this.c.svc.tillZ.list(200).find((x) => x.id === id);
    if (!z || !this.c.svc.reprintTillZ(id)) return this.c.refuse('invalid_args', MENU_SERVICE_TEXT.zMissing);
    this.c.toast(MENU_SERVICE_TEXT.zCopy(`Z ${z.number}`), 'ok');
  }
}
