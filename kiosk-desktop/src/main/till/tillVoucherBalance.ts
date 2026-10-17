/**
 * "בירור יתרת שובר" on the Windows till (core/till/voucherBalance.ts — the Android VoucherBalanceScreen): any signed-in
 * cashier, shift open or not, scans or types a voucher and sees what is left on it. Read only: the cloud's lookup
 * (`POST sync/{m}/prepaid-vouchers/lookup`, the payment's own call — lib/kioskVoucherClient.ts lookupVoucher) — never a hold,
 * a redemption, or the LAN host's copy (Android says it cannot check without the cloud, and so does this).
 */

import { lookupVoucher, type VoucherPost } from '@dash-lib/kioskVoucherClient';
import { refusalOf } from '../../core/cash/credit';
import { VOUCHER_FEATURES, voucherLogTail } from '../../core/till/vouchers';
import {
  VOUCHER_BALANCE_TEXT,
  balanceCodeOf,
  localStamp,
  voucherBalanceCard,
  voucherBalanceCheckEnabled,
  voucherBalanceRefusalText,
  type StampFormat,
  type VoucherBalanceAnswer,
  type VoucherBalanceState,
} from '../../core/till/voucherBalance';
import type { TillContext, TillFeature } from './tillContext';

export const VOUCHER_BALANCE_OPS = ['voucherBalance.open', 'voucherBalance.close', 'voucherBalance.lookup', 'voucherBalance.again'] as const;

export interface TillVoucherBalanceDeps {
  /** The cloud's voucher calls (tests answer them); absent — this till's cloud, as the payment's vouchers call it. */
  post?: VoucherPost;
  /** An ISO stamp as the till shows it (the till's own time zone). */
  format?: StampFormat;
}

export class TillVoucherBalance implements TillFeature {
  readonly key = 'voucherBalance';
  readonly ops: readonly string[] = VOUCHER_BALANCE_OPS;
  /** Nothing here changes a sale, a document or the voucher: a lookup sent twice is the same answer. */
  readonly mutating: readonly string[] = [];

  private open = false;
  private busy = false;
  private error: string | null = null;
  private answer: VoucherBalanceAnswer | null = null;
  /** The lookup on screen: an answer for an earlier one (closed, "בדיקת שובר נוסף") is dropped. */
  private seq = 0;
  /** The lookup in flight (the tests wait for it; never sent to a screen). */
  last: Promise<void> | null = null;
  private readonly post: VoucherPost;
  private readonly format: StampFormat;

  constructor(
    private readonly c: TillContext,
    deps: TillVoucherBalanceDeps = {},
  ) {
    this.format = deps.format ?? localStamp;
    this.post =
      deps.post ??
      (async (path, body, timeoutMs) => {
        const m = c.svc.machineId;
        if (!m) return { kind: 'offline' };
        const r = await c.svc.api.post<Record<string, unknown>>(`sync/${m}/${path}`, body, { timeoutMs });
        if (r.kind === 'ok') return { kind: 'ok', body: (r.body && typeof r.body === 'object' ? r.body : {}) as never };
        if (r.kind === 'refused') {
          const ref = refusalOf(r.body);
          const code = ref.code ?? (ref.message && /^[a-z_]+$/.test(ref.message) ? ref.message : null);
          return { kind: 'refused', status: r.status, body: { detail: code, message: code === ref.message ? null : ref.message }, detail: code };
        }
        return { kind: 'offline' };
      });
  }

  private param(key: string): unknown {
    return this.c.svc.cloud.parameters()[key] ?? this.c.svc.settingsMap()[key];
  }

  /** The menu's row: the cloud switched it on (`voucherBalanceCheckEnabled`). */
  enabled(): boolean {
    return voucherBalanceCheckEnabled({ voucherBalanceCheckEnabled: this.param('voucherBalanceCheckEnabled') });
  }

  state(): VoucherBalanceState | undefined {
    if (!this.c.operator()) return undefined;
    const enabled = this.enabled();
    if (!enabled && !this.open) return undefined;
    return { enabled, open: this.open, busy: this.busy, error: this.error, answer: this.answer };
  }

  apply(op: string, args: Record<string, unknown>): unknown {
    switch (op) {
      case 'voucherBalance.open':
        this.c.signedIn();
        if (!this.enabled()) return this.c.refuse('invalid_args');
        this.reset();
        this.open = true;
        return undefined;
      case 'voucherBalance.close':
        this.reset();
        this.open = false;
        return undefined;
      case 'voucherBalance.again':
        this.c.signedIn();
        this.reset();
        return undefined;
      case 'voucherBalance.lookup':
        return this.lookup(args.code, args.typed);
    }
    return this.c.refuse('unknown_op');
  }

  stop(): void {
    this.seq += 1;
  }

  private reset() {
    this.seq += 1;
    this.busy = false;
    this.error = null;
    this.answer = null;
  }

  /** "בדוק שובר" (typed) or a scan: the code checked here, the lookup in the background — the op answers at once. */
  private lookup(raw: unknown, typed: unknown): { started: true } | undefined {
    this.c.signedIn();
    if (!this.open) return this.c.refuse('invalid_args');
    if (typeof raw !== 'string' || raw.length > 120 || (typed !== undefined && typeof typed !== 'boolean')) return this.c.refuse('invalid_args');
    if (this.busy) return undefined;
    const read = balanceCodeOf(raw, typed !== false);
    if ('error' in read) {
      this.error = read.error;
      return undefined;
    }
    const code = read.code;
    this.seq += 1;
    const mine = this.seq;
    this.busy = true;
    this.error = null;
    this.answer = null;
    this.c.log(`voucher: balance check ${voucherLogTail(code)}`);
    this.last = this.ask(code)
      .catch((e: unknown): VoucherBalanceAnswer => {
        this.c.log(`voucher: balance check failed (${String(e)})`);
        return { kind: 'refused', text: VOUCHER_BALANCE_TEXT.reasonOther };
      })
      .then((answer) =>
        this.c.later(() => {
          // The spinner always ends — unless another lookup (or the close) took its place.
          if (mine !== this.seq) return;
          this.busy = false;
          this.answer = answer;
          this.c.changed();
        }),
      );
    return { started: true };
  }

  private async ask(code: string): Promise<VoucherBalanceAnswer> {
    const r = await lookupVoucher(this.post, code, { features: [...VOUCHER_FEATURES] });
    if (r.kind === 'offline') return { kind: 'offline', text: VOUCHER_BALANCE_TEXT.offline };
    if (r.kind === 'refused') return { kind: 'refused', text: voucherBalanceRefusalText(r.reason, (r as { message?: string }).message ?? null) };
    return { kind: 'found', code, card: voucherBalanceCard(r.dto, this.format) };
  }
}
