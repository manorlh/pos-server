'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  PAYMENT_OPTIONS,
  PAYMENT_OPTION_FALLBACK,
  noPaymentOptionAllowed,
  resolvePaymentOptionKey,
} from '@/lib/paymentOptions';
import { SELL_SCREEN_TOOLS, SELL_SCREEN_TOOL_DEFAULT } from '@/lib/sellScreen';
import { REFUND_SETTINGS, REFUND_SETTING_DEFAULT } from '@/lib/refundSettings';
import type { PosSettingsPatch, PosSettingsV1, ResettableSwitchKey } from '@/lib/types';

/**
 * A patch, not plain settings, so a payment-option or sell-screen key can hold `null`
 * (= inherit again).
 */
export type PosSettingsFormState = PosSettingsPatch;

type Props = {
  value: PosSettingsFormState;
  onChange: (next: PosSettingsFormState) => void;
  /** When set, empty fields show inherited effective values (shop override UX). */
  inherited?: PosSettingsV1;
  showOverrideHints?: boolean;
  /** The server refused the last save because no payment option was left allowed. */
  paymentOptionsRejected?: boolean;
  /**
   * Show the settings that exist only at the tenant level (the Z scope). The server
   * refuses them on a company or shop, so they are not offered there.
   */
  tenantLevel?: boolean;
  /** May change the Z scope (distributor / super admin); otherwise it is shown read-only. */
  zScopeEditable?: boolean;
};

const Z_SCOPES = ['shop', 'machine'] as const;

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

