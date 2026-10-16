/**
 * "משמרת ו-Z" in "ניהול הקיוסק" (the manager's code already given) — pos-android ui/kiosk/KioskZPanel.kt
 * `KioskZAdminSection`: the kiosk's Z mode and its one action, run on the kiosk (main/service.ts `kioskAdminZ`,
 * core/kioskZ.ts): "סגירת משמרת" in the shop Z, "הפקת Z" with its own Z — asked to confirm first, never with a
 * customer mid-order or paying.
 */

import { mixHex, readableInk } from '@dash-lib/kioskConfig';
import { useState } from 'react';
import { cardStyle, type PreviewModel } from '@kiosk-shared/index';
import type { AdminActionResult, AdminInfo } from '../../shared/bridge';
import { KZ_TEXT } from '../../core/kioskZ';

export function KioskZPanel({ m, info, onRun }: { m: PreviewModel; info: NonNullable<AdminInfo['kioskZ']>; onRun: () => Promise<AdminActionResult> }) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const shop = info.kind === 'shop';
  const accent = shop ? '#2563EB' : '#7C3AED';
  const enabled = !running && !info.customerBusy && (!shop || info.shiftOpen);
  const label = running ? KZ_TEXT.working : confirming ? KZ_TEXT.confirm : shop ? KZ_TEXT.closeShift : KZ_TEXT.tillZ;
  const press = async () => {
    if (!confirming) {
      setNote(null);
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setRunning(true);
    const r = await onRun().catch((e: unknown) => ({ ok: false, message: String(e) }) as AdminActionResult);
    setRunning(false);
    setNote({ ok: r.ok, text: r.message ?? (r.ok ? 'בוצע' : 'לא בוצע') });
  };
  return (
    <section className="space-y-2 p-3 text-sm" style={cardStyle(m)} data-testid="kiosk-z">
      <h3 className="text-sm font-extrabold">{KZ_TEXT.title}</h3>
      <div className="flex items-center gap-2">
        <span className="rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: `${accent}29`, color: readableInk(accent, [mixHex(m.c.surface, accent, 0x29 / 255)]) }}>
          {KZ_TEXT.kind[info.kind]}
        </span>
        <span>{info.shiftOpen ? KZ_TEXT.shiftOpen : KZ_TEXT.shiftClosed}</span>
      </div>
      <div className="text-xs" style={{ color: m.c.mutedText }}>
        {shop ? KZ_TEXT.shopHint : KZ_TEXT.ownHint}
      </div>
      {info.owed && !shop ? <div className="text-xs font-semibold text-amber-700">{KZ_TEXT.owed}</div> : null}
      {confirming ? <div className="text-xs">{shop ? KZ_TEXT.closeConfirm : KZ_TEXT.zConfirm}</div> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!enabled}
          onClick={() => void press()}
          className="px-4 py-2 text-sm font-bold disabled:opacity-40"
          style={{ background: m.c.button, color: m.c.buttonText, borderRadius: 10 }}
        >
          {label}
        </button>
        {confirming ? (
          <button type="button" onClick={() => setConfirming(false)} className="px-4 py-2 text-sm font-bold" style={{ background: `${m.c.button}1A`, color: m.c.buttonInk, borderRadius: 10 }}>
            {KZ_TEXT.cancel}
          </button>
        ) : null}
      </div>
      {info.customerBusy ? <div className="text-xs" style={{ color: m.c.mutedText }}>{KZ_TEXT.blockedCustomer}</div> : null}
      {note ? <div className={`text-xs font-semibold ${note.ok ? 'text-emerald-700' : 'text-red-600'}`}>{note.text}</div> : null}
    </section>
  );
}
