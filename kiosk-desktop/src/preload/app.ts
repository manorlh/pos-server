/**
 * The till view's preload (S0-6): `window.r2mApp` (shared/till/appBridge.ts) and nothing else —
 * no `window.kiosk`, no Node, no Electron, no hardware call. The engine's envelopes go through
 * IPC to the main process (main/roles/tillElectron.ts); `hw.*` never reach this page (§3.1, §9.5).
 */

import { contextBridge, ipcRenderer } from 'electron';
import { APP_IPC, type R2mAppBridge } from '../shared/till/appBridge';
import type { DeviceRoleName, EngineEvent } from '../shared/till/protocol';

const bridge: R2mAppBridge = {
  info: () => ipcRenderer.invoke(APP_IPC.info),
  hello: (since) => ipcRenderer.invoke(APP_IPC.hello, since),
  call: (c) => ipcRenderer.invoke(APP_IPC.call, c),
  on: (fn) => {
    const listener = (_e: unknown, ev: EngineEvent) => fn(ev);
    ipcRenderer.on(APP_IPC.event, listener);
    return () => ipcRenderer.removeListener(APP_IPC.event, listener);
  },
  onRole: (fn) => {
    const listener = (_e: unknown, role: DeviceRoleName) => fn(role);
    ipcRenderer.on(APP_IPC.role, listener);
    return () => ipcRenderer.removeListener(APP_IPC.role, listener);
  },
  reportReady: () => ipcRenderer.send(APP_IPC.ready),
  reportIdle: (idle, busy) => ipcRenderer.send(APP_IPC.idle, idle === true, busy === true),
  keepAwake: (on) => ipcRenderer.send(APP_IPC.keepAwake, on === true),
};

contextBridge.exposeInMainWorld('r2mApp', bridge);
