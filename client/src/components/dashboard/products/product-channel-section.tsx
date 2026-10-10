'use client';

/**
 * The product form's "מופיע ב" (lib/productChannels.ts, pos-server app/services/product_channels.py):
 * four switches — קופה, קיוסק, הזמנות אונליין, תפריט דיגיטלי — saved with the form's own "שמור",
 * and below them, for a saved catalog product, the exceptions per shop / point of sale with their
 * source (set and let go at once, each its own request). Also the list's chips.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Globe, MonitorSmartphone, Store, Tablet, Trash2, UtensilsCrossed } from 'lucide-react';
import { api, fetchShops } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  CHANNELS,
  CHANNEL_LABEL_KEYS,
  WEB_CHANNELS,
  appearsNowhere,
  channelChips,
  channelsOf,
  type Channel,
  type ChannelOverride,
  type Channels,
} from '@/lib/productChannels';
import type { Product } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Patch = (patch: Partial<Product>) => void;

const ICONS: Record<Channel, typeof Store> = {
  pos: Store,
  kiosk: Tablet,
  online: Globe,
  menu: UtensilsCrossed,
};

export function ProductChannelSection({
  product,
  onChange,
  disabled,
}: {
  product: Partial<Product>;
  onChange: Patch;
  disabled?: boolean;
}) {
  const t = useTranslations('productChannels');
  const value = channelsOf(product);
  const set = (channel: Channel, on: boolean) => {
    const next: Channels = { ...value, [channel]: on };
    onChange({ channels: next });
  };
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <Label>{t('title')}</Label>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {CHANNELS.map((channel) => {
          const Icon = ICONS[channel];
          const id = `appears-in-${channel}`;
          return (
            <div key={channel} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden />
                <div>
                  <Label htmlFor={id} className="cursor-pointer">{t(CHANNEL_LABEL_KEYS[channel])}</Label>
                  <p className="text-xs text-muted-foreground">{t(`${channel}Hint`)}</p>
                </div>
              </div>
              <Switch
                id={id}
                disabled={disabled}
                checked={value[channel]}
                onCheckedChange={(on) => set(channel, on)}
                aria-label={t(CHANNEL_LABEL_KEYS[channel])}
              />
            </div>
          );
        })}
      </div>
      {WEB_CHANNELS.some((c) => value[c]) ? (
        <p className="text-xs text-muted-foreground" role="note">{t('webDraftNote')}</p>
      ) : null}
      {appearsNowhere(value) ? (
        <p className="text-xs text-[#B25000]" role="status">{t('nowhere')}</p>
      ) : null}
      {product.id && (product.catalogLevel ?? 'global') === 'global' ? (
        <ProductChannelOverrides productId={product.id} disabled={disabled} />
      ) : null}
    </div>
  );
}

interface ChannelsView {
  productId: string;
  channels: Channels;
  overrides: ChannelOverride[];
  effective: { level: 'shop' | 'area'; targetId: string; targetName?: string | null; channels: Record<Channel, { allowed: boolean; source: string }> }[];
}

interface AreaRow {
  id: string;
  name: string;
}

/** The exceptions of one product: listed with their place and who set them; add / let go at once. */
function ProductChannelOverrides({ productId, disabled }: { productId: string; disabled?: boolean }) {
  const t = useTranslations('productChannels');
  const qc = useQueryClient();
  const key = ['product-channels', productId];
  const { data } = useQuery<ChannelsView>({
    queryKey: key,
    queryFn: () => api.get(`/product-channels/products/${productId}`).then((r) => r.data),
  });
  const { data: shops = [] } = useQuery({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const [shopId, setShopId] = useState<string>('');
  const [areaId, setAreaId] = useState<string>('');
  const [channel, setChannel] = useState<Channel>('online');
  const [allowed, setAllowed] = useState<'on' | 'off'>('off');
  const { data: areas = [] } = useQuery<AreaRow[]>({
    queryKey: ['shop-areas', shopId],
    queryFn: () => api.get(`/shops/${shopId}/areas`).then((r) => r.data?.items ?? r.data ?? []),
    enabled: !!shopId,
  });
  const save = useMutation({
    mutationFn: (overrides: { level: 'shop' | 'area'; targetId: string; channel: Channel; allowed: boolean | null }[]) =>
      api.put(`/product-channels/products/${productId}`, { overrides }).then((r) => r.data),
    onSuccess: (view: ChannelsView) => {
      qc.setQueryData(key, view);
      toast.success(t('saved'));
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });
  const overrides = data?.overrides ?? [];
  const add = () => {
    if (!shopId) return;
    save.mutate([
      { level: areaId ? 'area' : 'shop', targetId: areaId || shopId, channel, allowed: allowed === 'on' },
    ]);
  };
  return (
    <div className="space-y-2 border-t pt-3">
      <div>
        <Label>{t('exceptionsTitle')}</Label>
        <p className="text-xs text-muted-foreground">{t('exceptionsHint')}</p>
      </div>
      {overrides.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('noExceptions')}</p>
      ) : (
        <ul className="space-y-1" aria-label={t('exceptionsTitle')}>
          {overrides.map((o) => (
            <li key={`${o.level}:${o.targetId}:${o.channel}`} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-sm">
              <span>
                <Badge variant="outline" className="me-1">{t(o.level === 'area' ? 'levelArea' : 'levelShop')}</Badge>
                {o.level === 'area' && o.shopName ? `${o.shopName} · ` : ''}
                {o.targetName ?? o.targetId}
                {' — '}
                {t(CHANNEL_LABEL_KEYS[o.channel])}: <strong>{o.allowed ? t('shown') : t('notShown')}</strong>
                {o.updatedBy ? <span className="text-xs text-muted-foreground"> · {t('by', { name: o.updatedBy })}</span> : null}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || save.isPending}
                aria-label={t('letGo')}
                title={t('letGo')}
                onClick={() => save.mutate([{ level: o.level, targetId: o.targetId, channel: o.channel, allowed: null }])}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">{t('shop')}</Label>
          <Select
            value={shopId}
            onValueChange={(v) => {
              setShopId(String(v ?? ''));
              setAreaId('');
            }}
            items={shops.map((s) => ({ value: s.id, label: s.name }))}
          >
            <SelectTrigger className="w-40" size="sm"><SelectValue placeholder={t('chooseShop')} /></SelectTrigger>
            <SelectContent>
              {shops.map((s) => <SelectItem key={s.id} value={s.id} label={s.name}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('area')}</Label>
          <Select
            value={areaId || '__shop'}
            onValueChange={(v) => setAreaId(v && v !== '__shop' ? String(v) : '')}
            items={[{ value: '__shop', label: t('wholeShop') }, ...areas.map((a) => ({ value: a.id, label: a.name }))]}
          >
            <SelectTrigger className="w-40" size="sm" disabled={!shopId}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__shop" label={t('wholeShop')}>{t('wholeShop')}</SelectItem>
              {areas.map((a) => <SelectItem key={a.id} value={a.id} label={a.name}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('channel')}</Label>
          <Select
            value={channel}
            onValueChange={(v) => setChannel((v as Channel) ?? 'online')}
            items={CHANNELS.map((c) => ({ value: c, label: t(CHANNEL_LABEL_KEYS[c]) }))}
          >
            <SelectTrigger className="w-36" size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CHANNELS.map((c) => <SelectItem key={c} value={c} label={t(CHANNEL_LABEL_KEYS[c])}>{t(CHANNEL_LABEL_KEYS[c])}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('state')}</Label>
          <Select
            value={allowed}
            onValueChange={(v) => setAllowed(v === 'on' ? 'on' : 'off')}
            items={[{ value: 'on', label: t('shown') }, { value: 'off', label: t('notShown') }]}
          >
            <SelectTrigger className="w-28" size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="on" label={t('shown')}>{t('shown')}</SelectItem>
              <SelectItem value="off" label={t('notShown')}>{t('notShown')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={disabled || !shopId || save.isPending} onClick={add}>
          {t('addException')}
        </Button>
      </div>
    </div>
  );
}

/** The list's chips: nothing for a product on the tills and kiosks only; else each channel it is on. */
export function ProductChannelBadge({ product }: { product: { channels?: unknown; salesChannel?: unknown } }) {
  const t = useTranslations('productChannels');
  const channels = channelsOf(product);
  if (appearsNowhere(channels)) {
    return <Badge variant="outline" title={t('title')}>{t('nowhereShort')}</Badge>;
  }
  const chips = channelChips(channels);
  if (chips.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5" title={t('title')} aria-label={`${t('title')}: ${chips.map((c) => t(CHANNEL_LABEL_KEYS[c])).join(', ')}`}>
      {chips.map((c) => {
        const Icon = c === 'menu' ? UtensilsCrossed : c === 'online' ? Globe : c === 'kiosk' ? MonitorSmartphone : Store;
        return (
          <Badge key={c} variant="outline" className="gap-1 px-1.5">
            <Icon className="h-3 w-3" aria-hidden />
            <span className="text-[10px]">{t(`${c}Short`)}</span>
          </Badge>
        );
      })}
    </span>
  );
}
