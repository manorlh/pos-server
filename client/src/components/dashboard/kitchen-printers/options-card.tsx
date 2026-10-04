'use client';

/**
 * The two kitchen options at the shop, each point of sale and each till: "tickets on a
 * counter sale" (`kitchenTicketsOnSale`) and "a copy on the till too"
 * (`kitchenTicketsOnTill`). They are till parameters: a level left on "inherit" takes the
 * level above it (till → point of sale → shop → company → default).
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  saveKitchenOptions,
  type KitchenOptionKey,
  type KitchenOptionValues,
  type KitchenPrintersPage,
} from '@/lib/kitchenPrintersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SimpleSelect } from './printer-dialog';

const KEYS: KitchenOptionKey[] = ['kitchenTicketsOnSale', 'kitchenTicketsOnTill'];

type Level = { type: 'shop' | 'area' | 'machine'; id: string; name: string; values: KitchenOptionValues };

export function OptionsCard({ page }: { page: KitchenPrintersPage }) {
  const t = useTranslations('kitchenPrinters.options');
  const tc = useTranslations('common');
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: (v: { level: Level; key: KitchenOptionKey; value: boolean | null }) =>
      saveKitchenOptions(page.shopId, v.level.type, v.level.id, { [v.key]: v.value }),
    onSuccess: (options) => {
      qc.setQueryData<KitchenPrintersPage>(['kitchen-printers', page.shopId], (old) =>
        old ? { ...old, options } : old,
      );
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const levels: Level[] = [
    { type: 'shop', id: page.shopId, name: t('shop'), values: page.options.shop },
    ...page.areas.map((a) => ({
      type: 'area' as const,
      id: a.id,
      name: t('area', { name: a.name }),
      values: page.options.areas[a.id] ?? {},
    })),
    ...page.machines.map((m) => ({
      type: 'machine' as const,
      id: m.id,
      name: t('machine', { name: m.name }),
      values: page.options.machines[m.id] ?? {},
    })),
  ];

  const options = (key: KitchenOptionKey, level: Level) => [
    {
      value: 'inherit',
      label:
        level.type === 'shop'
          ? t('inheritDefault', { value: page.options.defaults[key] ? t('on') : t('off') })
          : t('inherit'),
    },
    { value: 'on', label: t('on') },
    { value: 'off', label: t('off') },
  ];

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('level')}</TableHead>
              <TableHead>{t('onSale')}</TableHead>
              <TableHead>{t('onTill')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {levels.map((level) => (
              <TableRow key={`${level.type}:${level.id}`}>
                <TableCell className="font-medium">{level.name}</TableCell>
                {KEYS.map((key) => {
                  const current = level.values[key];
                  return (
                    <TableCell key={key} className="min-w-44">
                      <SimpleSelect
                        value={current === undefined ? 'inherit' : current ? 'on' : 'off'}
                        disabled={!page.canEdit || save.isPending}
                        options={options(key, level)}
                        ariaLabel={`${level.name} — ${key === 'kitchenTicketsOnSale' ? t('onSale') : t('onTill')}`}
                        onChange={(v) =>
                          save.mutate({ level, key, value: v === 'inherit' ? null : v === 'on' })
                        }
                      />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
