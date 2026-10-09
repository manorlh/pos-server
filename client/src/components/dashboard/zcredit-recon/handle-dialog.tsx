'use client';

/** "סמן כטופל" with a note — the item's exception in the exceptions log is closed with the same note. */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { markReconHandled } from '@/lib/zcreditReconApi';
import type { ReconItem } from '@/lib/zcreditRecon';

const NOTE_MAX = 500;

export function ZCreditHandleDialog({
  item,
  open,
  onOpenChange,
  onDone,
}: {
  item: ReconItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const t = useTranslations('zcreditRecon.handle');
  const tc = useTranslations('common');
  const [note, setNote] = useState('');
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setNote('');
  }
  const save = useMutation({
    mutationFn: () => markReconHandled(item!.id, note.trim() || null),
    onSuccess: () => {
      toast.success(t('saved'));
      onDone();
      onOpenChange(false);
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, tc('error'))),
  });
  if (!item) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{item.reason ?? item.categoryLabel}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="zc-handle-note">{t('note')}</Label>
          <textarea
            id="zc-handle-note"
            className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 text-sm"
            maxLength={NOTE_MAX}
            value={note}
            placeholder={t('notePlaceholder')}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
