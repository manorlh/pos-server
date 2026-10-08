'use client';

/**
 * Add / edit one payment device of a shop ("מכשירי תשלום"): its nickname, its kind (Agamento on
 * the LAN, a Z-Credit PinPad, a SynqPay terminal) and that kind's fields, its write-only secret
 * ("מוגדר" once stored — replace or remove, never shown), which tills use it (none chosen = every
 * till of the shop; a till with built-in clearing is marked as not concerned), active, order.
 * The checks are lib/paymentDevices.ts, the server's own (same codes).
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { SimpleSelect } from '@/components/dashboard/kitchen-printers/printer-dialog';
import {
  NICKNAME_MAX,
  PAYMENT_DEVICE_KINDS,
  deviceForm,
  deviceInput,
  emptyDeviceForm,
  hasDeviceErrors,
  validateDeviceForm,
  type DeviceFormErrors,
  type DeviceFormField,
  type DeviceSecretStatus,
  type DeviceServerError,
  type PaymentDevice,
  type PaymentDeviceForm,
  type PaymentDeviceInput,
  type PaymentDeviceKind,
  type ShopPaymentDevices,
} from '@/lib/paymentDevices';
import { SYNQPAY_MODELS, SYNQPAY_MODEL_LABELS, synqpayDefaultPort } from '@/lib/paymentIntegration';

export function PaymentDeviceDialog({
  device,
  page,
  saving,
  serverError,
  onClose,
  onSave,
}: {
  device: PaymentDevice | null;
  page: ShopPaymentDevices;
  saving: boolean;
  /** The server's last refusal, shown on its field (or under the form). */
  serverError: DeviceServerError | null;
  onClose: () => void;
  onSave: (body: PaymentDeviceInput) => void;
}) {
  const t = useTranslations('paymentDevices');
  const tc = useTranslations('common');
  const [form, setForm] = useState<PaymentDeviceForm>(() => (device ? deviceForm(device) : emptyDeviceForm()));
  const [submitted, setSubmitted] = useState(false);
  const set = (patch: Partial<PaymentDeviceForm>) => setForm((f) => ({ ...f, ...patch }));

  const machineIds = useMemo(() => page.machines.map((m) => m.id), [page.machines]);
  const otherNicknames = useMemo(
    () => page.devices.filter((d) => d.id !== device?.id).map((d) => d.nickname),
    [page.devices, device?.id],
  );
  const errors: DeviceFormErrors = validateDeviceForm(form, { otherNicknames, machineIds });
  const shown: DeviceFormErrors = submitted ? errors : {};
  const errorOf = (field: DeviceFormField): string | null => {
    const code = shown[field] ?? (serverError?.field === field ? serverError.code : null);
    if (!code) return null;
    return t.has(`errors.${code}`) ? t(`errors.${code}`) : (serverError?.msg ?? code);
  };
  const unplacedServerError =
    serverError && !serverError.field ? (serverError.msg ?? (t.has(`errors.${serverError.code}`) ? t(`errors.${serverError.code}`) : serverError.code)) : null;

  const kind = form.kind;
  const lan = form.connection === 'lan';

  const submit = () => {
    setSubmitted(true);
    if (hasDeviceErrors(errors)) return;
    // Only the tills that still exist; a till kept from before but gone is dropped.
    onSave(deviceInput(form, { machineIds }));
  };

  const fieldError = (field: DeviceFormField) => {
    const msg = errorOf(field);
    return msg ? <p className="text-xs text-destructive">{msg}</p> : null;
  };

  const tillOptions = page.machines.map((m) => ({
    id: m.id,
    label: m.name,
    hint: m.hasBuiltinTerminal ? t('fields.builtinMark') : null,
  }));

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{device ? t('editTitle') : t('addTitle')}</DialogTitle>
          <DialogDescription>{t('dialogHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="pd-nickname">{t('fields.nickname')}</Label>
            <Input
              id="pd-nickname"
              value={form.nickname}
              maxLength={NICKNAME_MAX + 10}
              placeholder={t('fields.nicknamePlaceholder')}
              onChange={(e) => set({ nickname: e.target.value })}
              aria-invalid={!!errorOf('nickname') || undefined}
            />
            {fieldError('nickname')}
          </div>

          <div className="space-y-1">
            <Label>{t('fields.kind')}</Label>
            <SimpleSelect
              value={kind}
              onChange={(v) => set({ kind: v as PaymentDeviceKind })}
              options={PAYMENT_DEVICE_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
              ariaLabel={t('fields.kind')}
            />
            <p className="text-xs text-muted-foreground">{t(`kindHints.${kind}`)}</p>
          </div>

          {kind === 'agamento_lan' && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 space-y-1">
                  <Label htmlFor="pd-host">{t('fields.host')}</Label>
                  <Input
                    id="pd-host"
                    dir="ltr"
                    value={form.host}
                    placeholder="192.168.1.20"
                    onChange={(e) => set({ host: e.target.value })}
                    aria-invalid={!!errorOf('host') || undefined}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pd-port">{t('fields.port')}</Label>
                  <Input
                    id="pd-port"
                    dir="ltr"
                    inputMode="numeric"
                    value={form.port}
                    placeholder="8080"
                    onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })}
                    aria-invalid={!!errorOf('port') || undefined}
                  />
                </div>
              </div>
              {fieldError('host')}
              {fieldError('port')}
              <p className="text-xs text-muted-foreground">{t('fields.hostHint')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="pd-path">{t('fields.path')}</Label>
                  <Input
                    id="pd-path"
                    dir="ltr"
                    value={form.path}
                    placeholder="/SPICy"
                    onChange={(e) => set({ path: e.target.value })}
                  />
                  {fieldError('path') ?? <p className="text-xs text-muted-foreground">{t('fields.pathHint')}</p>}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pd-mac">{t('fields.mac')}</Label>
                  <Input
                    id="pd-mac"
                    dir="ltr"
                    value={form.mac}
                    placeholder="aa:bb:cc:dd:ee:ff"
                    onChange={(e) => set({ mac: e.target.value })}
                  />
                  {fieldError('mac') ?? <p className="text-xs text-muted-foreground">{t('fields.macHint')}</p>}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="pd-terminal">{t('fields.terminalNumber')}</Label>
                  <Input
                    id="pd-terminal"
                    dir="ltr"
                    inputMode="numeric"
                    value={form.terminalNumber}
                    onChange={(e) => set({ terminalNumber: e.target.value.replace(/\D/g, '').slice(0, 20) })}
                  />
                  {fieldError('terminalNumber') ?? (
                    <p className="text-xs text-muted-foreground">{t('fields.terminalNumberHint')}</p>
                  )}
                </div>
                <label className="flex items-center gap-2 self-center text-sm">
                  <Switch checked={form.https} onCheckedChange={(v) => set({ https: v })} />
                  <span>
                    {t('fields.https')}
                    <span className="block text-xs text-muted-foreground">{t('fields.httpsHint')}</span>
                  </span>
                </label>
              </div>
            </>
          )}

          {kind === 'zcredit_pinpad' && (
            <>
              <div className="space-y-1">
                <Label htmlFor="pd-pinpad">{t('fields.pinpadId')}</Label>
                <Input
                  id="pd-pinpad"
                  dir="ltr"
                  value={form.pinpadId}
                  placeholder="PINPAD100000"
                  onChange={(e) => set({ pinpadId: e.target.value })}
                  aria-invalid={!!errorOf('pinpadId') || undefined}
                />
                {fieldError('pinpadId') ?? <p className="text-xs text-muted-foreground">{t('fields.pinpadHint')}</p>}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="pd-zterminal">{t('fields.terminalNumber')}</Label>
                  <Input
                    id="pd-zterminal"
                    dir="ltr"
                    inputMode="numeric"
                    value={form.terminalNumber}
                    onChange={(e) => set({ terminalNumber: e.target.value.replace(/\D/g, '').slice(0, 20) })}
                  />
                  {fieldError('terminalNumber') ?? (
                    <p className="text-xs text-muted-foreground">{t('fields.zcreditTerminalHint')}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label>{t('fields.mode')}</Label>
                  <SimpleSelect
                    value={form.mode || 'inherit'}
                    onChange={(v) => set({ mode: v === 'test' || v === 'production' ? v : '' })}
                    options={[
                      { value: 'inherit', label: t('fields.modeInherit') },
                      { value: 'test', label: t('fields.modeTest') },
                      { value: 'production', label: t('fields.modeProduction') },
                    ]}
                    ariaLabel={t('fields.mode')}
                  />
                </div>
              </div>
              <SecretField
                id="pd-zpassword"
                label={t('fields.zcreditPassword')}
                hint={t('fields.zcreditPasswordHint')}
                status={device?.kind === 'zcredit_pinpad' ? device.secrets?.zcreditPassword : undefined}
                value={form.zcreditPassword}
                remove={form.removeZcreditPassword}
                onValue={(v) => set({ zcreditPassword: v })}
                onRemove={(r) => set({ removeZcreditPassword: r, zcreditPassword: '' })}
                error={errorOf('zcreditPassword')}
              />
            </>
          )}

          {kind === 'synqpay' && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t('fields.model')}</Label>
                  <SimpleSelect
                    value={form.model || ''}
                    onChange={(v) => set({ model: v })}
                    options={[
                      { value: '', label: t('fields.modelPlaceholder') },
                      ...SYNQPAY_MODELS.map((m) => ({ value: m, label: SYNQPAY_MODEL_LABELS[m] })),
                    ]}
                    ariaLabel={t('fields.model')}
                  />
                  {fieldError('model')}
                </div>
                <div className="space-y-1">
                  <Label>{t('fields.connection')}</Label>
                  <SimpleSelect
                    value={form.connection || ''}
                    onChange={(v) => set({ connection: v === 'lan' || v === 'usb' ? v : '' })}
                    options={[
                      { value: '', label: t('fields.connectionPlaceholder') },
                      { value: 'lan', label: t('fields.connectionLan') },
                      { value: 'usb', label: t('fields.connectionUsb') },
                    ]}
                    ariaLabel={t('fields.connection')}
                  />
                  {fieldError('connection')}
                </div>
              </div>
              {lan && (
                <div className="space-y-1">
                  <Label htmlFor="pd-shost">{t('fields.host')}</Label>
                  <Input
                    id="pd-shost"
                    dir="ltr"
                    value={form.host}
                    placeholder="192.168.1.40"
                    onChange={(e) => set({ host: e.target.value })}
                    aria-invalid={!!errorOf('host') || undefined}
                  />
                  {fieldError('host') ?? <p className="text-xs text-muted-foreground">{t('fields.synqpayHostHint')}</p>}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{t('fields.protocol')}</Label>
                  <SimpleSelect
                    value={form.protocol}
                    onChange={(v) => set({ protocol: v === 'http' ? 'http' : 'tcp' })}
                    options={[
                      { value: 'tcp', label: 'TCP' },
                      { value: 'http', label: 'HTTP' },
                    ]}
                    ariaLabel={t('fields.protocol')}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pd-sport">{t('fields.port')}</Label>
                  <Input
                    id="pd-sport"
                    dir="ltr"
                    inputMode="numeric"
                    value={form.port}
                    placeholder={String(synqpayDefaultPort(form.protocol, form.tls))}
                    onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })}
                  />
                  {fieldError('port') ?? <p className="text-xs text-muted-foreground">{t('fields.portHintSynqpay')}</p>}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={form.tls} onCheckedChange={(v) => set({ tls: v })} />
                {t('fields.tls')}
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="pd-usb">{t('fields.usbDevice')}</Label>
                  <Input
                    id="pd-usb"
                    dir="ltr"
                    value={form.usbDevice}
                    placeholder="0B00:0080"
                    onChange={(e) => set({ usbDevice: e.target.value })}
                  />
                  {fieldError('usbDevice') ?? <p className="text-xs text-muted-foreground">{t('fields.usbDeviceHint')}</p>}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pd-serial">{t('fields.serialNumber')}</Label>
                  <Input
                    id="pd-serial"
                    dir="ltr"
                    value={form.serialNumber}
                    onChange={(e) => set({ serialNumber: e.target.value })}
                  />
                  {fieldError('serialNumber') ?? <p className="text-xs text-muted-foreground">{t('fields.serialHint')}</p>}
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pd-sterminal">{t('fields.terminalNumber')}</Label>
                <Input
                  id="pd-sterminal"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.terminalNumber}
                  onChange={(e) => set({ terminalNumber: e.target.value.replace(/\D/g, '').slice(0, 20) })}
                />
                {fieldError('terminalNumber') ?? (
                  <p className="text-xs text-muted-foreground">{t('fields.terminalNumberHint')}</p>
                )}
              </div>
              <SecretField
                id="pd-skey"
                label={t('fields.synqpayApiKey')}
                hint={t('fields.synqpayApiKeyHint')}
                status={device?.kind === 'synqpay' ? device.secrets?.synqpayApiKey : undefined}
                value={form.synqpayApiKey}
                remove={form.removeSynqpayApiKey}
                onValue={(v) => set({ synqpayApiKey: v })}
                onRemove={(r) => set({ removeSynqpayApiKey: r, synqpayApiKey: '' })}
                error={errorOf('synqpayApiKey')}
                pairing
              />
            </>
          )}

          <div className="space-y-1">
            <EntityMultiSelect
              label={t('fields.tills')}
              options={tillOptions}
              selected={form.machineIds.filter((id) => machineIds.includes(id))}
              onChange={(next) => set({ machineIds: next })}
              allLabel={t('fields.tillsAll')}
              clearLabel={t('fields.tillsClear')}
              emptyLabel={t('fields.tillsEmpty')}
            />
            {fieldError('machineIds') ?? <p className="text-xs text-muted-foreground">{t('fields.tillsHint')}</p>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.active} onCheckedChange={(v) => set({ active: v })} />
              <span>
                {t('fields.active')}
                <span className="block text-xs text-muted-foreground">{t('fields.activeHint')}</span>
              </span>
            </label>
            <div className="space-y-1">
              <Label htmlFor="pd-order">{t('fields.sortOrder')}</Label>
              <Input
                id="pd-order"
                dir="ltr"
                inputMode="numeric"
                className="w-28"
                value={form.sortOrder}
                onChange={(e) => set({ sortOrder: e.target.value.replace(/\D/g, '').slice(0, 4) })}
              />
              {fieldError('sortOrder') ?? <p className="text-xs text-muted-foreground">{t('fields.sortOrderHint')}</p>}
            </div>
          </div>

          {submitted && hasDeviceErrors(errors) ? (
            <p role="alert" className="text-sm text-destructive">
              {t('errors.formInvalid')}
            </p>
          ) : null}
          {unplacedServerError ? (
            <p role="alert" className="text-sm text-destructive">
              {unplacedServerError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {tc('cancel')}
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? tc('saving') : tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A write-only secret: "מוגדר" when one is stored (with "החלפה" / "הסרה"), else a password
 * field. Nothing typed = keep what is stored.
 */
function SecretField({
  id,
  label,
  hint,
  status,
  value,
  remove,
  onValue,
  onRemove,
  error,
  pairing = false,
}: {
  id: string;
  label: string;
  hint: string;
  status: DeviceSecretStatus | undefined;
  value: string;
  remove: boolean;
  onValue: (value: string) => void;
  onRemove: (remove: boolean) => void;
  error: string | null;
  /** SynqPay's key: show the pairing state beside "מוגדר". */
  pairing?: boolean;
}) {
  const t = useTranslations('paymentDevices');
  const stored = status?.set === true;
  const [replacing, setReplacing] = useState(false);
  const editing = !stored || replacing;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {stored && !replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          {remove ? (
            <Badge variant="outline" className="text-destructive">
              {t('secretWillRemove')}
            </Badge>
          ) : (
            <Badge variant="secondary">{t('secretSaved')}</Badge>
          )}
          {pairing && !remove ? <PairingNote status={status} /> : null}
          {remove ? (
            <Button type="button" size="xs" variant="link" className="h-auto px-0" onClick={() => onRemove(false)}>
              {t('secretUndo')}
            </Button>
          ) : (
            <>
              <Button type="button" size="xs" variant="link" className="h-auto px-0" onClick={() => setReplacing(true)}>
                {t('secretReplace')}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="link"
                className="h-auto px-0 text-destructive"
                onClick={() => onRemove(true)}
              >
                {t('secretRemove')}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {editing ? (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={value}
            placeholder={stored ? t('secretPlaceholder') : ''}
            onChange={(e) => onValue(e.target.value)}
            aria-invalid={!!error || undefined}
          />
          {stored ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setReplacing(false);
                onValue('');
              }}
            >
              {t('secretUndo')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PairingNote({ status }: { status: DeviceSecretStatus | undefined }) {
  const t = useTranslations('paymentDevices');
  if (!status?.set) return null;
  if (status.rejectedAt) return <span className="text-xs text-destructive">{t('keyRejected')}</span>;
  if (status.origin === 'till_pairing') {
    return (
      <span className="text-xs text-muted-foreground">
        {t('paired')}
        {status.terminalSerial ? ` · ${status.terminalSerial}` : ''}
      </span>
    );
  }
  return null;
}
