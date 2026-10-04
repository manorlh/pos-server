'use client';

/**
 * What can be done to several selected products at once: move them to a category, lock
 * or unlock them at one company / shop / point of sale / till, or delete them.
 *
 * There is no bulk endpoint — each product goes through the same request its own
 * dialog makes (`PUT /products/{id}`, `PUT /products/{id}/availability/{level}/{id}`,
 * `DELETE /products/{id}`), so every permission and rule the server applies to one
 * product applies here too. A refusal is reported per product rather than stopping
 * the run. A few run at a time so a page of 100 does not open 100 connections.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { FolderInput, Lock, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { formatApiErrorDetail } from '@/lib/apiError';
import { entitySelectItems } from '@/lib/selectItems';
import type { Category, Product } from '@/lib/types';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AVAILABILITY_SUMMARY_KEY } from './product-availability-summary';

const CONCURRENCY = 4;

type Outcome =
  | { kind: 'ok' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string };

interface RunState {
  title: string;
  total: number;
  done: number;
  results: { product: Product; outcome: Outcome }[];
  finished: boolean;
}

type Action = 'category' | 'availability' | 'delete';
type AvailabilityChoice = 'active' | 'locked' | 'inherit';

const LEVEL_PATH = { company: 'companies', shop: 'shops', area: 'areas', machine: 'machines' } as const;

function errorText(err: unknown, fallback: string): string {
  if (isAxiosError(err)) {
    return formatApiErrorDetail(err.response?.data?.detail) ?? err.message ?? fallback;
  }
  return fallback;
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

export function ProductBulkActions({
  selected,
  categories,
  onClear,
  onDeleted,
}: {
  selected: Product[];
  categories: Category[];
  onClear: () => void;
  /** Ids that no longer exist, to drop from the selection. */
  onDeleted: (ids: string[]) => void;
}) {
  const t = useTranslations('productsList.bulk');
  const qc = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const [choice, setChoice] = useState<AvailabilityChoice>('locked');
  const [run, setRun] = useState<RunState | null>(null);

  const target = deepestOrgScope(scope);
  const scopeTarget = target && target.level !== 'tenant' && target.id ? target : null;

  const start = async (
    title: string,
    products: Product[],
    worker: (p: Product) => Promise<Outcome>,
  ) => {
    setAction(null);
    const state: RunState = { title, total: products.length, done: 0, results: [], finished: false };
    setRun({ ...state });
    await runPool(products, async (p) => {
      let outcome: Outcome;
      try {
        outcome = await worker(p);
      } catch (err) {
        outcome = { kind: 'failed', reason: errorText(err, t('unknownError')) };
      }
      state.done += 1;
      state.results.push({ product: p, outcome });
      setRun({ ...state, results: [...state.results] });
    });
    state.finished = true;
    setRun({ ...state, results: [...state.results] });
    qc.invalidateQueries({ queryKey: ['products'] });
    qc.invalidateQueries({ queryKey: [AVAILABILITY_SUMMARY_KEY] });
    qc.invalidateQueries({ queryKey: ['product-availability'] });
    return state.results;
  };

  const applyCategory = () => {
    const category = categories.find((c) => c.id === categoryId);
    if (!category) return;
    void start(t('runCategory', { name: category.name }), selected, async (p) => {
      if (p.categoryId === category.id) return { kind: 'skipped', reason: t('alreadyThere') };
      await api.put(`/products/${p.id}`, { categoryId: category.id });
      return { kind: 'ok' };
    });
  };

  const applyAvailability = () => {
    if (!scopeTarget) return;
    const value = choice === 'active' ? true : choice === 'locked' ? false : null;
    const path = `${LEVEL_PATH[scopeTarget.level as keyof typeof LEVEL_PATH]}/${scopeTarget.id}`;
    void start(t(`runAvailability.${choice}`), selected, async (p) => {
      if (p.catalogLevel !== 'global') return { kind: 'skipped', reason: t('notGlobal') };
      try {
        await api.put(`/products/${p.id}/availability/${path}`, { isAvailable: value });
        return { kind: 'ok' };
      } catch (err) {
        // "Not in shop assortment" / "cannot be sold in that company": nothing to set there.
        if (isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 400)) {
          return { kind: 'skipped', reason: t('notSoldThere') };
        }
        throw err;
      }
    });
  };

  const applyDelete = async () => {
    const results = await start(t('runDelete'), selected, async (p) => {
      if (p.isGeneral) return { kind: 'skipped', reason: t('generalItem') };
      await api.delete(`/products/${p.id}`);
      return { kind: 'ok' };
    });
    onDeleted(results.filter((r) => r.outcome.kind === 'ok').map((r) => r.product.id));
  };

  const counts = run
    ? {
        ok: run.results.filter((r) => r.outcome.kind === 'ok').length,
        skipped: run.results.filter((r) => r.outcome.kind === 'skipped').length,
        failed: run.results.filter((r) => r.outcome.kind === 'failed').length,
      }
    : null;
  const busy = !!run && !run.finished;

  return (
    <>
      {selected.length > 0 ? (
        <div className="sticky bottom-0 z-30 -mx-4 border-t bg-background/95 px-4 py-2 shadow-[0_-4px_12px_-6px_rgb(0_0_0/0.15)] backdrop-blur supports-backdrop-filter:bg-background/80 md:mx-0 md:rounded-lg md:border">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t('selected', { count: selected.length })}</span>
            <Button variant="ghost" size="sm" onClick={onClear} disabled={busy}>
              <X className="h-3.5 w-3.5" aria-hidden />
              {t('clear')}
            </Button>
            <div className="ms-auto flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setAction('category')}>
                <FolderInput className="h-3.5 w-3.5" aria-hidden />
                {t('changeCategory')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setAction('availability')}>
                <Lock className="h-3.5 w-3.5" aria-hidden />
                {t('setAvailability')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => setAction('delete')}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {t('delete')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Dialog open={action === 'category'} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('changeCategoryTitle', { count: selected.length })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label>{t('category')}</Label>
            <Select value={categoryId || null} onValueChange={(v) => setCategoryId(v ?? '')} items={entitySelectItems(categories)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('chooseCategory')} />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id} label={c.name}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)}>{t('cancel')}</Button>
            <Button disabled={!categoryId} onClick={applyCategory}>{t('apply')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={action === 'availability'} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('availabilityTitle', { count: selected.length })}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t('availabilityHint')}</p>
          <OrgScopeCascade value={scope} onChange={setScope} />
          <div role="radiogroup" aria-label={t('stateLabel')} className="inline-flex w-fit gap-0.5 rounded-lg border p-0.5">
            {(['active', 'locked', 'inherit'] as const).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={choice === c}
                onClick={() => setChoice(c)}
                className={
                  choice === c
                    ? c === 'locked'
                      ? 'rounded-md bg-destructive/15 px-3 py-1 text-sm font-medium text-destructive'
                      : c === 'active'
                        ? 'rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground'
                        : 'rounded-md bg-muted px-3 py-1 text-sm font-medium'
                    : 'rounded-md px-3 py-1 text-sm text-muted-foreground hover:bg-muted'
                }
              >
                {t(`state.${c}`)}
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)}>{t('cancel')}</Button>
            <Button disabled={!scopeTarget} onClick={applyAvailability}>{t('apply')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={action === 'delete'} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle', { count: selected.length })}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t('deleteHint')}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)}>{t('cancel')}</Button>
            <Button variant="destructive" onClick={() => void applyDelete()}>{t('deleteConfirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!run} onOpenChange={(o) => !o && !busy && setRun(null)}>
        <DialogContent className="max-w-lg" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>{run?.title}</DialogTitle>
          </DialogHeader>
          {run ? (
            <div className="space-y-3">
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={run.total}
                aria-valuenow={run.done}
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${run.total ? (run.done / run.total) * 100 : 100}%` }}
                />
              </div>
              <p className="text-sm">
                {run.finished ? t('finished') : t('progress', { done: run.done, total: run.total })}
              </p>
              {counts ? (
                <p className="text-sm text-muted-foreground">
                  {t('summary', { ok: counts.ok, skipped: counts.skipped, failed: counts.failed })}
                </p>
              ) : null}
              {run.results.some((r) => r.outcome.kind !== 'ok') ? (
                <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
                  {run.results
                    .filter((r) => r.outcome.kind !== 'ok')
                    .map((r) => (
                      <li key={r.product.id} className="flex gap-2">
                        <span className="font-medium">{r.product.name}</span>
                        <span className={r.outcome.kind === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                          {r.outcome.kind === 'failed' ? t('failedPrefix') : t('skippedPrefix')}
                          {'reason' in r.outcome ? r.outcome.reason : ''}
                        </span>
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button disabled={busy} onClick={() => setRun(null)}>{t('close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
