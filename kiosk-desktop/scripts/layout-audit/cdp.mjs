/**
 * The layout audit's browser (P:/specs/layout-audit-1610/README.md): a headless Chrome / Edge driven over the
 * DevTools protocol with Node's own WebSocket — no new dependency. One browser, a page per worker; each page
 * emulates one screen of the matrix (the CSS viewport, the device pixel ratio, the window's outer size).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function browserExe() {
  const env = process.env.LAYOUT_AUDIT_BROWSER;
  if (env && existsSync(env)) return env;
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('no Chrome / Edge found — set LAYOUT_AUDIT_BROWSER');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, profileDir }) {
  mkdirSync(profileDir, { recursive: true });
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--lang=he-IL',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1920,1080',
    'about:blank',
  ];
  const proc = spawn(browserExe(), args, { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    await sleep(200);
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      /* not up yet */
    }
  }
  if (!version) {
    proc.kill();
    throw new Error('the browser did not start');
  }
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  return { cdp, close: async () => { try { await cdp.send('Browser.close'); } catch { /* gone */ } proc.kill(); } };
}

export class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = (e) => reject(new Error(`cdp: ${e.message ?? 'socket error'}`));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const fn of this.listeners) fn(msg);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** A page of its own (a target in the flat session mode). */
export async function openPage(cdp) {
  // Each page in a window of its own: a background tab gets no frames (its animations stand still, fades stay at 0).
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setFocusEmulationEnabled', { enabled: true });
  const errors = [];
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? 'exception');
  });
  let initScript = null;
  const page = {
    send: s,
    errors,
    async close() {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    },
    /** The screen: the CSS viewport, its pixel ratio and what `window.outerWidth/outerHeight` say. */
    async emulate({ cssWidth, cssHeight, dpr, outerWidth, outerHeight, portrait }) {
      await s('Emulation.setDeviceMetricsOverride', {
        width: cssWidth,
        height: cssHeight,
        deviceScaleFactor: dpr,
        mobile: false,
        screenWidth: outerWidth,
        screenHeight: outerHeight,
        screenOrientation: portrait ? { type: 'portraitPrimary', angle: 0 } : { type: 'landscapePrimary', angle: 90 },
      });
      if (initScript) await s('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript });
      const src = `Object.defineProperty(window,'outerWidth',{get:()=>${outerWidth},configurable:true});Object.defineProperty(window,'outerHeight',{get:()=>${outerHeight},configurable:true});`;
      initScript = (await s('Page.addScriptToEvaluateOnNewDocument', { source: src })).identifier;
    },
    async goto(url) {
      const loaded = new Promise((resolve) => {
        const off = cdp.on((msg) => {
          if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') {
            off();
            resolve();
          }
        });
      });
      await s('Page.navigate', { url });
      await Promise.race([loaded, sleep(20000)]);
    },
    async eval(expression) {
      const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
    async mouse(type, x, y, extra = {}) {
      await s('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse', ...extra });
    },
    async tap(x, y) {
      await page.mouse('mouseMoved', x, y, { buttons: 0 });
      await page.mouse('mousePressed', x, y);
      await page.mouse('mouseReleased', x, y);
    },
    async hold(x, y, ms) {
      await page.mouse('mouseMoved', x, y, { buttons: 0 });
      await page.mouse('mousePressed', x, y);
      await sleep(ms);
      await page.mouse('mouseReleased', x, y);
    },
    async type(text) {
      await s('Input.insertText', { text });
    },
    async key(key, code = key, keyCode = 0) {
      await s('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
      await s('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    },
    /** A PNG of the viewport; `maxPx`: at most that many device pixels across (smaller files for the report). */
    async screenshot(maxPx = 0) {
      let clip;
      if (maxPx > 0) {
        const m = await page.eval('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
        const scale = Math.min(1, maxPx / (m.w * m.dpr));
        if (scale < 1) clip = { x: 0, y: 0, width: m.w, height: m.h, scale };
      }
      const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip } : {}) });
      return Buffer.from(data, 'base64');
    },
  };
  return page;
}

export { sleep };
