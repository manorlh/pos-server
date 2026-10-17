/**
 * The Windows 7 build's main process on an Electron-22-shaped runtime: the till's view (roles/tillElectron.ts through
 * shell/viewCompat.ts) against a fake Electron 22 — a WebContentsView with NO setBounds, no protocol.handle, no
 * net.fetch — and the static scan (scripts/win7MainApis.mjs) that keeps Electron-23+ APIs behind a feature test.
 *
 * The crash this pins: Electron 22 exposes an experimental WebContentsView; the till took it, `fit()` called
 * `setBounds` on it ("e.setBounds is not a function", an uncaught exception in the main process) and the till stayed
 * on "loading" forever.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOverlayView, electronMajor, type Bounds } from '../src/main/shell/viewCompat';
// @ts-expect-error a plain .mjs build script (no types)
import { scanMainSource, scanMainSources } from '../scripts/win7MainApis.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');

/** A fake webContents with what the till touches. */
function fakeWebContents() {
  return {
    loaded: [] as string[],
    sent: [] as unknown[],
    destroyed: false,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    send(ch: string, v: unknown) {
      this.sent.push([ch, v]);
    },
    loadURL(u: string) {
      this.loaded.push(u);
      return Promise.resolve();
    },
    reload: vi.fn(),
    focus: vi.fn(),
    destroy() {
      this.destroyed = true;
    },
  };
}

/** Electron 22's experimental WebContentsView: a webContents, but no setBounds. */
class Wcv22 {
  webContents = fakeWebContents();
  constructor(public o: unknown) {}
}

/** BrowserView (Electron 22 and 44): setBounds, setAutoResize. */
class FakeBrowserView {
  webContents = fakeWebContents();
  bounds: Bounds[] = [];
  constructor(public o: unknown) {}
  setBounds(b: Bounds) {
    this.bounds.push(b);
  }
  setAutoResize = vi.fn();
}

/** Electron 30+'s WebContentsView. */
class Wcv30 extends FakeBrowserView {}

function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const shown: unknown[] = [];
  const childViews: unknown[] = [];
  return {
    shown,
    childViews,
    // Electron 22 also has a `contentView` (with addChildView) on its windows — the till must not take it there.
    contentView: { addChildView: (v: unknown) => void childViews.push(v), removeChildView: vi.fn() },
    setBrowserView: (v: unknown) => void shown.push(v),
    getContentBounds: () => ({ x: 0, y: 0, width: 1024, height: 768 }),
    on: (ev: string, fn: () => void) => listeners.set(ev, fn),
    removeListener: (ev: string) => listeners.delete(ev),
    emit: (ev: string) => listeners.get(ev)?.(),
  };
}

