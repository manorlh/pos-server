/**
 * `/app` as an installed PWA (P:/specs/web-till-spec-v2.md §8.2, §13.6): its manifest, its
 * service worker (public/app-sw.js, scope `/app`) and the update gate — a new version NEVER takes
 * over mid-sale.
 *
 *  - The page tells the workers its sale state (`sale-state`: at rest / busy) — the till bundle
 *    raises it as a DOM event (`r2m:sale-state`, kiosk-desktop src/renderer/app/pickHost.ts).
 *    Until the till runs inside `/app` (S0-10 / P6-6) that event is the MOCK hook here.
 *  - A new worker waits. The gate asks it to take over (`activate-request`) only when the page is
 *    at rest and not busy; the worker itself also checks every other open `/app` window.
 *  - When it took over, the page reloads only while still at rest — otherwise at the next rest.
 *
 * Pure logic (updateDecision, createUpdateGate) is tested in appPwa.test.ts; registration needs a
 * browser. Coordination: the `/app` page is S0-10's — it spreads `appPwaMetadata` into its
 * layout's metadata and calls `registerAppServiceWorker()` once.
 */

export const APP_SCOPE = '/app';
export const APP_SW_URL = '/app-sw.js';
export const APP_MANIFEST_URL = '/app.webmanifest';
/** The till bundle's DOM event (same name in kiosk-desktop src/renderer/app/pickHost.ts). */
export const SALE_STATE_EVENT = 'r2m:sale-state';

/** For the `/app` layout's `metadata` (Next): the manifest, iOS's home-screen app. */
export const appPwaMetadata = {
  manifest: APP_MANIFEST_URL,
  applicationName: 'R2M POS',
  appleWebApp: { capable: true, title: 'R2M POS', statusBarStyle: 'default' as const },
  formatDetection: { telephone: false },
};

export interface SaleState {
  idle: boolean;
  busy: boolean;
}

export type UpdateDecision = 'none' | 'wait' | 'activate';

/**
 * Whether to let a waiting version take over now. Unknown state = busy: a page that has not said
 * it is at rest is never interrupted.
 */
export function updateDecision(o: { waiting: boolean; state: SaleState | null }): UpdateDecision {
  if (!o.waiting) return 'none';
  if (!o.state || o.state.busy || !o.state.idle) return 'wait';
  return 'activate';
}

export interface UpdateGate {
  report(state: SaleState): void;
  setWaiting(waiting: boolean): void;
  /** The new worker took over: reload now if at rest, else at the next rest. */
  controllerChanged(): void;
  readonly state: SaleState | null;
}

export function createUpdateGate(d: { activate(): void; reload(): void; post?(state: SaleState): void }): UpdateGate {
  let state: SaleState | null = null;
  let waiting = false;
  let asked = false;
  let reloadPending = false;
  const evaluate = () => {
    if (reloadPending && state && state.idle && !state.busy) {
      reloadPending = false;
      d.reload();
      return;
    }
    if (updateDecision({ waiting, state }) === 'activate' && !asked) {
      asked = true;
      d.activate();
    }
  };
  return {
    report(s) {
      state = { idle: s.idle === true, busy: s.busy !== false };
      // A sale began again: a later rest may ask again.
      if (state.busy || !state.idle) asked = false;
      d.post?.(state);
      evaluate();
    },
    setWaiting(w) {
      waiting = w;
      if (!w) asked = false;
      evaluate();
    },
    controllerChanged() {
      waiting = false;
      reloadPending = true;
      evaluate();
    },
    get state() {
      return state;
    },
  };
}

/** The MOCK sale-state hook: the till bundle's DOM event (`detail: {idle, busy}`). */
export function listenSaleState(target: EventTarget, fn: (s: SaleState) => void): () => void {
  const handler = (e: Event) => {
    const d = (e as CustomEvent<Partial<SaleState>>).detail ?? {};
    fn({ idle: d.idle === true, busy: d.busy !== false });
  };
  target.addEventListener(SALE_STATE_EVENT, handler);
  return () => target.removeEventListener(SALE_STATE_EVENT, handler);
}

/**
 * Registers public/app-sw.js for `/app` and wires the gate (a production build only — under
 * `next dev` chunks are not hashed and a worker would serve stale code). Returns a stop function.
 */
export function registerAppServiceWorker(win: Window = window, opts: { production?: boolean } = {}): () => void {
  const nav = win.navigator;
  if (!('serviceWorker' in nav)) return () => undefined;
  if (!(opts.production ?? process.env.NODE_ENV === 'production')) return () => undefined;
  const sw = nav.serviceWorker;
  let reg: ServiceWorkerRegistration | null = null;
  const postAll = (msg: unknown) => {
    // The active worker and a waiting one both keep the windows' states.
    sw.controller?.postMessage(msg);
    reg?.waiting?.postMessage(msg);
  };
  const gate = createUpdateGate({
    activate: () => reg?.waiting?.postMessage({ type: 'activate-request' }),
    reload: () => win.location.reload(),
    post: (s) => postAll({ type: 'sale-state', idle: s.idle, busy: s.busy }),
  });
  const offSale = listenSaleState(win, (s) => gate.report(s));
  const onController = () => gate.controllerChanged();
  sw.addEventListener('controllerchange', onController);
  const watch = (r: ServiceWorkerRegistration) => {
    reg = r;
    if (r.waiting && sw.controller) gate.setWaiting(true);
    r.addEventListener('updatefound', () => {
      const next = r.installing;
      next?.addEventListener('statechange', () => {
        // "installed" with a controller = an update that waits (the first install takes over by itself).
        if (next.state === 'installed' && sw.controller) {
          if (gate.state) postAll({ type: 'sale-state', idle: gate.state.idle, busy: gate.state.busy });
          gate.setWaiting(true);
        }
      });
    });
  };
  sw.register(APP_SW_URL, { scope: APP_SCOPE, updateViaCache: 'none' }).then(watch, () => undefined);
  return () => {
    offSale();
    sw.removeEventListener('controllerchange', onController);
  };
}
