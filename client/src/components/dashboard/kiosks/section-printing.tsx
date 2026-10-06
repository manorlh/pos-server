'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { fetchKitchenPrinters } from '@/lib/kitchenPrintersApi';
import { KIOSK_LIMITS, type BonMode } from '@/lib/kioskConfig';
import { useKioskEditor, useKioskField } from './editor-context';
import { FieldShell, NumberField, OptionSelect, SectionCard, SegmentField, SwitchField } from './fields';

const TILL_DEFAULT = '__till__';
const NONE = '__none__';

export function PrintingSection() {
  const t = useTranslations('kiosks.printing');
  const tf = useTranslations('kiosks.fields');
  const ed = useKioskEditor();
  const mode = useKioskField<BonMode>('printing.bonMode');
  const bonPrinter = useKioskField<string | null>('printing.bonPrinterId');
  const receiptPrinter = useKioskField<string | null>('printing.receiptPrinterId');

  const { data: page, isLoading } = useQuery({
    queryKey: ['kitchen-printers', ed.shopId],
    queryFn: () => fetchKitchenPrinters(ed.shopId as string),
    enabled: !!ed.shopId,
  });
  const printers = page?.printers ?? [];
  const kitchen = printers.filter((p) => (p.purpose ?? 'kitchen') === 'kitchen');
  const receipts = printers.filter((p) => p.purpose === 'receipt');
  const label = (p: { name: string; isActive: boolean }) => (p.isActive ? p.name : `${p.name} (${t('inactive')})`);

  const bonOptions = [
    ...(bonPrinter.value && !kitchen.some((p) => p.id === bonPrinter.value)
      ? [{ value: bonPrinter.value, label: t('unknownPrinter') }]
      : []),
    ...(bonPrinter.value ? [] : [{ value: NONE, label: t('printerPlaceholder') }]),
    ...kitchen.map((p) => ({ value: p.id, label: label(p) })),
  ];
  const receiptOptions = [
    { value: TILL_DEFAULT, label: t('receiptDefault') },
    ...(receiptPrinter.value && !receipts.some((p) => p.id === receiptPrinter.value)
      ? [{ value: receiptPrinter.value, label: t('unknownPrinter') }]
      : []),
    ...receipts.map((p) => ({ value: p.id, label: label(p) })),
  ];

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
          <FieldShell path="printing.bonPrinterId" label={tf('printing.bonPrinterId')}>
            {!ed.shopId ? (
              <p className="text-sm text-muted-foreground">{t('printersAtShop')}</p>
            ) : isLoading ? null : kitchen.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noPrinters')}</p>
            ) : (
              <OptionSelect
                value={bonPrinter.value ?? NONE}
                disabled={bonPrinter.disabled}
                ariaLabel={tf('printing.bonPrinterId')}
                options={bonOptions}
                onChange={(v) => bonPrinter.set(v === NONE ? null : v)}
              />
            )}
          </FieldShell>
        ) : null}
        <NumberField
          path="printing.bonCopies"
          label={tf('printing.bonCopies')}
          min={KIOSK_LIMITS.bonCopies.min}
          max={KIOSK_LIMITS.bonCopies.max}
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
