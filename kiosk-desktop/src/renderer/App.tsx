/**
 * The window of R2M POS for Windows: pairing (server URL + code, as on the till), then the screen
 * of the ROLE the cloud gave this device (core/roles.ts) — never chosen here:
 *
 *   kiosk               the kiosk (renderer/kiosk) — exactly as before, from the local view
 *   kds                 the kitchen screen (renderer/roles/kds)
 *   order_status_board  "מסך מוכן / לא מוכן" (renderer/roles/board)
 *   till, customer_display  a placeholder: "תפקיד זה יגיע בגרסה הבאה"
 *
 * and "waiting" while the role is not known yet (paired, nothing from the cloud yet).
 *
 * "סניף לא פעיל" (client lib/shopActive.ts): a shop turned off in the cloud locks the device with
 * "הסניף אינו פעיל — פנו לתמיכה" — the screens that sell nothing (KDS, board, the placeholders, the
 * waiting screen) at once, here; the kiosk once its customer is done (KioskApp). The sync goes on
 * under it, so turning the shop on again releases it at once.
 */

import { useEffect, useState } from 'react';
import { shopLockShown } from '@dash-lib/shopActive';
import type { KioskView } from '../shared/bridge';
import type { ShellView } from '../shared/roles';
import { kiosk } from './bridge';
import { KioskApp } from './kiosk/KioskApp';
import { Pairing } from './pairing/Pairing';
import { OrderStatusBoard } from './roles/board/OrderStatusBoard';
import { CashHostScreen } from './roles/cash/CashHostScreen';
import { KdsScreen } from './roles/kds/KdsScreen';
import { RolePlaceholder } from './roles/RolePlaceholder';
import { ShopLocked } from './roles/ShopLocked';
import { shell } from './roles/shellBridge';
import { t } from './i18n';

export function App({ initial, initialShell }: { initial: KioskView; initialShell: ShellView | null }) {
  const [view, setView] = useState<KioskView>(initial);
  const [shellView, setShellView] = useState<ShellView | null>(initialShell);
  useEffect(() => kiosk.on('view', setView), []);
  useEffect(() => shell.on('view', setShellView), []);
  if (view.phase === 'unpaired') return <Pairing />;
  const role = shellView?.role ?? null;
  // "סניף לא פעיל": every screen here but the kiosk's sells nothing — locked at once.
  const shopActive = view.shopActive !== false && shellView?.shopActive !== false;
  // "שרת מזומן" (P:/specs/cash-paylink.md): its staff screen, never a kiosk — and never locked (it sells nothing; the kiosks are).
  if (role === 'cash_host') return <CashHostScreen shellView={shellView!} />;
  const kioskScreen = role !== 'kds' && role !== 'order_status_board' && role !== 'till' && role !== 'customer_display' && view.phase === 'kiosk' && !!view.config;
  if (!kioskScreen && shopLockShown({ shopActive, surface: role === 'order_status_board' ? 'board' : role === 'customer_display' ? 'customer_display' : 'kds' })) {
    return <ShopLocked shellView={shellView} />;
  }
  // The screens that are not the kiosk; a kiosk (the cloud's kiosk snapshot) is never one of them.
  if (role === 'kds') return <KdsScreen shellView={shellView!} />;
  if (role === 'order_status_board') return <OrderStatusBoard shellView={shellView!} />;
  if (role === 'till' || role === 'customer_display') return <RolePlaceholder role={role} shellView={shellView!} />;
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
