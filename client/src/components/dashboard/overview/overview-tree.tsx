'use client';

/**
 * Company › shop › point of sale (area) › till, as cards: a phone reads a column of
 * cards, never a table. A shop's areas are sub-headers with their own day's money; its
 * tills in no area follow them, directly under the shop.
 *
 * Every tap target is at least 44px tall. A till card opens the details (the page
 * decides whether that is a bottom sheet or the side panel); the few links inside it
 * (a transmission badge, a Z run) still go where they say, and do not also open it.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Building2, ChevronDown, ChevronLeft, CreditCard, Download, MapPin } from 'lucide-react';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  groupTillsByArea,
  machinesColumnAlertCount,
  type CompanyNode,
  type ShopNode,
  type TillNode,
} from '@/lib/overview';
import type { AppReleaseRolloutRow, AppUpdateStatus, OverviewArea } from '@/lib/types';
import { NumberPill } from '@/components/dashboard/number-pill';
import { MachineStatusDot } from '@/components/dashboard/machine-status';
import { MachineAlerts, MachineShiftChip } from '@/components/dashboard/machines/machine-row';

/** "קופה 4" as a pill, the way the counter names a till. Nothing without a number. */
export function RegisterPill({ n, className = '' }: { n: number | null; className?: string }) {
  const t = useTranslations('machines');
  if (n === null) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums leading-none text-primary',
        className,
      )}
    >
      {t('registerLabel', { number: n })}
    </span>
  );
}

/**
 * The till's app update as the rollout page says it: its last report, else installed
 * when it runs the target, else pending. Null when nothing was sent to it.
 */
export function rolloutState(row: AppReleaseRolloutRow | undefined): AppUpdateStatus | 'pending' | null {
  if (!row?.releaseId) return null;
  if (row.status) return row.status;
  return row.upToDate ? 'installed' : 'pending';
}

const UPDATE_STYLE: Record<AppUpdateStatus | 'pending', string> = {
  pending: 'border-muted-foreground/30 text-muted-foreground',
  downloading: 'border-sky-400/60 text-sky-800 dark:text-sky-300',
  downloaded: 'border-sky-400/60 text-sky-800 dark:text-sky-300',
  installing: 'border-amber-400/60 text-amber-800 dark:text-amber-300',
  installed: 'border-emerald-400/60 text-emerald-800 dark:text-emerald-300',
  failed: 'border-destructive/50 bg-destructive/5 text-destructive',
  declined: 'border-orange-400/60 text-orange-800 dark:text-orange-300',
};

export function UpdateChip({ row, quietWhenDone = false }: { row?: AppReleaseRolloutRow; quietWhenDone?: boolean }) {
  const t = useTranslations('appUpdates');
  const tOverview = useTranslations('dashboard.overview.till');
  const state = rolloutState(row);
  if (!state || (quietWhenDone && state === 'installed')) return null;
  const label = t(`statuses.${state}`);
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[11px] leading-none',
        UPDATE_STYLE[state],
      )}
      title={row?.statusMessage ?? undefined}
    >
      <Download className="h-3 w-3" aria-hidden />
      {tOverview('update', { status: label })}
    </span>
  );
}

/** Clicks on these do what they are, not open the till's details. */
const INTERACTIVE = 'a, button, input, select, textarea';

function TillCard({
  till,
  selected,
  onSelect,
}: {
  till: TillNode;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations('dashboard.overview.till');
  const tTerminal = useTranslations('cardTerminal');
  const m = till.live;
  const name = till.sales.name;

  const open = () => onSelect(till.sales.id);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('openDetails', { name })}
      aria-pressed={selected}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
        open();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        'flex min-h-14 cursor-pointer items-start gap-3 px-3 py-2.5 text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50',
        selected && 'bg-primary/5',
      )}
    >
      <div className="pt-1.5">
        {m ? (
          <MachineStatusDot m={m} />
        ) : (
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-neutral-300" title={t('noLive')} />
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <RegisterPill n={till.registerNumber} />
          <span className="truncate font-medium">{name}</span>
        </div>
        {m ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <MachineShiftChip m={m} />
            {machinesColumnAlertCount(m) > 0 ? <MachineAlerts m={m} /> : null}
            {m.terminalOfflineMode ? (
              <span
                className="inline-flex h-6 items-center gap-1 rounded border border-amber-400/60 bg-amber-50 px-1.5 text-[11px] leading-none text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                title={t('offlineMode')}
              >
                <CreditCard className="h-3 w-3" aria-hidden />
                {tTerminal('offlineMode')}
              </span>
            ) : null}
            <UpdateChip row={till.rollout} quietWhenDone />
          </div>
        ) : null}
      </div>

      <div className="shrink-0 text-end">
        <p className="font-semibold tabular-nums">{formatCurrency(till.sales.salesToday)}</p>
        <p className="text-[11px] text-muted-foreground">
          {m?.lastHeartbeatAt
            ? t('lastSeen', {
                ago: formatDistanceToNow(new Date(m.lastHeartbeatAt), { addSuffix: true, locale: he }),
              })
            : m
              ? t('neverSeen')
              : null}
        </p>
      </div>
    </div>
  );
}

