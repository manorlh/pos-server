'use client';

/**
 * "סדר תצוגה" — the one ordering editor (lib/displayOrdering.ts; pos-server
 * app/routers/display_orderings.py). For one channel at one level: where the order comes from
 * (this level, inherited, today's device keys, or the catalog), "מקושר ל…" with "נתק", link to or
 * copy from another channel, and the order itself — categories and each category's products,
 * dragged, moved up / down, or given a number, and pinned first. Saving moves every level linked
 * to the same ordering; the tills and kiosks get it through the keys they read today.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Link2, Link2Off, Pin, PinOff } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  linkedText,
  moveItem,
  moveToPosition,
  orderingFromEditor,
  pinnedFirst,
  togglePinned,
  type OrderingChannel,
  type OrderingLevel,
  type OrderingView,
} from '@/lib/displayOrdering';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const CHANNELS: OrderingChannel[] = ['pos', 'kiosk', 'online', 'menu'];

interface Draft {
  key: string;
  categories: string[];
  products: Record<string, string[]>;
  pinnedCategories: string[];
  pinnedProducts: Record<string, string[]>;
}

function draftOf(view: OrderingView): Draft {
  const arranged = view.arranged ?? { categories: view.effective.categories, products: view.effective.products };
  return {
    key: `${view.channel}:${view.level}:${view.targetId}:${view.ordering?.version ?? 0}:${view.binding?.orderingId ?? ''}`,
    categories: [...arranged.categories],
    products: Object.fromEntries(Object.entries(arranged.products).map(([k, v]) => [k, [...v]])),
    pinnedCategories: [...(view.effective.pinned?.categories ?? [])],
    pinnedProducts: Object.fromEntries(Object.entries(view.effective.pinned?.products ?? {}).map(([k, v]) => [k, [...v]])),
  };
}

function SortableList({
  ids,
  names,
  pinned,
  selected,
  onSelect,
  onChange,
  onPin,
  label,
}: {
  ids: string[];
  names: Record<string, string>;
  pinned: string[];
  selected?: string | null;
  onSelect?: (id: string) => void;
  onChange: (ids: string[]) => void;
  onPin: (id: string) => void;
  label: string;
}) {
  const t = useTranslations('displayOrdering');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const shown = pinnedFirst(pinned, ids);
  return (
    <ol className="space-y-1" aria-label={label}>
      {shown.map((id, index) => {
        const isPinned = pinned.includes(id);
        return (
          <li
            key={id}
            draggable
            onDragStart={() => setDragFrom(index)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragFrom !== null) onChange(moveItem(shown, dragFrom, index));
              setDragFrom(null);
            }}
            className={`flex items-center gap-2 rounded border px-2 py-1 text-sm ${selected === id ? 'border-primary bg-primary/5' : ''}`}
          >
            <span className="w-6 text-xs text-muted-foreground" aria-hidden>{index + 1}</span>
            <button
              type="button"
              className="flex-1 truncate text-start"
              onClick={() => onSelect?.(id)}
              aria-current={selected === id ? 'true' : undefined}
            >
              {names[id] ?? id}
              {isPinned ? <Badge variant="outline" className="ms-2">{t('pinned')}</Badge> : null}
            </button>
            <Input
              type="number"
              min={1}
              max={shown.length}
              defaultValue={index + 1}
              key={`${id}:${index}`}
              className="h-7 w-14"
              aria-label={t('positionOf', { name: names[id] ?? id })}
              onBlur={(e) => {
                const value = Number(e.target.value);
                if (value && value !== index + 1) onChange(moveToPosition(shown, id, value));
              }}
            />
            <Button type="button" variant="ghost" size="sm" aria-label={t('moveUp', { name: names[id] ?? id })} disabled={index === 0} onClick={() => onChange(moveItem(shown, index, index - 1))}>
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="sm" aria-label={t('moveDown', { name: names[id] ?? id })} disabled={index === shown.length - 1} onClick={() => onChange(moveItem(shown, index, index + 1))}>
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="sm" aria-pressed={isPinned} aria-label={isPinned ? t('unpin') : t('pin')} onClick={() => onPin(id)}>
              {isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            </Button>
          </li>
        );
      })}
    </ol>
  );
}

export function OrderingEditor({
  channel,
  level,
  targetId,
  canEdit = true,
}: {
  channel: OrderingChannel;
  level: OrderingLevel;
  targetId: string;
  canEdit?: boolean;
}) {
  const t = useTranslations('displayOrdering');
  const tc = useTranslations('productChannels');
  const qc = useQueryClient();
  const key = ['display-ordering', channel, level, targetId];
  const { data: view, isLoading } = useQuery<OrderingView>({
    queryKey: key,
    queryFn: () =>
      api.get('/display-orderings/view', { params: { channel, level, targetId, includeCatalog: true } }).then((r) => r.data),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [other, setOther] = useState<OrderingChannel>(channel === 'pos' ? 'kiosk' : 'pos');
  const fresh = view ? draftOf(view) : null;
  const current = draft && fresh && draft.key === fresh.key ? draft : fresh;
  const dirty = !!draft && !!fresh && draft.key === fresh.key;

  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of view?.catalog?.categories ?? []) out[c.id] = c.name;
    for (const p of view?.catalog?.products ?? []) out[p.id] = p.name;
    return out;
  }, [view]);

  const onDone = (next: OrderingView) => {
    qc.setQueryData(key, next);
    qc.invalidateQueries({ queryKey: ['display-ordering'] });
    setDraft(null);
  };
  const onFail = (e: unknown) => {
    toast.error(axiosErrorToToastMessage(e, t('saveFailed')));
    qc.invalidateQueries({ queryKey: key });
  };
  const save = useMutation({
    mutationFn: () => {
      if (!current) throw new Error('nothing');
      const ordering = orderingFromEditor(
        current.categories,
        current.products,
        { categories: current.pinnedCategories, products: current.pinnedProducts },
        view?.ordering?.newItems ?? 'end',
      );
      return api
        .put('/display-orderings/view', { channel, level, targetId, version: view?.binding ? view?.ordering?.version : undefined, ordering })
        .then((r) => r.data as OrderingView);
    },
    onSuccess: (next) => {
      toast.success(t('saved'));
      onDone(next);
    },
    onError: onFail,
  });
  const action = useMutation({
    mutationFn: (what: 'unlink' | 'link' | 'copy' | 'clear') => {
      const body = { channel, level, targetId };
      if (what === 'unlink') return api.post('/display-orderings/unlink', body).then((r) => r.data as OrderingView);
      if (what === 'clear') return api.delete('/display-orderings/view', { params: body }).then((r) => r.data as OrderingView);
      const source = { channel: other, level, targetId };
      return api.post(`/display-orderings/${what}`, { ...body, source }).then((r) => r.data as OrderingView);
    },
    onSuccess: (next) => {
      toast.success(t('saved'));
      onDone(next);
    },
    onError: onFail,
  });

  if (isLoading || !view || !current) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  const linked = linkedText(view);
  const sourceText =
    view.source.kind === 'catalog'
      ? t('sourceCatalog')
      : view.source.level === view.level && view.source.targetId === view.targetId
        ? view.source.kind === 'legacy'
          ? t('sourceLegacyHere')
          : t('sourceHere')
        : t('sourceInherited', { level: t(`level_${view.source.level}`) });
  const selected = category && current.categories.includes(category) ? category : current.categories[0] ?? null;
  const update = (patch: Partial<Draft>) => setDraft({ ...current, ...patch });
  const otherChannels = CHANNELS.filter((c) => c !== channel);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{sourceText}</Badge>
        {linked ? (
          <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-primary" role="status">
            <Link2 className="h-4 w-4" aria-hidden /> {linked}
          </span>
        ) : view.binding ? (
          <Badge variant="outline">{view.binding.copiedFromOrderingId ? t('copiedOnce') : t('independent')}</Badge>
        ) : null}
        {view.diverged ? <span className="text-[#B25000]">{t('diverged')}</span> : null}
        {linked && canEdit ? (
          <Button type="button" size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate('unlink')}>
            <Link2Off className="h-4 w-4 me-1" aria-hidden /> {t('unlink')}
          </Button>
        ) : null}
      </div>
      {canEdit ? (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <Select
            value={other}
            onValueChange={(v) => setOther((v as OrderingChannel) ?? other)}
            items={otherChannels.map((c) => ({ value: c, label: tc(c) }))}
          >
            <SelectTrigger className="w-40" size="sm" aria-label={t('otherChannel')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {otherChannels.map((c) => <SelectItem key={c} value={c} label={tc(c)}>{tc(c)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button type="button" size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate('link')}>
            {t('linkTo')}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate('copy')}>
            {t('copyFrom')}
          </Button>
          {view.binding || view.ordering?.implicit ? (
            <Button type="button" size="sm" variant="ghost" disabled={action.isPending} onClick={() => action.mutate('clear')}>
              {t('backToInherit')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label={t('categories')} className="space-y-2">
          <h3 className="text-sm font-medium">{t('categories')}</h3>
          <SortableList
            ids={current.categories}
            names={names}
            pinned={current.pinnedCategories}
            selected={selected}
            onSelect={setCategory}
            onChange={(ids) => update({ categories: ids })}
            onPin={(id) => update({ pinnedCategories: togglePinned(current.pinnedCategories, id) })}
            label={t('categories')}
          />
        </section>
        <section aria-label={t('products')} className="space-y-2">
          <h3 className="text-sm font-medium">{selected ? t('productsOf', { name: names[selected] ?? selected }) : t('products')}</h3>
          {selected ? (
            <SortableList
              ids={current.products[selected] ?? []}
              names={names}
              pinned={current.pinnedProducts[selected] ?? []}
              onChange={(ids) => update({ products: { ...current.products, [selected]: ids } })}
              onPin={(id) =>
                update({ pinnedProducts: { ...current.pinnedProducts, [selected]: togglePinned(current.pinnedProducts[selected] ?? [], id) } })
              }
              label={t('products')}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t('noCategories')}</p>
          )}
        </section>
      </div>
      {canEdit ? (
        <div className="flex items-center gap-2">
          <Button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {t('save')}
          </Button>
          {dirty ? (
            <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
              {t('discard')}
            </Button>
          ) : null}
          {linked ? <span className="text-xs text-muted-foreground">{t('savesLinked')}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
