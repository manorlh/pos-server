'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DETAILS_STEPS,
  KIOSK_LIMITS,
  checkoutStepOrder,
  moveItem,
  type CheckoutStep,
  type CustomerFieldMode,
  type DetailsStep,
  type ReceiptPolicy,
  type MediaRef,
  WAIT_LOGO_STYLES,
  type WaitLogoStyle,
} from '@/lib/kioskConfig';
import { useKioskField } from './editor-context';
import { FieldShell, MediaField, MoveButtons, NumberInput, SectionCard, SegmentField, SwitchField } from './fields';
import { CashAtTillFields, PayMethodStepRow, PaymentMethodsField } from './section-payment-methods';
import { StepModesCard } from './section-step-modes';

/**
 * "לוגו במסך התשלום" (payment.waitLogo): its own upload (POST /kiosks/media, cached on the kiosk
 * with the rest of its media), at the top of the screens that wait for the payment; and how it
 * sits — as it is (a transparent PNG) or on a rounded light plate. Nothing uploaded: nothing shows.
 */
function WaitLogoFields() {
  const t = useTranslations('kiosks.payment');
  const media = useKioskField<MediaRef | null | undefined>('payment.waitLogo.media');
  return (
    <>
      <MediaField path="payment.waitLogo.media" label={t('waitLogo')} hint={t('waitLogoHint')} />
      {media.value ? (
        <SegmentField<WaitLogoStyle>
          path="payment.waitLogo.style"
          label={t('waitLogoStyle')}
          hint={t('waitLogoStyleHint.plain')}
          options={WAIT_LOGO_STYLES.map((v) => ({ value: v, label: t(`waitLogoStyleOption.${v}`) }))}
        />
      ) : null}
    </>
  );
}

/** "סכום אחר": only while the tip is on. */
function TipOther() {
  const t = useTranslations('kiosks.payment');
  const tf = useTranslations('kiosks.fields');
  const enabled = useKioskField<boolean>('payment.tipEnabled');
  if (!enabled.value) return null;
  return <SwitchField path="payment.tipOther" label={tf('payment.tipOther')} hint={t('tipOtherHint')} />;
}

/**
 * "סדר השלבים לפני התשלום": the order review first, then the tip and the customer's details in the
 * order chosen here (payment.checkoutSteps), then the payment. The tip is switched here
 * (payment.tipEnabled); the details follow the customer fields below — asked before the payment
 * or not.
 */
function CheckoutStepsOrder() {
  const t = useTranslations('kiosks.payment');
  const tf = useTranslations('kiosks.fields');
  const f = useKioskField<CheckoutStep[]>('payment.checkoutSteps');
  const tip = useKioskField<boolean>('payment.tipEnabled');
  const name = useKioskField<CustomerFieldMode>('payment.customerName');
  const phone = useKioskField<CustomerFieldMode>('payment.customerPhone');
  const table = useKioskField<CustomerFieldMode>('payment.tableNumber');
  const askTable = useKioskField<boolean>('general.askTableNumber');
  const when = useKioskField<DetailsStep>('payment.detailsStep');
  // "איך תרצו לשלם?" is always last (its own row below): the tip and the details move here.
  const order = checkoutStepOrder(f.value).filter((s) => s !== 'payMethod');
  const detailsOn = name.value !== 'off' || phone.value !== 'off' || (table.value ?? 'off') !== 'off' || !!askTable.value;
  const detailsHere = detailsOn && when.value === 'before_pay';
  const fixed = (n: number, label: string) => (
    <li className="flex items-center justify-between gap-2 bg-muted/40 px-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        <span className="w-4 text-xs text-muted-foreground tabular-nums">{n}</span>
        {label}
      </span>
      <Badge variant="outline">{t('stepFixed')}</Badge>
    </li>
  );
  return (
    <FieldShell path="payment.checkoutSteps" label={tf('payment.checkoutSteps')} hint={t('stepsHint')}>
      <ol className="divide-y overflow-hidden rounded-xl border">
        {fixed(1, t('stepReview'))}
        {order.map((s, i) => (
          <li key={s} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="w-4 text-xs text-muted-foreground tabular-nums">{i + 2}</span>
              <span className="truncate">{s === 'tip' ? t('stepTip') : t('stepDetails')}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {s === 'tip' ? (
                <Switch checked={!!tip.value} disabled={tip.disabled} onCheckedChange={(v) => tip.set(!!v)} aria-label={t('stepTip')} />
              ) : (
                <span className="flex flex-col items-end gap-0.5">
                  <Badge variant={detailsHere ? 'default' : 'outline'}>{detailsHere ? t('stepOn') : t('stepOff')}</Badge>
                  <span className="text-[11px] text-muted-foreground">{detailsOn && !detailsHere ? t('stepDetailsElsewhere') : t('stepDetailsHint')}</span>
                </span>
              )}
              <MoveButtons index={i} count={order.length} disabled={f.disabled} onMove={(d) => f.set(moveItem(order, i, d))} />
            </span>
          </li>
        ))}
        <PayMethodStepRow n={order.length + 2} />
        {fixed(order.length + 3, t('stepPay'))}
      </ol>
    </FieldShell>
  );
}

