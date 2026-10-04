'use client';

/**
 * A prepaid voucher's free-text note ("נמסר לדני — במה"): shown under its row in the
 * voucher list, edited in place. The till's lookup shows it to the cashier too.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, StickyNote } from 'lucide-react';
import { setPrepaidVoucherNote, type PrepaidVoucher } from '@/lib/prepaidVouchersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/button';

const NOTE_MAX = 1000;

/** The row's note button: opens the editor. */
export function VoucherNoteButton({ voucher, onEdit }: { voucher: PrepaidVoucher; onEdit: () => void }) {
  const t = useTranslations('prepaidVouchers.note');
  const label = voucher.note ? t('edit') : t('add');
  return (
    <Button size="icon-sm" variant="ghost" aria-label={label} title={label} onClick={onEdit}>
      <StickyNote className={voucher.note ? 'h-4 w-4 text-amber-600 dark:text-amber-400' : 'h-4 w-4'} />
    </Button>
  );
}

/** The note under the row, or its editor while [editing]. */
export function VoucherNote({ voucher, editing, onDone }: {
  voucher: PrepaidVoucher;
  editing: boolean;
  onDone: () => void;
}) {
  const t = useTranslations('prepaidVouchers.note');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [text, setText] = useState(voucher.note ?? '');

  const save = useMutation({
    mutationFn: (note: string | null) => setPrepaidVoucherNote(voucher.id, note),
    onSuccess: (v) => {
      toast.success(v.note ? t('saved') : t('cleared'));
      void qc.invalidateQueries({ queryKey: ['prepaid-vouchers', voucher.batchId] });
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher', voucher.id] });
      onDone();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  if (!editing) {
    return voucher.note ? (
      <p className="whitespace-pre-wrap break-words rounded bg-amber-50 px-2 py-1 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-200">
        {voucher.note}
      </p>
    ) : null;
  }
  return (
    <form
      className="space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!save.isPending) save.mutate(text.trim() || null);
      }}
    >
      <textarea
        autoFocus
        rows={2}
        value={text}
        maxLength={NOTE_MAX}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('placeholder')}
        aria-label={t('label')}
        className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {tc('save')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone} disabled={save.isPending}>
          {tc('cancel')}
        </Button>
        {voucher.note ? (
          <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
            {t('remove')}
          </Button>
        ) : null}
        <span className="ms-auto text-[11px] tabular-nums text-muted-foreground">{text.length}/{NOTE_MAX}</span>
      </div>
    </form>
  );
}
