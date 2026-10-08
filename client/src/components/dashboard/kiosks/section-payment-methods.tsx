'use client';

/**
 * "אמצעי תשלום" and "תשלום בקופה" in the kiosk editor (docs/SPEC_KIOSK.md §23): which methods the
 * kiosk takes and in which order its "איך תרצו לשלם?" screen shows them (payment.methods), and
 * how an order paid at the till behaves (payment.cashAtTillExpiryMin, cashAtTillKitchenBeforePay),
 * and what "פיצול תשלום בכרטיסים" offers (payment.splitCard — the Android kiosk only).
 */

import { useTranslations } from 'next-intl';
import { Banknote, CreditCard, Ticket, WalletCards } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  KIOSK_DEFAULTS,
  PAYMENT_METHODS,
  SPLIT_CARD_COUNTS,
  SPLIT_CARD_MIN_PER_CARD,
  kioskAsksPayMethod,
  moveItem,
  type PaymentMethod,
} from '@/lib/kioskConfig';
import { useKioskField } from './editor-context';
import { FieldShell, MoveButtons, NumberInput, SwitchField } from './fields';

const ICONS: Record<PaymentMethod, typeof CreditCard> = { card: CreditCard, voucher: Ticket, cash_at_till: Banknote, split_card: WalletCards };
/** Each method's name and line under it (kiosks.payment). */
const LABEL: Record<PaymentMethod, string> = { card: 'methodCard', voucher: 'methodVoucher', cash_at_till: 'methodCash', split_card: 'methodSplitCard' };
const HINT: Record<PaymentMethod, string> = {
  card: 'methodCardHint',
  voucher: 'methodVoucherHint',
  cash_at_till: 'methodCashHint',
  split_card: 'methodSplitCardHint',
};

