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
 * "ניהול הקיוסק" on every screen (staff/ShellStaff.tsx — the kiosk draws its own): two seconds held in the top-right
 * corner, then a manager's code checked on the device — pairing, waiting, the shop's lock, the KDS, the board, the cash
 * host and the till role too (its view asks for it over the shell).
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
import { PairedNotice } from './pairing/pairedNotice';
import { OrderStatusBoard } from './roles/board/OrderStatusBoard';
import { CashHostScreen } from './roles/cash/CashHostScreen';
import { KdsScreen } from './roles/kds/KdsScreen';
import { RolePlaceholder } from './roles/RolePlaceholder';
import { ShopLocked } from './roles/ShopLocked';
import { ShellStaff } from './staff/ShellStaff';
import { shell } from './roles/shellBridge';
import { t } from './i18n';

export function App(props: { initial: KioskView; initialShell: ShellView | null }) {
  return (
    <>
      <AppScreen {...props} />
      {/* "סוג רישיון": what the device was set up as, for a few seconds after the pairing (pairing/pairedNotice.tsx). */}
      <PairedNotice />
    </>
  );
}

function AppScreen({ initial, initialShell }: { initial: KioskView; initialShell: ShellView | null }) {
  const [view, setView] = useState<KioskView>(initial);
  const [shellView, setShellView] = useState<ShellView | null>(initialShell);
  useEffect(() => kiosk.on('view', setView), []);
  useEffect(() => shell.on('view', setShellView), []);
  if (view.phase === 'unpaired') return <ShellStaff view={view}><Pairing /></ShellStaff>;
  const role = shellView?.role ?? null;
  // "סניף לא פעיל": every screen here but the kiosk's sells nothing — locked at once.
  const shopActive = view.shopActive !== false && shellView?.shopActive !== false;
  // "שרת מזומן" (P:/specs/cash-paylink.md): its staff screen, never a kiosk — and never locked (it sells nothing; the kiosks are).
  if (role === 'cash_host') return <ShellStaff view={view}><CashHostScreen shellView={shellView!} /></ShellStaff>;
  const kioskScreen = role !== 'kds' && role !== 'order_status_board' && role !== 'till' && role !== 'customer_display' && view.phase === 'kiosk' && !!view.config;
  if (!kioskScreen && shopLockShown({ shopActive, surface: role === 'order_status_board' ? 'board' : role === 'customer_display' ? 'customer_display' : 'kds' })) {
    return <ShellStaff view={view}><ShopLocked shellView={shellView} /></ShellStaff>;
  }
  // The screens that are not the kiosk; a kiosk (the cloud's kiosk snapshot) is never one of them.
  if (role === 'kds') return <ShellStaff view={view}><KdsScreen shellView={shellView!} /></ShellStaff>;
  if (role === 'order_status_board') return <ShellStaff view={view}><OrderStatusBoard shellView={shellView!} /></ShellStaff>;
  if (role === 'till' || role === 'customer_display') return <ShellStaff view={view}><RolePlaceholder role={role} shellView={shellView!} /></ShellStaff>;
  if (view.phase === 'waiting' || !view.config) {
    return (
      <ShellStaff view={view}>
      <div dir="rtl" className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-neutral-50 p-8 text-center">
        <span className="h-12 w-12 animate-spin rounded-full border-4 border-neutral-200 border-t-blue-600" />
        <h1 className="text-2xl font-extrabold">{t('waitingTitle')}</h1>
        <p className="max-w-md text-sm text-neutral-500">{t('waitingBody')}</p>
        <p className="text-xs text-neutral-400">
          {view.machine?.name ?? ''} {view.machine?.shopName ? `· ${view.machine.shopName}` : ''}
        </p>
      </div>
      </ShellStaff>
    );
  }
  return <KioskApp view={view} />;
}
