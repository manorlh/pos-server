'use client';

/**
 * "סוג אינטגרציית אשראי" on one settings layer: the type, and exactly the fields that type
 * needs, checked as the server checks them (lib/paymentIntegration.ts). It edits the same
 * form state as the rest of PosSettingsForm; the Z-Credit secrets are write-only — typed
 * here, sent once, and afterwards only said to be saved ("••••").
 *
 * With a level and an id it reads GET /payment-integration/context: whether a till has a
 * terminal of its own (a tablet may only pick an external one), what is inherited and from
 * where, which secrets some layer holds, and for a till what it charges on now and what is
 * missing. Without them it still works, minus those.
 */

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  FIELD_LABELS,
  FORM_FIELDS,
  INTEGRATION_LABELS,
  LEVEL_LABELS,
  NAYAX_DEFAULT_PATH,
  NAYAX_DEFAULT_PORT,
  PI_TEXT,
  REQUIRED_FIELDS,
  SECRET_MASK,
  SYNQPAY_ADDRESSED,
  SYNQPAY_CONNECTIONS,
  SYNQPAY_CONNECTION_LABELS,
  SYNQPAY_MODELS,
  SYNQPAY_MODEL_LABELS,
  SYNQPAY_PROTOCOLS,
  SYNQPAY_PROTOCOL_LABELS,
  ZCREDIT_MODES,
  ZCREDIT_MODE_LABELS,
  cleanIntegration,
  formEffectiveIntegration,
  formSynqpayConnection,
  synqpayDefaultPort,
  synqpayWarnings,
  hasPaymentIntegrationErrors,
  inheritedLabel,
  inheritedValueLabel,
  integrationOptions,
  isTypedSecret,
  missingFieldsLabel,
  missingRequiredFields,
  secretSavedLabel,
  validatePaymentIntegration,
  type FormIntegration,
  type PaymentFieldKey,
  type PaymentIntegration,
  type PaymentIntegrationErrors,
  type PaymentIntegrationInherited,
  type PaymentSecretKey,
  type SecretStatus,
  type SettingsLevelName,
} from '@/lib/paymentIntegration';
import {
  fetchPaymentIntegrationContext,
  paymentIntegrationContextKey,
  type PaymentIntegrationContext,
} from '@/lib/paymentIntegrationApi';
import type { PosSettingsPatch, PosSettingsV1 } from '@/lib/types';

// ── State the dialog shares with the section ──────────────────────────────────

/** The layer's context, shared (one request) by the section and its dialog. */
export function usePaymentIntegrationContext(
  level: SettingsLevelName | null | undefined,
  entityId: string | null | undefined,
  enabled = true,
) {
  return useQuery<PaymentIntegrationContext>({
    queryKey: paymentIntegrationContextKey(level ?? 'tenant', entityId ?? ''),
    queryFn: () => fetchPaymentIntegrationContext(level!, entityId!),
    enabled: enabled && !!level && !!entityId,
    retry: 1,
  });
}

export interface PaymentIntegrationValidation {
  errors: PaymentIntegrationErrors;
  valid: boolean;
  /** The type the layer ends up on (its own, inherited or automatic). */
  integration: FormIntegration;
  /** Above a till: the required fields nothing gives yet (a till may still complete them). */
  missing: PaymentFieldKey[];
  context: PaymentIntegrationContext | undefined;
  contextError: boolean;
}

