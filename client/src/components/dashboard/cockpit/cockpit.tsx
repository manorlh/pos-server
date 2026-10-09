'use client';

/**
 * The cockpit's ("הניהול שלי") pieces on the home page — never a navigation away:
 *
 * * `CockpitProvider` — the scope, and the one bottom sheet an action opens in place;
 * * `QuickActionsBar` — big buttons, the registered actions the user may use;
 * * `AttentionFeed` — "דורש תשומת לב": every provider's items in one prioritised list, each with
 *   its buttons (they open a sheet, or the till's own details);
 * * `DevicesStrip` — every till with its light and its sales today; a tap opens its sheet.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { allowedEntries, pickVariant, sortAttention } from '@/lib/cockpitGates';
import { formatCurrency } from '@/lib/format';
import type { TillNode } from '@/lib/overview';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { BoardCard, CardTitle, boardSurface } from '@/components/dashboard/control-board/board-ui';
import { DeviceCommandChip } from '@/components/dashboard/device-commands/command-chip';
import { useCockpitFeatures } from './features';
import { ATTENTION_PROVIDERS, COCKPIT_CARDS, QUICK_ACTIONS, TILL_DETAILS_ACTION, actionById } from './registry';
import type { AttentionItem, AttentionProvider, CockpitAction, CockpitActionContext, CockpitScope } from './types';

// ── The host ─────────────────────────────────────────────────────────────────

interface CockpitContextValue {
  scope: CockpitScope;
  /** Opens an action's sheet in place (or the till's own sheet for `tillDetails`). */
  open: (actionId: string, context?: CockpitActionContext) => void;
  /** Opens an attention item's own sheet in place (`AttentionAction.render`). */
  openSheet: (render: (close: () => void) => React.ReactNode) => void;
}

const CockpitContext = createContext<CockpitContextValue | null>(null);

export function useCockpit(): CockpitContextValue {
  const ctx = useContext(CockpitContext);
  if (!ctx) throw new Error('useCockpit must be used inside CockpitProvider');
  return ctx;
}

/**
 * The actions this user may use, now (gates: sections, roles, days); with `bar`, the bar's. An
 * action with `variants` takes the sheet of the first variant the user passes (none: not shown).
 */
export function useAllowedActions(barOnly: boolean): CockpitAction[] {
  const access = useDashboardAccess();
  const role = useAuth((s) => s.user?.role);
  const features = useCockpitFeatures();
  return allowedEntries(QUICK_ACTIONS, access, role)
    .filter((a) => !a.feature || features[a.feature])
    .map((a): CockpitAction => {
      if (!a.variants) return a;
      const v = pickVariant(a.variants, access, role);
      return v ? { ...a, Sheet: v.Sheet, ownDialog: v.ownDialog } : { ...a, Sheet: null };
    })
    .filter((a) => a.Sheet !== null && (!barOnly || a.bar));
}

export function CockpitProvider({
  scope,
  dark,
  onOpenTill,
  children,
}: {
  scope: CockpitScope;
  dark: boolean;
  /** The till's own sheet (its details and remote actions) — the page's. */
  onOpenTill: (machineId: string) => void;
  children: React.ReactNode;
}) {
  const t = useTranslations('controlBoard.cockpit');
  const [opened, setOpened] = useState<{ actionId: string; context?: CockpitActionContext } | null>(null);
  // An attention item's own sheet (`AttentionAction.render`), one at a time like the actions'.
  const [custom, setCustom] = useState<{ render: (close: () => void) => React.ReactNode } | null>(null);
  const allowed = useAllowedActions(false);
  const open = useCallback(
    (actionId: string, context?: CockpitActionContext) => {
      if (actionId === TILL_DETAILS_ACTION) {
        if (context?.machineId) onOpenTill(context.machineId);
        return;
      }
      setOpened({ actionId, context });
    },
    [onOpenTill],
  );
  const openSheet = useCallback((render: (close: () => void) => React.ReactNode) => setCustom({ render }), []);
  const value = useMemo(() => ({ scope, open, openSheet }), [open, openSheet, scope]);
  const action = opened ? allowed.find((a) => a.id === opened.actionId) : undefined;
  const Sheet = action?.Sheet ?? null;
  // A sheet that is its own dialog (`ownDialog`) is mounted as it is — never a dialog in a dialog.
  const hosted = !!Sheet && !action?.ownDialog;
  return (
    <CockpitContext.Provider value={value}>
      {children}
      {custom ? custom.render(() => setCustom(null)) : null}
      {action?.ownDialog && Sheet ? (
        <Sheet scope={scope} context={opened?.context} onDone={() => setOpened(null)} />
      ) : null}
      <Dialog open={hosted} onOpenChange={(o) => (o ? null : setOpened(null))}>
        <DialogContent className={cn(boardSurface(dark), 'bg-cb-card text-cb-ink sm:max-w-lg')}>
          {hosted && action && Sheet ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
                  <action.icon className="size-5 text-cb-muted" aria-hidden />
                  {t(`actions.${action.labelKey}`)}
                </DialogTitle>
              </DialogHeader>
              <Sheet scope={scope} context={opened?.context} onDone={() => setOpened(null)} />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </CockpitContext.Provider>
  );
}

// ── Quick actions ────────────────────────────────────────────────────────────

export function QuickActionsBar({ className }: { className?: string }) {
  const t = useTranslations('controlBoard.cockpit');
  const { open } = useCockpit();
  const actions = useAllowedActions(true);
  if (actions.length === 0) return null;
  return (
    <section aria-label={t('quickActions')} className={className}>
      <h2 className="mb-2 text-base font-semibold text-cb-ink">{t('quickActions')}</h2>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => open(a.id)}
            className="flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-2xl border border-cb-line bg-cb-card px-2 py-3 text-center text-xs font-semibold text-cb-ink shadow-[var(--cb-shadow)] outline-none transition-colors hover:bg-cb-soft focus-visible:ring-2 focus-visible:ring-cb-blue/40 md:text-sm"
          >
            <span className="flex size-10 items-center justify-center rounded-full bg-cb-blue/12 text-cb-blue-ink">
              <a.icon className="size-5" aria-hidden />
            </span>
            {t(`actions.${a.labelKey}`)}
          </button>
        ))}
      </div>
    </section>
  );
}

