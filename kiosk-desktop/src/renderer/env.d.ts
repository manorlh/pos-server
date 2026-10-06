/// <reference types="vite/client" />

import type { KioskBridge } from '../shared/bridge';

declare global {
  const __WEB_BRIDGE__: boolean;
  interface Window {
    kiosk?: KioskBridge;
    kioskPrint?: {
      onRender(fn: (req: { id: number; doc: unknown; widthDots: number }) => void): void;
      result(r: { id: number; width?: number; height?: number; rgba?: Uint8Array; error?: string }): void;
    };
  }
}