/** What the layer inherits for this feature: the settings preview, the type from the context. */
function inheritedFor(
  inherited: PosSettingsV1 | undefined,
  context: PaymentIntegrationContext | undefined,
): PaymentIntegrationInherited {
  return {
    paymentIntegration: context ? context.inherited?.integration ?? null : inherited?.paymentIntegration ?? null,
    nayaxEnabled: inherited?.nayaxEnabled ?? null,
    nayaxDeviceHost: inherited?.nayaxDeviceHost ?? null,
    nayaxDevicePort: inherited?.nayaxDevicePort ?? null,
    nayaxSpicyPath: inherited?.nayaxSpicyPath ?? null,
    zcreditTerminalNumber: inherited?.zcreditTerminalNumber ?? null,
    zcreditPinpadId: inherited?.zcreditPinpadId ?? null,
    zcreditMode: inherited?.zcreditMode ?? null,
    synqpayDeviceModel: inherited?.synqpayDeviceModel ?? null,
    synqpayConnection: inherited?.synqpayConnection ?? null,
    synqpayHost: inherited?.synqpayHost ?? null,
    synqpayProtocol: inherited?.synqpayProtocol ?? null,
    synqpayPort: inherited?.synqpayPort ?? null,
    synqpayTls: inherited?.synqpayTls ?? null,
    synqpayUsbDevice: inherited?.synqpayUsbDevice ?? null,
    synqpaySerialNumber: inherited?.synqpaySerialNumber ?? null,
  };
}

/**
 * Whether the layer's payment part may be saved, with the errors to show. The dialog
 * uses it to disable Save; the section to show the same errors next to their fields.
 * Required fields are enforced on a till only — above it a PinPad id or an address is
 * often per till, so they are listed, not refused.
 */
export function usePaymentIntegrationValidation({
  level,
  entityId,
  value,
  inherited,
  enabled = true,
}: {
  level?: SettingsLevelName | null;
  entityId?: string | null;
  value: PosSettingsPatch;
  inherited?: PosSettingsV1;
  enabled?: boolean;
}): PaymentIntegrationValidation {
  const query = usePaymentIntegrationContext(level, entityId, enabled);
  const context = query.data;
  const inh = inheritedFor(inherited, context);
  const hasBuiltinTerminal = context?.hasBuiltinTerminal ?? null;
  const secrets = context?.secrets ?? null;
  const errors = validatePaymentIntegration(value, inh, secrets, {
    requireAll: level === 'machine',
    hasBuiltinTerminal,
  });
  const integration = formEffectiveIntegration(value, inh, hasBuiltinTerminal);
  const missing = level === 'machine' ? [] : missingRequiredFields(integration.effective, value, inh, secrets);
  return {
    errors,
    valid: !hasPaymentIntegrationErrors(errors),
    integration,
    missing,
    context,
    contextError: query.isError,
  };
}

// ── The section ───────────────────────────────────────────────────────────────

type Props = {
  value: PosSettingsPatch;
  onChange: (next: PosSettingsPatch) => void;
  /** What the layers above give (the settings GET's `effective`). */
  inherited?: PosSettingsV1;
  showOverrideHints?: boolean;
  /** The layer edited; with `entityId`, turns on the context (hardware, secrets, resolution). */
  settingsLevel?: SettingsLevelName;
  entityId?: string | null;
};

const HINT = 'text-xs text-muted-foreground';
const ERROR = 'text-xs text-destructive';
const WARN = 'text-xs text-amber-700 dark:text-amber-400';

