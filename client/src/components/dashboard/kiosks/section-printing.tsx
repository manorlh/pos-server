'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { ensureTillLocalPrinter, fetchKitchenPrinters, fetchTillLocalPrinters } from '@/lib/kitchenPrintersApi';
import { KIOSK_LIMITS, type BonMode } from '@/lib/kioskConfig';
import { NONE_VALUE, bonPrinterChoices, choiceOf, type LocalConnection } from '@/lib/kioskBonPrinters';
import { useKioskEditor, useKioskField } from './editor-context';
import { FieldShell, NumberField, OptionSelect, SectionCard, SegmentField, SwitchField } from './fields';

const TILL_DEFAULT = '__till__';

export function PrintingSection() {
  const t = useTranslations('kiosks.printing');
  const tf = useTranslations('kiosks.fields');
  const tm = useTranslations('machines.deviceModel.badge');
  const ed = useKioskEditor();
  const qc = useQueryClient();
  const mode = useKioskField<BonMode>('printing.bonMode');
  const bonPrinter = useKioskField<string | null>('printing.bonPrinterId');
  const receiptPrinter = useKioskField<string | null>('printing.receiptPrinterId');

  const { data: page, isLoading } = useQuery({
    queryKey: ['kitchen-printers', ed.shopId],
    queryFn: () => fetchKitchenPrinters(ed.shopId as string),
    enabled: !!ed.shopId,
  });
  // Each till's own printer by name ("המדפסת המובנית — קופה 2"), docs/SPEC_KIOSK.md §16.9.
  const { data: tillPrinters = [], isLoading: tillLoading } = useQuery({
    queryKey: ['till-local-printers', ed.shopId],
    queryFn: () => fetchTillLocalPrinters(ed.shopId as string),
    enabled: !!ed.shopId,
  });
  // Picking a till's printer makes (or switches on) the printer entry behind it, then chooses it.
  const makeLocal = useMutation({
    mutationFn: (v: { machineId: string; connection: LocalConnection }) =>
      ensureTillLocalPrinter(ed.shopId as string, v.machineId, v.connection),
    onSuccess: (printer) => {
      bonPrinter.set(printer.id);
      void qc.invalidateQueries({ queryKey: ['kitchen-printers', ed.shopId] });
      void qc.invalidateQueries({ queryKey: ['till-local-printers', ed.shopId] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('localError'))),
  });

  const printers = page?.printers ?? [];
  const kitchen = printers.filter((p) => (p.purpose ?? 'kitchen') === 'kitchen');
  const receipts = printers.filter((p) => p.purpose === 'receipt');
  const label = (p: { name: string; isActive: boolean }) => (p.isActive ? p.name : `${p.name} (${t('inactive')})`);

  const bonOptions = bonPrinterChoices(kitchen, tillPrinters, bonPrinter.value ?? null, {
    local: (connection, till, model, device) =>
      `${t(`local.${connection}`)} — ${till}` +
      (model && tm.has(model) ? ` (${tm(model)})` : '') +
      (device ? ` · ${device}` : ''),
    inactive: (text) => `${text} (${t('inactive')})`,
    unknown: t('unknownPrinter'),
    placeholder: t('printerPlaceholder'),
  });
  const hasChoice = kitchen.length > 0 || tillPrinters.length > 0;
  const receiptOptions = [
    { value: TILL_DEFAULT, label: t('receiptDefault') },
    ...(receiptPrinter.value && !receipts.some((p) => p.id === receiptPrinter.value)
      ? [{ value: receiptPrinter.value, label: t('unknownPrinter') }]
      : []),
    ...receipts.map((p) => ({ value: p.id, label: label(p) })),
  ];

  const pickBonPrinter = (value: string) => {
    if (value === NONE_VALUE) return bonPrinter.set(null);
    const choice = choiceOf(bonOptions, value);
    if (choice?.local) makeLocal.mutate(choice.local);
    else bonPrinter.set(value);
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title={t('bonTitle')}
        description={t('bonHint')}
        paths={['printing.bonMode', 'printing.bonPrinterId', 'printing.bonCopies']}
      >
        <SegmentField<BonMode>
          path="printing.bonMode"
          label={tf('printing.bonMode')}
          hint={t(`modeHint.${mode.value ?? 'routing'}`)}
          options={(['routing', 'single'] as const).map((v) => ({ value: v, label: t(`mode.${v}`) }))}
        />
        {mode.value === 'single' ? (
          <FieldShell path="printing.bonPrinterId" label={tf('printing.bonPrinterId')} hint={t('localHint')}>
            {!ed.shopId ? (
              <p className="text-sm text-muted-foreground">{t('printersAtShop')}</p>
            ) : isLoading || tillLoading ? null : !hasChoice ? (
              <p className="text-sm text-muted-foreground">{t('noPrinters')}</p>
            ) : (
              <OptionSelect
                value={bonPrinter.value ?? NONE_VALUE}
                disabled={bonPrinter.disabled || makeLocal.isPending}
                ariaLabel={tf('printing.bonPrinterId')}
                options={bonOptions.map(({ value, label: text }) => ({ value, label: text }))}
                onChange={pickBonPrinter}
              />
            )}
          </FieldShell>
        ) : ed.shopId && tillPrinters.length > 0 ? (
          <p className="text-xs text-muted-foreground">{t('localRoutingHint')}</p>
        ) : null}
        <NumberField
          path="printing.bonCopies"
          label={tf('printing.bonCopies')}
          min={KIOSK_LIMITS.bonCopies.min}
          max={KIOSK_LIMITS.bonCopies.max}
        />
        {/* An unprinted bon: printed again by itself when the printer comes back (docs/SPEC_KIOSK.md §16.8). */}
        <NumberField
          path="printing.bonAutoRetryMin"
          label={tf('printing.bonAutoRetryMin')}
          hint={t('bonAutoRetryHint')}
          min={0}
          max={120}
        />
      </SectionCard>

      <SectionCard title={t('receiptTitle')} paths={['printing.receiptPrinterId', 'printing.pickupSlip']}>
        <FieldShell path="printing.receiptPrinterId" label={tf('printing.receiptPrinterId')} hint={t('receiptHint')}>
          {!ed.shopId ? (
            <p className="text-sm text-muted-foreground">{t('printersAtShop')}</p>
          ) : (
            <OptionSelect
              value={receiptPrinter.value ?? TILL_DEFAULT}
              disabled={receiptPrinter.disabled || isLoading}
              ariaLabel={tf('printing.receiptPrinterId')}
              options={receiptOptions}
              onChange={(v) => receiptPrinter.set(v === TILL_DEFAULT ? null : v)}
            />
          )}
        </FieldShell>
        <SwitchField path="printing.pickupSlip" label={tf('printing.pickupSlip')} hint={t('pickupSlipHint')} />
      </SectionCard>
    </div>
  );
}
