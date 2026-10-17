'use client';

/**
 * "מסופון אשראי" — the card terminal type of a till or a kiosk and its fields (lib/deviceTerminal.ts), in the
 * add-device dialog and on the device page's "תפקיד ודגם". Only the types the device's platform and role
 * can charge on, and per type only its fields; no secret is asked or shown (the payment settings take them).
 */

import { useTranslations } from 'next-intl';
import { CreditCard } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  SYNQPAY_CONNECTIONS,
  SYNQPAY_CONNECTION_LABELS,
  SYNQPAY_MODELS,
  SYNQPAY_MODEL_LABELS,
  SYNQPAY_PROTOCOLS,
  SYNQPAY_PROTOCOL_LABELS,
  TAP_TO_PAY_ENVIRONMENTS,
  TAP_TO_PAY_ENVIRONMENT_LABELS,
  ZCREDIT_MODES,
  ZCREDIT_MODE_LABELS,
  type PaymentIntegration,
} from '@/lib/paymentIntegration';
import {
  TERMINAL_FIELD_ERRORS,
  TERMINAL_FIELD_LABELS,
  TERMINAL_FIELD_PLACEHOLDERS,
  TERMINAL_TEXT,
  emptyTerminalDraft,
  terminalDraftErrors,
  terminalFieldsOf,
  terminalSecretElsewhere,
  terminalTypeLabel,
  terminalTypesFor,
  type TerminalDraft,
  type TerminalField,
  type TerminalPlatform,
  type TerminalRole,
} from '@/lib/deviceTerminal';

const CHOICES: Partial<Record<TerminalField, { values: readonly string[]; labels: Record<string, string> }>> = {
  zcreditMode: { values: ZCREDIT_MODES, labels: ZCREDIT_MODE_LABELS },
  synqpayDeviceModel: { values: SYNQPAY_MODELS, labels: SYNQPAY_MODEL_LABELS },
  synqpayConnection: { values: SYNQPAY_CONNECTIONS, labels: SYNQPAY_CONNECTION_LABELS },
  synqpayProtocol: { values: SYNQPAY_PROTOCOLS, labels: SYNQPAY_PROTOCOL_LABELS },
  tapToPayEnvironment: { values: TAP_TO_PAY_ENVIRONMENTS, labels: TAP_TO_PAY_ENVIRONMENT_LABELS },
};

function ChoiceField({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: TerminalField;
  value: string;
  onChange: (next: string) => void;
}) {
  const choice = CHOICES[field]!;
  const items = choice.values.map((v) => ({ value: v, label: choice.labels[v] ?? v }));
  return (
    <Select value={value || null} onValueChange={(next: unknown) => onChange(typeof next === 'string' ? next : '')} items={items}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={field === 'synqpayConnection' ? TERMINAL_TEXT.synqpayConnectionPick : TERMINAL_TEXT.pick} />
      </SelectTrigger>
      <SelectContent>
        {items.map((m) => (
          <SelectItem key={m.value} value={m.value} label={m.label}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The note under the type: what it means, what is set elsewhere. */
function typeNote(type: PaymentIntegration, role: TerminalRole, draft: TerminalDraft): string | null {
  if (type === 'auto') return TERMINAL_TEXT.auto;
  if (type === 'agamento') return TERMINAL_TEXT.builtin;
  if (type === 'none') return role === 'kiosk' ? TERMINAL_TEXT.noneKiosk : TERMINAL_TEXT.noneTill;
  if (type === 'nayax_usb') return TERMINAL_TEXT.nayaxUsb;
  if (type === 'nayax_lan' && role === 'kiosk' && !draft.nayaxDeviceHost.trim()) return TERMINAL_TEXT.nayaxLanKioskBlank;
  const secret = terminalSecretElsewhere(type);
  return secret ? TERMINAL_TEXT[secret] : null;
}

export function DeviceTerminalFields({
  role,
  platform,
  builtinTerminal,
  hasNfc,
  value,
  onChange,
  idPrefix = 'device-terminal',
}: {
  role: TerminalRole;
  platform: TerminalPlatform;
  /** An Android model with a terminal of its own ("מובנה במכשיר"); false / unknown hides it. */
  builtinTerminal?: boolean | null;
  hasNfc?: boolean | null;
  value: TerminalDraft;
  onChange: (next: TerminalDraft) => void;
  idPrefix?: string;
}) {
  const tr = useTranslations('machines.deviceRole');
  const types = terminalTypesFor({ role, platform, builtinTerminal, hasNfc });
  const typeItems = types.map((t) => ({ value: t, label: terminalTypeLabel(t, role) }));
  const errors = terminalDraftErrors(value);
  const fields = terminalFieldsOf(value);
  const note = typeNote(value.type, role, value);
  const set = (patch: Partial<TerminalDraft>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3" data-testid="device-terminal">
      <p className="flex items-center gap-1 text-xs font-medium">
        <CreditCard className="h-3.5 w-3.5" aria-hidden /> {tr('pinpadTitle')}
      </p>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-type`} className="text-xs">
          {tr('terminalType')}
        </Label>
        <Select
          value={value.type}
          onValueChange={(next: unknown) => {
            if (typeof next !== 'string' || !(types as string[]).includes(next)) return;
            // A new type starts from its own empty fields (another type's values are not carried over).
            onChange(next === value.type ? value : emptyTerminalDraft(next as PaymentIntegration));
          }}
          items={typeItems}
        >
          <SelectTrigger id={`${idPrefix}-type`} aria-label={tr('terminalType')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {typeItems.map((m) => (
              <SelectItem key={m.value} value={m.value} label={m.label}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {fields.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {fields.map((f) => {
            const id = `${idPrefix}-${f}`;
            if (f === 'synqpayTls') {
              return (
                <label key={f} htmlFor={id} className="flex items-center gap-2 self-end pb-2 text-xs">
                  <Switch id={id} checked={value.synqpayTls} onCheckedChange={(on: boolean) => set({ synqpayTls: on })} />
                  {TERMINAL_FIELD_LABELS[f]}
                </label>
              );
            }
            return (
              <div key={f} className="space-y-1">
                <Label htmlFor={id} className="text-xs">
                  {TERMINAL_FIELD_LABELS[f]}
                </Label>
                {CHOICES[f] ? (
                  <ChoiceField id={id} field={f} value={String(value[f] ?? '')} onChange={(v) => set({ [f]: v } as Partial<TerminalDraft>)} />
                ) : (
                  <Input
                    id={id}
                    dir="ltr"
                    inputMode={f.endsWith('Port') || f === 'zcreditTerminalNumber' ? 'numeric' : undefined}
                    placeholder={TERMINAL_FIELD_PLACEHOLDERS[f]}
                    value={String(value[f] ?? '')}
                    aria-invalid={errors[f] ? true : undefined}
                    onChange={(e) => set({ [f]: e.target.value } as Partial<TerminalDraft>)}
                  />
                )}
                {errors[f] ? <p className="text-xs text-destructive">{TERMINAL_FIELD_ERRORS[f]}</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <p className="text-xs text-muted-foreground">{tr('pinpadHint')}</p>
    </div>
  );
}