export function PaymentIntegrationSection({
  value,
  onChange,
  inherited,
  showOverrideHints,
  settingsLevel,
  entityId,
}: Props) {
  const v = usePaymentIntegrationValidation({ level: settingsLevel, entityId, value, inherited });
  const { errors, context, integration } = v;
  const inh = inheritedFor(inherited, context);
  const hasBuiltinTerminal = context?.hasBuiltinTerminal ?? null;
  const options = integrationOptions(
    { hasBuiltinTerminal, hasNfc: context?.hasNfc ?? null },
    context?.options,
  );
  // A value this layer holds that the till may not use (a stored "built-in" on a tablet)
  // stays in the list, disabled, so the select can still show it.
  const visible = options.filter((o) => !o.hidden || o.value === integration.selected);
  const ownIntegration = cleanIntegration(value.paymentIntegration);
  const hasOwnChoice = ownIntegration !== null && ownIntegration !== 'auto';
  const inheritedSource = context?.inherited?.source ?? null;
  const shownFields = FORM_FIELDS[integration.effective];

  const set = (patch: Partial<PosSettingsPatch>) => onChange({ ...value, ...patch });
  /** A cleared field is `null`: the PATCH then drops this layer's value and the parent's shows. */
  const setText = (key: PaymentFieldKey, text: string) =>
    set({ [key]: text === '' ? null : text } as Partial<PosSettingsPatch>);

  const ownText = (key: PaymentFieldKey): string => {
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  };
  const inheritedText = (key: keyof PaymentIntegrationInherited): string | null => {
    const raw = inh[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw;
    if (typeof raw === 'number') return String(raw);
    return null;
  };
  const required = (key: PaymentFieldKey) =>
    integration.effective !== 'auto' && REQUIRED_FIELDS[integration.effective].includes(key);

  const fieldLabel = (key: PaymentFieldKey) => (
    <Label htmlFor={`pi-${key}`}>
      {FIELD_LABELS[key]}
      {required(key) ? (
        <span className="text-destructive" aria-hidden>
          *
        </span>
      ) : null}
      {showOverrideHints && ownText(key) !== '' ? (
        <Badge variant="secondary" className="ms-2 text-xs">
          {PI_TEXT.override}
        </Badge>
      ) : null}
    </Label>
  );
  const fieldError = (key: PaymentFieldKey) =>
    errors[key] ? (
      <p id={`pi-${key}-error`} role="alert" className={ERROR}>
        {errors[key]}
      </p>
    ) : null;
  const fieldInherited = (key: keyof PaymentIntegrationInherited) => {
    const inhValue = inheritedText(key);
    if (!inhValue || ownText(key as PaymentFieldKey) !== '') return null;
    return <p className={HINT}>{inheritedValueLabel(inhValue)}</p>;
  };

  const textField = (
    key:
      | 'nayaxDeviceHost'
      | 'nayaxDevicePort'
      | 'nayaxSpicyPath'
      | 'zcreditTerminalNumber'
      | 'zcreditPinpadId'
      | 'synqpayHost'
      | 'synqpayPort'
      | 'synqpayUsbDevice'
      | 'synqpaySerialNumber',
    opts: { placeholder?: string; hint?: string; numeric?: boolean; mono?: boolean; maxLength?: number },
  ) => (
    <div className="space-y-1">
      {fieldLabel(key)}
      <Input
        id={`pi-${key}`}
        dir="ltr"
        inputMode={opts.numeric ? 'numeric' : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={opts.maxLength}
        className={opts.mono ? 'font-mono' : undefined}
        placeholder={inheritedText(key) ?? opts.placeholder}
        value={ownText(key)}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `pi-${key}-error` : undefined}
        onChange={(e) => setText(key, e.target.value)}
      />
      {opts.hint ? <p className={HINT}>{opts.hint}</p> : null}
      {fieldInherited(key)}
      {fieldError(key)}
    </div>
  );

  // Errors on fields this type does not show (a Z-Credit value typed before switching away):
  // the server would still refuse them, so they are listed with a way to clear them.
  const hiddenErrors = (Object.keys(errors) as PaymentFieldKey[]).filter(
    (key) => key !== 'paymentIntegration' && !shownFields.includes(key),
  );

  // SynqPay: the connection decides which of its fields show; the port's placeholder is the
  // documented one for the protocol and TLS the layer ends up on.
  const synqpayConnection = formSynqpayConnection(value, inh);
  const synqpayTls = typeof value.synqpayTls === 'boolean' ? value.synqpayTls : inh.synqpayTls === true;
  const synqpayPort = synqpayDefaultPort(
    typeof value.synqpayProtocol === 'string' && value.synqpayProtocol !== '' ? value.synqpayProtocol : inh.synqpayProtocol,
    synqpayTls,
  );

  /** A select over [options] for one of SynqPay's choice fields; '' = inherit (`null` in the PATCH). */
  const choiceField = <T extends string>(
    key: 'synqpayDeviceModel' | 'synqpayConnection' | 'synqpayProtocol',
    options: readonly T[],
    labels: Record<T, string>,
    placeholder: string,
    hint?: string,
  ) => {
    const own = ownText(key);
    const inhValue = inheritedText(key);
    const items = options.map((o) => ({ value: o, label: labels[o] }));
    return (
      <div className="space-y-1">
        {fieldLabel(key)}
        <Select
          value={own}
          onValueChange={(next: unknown) =>
            set({
              [key]: typeof next === 'string' && (options as readonly string[]).includes(next) ? next : null,
            } as Partial<PosSettingsPatch>)
          }
          items={items}
        >
          <SelectTrigger id={`pi-${key}`} aria-invalid={errors[key] ? true : undefined}>
            <SelectValue
              placeholder={
                inhValue && inhValue in labels ? `${labels[inhValue as T]} ${PI_TEXT.inheritedSuffix}` : placeholder
              }
            />
          </SelectTrigger>
          <SelectContent>
            {items.map((m) => (
              <SelectItem key={m.value} value={m.value} label={m.label}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {own !== '' && showOverrideHints && inhValue ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-0 text-xs"
            onClick={() => set({ [key]: null } as Partial<PosSettingsPatch>)}
          >
            {PI_TEXT.resetToInherited}
          </Button>
        ) : null}
        {hint ? <p className={HINT}>{hint}</p> : null}
        {fieldError(key)}
      </div>
    );
  };

  const modeOwn = typeof value.zcreditMode === 'string' ? value.zcreditMode : '';
  const modeInherited = inheritedText('zcreditMode');
  const modeItems = ZCREDIT_MODES.map((m) => ({ value: m, label: ZCREDIT_MODE_LABELS[m] }));

  return (
    <div className="border-t pt-4 space-y-3">
      <div>
        <p className="text-sm font-medium">{PI_TEXT.sectionTitle}</p>
        <p className={HINT}>{PI_TEXT.sectionDesc}</p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="pi-paymentIntegration">
          {FIELD_LABELS.paymentIntegration}
          {showOverrideHints && hasOwnChoice ? (
            <Badge variant="secondary" className="ms-2 text-xs">
              {PI_TEXT.override}
            </Badge>
          ) : null}
        </Label>
        <Select
          value={integration.selected}
          onValueChange={(next) => {
            const picked = cleanIntegration(next);
            if (!picked) return;
            // `auto` is "inherit": the PATCH's null removes this layer's own choice.
            set({ paymentIntegration: picked === 'auto' ? null : picked });
          }}
          items={visible.map((o) => ({ value: o.value, label: o.label }))}
        >
          <SelectTrigger id="pi-paymentIntegration" aria-invalid={errors.paymentIntegration ? true : undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {visible.map((o) => (
              <SelectItem key={o.value} value={o.value} label={o.label} disabled={!o.selectable}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {integration.selected === 'auto' && integration.inherited ? (
          <p className={HINT}>{inheritedLabel(integration.effective, inheritedSource)}</p>
        ) : null}
        {/* A tablet: why the built-in choice is disabled — an error once it is the one chosen. */}
        {errors.paymentIntegration ? (
          <p role="alert" className={ERROR}>
            {errors.paymentIntegration}
          </p>
        ) : hasBuiltinTerminal === false ? (
          <p className={WARN}>{PI_TEXT.agamentoNeedsBuiltin}</p>
        ) : null}
      </div>

      {integration.automatic ? (
        <div className="space-y-1">
          <p className={HINT}>{PI_TEXT.autoHint}</p>
          {value.nayaxEnabled === true ? (
            <p className={WARN}>
              {PI_TEXT.autoNayaxLegacy}{' '}
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs"
                onClick={() => set({ nayaxEnabled: null })}
              >
                {PI_TEXT.autoNayaxLegacyClear}
              </Button>
            </p>
          ) : null}
        </div>
      ) : null}

      {integration.effective === 'agamento' && !integration.automatic ? (
        <p className={HINT}>{PI_TEXT.agamentoHint}</p>
      ) : null}

      {integration.effective === 'nayax_lan' ? (
        <div className="space-y-3 rounded-lg border p-3">
          <p className={HINT}>{PI_TEXT.nayaxHint}</p>
          {textField('nayaxDeviceHost', { placeholder: PI_TEXT.hostPlaceholder, hint: PI_TEXT.hostHint, maxLength: 253 })}
          <div className="grid grid-cols-2 gap-3">
            {textField('nayaxDevicePort', { placeholder: NAYAX_DEFAULT_PORT, hint: PI_TEXT.portHint, numeric: true, maxLength: 5 })}
            {textField('nayaxSpicyPath', { placeholder: NAYAX_DEFAULT_PATH, hint: PI_TEXT.pathHint, maxLength: 100 })}
          </div>
          <p className={HINT}>{PI_TEXT.nayaxHttpHint}</p>
        </div>
      ) : null}

      {integration.effective === 'zcredit' ? (
        <div className="space-y-3 rounded-lg border p-3">
          <p className={HINT}>{PI_TEXT.zcreditHint}</p>
          {textField('zcreditTerminalNumber', { hint: PI_TEXT.terminalHint, numeric: true, mono: true, maxLength: 20 })}
          <SecretField
            secretKey="zcreditPassword"
            label={fieldLabel('zcreditPassword')}
            value={value.zcreditPassword}
            status={context?.secrets?.zcreditPassword}
            error={fieldError('zcreditPassword')}
            onChange={(next) => set({ zcreditPassword: next })}
          />
          {textField('zcreditPinpadId', { placeholder: 'PINPAD100000', hint: PI_TEXT.pinpadHint, mono: true, maxLength: 38 })}
          <div className="space-y-1">
            {fieldLabel('zcreditMode')}
            <Select
              value={modeOwn}
              onValueChange={(next) =>
                set({ zcreditMode: next === 'test' || next === 'production' ? next : null })
              }
              items={modeItems}
            >
              <SelectTrigger id="pi-zcreditMode" aria-invalid={errors.zcreditMode ? true : undefined}>
                <SelectValue
                  placeholder={
                    modeInherited && modeInherited in ZCREDIT_MODE_LABELS
                      ? `${ZCREDIT_MODE_LABELS[modeInherited as 'test' | 'production']} ${PI_TEXT.inheritedSuffix}`
                      : PI_TEXT.modePlaceholder
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {modeItems.map((m) => (
                  <SelectItem key={m.value} value={m.value} label={m.label}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {modeOwn !== '' && showOverrideHints && modeInherited ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs"
                onClick={() => set({ zcreditMode: null })}
              >
                {PI_TEXT.resetToInherited}
              </Button>
            ) : null}
            {fieldError('zcreditMode')}
          </div>
          <AdvancedKey
            value={value.zcreditKey}
            status={context?.secrets?.zcreditKey}
            label={fieldLabel('zcreditKey')}
            error={fieldError('zcreditKey')}
            onChange={(next) => set({ zcreditKey: next })}
          />
        </div>
      ) : null}

      {integration.effective === 'synqpay' ? (
        <div className="space-y-3 rounded-lg border p-3">
          <p className={HINT}>{PI_TEXT.synqpayHint}</p>
          <div className="grid grid-cols-2 gap-3">
            {choiceField('synqpayDeviceModel', SYNQPAY_MODELS, SYNQPAY_MODEL_LABELS, PI_TEXT.synqpayModelPlaceholder)}
            {choiceField(
              'synqpayConnection',
              SYNQPAY_CONNECTIONS,
              SYNQPAY_CONNECTION_LABELS,
              PI_TEXT.synqpayConnectionPlaceholder,
            )}
          </div>
          {synqpayConnection !== null && SYNQPAY_ADDRESSED.includes(synqpayConnection) ? (
            <>
              {textField('synqpayHost', {
                placeholder: PI_TEXT.hostPlaceholder,
                hint: PI_TEXT.synqpayHostHintLan,
                maxLength: 253,
              })}
              <div className="grid grid-cols-2 gap-3">
                {choiceField(
                  'synqpayProtocol',
                  SYNQPAY_PROTOCOLS,
                  SYNQPAY_PROTOCOL_LABELS,
                  SYNQPAY_PROTOCOL_LABELS.tcp,
                  PI_TEXT.synqpayProtocolHint,
                )}
                {textField('synqpayPort', {
                  placeholder: String(synqpayPort),
                  hint: PI_TEXT.synqpayPortHint(synqpayPort),
                  numeric: true,
                  maxLength: 5,
                })}
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  {fieldLabel('synqpayTls')}
                  <p className={HINT}>{PI_TEXT.synqpayTlsHint}</p>
                </div>
                <Switch
                  checked={synqpayTls}
                  onCheckedChange={(checked: boolean) => set({ synqpayTls: checked })}
                  aria-label={FIELD_LABELS.synqpayTls}
                />
              </div>
            </>
          ) : null}
          {synqpayConnection === 'usb'
            ? textField('synqpayUsbDevice', { placeholder: 'auto', hint: PI_TEXT.synqpayUsbHint, mono: true, maxLength: 9 })
            : null}
          {textField('synqpaySerialNumber', { hint: PI_TEXT.synqpaySerialHint, mono: true, maxLength: 32 })}
          <div className="space-y-1">
            <SecretField
              secretKey="synqpayApiKey"
              label={fieldLabel('synqpayApiKey')}
              value={value.synqpayApiKey}
              status={context?.secrets?.synqpayApiKey}
              error={fieldError('synqpayApiKey')}
              onChange={(next) => set({ synqpayApiKey: next })}
            />
            <p className={HINT}>{PI_TEXT.synqpayKeyHint}</p>
          </div>
          <p className={WARN}>{PI_TEXT.synqpayIdentityHint}</p>
          {synqpayWarnings(value, inh).map((warning) => (
            <p key={warning} className={WARN}>
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      {integration.effective === 'tap_to_pay' ? (
        <div className="space-y-2 rounded-lg border p-3 opacity-70">
          <p className={HINT}>{PI_TEXT.tapToPayHint}</p>
          <Input disabled dir="ltr" placeholder={PI_TEXT.tapToPayMerchant} />
          <Input disabled dir="ltr" placeholder={PI_TEXT.tapToPayTerminal} />
        </div>
      ) : null}

      {hiddenErrors.length > 0 ? (
        <div role="alert" className={`${ERROR} space-y-1`}>
          {hiddenErrors.map((key) => (
            <p key={key}>
              {PI_TEXT.hiddenInvalid} — {FIELD_LABELS[key]}: {errors[key]}{' '}
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs"
                onClick={() =>
                  set({
                    [key]: key === 'zcreditPassword' || key === 'zcreditKey' || key === 'synqpayApiKey' ? undefined : null,
                  } as Partial<PosSettingsPatch>)
                }
              >
                {PI_TEXT.clear}
              </Button>
            </p>
          ))}
        </div>
      ) : null}

      {/* Above a till: what is still missing for its tills (a till may complete it). */}
      {v.missing.length > 0 ? (
        <p className={WARN}>
          {missingFieldsLabel(v.missing)} — {PI_TEXT.missingUpperLevelHint}
        </p>
      ) : null}

      {/* A till: what it charges on as saved, and what it still lacks. */}
      {context?.resolved ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
          <p>
            {PI_TEXT.resolvedPrefix} <span className="font-medium">{INTEGRATION_LABELS[context.resolved.integration]}</span>{' '}
            <span className="text-muted-foreground">
              {context.resolved.automatic
                ? PI_TEXT.automaticSuffix
                : context.resolved.source
                  ? `(${PI_TEXT.chosenAt} ${LEVEL_LABELS[context.resolved.source]})`
                  : null}
            </span>
          </p>
          {context.resolved.missing.length > 0 ? (
            <p className="mt-0.5 text-amber-700 dark:text-amber-400">{missingFieldsLabel(context.resolved.missing)}</p>
          ) : null}
        </div>
      ) : null}

      {v.contextError ? <p className={HINT}>{PI_TEXT.contextError}</p> : null}
    </div>
  );
}

// ── A new shop ────────────────────────────────────────────────────────────────

/**
 * The type picked when a shop is created (`POST /shops` `paymentIntegration`): stored on
 * the shop's layer, so all its tills follow it until one is set apart. No device here,
 * so every choice but the reserved Tap to Pay may be picked.
 */
export function ShopPaymentIntegrationSelect({
  value,
  onChange,
  id = 'shop-payment-integration',
}: {
  value: PaymentIntegration;
  onChange: (next: PaymentIntegration) => void;
  id?: string;
}) {
  const options = integrationOptions(null).filter((o) => !o.hidden);
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{PI_TEXT.sectionTitle}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          const picked = cleanIntegration(next);
          if (picked) onChange(picked);
        }}
        items={options.map((o) => ({ value: o.value, label: o.label }))}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} label={o.label} disabled={!o.selectable}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className={HINT}>{PI_TEXT.shopCreateHint}</p>
    </div>
  );
}

// ── Write-only secrets ────────────────────────────────────────────────────────

/**
 * A secret the server never returns. Stored (here or above): "••••", where it is kept, and
 * "החלף" to type a new one for this layer. Nothing typed is `undefined` (unchanged) —
 * never '' (which the server reads as "remove") and never the mask.
 */
function SecretField({
  secretKey,
  label,
  value,
  status,
  error,
  onChange,
}: {
  secretKey: PaymentSecretKey;
  label: ReactNode;
  value: string | null | undefined;
  status: SecretStatus | undefined;
  error: ReactNode;
  onChange: (next: string | undefined) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const stored = status?.set === true;
  const typed = isTypedSecret(value);
  const editing = !stored || replacing || typed;
  const source = typeof status?.source === 'string' && status.source in LEVEL_LABELS
    ? (status.source as SettingsLevelName)
    : null;

  return (
    <div className="space-y-1">
      {label}
      {editing ? (
        <Input
          id={`pi-${secretKey}`}
          type="password"
          dir="ltr"
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          maxLength={200}
          placeholder={stored ? PI_TEXT.typeNewSecret : undefined}
          value={typed ? (value as string) : ''}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      ) : (
        <Input
          id={`pi-${secretKey}`}
          type="password"
          dir="ltr"
          readOnly
          tabIndex={-1}
          className="bg-muted/40"
          placeholder={SECRET_MASK}
          value=""
          aria-label={secretSavedLabel(secretKey, source, status?.own === true)}
        />
      )}
      {stored ? (
        <div className="flex flex-wrap items-center gap-x-3">
          <p className={HINT}>{secretSavedLabel(secretKey, source, status?.own === true)}</p>
          {editing ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0 text-xs"
              onClick={() => {
                setReplacing(false);
                onChange(undefined);
              }}
            >
              {PI_TEXT.cancelReplace}
            </Button>
          ) : (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0 text-xs"
              onClick={() => setReplacing(true)}
            >
              {PI_TEXT.replace}
            </Button>
          )}
        </div>
      ) : null}
      {error}
    </div>
  );
}

/** The optional WebCheckout key, under "מתקדם": not needed for charging on the pinpad. */
function AdvancedKey({
  value,
  status,
  label,
  error,
  onChange,
}: {
  value: string | null | undefined;
  status: SecretStatus | undefined;
  label: ReactNode;
  error: ReactNode;
  onChange: (next: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  // Kept open while it holds something: a saved key, a typed one or an error.
  const forced = status?.set === true || isTypedSecret(value) || !!error;
  const shown = open || forced;
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="text-xs font-medium text-muted-foreground enabled:hover:underline"
        aria-expanded={shown}
        disabled={forced}
        onClick={() => setOpen((o) => !o)}
      >
        {shown ? '▾' : '◂'} {PI_TEXT.advanced}
      </button>
      {shown ? (
        <div className="space-y-1">
          <SecretField
            secretKey="zcreditKey"
            label={label}
            value={value}
            status={status}
            error={error}
            onChange={onChange}
          />
          <p className={HINT}>{PI_TEXT.keyHint}</p>
        </div>
      ) : null}
    </div>
  );
}
