'use client';

/**
 * Add / edit one printer of the shop: a kitchen printer ("מדפסת בונים": network, Bluetooth,
 * through the cloud via a host till, the till's own) or a receipt printer ("מדפסת
 * חשבוניות": network, Bluetooth, or one till's USB — with the cash drawer on its port or
 * not — or another till's printer, "ענן": its host and how the host reaches it, and whether that
 * printer has the drawer, which opens there only as §9 of P:/specs/bill-print-other-till.md lets
 * it); where it applies (the whole shop, one point of sale, one till), and how it prints.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
  KitchenPrinter,
  KitchenPrinterInput,
  KitchenPrintersPage,
  PrinterConnectionType,
  PrinterHostConnection,
  PrinterPurpose,
  PrintWidthDots,
} from '@/lib/kitchenPrintersApi';
import { PRINT_WIDTHS } from '@/lib/kitchenPrintersApi';
import { hostOffered } from '@/lib/remotePrint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Radar } from 'lucide-react';
import { NetworkScanDialog } from './network-scan';

const NONE = 'none';
const AUTO_WIDTH = 'auto';
const MAC_RE = /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/;

export interface Option {
  value: string;
  label: string;
  /** Listed, not chosen ("נדרש עדכון גרסה"). */
  disabled?: boolean;
}

/** The one select shape this page needs: string values, labelled. */
export function SimpleSelect({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(String(v ?? ''))}
      items={options}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} label={o.label} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface FormState {
  name: string;
  purpose: PrinterPurpose;
  cashDrawer: boolean;
  connectionType: PrinterConnectionType;
  host: string;
  port: string;
  btAddress: string;
  btName: string;
  hostMachineId: string;
  hostConnection: PrinterHostConnection;
  scope: string; // 'shop' | 'area:<id>' | 'machine:<id>'
  paperWidth: '58' | '80';
  /** 'auto' — by the paper; else dots. */
  printWidth: string;
  copies: string;
  cutPaper: boolean;
  beep: boolean;
  isActive: boolean;
}

/** A printer the network scan found ("חיפוש ברשת"): fills a new printer's address. */
export interface PrinterPrefill {
  host: string;
  port: number;
  name?: string | null;
}

function initial(printer: KitchenPrinter | null, purpose: PrinterPurpose, prefill?: PrinterPrefill | null): FormState {
  if (!printer) {
    return {
      name: prefill?.name ?? '',
      purpose,
      cashDrawer: purpose === 'receipt',
      connectionType: 'network',
      host: prefill?.host ?? '',
      port: String(prefill?.port ?? 9100),
      btAddress: '',
      btName: '',
      hostMachineId: NONE,
      hostConnection: 'till',
      scope: 'shop',
      paperWidth: '80',
      printWidth: AUTO_WIDTH,
      copies: '1',
      cutPaper: true,
      beep: false,
      isActive: true,
    };
  }
  return {
    name: printer.name,
    purpose: printer.purpose ?? 'kitchen',
    cashDrawer: printer.cashDrawer ?? false,
    connectionType: printer.connectionType,
    host: printer.host ?? '',
    port: String(printer.port ?? 9100),
    btAddress: printer.btAddress ?? '',
    btName: printer.btName ?? '',
    hostMachineId: printer.hostMachineId ?? NONE,
    hostConnection: printer.hostConnection ?? 'till',
    scope: printer.machineId ? `machine:${printer.machineId}` : printer.areaId ? `area:${printer.areaId}` : 'shop',
    paperWidth: printer.paperWidth === 58 ? '58' : '80',
    printWidth: printer.printWidthDots ? String(printer.printWidthDots) : AUTO_WIDTH,
    copies: String(printer.copies),
    cutPaper: printer.cutPaper,
    beep: printer.beep,
    isActive: printer.isActive,
  };
}

