'use client';

/**
 * "קוד סניף הוקצה אוטומטית — ודאו מול רו״ח": a shop whose branch code the server assigned
 * when the code became mandatory (the lowest free code of its company). The code goes into
 * the tax file, so it is shown until someone confirms it — saving the shop's code, here or
 * in the shop form, clears it (server/app/services/branch_code.py).
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { branchCodeNeedsCheck } from '@/lib/branchCode';
import type { Shop } from '@/lib/types';
import { Button } from '@/components/ui/button';

export function BranchCodeNotice({ shop, canEdit }: { shop: Shop; canEdit: boolean }) {
  const t = useTranslations('shops');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const confirm = useMutation({
    mutationFn: () => api.put<Shop>(`/shops/${shop.id}`, { branchId: shop.branchId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shops'] });
      qc.invalidateQueries({ queryKey: ['shop', shop.id] });
      toast.success(t('branchIdConfirmed'));
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  if (!branchCodeNeedsCheck(shop)) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1">
        {t('branchIdAutoAssigned')} <span className="font-mono">({shop.branchId})</span>
      </span>
      {canEdit ? (
        <Button size="sm" variant="outline" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
          {t('branchIdConfirm')}
        </Button>
      ) : null}
    </div>
  );
}
