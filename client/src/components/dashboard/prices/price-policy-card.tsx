'use client';

/**
 * "מדיניות מחירים של הרשת" (P:/specs/chain-areas.md §9.2): who may change prices below the chain, a shop's own
 * exception, the allowed ±% from the chain's price, and the categories whose price only the chain sets
 * (`GET|PUT /companies/{id}/price-policy`). Only the chain saves it; anyone else sees it read-only with the reason.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { parseAmount } from '@/lib/bulkPrice';
import { useAuth } from '@/lib/auth';
import type { Category, Shop } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { AreaChips } from './area-chips';
import type { Editors, PricePolicyResponse } from './types';

const NATIVE_SELECT =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

const CHAIN_ONLY = 'רק הרשת (מנהל החברה) קובעת את מדיניות המחירים';

interface Draft {
  editors: Editors;
  shopEditors: Record<string, Editors>;
  lockedCategoryIds: string[];
  maxDeltaPct: string;
}

function draftOf(data: PricePolicyResponse): Draft {
  const own = data.own;
  return {
    editors: own?.editors ?? 'area',
    shopEditors: { ...(own?.shopEditors ?? {}) },
    lockedCategoryIds: [...(own?.lockedCategoryIds ?? [])],
    maxDeltaPct: own?.maxDeltaPct === null || own?.maxDeltaPct === undefined ? '' : String(own.maxDeltaPct),
  };
}

export function PricePolicyCard({ companyId, companyName, shops }: { companyId: string; companyName?: string; shops: Shop[] }) {
  const query = useQuery<PricePolicyResponse>({
    queryKey: ['price-policy', companyId],
    queryFn: () => api.get(`/companies/${companyId}/price-policy`).then((r) => r.data),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          מדיניות מחירים של הרשת
          {companyName ? <span className="text-sm font-normal text-muted-foreground">· {companyName}</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError || !query.data ? (
          <p className="text-sm text-destructive">{axiosErrorToToastMessage(query.error, 'הטעינה נכשלה')}</p>
        ) : (
          <PolicyForm key={query.data.own?.updatedAt ?? 'none'} companyId={companyId} data={query.data} shops={shops} />
        )}
      </CardContent>
    </Card>
  );
}

function PolicyForm({ companyId, data, shops }: { companyId: string; data: PricePolicyResponse; shops: Shop[] }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  // Whether the user is the chain is the server's call (403 `price_policy_chain_only`); this only avoids
  // offering a form to whoever is plainly below it.
  const looksChain =
    user?.role === 'super_admin' || user?.role === 'distributor' || (user?.role === 'company_manager' && !user.shopId);
  const [refusal, setRefusal] = useState<string | null>(looksChain ? null : CHAIN_ONLY);
  const readOnly = !!refusal;
  const [draft, setDraft] = useState<Draft>(() => draftOf(data));
  const categories = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data),
  });
  const companyShops = shops.filter((s) => s.companyId === companyId);
  const options = data.editorsOptions;

  const save = useMutation({
    mutationFn: () =>
      api.put(`/companies/${companyId}/price-policy`, {
        editors: draft.editors,
        shopEditors: draft.shopEditors,
        lockedProductIds: data.own?.lockedProductIds ?? [],
        lockedCategoryIds: draft.lockedCategoryIds,
        maxDeltaPct: parseAmount(draft.maxDeltaPct),
      }),
    onSuccess: () => {
      toast.success('מדיניות המחירים נשמרה');
      qc.invalidateQueries({ queryKey: ['price-policy', companyId] });
      qc.invalidateQueries({ queryKey: ['product-prices'] });
    },
    onError: (err) => {
      if (isAxiosError(err) && err.response?.status === 403) setRefusal(CHAIN_ONLY);
      toast.error(
        isAxiosError(err) && err.response?.data?.detail === 'price_policy_chain_only'
          ? CHAIN_ONLY
          : axiosErrorToToastMessage(err, 'השמירה נכשלה'),
      );
    },
  });

  const pct = parseAmount(draft.maxDeltaPct);
  const pctBad = draft.maxDeltaPct.trim() !== '' && (pct === null || pct < 0 || pct > 100);
  const effective = data.effective;

  return (
    <div className="space-y-4">
      {refusal ? <p className="rounded-md border bg-muted/40 p-2 text-sm text-muted-foreground">{refusal}</p> : null}
      <div className="space-y-1">
        <Label htmlFor="price-policy-editors">מי רשאי לשנות מחירים</Label>
        <select
          id="price-policy-editors"
          className={NATIVE_SELECT}
          disabled={readOnly}
          value={draft.editors}
          onChange={(e) => setDraft((d) => ({ ...d, editors: e.target.value as Editors }))}
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        {effective.editors !== draft.editors && data.own ? (
          <p className="text-xs text-muted-foreground">בפועל (כולל חברת האם): {effective.editorsLabel ?? effective.editors}</p>
        ) : null}
      </div>

      {companyShops.length ? (
        <div className="space-y-1.5">
          <Label>חריגה לסניף</Label>
          <div className="space-y-1.5">
            {companyShops.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-32 text-sm">{s.name}</span>
                <select
                  aria-label={`חריגה לסניף ${s.name}`}
                  className={`${NATIVE_SELECT} w-auto min-w-56`}
                  disabled={readOnly}
                  value={draft.shopEditors[s.id] ?? ''}
                  onChange={(e) =>
                    setDraft((d) => {
                      const next = { ...d.shopEditors };
                      if (e.target.value) next[s.id] = e.target.value as Editors;
                      else delete next[s.id];
                      return { ...d, shopEditors: next };
                    })
                  }
                >
                  <option value="">כמו הרשת</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="price-policy-pct">טווח מותר ±% ממחיר הרשת</Label>
        <Input
          id="price-policy-pct"
          className="w-32"
          dir="ltr"
          inputMode="decimal"
          placeholder="ללא"
          disabled={readOnly}
          value={draft.maxDeltaPct}
          onChange={(e) => setDraft((d) => ({ ...d, maxDeltaPct: e.target.value }))}
        />
        {pctBad ? <p className="text-xs text-destructive">אחוז בין 0 ל-100</p> : null}
        <p className="text-xs text-muted-foreground">ריק — ללא הגבלה. מחיר סניף או נקודה מחוץ לטווח יסורב.</p>
      </div>

      <div className="space-y-1">
        <Label>קטגוריות שמחירן נעול ע״י הרשת</Label>
        <AreaChips
          label="קטגוריות נעולות"
          areas={(categories.data ?? []).map((c) => ({ id: c.id, name: c.name }))}
          value={draft.lockedCategoryIds}
          onChange={(lockedCategoryIds) => setDraft((d) => ({ ...d, lockedCategoryIds }))}
          disabled={readOnly}
        />
        {data.own?.lockedProductIds?.length ? (
          <p className="text-xs text-muted-foreground">
            ועוד {data.own.lockedProductIds.length} מוצרים נעולים (נקבע בעורך המוצר — &quot;מחיר נעול ע״י הרשת&quot;).
          </p>
        ) : null}
      </div>

      {!readOnly ? (
        <div className="flex justify-end">
          <Button disabled={save.isPending || pctBad} onClick={() => save.mutate()}>
            {save.isPending ? 'שומר…' : 'שמור מדיניות'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
