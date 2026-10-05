'use client';

/**
 * Company › shop › point of sale (area) › till, the control board's tills section.
 *
 * Each shop is a card: its name and day ("קופות בסניף — רמת גן", "מציג 4 מתוך 8"), then
 * its tills — a table from `md` (קופה | שם | סטטוס | מכירות | עסקאות | סנכרון אחרון),
 * a list of rows on a phone ("01 · בר ראשי [מחובר] ›"). A shop's areas are sub-headers
 * with their own day's money; its tills in no area follow them.
 *
 * A till row opens the details (the page decides: a side drawer or a bottom sheet); the
 * few links inside it (a transmission badge, a Z run) still go where they say. Company
 * and shop names link to their pages. Every tap target is at least 44px tall.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatDistanceToNowStrict } from 'date-fns';
import { he } from 'date-fns/locale';
import { Building2, ChevronDown, ChevronLeft, CreditCard, Download, MapPin, Store } from 'lucide-react';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  groupTillsByArea,
  machinesColumnAlertCount,
  type CompanyNode,
  type ShopNode,
  type TillNode,
} from '@/lib/overview';
import { machineStatus } from '@/components/dashboard/machine-status';
import type { AppReleaseRolloutRow, AppUpdateStatus, OverviewArea } from '@/lib/types';
import { NumberPill } from '@/components/dashboard/number-pill';
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

/** The table's columns from `md`; a phone row is register | name | status | chevron. */
const ROW_GRID =
  'grid grid-cols-[2.25rem_minmax(0,1fr)_auto_1rem] md:grid-cols-[3.5rem_minmax(0,1.6fr)_8.5rem_minmax(5.5rem,0.8fr)_4.5rem_minmax(6.5rem,0.8fr)_1rem]';

function ago(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : formatDistanceToNowStrict(d, { addSuffix: true, locale: he });
}

/** "מחובר" / "לא מחובר": green when up; orange when down with its shift open; red with unsent sales. */
function StatusPill({ till }: { till: TillNode }) {
  const t = useTranslations('controlBoard.tills');
  const tStatus = useTranslations('machineStatus');
  const m = till.live;
  if (!m) {
    return (
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-cb-soft px-2.5 text-xs font-medium text-cb-muted">
        <span aria-hidden className="size-1.5 rounded-full bg-cb-muted/60" />
        {t('noData')}
      </span>
    );
  }
  const status = machineStatus(m);
  const tone = till.online
    ? 'bg-cb-green/12 text-cb-green-ink'
    : status === 'offline_with_unsynced'
      ? 'bg-cb-red/12 text-cb-red-ink'
      : status === 'offline'
        ? 'bg-cb-amber/15 text-cb-amber-ink'
        : 'bg-cb-soft text-cb-muted';
  const dot = till.online
    ? 'bg-cb-green'
    : status === 'offline_with_unsynced'
      ? 'bg-cb-red'
      : status === 'offline'
        ? 'bg-cb-amber'
        : 'bg-cb-muted/60';
  return (
    <span
      className={cn('inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold', tone)}
      title={tStatus(`status.${status}`)}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />
      {till.online ? t('connected') : t('disconnected')}
    </span>
  );
}

function TillChips({ till }: { till: TillNode }) {
  const t = useTranslations('dashboard.overview.till');
  const tTerminal = useTranslations('cardTerminal');
  const m = till.live;
  if (!m) return null;
  const hasAlerts = machinesColumnAlertCount(m) > 0;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <MachineShiftChip m={m} />
      {hasAlerts ? <MachineAlerts m={m} /> : null}
      {m.terminalOfflineMode ? (
        <span
          className="inline-flex h-6 items-center gap-1 rounded border border-cb-amber/50 bg-cb-amber/10 px-1.5 text-[11px] leading-none text-cb-amber-ink"
          title={t('offlineMode')}
        >
          <CreditCard className="h-3 w-3" aria-hidden />
          {tTerminal('offlineMode')}
        </span>
      ) : null}
      <UpdateChip row={till.rollout} quietWhenDone />
    </div>
  );
}

