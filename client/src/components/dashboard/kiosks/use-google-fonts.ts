'use client';

import { useEffect } from 'react';
import { googleFontsCssUrl, type KioskFont } from '@/lib/kioskConfig';

/**
 * Load catalog fonts from Google Fonts CSS2 for the preview and the font picker. A
 * stylesheet is added once per URL and kept: switching back to a font is then instant.
 */
export function useGoogleFonts(fonts: ReadonlyArray<KioskFont | undefined>): void {
  const href = googleFontsCssUrl(fonts.filter((f): f is KioskFont => !!f));
  useEffect(() => {
    if (!href || typeof document === 'undefined') return;
    const existing = Array.from(document.head.querySelectorAll('link[data-kiosk-font]')).some(
      (el) => el.getAttribute('href') === href,
    );
    if (existing) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-kiosk-font', '1');
    document.head.appendChild(link);
  }, [href]);
}
