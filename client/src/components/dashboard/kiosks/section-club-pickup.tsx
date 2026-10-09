'use client';

import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { KIOSK_LIMITS, pickupLabel, type PickupScope } from '@/lib/kioskConfig';
import { useKioskEditor, useKioskField } from './editor-context';
import { NumberField, SectionCard, SegmentField, SwitchField, TextField } from './fields';

export function ClubSection() {
  const t = useTranslations('kiosks.club');
  const tf = useTranslations('kiosks.fields');
  const enabled = useKioskField<boolean>('club.enabled');
  const url = useKioskField<string>('club.joinUrl');
  const validUrl = /^https?:\/\/\S+$/i.test(url.value ?? '');
  return (
    <SectionCard title={t('title')} description={t('hint')} paths={['club']}>
      <SwitchField path="club.enabled" label={tf('club.enabled')} />
      {enabled.value ? (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="space-y-4">
            <TextField path="club.joinUrl" label={tf('club.joinUrl')} max={KIOSK_LIMITS.mediaUrlMax} placeholder="https://" dir="ltr" />
            <TextField path="club.title" label={tf('club.title')} max={KIOSK_LIMITS.messageTitleMax} placeholder={t('titlePlaceholder')} />
            <TextField path="club.body" label={tf('club.body')} max={KIOSK_LIMITS.messageBodyMax} multiline placeholder={t('bodyPlaceholder')} />
          </div>
          <div className="flex flex-col items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('qrPreview')}</span>
            <div className="rounded-2xl border bg-white p-3 shadow-sm">
              {validUrl ? (
                <QRCodeSVG value={url.value} size={140} level="M" />
              ) : (
                <div className="flex h-[140px] w-[140px] items-center justify-center text-center text-xs text-neutral-500">
                  {t('noUrl')}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

export function PickupSection() {
  const t = useTranslations('kiosks.pickup');
  const tf = useTranslations('kiosks.fields');
  const { draft } = useKioskEditor();
  const scope = useKioskField<PickupScope>('pickup.scope');
  const p = draft.pickup;
  const start = Number.isFinite(p.start) ? p.start : 1;
  return (
    <SectionCard title={t('title')} paths={['pickup']}>
      <SegmentField<PickupScope>
        path="pickup.scope"
        label={tf('pickup.scope')}
        hint={t(`scopeHint.${scope.value ?? 'kiosk'}`)}
        options={(['kiosk', 'shop'] as const).map((v) => ({ value: v, label: t(`scope.${v}`) }))}
      />
      <TextField path="pickup.prefix" label={tf('pickup.prefix')} hint={t('prefixHint')} max={KIOSK_LIMITS.pickupPrefixMax} dir="ltr" />
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField path="pickup.start" label={tf('pickup.start')} min={1} max={KIOSK_LIMITS.pickupMax - 1} />
        <NumberField path="pickup.max" label={tf('pickup.max')} min={2} max={KIOSK_LIMITS.pickupMax} />
      </div>
      <div className="space-y-2">
        <span className="text-sm font-medium">{t('sampleTitle')}</span>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-2xl bg-primary px-5 py-2.5 text-2xl font-bold text-primary-foreground tabular-nums shadow-sm" dir="ltr">
            {pickupLabel(p.prefix, start)}
          </span>
          <span className="text-sm text-muted-foreground">{t('wrapHint', { max: p.max, start })}</span>
        </div>
      </div>
    </SectionCard>
  );
}