describe('the view API by capability (shell/viewCompat.ts)', () => {
  it("reads Electron's major from process.versions", () => {
    expect(electronMajor({ electron: '22.3.27' })).toBe(22);
    expect(electronMajor({ electron: '44.5.1' })).toBe(44);
    expect(electronMajor({})).toBe(0);
  });

  it('Electron 22: BrowserView + setBrowserView even though WebContentsView and contentView exist', () => {
    const w = fakeWindow();
    const v = createOverlayView({ WebContentsView: Wcv22 as never, BrowserView: FakeBrowserView as never }, w, {}, 22);
    expect(v.api).toBe('browserView');
    v.attach();
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]).toBeInstanceOf(FakeBrowserView);
    expect(w.childViews).toHaveLength(0);
    v.fit({ x: 0, y: 0, width: 1024, height: 768 });
    expect((w.shown[0] as FakeBrowserView).bounds).toEqual([{ x: 0, y: 0, width: 1024, height: 768 }]);
    v.detach();
    expect(w.shown[1]).toBe(null);
  });

  it('Electron 30+ with a real WebContentsView: contentView.addChildView', () => {
    const w = fakeWindow();
    const v = createOverlayView({ WebContentsView: Wcv30 as never, BrowserView: FakeBrowserView as never }, w, {}, 44);
    expect(v.api).toBe('contentView');
    v.attach();
    expect(w.childViews[0]).toBeInstanceOf(Wcv30);
    expect(w.shown).toHaveLength(0);
    v.fit({ x: 0, y: 0, width: 10, height: 20 });
    expect((w.childViews[0] as Wcv30).bounds).toEqual([{ x: 0, y: 0, width: 10, height: 20 }]);
    v.detach();
    expect(w.contentView.removeChildView).toHaveBeenCalledOnce();
  });

  it('a WebContentsView with no setBounds is never taken, whatever the major says', () => {
    const w = fakeWindow();
    const logs: string[] = [];
    const v = createOverlayView({ WebContentsView: Wcv22 as never, BrowserView: FakeBrowserView as never }, w, {}, 44, (m) => logs.push(m));
    expect(v.api).toBe('browserView');
    expect(logs.join('\n')).toContain('no setBounds');
  });

  it('fit never throws: a view without setBounds is logged once', () => {
    class NoBounds {
      webContents = fakeWebContents();
    }
    const logs: string[] = [];
    const v = createOverlayView({ BrowserView: NoBounds as never }, fakeWindow(), {}, 22, (m) => logs.push(m));
    expect(() => v.fit({ x: 0, y: 0, width: 1, height: 1 })).not.toThrow();
    expect(() => v.fit({ x: 0, y: 0, width: 2, height: 2 })).not.toThrow();
    expect(logs.filter((l) => l.includes('fit failed'))).toHaveLength(1);
  });
});

// ── the till role's Electron glue on a fake Electron 22 ──────────────────────────────────────────────────────────────

const fake = vi.hoisted(() => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const listeners = new Map<string, (...a: unknown[]) => unknown>();
  const streams = new Map<string, (req: unknown, cb: (r: unknown) => void) => void>();
  return { handlers, listeners, streams };
});

vi.mock('electron', () => {
  class Wcv22Mock {
    webContents: unknown;
    constructor() {
      this.webContents = {};
    }
  }
  class BrowserViewMock {
    static made: BrowserViewMock[] = [];
    bounds: unknown[] = [];
    webContents = {
      loaded: [] as string[],
      setWindowOpenHandler() {},
      on() {},
      send() {},
      loadURL(u: string) {
        this.loaded.push(u);
        return Promise.resolve();
      },
      reload() {},
      focus() {},
      destroy() {},
    };
    constructor() {
      BrowserViewMock.made.push(this);
    }
    setBounds(b: unknown) {
      this.bounds.push(b);
    }
  }
  return {
    // Electron 22's shape: no protocol.handle / unhandle, no net.fetch, a WebContentsView without setBounds.
    ipcMain: {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => fake.handlers.set(ch, fn),
      on: (ch: string, fn: (...a: unknown[]) => unknown) => fake.listeners.set(ch, fn),
      removeHandler: (ch: string) => fake.handlers.delete(ch),
      removeAllListeners: (ch: string) => fake.listeners.delete(ch),
    },
    protocol: {
      registerStreamProtocol: (s: string, fn: (req: unknown, cb: (r: unknown) => void) => void) => {
        fake.streams.set(s, fn);
        return true;
      },
      unregisterProtocol: (s: string) => fake.streams.delete(s),
    },
    net: { isOnline: () => true },
    WebContentsView: Wcv22Mock,
    BrowserView: BrowserViewMock,
  };
});

