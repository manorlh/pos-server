'use client';

/**
 * "הדפס טווח": every Z of one shop between two Z numbers, or between two dates (on the
 * list's date basis), printed as a sequence in the chosen view. Z numbers are per shop,
 * so a range needs exactly one shop in scope.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileDown, Printer } from 'lucide-react';
import type { ZPrintDocumentsParams } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ZPrintViewToggle, type ZPrintView } from '@/components/dashboard/z-report/z-print-view-toggle';

type RangeBy = 'number' | 'date';

export function ZRangePrintDialog({
  open,
  onOpenChange,
  shopId,
  dateBasis,
  view,
  onViewChange,
  busy,
  onPrint,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shopId: string | null | undefined;
  dateBasis: 'business' | 'production';
  view: ZPrintView;
  onViewChange: (view: ZPrintView) => void;
  busy: boolean;
  /** Resolves true once the sequence went to the printer. */
  onPrint: (range: Omit<ZPrintDocumentsParams, 'ids'>, pdf: boolean) => Promise<boolean>;
}) {
  const t = useTranslations('zReports.tillPrint');
  const tc = useTranslations('common');
  const [by, setBy] = useState<RangeBy>('number');
  const [fromNumber, setFromNumber] = useState('');
  const [toNumber, setToNumber] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const range = (): Omit<ZPrintDocumentsParams, 'ids'> | null => {
    if (!shopId) return null;
    if (by === 'number') {
      const lo = fromNumber.trim() ? Number(fromNumber) : undefined;
      const hi = toNumber.trim() ? Number(toNumber) : undefined;
      if (lo === undefined && hi === undefined) return null;
      return { shopId, fromNumber: lo, toNumber: hi };
    }
    if (!from && !to) return null;
    return { shopId, from: from || undefined, to: to || undefined, dateBasis };
  };
  const value = range();

  const submit = async (pdf: boolean) => {
    if (!value) return;
    if (await onPrint(value, pdf)) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('rangeTitle')}</DialogTitle>
          <DialogDescription>{t('rangeDescription')}</DialogDescription>
        </DialogHeader>
        {!shopId ? (
          <p className="text-muted-foreground text-sm">{t('rangeNeedsShop')}</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs">{t('viewLabel')}</span>
              <ZPrintViewToggle value={view} onChange={onViewChange} />
            </div>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('rangeBy')}>
              <span className="text-muted-foreground text-xs">{t('rangeBy')}</span>
              <div className="inline-flex rounded-md border p-0.5">
                {(['number', 'date'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={by === option}
                    onClick={() => setBy(option)}
                    className={`rounded px-2.5 py-1 text-xs ${
                      by === option
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {option === 'number' ? t('rangeByNumber') : t('rangeByDate')}
                  </button>
                ))}
              </div>
            </div>
            {by === 'number' ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t('fromNumber')}</Label>
                  <Input type="number" min={0} inputMode="numeric" value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('toNumber')}</Label>
                  <Input type="number" min={0} inputMode="numeric" value={toNumber} onChange={(e) => setToNumber(e.target.value)} />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t('fromDate')}</Label>
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('toDate')}</Label>
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>
            )}
            {!value ? <p className="text-muted-foreground text-xs">{t('rangeMissingBounds')}</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{tc('cancel')}</Button>
          <Button variant="outline" disabled={!value || busy} onClick={() => void submit(true)}>
            <FileDown className="h-4 w-4 me-1" aria-hidden />
            {t('savePdf')}
          </Button>
          <Button disabled={!value || busy} onClick={() => void submit(false)}>
            <Printer className="h-4 w-4 me-1" aria-hidden />
            {t('print')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
