/**
 * The preload of the installed app's "מצב הדגמה" (core/demoMode.ts, main/demo/demoShell.ts): `window.r2mDemo` and
 * nothing else — no `window.kiosk`, no `window.r2m`, no `window.r2mApp`, so the screens run on the web demo's bridges
 * and the mock engine, never on the local service, the cloud or a real terminal. And the ribbon "מצב הדגמה" over every
 * page, with the simulated card terminal's answer (a tap changes it: approved → declined → no answer).
 */

import { contextBridge, ipcRenderer } from 'electron';
import { DEMO_IPC, DEMO_TEXT, isDemoRole, nextCardOutcome, type DemoCardOutcome, type R2mDemoBridge } from '../core/demoMode';

let outcome: DemoCardOutcome = 'approve';

const api: R2mDemoBridge = {
  switchTo: (role) => {
    if (isDemoRole(role)) ipcRenderer.send(DEMO_IPC.switchTo, role);
  },
  exit: () => ipcRenderer.send(DEMO_IPC.exit),
  cardOutcome: () => outcome,
  openAdmin: (screen) => ipcRenderer.send(DEMO_IPC.openAdmin, screen === 'technician' ? 'technician' : 'admin'),
  onAdmin: (fn) => {
    const listener = (_e: unknown, p: { from: 'till'; screen: 'admin' | 'technician' }) => fn(p);
    ipcRenderer.on(DEMO_IPC.admin, listener);
    return () => ipcRenderer.removeListener(DEMO_IPC.admin, listener);
  },
  adminClosed: () => ipcRenderer.send(DEMO_IPC.adminClosed),
};

contextBridge.exposeInMainWorld('r2mDemo', api);

/** The ribbon: top centre, out of the corners (the manager's hold top-right, the technician's taps top-left). */
function ribbon() {
  const bar = document.createElement('div');
  bar.setAttribute('data-demo-ribbon', '');
  bar.setAttribute('dir', 'rtl');
  bar.setAttribute('role', 'note');
  bar.style.cssText =
    'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;gap:8px;align-items:center;' +
    'padding:2px 12px;border-radius:0 0 10px 10px;background:rgba(217,119,6,.92);color:#fff;font:700 12px/18px Arial,sans-serif;' +
    'box-shadow:0 1px 4px rgba(0,0,0,.25);user-select:none;';
  const label = document.createElement('span');
  label.textContent = DEMO_TEXT.ribbon;
  const card = document.createElement('button');
  card.type = 'button';
  card.style.cssText = 'all:unset;cursor:pointer;padding:0 8px;border-radius:8px;background:rgba(255,255,255,.22);font:600 11px/18px Arial,sans-serif;';
  const paint = () => (card.textContent = DEMO_TEXT.card[outcome]);
  paint();
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    outcome = nextCardOutcome(outcome);
    paint();
  });
  bar.append(label, card);
  document.body.appendChild(bar);
}

// The hidden pages (none in the demo) and the print window never come here; every demo page gets the ribbon.
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', ribbon, { once: true });
else ribbon();