describe('the till view on Electron 22 (roles/tillElectron.ts)', () => {
  beforeEach(() => {
    fake.handlers.clear();
    fake.listeners.clear();
    fake.streams.clear();
  });

  it('creates the view with BrowserView, sizes it, loads the bundle — no uncaught exception', async () => {
    const electron = (await import('electron')) as unknown as { BrowserView: { made: { bounds: unknown[]; webContents: { loaded: string[] } }[] } };
    const { attachTillRole } = await import('../src/main/roles/tillElectron');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'r2m-win7-view-'));
    const index = path.join(dir, 'index.html');
    writeFileSync(index, '<!doctype html><title>till</title>');
    const bundle = { dir, source: 'builtin', manifest: { version: '1.0.0' } };
    const role = {
      serve: (p: string) => (p === '/index.html' ? { file: index, headers: {} } : null),
      info: () => ({}),
      hello: () => Promise.resolve({}),
      call: () => Promise.resolve({}),
      reportReady: vi.fn(),
      reportIdle: vi.fn(),
      onEngineEvent: () => () => undefined,
      hwResult: vi.fn(),
      chooseBundle: () => bundle,
      loading: vi.fn(),
      isReady: false,
      bundle,
      markBad: vi.fn(),
    };
    const w = fakeWindow();
    const logs: string[] = [];
    const till = attachTillRole({
      role: role as never,
      main: () => w as never,
      preload: 'app-preload.js',
      isDev: false,
      enabled: () => true,
      log: (m) => logs.push(m),
    });

    // No protocol.handle on Electron 22: the stream protocol serves r2m://app/.
    const serve = fake.streams.get('r2m');
    expect(serve).toBeTypeOf('function');
    const reply = await new Promise<{ statusCode: number; data: Readable }>((resolve) => serve!({ url: 'r2m://app/index.html', method: 'GET', headers: {} }, resolve as never));
    expect(reply.statusCode).toBe(200);
    expect(reply.data).toBeInstanceOf(Readable);
    reply.data.destroy();

    expect(() => till.onRole('till')).not.toThrow();
    const made = electron.BrowserView.made;
    expect(made).toHaveLength(1);
    expect(w.shown).toEqual([made[0]]);
    expect(w.childViews).toHaveLength(0);
    expect(made[0].bounds).toEqual([{ x: 0, y: 0, width: 1024, height: 768 }]);
    expect(made[0].webContents.loaded).toEqual(['r2m://app/index.html']);
    expect(role.loading).toHaveBeenCalled();
    expect(logs.some((l) => l.startsWith('view: browserView'))).toBe(true);
    expect(logs.some((l) => l.startsWith('till: builtin bundle 1.0.0'))).toBe(true);

    // A resize refits; the manager's menu parks it at zero; hiding detaches it.
    w.emit('resize');
    expect(made[0].bounds).toHaveLength(2);
    till.stop();
    expect(w.shown.at(-1)).toBe(null);
    expect(fake.streams.has('r2m')).toBe(false);
  });
});

describe('the main-process API scan (scripts/win7MainApis.mjs)', () => {
  it('finds nothing in the sources today', () => {
    expect(scanMainSources(root)).toEqual([]);
  });

  it('flags the old till view code (WebContentsView outside viewCompat.ts)', () => {
    const old = [
      "  if (e.WebContentsView) return new e.WebContentsView({ webPreferences });",
      '  if (w.contentView?.addChildView) w.contentView.addChildView(view);',
    ].join('\n');
    const found = scanMainSource('src/main/roles/tillElectron.ts', old) as { what: string }[];
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found[0].what).toContain('WebContentsView');
  });

  it('flags net.fetch / protocol.handle / navigationHistory without a feature test, passes them with one', () => {
    expect(scanMainSource('src/main/x.ts', 'const r = await net.fetch(url);')).toHaveLength(1);
    expect(scanMainSource('src/main/x.ts', "protocol.handle('r2m', h);")).toHaveLength(1);
    expect(scanMainSource('src/main/x.ts', 'wc.navigationHistory.goBack();')).toHaveLength(1);
    expect(scanMainSource('src/main/x.ts', "if (typeof net.fetch === 'function') {\n  const r = await net.fetch(url);\n}")).toEqual([]);
    expect(scanMainSource('src/main/x.ts', "const r = await enet.fetch?.(url);")).toEqual([]);
    expect(scanMainSource('src/main/shell/schemeHandler.ts', "protocol.handle('r2m', h);")).toEqual([]);
    // Comments never count.
    expect(scanMainSource('src/main/x.ts', '// net.fetch( is Electron 28')).toEqual([]);
  });
});

