/**
 * "מדפסות" on the technician's screen (core/printerPicker.ts has the rules; main/service.ts `printerPicker` the look): every
 * printer the device finds — Windows queues, a USB printer without a driver, COM ports, the network's 9100 and the saved
 * addresses — with its connection, its state and "בדיקה"; ONE printer for everything by default, the bons' and the item
 * tickets' own printer as an option; "רוחב הדפסה"; a chosen printer that is gone, said at the top. Looked at again every
 * 5 s while open (the network scan on open and on "חיפוש ברשת").
 */

import { useEffect, useRef, useState } from 'react';
import type { PreviewModel } from '@kiosk-shared/index';
import { PICK_ROLES, PICK_TEXT as T, type PickerView, type PickRole } from '../../core/printerPicker';
import type { TechnicianAction, TechnicianActionResult } from '../../shared/bridge';
import { kiosk } from '../bridge';
import { answered, Btn, Panel } from '../staff/staffParts';

const STATUS_COLOR: Record<string, string> = { ready: '#16A34A', paper_low: '#D97706', unknown: '#9CA3AF' };
const REFRESH_MS = 5_000;

export function PrinterPicker({ m, act }: { m: PreviewModel; act: (a: TechnicianAction, label?: string) => Promise<TechnicianActionResult> }) {
  const [view, setView] = useState<PickerView | null>(null);
  const [scanning, setScanning] = useState(false);
  const [role, setRole] = useState<PickRole>('receipt');
  const alive = useRef(true);
  const look = (lan: boolean) =>
    answered(kiosk.technicianAction({ type: 'printerDiscover', lan }))
      .then((r: TechnicianActionResult) => {
        if (alive.current && r.picker) setView(r.picker);
      })
      .catch(() => undefined);
  useEffect(() => {
    alive.current = true;
    setScanning(true);
    void look(false).then(() => look(true).finally(() => alive.current && setScanning(false)));
    const timer = setInterval(() => void look(false), REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  const run = (a: TechnicianAction) =>
    void act(a).then((r) => {
      if (r.picker) setView(r.picker);
    });
  if (!view) {
    return (
      <Panel m={m} title={T.title}>
        <div className="text-xs">{T.scanning}</div>
      </Panel>
    );
  }
  return (
    <Panel m={m} title={view.title}>
      <div className="text-xs" style={{ color: m.c.mutedText }} data-testid="picker-hint">
        {view.hint}
      </div>
      {view.alerts.map((a) => (
        <div key={a} className="rounded-lg border-2 px-2 py-1.5 text-xs font-bold" style={{ borderColor: '#DC2626', color: '#991B1B', background: '#FEF2F2' }} role="alert">
          {a}
        </div>
      ))}
      <div className="space-y-1">
        {view.roles.map((r) => (
          <div key={r.role} className="flex items-center justify-between gap-2 text-xs">
            <span style={{ color: m.c.mutedText }}>{r.label}</span>
            <span className="font-semibold">{r.value}</span>
            {r.role !== 'receipt' && !r.auto ? (
              <Btn m={m} onClick={() => run({ type: 'printerChoose', role: r.role, target: null })}>
                {T.sameAsMain}
              </Btn>
            ) : r.role === 'receipt' && !r.auto ? (
              <Btn m={m} onClick={() => run({ type: 'printerChoose', role: 'receipt', target: null })}>
                {T.auto}
              </Btn>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span style={{ color: m.c.mutedText }}>בחירה עבור:</span>
        {PICK_ROLES.map((r) => (
          <Btn key={r} m={m} onClick={() => setRole(r)}>
            {role === r ? `✓ ${T.role[r]}` : T.role[r]}
          </Btn>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Btn m={m} onClick={() => void look(false)}>
          {T.refresh}
        </Btn>
        <Btn
          m={m}
          onClick={() => {
            setScanning(true);
            void look(true).finally(() => setScanning(false));
          }}
        >
          {scanning || view.lanScanning ? T.scanning : T.scanLan}
        </Btn>
        {view.subnet ? (
          <span className="text-xs" dir="ltr" style={{ color: m.c.mutedText }}>
            {view.subnet}
          </span>
        ) : null}
      </div>
      {view.rows.length === 0 ? <div className="text-xs">{T.none}</div> : null}
      <div className="space-y-1.5" data-testid="picker-rows">
        {view.rows.map((p) => (
          <div key={p.id} className="space-y-1 rounded-lg border p-2 text-xs" style={{ borderColor: p.roles.length > 0 ? m.c.text : m.c.border }}>
            <div className="flex items-center justify-between gap-2">
              <bdi className="font-bold">{p.name}</bdi>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: p.missing ? '#DC2626' : (STATUS_COLOR[p.status] ?? '#DC2626') }} />
                {p.statusText}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2" style={{ color: m.c.mutedText }}>
              <span>{p.connectionText}</span>
              <span dir="ltr">{p.detail}</span>
            </div>
            {p.roleTexts.length > 0 ? <div className="font-semibold">✓ {p.roleTexts.join(' · ')}</div> : null}
            {p.target ? (
              <div className="flex flex-wrap gap-1.5">
                <Btn m={m} onClick={() => run({ type: 'printerChoose', role, target: p.target! })}>
                  {`${T.choose} — ${T.role[role]}`}
                </Btn>
                <Btn m={m} onClick={() => void act({ type: 'printerTestTarget', target: p.target! })}>
                  {T.test}
                </Btn>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-1.5 text-xs" style={{ borderColor: m.c.border }}>
        <span style={{ color: m.c.mutedText }}>{T.width}</span>
        {view.widths.map((w) => (
          <Btn key={w} m={m} onClick={() => run({ type: 'printerWidth', widthDots: w })}>
            {view.widthDots === w ? `✓ ${w}` : String(w)}
          </Btn>
        ))}
      </div>
    </Panel>
  );
}
