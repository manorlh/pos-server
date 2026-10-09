'use client';

/**
 * The control board's small "שליטה חיה" block: the blocks in force (count, to the stock page's
 * tab), and the remote control of tills and kiosks in a sheet. Kept apart from the board itself.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Gamepad2, MonitorSmartphone, PackageX } from 'lucide-react';
import { ActiveBlocksList, useActiveBlocks } from './active-blocks';
import { DeviceControlSheet } from './device-control-sheet';
import { KioskControlSheet } from './kiosk-control-sheet';
import type { LiveControlScope } from './types';

export function LiveControlBoardChips({ scope, chipClass }: { scope: LiveControlScope; chipClass: string }) {
  const blocks = useActiveBlocks(scope);
  const [open, setOpen] = useState<'devices' | 'kiosks' | null>(null);
  const count = (blocks.data ?? []).filter((b) => b.inForce).length;
  return (
    <>
      <Link href={`/dashboard/stock?tab=blocks`} className={chipClass} title="חסימות פעילות">
        <PackageX className="size-4 text-cb-muted" aria-hidden />
        חסימות פעילות
        {count > 0 ? <span className="rounded-full bg-cb-amber px-1.5 text-[11px] font-bold text-black/85">{count}</span> : null}
      </Link>
      <button type="button" className={chipClass} onClick={() => setOpen('devices')}>
        <Gamepad2 className="size-4 text-cb-muted" aria-hidden />
        שליטה מרחוק
      </button>
      <button type="button" className={chipClass} onClick={() => setOpen('kiosks')}>
        <MonitorSmartphone className="size-4 text-cb-muted" aria-hidden />
        קיוסקים
      </button>
      {open === 'devices' ? <DeviceControlSheet scope={scope} onDone={() => setOpen(null)} /> : null}
      {open === 'kiosks' ? <KioskControlSheet scope={scope} onDone={() => setOpen(null)} /> : null}
    </>
  );
}

/** The blocks in force, as a board card (for the cockpit or a wide board). */
export function LiveControlBlocksCard({ scope }: { scope: LiveControlScope }) {
  return (
    <section className="space-y-2 rounded-2xl border bg-card p-4" aria-label="חסימות פעילות">
      <h2 className="font-semibold">חסימות פעילות</h2>
      <ActiveBlocksList scope={scope} />
    </section>
  );
}
