/**
 * "מסך מוכן / לא מוכן" — the order status board for customers: big pickup numbers, in
 * preparation and ready. A number that turns ready flashes, is announced across the screen for a
 * moment and chimes. Without internet the last board stays up, with a note.
 *
 * Numbers only (the cloud's pickup payload has no names, phones or notes). Not a till.
 */

import { useEffect, useRef, useState } from 'react';
import { columnFit, newlyReady } from '../../../core/pickupBoard';
import type { BoardNumber, BoardView, ShellView } from '../../../shared/roles';
import { shell } from '../shellBridge';
import { RoleTechnician, useTechnicianCorner } from '../RoleTechnician';

/** A short two-note chime, made here (no sound file, no network). */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const note = (freq: number, at: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.65);
    };
    note(880, 0);
    note(1318.5, 0.18);
    setTimeout(() => void ctx.close(), 1_500);
  } catch {
    /* no audio device: the flash is enough */
  }
}

const FLASH_MS = 8_000;
const ANNOUNCE_MS = 4_000;

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

const SIZE = { xl: 'text-[9vmin]', lg: 'text-[7vmin]', md: 'text-[5vmin]' } as const;

function Numbers({ list, tone, flashing }: { list: BoardNumber[]; tone: 'prep' | 'ready'; flashing: Set<string> }) {
  const fit = columnFit(list.length);
  return (
    <div className="grid content-start gap-[1.5vmin]" style={{ gridTemplateColumns: `repeat(${fit.cols}, minmax(0, 1fr))` }}>
      {list.map((n) => (
        <div
          key={n.number}
          className={[
            'rounded-[2vmin] py-[1.2vmin] text-center font-black tabular-nums leading-none transition-colors',
            SIZE[fit.size],
            tone === 'ready' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/5 text-amber-200/90',
            flashing.has(n.number) ? 'r2m-board-flash ring-4 ring-emerald-300' : '',
          ].join(' ')}
          dir="ltr"
        >
          {n.number}
        </div>
      ))}
    </div>
  );
}

export function OrderStatusBoard({ shellView }: { shellView: ShellView }) {
  const [board, setBoard] = useState<BoardView | null>(null);
  const [flashing, setFlashing] = useState<Map<string, number>>(new Map());
  const [announce, setAnnounce] = useState<string[]>([]);
  const prevReady = useRef<BoardNumber[] | null>(null);
  const [tech, setTech, onCorner] = useTechnicianCorner();
  const clock = useClock();

  useEffect(() => {
    const take = (b: BoardView) => {
      const fresh = newlyReady(prevReady.current, b.ready);
      prevReady.current = b.ready;
      setBoard(b);
      if (fresh.length > 0) {
        const until = Date.now() + FLASH_MS;
        setFlashing((m) => {
          const next = new Map(m);
          for (const n of fresh) next.set(n, until);
          return next;
        });
        setAnnounce(fresh);
        chime();
      }
    };
    void shell.board().then((b) => b && take(b));
    return shell.on('board', take);
  }, []);

  // The flash and the announcement fade by themselves.
  useEffect(() => {
    if (announce.length === 0) return;
    const t = setTimeout(() => setAnnounce([]), ANNOUNCE_MS);
    return () => clearTimeout(t);
  }, [announce]);
  useEffect(() => {
    const t = setInterval(() => {
      setFlashing((m) => {
        const now = Date.now();
        const next = new Map([...m].filter(([, until]) => until > now));
        return next.size === m.size ? m : next;
      });
    }, 1_000);
    return () => clearInterval(t);
  }, []);

  const flashSet = new Set(flashing.keys());
  const updated = board?.updatedAt ? new Date(board.updatedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div dir="rtl" className="relative flex h-screen w-screen select-none flex-col bg-[#0d1016] text-white" onPointerDown={onCorner}>
      <style>{`@keyframes r2mFlash{0%,100%{transform:scale(1)}50%{transform:scale(1.08);background:rgba(16,185,129,.45)}}.r2m-board-flash{animation:r2mFlash 1s ease-in-out infinite}@media (prefers-reduced-motion: reduce){.r2m-board-flash{animation:none}}`}</style>
      <header className="flex items-center justify-between px-[3vmin] py-[2vmin]">
        <div className="text-[3.2vmin] font-extrabold">{board?.shopName ?? shellView.shopName ?? ''}</div>
        <div className="text-[3.2vmin] font-bold tabular-nums text-white/70">{clock}</div>
      </header>
      {board?.offline ? (
        <div className="mx-[3vmin] mb-[1.5vmin] rounded-xl bg-amber-500/15 px-4 py-2 text-center text-[2.2vmin] font-semibold text-amber-200">
          אין חיבור — מוצג המידע האחרון{updated ? ` (עודכן ${updated})` : ''}
        </div>
      ) : null}
      {board?.notConfigured ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-[4vmin] font-extrabold">המסך עוד לא הוגדר כמסך מוכן / לא מוכן</div>
          <div className="max-w-[70vmin] text-[2.4vmin] text-white/60">בדשבורד: הוספת מכשיר מסוג &quot;מסך מוכן / לא מוכן&quot; בסניף, או בעמוד מסכי המטבח — מסך איסוף.</div>
        </div>
      ) : (
        <main className="grid flex-1 grid-cols-[2fr_3fr] gap-[2vmin] px-[3vmin] pb-[3vmin]">
          <section className="flex flex-col rounded-[3vmin] bg-white/[0.04] p-[2.5vmin]">
            <h2 className="mb-[2vmin] text-[4.5vmin] font-black text-amber-300">בהכנה</h2>
            <Numbers list={board?.preparing ?? []} tone="prep" flashing={flashSet} />
          </section>
          <section className="flex flex-col rounded-[3vmin] bg-emerald-500/[0.06] p-[2.5vmin]">
            <h2 className="mb-[2vmin] text-[4.5vmin] font-black text-emerald-300">מוכן לאיסוף</h2>
            <Numbers list={board?.ready ?? []} tone="ready" flashing={flashSet} />
          </section>
        </main>
      )}
      {announce.length > 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55">
          <div className="r2m-board-flash rounded-[4vmin] bg-emerald-500 px-[8vmin] py-[5vmin] text-center shadow-2xl">
            <div className="text-[4vmin] font-bold text-emerald-950">ההזמנה מוכנה</div>
            <div className="text-[16vmin] font-black leading-none text-white tabular-nums" dir="ltr">
              {announce.slice(0, 3).join(' · ')}
            </div>
          </div>
        </div>
      ) : null}
      {tech ? <RoleTechnician shellView={shellView} onClose={() => setTech(false)} /> : null}
    </div>
  );
}