// ── The attention feed ───────────────────────────────────────────────────────

/** One provider's items, reported up when they change (a provider is a hook: one per component). */
function ProviderProbe({
  provider,
  scope,
  onItems,
}: {
  provider: AttentionProvider;
  scope: CockpitScope;
  onItems: (id: string, items: AttentionItem[], loading: boolean) => void;
}) {
  const { items, loading } = provider.useItems(scope);
  // Its buttons too: a provider may offer one only once it knows the user may use it.
  const key = items
    .map((i) => `${i.id}|${i.severity}|${i.title}|${i.body ?? ''}|${i.actions.map((a) => `${a.actionId}:${a.labelKey}`).join(',')}`)
    .join('¦');
  useEffect(() => {
    onItems(provider.id, items, loading);
    // `key` stands for the items' content: a provider may build a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loading, onItems, provider.id]);
  return null;
}

const SEVERITY_STYLE = {
  critical: { icon: OctagonAlert, tone: 'text-cb-red-ink bg-cb-red/12' },
  warning: { icon: AlertTriangle, tone: 'text-cb-amber-ink bg-cb-amber/15' },
  info: { icon: Info, tone: 'text-cb-blue-ink bg-cb-blue/12' },
} as const;

export function AttentionFeed({ className, limit = 6 }: { className?: string; limit?: number }) {
  const t = useTranslations('controlBoard.cockpit');
  const { scope, open, openSheet } = useCockpit();
  const access = useDashboardAccess();
  const role = useAuth((s) => s.user?.role);
  const providers = allowedEntries(ATTENTION_PROVIDERS, access, role);
  const [byProvider, setByProvider] = useState<Record<string, { items: AttentionItem[]; loading: boolean }>>({});
  const [expanded, setExpanded] = useState(false);
  const onItems = useCallback((id: string, items: AttentionItem[], loading: boolean) => {
    setByProvider((prev) => ({ ...prev, [id]: { items, loading } }));
  }, []);
  const actionsAllowed = new Set(useAllowedActions(false).map((a) => a.id));
  const live = providers.map((p) => byProvider[p.id]).filter(Boolean);
  const items = sortAttention(live.flatMap((r) => r.items));
  const loading = live.length < providers.length || live.some((r) => r.loading);
  const shown = expanded ? items : items.slice(0, limit);

  return (
    <BoardCard className={className} labelledBy="cb-attention-title">
      {providers.map((p) => (
        <ProviderProbe key={p.id} provider={p} scope={scope} onItems={onItems} />
      ))}
      <CardTitle
        id="cb-attention-title"
        trailing={items.length ? <span className="text-xs text-cb-muted">{t('feed.count', { count: items.length })}</span> : null}
      >
        {t('feed.title')}
      </CardTitle>
      {loading && items.length === 0 ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full bg-cb-soft" />
          <Skeleton className="h-12 w-full bg-cb-soft" />
        </div>
      ) : items.length === 0 ? (
        <p className="flex items-center gap-2 py-4 text-sm text-cb-muted">
          <CheckCircle2 className="size-5 text-cb-green-ink" aria-hidden />
          {t('feed.allGood')}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-cb-line">
            {shown.map((item) => {
              const style = SEVERITY_STYLE[item.severity];
              const buttons = item.actions.filter(
                (a) => a.run !== undefined || a.render !== undefined || a.actionId === TILL_DETAILS_ACTION || actionsAllowed.has(a.actionId),
              );
              return (
                <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                  <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', style.tone)} aria-hidden>
                    <style.icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-cb-ink">{item.title}</p>
                    {item.body ? <p className="truncate text-xs text-cb-muted">{item.body}</p> : null}
                  </div>
                  {buttons.length ? (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {buttons.map((b) => (
                        <button
                          key={`${b.actionId}:${b.labelKey}`}
                          type="button"
                          onClick={() => (b.run ? b.run() : b.render ? openSheet(b.render) : open(b.actionId, b.context))}
                          className="inline-flex min-h-10 items-center rounded-full border border-cb-line bg-cb-card px-3 text-sm font-medium text-cb-blue-ink hover:bg-cb-soft"
                        >
                          {t(`itemActions.${b.labelKey}`)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {items.length > limit ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 min-h-10 text-sm font-medium text-cb-blue-ink hover:underline"
            >
              {expanded ? t('feed.less') : t('feed.more', { count: items.length - limit })}
            </button>
          ) : null}
        </>
      )}
    </BoardCard>
  );
}

// ── The cockpit's own cards ──────────────────────────────────────────────────

/** The registered cards (registry `COCKPIT_CARDS`) the user may see, each once, for the scope. */
export function CockpitCards({ className }: { className?: string }) {
  const { scope } = useCockpit();
  const access = useDashboardAccess();
  const role = useAuth((s) => s.user?.role);
  const cards = allowedEntries(COCKPIT_CARDS, access, role).filter((c) => c.Card !== null);
  if (cards.length === 0) return null;
  return (
    <div className={cn('space-y-4 md:space-y-5', className)}>
      {cards.map(({ id, Card }) => (Card ? <Card key={id} scope={scope} /> : null))}
    </div>
  );
}

// ── The devices strip ────────────────────────────────────────────────────────

export function DevicesStrip({
  tills,
  loading,
  showMoney,
  className,
}: {
  tills: TillNode[];
  loading: boolean;
  /** Without "דוחות" (or with an event): the lights only. */
  showMoney: boolean;
  className?: string;
}) {
  const t = useTranslations('controlBoard.cockpit');
  const tB = useTranslations('controlBoard');
  const { open } = useCockpit();
  if (!loading && tills.length === 0) return null;
  return (
    <section aria-label={t('devices')} className={className}>
      <h2 className="mb-2 text-base font-semibold text-cb-ink">{t('devices')}</h2>
      {loading && tills.length === 0 ? (
        <Skeleton className="h-20 w-full rounded-2xl bg-cb-card" />
      ) : (
        <ul className="-mx-3 flex snap-x gap-2 overflow-x-auto px-3 pb-1 sm:-mx-4 sm:px-4 md:mx-0 md:flex-wrap md:px-0">
          {tills.map((till) => {
            const light = till.live?.status === 'offline_with_unsynced' ? 'bg-cb-red' : !till.online ? (till.openShift ? 'bg-cb-amber' : 'bg-cb-muted') : 'bg-cb-green';
            const n = till.registerNumber;
            return (
              <li key={till.sales.id} className="flex w-36 snap-start flex-col gap-1">
                <button
                  type="button"
                  onClick={() => open(TILL_DETAILS_ACTION, { machineId: till.sales.id })}
                  className="flex min-h-16 w-36 flex-col items-start gap-1 rounded-2xl border border-cb-line bg-cb-card px-3 py-2 text-start shadow-[var(--cb-shadow)] outline-none hover:bg-cb-soft focus-visible:ring-2 focus-visible:ring-cb-blue/40"
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', light)} />
                    <span className="truncate text-xs font-semibold text-cb-ink">
                      {n ? tB('tillLabel', { number: String(n).padStart(2, '0') }) : till.sales.name}
                    </span>
                    {till.alerts > 0 ? <span className="ms-auto size-2 shrink-0 rounded-full bg-cb-amber" aria-label={t('hasAlerts')} /> : null}
                  </span>
                  <span className="w-full truncate text-[11px] text-cb-muted">{till.sales.name}</span>
                  {showMoney ? (
                    <span className="text-sm font-semibold tabular-nums text-cb-ink">{formatCurrency(till.sales.salesToday)}</span>
                  ) : (
                    <span className="text-[11px] text-cb-muted">{till.online ? tB('tills.connected') : tB('tills.disconnected')}</span>
                  )}
                </button>
                {/* The last command sent to this till ("פקודות שנשלחו"); a sibling, not inside the button. */}
                <DeviceCommandChip machineId={till.sales.id} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** For a sheet that wants the registered action of an id (an item's button). */
export { actionById };
