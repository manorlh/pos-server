/**
 * "מסך מטבח (KDS)" on Windows — the kitchen screen of a KDS device (station / expo / manager),
 * from the shell's KDS module (main/roles/kds.ts). Not a till.
 */

import { useEffect, useState } from 'react';
import type { KdsOrder, KdsView, ShellView } from '../../../shared/roles';
import { shell } from '../shellBridge';
import { RoleTechnician, useTechnicianCorner } from '../RoleTechnician';

function minutesSince(iso: string | null, offsetMs: number): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() + offsetMs - t) / 60_000)) : 0;
}

function title(o: KdsOrder): string {
  if (o.pickupNumber) return `#${o.pickupNumber}`;
  if (o.tableRef) return `שולחן ${o.tableRef}`;
  return o.displayRef ?? '—';
}

export function KdsScreen({ shellView }: { shellView: ShellView }) {
  const [view, setView] = useState<KdsView | null>(null);
  const [, setTick] = useState(0);
  const [tech, setTech, onCorner] = useTechnicianCorner();
  useEffect(() => {
    void shell.kds().then((v) => v && setView(v));
    return shell.on('kds', setView);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);
  const act = (a: Parameters<typeof shell.kdsAction>[0]) => void shell.kdsAction(a);
  const station = view?.device?.role === 'station';
  return (
    <div
      dir="rtl"
      className="relative flex h-screen w-screen flex-col bg-neutral-900 text-white"
      onPointerDown={(e) => {
        shell.activity();
        onCorner(e);
      }}
    >
      <header className="flex items-center justify-between px-4 py-2 text-sm">
        <div className="font-extrabold">
          {view?.device?.name ?? 'מסך מטבח'} · {view?.shopName ?? shellView.shopName ?? ''}
        </div>
        <div className="text-white/60">
          {view?.offline ? 'אין חיבור — מוצג המידע האחרון' : `${view?.orders.length ?? 0} הזמנות`}
          {view?.lastError ? ` · ${view.lastError}` : ''}
        </div>
      </header>
      <main className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 overflow-y-auto p-3">
        {(view?.orders ?? []).map((o) => {
          const age = minutesSince(o.firstReleasedAt ?? o.createdAt, view?.serverOffsetMs ?? 0);
          return (
            <section key={o.id} className="flex flex-col rounded-2xl bg-neutral-800 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-2xl font-black">{title(o)}</div>
                <div className="text-sm font-bold tabular-nums text-white/70">{age} דק׳</div>
              </div>
              <ul className="flex-1 space-y-1">
                {o.tasks.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className={`w-full rounded-lg px-2 py-1 text-start ${t.state === 'ready' ? 'bg-emerald-700/50 line-through' : t.state === 'preparing' ? 'bg-amber-600/30' : 'bg-white/5'}`}
                      onClick={() => act({ type: t.state === 'ready' ? 'undo_ready' : 'item_ready', taskId: t.id })}
                    >
                      <span className="font-bold">{t.activeQty} × {t.name}</span>
                      {t.mods.length ? <div className="text-xs text-white/70">{t.mods.join(', ')}</div> : null}
                      {t.removals.length ? <div className="text-xs text-red-300">בלי {t.removals.join(', ')}</div> : null}
                      {t.notes ? <div className="text-xs text-amber-200">{t.notes}</div> : null}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex gap-2">
                {station ? (
                  <button type="button" className="flex-1 rounded-xl bg-emerald-600 py-2 font-bold" onClick={() => act({ type: 'station_ready', orderId: o.id })}>
                    מוכן
                  </button>
                ) : (
                  <button type="button" className="flex-1 rounded-xl bg-emerald-600 py-2 font-bold" onClick={() => act({ type: o.groupState === 'ready_for_pickup' ? 'handover' : 'ready_for_pickup', orderId: o.id })}>
                    {o.groupState === 'ready_for_pickup' ? 'נמסר' : 'מוכן לאיסוף'}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </main>
      {tech ? <RoleTechnician shellView={shellView} onClose={() => setTech(false)} /> : null}
    </div>
  );
}
