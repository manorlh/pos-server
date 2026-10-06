/**
 * The kiosk window: pairing (server URL + code, as on the till), "waiting" (paired, not made a
 * kiosk yet), or the kiosk itself — always from the local service's view, which is there at once
 * from the local database (cold start straight to the attract screen).
 */

import { useEffect, useState } from 'react';
import type { KioskView } from '../shared/bridge';
import { kiosk } from './bridge';
import { KioskApp } from './kiosk/KioskApp';
import { Pairing } from './pairing/Pairing';
import { t } from './i18n';

export function App({ initial }: { initial: KioskView }) {
  const [view, setView] = useState<KioskView>(initial);
  useEffect(() => kiosk.on('view', setView), []);
  if (view.phase === 'unpaired') return <Pairing />;
  if (view.phase === 'waiting' || !view.config) {
    return (
      <div dir="rtl" className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-neutral-50 p-8 text-center">
        <span className="h-12 w-12 animate-spin rounded-full border-4 border-neutral-200 border-t-blue-600" />
        <h1 className="text-2xl font-extrabold">{t('waitingTitle')}</h1>
        <p className="max-w-md text-sm text-neutral-500">{t('waitingBody')}</p>
        <p className="text-xs text-neutral-400">
          {view.machine?.name ?? ''} {view.machine?.shopName ? `· ${view.machine.shopName}` : ''}
        </p>
      </div>
    );
  }
  return <KioskApp view={view} />;
}
