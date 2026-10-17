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
  pairingScreen: (a) => ipcRenderer.invoke('kiosk:pairingScreen', a),
  reportFlow: (input) => ipcRenderer.send('kiosk:reportFlow', input),
  funnel: (events) => ipcRenderer.send('kiosk:funnel', events),
  battery: (reading) => ipcRenderer.invoke('kiosk:battery', reading),
  startPayment: (input) => ipcRenderer.invoke('kiosk:startPayment', input),
  placeOpenOrder: (input) => ipcRenderer.invoke('kiosk:placeOpenOrder', input),
  redeemVoucher: (input) => ipcRenderer.invoke('kiosk:redeemVoucher', input),
  reverseVoucher: (id) => ipcRenderer.invoke('kiosk:reverseVoucher', id),
  releaseDiscounts: (vouchers) => ipcRenderer.invoke('kiosk:releaseDiscounts', vouchers),
  cancelPayment: () => ipcRenderer.invoke('kiosk:cancelPayment'),
  cashOwedChoice: (choice) => ipcRenderer.invoke('kiosk:cashOwedChoice', choice),
  cashSplit: () => ipcRenderer.invoke('kiosk:cashSplit'),
  cashQuestion: (confirm) => ipcRenderer.invoke('kiosk:cashQuestion', confirm),
  redeemCashCredit: (input) => ipcRenderer.invoke('kiosk:redeemCashCredit', input),
  releaseCashCredit: (id) => ipcRenderer.invoke('kiosk:releaseCashCredit', id),
  receiptChoice: (orderId, print) => ipcRenderer.invoke('kiosk:receiptChoice', orderId, print),
  helpRequest: () => ipcRenderer.invoke('kiosk:helpRequest'),
  adminUnlock: (pin) => ipcRenderer.invoke('kiosk:adminUnlock', pin),
  adminInfo: () => ipcRenderer.invoke('kiosk:adminInfo'),
  adminAction: (a) => ipcRenderer.invoke('kiosk:adminAction', a),
  adminHistory: (input) => ipcRenderer.invoke('kiosk:adminHistory', input),
  technicianUnlock: (code) => ipcRenderer.invoke('kiosk:technicianUnlock', code),
  technicianInfo: () => ipcRenderer.invoke('kiosk:technicianInfo'),
  technicianAction: (a) => ipcRenderer.invoke('kiosk:technicianAction', a),
  shopLockCloseDay: (pin) => ipcRenderer.invoke('kiosk:shopLockCloseDay', pin),
  on: (event, fn) => {
    const channel = channels[event];
    const listener = (_e: unknown, payload: unknown) => (fn as (p: unknown) => void)(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('kiosk', api);

/** The shell (shared/roles.ts): the device's role, the update status, the KDS and board screens. */
const shellChannels: Record<keyof ShellEvents, string> = { view: 'shell:view', board: 'shell:board', kds: 'shell:kds', cash: 'shell:cash', admin: 'shell:admin' };
const shellApi: ShellBridge = {
  view: () => ipcRenderer.invoke('shell:view'),
  board: () => ipcRenderer.invoke('shell:board'),
  kds: () => ipcRenderer.invoke('shell:kds'),
  kdsAction: (a) => ipcRenderer.invoke('shell:kdsAction', a),
  activity: () => ipcRenderer.send('shell:activity'),
  becomeBridge: () => ipcRenderer.invoke('shell:becomeBridge'),
  desktopExit: (pin) => ipcRenderer.invoke('shell:desktopExit', pin),
  cash: () => ipcRenderer.invoke('shell:cash'),
  cashUnlock: (pin) => ipcRenderer.invoke('shell:cashUnlock', pin),
  cashAction: (a) => ipcRenderer.invoke('shell:cashAction', a),
  adminClosed: () => ipcRenderer.send('shell:adminClosed'),
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

/** "מסך לקוח" (main/shell/customerDisplayWindow.ts): the till's frames for its second screen. */
contextBridge.exposeInMainWorld('kioskDisplay', {
  onState: (fn: (frame: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => fn(payload);
    ipcRenderer.on('display:state', listener);
    return () => ipcRenderer.removeListener('display:state', listener);
  },
  ready: () => ipcRenderer.send('display:ready'),
});

contextBridge.exposeInMainWorld('kioskPrint', {
  onRender: (fn: (req: { id: number; doc: unknown; widthDots: number }) => void) => ipcRenderer.on('print:render', (_e, req) => fn(req)),
  result: (r: { id: number; width?: number; height?: number; rgba?: Uint8Array; error?: string }) => ipcRenderer.send('print:result', r),
});
