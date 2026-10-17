/**
 * "הסניף אינו פעיל — פנו לתמיכה" on the Windows kiosk (client lib/shopActive.ts): the shared lock
 * (kiosk-shared/shop-lock.tsx), up once the customer on the kiosk is done (KioskApp decides when),
 * with "סגירת משמרת ו-Z" — a manager's code, then the kiosk's own close for its Z mode
 * (main/service.ts shopLockCloseDay, core/shopLock.ts). The code opens nothing: the lock stays
 * until the shop is turned on again in the cloud. The manager's menu (a long press top-right) and
 * the technician's corner keep working over it, as on every resting screen.
 */

import { useState } from 'react';
import type { PreviewModel } from '@kiosk-shared/index';
import { ShopLockScreen } from '@kiosk-shared/shop-lock';
import { SHOP_LOCK_TEXT, type CloseDayKind } from '@dash-lib/shopActive';
import { kiosk } from '../bridge';
import { PinPad } from '../staff/staffParts';

export function KioskShopLock({ m, closeDay }: { m: PreviewModel; closeDay: CloseDayKind | null }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = kiosk.shopLockCloseDay;
  return (
    <ShopLockScreen
      onCloseDay={
        run
          ? () => {
              if (!closeDay) return setNote(SHOP_LOCK_TEXT.nothingToClose);
              setNote(null);
              setAsking(true);
            }
          : null
      }
      busy={busy}
      note={note}
    >
      {asking && run ? (
        <PinPad
          m={m}
          title={`${SHOP_LOCK_TEXT.managerMessage} — קוד מנהל`}
          onCancel={() => setAsking(false)}
          onSubmit={async (code) => {
            setBusy(true);
            try {
              const r = await run(code);
              if (r.wrongCode) return r.message;
              setAsking(false);
              setNote(r.message);
              return null;
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </ShopLockScreen>
  );
}
