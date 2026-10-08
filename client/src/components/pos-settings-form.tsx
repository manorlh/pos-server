'use client';

import { useState, type ReactNode } from 'react';
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
import { AUTO_REOPEN_DEFAULT, AUTO_REOPEN_MODES, type AutoReopenMode } from '@/lib/availabilityReopen';
import { TIP_PRESETS_MAX } from '@/lib/types';
import type { PosSettingsPatch, PosSettingsV1, ResettableSwitchKey, SettingsLevel } from '@/lib/types';
import { PaymentIntegrationSection } from '@/components/payment-integration-section';
import { PaymentDevicesSettingsSection } from '@/components/dashboard/payment-devices/payment-devices-settings-section';

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
  /**
   * The layer edited and its id: the payment-integration section then reads what the
   * server knows (a till's hardware, saved secrets, what it charges on). Optional.
   */
  settingsLevel?: SettingsLevel;
  entityId?: string | null;
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
  settingsLevel,
  entityId,
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

      {/* "פתיחת פריטים אוטומטית אחרי Z" (lib/availabilityReopen.ts; also on the stock page,
          per point of sale). "ירושה" sends null: this layer stops setting it. */}
      <div className="space-y-1">
        <Label>
          {t('autoReopenAfterZ')}
          {overrideBadge('autoReopenAfterZ')}
        </Label>
        {(() => {
          const label = (m: AutoReopenMode) => t(`autoReopen_${m}`);
          const items = [
            {
              value: 'inherit',
              label: t('autoReopenInherit', { value: label(inherited?.autoReopenAfterZ ?? AUTO_REOPEN_DEFAULT) }),
            },
            ...AUTO_REOPEN_MODES.map((m) => ({ value: m, label: label(m) })),
          ];
          return (
            <Select
              value={value.autoReopenAfterZ ?? 'inherit'}
              onValueChange={(v) =>
                set('autoReopenAfterZ', v === 'inherit' ? null : (v as AutoReopenMode))
              }
              items={items}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.value} value={i.value} label={i.label}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        })()}
        <p className="text-xs text-muted-foreground">{t('autoReopenDesc')}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <Label>
            {t('autoReopenIgnoreStock')}
            {overrideBadge('autoReopenIgnoreStock')}
          </Label>
          <p className="text-xs text-muted-foreground">{t('autoReopenIgnoreStockDesc')}</p>
          {inheritedHint('autoReopenIgnoreStock', onOff)}
          {typeof value.autoReopenIgnoreStock === 'boolean' ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0 text-xs"
              onClick={() => set('autoReopenIgnoreStock', null)}
            >
              {t('payResetToInherited')}
            </Button>
          ) : null}
        </div>
        <Switch
          checked={value.autoReopenIgnoreStock ?? inherited?.autoReopenIgnoreStock === true}
          onCheckedChange={(c) => set('autoReopenIgnoreStock', c)}
        />
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
          // Whether the option asks for a tip is set in the tips section below, with
          // the percentages it would offer — one place for everything about tips.
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

        {/* Where the till asks: one switch per payment option. A hidden option's
            switch is left as stored, so showing the option again brings it back. */}
        <div className="space-y-2">
          <p className="text-sm">{t('tipsAskOn')}</p>
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
              <div key={opt.id} className="flex items-center justify-between gap-4">
                <div>
                  <Label className={allowed ? undefined : 'text-muted-foreground'}>
                    {t(opt.labelKey)}
                    {overrideBadge(opt.tipsKey)}
                  </Label>
                  {inheritedHint(opt.tipsKey, onOff)}
                  {resetToInherited(opt.tipsKey)}
                  {!allowed ? (
                    <p className="text-xs text-muted-foreground">{t('payTipsHiddenHint')}</p>
                  ) : null}
                </div>
                <Switch
                  checked={tips}
                  disabled={!allowed}
                  onCheckedChange={(c) => set(opt.tipsKey, c)}
                />
              </div>
            );
          })}
        </div>

        <div className="space-y-1">
          <Label>
            {t('tipPromptText')}
            {overrideBadge('tipPromptText')}
          </Label>
          <Input
            maxLength={80}
            placeholder={placeholderFor('tipPromptText', value, inherited) || t('tipPromptTextDefault')}
            value={value.tipPromptText ?? ''}
            onChange={(e) => set('tipPromptText', e.target.value === '' ? undefined : e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('tipPromptTextDesc')}</p>
          {inheritedHint('tipPromptText')}
          {value.tipPromptText != null && showOverrideHints ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0 text-xs"
              onClick={() => set('tipPromptText', null)}
            >
              {t('payResetToInherited')}
            </Button>
          ) : null}
        </div>

        <TipPresetsEditor
          value={value.tipPresets}
          inherited={inherited?.tipPresets}
          onChange={(next) => set('tipPresets', next)}
          badge={overrideBadge('tipPresets')}
          showInherited={!!showOverrideHints && !!inherited}
        />

        <div className="space-y-1">
          <Label>
            {t('tipDistribution')}
            {overrideBadge('tipDistribution')}
          </Label>
          {value.tipDistribution != null && showOverrideHints ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0 text-xs"
              onClick={() => set('tipDistribution', null)}
            >
              {t('payResetToInherited')}
            </Button>
          ) : null}
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

      {/* The card terminal each till must be on: one number for the whole shop, or a
          till's own in that till's settings. The till checks it against Agamento. */}
      <div className="border-t pt-4 space-y-2">
        <p className="text-sm font-medium">{t('terminalTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('terminalDesc')}</p>
        <Label>
          {t('terminalNumber')}
          {overrideBadge('expectedTerminalNumber')}
        </Label>
        <Input
          dir="ltr"
          inputMode="numeric"
          className="font-mono"
          placeholder={placeholderFor('expectedTerminalNumber', value, inherited)}
          value={value.expectedTerminalNumber ?? ''}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 20);
            set('expectedTerminalNumber', v === '' ? undefined : v);
          }}
        />
        {inheritedHint('expectedTerminalNumber')}
        {value.expectedTerminalNumber != null && showOverrideHints ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-0 text-xs"
            onClick={() => set('expectedTerminalNumber', null)}
          >
            {t('payResetToInherited')}
          </Button>
        ) : null}
        {/* Off unless some level turns it on; `null` hands the choice back to the parent. */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label>
              {t('forceTerminalNumber')}
              {overrideBadge('forceTerminalNumber')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('forceTerminalNumberDesc')}</p>
            {inheritedHint('forceTerminalNumber', onOff)}
            {typeof value.forceTerminalNumber === 'boolean' && showOverrideHints ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs"
                onClick={() => set('forceTerminalNumber', null)}
              >
                {t('payResetToInherited')}
              </Button>
            ) : null}
          </div>
          <Switch
            checked={value.forceTerminalNumber ?? inherited?.forceTerminalNumber === true}
            onCheckedChange={(c) => set('forceTerminalNumber', c)}
          />
        </div>
        <Label>
          {t('clearingServer')}
          {overrideBadge('clearingServer')}
        </Label>
        <Select
          value={value.clearingServer ?? inherited?.clearingServer ?? ''}
          onValueChange={(v) =>
            set('clearingServer', v as PosSettingsFormState['clearingServer'])
          }
          items={[
            { value: '', label: t('clearingServerKeep') },
            { value: 'SHVA', label: t('clearingServerShva') },
            { value: 'PELECARD', label: t('clearingServerPelecard') },
          ]}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="" label={t('clearingServerKeep')}>{t('clearingServerKeep')}</SelectItem>
            <SelectItem value="SHVA" label={t('clearingServerShva')}>{t('clearingServerShva')}</SelectItem>
            <SelectItem value="PELECARD" label={t('clearingServerPelecard')}>{t('clearingServerPelecard')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('clearingServerDesc')}</p>
        {inheritedHint('clearingServer')}
        {value.clearingServer != null && showOverrideHints ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-0 text-xs"
            onClick={() => set('clearingServer', null)}
          >
            {t('payResetToInherited')}
          </Button>
        ) : null}
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

      {/* "סוג אינטגרציית אשראי" and the fields of the type chosen (Nayax's address
          among them). The older `nayaxEnabled` switch is gone: choosing Nayax is the way
          now, though "אוטומטי" with it on still means Nayax. */}
      <PaymentIntegrationSection
        value={value}
        onChange={onChange}
        inherited={inherited}
        showOverrideHints={showOverrideHints}
        settingsLevel={settingsLevel}
        entityId={entityId}
      />

      {/* "מכשירי תשלום": a shop's / a till's switch and default device (a till without
          built-in clearing choosing between several payment devices). */}
      <PaymentDevicesSettingsSection
        value={value}
        onChange={onChange}
        inherited={inherited}
        settingsLevel={settingsLevel}
        entityId={entityId}
      />

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

