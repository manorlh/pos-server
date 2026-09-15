'use client';

/**
 * Moving a company to a different place in the group.
 *
 * Separated from the edit form on purpose. Setting a parent at creation costs nothing —
 * there is nothing underneath yet. Moving an existing company carries every shop, till
 * and receipt beneath it into another branch, which changes who can see whose takings,
 * so it is a deliberate action that states its consequences before it happens rather
 * than a dropdown someone changes while fixing a typo in an address.
 *
 * The candidate list and the impact counts both come from the server, which applies the
 * same no-self, no-descendant and depth rules the save enforces. Recomputing them here
 * would mean two answers to one question, and the picker would eventually offer a parent
 * the save refuses.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { api, fetchParentOptions } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { Company } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

export function CompanyMoveDialog({
  company,
  open,
  onOpenChange,
}: {
  company: Company;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('companies');
  const tc = useTranslations('common');
  const qc = useQueryClient();

  // `undefined` is "nothing chosen yet", which is not the same as `null` — the latter
  // is an explicit choice to detach to the top level, and the two must not be confused
  // or opening the dialog would look like a pending detach.
  const [target, setTarget] = useState<string | null | undefined>(undefined);

  const { data, isLoading } = useQuery({
    queryKey: ['company-parent-options', company.id],
    queryFn: () => fetchParentOptions(company.id),
    enabled: open,
  });

  const move = useMutation({
    mutationFn: async () => {
      const { data: saved } = await api.put<Company>(`/companies/${company.id}`, {
        parentCompanyId: target ?? null,
      });
      return saved;
    },
    onSuccess: () => {
      // The whole tree shifts, so anything scoped by company is now stale.
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['shops'] });
      qc.invalidateQueries({ queryKey: ['machines'] });
      toast.success(t('moved'));
      onOpenChange(false);
      setTarget(undefined);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const chosen = target !== undefined;
  const carries =
    (data?.movesShops ?? 0) + (data?.movesMachines ?? 0) + (data?.movesCompanies ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('moveTitle', { name: company.name })}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">{tc('loading')}</p>
        ) : (
          <div className="space-y-4 text-sm">
            {/* Stated before the choice, not after it. */}
            {carries ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                <p>
                  {t('moveCarries', {
                    companies: data?.movesCompanies ?? 0,
                    shops: data?.movesShops ?? 0,
                    machines: data?.movesMachines ?? 0,
                  })}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">{t('moveCarriesNothing')}</p>
            )}

            <div className="space-y-1">
              <Label htmlFor="company-move-target">{t('moveTargetLabel')}</Label>
              <select
                id="company-move-target"
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                value={target === undefined ? '__unset__' : (target ?? '')}
                onChange={(e) =>
                  setTarget(e.target.value === '__unset__' ? undefined : e.target.value || null)
                }
              >
                <option value="__unset__">{t('moveChoose')}</option>
                {data?.mayDetach ? <option value="">{t('moveDetach')}</option> : null}
                {(data?.options ?? []).map((o) => (
                  <option key={o.id} value={o.id} disabled={!o.allowed}>
                    {' '.repeat(o.depth * 3)}
                    {o.name}
                    {o.allowed ? '' : ` — ${o.reason ?? ''}`}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {tc('cancel')}
              </Button>
              <Button disabled={!chosen || move.isPending} onClick={() => move.mutate()}>
                {move.isPending ? tc('loading') : t('moveConfirm')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
