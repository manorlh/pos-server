'use client';

/**
 * "שליחה לפי קבוצות": a batch made in groups (envelopes) can send each group's PDF as one message,
 * to a phone chosen per group (the group's leader) — or to no phone at all, shared by hand (the
 * share sheet lets the operator pick a WhatsApp group; a wa.me link cannot target one).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { fetchDistributionGroups, importDistribution } from '@/lib/voucherDistributionApi';
import type { PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { serialsText } from '@/lib/voucherDistribution';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { keys, useDistributionError, useRefreshDistribution } from './shared';

export function GroupSends({ batch }: { batch: PrepaidVoucherBatch }) {
  const t = useTranslations('voucherDistribution.groups');
  const tp = useTranslations('voucherDistribution.problems');
  const errorText = useDistributionError();
  const refresh = useRefreshDistribution(batch.id);
  const groups = useQuery({ queryKey: keys.groups(batch.id), queryFn: () => fetchDistributionGroups(batch.id) });
  const [draft, setDraft] = useState<Record<number, { phone: string; name: string; on: boolean }>>({});

  const open = (groups.data ?? []).filter((g) => g.free > 0);
  const row = (g: number) => draft[g] ?? { phone: '', name: '', on: true };
  const set = (g: number, patch: Partial<{ phone: string; name: string; on: boolean }>) =>
    setDraft((d) => ({ ...d, [g]: { ...row(g), ...patch } }));
  const picked = open.filter((g) => row(g.group).on);

  const create = useMutation({
    mutationFn: () =>
      importDistribution(batch.id, {
        mode: 'group',
        kind: 'group',
        rows: picked.map((g) => ({ group: String(g.group), phone: row(g.group).phone.trim() || null, name: row(g.group).name.trim() || null })),
      }),
    onSuccess: (out) => {
      if (out.skipped.length) {
        toast.warning(t('someSkipped', {
          n: out.skipped.length,
          why: out.skipped.map((s) => `${s.group ?? '?'}: ${s.problems.map((p) => (tp.has(p) ? tp(p) : p)).join(', ')}`).join(' · '),
        }));
      }
      toast.success(t('created', { n: out.summary.created }));
      setDraft({});
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
        <p className="text-xs text-muted-foreground">{t('whatsappGroups')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {groups.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : open.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        ) : (
          <>
            <div className="max-h-80 overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted text-xs">
                  <tr>
                    <th className="p-2 text-start">{t('col.send')}</th>
                    <th className="p-2 text-start">{t('col.group')}</th>
                    <th className="p-2 text-start">{t('col.free')}</th>
                    <th className="p-2 text-start">{t('col.phone')}</th>
                    <th className="p-2 text-start">{t('col.name')}</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((g) => (
                    <tr key={g.group} className="border-t">
                      <td className="p-2">
                        <input type="checkbox" checked={row(g.group).on} onChange={(e) => set(g.group, { on: e.target.checked })}
                          aria-label={t('col.send')} />
                      </td>
                      <td className="p-2 tabular-nums">
                        {g.group}
                        <span className="block text-xs text-muted-foreground" dir="ltr">
                          {g.fromSerial === g.toSerial ? serialsText([g.fromSerial]) : `${serialsText([g.fromSerial])}-${serialsText([g.toSerial])}`}
                        </span>
                      </td>
                      <td className="p-2 tabular-nums">{t('freeOf', { free: g.free, total: g.total })}</td>
                      <td className="p-2">
                        <Input dir="ltr" value={row(g.group).phone} placeholder={t('phoneOptional')} className="h-8 w-40"
                          onChange={(e) => set(g.group, { phone: e.target.value })} aria-label={t('col.phone')} />
                      </td>
                      <td className="p-2">
                        <Input value={row(g.group).name} placeholder={t('nameOptional')} className="h-8 w-40"
                          onChange={(e) => set(g.group, { name: e.target.value })} aria-label={t('col.name')} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button onClick={() => create.mutate()} disabled={!picked.length || create.isPending}>
              {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t('create', { n: picked.length })}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
