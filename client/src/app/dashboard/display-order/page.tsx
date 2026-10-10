'use client';

/**
 * "סדר תצוגה" — one page for the order of the tills, the kiosks, online ordering and the digital
 * menu (components/dashboard/display-ordering/ordering-editor.tsx). Pick a channel and a level
 * (company, shop, point of sale, device); the editor says where the order comes from and what it
 * is linked with, and saves it there.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api, fetchCompanies, fetchMachines, fetchShops } from '@/lib/api';
import { CHANNEL_LEVELS, type OrderingChannel, type OrderingLevel } from '@/lib/displayOrdering';
import { OrderingEditor } from '@/components/dashboard/display-ordering/ordering-editor';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const CHANNELS: OrderingChannel[] = ['pos', 'kiosk', 'online', 'menu'];
const PAGE_LEVELS: OrderingLevel[] = ['company', 'shop', 'area', 'machine'];

export default function DisplayOrderPage() {
  const t = useTranslations('displayOrdering');
  const tc = useTranslations('productChannels');
  const [channel, setChannel] = useState<OrderingChannel>('pos');
  const [level, setLevel] = useState<OrderingLevel>('shop');
  const [shopId, setShopId] = useState('');
  const [targetId, setTargetId] = useState('');

  const levels = PAGE_LEVELS.filter((l) => CHANNEL_LEVELS[channel].includes(l));
  const effectiveLevel: OrderingLevel = levels.includes(level) ? level : 'shop';
  const { data: companies = [] } = useQuery({ queryKey: ['companies'], queryFn: () => fetchCompanies() });
  const { data: shops = [] } = useQuery({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const { data: machines = [] } = useQuery({ queryKey: ['machines'], queryFn: () => fetchMachines(), enabled: effectiveLevel === 'machine' });
  const { data: areas = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['shop-areas', shopId],
    queryFn: () => api.get(`/shops/${shopId}/areas`).then((r) => r.data?.items ?? r.data ?? []),
    enabled: effectiveLevel === 'area' && !!shopId,
  });

  const options: { id: string; name: string }[] =
    effectiveLevel === 'company'
      ? companies.map((c) => ({ id: c.id, name: c.name }))
      : effectiveLevel === 'shop'
        ? shops.map((s) => ({ id: s.id, name: s.name }))
        : effectiveLevel === 'area'
          ? areas
          : machines.map((m) => ({ id: m.id, name: m.name ?? m.id }));
  const chosen = options.some((o) => o.id === targetId) ? targetId : '';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('where')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1" role="tablist" aria-label={t('channel')}>
            <Label>{t('channel')}</Label>
            <div className="flex gap-1">
              {CHANNELS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="tab"
                  aria-selected={channel === c}
                  className={`rounded border px-3 py-1 text-sm ${channel === c ? 'border-primary bg-primary text-primary-foreground' : ''}`}
                  onClick={() => setChannel(c)}
                >
                  {tc(c)}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label>{t('level')}</Label>
            <Select
              value={effectiveLevel}
              onValueChange={(v) => {
                setLevel((v as OrderingLevel) ?? 'shop');
                setTargetId('');
              }}
              items={levels.map((l) => ({ value: l, label: t(`level_${l}`) }))}
            >
              <SelectTrigger className="w-36" size="sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {levels.map((l) => <SelectItem key={l} value={l} label={t(`level_${l}`)}>{t(`level_${l}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {effectiveLevel === 'area' ? (
            <div className="space-y-1">
              <Label>{t('level_shop')}</Label>
              <Select value={shopId} onValueChange={(v) => setShopId(String(v ?? ''))} items={shops.map((s) => ({ value: s.id, label: s.name }))}>
                <SelectTrigger className="w-44" size="sm"><SelectValue placeholder={t('choose')} /></SelectTrigger>
                <SelectContent>
                  {shops.map((s) => <SelectItem key={s.id} value={s.id} label={s.name}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label>{t(`level_${effectiveLevel}`)}</Label>
            <Select value={chosen} onValueChange={(v) => setTargetId(String(v ?? ''))} items={options.map((o) => ({ value: o.id, label: o.name }))}>
              <SelectTrigger className="w-52" size="sm"><SelectValue placeholder={t('choose')} /></SelectTrigger>
              <SelectContent>
                {options.map((o) => <SelectItem key={o.id} value={o.id} label={o.name}>{o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
      {chosen ? (
        <Card>
          <CardContent className="pt-4">
            <OrderingEditor key={`${channel}:${effectiveLevel}:${chosen}`} channel={channel} level={effectiveLevel} targetId={chosen} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">{t('pickTarget')}</p>
      )}
    </div>
  );
}
