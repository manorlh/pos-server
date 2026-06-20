'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import type { PosSettingsV1 } from '@/lib/types';

export type PosSettingsFormState = PosSettingsV1;

type Props = {
  value: PosSettingsFormState;
  onChange: (next: PosSettingsFormState) => void;
  /** When set, empty fields show inherited effective values (shop override UX). */
  inherited?: PosSettingsV1;
  showOverrideHints?: boolean;
};

function isOverridden(
  key: keyof PosSettingsV1,
  value: PosSettingsFormState,
  inherited?: PosSettingsV1,
): boolean {
  if (!inherited) return false;
  return value[key] !== undefined && value[key] !== null && value[key] !== '';
}

function placeholderFor<K extends keyof PosSettingsV1>(
  key: K,
  value: PosSettingsFormState,
  inherited?: PosSettingsV1,
): string {
  if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
    return String(value[key]);
  }
  const inh = inherited?.[key];
  if (inh !== undefined && inh !== null && inh !== '') {
    return String(inh);
  }
  return '';
}

export function PosSettingsForm({ value, onChange, inherited, showOverrideHints }: Props) {
  const t = useTranslations('posSettings');

  const set = <K extends keyof PosSettingsV1>(key: K, v: PosSettingsV1[K]) => {
    onChange({ ...value, [key]: v });
  };

  const overrideBadge = (key: keyof PosSettingsV1) =>
    showOverrideHints && isOverridden(key, value, inherited) ? (
      <Badge variant="secondary" className="text-xs ms-2">
        {t('override')}
      </Badge>
    ) : null;

  const inheritedHint = (key: keyof PosSettingsV1) => {
    if (!showOverrideHints || !inherited) return null;
    const inh = inherited[key];
    if (inh === undefined || inh === null || inh === '') return null;
    if (isOverridden(key, value, inherited)) return null;
    return (
      <p className="text-xs text-muted-foreground">{t('inherited', { value: String(inh) })}</p>
    );
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>
          {t('taxRate')}
          {overrideBadge('globalTaxRate')}
        </Label>
        <Input
          type="number"
          min={0}
          max={100}
          placeholder={placeholderFor('globalTaxRate', value, inherited) || '18'}
          value={value.globalTaxRate ?? ''}
          onChange={(e) =>
            set('globalTaxRate', e.target.value === '' ? undefined : Number(e.target.value))
          }
        />
        {inheritedHint('globalTaxRate')}
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <Label>
            {t('hideOutOfStock')}
            {overrideBadge('hideOutOfStockProducts')}
          </Label>
          {inheritedHint('hideOutOfStockProducts')}
        </div>
        <Switch
          checked={
            value.hideOutOfStockProducts ??
            (inherited?.hideOutOfStockProducts === true)
          }
          onCheckedChange={(c) => set('hideOutOfStockProducts', c)}
        />
      </div>

      <div className="space-y-1">
        <Label>
          {t('language')}
          {overrideBadge('language')}
        </Label>
        <Select
          value={value.language ?? inherited?.language ?? 'he'}
          onValueChange={(v) => set('language', v as 'he' | 'en')}
          items={[
            { value: 'he', label: t('langHe') },
            { value: 'en', label: t('langEn') },
          ]}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="he" label={t('langHe')}>{t('langHe')}</SelectItem>
            <SelectItem value="en" label={t('langEn')}>{t('langEn')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border-t pt-4 space-y-3">
        <p className="text-sm font-medium">{t('nayaxTitle')}</p>
        <div className="flex items-center justify-between gap-4">
          <Label>
            {t('nayaxEnabled')}
            {overrideBadge('nayaxEnabled')}
          </Label>
          <Switch
            checked={value.nayaxEnabled ?? inherited?.nayaxEnabled ?? false}
            onCheckedChange={(c) => set('nayaxEnabled', c)}
          />
        </div>
        <div className="space-y-1">
          <Label>
            {t('nayaxHost')}
            {overrideBadge('nayaxDeviceHost')}
          </Label>
          <Input
            placeholder={placeholderFor('nayaxDeviceHost', value, inherited)}
            value={value.nayaxDeviceHost ?? ''}
            onChange={(e) => set('nayaxDeviceHost', e.target.value || undefined)}
          />
          {inheritedHint('nayaxDeviceHost')}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>
              {t('nayaxPort')}
              {overrideBadge('nayaxDevicePort')}
            </Label>
            <Input
              placeholder={placeholderFor('nayaxDevicePort', value, inherited) || '8080'}
              value={value.nayaxDevicePort ?? ''}
              onChange={(e) => set('nayaxDevicePort', e.target.value || undefined)}
            />
          </div>
          <div className="space-y-1">
            <Label>
              {t('nayaxPath')}
              {overrideBadge('nayaxSpicyPath')}
            </Label>
            <Input
              placeholder={placeholderFor('nayaxSpicyPath', value, inherited) || '/SPICy'}
              value={value.nayaxSpicyPath ?? ''}
              onChange={(e) => set('nayaxSpicyPath', e.target.value || undefined)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