/** A point of sale inside a shop: its name, its tills and what it took today. */
function AreaHeader({ area, tills }: { area: OverviewArea; tills: number }) {
  const t = useTranslations('dashboard.overview');
  return (
    <div className="flex min-h-11 items-center gap-2 bg-muted/30 px-3 py-1.5 text-sm">
      <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium">{area.name}</span>
        <span className="text-[11px] text-muted-foreground">
          {t('area.tills', { count: tills })} · {t('documents', { count: area.documentsToday })}
        </span>
      </div>
      <span className="shrink-0 font-semibold tabular-nums">{formatCurrency(area.salesToday)}</span>
    </div>
  );
}

function ShopSection({
  shop,
  expanded,
  onToggle,
  selectedId,
  onSelect,
}: {
  shop: ShopNode;
  expanded: boolean;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations('dashboard.overview');
  const total = shop.sales.machines.length;
  const bodyId = `overview-shop-${shop.sales.id}`;
  return (
    <section className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => onToggle(shop.sales.id)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={t('shop.toggle', { name: shop.sales.name })}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-start outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', !expanded && 'rtl:rotate-90 ltr:-rotate-90')}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <NumberPill n={shop.sales.number} />
              <span className="truncate font-semibold">{shop.sales.name}</span>
              {shop.alerts > 0 ? (
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500"
                  role="img"
                  aria-label={t('shop.alerts', { count: shop.alerts })}
                  title={t('shop.alerts', { count: shop.alerts })}
                />
              ) : null}
            </div>
            <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              <span>{t('shop.tillsOnline', { online: shop.online, total })}</span>
              {shop.openShifts > 0 ? <span>· {t('shop.openShifts', { count: shop.openShifts })}</span> : null}
              <span>· {t('documents', { count: shop.sales.documentsToday })}</span>
            </div>
          </div>
          <span className="shrink-0 font-semibold tabular-nums">{formatCurrency(shop.sales.salesToday)}</span>
        </button>
        <Link
          href={`/dashboard/shops/${shop.sales.id}`}
          aria-label={t('shop.open', { name: shop.sales.name })}
          title={t('shop.open', { name: shop.sales.name })}
          className="flex w-11 shrink-0 items-center justify-center border-s text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4 ltr:rotate-180" aria-hidden />
        </Link>
      </div>
      {expanded ? (
        <div id={bodyId} className="divide-y border-t">
          {shop.tills.length === 0 && !(shop.sales.areas?.length) ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">{t('noTills')}</p>
          ) : (
            // Nothing filtered out of this shop: its empty areas still show, as places.
            groupTillsByArea(shop, shop.tills.length === shop.sales.machines.length).map((group) => (
              <div key={group.area?.id ?? 'none'} className="divide-y">
                {group.area ? (
                  <AreaHeader area={group.area} tills={group.tills.length} />
                ) : (shop.sales.areas?.length ?? 0) > 0 ? (
                  <div className="bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                    {t('area.none')}
                  </div>
                ) : null}
                {group.area && group.tills.length === 0 ? (
                  <p className="px-3 py-2 ps-8 text-xs text-muted-foreground">{t('area.noTills')}</p>
                ) : null}
                {group.tills.map((till) => (
                  <TillCard
                    key={till.sales.id}
                    till={till}
                    selected={selectedId === till.sales.id}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

export function OverviewTree({
  companies,
  isExpanded,
  onToggleShop,
  selectedId,
  onSelect,
}: {
  companies: CompanyNode[];
  isExpanded: (shopId: string) => boolean;
  onToggleShop: (shopId: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations('dashboard.overview');
  return (
    <div className="space-y-5">
      {companies.map((company) => (
        <div key={company.sales.id} className="space-y-2">
          <div className="flex min-h-11 items-center gap-2 px-1">
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <NumberPill n={company.sales.number} />
            <Link
              href={`/dashboard/companies/${company.sales.id}`}
              className="min-w-0 truncate py-2.5 font-semibold hover:underline"
              title={t('company.open', { name: company.sales.name })}
            >
              {company.sales.name}
            </Link>
            <span className="ms-auto shrink-0 text-end text-sm font-semibold tabular-nums text-muted-foreground">
              {formatCurrency(company.sales.salesToday)}
              <span className="block text-[11px] font-normal">
                {t('documents', { count: company.sales.documentsToday })}
              </span>
            </span>
          </div>
          <div className="space-y-2">
            {company.shops.map((shop) => (
              <ShopSection
                key={shop.sales.id}
                shop={shop}
                expanded={isExpanded(shop.sales.id)}
                onToggle={onToggleShop}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
