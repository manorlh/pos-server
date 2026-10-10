'use client';

/**
 * "רץ בדפדפן" on the device page: a machine on the "web" platform — the browser kiosk (`/k`), KDS
 * (`/kds`) or "מוכן / לא מוכן" board (`/board`) on this dashboard's own site (docs/SPEC_KIOSK.md §27,
 * docs/SPEC_KDS.md §13): where it opens, what the browser told the cloud at pairing (browser, system,
 * screen, installed as an app) and how it is paired again (a new code — a browser keeps its own token).
 */

import { useTranslations } from 'next-intl';
import { ExternalLink, Globe } from 'lucide-react';
import { webPathOf, type DeviceRole } from '@/lib/deviceProfile';
import type { PosMachine } from '@/lib/types';

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function WebScreenNote({ m }: { m: Pick<PosMachine, 'platform' | 'deviceRole' | 'deviceInfo'> }) {
  const t = useTranslations('machines.webScreen.device');
  if (m.platform !== 'web') return null;
  const path = webPathOf((m.deviceRole ?? null) as DeviceRole | null);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const info = m.deviceInfo ?? {};
  const browser = [text(info.browser), text(info.os), text(info.model)].filter(Boolean).join(' · ');
  const installed = text(info.installed);
  const screen = text(info.screen);
  const kind = m.deviceRole === 'kds' ? 'kds' : m.deviceRole === 'order_status_board' ? 'board' : 'kiosk';
  return (
    <div className="space-y-1 rounded-md bg-violet-50 p-2 text-xs text-violet-900 dark:bg-violet-950/40 dark:text-violet-200">
      <p className="flex items-center gap-1 font-medium">
        <Globe className="h-3.5 w-3.5" aria-hidden /> {t(`title.${kind}`)}
      </p>
      {path ? (
        <p className="flex flex-wrap items-center gap-1">
          {t('opens')}
          <a href={`${origin}${path}`} target="_blank" rel="noopener noreferrer" dir="ltr" className="inline-flex items-center gap-0.5 font-mono underline">
            {`${origin}${path}`} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </p>
      ) : null}
      {browser ? <p>{t('browser', { browser })}</p> : null}
      {screen || installed ? (
        <p>
          {screen ? t('screen', { screen }) : null}
          {screen && installed ? ' · ' : null}
          {installed ? (installed === 'yes' ? t('installed') : t('notInstalled')) : null}
        </p>
      ) : null}
      <p className="text-violet-800/80 dark:text-violet-300/80">{t('repair')}</p>
    </div>
  );
}
