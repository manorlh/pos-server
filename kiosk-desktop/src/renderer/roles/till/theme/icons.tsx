/**
 * The Android till's icons on Windows (P:/specs/till-visual-parity): the Material "Filled" set the app draws with
 * (androidx.compose.material.icons — Apache 2.0, 24×24 paths) plus its own glyphs (ui/nav/BottomBar.kt's catalog grid,
 * SellSheets.kt's pause). Inline SVG in `currentColor`: no icon font to load, crisp at any zoom, cheap on a J1900.
 * `mirrored` icons (Android's AutoMirrored set) flip in a right-to-left page, as they do on the tablet.
 */

import type { CSSProperties } from 'react';

const PATHS = {
  menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
  catalog:
    'M4.5 3h4.5A1.5 1.5 0 0 1 10.5 4.5V9A1.5 1.5 0 0 1 9 10.5H4.5A1.5 1.5 0 0 1 3 9V4.5A1.5 1.5 0 0 1 4.5 3zM15 3h4.5A1.5 1.5 0 0 1 21 4.5V9a1.5 1.5 0 0 1-1.5 1.5H15A1.5 1.5 0 0 1 13.5 9V4.5A1.5 1.5 0 0 1 15 3zM4.5 13.5H9a1.5 1.5 0 0 1 1.5 1.5v4.5A1.5 1.5 0 0 1 9 21H4.5A1.5 1.5 0 0 1 3 19.5V15a1.5 1.5 0 0 1 1.5-1.5zM15 13.5h4.5A1.5 1.5 0 0 1 21 15v4.5a1.5 1.5 0 0 1-1.5 1.5H15a1.5 1.5 0 0 1-1.5-1.5V15a1.5 1.5 0 0 1 1.5-1.5z',
  moreVert: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
  search:
    'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  checkCircle: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  arrowBack: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  cart: 'M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z',
  backspace:
    'M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z',
  info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  refresh:
    'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  notifications:
    'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  remove: 'M19 13H5v-2h14v2z',
  keyboardArrowDown: 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
  chevronEnd: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
} as const;

export type IconName = keyof typeof PATHS;

/** Android's AutoMirrored icons: drawn the other way round in Hebrew. */
const MIRRORED = new Set<IconName>(['arrowBack', 'list', 'backspace']);

export function Icon({ name, size = 24, style, className }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  return (
    <svg
      className={`t-icon${MIRRORED.has(name) ? ' t-icon-mirrored' : ''}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
      style={style}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The payment's tender pictures (CheckoutScreen.kt TenderIcon, a 34 dp canvas): a note or a card, and what sits inside. */
export function TenderIcon({ glyph, size = 34 }: { glyph: 'cash' | 'card' | 'voucher' | 'split'; size?: number }) {
  // The canvas in a 100-unit box: the body 6–94 × 22–78, a 7.5-unit stroke, 8-unit corners.
  const stroke = 7.5;
  return (
    <svg className="t-icon" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={stroke}>
      <rect x="6" y="22" width="88" height="56" rx="8" ry="8" />
      {glyph === 'cash' ? <circle cx="50" cy="50" r="13" /> : null}
      {glyph === 'card' ? <rect x="6" y="36" width="88" height="10" fill="currentColor" stroke="none" /> : null}
      {glyph === 'split' ? <line x1="50" y1="22" x2="50" y2="78" /> : null}
      {glyph === 'voucher' ? <line x1="65.8" y1="26" x2="65.8" y2="74" strokeWidth={6} strokeDasharray="5 4" /> : null}
    </svg>
  );
}
