'use client';

/**
 * "גודל כרטיסי לקחת / לשבת" in the kiosk editor (P:/specs/kiosk-service-size.md): auto / small / medium / large and
 * the optional numbers (dp), next to "לקחת / לשבת" and "בחירת לקחת / לשבת". With the "לאורך / לרוחב" switch on
 * landscape they edit `landscape.general.*` (editor-context landscapePathOf). Every change shows the service
 * screen in the live preview.
 */

import { useTranslations } from 'next-intl';
import {
  SERVICE_CARD_SIZES,
  SERVICE_SIZE_NUMBER_KEYS,
  SERVICE_SIZE_NUMBER_SPECS,
  type ServiceCardSize,
  type ServiceSizeNumberKey,
} from '@/lib/kioskServiceSize';
import { useKioskEditor, useKioskField } from './editor-context';
import { FieldErrors, FieldShell, NumberInput, OverrideMark, Segmented } from './fields';

function ServiceSizeNumber({ k }: { k: ServiceSizeNumberKey }) {
  const t = useTranslations('kiosks.general');
  const ed = useKioskEditor();
  const path = `general.${k}`;
  const f = useKioskField<number | null | undefined>(path);
  const spec = SERVICE_SIZE_NUMBER_SPECS[k];
  const set = typeof f.value === 'number';
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium">{t(k)}</span>
        <OverrideMark path={path} />
      </div>
      <NumberInput
        value={set ? (f.value as number) : NaN}
        onChange={(n) => {
          ed.showScreen('service');
          // Emptied: back to the size (this level's value removed).
          if (Number.isFinite(n)) f.set(Math.max(spec.min, Math.min(spec.max, n)));
          else f.reset();
        }}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        disabled={f.disabled}
        suffix="dp"
        ariaLabel={t(k)}
      />
      {!set ? <p className="text-[11px] text-muted-foreground">{t('serviceSizeEmpty')}</p> : null}
      <FieldErrors path={path} />
    </div>
  );
}

export function ServiceSizeField() {
  const t = useTranslations('kiosks.general');
  const ed = useKioskEditor();
  const size = useKioskField<ServiceCardSize | null | undefined>('general.serviceCardSize');
  return (
    <FieldShell
      path="general.serviceCardSize"
      label={t('serviceSize')}
      hint={
        <>
          {t('serviceSizeHint')} {ed.orientation === 'landscape' ? t('serviceSizeLandscape') : null}
        </>
      }
    >
      <div className="space-y-3" onPointerDown={() => ed.showScreen('service')}>
        <Segmented<ServiceCardSize>
          value={size.value ?? 'auto'}
          options={SERVICE_CARD_SIZES.map((v) => ({ value: v, label: t(`serviceSizeOption.${v}`) }))}
          onChange={(v) => size.set(v)}
          disabled={size.disabled}
          ariaLabel={t('serviceSize')}
        />
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">{t('serviceSizeNumbers')}</div>
          <div className="grid gap-3 sm:grid-cols-3">
            {SERVICE_SIZE_NUMBER_KEYS.map((k) => (
              <ServiceSizeNumber key={k} k={k} />
            ))}
          </div>
        </div>
      </div>
    </FieldShell>
  );
}