/** What the till offers when no layer sets any percentages (its own default). */
const TILL_DEFAULT_TIP_PRESETS = [10, 12, 15];

/**
 * The tip percentages of one layer, as the till's square buttons.
 *
 * `undefined`/`null` = this layer sets none and inherits (shown greyed, from the layer
 * above, or the till's default); a list = this layer's own, in the order the till shows
 * them; `[]` = deliberately none, so the till asks for no tip. The same rules as the
 * server (TIP_PRESETS_MAX, 1–100, no repeats) are checked here so a save is not refused.
 */
function TipPresetsEditor({
  value,
  inherited,
  onChange,
  badge,
  showInherited,
}: {
  value: number[] | null | undefined;
  inherited?: number[];
  onChange: (next: number[] | null) => void;
  badge: ReactNode;
  showInherited: boolean;
}) {
  const t = useTranslations('posSettings');
  const [draft, setDraft] = useState('');
  const own = value ?? null;
  const shown = own ?? inherited ?? TILL_DEFAULT_TIP_PRESETS;
  const isInherited = own === null;

  const n = Number(draft);
  const draftError =
    draft.trim() === ''
      ? null
      : !Number.isInteger(n) || n < 1 || n > 100
        ? t('tipPresetsRange')
        : shown.includes(n)
          ? t('tipPresetsRepeat')
          : shown.length >= TIP_PRESETS_MAX
            ? t('tipPresetsMax', { max: TIP_PRESETS_MAX })
            : null;

  const add = () => {
    if (draft.trim() === '' || draftError) return;
    // Adding to an inherited list starts this layer's own list from it, so the
    // operator edits what they see rather than an empty list.
    const base = own ?? [...shown];
    if (base.includes(n) || base.length >= TIP_PRESETS_MAX) return;
    onChange([...base, n]);
    setDraft('');
  };

  const remove = (p: number) => onChange((own ?? [...shown]).filter((x) => x !== p));

  return (
    <div className="space-y-2">
      <Label>
        {t('tipPresets')}
        {badge}
      </Label>
      <p className="text-xs text-muted-foreground">
        {t('tipPresetsDesc', { max: TIP_PRESETS_MAX })}
      </p>

      {/* The till's tip screen, in miniature: one square per percentage. */}
      {shown.length > 0 ? (
        <div className={`grid gap-2 ${shown.length === 2 || shown.length === 4 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {shown.map((p) => (
            <div
              key={p}
              className={`relative aspect-square rounded-lg border flex items-center justify-center text-xl font-semibold ${
                isInherited ? 'bg-muted text-muted-foreground' : 'bg-primary/10'
              }`}
            >
              <span dir="ltr">{p}%</span>
              <button
                type="button"
                aria-label={t('tipPresetsRemove', { value: p })}
                className="absolute top-1 end-1 rounded px-1 text-sm text-muted-foreground hover:text-destructive"
                onClick={() => remove(p)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-amber-700 dark:text-amber-400">{t('tipPresetsNone')}</p>
      )}
      {isInherited && showInherited ? (
        <p className="text-xs text-muted-foreground">
          {t('inherited', { value: shown.map((p) => `${p}%`).join(', ') || '—' })}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          placeholder={t('tipPresetsAddPlaceholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" variant="outline" onClick={add} disabled={!!draftError || draft.trim() === ''}>
          {t('tipPresetsAdd')}
        </Button>
      </div>
      {draftError ? <p className="text-xs text-destructive">{draftError}</p> : null}

      <div className="flex flex-wrap gap-x-4">
        {!isInherited && showInherited ? (
          <Button type="button" variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => onChange(null)}>
            {t('payResetToInherited')}
          </Button>
        ) : null}
        {shown.length > 0 ? (
          <Button type="button" variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => onChange([])}>
            {t('tipPresetsClear')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
