'use client';

/**
 * "אמצעי תשלום" and "תשלום בקופה" in the kiosk editor (docs/SPEC_KIOSK.md §23): which methods the
 * kiosk takes and in which order its "איך תרצו לשלם?" screen shows them (payment.methods), and
 * how an order paid at the till behaves (payment.cashAtTillExpiryMin, cashAtTillKitchenBeforePay).
 */

import { useTranslations } from 'next-intl';
import { Banknote, CreditCard, Ticket } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { PAYMENT_METHODS, kioskAsksPayMethod, moveItem, type PaymentMethod } from '@/lib/kioskConfig';
import { useKioskField } from './editor-context';
import { FieldShell, MoveButtons, NumberInput, SwitchField } from './fields';

const ICONS: Record<PaymentMethod, typeof CreditCard> = { card: CreditCard, voucher: Ticket, cash_at_till: Banknote };

/** The methods: on / off each, the ones on in the order the customer sees them. */
export function PaymentMethodsField() {
  const t = useTranslations('kiosks.payment');
  const tf = useTranslations('kiosks.fields');
  const f = useKioskField<string[]>('payment.methods');
  const on = (Array.isArray(f.value) ? f.value : []).filter((m): m is PaymentMethod => (PAYMENT_METHODS as readonly string[]).includes(m));
  const rows: PaymentMethod[] = [...on, ...PAYMENT_METHODS.filter((m) => !on.includes(m))];
  const label = (m: PaymentMethod) => (m === 'card' ? t('methodCard') : m === 'voucher' ? t('methodVoucher') : t('methodCash'));
  const hint = (m: PaymentMethod) => (m === 'card' ? t('methodCardHint') : m === 'voucher' ? t('methodVoucherHint') : t('methodCashHint'));
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
