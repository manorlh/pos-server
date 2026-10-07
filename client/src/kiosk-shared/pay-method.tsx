'use client';

/**
 * "איך תרצו לשלם?" — the kiosk's payment method step and the screen after "מזומן בקופה"
 * (docs/SPEC_KIOSK.md §23), for every kiosk that draws the shared screens: the browser kiosk
 * (`/k`, components/kiosk-web) today; the Windows kiosk can take it as it is (it would offer the
 * card too — the host decides which tiles it can honour, `tiles[].off`).
 *
 * As the Android kiosk's KioskPayMethodUi.kt, in the kiosk's own look (the tip step's card, its
 * header and step bar): big tiles in the configured order — a tile the host cannot take now is
 * greyed with its reason —, the vouchers already taken with "הסרה", "נותר לתשלום ₪X", and for
 * "מזומן בקופה" a confirmation ("מזומן בקופה · ₪X") before the order goes to the tills.
 * After it, `CashAtTillDone`: "גשו לקופה לתשלום", the number big, the sum, the order's code as a QR
 * the till scans ("KO:…" — on the screen, since a browser cannot print the slip).
 *
 * Every word is a kiosk text (lib/kioskConfig.ts TEXT_KEYS: payMethodTitle, payCashLabel,
 * remainingToPay, cashDoneTitle…), editable in the dashboard; the host only adds what it alone
 * knows (why a tile is off). No Next.js, no next-intl (kiosk-shared rule).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Banknote, Check, CreditCard, Ticket, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { checkoutBar, type CheckoutStep, type KioskTextKey, type PaymentMethod } from '@/lib/kioskConfig';
import { BigButton, LiveBack, cardStyle, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { EntryHeader } from '@/components/dashboard/kiosks/preview-entry';

/** A tile on the step: `off` — why it cannot be taken now (the host's words), else null. */
export interface KioskPayTile {
  method: PaymentMethod;
  off: string | null;
}

/** A voucher already redeemed towards this order. */
export interface KioskPayVoucher {
  id: string;
  serial: number;
  amountAgorot: number;
  label?: string | null;
}

export interface KioskLivePayMethod {
  /** This order's checkout steps (the step bar). */
  steps: CheckoutStep[];
  tiles: KioskPayTile[];
  goodsAgorot: number;
  tipAgorot: number;
  vouchers: KioskPayVoucher[];
  dueAgorot: number;
  /** A tile taken: the card goes to the payment, a voucher opens its window; cash is confirmed first (here). */
  onPick: (method: PaymentMethod) => void;
  onRemoveVoucher?: (id: string) => void;
  /** A voucher being checked, the order being placed: the tiles wait. */
  busy: boolean;
  /** "השובר נקלט · ₪X" and the like. */
  note: string | null;
  error: string | null;
  /** Something the host adds under the tiles (the browser's camera button for a voucher). */
  extra?: ReactNode;
  /**
   * "רשות" (payment.stepModes.payMethod optional, lib/kioskConfig.ts payMethodAsk): the step may be
   * passed with this method ("המשך · אשראי"); absent when a choice must be made.
   */
  skip?: { method: PaymentMethod; onSkip: () => void } | null;
}

const ICONS: Record<PaymentMethod, typeof CreditCard> = { card: CreditCard, voucher: Ticket, cash_at_till: Banknote };
const LABEL: Record<PaymentMethod, KioskTextKey> = { card: 'payCardLabel', voucher: 'payVoucherLabel', cash_at_till: 'payCashLabel' };
const SUB: Record<PaymentMethod, KioskTextKey> = { card: 'payCardSub', voucher: 'payVoucherSub', cash_at_till: 'payCashSub' };

/** A kiosk text with its placeholders ("{amount}", "{number}"), the business's words first. */
export function payText(m: PreviewModel, key: KioskTextKey, values: Record<string, string | number>): string {
  if (m.kt) return m.kt(key, values);
  return m.txt(key).replace(/\{(\w+)\}/g, (s, k: string) => (values[k] === undefined ? s : String(values[k])));
}

