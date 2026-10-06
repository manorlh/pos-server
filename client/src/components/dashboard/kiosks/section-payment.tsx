'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CreditCard, Banknote, Plus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KIOSK_LIMITS, type CustomerFieldMode, type ReceiptPolicy } from '@/lib/kioskConfig';
import { useKioskField } from './editor-context';
import { FieldShell, NumberInput, SectionCard, SegmentField, SwitchField } from './fields';

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
        <FieldShell path="payment.methods" label={tf('payment.methods')}>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex items-center gap-3 rounded-xl border border-primary bg-primary/5 p-3">
              <CreditCard className="h-5 w-5 text-primary" />
              <span className="flex-1 text-sm font-medium">{t('card')}</span>
              <Badge>{t('on')}</Badge>
            </div>
            <div className="flex items-center gap-3 rounded-xl border p-3 opacity-60">
              <Banknote className="h-5 w-5" />
              <span className="flex-1 text-sm">{t('cash')}</span>
              <Badge variant="outline">{t('cashSoon')}</Badge>
            </div>
          </div>
        </FieldShell>
      </SectionCard>

      <SectionCard title={t('tipTitle')} paths={['payment.tipEnabled', 'payment.tipPresets']}>
        <SwitchField path="payment.tipEnabled" label={tf('payment.tipEnabled')} hint={t('tipHint')} />
        <TipPresets />
      </SectionCard>

      <SectionCard title={t('receiptTitle')} paths={['payment.receiptPolicy']}>
        <SegmentField<ReceiptPolicy>
          path="payment.receiptPolicy"
          label={tf('payment.receiptPolicy')}
          options={(['always', 'ask', 'never'] as const).map((v) => ({ value: v, label: t(`receipt.${v}`) }))}
        />
      </SectionCard>

      <SectionCard title={t('customerTitle')} description={t('customerHint')} paths={['payment.customerName', 'payment.customerPhone']}>
        <SegmentField<CustomerFieldMode> path="payment.customerName" label={tf('payment.customerName')} options={fieldOptions} />
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