describe('Windows 7 till: zoom, printers (core/windowZoom.ts, printer/transports.ts)', () => {
  it('the till and the whole Windows 7 build at 100% — the kiosk keeps its 540-px design', async () => {
    const { shellAutoZoom, kioskWindowZoom } = await import('../src/core/windowZoom');
    expect(shellAutoZoom({ build: 'win7', role: 'till', width: 1024, height: 768 })).toBe(1);
    expect(shellAutoZoom({ build: 'win7', role: null, width: 1024, height: 768 })).toBe(1);
    expect(shellAutoZoom({ build: 'standard', role: 'till', width: 1366, height: 768 })).toBe(1);
    expect(shellAutoZoom({ build: 'standard', role: 'kiosk', width: 1024, height: 768 })).toBe(kioskWindowZoom(1024, 768));
    expect(kioskWindowZoom(1024, 768)).toBeGreaterThan(1.2);
  });

  it('wmic lists the queues when the PowerShell helper cannot start (UTF-16 and ANSI output)', async () => {
    const { parseWmicPrinters } = await import('../src/main/printer/transports');
    const text = [
      '',
      '',
      'DetectedErrorState=0',
      'DriverName=BTP-R880NP',
      'Name=BTP-R880NP(U) 1',
      'PortName=USB001',
      'PrinterStatus=3',
      'WorkOffline=FALSE',
      '',
      '',
      'DetectedErrorState=9',
      'DriverName=Microsoft XPS Document Writer',
      'Name=Microsoft XPS Document Writer',
      'PortName=XPSPort:',
      'PrinterStatus=1',
      'WorkOffline=TRUE',
      '',
    ].join('\r\r\n');
    for (const out of [Buffer.from(`\uFEFF${text}`, 'utf16le'), Buffer.from(text, 'latin1')]) {
      const list = parseWmicPrinters(out);
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ name: 'BTP-R880NP(U) 1', port: 'USB001', detected: 0, offline: false, status: 3 });
      expect(list[1]).toMatchObject({ name: 'Microsoft XPS Document Writer', offline: true, detected: 9 });
    }
  });

  it('the helper gets ASCII JSON (Windows 7 PowerShell 2 reads stdin in the console code page) and C# 2 code', async () => {
    const { asciiJson, SPOOLER_HELPER_PS1 } = await import('../src/main/printer/transports');
    const line = asciiJson({ op: 'send', printer: 'מדפסת קבלות' });
    expect(line).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(line).printer).toBe('מדפסת קבלות');
    // Add-Type on PowerShell 2 compiles C# 2: no `var`, no object initialisers.
    const cs = /Add-Type -TypeDefinition @"([\s\S]*?)"@/.exec(SPOOLER_HELPER_PS1)![1];
    expect(cs).not.toMatch(/\bvar\s+\w+\s*=/);
    expect(cs).not.toMatch(/new\s+\w+\s*\{/);
    // PowerShell 3+ only cmdlets stay behind the legacy switch.
    expect(SPOOLER_HELPER_PS1).not.toMatch(/Get-Printer|\[pscustomobject\]/i);
  });
});

describe('"מקלדת מסך" (renderer/osk/OnScreenKeyboard.tsx)', () => {
  it('auto: after a touch on the field, or on a touch screen nobody typed on for a minute', async () => {
    const { autoOpens } = await import('../src/renderer/osk/OnScreenKeyboard');
    const now = 1_000_000;
    expect(autoOpens({ now, lastTouchAt: now - 300, lastPhysicalKeyAt: now - 1_000, touchScreen: false })).toBe(true);
    expect(autoOpens({ now, lastTouchAt: 0, lastPhysicalKeyAt: 0, touchScreen: true })).toBe(true);
    expect(autoOpens({ now, lastTouchAt: 0, lastPhysicalKeyAt: now - 5_000, touchScreen: true })).toBe(false);
    expect(autoOpens({ now, lastTouchAt: 0, lastPhysicalKeyAt: 0, touchScreen: false })).toBe(false);
  });
});
