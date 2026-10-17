/**
 * "מדפסות" alone (/printerPicker.html, `npm run dev:web` only): the real picker component on the demo bridge — with
 * `?view=<base64url JSON>` the view a print smoke run took from a real device (scripts/print-e2e.ts), else the demo's.
 * For screenshots of the picker as Windows 10/11 (Chromium 130+) and Windows 7 (Electron 22) draw it.
 */

import '../styles.css';
import { createRoot } from 'react-dom/client';
import { PrinterPicker } from './PrinterPicker';
import { staffModel } from '../staff/staffParts';
import type { TechnicianAction, TechnicianActionResult } from '../../shared/bridge';
import { kiosk } from '../bridge';

const raw = new URLSearchParams(window.location.search).get('view');
if (raw) {
  try {
    const json = new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
    (window as unknown as { __R2M_PICKER__?: unknown }).__R2M_PICKER__ = JSON.parse(json);
  } catch {
    /* the demo's printers */
  }
}

const m = staffModel();
const act = (a: TechnicianAction): Promise<TechnicianActionResult> => kiosk.technicianAction(a);
createRoot(document.getElementById('root')!).render(
  <div style={{ maxWidth: 560, margin: '12px auto', padding: 8 }}>
    <PrinterPicker m={m} act={act} />
  </div>,
);