function TillRow({
  till,
  selected,
  onSelect,
}: {
  till: TillNode;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations('dashboard.overview.till');
  const tB = useTranslations('controlBoard.tills');
  const m = till.live;
  const name = till.sales.name;
  const reg = till.registerNumber !== null ? String(till.registerNumber).padStart(2, '0') : '—';
  const synced = ago(m?.lastSyncAt);
  const seen = ago(m?.lastHeartbeatAt);

  const open = () => onSelect(till.sales.id);
  return (
    <li>
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
          ROW_GRID,
          'min-h-14 cursor-pointer items-center gap-x-3 px-4 py-3 text-sm outline-none transition-colors hover:bg-cb-soft/70 focus-visible:bg-cb-soft focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cb-blue/40 md:px-5',
          selected && 'bg-cb-blue/6',
        )}
      >
        <span className="text-[15px] font-semibold tabular-nums text-cb-ink" title={till.registerNumber !== null ? `${tB('register')} ${till.registerNumber}` : undefined}>
          {reg}
        </span>

        <div className="min-w-0 space-y-1">
          <p className="truncate font-medium text-cb-ink">{name}</p>
          {/* A phone has no columns for these: one quiet line under the name. */}
          <p className="truncate text-xs text-cb-muted md:hidden">
            <span className="font-semibold tabular-nums text-cb-ink">{formatCurrency(till.sales.salesToday)}</span>
            {' · '}
            {tB('txCount', { count: till.sales.salesCount })}
            {synced ? ` · ${tB('syncAgo', { ago: synced })}` : ''}
          </p>
          <TillChips till={till} />
        </div>

        <div className="flex flex-col items-end gap-0.5 md:items-start">
          <StatusPill till={till} />
          {!till.online && m ? (
            <span className="hidden text-[11px] text-cb-muted md:block">
              {seen ? tB('lastSeen', { ago: seen }) : t('neverSeen')}
            </span>
          ) : null}
        </div>

        <span className="hidden font-semibold tabular-nums text-cb-ink md:block">{formatCurrency(till.sales.salesToday)}</span>
        <span className="hidden tabular-nums text-cb-ink md:block">{formatQuantity(till.sales.salesCount)}</span>
        <span className="hidden text-xs text-cb-muted md:block" title={seen ? t('lastSeen', { ago: seen }) : undefined}>
          {synced ?? '—'}
        </span>

        <ChevronLeft className="size-4 text-cb-muted ltr:rotate-180" aria-hidden />
      </div>
    </li>
  );
}

/** The table's column titles, from `md`. */
function HeaderRow() {
  const t = useTranslations('controlBoard.tills');
  return (
    <div
      aria-hidden
      className={cn(
        ROW_GRID,
        'hidden gap-x-3 border-b border-cb-line bg-cb-soft/60 px-5 py-2 text-xs font-medium text-cb-muted md:grid',
      )}
    >
      <span>{t('register')}</span>
      <span>{t('name')}</span>
      <span>{t('status')}</span>
      <span>{t('sales')}</span>
      <span>{t('transactions')}</span>
      <span>{t('lastSync')}</span>
      <span />
    </div>
  );
}

/** A point of sale inside a shop: its name, its tills and what it took. */
function AreaHeader({ area, tills }: { area: OverviewArea; tills: number }) {
  const t = useTranslations('dashboard.overview');
  return (
    <div className="flex min-h-11 items-center gap-2 bg-cb-soft/60 px-4 py-1.5 text-sm md:px-5">
      <MapPin className="h-3.5 w-3.5 shrink-0 text-cb-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium text-cb-ink">{area.name}</span>
        <span className="text-[11px] text-cb-muted">
          {t('area.tills', { count: tills })} · {t('documents', { count: area.documentsToday })}
        </span>
      </div>
      <span className="shrink-0 font-semibold tabular-nums text-cb-ink">{formatCurrency(area.salesToday)}</span>
    </div>
  );
}

