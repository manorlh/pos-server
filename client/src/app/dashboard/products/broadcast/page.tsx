'use client';

/**
 * "שדר לקופות" — the review before a menu broadcast (docs/SPEC_MENU_BROADCAST_REVIEW.md).
 *
 * In a shop in review mode (tables on, or the override «תמיד») the catalog pages edit a
 * draft; the tills keep the last broadcast version. Here the draft is compared with that
 * version, section by section — products added / removed, prices, categories, modifiers,
 * availability, hours, the menu (courses, upsells) — with the tills it would reach, and
 * "אישור ושידור" makes it the next version and wakes the tills. "גרסאות שידור" lists the
 * versions.
 *
 * Scope: a shop — its review; a company — every shop of it in review mode, each with its
 * own approve and one for all; the organization — the shops in review mode, to pick one.
 * Server: pos-server app/routers/menu_broadcast.py.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, History, Monitor, RadioTower, Send } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { useAuth } from '@/lib/auth';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  BROADCAST_KEYS,
  BROADCAST_SECTIONS,
  broadcastCompany,
  broadcastErrorCode,
  broadcastShop,
  fetchBroadcastHistory,
  fetchBroadcastStatus,
  fetchCompanyPreview,
  fetchShopPreview,
  type BroadcastChange,
  type BroadcastItem,
  type BroadcastSection,
  type Publication,
  type ReviewState,
  type ShopPreview,
} from '@/lib/menuBroadcastApi';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { UserRole } from '@/lib/types';

/** Who may approve: the catalog's writers (pos-server permission_matrix CATALOG/WRITE). */
const BROADCAST_ROLES: UserRole[] = ['super_admin', 'distributor', 'company_manager', 'merchant_admin', 'shop_manager'];

/** Fields whose values are money. */
const MONEY_FIELDS = new Set(['price', 'option.price', 'option', 'optionAdded', 'optionRemoved']);
/** `detail` values that name a kind of change rather than a category. */
const DETAIL_KINDS = new Set([
  'group',
  'links_category',
  'links_product',
  'notes_all',
  'notes_category',
  'notes_product',
  'meal',
  'upsell',
  'course',
  // "תפריטים" (catalog_menus.diff): a menu, a target's menus, a target's fallback.
  'catalog_menu',
  'catalog_menu_assignment',
  'catalog_menu_fallback',
]);
/** Fields whose value is a code with a label under `values.<field>_<code>`. */
const CODED_FIELDS = new Set(['channel', 'fallback']);

function useCanBroadcast(): boolean {
  const role = useAuth((s) => s.user?.role);
  return !!role && BROADCAST_ROLES.includes(role);
}

export default function MenuBroadcastPage() {
  const t = useTranslations('menuBroadcast');
  const { effective } = usePageScope({ maxLevel: 'shop' });
  const shopId = effective.shopId ?? null;
  const companyId = effective.companyId ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <RadioTower className="h-5 w-5 text-muted-foreground" aria-hidden />
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {shopId ? (
        <ShopReviewLoader shopId={shopId} />
      ) : companyId ? (
        <CompanyReview companyId={companyId} />
      ) : (
        <OrganizationOverview />
      )}
    </div>
  );
}

// ── The organization: pick a shop ────────────────────────────────────────────

