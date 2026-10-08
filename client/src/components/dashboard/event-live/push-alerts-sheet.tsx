'use client';

/**
 * `PushAlertsSheet` — "הירשם להתראות בטלפון": turn on push on this phone / browser, choose which
 * alerts arrive (types, the minimum for a large void, shops, events, quiet hours, how often),
 * send a test, see and remove one's devices. For the Manager Cockpit and the alerts page.
 *
 * Props: `{ scope, context?, onDone }` (./types.ts), plus `open` / `onOpenChange` when the
 * caller controls it, or a `trigger` button of its own. With a scope's shop or event and no
 * preferences yet, the form starts narrowed to it.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, Loader2, Smartphone, Trash2 } from 'lucide-react';
import {
  ALERT_CATEGORIES,
  draftFromPrefs,
  prefsBody,
  prefsErrors,
  pushSupport,
  toggle,
  type PrefsDraft,
  type PushSupport,
} from '@/lib/pushAlerts';
import {
  currentEndpoint,
  fetchPushConfig,
  fetchPushDevices,
  fetchPushOptions,
  fetchPushPreferences,
  removePushDevice,
  savePushPreferences,
  sendPushTest,
  subscribeThisBrowser,
  unsubscribeThisBrowser,
} from '@/lib/pushAlertsApi';
import { formatShortDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { CockpitProps } from './types';

function useBrowserSupport(): PushSupport {
  return useSyncExternalStore(
    () => () => {},
    () =>
      pushSupport({
        hasServiceWorker: 'serviceWorker' in navigator,
        hasPushManager: 'PushManager' in window,
        hasNotification: 'Notification' in window,
        permission: 'Notification' in window ? Notification.permission : null,
        userAgent: navigator.userAgent,
        standalone: window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
      }),
    () => 'unsupported' as PushSupport,
  );
}

function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex items-center justify-between gap-3 py-2', className)}>{children}</div>;
}

function PreferencesForm({ initial, onSaved }: { initial: PrefsDraft; onSaved: () => void }) {
  const t = useTranslations('phoneAlerts');
  const [draft, setDraft] = useState<PrefsDraft>(initial);
  const config = useQuery({ queryKey: ['push-config'], queryFn: fetchPushConfig });
  const options = useQuery({ queryKey: ['push-options'], queryFn: fetchPushOptions });
  const errors = prefsErrors(draft);
  const save = useMutation({
    mutationFn: () => savePushPreferences(prefsBody(draft)),
    onSuccess: () => {
      toast.success(t('saved'));
      onSaved();
    },
    onError: () => toast.error(t('saveFailed')),
  });
  const set = (patch: Partial<PrefsDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const labels = Object.fromEntries((config.data?.categories ?? []).map((c) => [c.key, c]));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!errors.length) save.mutate();
      }}
    >
      <Row>
        <span className="font-medium">{t('enabled')}</span>
        <Switch checked={draft.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label={t('enabled')} />
      </Row>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">{t('types')}</legend>
        {ALERT_CATEGORIES.map((c) => (
          <label key={c} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-[#007AFF]"
              checked={draft.categories.includes(c)}
              onChange={() => set({ categories: toggle(draft.categories, c) })}
            />
            <span className="min-w-0">
              <span className="block font-medium">{labels[c]?.label ?? t(`type.${c}`)}</span>
              <span className="block text-xs text-muted-foreground">{labels[c]?.hint ?? ''}</span>
              {c === 'large_void' && draft.categories.includes(c) ? (
                <span className="mt-2 flex items-center gap-2 text-sm">
                  {t('minAmount')}
                  <Input
                    inputMode="decimal"
                    className="h-9 w-28"
                    value={draft.minAmount}
                    onChange={(e) => set({ minAmount: e.target.value })}
                    aria-invalid={errors.includes('minAmount')}
                  />
                  ₪
                </span>
              ) : null}
            </span>
          </label>
        ))}
        {errors.includes('categories') ? <p className="text-sm text-destructive">{t('errors.categories')}</p> : null}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">{t('where')}</legend>
        <p className="text-xs text-muted-foreground">{t('whereHint')}</p>
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border p-2">
          {(options.data?.shops ?? []).map((s) => (
            <label key={s.id} className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[#007AFF]" checked={draft.shopIds.includes(s.id)} onChange={() => set({ shopIds: toggle(draft.shopIds, s.id) })} />
              {s.name}
            </label>
          ))}
          {(options.data?.events ?? []).map((e) => (
            <label key={e.id} className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[#FF3B30]" checked={draft.eventIds.includes(e.id)} onChange={() => set({ eventIds: toggle(draft.eventIds, e.id) })} />
              <span>
                {t('eventOption', { name: e.name })}
                <span className="text-xs text-muted-foreground"> · {e.shopName} · {formatShortDateTime(e.startsAt)}</span>
              </span>
            </label>
          ))}
          {options.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <Row>
          <span className="text-sm font-semibold">{t('quiet')}</span>
          <Switch checked={draft.quiet} onCheckedChange={(v) => set({ quiet: v })} aria-label={t('quiet')} />
        </Row>
        {draft.quiet ? (
          <div className="flex items-center gap-2 text-sm">
            {t('quietFrom')}
            <Input type="time" className="h-9 w-28" value={draft.quietFrom} onChange={(e) => set({ quietFrom: e.target.value })} />
            {t('quietTo')}
            <Input type="time" className="h-9 w-28" value={draft.quietTo} onChange={(e) => set({ quietTo: e.target.value })} />
          </div>
        ) : null}
        {errors.includes('quiet') ? <p className="text-sm text-destructive">{t('errors.quiet')}</p> : null}
        <div className="flex items-center gap-2 text-sm">
          {t('rateLimit')}
          <Input inputMode="numeric" className="h-9 w-20" value={draft.rateLimitMinutes} onChange={(e) => set({ rateLimitMinutes: e.target.value })} aria-invalid={errors.includes('rateLimit')} />
          {t('minutes')}
        </div>
        <Row>
          <span className="text-sm">{t('digest')}</span>
          <Switch checked={draft.digestEnabled} onCheckedChange={(v) => set({ digestEnabled: v })} aria-label={t('digest')} />
        </Row>
      </fieldset>

      <div className="flex justify-end">
        <Button type="submit" disabled={save.isPending || errors.length > 0}>
          {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

function ThisDevice() {
  const t = useTranslations('phoneAlerts');
  const qc = useQueryClient();
  const support = useBrowserSupport();
  const config = useQuery({ queryKey: ['push-config'], queryFn: fetchPushConfig });
  const devices = useQuery({ queryKey: ['push-devices'], queryFn: fetchPushDevices });
  const [endpointKnown, setEndpointKnown] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void currentEndpoint().then((e) => {
      if (alive) setEndpointKnown(!!e);
    });
    return () => {
      alive = false;
    };
  }, []);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['push-devices'] });
    void qc.invalidateQueries({ queryKey: ['push-preferences'] });
  };
  const subscribe = useMutation({
    mutationFn: () => subscribeThisBrowser(config.data?.publicKey ?? null),
    onSuccess: (outcome) => {
      if (outcome === 'subscribed') {
        toast.success(t('subscribed'));
        setEndpointKnown(true);
      } else toast.error(t(outcome === 'denied' ? 'denied' : 'notConfigured'));
      refresh();
    },
    onError: () => toast.error(t('subscribeFailed')),
  });
  const stop = useMutation({
    mutationFn: unsubscribeThisBrowser,
    onSuccess: () => {
      setEndpointKnown(false);
      refresh();
    },
  });
  const test = useMutation({
    mutationFn: sendPushTest,
    onSuccess: (n) => toast.success(t('testSent', { n })),
    onError: () => toast.error(t('testFailed')),
  });
  const remove = useMutation({ mutationFn: removePushDevice, onSuccess: refresh });
  const active = (devices.data ?? []).filter((d) => d.active);

  return (
    <section className="space-y-3 rounded-2xl border p-4">
      <h3 className="flex items-center gap-2 font-semibold">
        <Smartphone className="size-4" aria-hidden />
        {t('thisDevice')}
      </h3>
      {config.data && !config.data.enabled ? (
        <p className="text-sm text-muted-foreground">{t('notConfigured')}</p>
      ) : support !== 'ok' ? (
        <p className="text-sm text-muted-foreground">{t(`support.${support}`)}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {endpointKnown ? (
            <>
              <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending || active.length === 0}>
                {t('sendTest')}
              </Button>
              <Button variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>
                {t('stopHere')}
              </Button>
            </>
          ) : (
            <Button onClick={() => subscribe.mutate()} disabled={subscribe.isPending || !config.data}>
              {subscribe.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <BellRing className="size-4" aria-hidden />}
              {t('subscribe')}
            </Button>
          )}
        </div>
      )}
      {active.length ? (
        <ul className="divide-y text-sm">
          {active.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="block truncate font-medium">{d.label ?? t('device')}</span>
                <span className="block text-xs text-muted-foreground">
                  {d.lastSuccessAt ? t('lastSent', { at: formatShortDateTime(d.lastSuccessAt) }) : t('neverSent')}
                  {d.lastError ? ` · ${d.lastError}` : ''}
                </span>
              </span>
              <Button variant="ghost" size="icon" aria-label={t('removeDevice')} onClick={() => remove.mutate(d.id)}>
                <Trash2 className="size-4 text-destructive" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function PushAlertsSheet({
  scope,
  onDone,
  open,
  onOpenChange,
  trigger,
}: CockpitProps & { open?: boolean; onOpenChange?: (open: boolean) => void; trigger?: boolean }) {
  const t = useTranslations('phoneAlerts');
  const qc = useQueryClient();
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = (v: boolean) => {
    if (open === undefined) setOwn(v);
    onOpenChange?.(v);
    if (!v) onDone?.();
  };
  const prefs = useQuery({ queryKey: ['push-preferences'], queryFn: fetchPushPreferences, enabled: isOpen });
  const initial = useMemo<PrefsDraft | null>(() => {
    if (!prefs.data) return null;
    const draft = draftFromPrefs(prefs.data);
    if (!prefs.data.exists) {
      if (scope.eventId) draft.eventIds = [scope.eventId];
      else if (scope.shopId) draft.shopIds = [scope.shopId];
    }
    return draft;
  }, [prefs.data, scope.eventId, scope.shopId]);

  return (
    <>
      {trigger ? (
        <Button onClick={() => setOpen(true)}>
          <BellRing className="size-4" aria-hidden />
          {t('openSheet')}
        </Button>
      ) : null}
      <Dialog open={isOpen} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('sheetTitle')}</DialogTitle>
            <DialogDescription>{t('sheetHint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <ThisDevice />
            {initial ? (
              <PreferencesForm
                key={prefs.dataUpdatedAt}
                initial={initial}
                onSaved={() => {
                  void qc.invalidateQueries({ queryKey: ['push-preferences'] });
                  setOpen(false);
                }}
              />
            ) : (
              <Loader2 className="mx-auto size-5 animate-spin" aria-hidden />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
