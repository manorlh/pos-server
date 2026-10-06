'use client';

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  LANGUAGES,
  SERVICE_PLACEMENTS,
  SERVICE_SELECTS,
  SERVICE_TYPES,
  moveItem,
  type KioskLanguage,
  type ServicePlacement,
  type ServiceSelect,
  type ServiceType,
  type SkipCartMode,
} from '@/lib/kioskConfig';
import { useKioskField } from './editor-context';
import { FieldShell, MoveButtons, OrderedPick, SectionCard, Segmented, SegmentField, SwitchField } from './fields';

/**
 * "לשאול לקחת או לשבת": on, both service types (in the order of their buttons); off, one — every
 * order is that one and the customer sees neither the choice nor its word (general.serviceTypes).
 */
function ServiceTypesField() {
  const t = useTranslations('kiosks.general');
  const tf = useTranslations('kiosks.fields');
  const f = useKioskField<ServiceType[]>('general.serviceTypes');
  const list = (Array.isArray(f.value) ? f.value : []).filter((v) => SERVICE_TYPES.includes(v));
  const ask = list.length > 1;
  const only: ServiceType = list[0] ?? 'take_away';
  const label = (v: ServiceType) => (v === 'take_away' ? t('takeAway') : t('eatIn'));
  return (
    <FieldShell path="general.serviceTypes" label={tf('general.serviceTypes')} hint={t('serviceTypesHint')}>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium">{t('askService')}</div>
            <p className="text-xs text-muted-foreground">{t('askServiceHint')}</p>
          </div>
          <Switch
            checked={ask}
            disabled={f.disabled}
            aria-label={t('askService')}
            onCheckedChange={(v) => f.set(v ? [only, ...SERVICE_TYPES.filter((x) => x !== only)] : [only])}
          />
        </div>
        {ask ? (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">{t('serviceOrder')}</div>
            <ol className="divide-y rounded-xl border">
              {list.map((v, i) => (
                <li key={v} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="w-4 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                    {label(v)}
                  </span>
                  <MoveButtons index={i} count={list.length} disabled={f.disabled} onMove={(d) => f.set(moveItem(list, i, d))} />
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">{t('oneService')}</span>
            <Segmented<ServiceType>
              value={only}
              options={SERVICE_TYPES.map((v) => ({ value: v, label: label(v) }))}
              onChange={(v) => f.set([v])}
              disabled={f.disabled}
              ariaLabel={t('oneService')}
            />
          </div>
        )}
      </div>
    </FieldShell>
  );
}

export function GeneralSection() {
  const t = useTranslations('kiosks.general');
  const tf = useTranslations('kiosks.fields');
  const mode = useKioskField<'BON' | 'KDS'>('general.fulfillmentMode');
  const services = useKioskField<ServiceType[]>('general.serviceTypes');
  const skip = useKioskField<SkipCartMode>('general.skipCart');
  const dietary = useKioskField<boolean>('general.showDietary');

  const card = (value: 'BON' | 'KDS', title: string, desc: string, steps: string | null, soon: boolean) => {
    const active = mode.value === value;
    return (
      <button
        type="button"
        disabled={mode.disabled || soon}
        onClick={() => mode.set(value)}
        className={cn(
          'relative flex-1 rounded-2xl border p-4 text-start transition-all duration-200',
          active ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary' : 'hover:bg-muted/50',
          soon && 'cursor-not-allowed opacity-60',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">{title}</span>
          {soon ? <Badge variant="outline">{t('soon')}</Badge> : active ? <Check className="h-4 w-4 text-primary" /> : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
        {steps ? <p className="mt-2 text-xs font-medium text-primary">{steps}</p> : null}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <SectionCard title={t('fulfillmentTitle')} description={t('fulfillmentHint')} paths={['general.fulfillmentMode']}>
        <FieldShell path="general.fulfillmentMode" label={tf('general.fulfillmentMode')}>
          <div className="flex flex-col gap-3 sm:flex-row">
            {card('BON', t('bonTitle'), t('bonDesc'), t('bonSteps'), false)}
            {card('KDS', t('kdsTitle'), t('kdsDesc'), null, true)}
          </div>
        </FieldShell>
      </SectionCard>

      <SectionCard
        title={t('orderingTitle')}
        paths={['general.serviceTypes', 'general.askTableNumber', 'general.serviceSelect', 'general.skipCart', 'general.languages']}
      >
        <ServiceTypesField />
        {Array.isArray(services.value) && services.value.includes('eat_in') ? (
          <SwitchField path="general.askTableNumber" label={tf('general.askTableNumber')} hint={t('askTableHint')} />
        ) : null}
        {Array.isArray(services.value) && services.value.length > 1 ? (
          <SegmentField<ServicePlacement>
            path="general.servicePlacement"
            label={t('servicePlacement')}
            hint={t('servicePlacementHint')}
            options={SERVICE_PLACEMENTS.map((v) => ({ value: v, label: t(`servicePlacementOption.${v}`) }))}
          />
        ) : null}
        {Array.isArray(services.value) && services.value.length > 1 ? (
          <SegmentField<ServiceSelect>
            path="general.serviceSelect"
            label={t('serviceSelect')}
            hint={t('serviceSelectHint')}
            options={SERVICE_SELECTS.map((v) => ({ value: v, label: t(`serviceSelectOption.${v}`) }))}
          />
        ) : null}
        <SegmentField<SkipCartMode>
          path="general.skipCart"
          label={tf('general.skipCart')}
          hint={t(`skipCartHint.${skip.value ?? 'off'}`)}
          options={[
            { value: 'off', label: t('skipCartOff') },
            { value: 'direct', label: t('skipCartDirect') },
            { value: 'confirm', label: t('skipCartConfirm') },
          ]}
        />
        <FieldShell path="general.languages" label={tf('general.languages')} hint={t('languagesHint')}>
          <OrderedPick<KioskLanguage>
            path="general.languages"
            all={LANGUAGES}
            label={(v) => t(`lang.${v}`)}
            firstBadge={t('default')}
          />
        </FieldShell>
      </SectionCard>

      <SectionCard
        title={t('featuresTitle')}
        paths={[
          'general.upsellEnabled',
          'general.searchEnabled',
          'general.notesEnabled',
          'general.quickNotesEnabled',
          'general.showDietary',
          'general.showAllergens',
          'general.reduceMotion',
          'general.offlineSound',
          'general.blockWhenOffline',
          'general.offlineNotice',
          'general.soldOutMode',
        ]}
      >
        <SwitchField path="general.upsellEnabled" label={tf('general.upsellEnabled')} hint={t('upsellHint')} />
        <SwitchField path="general.searchEnabled" label={tf('general.searchEnabled')} hint={t('searchHint')} />
        <SwitchField path="general.notesEnabled" label={tf('general.notesEnabled')} hint={t('notesHint')} />
        <SwitchField path="general.quickNotesEnabled" label={tf('general.quickNotesEnabled')} hint={t('quickNotesHint')} />
        <SwitchField path="general.showDietary" label={tf('general.showDietary')} hint={t('dietaryHint')} />
        {dietary.value ? (
          <div className="border-s-2 ps-4">
            <SwitchField path="general.showAllergens" label={tf('general.showAllergens')} hint={t('allergensHint')} />
          </div>
        ) : null}
        <SwitchField path="general.reduceMotion" label={tf('general.reduceMotion')} hint={t('reduceMotionHint')} />
        <SwitchField path="general.offlineSound" label={tf('general.offlineSound')} hint={t('offlineSoundHint')} />
        {/* No internet never stops the kiosk by itself (docs/SPEC_KIOSK.md §17); both off by default. */}
        <SwitchField path="general.blockWhenOffline" label={tf('general.blockWhenOffline')} hint={t('blockWhenOfflineHint')} />
        <SwitchField path="general.offlineNotice" label={tf('general.offlineNotice')} hint={t('offlineNoticeHint')} />
        <SegmentField
          path="general.soldOutMode"
          label={tf('general.soldOutMode')}
          options={[
            { value: 'disable', label: t('soldOutDisable') },
            { value: 'hide', label: t('soldOutHide') },
          ]}
        />
      </SectionCard>
    </div>
  );
}