/** The methods: on / off each, the ones on in the order the customer sees them. */
export function PaymentMethodsField() {
  const t = useTranslations('kiosks.payment');
  const tf = useTranslations('kiosks.fields');
  const f = useKioskField<string[]>('payment.methods');
  const on = (Array.isArray(f.value) ? f.value : []).filter((m): m is PaymentMethod => (PAYMENT_METHODS as readonly string[]).includes(m));
  const rows: PaymentMethod[] = [...on, ...PAYMENT_METHODS.filter((m) => !on.includes(m))];
  const label = (m: PaymentMethod) => t(LABEL[m]);
  const hint = (m: PaymentMethod) => t(HINT[m]);
  return (
    <FieldShell path="payment.methods" label={tf('payment.methods')} hint={t('methodsHint')}>
      <ol className="divide-y overflow-hidden rounded-xl border">
        {rows.map((m) => {
          const Icon = ICONS[m];
          const active = on.includes(m);
          const at = on.indexOf(m);
          return (
            <li key={m} className={`flex items-center gap-3 px-3 py-2.5 text-sm ${active ? '' : 'opacity-70'}`}>
              <span className="w-4 text-xs text-muted-foreground tabular-nums">{active ? at + 1 : ''}</span>
              <Icon className={`h-5 w-5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{label(m)}</span>
                <span className="text-xs text-muted-foreground">{hint(m)}</span>
              </span>
              {active ? (
                <MoveButtons index={at} count={on.length} disabled={f.disabled} onMove={(d) => f.set(moveItem(on, at, d))} />
              ) : (
                <Badge variant="outline">{t('methodOff')}</Badge>
              )}
              <Switch
                checked={active}
                disabled={f.disabled}
                aria-label={label(m)}
                onCheckedChange={(v) => f.set(v ? [...on, m] : on.filter((x) => x !== m))}
              />
            </li>
          );
        })}
      </ol>
      {/* The browser kiosk (`/k`, docs/SPEC_KIOSK.md §27) takes what a browser can: never the card. */}
      <p className={`mt-2 rounded-lg p-2 text-xs ${on.includes('cash_at_till') ? 'bg-muted/50 text-muted-foreground' : 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'}`}>
        {t('webKioskNote')}
      </p>
    </FieldShell>
  );
}

/** "תשלום בקופה": the open order's time and the kitchen; only while the method is on. */
export function CashAtTillFields() {
  const t = useTranslations('kiosks.payment');
  const tf = useTranslations('kiosks.fields');
  const methods = useKioskField<string[]>('payment.methods');
  const expiry = useKioskField<number>('payment.cashAtTillExpiryMin');
  if (!(Array.isArray(methods.value) && methods.value.includes('cash_at_till'))) {
    return <p className="text-sm text-muted-foreground">{t('cashAtTillOff')}</p>;
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">{t('cashAtTillHint')}</p>
      <FieldShell path="payment.cashAtTillExpiryMin" label={tf('payment.cashAtTillExpiryMin')} hint={t('cashAtTillExpiryHint')}>
        <NumberInput
          value={Number.isFinite(expiry.value) ? expiry.value : 30}
          min={5}
          max={240}
          step={5}
          disabled={expiry.disabled}
          suffix={t('minutes')}
          ariaLabel={tf('payment.cashAtTillExpiryMin')}
          onChange={(n) => expiry.set(Number.isFinite(n) ? Math.round(n) : 30)}
        />
      </FieldShell>
      <SwitchField path="payment.cashAtTillKitchenBeforePay" label={tf('payment.cashAtTillKitchenBeforePay')} hint={t('cashAtTillKitchenHint')} />
    </>
  );
}

/**
 * "פיצול תשלום בכרטיסים" (payment.splitCard): 2 / 3 / 4 equal cards, "סכום אחר", the least per card;
 * only while the method is on. The Android kiosk only — the Windows and browser kiosks hold one card
 * per document and never offer it.
 */
export function SplitCardFields() {
  const t = useTranslations('kiosks.payment');
  const methods = useKioskField<string[]>('payment.methods');
  const counts = useKioskField<number[]>('payment.splitCard.counts');
  const min = useKioskField<number>('payment.splitCard.minPerCardAgorot');
  if (!(Array.isArray(methods.value) && methods.value.includes('split_card'))) {
    return <p className="text-sm text-muted-foreground">{t('splitCardOff')}</p>;
  }
  const on = Array.isArray(counts.value) ? counts.value : [];
  const lo = SPLIT_CARD_MIN_PER_CARD.min / 100;
  const hi = SPLIT_CARD_MIN_PER_CARD.max / 100;
  return (
    <>
      <p className="text-sm text-muted-foreground">{t('splitCardHint')}</p>
      <FieldShell path="payment.splitCard.counts" label={t('splitCardCounts')} hint={t('splitCardCountsHint')}>
        <div className="flex flex-wrap gap-4">
          {SPLIT_CARD_COUNTS.map((n) => (
            <label key={n} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={on.includes(n)}
                disabled={counts.disabled}
                onChange={(e) => counts.set(e.target.checked ? [...on.filter((x) => x !== n), n].sort((a, b) => a - b) : on.filter((x) => x !== n))}
              />
              {t('splitCardCount', { n })}
            </label>
          ))}
        </div>
      </FieldShell>
      <SwitchField path="payment.splitCard.otherAmount" label={t('splitCardOther')} hint={t('splitCardOtherHint')} />
      <FieldShell path="payment.splitCard.minPerCardAgorot" label={t('splitCardMin')} hint={t('splitCardMinHint', { min: lo, max: hi })}>
        <NumberInput
          value={Number.isFinite(min.value) ? min.value / 100 : NaN}
          min={lo}
          max={hi}
          step={1}
          disabled={min.disabled}
          suffix="₪"
          ariaLabel={t('splitCardMin')}
          onChange={(n) => min.set(Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) * 100 : (KIOSK_DEFAULTS.payment.splitCard?.minPerCardAgorot ?? 1000))}
        />
      </FieldShell>
      <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t('splitCardAndroidOnly')}</p>
    </>
  );
}

/** The "איך תרצו לשלם?" row of the steps' order: always last; on with more than one method. */
export function PayMethodStepRow({ n }: { n: number }) {
  const t = useTranslations('kiosks.payment');
  const methods = useKioskField<string[]>('payment.methods');
  const asked = kioskAsksPayMethod(methods.value);
  return (
    <li className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <span className="w-4 text-xs text-muted-foreground tabular-nums">{n}</span>
        <span className="truncate">{t('stepPayMethod')}</span>
      </span>
      <span className="flex flex-col items-end gap-0.5">
        <Badge variant={asked ? 'default' : 'outline'}>{asked ? t('stepOn') : t('stepOff')}</Badge>
        <span className="text-[11px] text-muted-foreground">{t('stepPayMethodHint')}</span>
      </span>
    </li>
  );
}
