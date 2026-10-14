/**
 * Chrome / Edge's "install app" offer for the dashboard (`beforeinstallprompt`), caught as early
 * as the page loads — imported by the root layout's service-worker registration — and kept for
 * the `PushGate`'s "התקן" button (pwa-push-required §2.1). Safari has no such event: the gate
 * shows Share → "הוסף למסך הבית" instead.
 *
 * The browser kiosk (`/k`) keeps its own (components/kiosk-web/web-shell.ts): nothing is caught
 * there.
 */
import { useSyncExternalStore } from 'react';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
let captured = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Start listening (once). Safe on the server and outside the dashboard. */
export function captureInstallPrompt(): void {
  if (captured || typeof window === 'undefined') return;
  const path = window.location.pathname;
  if (['/k', '/kds', '/board', '/c'].some((p) => path === p || path.startsWith(`${p}/`))) return;
  captured = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Our own bar offers it (on a phone); without this the browser's mini bar would too.
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the system's install offer is in hand now. */
export function useInstallPromptAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => deferred !== null, () => false);
}

/** Show the system's install dialog; the offer is used up either way. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const evt = deferred;
  if (!evt) return 'unavailable';
  deferred = null;
  emit();
  await evt.prompt();
  const choice = await evt.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
  return choice.outcome;
}

captureInstallPrompt();
