/**
 * The only door between the screens and the local service: a typed bridge (shared/bridge.ts) on
 * `window.kiosk`, the shell's (shared/roles.ts: role, updates, KDS, board) on `window.r2m`, and for
 * the hidden print window `window.kioskPrint`. Nothing else of Node or Electron reaches the page.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { KioskBridge, KioskEvents } from '../shared/bridge';
import type { ShellBridge, ShellEvents } from '../shared/roles';
import type { BridgeWindowApi, BridgeWindowView } from '../shared/bridgeWindow';

const channels: Record<keyof KioskEvents, string> = { view: 'kiosk:view', pay: 'kiosk:pay', toast: 'kiosk:toast' };

const api: KioskBridge = {
  bootstrap: () => ipcRenderer.invoke('kiosk:bootstrap'),
  pair: (input) => ipcRenderer.invoke('kiosk:pair', input),
  reportFlow: (input) => ipcRenderer.send('kiosk:reportFlow', input),
  funnel: (events) => ipcRenderer.send('kiosk:funnel', events),
  battery: (reading) => ipcRenderer.invoke('kiosk:battery', reading),
  startPayment: (input) => ipcRenderer.invoke('kiosk:startPayment', input),
  placeOpenOrder: (input) => ipcRenderer.invoke('kiosk:placeOpenOrder', input),
  redeemVoucher: (input) => ipcRenderer.invoke('kiosk:redeemVoucher', input),
  reverseVoucher: (id) => ipcRenderer.invoke('kiosk:reverseVoucher', id),
  cancelPayment: () => ipcRenderer.invoke('kiosk:cancelPayment'),
  receiptChoice: (orderId, print) => ipcRenderer.invoke('kiosk:receiptChoice', orderId, print),
  helpRequest: () => ipcRenderer.invoke('kiosk:helpRequest'),
  adminUnlock: (pin) => ipcRenderer.invoke('kiosk:adminUnlock', pin),
  adminInfo: () => ipcRenderer.invoke('kiosk:adminInfo'),
  adminAction: (a) => ipcRenderer.invoke('kiosk:adminAction', a),
  technicianUnlock: (code) => ipcRenderer.invoke('kiosk:technicianUnlock', code),
  technicianInfo: () => ipcRenderer.invoke('kiosk:technicianInfo'),
  technicianAction: (a) => ipcRenderer.invoke('kiosk:technicianAction', a),
  on: (event, fn) => {
    const channel = channels[event];
    const listener = (_e: unknown, payload: unknown) => (fn as (p: unknown) => void)(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('kiosk', api);

/** The shell (shared/roles.ts): the device's role, the update status, the KDS and board screens. */
const shellChannels: Record<keyof ShellEvents, string> = { view: 'shell:view', board: 'shell:board', kds: 'shell:kds' };
const shellApi: ShellBridge = {
  view: () => ipcRenderer.invoke('shell:view'),
  board: () => ipcRenderer.invoke('shell:board'),
  kds: () => ipcRenderer.invoke('shell:kds'),
  kdsAction: (a) => ipcRenderer.invoke('shell:kdsAction', a),
  activity: () => ipcRenderer.send('shell:activity'),
  becomeBridge: () => ipcRenderer.invoke('shell:becomeBridge'),
  desktopExit: (pin) => ipcRenderer.invoke('shell:desktopExit', pin),
  on: (event, fn) => {
    const channel = shellChannels[event];
    const listener = (_e: unknown, payload: unknown) => (fn as (p: unknown) => void)(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('r2m', shellApi);

/** "גשר לדפדפן": the bridge's own window (shared/bridgeWindow.ts). */
const bridgeApi: BridgeWindowApi = {
  view: () => ipcRenderer.invoke('bridge:view'),
  action: (a) => ipcRenderer.invoke('bridge:action', a),
  on: (fn) => {
    const listener = (_e: unknown, v: BridgeWindowView) => fn(v);
    ipcRenderer.on('bridge:view', listener);
    return () => ipcRenderer.removeListener('bridge:view', listener);
  },
};

contextBridge.exposeInMainWorld('r2mBridge', bridgeApi);

contextBridge.exposeInMainWorld('kioskPrint', {
  onRender: (fn: (req: { id: number; doc: unknown; widthDots: number }) => void) => ipcRenderer.on('print:render', (_e, req) => fn(req)),
  result: (r: { id: number; width?: number; height?: number; rgba?: Uint8Array; error?: string }) => ipcRenderer.send('print:result', r),
});