export function PrinterDialog({
  open,
  printer,
  purpose = 'kitchen',
  page,
  saving,
  onClose,
  onSave,
  prefill,
}: {
  open: boolean;
  printer: KitchenPrinter | null;
  /** A new printer's kind (an existing one keeps its own). */
  purpose?: PrinterPurpose;
  page: KitchenPrintersPage;
  saving: boolean;
  onClose: () => void;
  onSave: (body: KitchenPrinterInput) => void;
  /** A new printer found by the network scan. */
  prefill?: PrinterPrefill | null;
}) {
  const t = useTranslations('kitchenPrinters');
  const tc = useTranslations('common');
  const [form, setForm] = useState<FormState>(() => initial(printer, purpose, prefill));
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // How the printer itself is reached: directly, or by its host till.
  const hosted = form.connectionType === 'cloud';
  const reach = hosted ? form.hostConnection : form.connectionType;
  const receipt = form.purpose === 'receipt';
  // "המדפסת של <קופה>": a receipt printer another till prints on — its drawer (if the printer there has one)
  // opens only as `remotePrintDrawer` / CASH_DRAWER.OPEN_REMOTE let it (bill-print-other-till §9).
  const remoteReceipt = receipt && hosted;

  // A receipt printer is reached directly by the till that prints on it, or through another till.
  const typeOptions: Option[] = receipt
    ? [
        { value: 'network', label: t('types.network') },
        { value: 'bluetooth', label: t('types.bluetooth') },
        { value: 'usb', label: t('types.usb') },
        { value: 'cloud', label: t('types.cloudReceipt') },
      ]
    : [
        { value: 'network', label: t('types.network') },
        { value: 'bluetooth', label: t('types.bluetooth') },
        { value: 'cloud', label: t('types.cloud') },
        { value: 'till', label: t('types.till') },
      ];
  const setPurpose = (next: PrinterPurpose) =>
    set({
      purpose: next,
      cashDrawer: next === 'receipt' ? form.cashDrawer : false,
      connectionType:
        next === 'receipt' && form.connectionType === 'till'
          ? 'network'
          : next === 'kitchen' && form.connectionType === 'usb'
            ? 'network'
            : form.connectionType,
    });
  // Another till's printer starts without the drawer: it is said on purpose, never carried over.
  const setConnection = (next: PrinterConnectionType) =>
    set({ connectionType: next, cashDrawer: receipt && next === 'cloud' && !hosted ? false : form.cashDrawer });
  const hostConnectionOptions: Option[] = [
    { value: 'till', label: t('hostConnections.till') },
    { value: 'network', label: t('hostConnections.network') },
    { value: 'bluetooth', label: t('hostConnections.bluetooth') },
    // A printer on the host till's own USB port (a kiosk's bon on a till's local printer).
    { value: 'usb', label: t('hostConnections.usb') },
  ];
  const scopeOptions: Option[] = [
    { value: 'shop', label: t('scopeShop') },
    ...page.areas.map((a) => ({ value: `area:${a.id}`, label: t('scopeArea', { name: a.name }) })),
    ...page.machines.map((m) => ({ value: `machine:${m.id}`, label: t('scopeMachine', { name: m.name }) })),
  ];
  // A receipt printer of another till: only a till whose build prints relayed documents may host it; the
  // others are listed, not offered. The host it already has stays choosable (an older build then).
  const hostOptions: Option[] = [
    { value: NONE, label: t('chooseHost') },
    ...page.machines.map((m) => {
      const blocked = receipt && !hostOffered(m) && m.id !== printer?.hostMachineId;
      return { value: m.id, label: blocked ? t('hostNeedsUpdate', { name: m.name }) : m.name, disabled: blocked };
    }),
  ];

  const submit = () => {
    setError(null);
    const name = form.name.trim();
    if (!name) return setError(t('errors.name'));
    if (hosted && form.hostMachineId === NONE) return setError(t('errors.host'));
    if (remoteReceipt && hostOptions.find((o) => o.value === form.hostMachineId)?.disabled) {
      return setError(t('errors.hostNeedsUpdate'));
    }
    const port = Number(form.port || '9100');
    if (reach === 'network') {
      if (!form.host.trim()) return setError(t('errors.address'));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return setError(t('errors.port'));
    }
    if (reach === 'bluetooth' && form.btAddress.trim() && !MAC_RE.test(form.btAddress.trim())) {
      return setError(t('errors.mac'));
    }
    const copies = Math.min(5, Math.max(1, Number(form.copies) || 1));
    const [scopeType, scopeId] = form.scope.split(':');
    // A USB printer hangs on one till.
    if (form.connectionType === 'usb' && scopeType !== 'machine') return setError(t('errors.usbTill'));
    onSave({
      name,
      purpose: form.purpose,
      cashDrawer: receipt && form.cashDrawer,
      connectionType: form.connectionType,
      host: reach === 'network' ? form.host.trim() : null,
      port: reach === 'network' ? port : null,
      btAddress: reach === 'bluetooth' ? form.btAddress.trim() || null : null,
      btName: reach === 'bluetooth' ? form.btName.trim() || null : null,
      hostMachineId: hosted ? form.hostMachineId : null,
      hostConnection: hosted ? form.hostConnection : null,
      areaId: scopeType === 'area' ? scopeId : null,
      machineId: scopeType === 'machine' ? scopeId : null,
      paperWidth: form.paperWidth === '58' ? 58 : 80,
      printWidthDots:
        reach === 'till' || form.printWidth === AUTO_WIDTH ? null : (Number(form.printWidth) as PrintWidthDots),
      copies,
      cutPaper: form.cutPaper,
      beep: form.beep,
      isActive: form.isActive,
      sortOrder: printer?.sortOrder ?? 0,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{printer ? t('editTitle') : t('addTitle')}</DialogTitle>
          <DialogDescription>{t('dialogHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="kp-name">{t('fields.name')}</Label>
            <Input
              id="kp-name"
              value={form.name}
              maxLength={100}
              placeholder={t('fields.namePlaceholder')}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>

          <div className="space-y-1">
            <Label>{t('fields.purpose')}</Label>
            <SimpleSelect
              value={form.purpose}
              onChange={(v) => setPurpose(v === 'receipt' ? 'receipt' : 'kitchen')}
              options={[
                { value: 'kitchen', label: t('purposes.kitchen') },
                { value: 'receipt', label: t('purposes.receipt') },
              ]}
              ariaLabel={t('fields.purpose')}
            />
            <p className="text-xs text-muted-foreground">{t(`purposeHints.${form.purpose}`)}</p>
          </div>

          <div className="space-y-1">
            <Label>{t('fields.connection')}</Label>
            <SimpleSelect
              value={form.connectionType}
              onChange={(v) => setConnection(v as PrinterConnectionType)}
              options={typeOptions}
              ariaLabel={t('fields.connection')}
            />
            <p className="text-xs text-muted-foreground">
              {form.connectionType === 'network' && t('typeHints.network')}
              {form.connectionType === 'bluetooth' && t('typeHints.bluetooth')}
              {form.connectionType === 'cloud' && (receipt ? t('typeHints.cloudReceipt') : t('typeHints.cloud'))}
              {form.connectionType === 'till' && t('typeHints.till')}
              {form.connectionType === 'usb' && t('typeHints.usb')}
            </p>
          </div>

          {hosted && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>{t('fields.hostMachine')}</Label>
                <SimpleSelect
                  value={form.hostMachineId}
                  onChange={(v) => set({ hostMachineId: v })}
                  options={hostOptions}
                  ariaLabel={t('fields.hostMachine')}
                />
              </div>
              <div className="space-y-1">
                <Label>{t('fields.hostConnection')}</Label>
                <SimpleSelect
                  value={form.hostConnection}
                  onChange={(v) => set({ hostConnection: v as PrinterHostConnection })}
                  options={hostConnectionOptions}
                  ariaLabel={t('fields.hostConnection')}
                />
              </div>
            </div>
          )}

          {reach === 'network' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setScanning(true)}>
                <Radar className="h-4 w-4" /> {t('scan.button')}
              </Button>
              <span className="text-xs text-muted-foreground">{t('scan.dialogHint')}</span>
            </div>
          )}
          {scanning && (
            <NetworkScanDialog
              shopId={page.shopId}
              onClose={() => setScanning(false)}
              onChoose={(p) =>
                set({
                  host: p.host,
                  port: String(p.port),
                  name: form.name.trim() ? form.name : (p.name ?? p.model ?? form.name),
                })
              }
            />
          )}

          {reach === 'network' && (
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1">
                <Label htmlFor="kp-host">{t('fields.address')}</Label>
                <Input
                  id="kp-host"
                  dir="ltr"
                  value={form.host}
                  placeholder="192.168.1.50"
                  onChange={(e) => set({ host: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="kp-port">{t('fields.port')}</Label>
                <Input
                  id="kp-port"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.port}
                  onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })}
                />
              </div>
            </div>
          )}

          {reach === 'bluetooth' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="kp-mac">{t('fields.mac')}</Label>
                <Input
                  id="kp-mac"
                  dir="ltr"
                  value={form.btAddress}
                  placeholder="AA:BB:CC:DD:EE:FF"
                  onChange={(e) => set({ btAddress: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{t('fields.macHint')}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="kp-btname">{t('fields.btName')}</Label>
                <Input id="kp-btname" value={form.btName} onChange={(e) => set({ btName: e.target.value })} />
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Label>{t('fields.scope')}</Label>
            <SimpleSelect
              value={form.scope}
              onChange={(v) => set({ scope: v })}
              options={scopeOptions}
              ariaLabel={t('fields.scope')}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>{t('fields.paper')}</Label>
              <SimpleSelect
                value={form.paperWidth}
                onChange={(v) => set({ paperWidth: v === '58' ? '58' : '80' })}
                options={[
                  { value: '80', label: t('paper80') },
                  { value: '58', label: t('paper58') },
                ]}
                ariaLabel={t('fields.paper')}
              />
            </div>
            {!receipt && (
              <div className="space-y-1">
                <Label htmlFor="kp-copies">{t('fields.copies')}</Label>
                <Input
                  id="kp-copies"
                  inputMode="numeric"
                  value={form.copies}
                  onChange={(e) => set({ copies: e.target.value.replace(/\D/g, '').slice(0, 1) })}
                />
              </div>
            )}
          </div>

          {reach !== 'till' && (
            <div className="space-y-1">
              <Label>{t('fields.printWidth')}</Label>
              <SimpleSelect
                value={form.printWidth}
                onChange={(v) => set({ printWidth: v })}
                options={[
                  { value: AUTO_WIDTH, label: t('printWidths.auto') },
                  ...PRINT_WIDTHS.map((dots) => ({ value: String(dots), label: t('printWidths.dots', { dots }) })),
                ]}
                ariaLabel={t('fields.printWidth')}
              />
              <p className="text-xs text-muted-foreground">{t('printWidthHint')}</p>
            </div>
          )}

          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.cutPaper} onCheckedChange={(v) => set({ cutPaper: v })} />
              {t('fields.cut')}
            </label>
            {receipt ? (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={form.cashDrawer} onCheckedChange={(v) => set({ cashDrawer: v })} />
                {remoteReceipt ? t('fields.cashDrawerRemote') : t('fields.cashDrawer')}
              </label>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={form.beep} onCheckedChange={(v) => set({ beep: v })} />
                {t('fields.beep')}
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.isActive} onCheckedChange={(v) => set({ isActive: v })} />
              {t('fields.active')}
            </label>
          </div>

          {receipt && !remoteReceipt && form.cashDrawer && (
            <p className="text-xs text-muted-foreground">{t('cashDrawerHint')}</p>
          )}
          {remoteReceipt && (
            <p className="text-xs text-muted-foreground">
              {form.cashDrawer ? t('remoteReceiptDrawerHint') : t('remoteReceiptHint')}
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
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