export function PosSettingsForm({
  value,
  onChange,
  inherited,
  showOverrideHints,
  paymentOptionsRejected,
  tenantLevel,
  zScopeEditable = false,
}: Props) {
  const t = useTranslations('posSettings');

  const set = <K extends keyof PosSettingsFormState>(key: K, v: PosSettingsFormState[K]) => {
    onChange({ ...value, [key]: v });
  };

  const overrideBadge = (key: keyof PosSettingsV1) =>
    showOverrideHints && isOverridden(key, value, inherited) ? (
      <Badge variant="secondary" className="text-xs ms-2">
        {t('override')}
      </Badge>
    ) : null;

  const inheritedHint = (
    key: keyof PosSettingsV1,
    format: (inh: NonNullable<PosSettingsV1[keyof PosSettingsV1]>) => string = String,
  ) => {
    if (!showOverrideHints || !inherited) return null;
    const inh = inherited[key];
    if (inh === undefined || inh === null || inh === '') return null;
    if (isOverridden(key, value, inherited)) return null;
    return (
      <p className="text-xs text-muted-foreground">{t('inherited', { value: format(inh) })}</p>
    );
  };

  const onOff = (inh: unknown) => t(inh === true ? 'payOn' : 'payOff');

  // A switch has no empty state to clear, so a layer that set one of these keys
  // needs an explicit way back to inheriting it. `null` is what the PATCH reads
  // as "unset this layer", as it does for branding.
  const resetToInherited = (key: ResettableSwitchKey) =>
    typeof value[key] === 'boolean' ? (
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto px-0 text-xs"
        onClick={() => set(key, null)}
      >
        {t('payResetToInherited')}
      </Button>
    ) : null;

  const noneAllowed = noPaymentOptionAllowed(value, inherited);

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

      <div className="space-y-1">
        <Label>
          {t('outOfStockPolicy')}
          {overrideBadge('outOfStockPolicy')}
        </Label>
        <Select
          value={value.outOfStockPolicy ?? inherited?.outOfStockPolicy ?? 'allow'}
          onValueChange={(v) =>
            set('outOfStockPolicy', v as PosSettingsFormState['outOfStockPolicy'])
          }
          items={[
            { value: 'allow', label: t('oosAllow') },
            { value: 'warn', label: t('oosWarn') },
            { value: 'block', label: t('oosBlock') },
          ]}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="allow" label={t('oosAllow')}>{t('oosAllow')}</SelectItem>
            <SelectItem value="warn" label={t('oosWarn')}>{t('oosWarn')}</SelectItem>
            <SelectItem value="block" label={t('oosBlock')}>{t('oosBlock')}</SelectItem>
          </SelectContent>
        </Select>
        {inheritedHint('outOfStockPolicy')}
      </div>

      <div className="border-t pt-4 space-y-3">
        <div>
          <p className="text-sm font-medium">{t('sellScreenTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('sellScreenDesc')}</p>
        </div>
        {SELL_SCREEN_TOOLS.map((tool) => (
          <div key={tool.id} className="flex items-center justify-between gap-4">
            <div>
              <Label>
                {t(tool.labelKey)}
                {overrideBadge(tool.key)}
              </Label>
              <p className="text-xs text-muted-foreground">{t(tool.descriptionKey)}</p>
              {inheritedHint(tool.key, onOff)}
              {resetToInherited(tool.key)}
            </div>
            <Switch
              checked={resolvePaymentOptionKey(
                tool.key,
                value,
                inherited,
                SELL_SCREEN_TOOL_DEFAULT,
              )}
              onCheckedChange={(c) => set(tool.key, c)}
            />
          </div>
        ))}
      </div>

      <div className="border-t pt-4 space-y-3">
        <div>
          <p className="text-sm font-medium">{t('refundsTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('refundsDesc')}</p>
        </div>
        {REFUND_SETTINGS.map((setting) => (
          <div key={setting.key} className="flex items-center justify-between gap-4">
            <div>
              <Label>
                {t(setting.labelKey)}
                {overrideBadge(setting.key)}
              </Label>
              <p className="text-xs text-muted-foreground">{t(setting.descriptionKey)}</p>
              {inheritedHint(setting.key, onOff)}
              {resetToInherited(setting.key)}
            </div>
            <Switch
              checked={resolvePaymentOptionKey(
                setting.key,
                value,
                inherited,
                REFUND_SETTING_DEFAULT,
              )}
              onCheckedChange={(c) => set(setting.key, c)}
            />
          </div>
        ))}
      </div>

      <div className="border-t pt-4 space-y-3">
        <div>
          <p className="text-sm font-medium">{t('payOptionsTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('payOptionsDesc')}</p>
        </div>
        {PAYMENT_OPTIONS.map((opt) => {
          const allowed = resolvePaymentOptionKey(
            opt.enabledKey,
            value,
            inherited,
            opt.enabledByDefault,
          );
          const tips = resolvePaymentOptionKey(
            opt.tipsKey,
            value,
            inherited,
            PAYMENT_OPTION_FALLBACK.tips,
          );
          return (
            <div key={opt.id} className="rounded-lg border p-3 space-y-2">
              <div>
                <p className="text-sm font-medium">{t(opt.labelKey)}</p>
                <p className="text-xs text-muted-foreground">{t(opt.descriptionKey)}</p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label>
                    {t('payAllowed')}
                    {overrideBadge(opt.enabledKey)}
                  </Label>
                  {inheritedHint(opt.enabledKey, onOff)}
                  {resetToInherited(opt.enabledKey)}
                </div>
                <Switch checked={allowed} onCheckedChange={(c) => set(opt.enabledKey, c)} />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label className={allowed ? undefined : 'text-muted-foreground'}>
                    {t('payTips')}
                    {overrideBadge(opt.tipsKey)}
                  </Label>
                  {inheritedHint(opt.tipsKey, onOff)}
                  {resetToInherited(opt.tipsKey)}
                  {!allowed ? (
                    <p className="text-xs text-muted-foreground">{t('payTipsHiddenHint')}</p>
                  ) : null}
                </div>
                {/* Left as stored while the option is hidden, so turning the
                    option back on brings the earlier tip choice back with it. */}
                <Switch
                  checked={tips}
                  disabled={!allowed}
                  onCheckedChange={(c) => set(opt.tipsKey, c)}
                />
              </div>
            </div>
          );
        })}
        {noneAllowed || paymentOptionsRejected ? (
          <p role="alert" className="text-sm text-destructive">
            {t('payNoneAllowed')}
          </p>
        ) : null}
      </div>

      <div className="border-t pt-4 space-y-3">
        <div>
          <p className="text-sm font-medium">{t('tipsTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('tipsAppliesTo')}</p>
        </div>
        <div className="space-y-1">
          <Label>
            {t('tipPresets')}
            {overrideBadge('tipPresets')}
          </Label>
          <Input
            placeholder={
              (inherited?.tipPresets ?? [10, 12, 15]).join(', ')
            }
            value={
              value.tipPresets !== undefined
                ? value.tipPresets.join(', ')
                : ''
            }
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (!raw) {
                set('tipPresets', undefined);
                return;
              }
              const nums = raw
                .split(',')
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 100);
              set('tipPresets', nums.length ? nums : undefined);
            }}
          />
          {inheritedHint('tipPresets')}
        </div>
        <div className="space-y-1">
          <Label>
            {t('tipDistribution')}
            {overrideBadge('tipDistribution')}
          </Label>
          <Select
            value={value.tipDistribution ?? inherited?.tipDistribution ?? 'direct'}
            onValueChange={(v) =>
              set('tipDistribution', v as PosSettingsFormState['tipDistribution'])
            }
            items={[
              { value: 'direct', label: t('distDirect') },
              { value: 'equal_pool', label: t('distEqual') },
              { value: 'by_sales', label: t('distBySales') },
            ]}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="direct" label={t('distDirect')}>{t('distDirect')}</SelectItem>
              <SelectItem value="equal_pool" label={t('distEqual')}>{t('distEqual')}</SelectItem>
              <SelectItem value="by_sales" label={t('distBySales')}>{t('distBySales')}</SelectItem>
            </SelectContent>
          </Select>
          {inheritedHint('tipDistribution')}
        </div>
      </div>

      <div className="border-t pt-4 space-y-3">
        <p className="text-sm font-medium">{t('printersTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('printersDesc')}</p>
        <div className="space-y-1">
          <Label>
            {t('receiptPrinter')}
            {overrideBadge('receiptPrinterName')}
          </Label>
          <Input
            placeholder={placeholderFor('receiptPrinterName', value, inherited) || 'BB'}
            value={value.receiptPrinterName ?? ''}
            onChange={(e) => set('receiptPrinterName', e.target.value || undefined)}
          />
          {inheritedHint('receiptPrinterName')}
        </div>
        <div className="space-y-1">
          <Label>
            {t('drawerPrinter')}
            {overrideBadge('drawerPrinterName')}
          </Label>
          <Input
            placeholder={placeholderFor('drawerPrinterName', value, inherited) || 'BBILL'}
            value={value.drawerPrinterName ?? ''}
            onChange={(e) => set('drawerPrinterName', e.target.value || undefined)}
          />
          {inheritedHint('drawerPrinterName')}
        </div>
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

      {/* How the tenant's Zs are produced. One choice for the whole tenant, read by the
          Z wizard and enforced by POST /z-runs (422 z_scope_machine_one_till). */}
      {tenantLevel ? (
        <div className="border-t pt-4 space-y-3">
          <div>
            <p className="text-sm font-medium">{t('zScopeTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('zScopeDesc')}</p>
          </div>
          <div role="radiogroup" aria-label={t('zScopeTitle')} className="space-y-2">
            {Z_SCOPES.map((scope) => {
              const selected = (value.zScope ?? 'shop') === scope;
              const label = scope === 'shop' ? t('zScopeShop') : t('zScopeMachine');
              const desc = scope === 'shop' ? t('zScopeShopDesc') : t('zScopeMachineDesc');
              return (
                <button
                  key={scope}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!zScopeEditable}
                  onClick={() => set('zScope', scope)}
                  className={`w-full rounded-md border px-3 py-2 text-start transition-colors disabled:cursor-not-allowed ${
                    selected ? 'border-primary bg-primary/5' : 'enabled:hover:bg-muted/40'
                  } ${!zScopeEditable && !selected ? 'opacity-60' : ''}`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span
                      aria-hidden
                      className={`inline-block h-3.5 w-3.5 shrink-0 rounded-full border ${
                        selected ? 'border-primary bg-primary' : 'border-muted-foreground'
                      }`}
                    />
                    {label}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{desc}</span>
                </button>
              );
            })}
          </div>
          {!zScopeEditable ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">{t('zScopeReadOnly')}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t('zScopeLegal')}</p>
          <p className="text-xs text-muted-foreground">{t('zScopeTenantWide')}</p>
        </div>
      ) : null}
    </div>
  );
}
