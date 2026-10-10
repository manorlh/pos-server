'use client';

/**
 * "חובה / רשות / כבוי לכל שלב" (pos-server docs/SPEC_KIOSK_INSIGHTS.md §4): per company, shop or
 * kiosk (the editor's level), each step of the order — the service choice, the tip, "איך תרצו
 * לשלם?" and the upsell windows at each moment — is required (the customer must answer), optional
 * (shown, may be passed) or off. The customer fields (name, phone, table) keep their own modes
 * in "פרטי לקוח"; the order before the payment is "סדר השלבים לפני התשלום". Each step still needs
 * its own switch on: a step whose switch is off shows that it is off and why.
 */

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { STEP_MODE_KEYS, stepMode, type CustomerFieldMode, type KioskGeneral, type KioskPayment, type StepModeKey } from '@/lib/kioskConfig';
import { useKioskField } from './editor-context';
import { SectionCard, SegmentField } from './fields';

/** Why a step is off whatever its mode says (its own switch), or null. */
function offBecause(key: StepModeKey, general: Partial<KioskGeneral>, payment: Partial<KioskPayment>): string | null {
  const effective = stepMode({ general, payment: { ...payment, stepModes: { [key]: 'required' } } }, key);
  if (effective !== 'off') return null;
  if (key === 'service') return general.serviceMode === 'none' ? 'noService' : 'oneService';
  if (key === 'tip') return 'tipOff';
  if (key === 'payMethod') return 'oneMethod';
  return 'upsellOff';
}

function StepModeRow({ k, general, payment }: { k: StepModeKey; general: Partial<KioskGeneral>; payment: Partial<KioskPayment> }) {
  const t = useTranslations('kiosks.stepModes');
  const options = (['required', 'optional', 'off'] as const).map((v) => ({ value: v as CustomerFieldMode, label: t(`mode.${v}`) }));
  const why = offBecause(k, general, payment);
  return (
    <div className="space-y-1">
      <SegmentField<CustomerFieldMode> path={`payment.stepModes.${k}`} label={t(`step.${k}`)} hint={t(`hints.${k}`)} options={options} />
      {why ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{t('offNow')}</Badge>
          {t(`why.${why}`)}
        </p>
      ) : null}
    </div>
  );
}

export function StepModesCard() {
  const t = useTranslations('kiosks.stepModes');
  const serviceTypes = useKioskField<string[]>('general.serviceTypes');
  const serviceMode = useKioskField<KioskGeneral['serviceMode']>('general.serviceMode');
  const upsellEnabled = useKioskField<boolean>('general.upsellEnabled');
  const tipEnabled = useKioskField<boolean>('payment.tipEnabled');
  const tipPresets = useKioskField<number[]>('payment.tipPresets');
  const tipOther = useKioskField<boolean>('payment.tipOther');
  const methods = useKioskField<string[]>('payment.methods');
  const general: Partial<KioskGeneral> = {
    serviceTypes: (serviceTypes.value ?? ['take_away', 'eat_in']) as KioskGeneral['serviceTypes'],
    serviceMode: serviceMode.value ?? 'types',
    upsellEnabled: upsellEnabled.value !== false,
  };
  const payment: Partial<KioskPayment> = {
    tipEnabled: !!tipEnabled.value,
    tipPresets: tipPresets.value ?? [],
    tipOther: tipOther.value !== false,
    methods: methods.value ?? ['card'],
  };
  return (
    <SectionCard title={t('title')} description={t('hint')} paths={STEP_MODE_KEYS.map((k) => `payment.stepModes.${k}`)}>
      <div className="space-y-4">
        {STEP_MODE_KEYS.map((k) => (
          <StepModeRow key={k} k={k} general={general} payment={payment} />
        ))}
        <p className="rounded-xl border bg-muted/40 p-3 text-xs text-muted-foreground">{t('fieldsNote')}</p>
      </div>
    </SectionCard>
  );
}