function ShopSection({
  shop,
  expanded,
  onToggle,
  selectedId,
  onSelect,
  single,
  total,
}: {
  shop: ShopNode;
  expanded: boolean;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The scope is this shop (or inside it): its card is the tills table, always open. */
  single: boolean;
  /** Its tills in scope before the search and the chips narrowed them. */
  total: number;
}) {
  const t = useTranslations('dashboard.overview');
  const tB = useTranslations('controlBoard.tills');
  const bodyId = `overview-shop-${shop.sales.id}`;
  const open = single || expanded;

  const meta = (
    <div className="flex flex-wrap gap-x-2 text-xs text-cb-muted">
      <span>{t('shop.tillsOnline', { online: shop.online, total })}</span>
      {shop.openShifts > 0 ? <span>· {t('shop.openShifts', { count: shop.openShifts })}</span> : null}
      <span>· {t('documents', { count: shop.sales.documentsToday })}</span>
      {single ? <span className="md:hidden">· {tB('showing', { shown: shop.tills.length, total })}</span> : null}
    </div>
  );
  const title = single ? (
    tB('inShop', { name: shop.sales.name })
  ) : (
    <span className="flex min-w-0 items-center gap-1.5">
      <NumberPill n={shop.sales.number} />
      <span className="truncate">{shop.sales.name}</span>
      {shop.alerts > 0 ? (
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full bg-cb-amber"
          role="img"
          aria-label={t('shop.alerts', { count: shop.alerts })}
          title={t('shop.alerts', { count: shop.alerts })}
        />
      ) : null}
    </span>
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-cb-line bg-cb-card shadow-[var(--cb-shadow)]">
      <div className="flex items-stretch">
        {single ? (
          <div className="flex min-h-16 min-w-0 flex-1 items-center gap-3 px-4 py-3 md:px-5">
            <Store className="size-5 shrink-0 text-cb-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold leading-snug text-cb-ink md:truncate">{title}</h2>
              {meta}
            </div>
            <span className="hidden shrink-0 text-end text-xs text-cb-muted md:block">
              {tB('showing', { shown: shop.tills.length, total })}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onToggle(shop.sales.id)}
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={t('shop.toggle', { name: shop.sales.name })}
            className="flex min-h-16 min-w-0 flex-1 items-center gap-2 px-4 py-3 text-start outline-none hover:bg-cb-soft/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cb-blue/40 md:px-5"
          >
            <ChevronDown
              className={cn('h-4 w-4 shrink-0 text-cb-muted transition-transform', !expanded && 'rtl:rotate-90 ltr:-rotate-90')}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-cb-ink">{title}</span>
              {meta}
            </div>
            <span className="shrink-0 text-end">
              <span className="block font-semibold tabular-nums text-cb-ink">{formatCurrency(shop.sales.salesToday)}</span>
              {shop.tills.length !== total ? (
                <span className="block text-[11px] text-cb-muted">{tB('showing', { shown: shop.tills.length, total })}</span>
              ) : null}
            </span>
          </button>
        )}
        <Link
          href={`/dashboard/shops/${shop.sales.id}`}
          aria-label={t('shop.open', { name: shop.sales.name })}
          title={t('shop.open', { name: shop.sales.name })}
          className="flex w-11 shrink-0 items-center justify-center border-s border-cb-line text-cb-muted hover:bg-cb-soft/60 hover:text-cb-ink"
        >
          <ChevronLeft className="h-4 w-4 ltr:rotate-180" aria-hidden />
        </Link>
      </div>
      {open ? (
        <div id={bodyId} className="border-t border-cb-line">
          {shop.tills.length === 0 && !shop.sales.areas?.length ? (
            <p className="px-4 py-4 text-sm text-cb-muted md:px-5">{t('noTills')}</p>
          ) : (
            <>
              <HeaderRow />
              {/* Nothing filtered out of this shop: its empty areas still show, as places. */}
              {groupTillsByArea(shop, shop.tills.length === total).map((group) => (
                <div key={group.area?.id ?? 'none'} className="border-b border-cb-line last:border-b-0">
                  {group.area ? (
                    <AreaHeader area={group.area} tills={group.tills.length} />
                  ) : (shop.sales.areas?.length ?? 0) > 0 ? (
                    <div className="bg-cb-soft/60 px-4 py-1.5 text-xs text-cb-muted md:px-5">{t('area.none')}</div>
                  ) : null}
                  {group.area && group.tills.length === 0 ? (
                    <p className="px-4 py-2 ps-10 text-xs text-cb-muted">{t('area.noTills')}</p>
                  ) : null}
                  <ul className="divide-y divide-cb-line">
                    {group.tills.map((till) => (
                      <TillRow
                        key={till.sales.id}
                        till={till}
                        selected={selectedId === till.sales.id}
                        onSelect={onSelect}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </>
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
  singleShop = false,
  totals,
}: {
  companies: CompanyNode[];
  isExpanded: (shopId: string) => boolean;
  onToggleShop: (shopId: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The scope is one shop (or a point of sale or till in it): no company header. */
  singleShop?: boolean;
  /** Per shop, its tills in scope before the search and the chips. */
  totals?: Map<string, number>;
}) {
  const t = useTranslations('dashboard.overview');
  return (
    <div className="space-y-5">
      {companies.map((company) => (
        <div key={company.sales.id} className="space-y-2">
          {singleShop ? null : (
            <div className="flex min-h-11 items-center gap-2 px-1">
              <Building2 className="h-4 w-4 shrink-0 text-cb-muted" aria-hidden />
              <NumberPill n={company.sales.number} />
              <Link
                href={`/dashboard/companies/${company.sales.id}`}
                className="min-w-0 truncate py-2.5 font-semibold text-cb-ink hover:underline"
                title={t('company.open', { name: company.sales.name })}
              >
                {company.sales.name}
              </Link>
              <span className="ms-auto shrink-0 text-end text-sm font-semibold tabular-nums text-cb-muted">
                {formatCurrency(company.sales.salesToday)}
                <span className="block text-[11px] font-normal">
                  {t('documents', { count: company.sales.documentsToday })}
                </span>
              </span>
            </div>
          )}
          <div className="space-y-3">
            {company.shops.map((shop) => (
              <ShopSection
                key={shop.sales.id}
                shop={shop}
                expanded={isExpanded(shop.sales.id)}
                onToggle={onToggleShop}
                selectedId={selectedId}
                onSelect={onSelect}
                single={singleShop}
                total={totals?.get(shop.sales.id) ?? shop.sales.machines.length}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
