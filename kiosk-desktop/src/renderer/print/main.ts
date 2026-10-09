/**
 * The hidden print window: draws what the main process asks (receipts, bons, slips, Zs) and hands
 * back the pixels. Never shown, never printed through a dialog.
 */

import '@fontsource/noto-sans-hebrew/hebrew-400.css';
import '@fontsource/noto-sans-hebrew/hebrew-700.css';
import '@fontsource/noto-sans-hebrew/hebrew-900.css';
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-700.css';
import '@fontsource/roboto/latin-900.css';
import type { PrintDoc } from '../../core/printDocs';
import { loadFonts, renderDoc } from './draw';

void loadFonts();

window.kioskPrint?.onRender(async (req) => {
  try {
    const page = await renderDoc(req.doc as PrintDoc, req.widthDots);
    window.kioskPrint?.result({ id: req.id, ...page });
  } catch (e) {
    window.kioskPrint?.result({ id: req.id, error: e instanceof Error ? e.message : String(e) });
  }
});