function StepBar({ m, steps }: { m: PreviewModel; steps: CheckoutStep[] }) {
  const items = checkoutBar(steps, 'payMethod');
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 kt-11">
      {items.map((it, i) => (
        <span key={it.key} className="inline-flex items-center gap-2">
          {i > 0 ? <span aria-hidden className="h-1 w-1 rounded-full" style={{ background: `${m.c.mutedText}99` }} /> : null}
          <span className={it.state === 'current' ? 'font-extrabold' : 'font-medium'} style={{ color: it.state === 'current' ? m.c.primary : m.c.mutedText }} aria-current={it.state === 'current' ? 'step' : undefined}>
            {it.state === 'done' ? '✓ ' : ''}
            {m.txt(it.textKey)}
          </span>
        </span>
      ))}
    </div>
  );
}

function Spinner({ m, size = 28 }: { m: PreviewModel; size?: number }) {
  return <span aria-hidden className="inline-block animate-spin rounded-full border-4" style={{ width: size, height: size, borderColor: `${m.c.button}33`, borderTopColor: m.c.button }} />;
}

export function PayMethodStep({ m, live }: { m: PreviewModel; live: KioskLivePayMethod }) {
  const [confirming, setConfirming] = useState(false);
  const money = (agorot: number) => m.money(agorot / 100);
  const radius = Math.min(Math.max(m.radius, 10), 20);
  const vouchered = live.vouchers.length > 0;
  const voucherTotal = live.vouchers.reduce((s, v) => s + v.amountAgorot, 0);
  const cashOff = live.tiles.find((t) => t.method === 'cash_at_till')?.off ?? null;
  // Working (a voucher checked, the order placed): the tiles, never the confirmation.
  const asking = confirming && !cashOff && !live.busy;

  const tile = (t: KioskPayTile) => {
    const Icon = ICONS[t.method];
    const off = t.off !== null || live.busy;
    return (
      <button
        key={t.method}
        type="button"
        disabled={off}
        aria-disabled={off}
        onClick={() => {
          if (off) return;
          if (t.method === 'cash_at_till') setConfirming(true);
          else live.onPick(t.method);
        }}
        className={`flex w-full items-center gap-3 px-4 py-4 text-start transition-transform duration-150 ${off ? 'opacity-55' : 'active:scale-[0.98]'}`}
        style={{ background: m.c.surface, border: `1.5px solid ${m.c.border}`, borderRadius: radius, color: m.c.text }}
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center" style={{ background: `${m.c.primary}1F`, color: m.c.primary, borderRadius: 14 }}>
          <Icon className="h-6 w-6" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-lg font-extrabold leading-tight">{m.txt(LABEL[t.method])}</span>
          <span className="kt-13" style={{ color: m.c.mutedText }}>
            {t.off ?? m.txt(SUB[t.method])}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto p-3 [scrollbar-width:none]">
        <div className="my-auto w-full max-w-[640px] overflow-hidden" style={{ ...cardStyle(m), background: m.c.surface, borderRadius: Math.max(16, m.radius) }}>
          <EntryHeader m={m} caption={m.txt('stepPayMethod')} start={<LiveBack m={m} size={32} />} compact={m.screen.h < 720} />
          <div className="flex flex-col gap-4 p-4">
            <StepBar m={m} steps={live.steps} />
            <div className="flex flex-col items-center gap-1 text-center">
              <h2 className="text-2xl font-extrabold leading-tight">{m.txt('payMethodTitle')}</h2>
              <p className="kt-13" style={{ color: m.c.mutedText }}>
                {m.txt('payMethodSubtitle')}
              </p>
            </div>
            {asking ? (
              <div className="flex flex-col gap-3 p-4 text-center" style={{ background: `${m.c.primary}0D`, borderRadius: radius }}>
                <span className="mx-auto flex h-12 w-12 items-center justify-center" style={{ background: `${m.c.primary}1F`, color: m.c.primary, borderRadius: 14 }}>
                  <Banknote className="h-6 w-6" />
                </span>
                <div className="text-lg font-extrabold">{m.txt('cashSlipTitle')}</div>
                <div className="text-3xl font-black tabular-nums" style={{ color: m.c.primary }}>
                  {money(live.dueAgorot)}
                </div>
                <p className="kt-13" style={{ color: m.c.mutedText }}>
                  {m.txt('cashSlipFooter')}
                </p>
                <BigButton m={m} onClick={() => live.onPick('cash_at_till')} disabledLook={live.busy}>
                  <Check className="h-5 w-5" />
                  <span>
                    {m.txt('payCashLabel')} · <span className="tabular-nums">{money(live.dueAgorot)}</span>
                  </span>
                </BigButton>
                <BigButton m={m} variant="soft" onClick={() => setConfirming(false)}>
                  {m.t('payBack')}
                </BigButton>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">{live.tiles.map(tile)}</div>
            )}
            {/* "רשות": passed with the default method. */}
            {live.skip && !asking ? (
              <BigButton m={m} variant="soft" onClick={() => !live.busy && live.skip?.onSkip()} disabledLook={live.busy}>
                {m.txt('entryContinue')} · {m.txt(LABEL[live.skip.method])}
              </BigButton>
            ) : null}
            {live.extra}
            {vouchered ? (
              <div className="space-y-2 p-3.5" style={{ background: `${m.c.primary}0D`, borderRadius: radius }}>
                <div className="flex items-center justify-between kt-13">
                  <span style={{ color: m.c.mutedText }}>{m.txt('tipOrderTotal')}</span>
                  <span className="font-semibold tabular-nums">{money(live.goodsAgorot)}</span>
                </div>
                {live.tipAgorot > 0 ? (
                  <div className="flex items-center justify-between kt-13">
                    <span style={{ color: m.c.mutedText }}>{m.txt('tipLine')}</span>
                    <span className="font-semibold tabular-nums">{money(live.tipAgorot)}</span>
                  </div>
                ) : null}
                {live.vouchers.map((v) => (
                  <div key={v.id} className="flex items-center justify-between gap-2 kt-13">
                    <span className="flex min-w-0 items-center gap-1.5" style={{ color: m.c.mutedText }}>
                      <Ticket className="h-4 w-4 shrink-0" />
                      <span className="truncate">
                        {m.txt('payVoucherLabel')}
                        {v.serial ? ` #${v.serial}` : ''}
                        {v.label ? ` · ${v.label}` : ''}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums" dir="ltr">
                        −{money(v.amountAgorot)}
                      </span>
                      {live.onRemoveVoucher ? (
                        <button
                          type="button"
                          aria-label="remove"
                          onClick={() => live.onRemoveVoucher?.(v.id)}
                          disabled={live.busy}
                          className="flex h-8 w-8 items-center justify-center rounded-full"
                          style={{ background: `${m.c.button}14`, color: m.c.button }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between border-t pt-2" style={{ borderColor: m.c.border }}>
                  <span className="text-base font-bold">{payText(m, 'remainingToPay', { amount: '' }).trim()}</span>
                  <span className="text-xl font-extrabold tabular-nums" style={{ color: m.c.primary }}>
                    {money(live.dueAgorot)}
                  </span>
                </div>
                {voucherTotal > 0 && live.dueAgorot === 0 ? (
                  <p className="text-center kt-11" style={{ color: m.c.mutedText }}>
                    {m.txt('cashSlipFooter')}
                  </p>
                ) : null}
              </div>
            ) : null}
            {live.busy ? (
              <div className="flex items-center justify-center gap-2">
                <Spinner m={m} size={22} />
              </div>
            ) : null}
            {live.note ? (
              <p className="text-center kt-13 font-semibold" style={{ color: m.c.accent }}>
                {live.note}
              </p>
            ) : null}
            {live.error ? (
              <p className="p-2.5 text-center kt-13 font-semibold" style={{ background: '#FEE2E2', color: '#B91C1C', borderRadius: radius }}>
                {live.error}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface KioskLiveCashDone {
  pickupLabel: string;
  dueAgorot: number;
  vouchers: KioskPayVoucher[];
  /** "KO:" + the order id: the till's scanner opens the order with it. */
  code: string;
  /** Not in the cloud yet: "הזמנה ממתינה לסנכרון". */
  pending: boolean;
  secondsLeft: number;
  onNewOrder: () => void;
}

/** "גשו לקופה לתשלום · מספר X": the order went to the tills; its code on the screen for the till's scanner. */
export function CashAtTillDone({ m, live }: { m: PreviewModel; live: KioskLiveCashDone }) {
  const pop = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = pop.current;
    if (!el || m.cfg.general.reduceMotion || typeof el.animate !== 'function') return;
    el.animate([{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
  }, [m.cfg.general.reduceMotion]);
  const qr = Math.max(120, Math.min(220, Math.round(Math.min(m.screen.w, m.screen.h) * 0.28)));
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
        <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col items-center gap-3 p-5 text-center">
          <span ref={pop} className="mt-2 flex h-16 w-16 items-center justify-center rounded-full shadow-lg" style={{ background: m.c.accent, color: '#fff' }}>
            <Banknote className="h-9 w-9" strokeWidth={2.4} />
          </span>
          <h2 className="text-2xl font-extrabold">{m.txt('cashDoneTitle')}</h2>
          <div className="w-full space-y-1 p-4" style={cardStyle(m)}>
            {/* "מספר {number}": the business's words, the number drawn big under them. */}
            <div className="text-sm font-semibold" style={{ color: m.c.mutedText }}>
              {payText(m, 'cashDoneBody', { number: '' }).trim() || m.txt('pickupLabel')}
            </div>
            <div className="text-6xl font-black tabular-nums" dir="ltr" style={{ color: m.c.primary }}>
              {live.pickupLabel}
            </div>
          </div>
          <div className="w-full space-y-1.5 p-3.5" style={{ ...cardStyle(m), background: `${m.c.primary}0D` }}>
            <div className="text-sm font-bold">{m.txt('cashSlipTitle')}</div>
            <div className="text-4xl font-black tabular-nums" style={{ color: m.c.text }}>
              {m.money(live.dueAgorot / 100)}
            </div>
            {live.vouchers.map((v) => (
              <div key={v.id} className="flex items-center justify-center gap-1.5 kt-13" style={{ color: m.c.mutedText }}>
                <Ticket className="h-4 w-4" />
                <span>
                  {m.txt('payVoucherLabel')}
                  {v.serial ? ` #${v.serial}` : ''} ·{' '}
                  <span dir="ltr" className="tabular-nums">
                    −{m.money(v.amountAgorot / 100)}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div className="p-3" style={{ background: '#FFFFFF', borderRadius: Math.min(m.radius, 16), border: `1px solid ${m.c.border}` }}>
            <QRCodeSVG value={live.code} size={qr} level="M" marginSize={1} />
          </div>
          <p className="kt-13 font-semibold">{m.txt('cashSlipFooter')}</p>
          {live.pending ? (
            <p className="px-3 py-1.5 kt-13 font-bold" style={{ background: '#FEF3C7', color: '#92400E', borderRadius: 999 }}>
              {m.txt('cashSlipPending')}
            </p>
          ) : null}
          <div className="mt-auto w-full space-y-1.5">
            <BigButton m={m} variant="soft" onClick={live.onNewOrder}>
              {m.t('newOrder')}
            </BigButton>
            <p className="kt-11" style={{ color: m.c.mutedText }}>
              {m.t('resetsIn', { n: live.secondsLeft })}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
