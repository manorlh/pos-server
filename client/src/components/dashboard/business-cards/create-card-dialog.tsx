'use client';

/** "כרטיס חדש": type, organisation target (company → branch → sales point), name, template, languages. */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { fetchCompanies, fetchShopAreas, fetchShops } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { CARD_TYPES, type CardTemplate, type CardType } from '@/lib/businessCards';
import { createCard } from '@/lib/businessCardsApi';
import { cn } from '@/lib/utils';

import { Hint, NativeSelect } from './bc-ui';
import { TemplatePicker } from './design-editor';
import { NS } from './field-editors';

export function CreateCardDialog({
  open,
  onOpenChange,
  defaultCompanyId,
  defaultShopId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultCompanyId: string | null;
  defaultShopId: string | null;
}) {
  const t = useTranslations(NS);
  const tc = useTranslations(`${NS}.create`);
  const router = useRouter();
  const [type, setType] = useState<CardType>(defaultShopId ? 'branch' : 'company');
  const [companyId, setCompanyId] = useState(defaultCompanyId ?? '');
  const [shopId, setShopId] = useState(defaultShopId ?? '');
  const [areaId, setAreaId] = useState('');
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<CardTemplate>('cover');
  const [english, setEnglish] = useState(false);

  const companies = useQuery({ queryKey: ['companies'], queryFn: fetchCompanies, enabled: open });
  const shops = useQuery({ queryKey: ['shops', companyId], queryFn: () => fetchShops(companyId), enabled: open && !!companyId });
  const areas = useQuery({ queryKey: ['shop-areas', shopId], queryFn: () => fetchShopAreas(shopId), enabled: open && !!shopId && type === 'point' });

  const needsShop = type === 'branch' || type === 'point';
  const ready = !!companyId && !!name.trim() && (!needsShop || !!shopId) && (type !== 'point' || !!areaId);

  const create = useMutation({
    mutationFn: () =>
      createCard({
        type,
        companyId,
        shopId: type === 'company' ? null : shopId || null,
        areaId: type === 'point' ? areaId : null,
        name: name.trim(),
        template,
        languages: english ? ['he', 'en'] : ['he'],
        parentCardId: 'auto',
      }),
    onSuccess: (card) => {
      toast.success(tc('created'));
      onOpenChange(false);
      router.push(`/dashboard/business-cards/${card.id}`);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('errors.generic'))),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tc('title')}</DialogTitle>
          <DialogDescription>{t('subtitle')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !create.isPending) create.mutate();
          }}
        >
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-semibold">{tc('type')}</legend>
            <div role="radiogroup" aria-label={tc('type')} className="grid gap-2 sm:grid-cols-2">
              {CARD_TYPES.map((ct) => (
                <button
                  key={ct}
                  type="button"
                  role="radio"
                  aria-checked={type === ct}
                  onClick={() => {
                    setType(ct);
                    if (ct === 'personal') setTemplate('portrait');
                    if (ct === 'branch' || ct === 'point') setTemplate('location');
                  }}
                  className={cn('rounded-xl border p-2.5 text-start transition hover:border-primary/60', type === ct && 'border-primary ring-2 ring-primary/30')}
                >
                  <span className="block text-sm font-semibold">{t(`types.${ct}`)}</span>
                  <span className="block text-xs text-muted-foreground">{t(`typeHints.${ct}`)}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <NativeSelect
              label={tc('company')}
              value={companyId}
              onChange={(v) => {
                setCompanyId(v);
                setShopId('');
                setAreaId('');
              }}
              options={[{ value: '', label: tc('chooseCompany') }, ...(companies.data ?? []).map((c) => ({ value: c.id, label: c.name }))]}
            />
            {type !== 'company' ? (
              <NativeSelect
                label={type === 'personal' ? tc('shopOptional') : tc('shop')}
                value={shopId}
                disabled={!companyId}
                onChange={(v) => {
                  setShopId(v);
                  setAreaId('');
                }}
                options={[{ value: '', label: type === 'personal' ? tc('noShop') : tc('chooseShop') }, ...(shops.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
              />
            ) : null}
            {type === 'point' ? (
              <div>
                <NativeSelect
                  label={tc('area')}
                  value={areaId}
                  disabled={!shopId}
                  onChange={setAreaId}
                  options={[{ value: '', label: tc('chooseArea') }, ...(areas.data ?? []).map((a) => ({ value: a.id, label: a.name }))]}
                />
                {shopId && areas.data && !areas.data.length ? <Hint tone="warn">{tc('noAreas')}</Hint> : null}
              </div>
            ) : null}
          </div>
          <div className="space-y-1">
            <label htmlFor="bc-new-name" className="text-sm font-semibold">
              {tc('name')}
            </label>
            <Input id="bc-new-name" maxLength={160} value={name} onChange={(e) => setName(e.target.value)} required aria-required />
            <Hint>{tc('nameHint')}</Hint>
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-semibold">{tc('template')}</span>
            <div className="max-h-72 overflow-y-auto">
              <TemplatePicker value={template} onChange={setTemplate} />
            </div>
          </div>
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>{tc('english')}</span>
            <Switch checked={english} onCheckedChange={(v) => setEnglish(!!v)} />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tc('cancel')}
            </Button>
            <Button type="submit" disabled={!ready || create.isPending}>
              {create.isPending ? tc('creating') : tc('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
