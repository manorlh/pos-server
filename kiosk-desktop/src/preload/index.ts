/**
 * The only door between the screens and the local service: a typed bridge (shared/bridge.ts) on
 * `window.kiosk`, and for the hidden print window `window.kioskPrint`. Nothing else of Node or
 * Electron reaches the page.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { KioskBridge, KioskEvents } from '../shared/bridge';

const channels: Record<keyof KioskEvents, string> = { view: 'kiosk:view', pay: 'kiosk:pay', toast: 'kiosk:toast' };

const api: KioskBridge = {
  bootstrap: () => ipcRenderer.invoke('kiosk:bootstrap'),
  pair: (input) => ipcRenderer.invoke('kiosk:pair', input),
  reportFlow: (input) => ipcRenderer.send('kiosk:reportFlow', input),
  startPayment: (input) => ipcRenderer.invoke('kiosk:startPayment', input),
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

contextBridge.exposeInMainWorld('kioskPrint', {
  onRender: (fn: (req: { id: number; doc: unknown; widthDots: number }) => void) => ipcRenderer.on('print:render', (_e, req) => fn(req)),
  result: (r: { id: number; width?: number; height?: number; rgba?: Uint8Array; error?: string }) => ipcRenderer.send('print:result', r),
});