function TipPresets() {
  const t = useTranslations('kiosks.payment');
  const tf = useTranslations('kiosks.fields');
  const f = useKioskField<number[]>('payment.tipPresets');
  const enabled = useKioskField<boolean>('payment.tipEnabled');
  const list = Array.isArray(f.value) ? f.value : [];
  const [draft, setDraft] = useState<number>(NaN);
  if (!enabled.value) return null;
  const canAdd =
    Number.isInteger(draft) &&
    draft >= KIOSK_LIMITS.tipPreset.min &&
    draft <= KIOSK_LIMITS.tipPreset.max &&
    !list.includes(draft) &&
    list.length < KIOSK_LIMITS.tipPresetsMax;
  return (
    <FieldShell path="payment.tipPresets" label={tf('payment.tipPresets')} hint={t('tipPresets')}>
      <div className="flex flex-wrap items-center gap-2">
        {list.map((n) => (
          <span key={n} className="inline-flex items-center gap-1 rounded-full border bg-card py-1 ps-3 pe-1 text-sm tabular-nums">
            {n}%
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t('removePreset', { n })}
              disabled={f.disabled}
              onClick={() => f.set(list.filter((x) => x !== n))}
            >
              <X />
            </Button>
          </span>
        ))}
        {list.length < KIOSK_LIMITS.tipPresetsMax ? (
          <span className="inline-flex items-center gap-1">
            <NumberInput
              value={draft}
              onChange={setDraft}
              min={KIOSK_LIMITS.tipPreset.min}
              max={KIOSK_LIMITS.tipPreset.max}
              disabled={f.disabled}
              suffix="%"
              ariaLabel={t('addPreset')}
              className="w-20"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={f.disabled || !canAdd}
              onClick={() => {
                f.set([...list, draft].sort((a, b) => a - b));
                setDraft(NaN);
              }}
            >
              <Plus /> {t('addPreset')}
            </Button>
          </span>
        ) : null}
      </div>
    </FieldShell>
  );
}

function MinOrder() {
  const t = useTranslations('kiosks.payment');
  const tf = useTranslations('kiosks.fields');
  const f = useKioskField<number>('payment.minOrderAgorot');
  const shekels = Number.isFinite(f.value) ? f.value / 100 : NaN;
  return (
    <FieldShell path="payment.minOrderAgorot" label={tf('payment.minOrderAgorot')} hint={t('minOrderHint')}>
      <NumberInput
        value={shekels}
        min={0}
        step={1}
        disabled={f.disabled}
        suffix="₪"
        ariaLabel={tf('payment.minOrderAgorot')}
        onChange={(n) => f.set(Number.isFinite(n) ? Math.round(n * 100) : 0)}
      />
    </FieldShell>
  );
}

export function PaymentSection() {
  const t = useTranslations('kiosks.payment');
  const tf = useTranslations('kiosks.fields');
  const fieldOptions = (['off', 'optional', 'required'] as const).map((v) => ({ value: v, label: t(`field.${v}`) }));
  return (
    <div className="space-y-4">
      <SectionCard title={t('methodsTitle')} paths={['payment.methods']}>
        <PaymentMethodsField />
      </SectionCard>

      <SectionCard title={t('cashAtTillTitle')} paths={['payment.cashAtTillExpiryMin', 'payment.cashAtTillKitchenBeforePay']}>
        <CashAtTillFields />
      </SectionCard>

      <SectionCard title={t('tipTitle')} paths={['payment.tipEnabled', 'payment.tipPresets', 'payment.tipOther']}>
        <SwitchField path="payment.tipEnabled" label={tf('payment.tipEnabled')} hint={t('tipHint')} />
        <TipPresets />
        <TipOther />
      </SectionCard>

      <SectionCard title={t('stepsTitle')} paths={['payment.checkoutSteps']}>
        <CheckoutStepsOrder />
      </SectionCard>

      {/* "חובה / רשות / כבוי" per step (docs/SPEC_KIOSK_INSIGHTS.md §4). */}
      <StepModesCard />

      <SectionCard title={t('waitLogoTitle')} description={t('waitLogoDescription')} paths={['payment.waitLogo.media', 'payment.waitLogo.style']}>
        <WaitLogoFields />
      </SectionCard>

      <SectionCard title={t('receiptTitle')} paths={['payment.receiptPolicy']}>
        <SegmentField<ReceiptPolicy>
          path="payment.receiptPolicy"
          label={tf('payment.receiptPolicy')}
          options={(['always', 'ask', 'never'] as const).map((v) => ({ value: v, label: t(`receipt.${v}`) }))}
        />
      </SectionCard>

      <SectionCard
        title={t('customerTitle')}
        description={t('customerHint')}
        paths={['payment.customerName', 'payment.customerPhone', 'payment.tableNumber', 'payment.detailsStep']}
      >
        <SegmentField<DetailsStep>
          path="payment.detailsStep"
          label={t('detailsStep')}
          hint={t('detailsStepHint')}
          options={DETAILS_STEPS.map((v) => ({ value: v, label: t(`detailsStepOption.${v}`) }))}
        />
        <SegmentField<CustomerFieldMode> path="payment.customerName" label={tf('payment.customerName')} options={fieldOptions} />
        <SegmentField<CustomerFieldMode> path="payment.tableNumber" label={t('tableNumber')} hint={t('tableNumberHint')} options={fieldOptions} />
        <SegmentField<CustomerFieldMode>
          path="payment.customerPhone"
          label={tf('payment.customerPhone')}
          hint={t('phoneHint')}
          options={fieldOptions}
        />
      </SectionCard>

      <SectionCard title={t('minOrderTitle')} paths={['payment.minOrderAgorot']}>
        <MinOrder />
      </SectionCard>
    </div>
  );
}
