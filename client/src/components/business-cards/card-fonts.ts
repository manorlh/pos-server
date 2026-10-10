/**
 * The card typefaces. Self-hosted by next/font at build time — a visitor's browser never asks a
 * third party for them (no Google request, nothing to consent to). Heebo is the app's own font
 * (app/layout.tsx); the others load only on pages that render a card (`preload: false`).
 */
import { Assistant, Frank_Ruhl_Libre, Rubik } from 'next/font/google';

const rubik = Rubik({ subsets: ['hebrew', 'latin'], variable: '--font-bc-rubik', display: 'swap', preload: false });
const assistant = Assistant({ subsets: ['hebrew', 'latin'], variable: '--font-bc-assistant', display: 'swap', preload: false });
const frank = Frank_Ruhl_Libre({
  subsets: ['hebrew', 'latin'],
  weight: ['400', '700'],
  variable: '--font-bc-frank',
  display: 'swap',
  preload: false,
});

/** Class names that define the font variables — on a wrapper around `CardView` (menu-shared/cards). */
export const CARD_FONT_VARIABLES = `${rubik.variable} ${assistant.variable} ${frank.variable}`;