function OrganizationOverview() {
  const t = useTranslations('menuBroadcast');
  const query = useQuery({
    queryKey: BROADCAST_KEYS.status(null, null),
    queryFn: () => fetchBroadcastStatus({}),
  });
  if (query.isLoading) return <Skeleton className="h-32 w-full" />;
  const shops = query.data?.shops ?? [];
  if (shops.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">{t('noReviewShops')}</CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{t('pickShop')}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y p-0">
        {shops.map((s) => (
          <div key={s.shopId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div>
              <p className="font-medium">{s.shopName}</p>
              <p className="text-xs text-muted-foreground">
                {t('versionLine', { version: s.version, at: formatDateTime(s.publishedAt) })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {s.hasChanges ? (
                <Badge variant="secondary">{t('pendingCount', { count: s.pending })}</Badge>
              ) : (
                <Badge variant="outline">{t('upToDate')}</Badge>
              )}
              <Link
                href={`/dashboard/products/broadcast?shop=${s.shopId}`}
                className={buttonVariants({ size: 'sm', variant: s.hasChanges ? 'default' : 'outline' })}
              >
                {t('openReview')}
              </Link>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── One shop ─────────────────────────────────────────────────────────────────

function ShopReviewLoader({ shopId }: { shopId: string }) {
  const tc = useTranslations('common');
  const query = useQuery({ queryKey: BROADCAST_KEYS.shop(shopId), queryFn: () => fetchShopPreview(shopId) });
  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (query.isError || !query.data) {
    return <p className="text-sm text-destructive">{axiosErrorToToastMessage(query.error, tc('error'))}</p>;
  }
  return (
    <div className="space-y-4">
      <ShopReview preview={query.data} />
      {query.data.review.enabled || query.data.publication ? <BroadcastHistory shopId={shopId} /> : null}
    </div>
  );
}

function useInvalidateBroadcast() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['menu-broadcast-status'] });
    void qc.invalidateQueries({ queryKey: ['menu-broadcast-preview'] });
    void qc.invalidateQueries({ queryKey: ['menu-broadcast-company'] });
    void qc.invalidateQueries({ queryKey: ['menu-broadcast-history'] });
    void qc.invalidateQueries({ queryKey: ['shop-work-types'] });
  };
}

function ShopReview({ preview, compact = false }: { preview: ShopPreview; compact?: boolean }) {
  const t = useTranslations('menuBroadcast');
  const tc = useTranslations('common');
  const canBroadcast = useCanBroadcast();
  const invalidate = useInvalidateBroadcast();
  const [note, setNote] = useState('');

  const approve = useMutation({
    mutationFn: () => broadcastShop(preview.shopId, { fingerprint: preview.fingerprint, note: note.trim() || null }),
    onSuccess: (out) => {
      toast.success(t('done', { version: out.publication.version, tills: out.targets.length }));
      setNote('');
      invalidate();
    },
    onError: (err: unknown) => {
      const code = broadcastErrorCode(err);
      if (code === 'menu_changed_since_preview') toast.error(t('errors.changed'));
      else if (code === 'menu_nothing_to_broadcast') toast.error(t('errors.nothing'));
      else if (code === 'menu_review_off') toast.error(t('errors.off'));
      else toast.error(axiosErrorToToastMessage(err, tc('error')));
      invalidate();
    },
  });

  return (
    <Card>
      <CardHeader className="space-y-2 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">{preview.shopName}</CardTitle>
          {preview.review.enabled ? (
            preview.hasChanges ? (
              <Badge variant="secondary">{t('pendingCount', { count: preview.total })}</Badge>
            ) : (
              <Badge variant="outline">{t('upToDate')}</Badge>
            )
          ) : null}
        </div>
        <ReviewLine review={preview.review} />
        {preview.publication ? (
          <p className="text-xs text-muted-foreground">
            {t('tillsHave', {
              version: preview.publication.version,
              at: formatDateTime(preview.publication.publishedAt),
              by: preview.publication.publishedByName ?? t('automatic'),
            })}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!preview.review.enabled ? (
          <p className="text-sm text-muted-foreground">{t('offExplain')}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {BROADCAST_SECTIONS.map((s) => (
                <Badge key={s} variant={preview.counts[s] ? 'secondary' : 'outline'}>
                  {t(`sections.${s}`)} · {preview.counts[s] ?? 0}
                </Badge>
              ))}
            </div>
            {preview.total === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
                {preview.hasChanges ? t('invisibleChanges') : t('nothingPending')}
              </p>
            ) : (
              <div className="space-y-4">
                {BROADCAST_SECTIONS.filter((s) => (preview.sections[s] ?? []).length > 0).map((s) => (
                  <ReviewSection key={s} section={s} items={preview.sections[s]} />
                ))}
              </div>
            )}
            {!compact ? <HoursNote /> : null}
            <Targets preview={preview} />
            {canBroadcast ? (
              <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center">
                <Input
                  value={note}
                  maxLength={500}
                  placeholder={t('notePlaceholder')}
                  onChange={(e) => setNote(e.target.value)}
                  className="sm:flex-1"
                />
                <Button onClick={() => approve.mutate()} disabled={!preview.hasChanges || approve.isPending}>
                  <Send className="h-3.5 w-3.5" aria-hidden />
                  {approve.isPending ? t('broadcasting') : t('approve')}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-400">{t('readOnly')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ReviewLine({ review }: { review: ReviewState }) {
  const t = useTranslations('menuBroadcast.reason');
  const tills = review.tablesTills.map((x) => x.name).join(', ');
  return (
    <p className="text-sm text-muted-foreground">
      {t('label')}:{' '}
      <span className={cn('font-semibold', review.enabled ? 'text-emerald-700 dark:text-emerald-400' : '')}>
        {review.enabled ? t('on') : t('off')}
      </span>
      {' — '}
      {t(review.reason, { tills: tills || '—' })}
    </p>
  );
}

function HoursNote() {
  const t = useTranslations('menuBroadcast');
  return <p className="text-xs text-muted-foreground">{t('hoursNote')}</p>;
}

function ReviewSection({ section, items }: { section: BroadcastSection; items: BroadcastItem[] }) {
  const t = useTranslations('menuBroadcast');
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-semibold">
        {t(`sections.${section}`)} <span className="text-muted-foreground">({items.length})</span>
      </h3>
      <ul className="divide-y rounded-md border">
        {items.map((item) => (
          <li key={`${item.type}-${item.id}-${item.detail ?? ''}`} className="space-y-1 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={item.type === 'removed' ? 'destructive' : item.type === 'added' ? 'default' : 'secondary'}
              >
                {t(`types.${item.type}`)}
              </Badge>
              <span className="text-sm font-medium">{item.name ?? t(`kinds.${item.detail ?? 'group'}`)}</span>
              {item.detail && item.name ? (
                <span className="text-xs text-muted-foreground">
                  {DETAIL_KINDS.has(item.detail) ? t(`kinds.${item.detail}`) : item.detail}
                </span>
              ) : null}
            </div>
            {item.changes.length > 0 ? (
              <ul className="space-y-0.5 ps-1 text-xs">
                {item.changes.map((c, i) => (
                  <ChangeLine key={i} change={c} itemType={item.type} detail={item.detail} />
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChangeLine({
  change,
  itemType,
  detail,
}: {
  change: BroadcastChange;
  itemType: BroadcastItem['type'];
  detail?: string;
}) {
  const t = useTranslations('menuBroadcast');
  const tw = useTranslations('promotions.weekdays');
  const fieldKey = change.field.replace(/\./g, '_');
  const label = t.has(`fields.${fieldKey}`) ? t(`fields.${fieldKey}`) : change.field;
  // "תפריטים": a menu's price null is the catalog's; an assignment's label is its level.
  const catalogMenu = !!detail?.startsWith('catalog_menu');
  const changeLabel =
    catalogMenu && change.label && t.has(`values.level_${change.label}`) ? t(`values.level_${change.label}`) : change.label;

  const show = (value: unknown): string => {
    if (value === null || value === undefined) {
      if (catalogMenu && change.field === 'price') return t('values.catalogPrice');
      return change.field === 'groups' || change.field === 'notes' || change.field === 'fallback' ? t('values.inherit') : '—';
    }
    if (typeof value === 'string' && CODED_FIELDS.has(change.field) && t.has(`values.${change.field}_${value}`)) {
      return t(`values.${change.field}_${value}`);
    }
    if (typeof value === 'boolean') return value ? t('values.yes') : t('values.no');
    if (typeof value === 'number' && MONEY_FIELDS.has(change.field)) return formatCurrency(value);
    if (Array.isArray(value)) {
      if (value.length === 0) return t('values.none');
      if (change.field === 'weekdays') return value.map((d) => tw(String(d))).join(' ');
      return value.map((v) => (v === null || v === undefined ? '—' : String(v))).join(', ');
    }
    return String(value);
  };

  if (itemType === 'added' && change.before === null && change.field === 'price') {
    return <li className="text-muted-foreground">{t('addedAt', { price: show(change.after) })}</li>;
  }
  return (
    <li className="text-muted-foreground">
      <span className="text-foreground">{label}</span>
      {changeLabel ? <span> · {changeLabel}</span> : null}
      {': '}
      {change.field === 'optionAdded' ? (
        <span>{show(change.after)}</span>
      ) : change.field === 'optionRemoved' ? (
        <span className="line-through">{show(change.before)}</span>
      ) : (
        <>
          <span className="line-through decoration-muted-foreground/60">{show(change.before)}</span>
          {' ← '}
          <span className="font-medium text-foreground">{show(change.after)}</span>
        </>
      )}
    </li>
  );
}

function Targets({ preview }: { preview: ShopPreview }) {
  const t = useTranslations('menuBroadcast');
  return (
    <div className="space-y-1.5">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Monitor className="h-4 w-4 text-muted-foreground" aria-hidden />
        {t('targets', { count: preview.targets.length, shop: preview.shopName })}
      </h3>
      {preview.targets.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('noTargets')}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {preview.targets.map((m) => (
            <li key={m.machineId} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
              <span
                className={cn('h-2 w-2 rounded-full', m.online ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
                aria-label={m.online ? t('online') : t('offline')}
              />
              <span className="font-medium">{m.posNumber ? t('till', { n: m.posNumber, name: m.name }) : m.name}</span>
              {m.areaName ? <span className="text-muted-foreground">· {m.areaName}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── "גרסאות שידור" ────────────────────────────────────────────────────────────

function BroadcastHistory({ shopId }: { shopId: string }) {
  const t = useTranslations('menuBroadcast');
  const query = useQuery({ queryKey: BROADCAST_KEYS.history(shopId), queryFn: () => fetchBroadcastHistory(shopId) });
  const versions = query.data?.versions ?? [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <History className="h-4 w-4" aria-hidden />
          {t('history.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {query.isLoading ? (
          <Skeleton className="m-4 h-16" />
        ) : versions.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">{t('history.empty')}</p>
        ) : (
          <ul className="divide-y">
            {versions.map((v) => (
              <VersionRow key={v.id} version={v} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function VersionRow({ version }: { version: Publication }) {
  const t = useTranslations('menuBroadcast');
  const summary = version.summary ?? {};
  const counts = summary.counts ?? {};
  const parts = BROADCAST_SECTIONS.filter((s) => (counts[s] ?? 0) > 0).map(
    (s) => `${t(`sections.${s}`)} ${counts[s]}`,
  );
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 text-sm">
      <div className="space-y-0.5">
        <p className="font-medium">
          {t('history.version', { version: version.version })}
          <span className="ms-2 text-xs font-normal text-muted-foreground">
            {version.kind === 'initial' ? t('history.initial') : t('history.broadcast')}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {summary.initial
            ? t('history.initialSummary', {
                products: summary.totals?.products ?? 0,
                categories: summary.totals?.categories ?? 0,
              })
            : parts.length > 0
              ? parts.join(' · ')
              : t('history.noVisible')}
        </p>
        {version.note ? <p className="text-xs italic text-muted-foreground">“{version.note}”</p> : null}
        {version.closedAt ? (
          <p className="text-xs text-muted-foreground">{t('history.closed', { at: formatDateTime(version.closedAt) })}</p>
        ) : null}
      </div>
      <div className="text-end text-xs text-muted-foreground">
        <p>{formatDateTime(version.publishedAt)}</p>
        <p>{version.publishedByName ?? t('automatic')}</p>
      </div>
    </li>
  );
}

// ── A company: every shop of it in review mode ───────────────────────────────

function CompanyReview({ companyId }: { companyId: string }) {
  const t = useTranslations('menuBroadcast');
  const tc = useTranslations('common');
  const canBroadcast = useCanBroadcast();
  const invalidate = useInvalidateBroadcast();
  const query = useQuery({
    queryKey: BROADCAST_KEYS.company(companyId),
    queryFn: () => fetchCompanyPreview(companyId),
  });
  const shops = query.data?.shops ?? [];
  const changed = shops.filter((s) => s.hasChanges);

  const approveAll = useMutation({
    mutationFn: () =>
      broadcastCompany(companyId, {
        shops: changed.map((s) => ({ shopId: s.shopId, fingerprint: s.fingerprint })),
      }),
    onSuccess: (out) => {
      const ok = out.results.filter((r) => r.ok).length;
      const failed = out.results.filter((r) => !r.ok);
      if (ok > 0) toast.success(t('doneMany', { count: ok }));
      if (failed.length > 0) {
        toast.error(t('someFailed', { shops: failed.map((r) => r.shopName ?? r.shopId).join(', ') }));
      }
      invalidate();
    },
    onError: (err: unknown) => {
      toast.error(axiosErrorToToastMessage(err, tc('error')));
      invalidate();
    },
  });

  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (query.isError) return <p className="text-sm text-destructive">{axiosErrorToToastMessage(query.error, tc('error'))}</p>;
  if (shops.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">{t('noReviewShops')}</CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {canBroadcast && changed.length > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-4 py-3">
          <p className="text-sm">{t('companyPending', { shops: changed.length, count: query.data?.total ?? 0 })}</p>
          <Button onClick={() => approveAll.mutate()} disabled={approveAll.isPending}>
            <Send className="h-3.5 w-3.5" aria-hidden />
            {approveAll.isPending ? t('broadcasting') : t('approveAll', { count: changed.length })}
          </Button>
        </div>
      ) : null}
      {shops.map((p) => (
        <ShopReview key={p.shopId} preview={p} compact />
      ))}
      <HoursNote />
    </div>
  );
}
