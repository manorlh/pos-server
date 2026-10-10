'use client';

/**
 * The super admin's confirmation before moving the shop Z's production by force — the
 * producer has not confirmed that every shop Z it printed is in the cloud, so a Z it
 * prints later may carry a number the cloud cannot take (kept as printed, for support).
 * Used by "העבר את הפקת ה-Z עכשיו" and by "העבר בכל זאת (מנהל-על)" on a refused switch.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function ShopZForceDialog({
  open,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('independentTill.force');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
            {t('title')}
          </DialogTitle>
          <DialogDescription>{t('text')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
