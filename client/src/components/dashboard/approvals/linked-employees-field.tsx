'use client';

/**
 * "עובד מקושר" (P:\specs\manager-approval-mobile.md §4): the till employees a dashboard user is —
 * one or more. The link decides the till role, the ceilings and the shift state (by the time
 * clock) when that user approves a request from the phone; without one they approve by their
 * dashboard role and the shift rule does not apply.
 *
 * Controlled by the users dialog: `value` null = untouched (the saved list is shown), otherwise the
 * list as chosen; the dialog saves it with the user (`PUT /users/{id}/linked-employees`).
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, X } from 'lucide-react';
import { apiErrorOf, employeeHint, toggleEmployee, type LinkedEmployee } from '@/lib/approvals';
import { fetchLinkCandidates, fetchLinkedEmployees } from '@/lib/approvalsApi';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LinkedEmployeesField({
  userId,
  shopId,
  value,
  onChange,
}: {
  /** null for a user not created yet (nothing saved to show). */
  userId: string | null;
  /** Narrows the candidates to the user's shop, when they have one. */
  shopId?: string | null;
  value: LinkedEmployee[] | null;
  onChange: (next: LinkedEmployee[]) => void;
}) {
  const t = useTranslations('approvals.linked');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const saved = useQuery({
    queryKey: ['approvals', 'linked-employees', userId],
    queryFn: () => fetchLinkedEmployees(userId as string),
    enabled: !!userId,
    retry: false,
  });
  const candidates = useQuery({
    queryKey: ['approvals', 'link-candidates', query, shopId ?? null],
    queryFn: () => fetchLinkCandidates(query, shopId),
    retry: false,
    staleTime: 30_000,
  });

  // A server without the link (404) — the field is not offered at all.
  if (apiErrorOf(saved.error).status === 404 || apiErrorOf(candidates.error).status === 404) return null;

  const chosen = value ?? saved.data ?? [];
  const chosenIds = new Set(chosen.map((e) => e.posUserId));

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div>
        <Label htmlFor="linked-employees-search">{t('label')}</Label>
        <p className="text-muted-foreground text-xs">{t('hint')}</p>
      </div>
      {saved.isLoading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : saved.isError ? (
        <p className="text-destructive text-xs">{t('loadFailed')}</p>
      ) : chosen.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('none')}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {chosen.map((e) => (
            <li key={e.posUserId} className="bg-secondary inline-flex items-center gap-1 rounded-full py-0.5 ps-2.5 pe-1 text-xs">
              <span className="font-medium">{e.name}</span>
              {e.shopName ? <span className="text-muted-foreground">· {e.shopName}</span> : null}
              <button
                type="button"
                className="hover:bg-muted rounded-full p-0.5"
                aria-label={t('remove', { name: e.name })}
                onClick={() => onChange(toggleEmployee(chosen, e))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" aria-hidden />
        <Input
          id="linked-employees-search"
          type="search"
          className="ps-8"
          value={search}
          placeholder={t('search')}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="max-h-48 overflow-y-auto rounded-md border" role="group" aria-label={t('label')}>
        {candidates.isLoading ? (
          <Loader2 className="m-2 size-4 animate-spin" aria-hidden />
        ) : (candidates.data ?? []).length === 0 ? (
          <p className="text-muted-foreground p-2 text-xs">{t('noResults')}</p>
        ) : (
          (candidates.data ?? []).map((c) => {
            const elsewhere = !!c.linkedUserId && c.linkedUserId !== userId;
            return (
              <label key={c.posUserId} className="hover:bg-muted/50 flex min-h-10 cursor-pointer items-start gap-2 px-2 py-1.5 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary mt-0.5 size-4"
                  checked={chosenIds.has(c.posUserId)}
                  onChange={() => onChange(toggleEmployee(chosen, c))}
                />
                <span className="min-w-0">
                  <span className="block font-medium">{c.name}</span>
                  <span className="text-muted-foreground block text-xs">
                    {[employeeHint(c), elsewhere ? t('linkedElsewhere') : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
