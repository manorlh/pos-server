'use client';

/**
 * `PushGate` — "התראות בנייד שחובה להפעיל" (P:/specs/pwa-push-required.md): the dashboard
 * layout's one piece for phones and tablets (never a computer):
 *
 * * the install bar ("התקן את R2M כאפליקציה": Android's own prompt, iPhone's Share steps);
 * * the "הפעל התראות" screen (./enable-screen.tsx) — first open from the icon, or every open
 *   when required;
 * * every open: `GET /push/status` with this browser's endpoint hash — permission, registration,
 *   not failing; a granted permission with no (or a rotated, or a failing) registration is
 *   registered again silently;
 * * the reminder (orange, closable for 24 h) and required (red, fixed) bars; blocked → how to
 *   unblock, per platform.
 *
 * The rules are lib/pushGate.ts; the requirement (`required`) is the server's, per level.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Download, Smartphone, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { promptInstall, useInstallPromptAvailable } from '@/lib/installPrompt';
import { currentEndpointHash, resubscribeThisBrowserSilently, subscriptionKeyMatches, tellWorker } from '@/lib/pushAlertsApi';
import { deviceReady } from '@/lib/pushPolicy';
import { fetchPushStatus } from '@/lib/pushPolicyApi';
import {
  detectPlatform,
  gateApplies,
  gateKeys,
  gateView,
  INSTALL_SNOOZE_MS,
  iosPushCapable,
  REMINDER_SNOOZE_MS,
  safeGet,
  safeSet,
  snoozedUntil,
  STOPPED_HERE_KEY,
  type BannerKind,
  type FlowStep,
  type GateFacts,
  type GatePlatform,
  type GateView,
  type KeyValueStore,
  type PermissionState,
} from '@/lib/pushGate';
import { Button } from '@/components/ui/button';
import { EnableScreen } from './enable-screen';

// ── This device (read in the browser, re-read when the page comes back) ──────

interface DeviceSnapshot {
  applies: boolean;
  platform: GatePlatform;
  standalone: boolean;
  supported: boolean;
  iosCapable: boolean;
  permission: PermissionState;
}

function readDevice(): string {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ua = nav.userAgent;
  const shortSide = window.screen ? Math.min(window.screen.width, window.screen.height) : null;
  const facts = { userAgent: ua, maxTouchPoints: nav.maxTouchPoints, screenShortSide: shortSide };
  const snapshot: DeviceSnapshot = {
    applies: gateApplies(facts),
    platform: detectPlatform(facts),
    standalone: window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true,
    supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    iosCapable: iosPushCapable(ua),
    permission: 'Notification' in window ? (Notification.permission as PermissionState) : 'unsupported',
  };
  // A string: a stable snapshot for useSyncExternalStore.
  return JSON.stringify(snapshot);
}

function subscribeDevice(onChange: () => void) {
  // The permission is changed in the phone's settings, away from the page: re-read on return.
  document.addEventListener('visibilitychange', onChange);
  window.addEventListener('focus', onChange);
  window.addEventListener('appinstalled', onChange);
  // …and by the permission prompt itself (where the browser reports it).
  let permission: PermissionStatus | null = null;
  let gone = false;
  void navigator.permissions
    ?.query({ name: 'notifications' as PermissionName })
    .then((s) => {
      if (gone) return;
      permission = s;
      s.addEventListener('change', onChange);
    })
    .catch(() => {});
  return () => {
    gone = true;
    document.removeEventListener('visibilitychange', onChange);
    window.removeEventListener('focus', onChange);
    window.removeEventListener('appinstalled', onChange);
    permission?.removeEventListener('change', onChange);
  };
}

function useDevice(): DeviceSnapshot | null {
  const raw = useSyncExternalStore(subscribeDevice, readDevice, () => '');
  return useMemo(() => (raw ? (JSON.parse(raw) as DeviceSnapshot) : null), [raw]);
}

function storage(kind: 'local' | 'session'): KeyValueStore | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

interface Flags {
  reminderSnoozed: boolean;
  installSnoozed: boolean;
  onboarded: boolean;
  screenClosed: boolean;
  stoppedHere: boolean;
}

function readFlags(userId: string, now: number): Flags {
  const keys = gateKeys(userId);
  const local = storage('local');
  return {
    reminderSnoozed: snoozedUntil(safeGet(local, keys.reminderUntil), now),
    installSnoozed: snoozedUntil(safeGet(local, keys.installUntil), now),
    onboarded: safeGet(local, keys.onboarded) === '1',
    screenClosed: safeGet(storage('session'), keys.screenClosed) === '1',
    stoppedHere: safeGet(local, STOPPED_HERE_KEY) === '1',
  };
}

// ── The bar ──────────────────────────────────────────────────────────────────

const TONE: Record<GateView['tone'], string> = {
  danger: 'bg-red-600 text-white dark:bg-red-700',
  warning: 'bg-orange-400 text-orange-950 dark:bg-orange-500 dark:text-black',
  neutral: 'border-b bg-card text-foreground',
};

function Bar({
  view,
  installPrompt,
  onOpen,
  onInstall,
  onDismiss,
}: {
  view: GateView;
  installPrompt: boolean;
  onOpen: (startAt?: FlowStep) => void;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('pushGate.banner');
  const kind = view.banner as Exclude<BannerKind, 'none'>;
  const text: Record<Exclude<BannerKind, 'none'>, string> = {
    install: t('install'),
    install_required: t('installRequired'),
    ios_update: t('iosUpdate'),
    unsupported: t('unsupported'),
    denied: t('denied'),
    reminder: t('reminder'),
    required: t('required'),
  };
  const Icon = kind === 'install' ? Download : kind === 'install_required' || kind === 'ios_update' ? Smartphone : BellOff;
  const action =
    kind === 'install'
      ? installPrompt
        ? { label: t('installButton'), run: onInstall }
        : { label: t('howToInstall'), run: () => onOpen('install') }
      : kind === 'install_required'
        ? { label: t('howToInstall'), run: () => onOpen() }
        : kind === 'denied'
          ? { label: t('howToUnblock'), run: () => onOpen() }
          : kind === 'ios_update' || kind === 'unsupported'
            ? { label: t('howTo'), run: () => onOpen() }
            : { label: t('enable'), run: () => onOpen() };
  const outline = view.tone === 'neutral';
  return (
    <div
      role={view.tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'sticky top-0 z-30 -mx-3 -mt-3 flex items-center gap-2 px-3 py-2 shadow-sm sm:-mx-4 sm:-mt-4 sm:px-4 md:-mx-6 md:-mt-6 md:px-6 print:hidden',
        TONE[view.tone],
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-sm leading-snug">
        <p className="font-semibold">{text[kind]}</p>
        {kind === 'required' ? <p className="text-xs opacity-90">{t('requiredHint')}</p> : null}
        {kind === 'install' ? <p className="text-xs text-muted-foreground">{t('installHint')}</p> : null}
      </div>
      <Button
        size="sm"
        variant={outline ? 'default' : 'secondary'}
        className={cn('h-9 shrink-0', outline ? '' : 'bg-white text-black hover:bg-white/90 dark:bg-white dark:text-black')}
        onClick={action.run}
      >
        {action.label}
      </Button>
      {view.dismissible ? (
        <button
          type="button"
          className="-me-1 flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
          aria-label={kind === 'install' ? t('later') : t('snooze')}
          title={kind === 'install' ? t('later') : t('snooze')}
          onClick={onDismiss}
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

// ── The gate ─────────────────────────────────────────────────────────────────

export function PushGate() {
  const userId = useAuth((s) => s.user?.id ?? null);
  const device = useDevice();
  if (!userId || !device?.applies) return null;
  // Per user: a shared phone keeps each person's own reminder and first-open screen.
  return <Gate key={userId} userId={userId} device={device} />;
}

function Gate({ userId, device }: { userId: string; device: DeviceSnapshot }) {
  const qc = useQueryClient();
  const installPrompt = useInstallPromptAvailable();
  const [flags, setFlags] = useState<Flags>(() => readFlags(userId, Date.now()));
  const [screen, setScreen] = useState<{ open: boolean; startAt?: FlowStep; n: number }>({ open: false, n: 0 });
  const resubscribing = useRef(false);
  const [resubscribeTried, setResubscribeTried] = useState(false);

  const status = useQuery({
    queryKey: ['push-status'],
    queryFn: async () => {
      const hash = await currentEndpointHash().catch(() => null);
      const data = await fetchPushStatus(hash);
      // fix/pwa-push: a subscription made with another key (the server's keys changed) is not registered.
      const keyMatches = await subscriptionKeyMatches(data.publicKey).catch(() => true);
      void tellWorker(data.publicKey);
      return { ...data, hasSubscription: !!hash, keyMatches };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  // Snoozes run out and flags change in other tabs: re-read when the page comes back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setFlags(readFlags(userId, Date.now()));
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [userId]);

  const facts: GateFacts | null = status.data
    ? {
        ...device,
        ...flags,
        configured: status.data.configured,
        mode: status.data.required,
        registered: status.data.hasSubscription && status.data.keyMatches && deviceReady(status.data),
        resubscribeTried,
        installPrompt,
      }
    : null;
  const view = facts ? gateView(facts) : null;
  const publicKey = status.data?.publicKey ?? null;

  // Every open: the permission is there but this device is not registered (gone, rotated,
  // failing) — register again without asking anything. Once per open; if that did not help,
  // the bar shows.
  const resubscribe = !!view?.resubscribe;
  useEffect(() => {
    if (!resubscribe || resubscribing.current) return;
    resubscribing.current = true;
    void resubscribeThisBrowserSilently(publicKey, userId)
      .catch(() => false)
      .then(() => qc.invalidateQueries({ queryKey: ['push-status'] }))
      .finally(() => setResubscribeTried(true));
  }, [resubscribe, publicKey, qc, userId]);

  if (!facts || !view) return null;

  const keys = gateKeys(userId);
  const local = storage('local');
  const update = (patch: Partial<Flags>) => setFlags((f) => ({ ...f, ...patch }));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['push-status'] });
    void qc.invalidateQueries({ queryKey: ['push-devices'] });
  };

  const openScreen = (startAt?: FlowStep) => setScreen((s) => ({ open: true, startAt, n: s.n + 1 }));
  const closeScreen = () => {
    setScreen((s) => ({ ...s, open: false }));
    // This session: the screen waits for the next open (the bar stays). It was seen: no more first-open screen.
    safeSet(storage('session'), keys.screenClosed, '1');
    safeSet(local, keys.onboarded, '1');
    update({ screenClosed: true, onboarded: true });
    refresh();
  };
  const dismiss = () => {
    if (view.banner === 'install') {
      safeSet(local, keys.installUntil, String(Date.now() + INSTALL_SNOOZE_MS));
      update({ installSnoozed: true });
    } else {
      safeSet(local, keys.reminderUntil, String(Date.now() + REMINDER_SNOOZE_MS));
      update({ reminderSnoozed: true });
    }
  };
  const install = () => {
    void promptInstall().then((outcome) => {
      if (outcome === 'unavailable') openScreen('install');
    });
  };

  // The screen opens by itself (required: every open; reminder: the first time from the icon),
  // or from the bar's button; it stays open through its steps until closed.
  const screenOpen = screen.open || view.autoScreen;
  return (
    <>
      {view.banner !== 'none' ? (
        <Bar view={view} installPrompt={installPrompt} onOpen={openScreen} onInstall={install} onDismiss={dismiss} />
      ) : null}
      {screenOpen ? (
        <EnableScreen
          key={screen.n}
          open
          facts={facts}
          publicKey={publicKey}
          userId={userId}
          startAt={screen.open ? screen.startAt : undefined}
          onClose={closeScreen}
          onChanged={() => {
            // Keep it open through the test, whatever the status says now.
            setScreen((s) => ({ ...s, open: true }));
            update({ stoppedHere: false });
            refresh();
          }}
          onConfirmed={() => {
            safeSet(local, keys.onboarded, '1');
            update({ onboarded: true });
            refresh();
          }}
        />
      ) : null}
    </>
  );
}
