/**
 * A view laid over the main window (the till's, roles/tillElectron.ts) on both Electron lines, chosen ONCE by
 * capability so create / attach / detach / fit always use the same API:
 *
 *  - `WebContentsView` + `win.contentView` (Electron 30+, the standard build on Electron 44) — only when the major is
 *    ≥ 30 AND the view really has `setBounds` AND the window really has `contentView.addChildView`.
 *  - `BrowserView` + `win.setBrowserView` otherwise. Electron 22 (the Windows 7 build) exposes an early experimental
 *    `WebContentsView` with no `setBounds` (and a different `contentView`): taking it there threw
 *    "e.setBounds is not a function" in the main process and left the till on "loading" forever.
 *
 * `fit` never throws: a missing method is logged once and the view stays as it is. Nothing in here imports Electron
 * (the module is passed in), so test/win7MainApis.test.ts runs it against an Electron-22-shaped fake.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of a view (either class) used here. */
export interface ViewLike<WC = unknown> {
  webContents: WC;
  setBounds?(b: Bounds): void;
  setAutoResize?(o: { width: boolean; height: boolean }): void;
}

type ViewCtor = new (o: { webPreferences: Record<string, unknown> }) => ViewLike;

/** The part of the `electron` module used here. */
export interface ElectronViewsLike {
  WebContentsView?: ViewCtor;
  BrowserView?: ViewCtor;
}

/** The part of a BrowserWindow used here. */
export interface WindowViewsLike {
  contentView?: { addChildView?(v: unknown): void; removeChildView?(v: unknown): void };
  setBrowserView?(v: unknown): void;
  addBrowserView?(v: unknown): void;
  removeBrowserView?(v: unknown): void;
}

export type ViewApi = 'contentView' | 'browserView';

/** Electron's major version (`process.versions.electron`), 0 when unknown (Node tools, tests). */
export function electronMajor(versions: Record<string, string | undefined> = process.versions): number {
  const m = /^(\d+)\./.exec(versions.electron ?? '');
  return m ? Number(m[1]) : 0;
}

/** The first Electron line where `WebContentsView` + `BaseWindow.contentView` are the stable API. */
export const CONTENT_VIEW_MAJOR = 30;

export interface OverlayView<WC = unknown> {
  readonly api: ViewApi;
  readonly webContents: WC;
  attach(): void;
  detach(): void;
  /** Sets the view's bounds; never throws. */
  fit(b: Bounds): void;
}

/**
 * Creates the view with the API the running Electron really supports and binds it to `win`.
 * `major` is Electron's (electronMajor()); passed in so the tests can play Electron 22.
 */
export function createOverlayView<WC = unknown>(
  e: ElectronViewsLike,
  win: WindowViewsLike,
  webPreferences: Record<string, unknown>,
  major: number,
  log: (m: string) => void = () => undefined,
): OverlayView<WC> {
  let view: ViewLike | null = null;
  let api: ViewApi = 'browserView';
  const cv = win.contentView;
  if (major >= CONTENT_VIEW_MAJOR && typeof e.WebContentsView === 'function' && typeof cv?.addChildView === 'function') {
    const candidate = new e.WebContentsView({ webPreferences });
    if (typeof candidate.setBounds === 'function') {
      view = candidate;
      api = 'contentView';
    } else {
      log('view: WebContentsView has no setBounds here — BrowserView instead');
      (candidate.webContents as { destroy?(): void; close?(): void } | undefined)?.destroy?.();
    }
  }
  if (!view) {
    if (typeof e.BrowserView !== 'function') throw new Error('no usable view class in this Electron (no BrowserView, no WebContentsView with setBounds)');
    view = new e.BrowserView({ webPreferences });
    api = 'browserView';
  }
  const v = view;
  let warned = false;
  log(`view: ${api} (Electron ${major || '?'})`);

  return {
    api,
    webContents: v.webContents as WC,
    attach: () => {
      if (api === 'contentView') win.contentView!.addChildView!(v);
      else if (typeof win.setBrowserView === 'function') win.setBrowserView(v);
      else if (typeof win.addBrowserView === 'function') win.addBrowserView(v);
      else throw new Error('this window cannot show a BrowserView');
    },
    detach: () => {
      try {
        if (api === 'contentView') win.contentView?.removeChildView?.(v);
        else if (typeof win.setBrowserView === 'function') win.setBrowserView(null);
        else win.removeBrowserView?.(v);
      } catch (err) {
        log(`view: detach failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    fit: (b) => {
      try {
        if (typeof v.setBounds !== 'function') throw new Error('setBounds is not a function');
        v.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) });
      } catch (err) {
        if (!warned) log(`view: fit failed (${api}) — ${err instanceof Error ? err.message : String(err)}`);
        warned = true;
      }
    },
  };
}
