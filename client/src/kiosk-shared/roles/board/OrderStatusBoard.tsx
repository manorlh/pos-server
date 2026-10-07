/**
 * "מסך מוכן / לא מוכן" — the order status board for customers: big pickup numbers, in
 * preparation and ready. A number that turns ready flashes, is announced across the screen for a
 * moment and chimes. Without internet the last board stays up, with a note.
 *
 * Its look is the board's own (`BoardView.display`, set on the dashboard's KDS page for the pickup
 * screen — pickupBoard.ts `boardDisplayOf`): a theme (dark / light / high contrast / brand), an
 * accent colour for the ready column, a title, the "בהכנה" column on or off, the chime on or off.
 *
 * Numbers only (the cloud's pickup payload has no names, phones or notes). Not a till. Shared by the
 * Windows app and the browser board (`/board`) — see roles/bridge.ts for the rule.
 */

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { columnFit, DEFAULT_BOARD_DISPLAY, newlyReady, textOn } from '@/lib/pickupBoard';
import type { BoardDisplay, BoardNumber, BoardThemeName, BoardView } from '@/lib/kdsScreenTypes';
import { playNotes } from '../audio';
import type { RoleScreenBridge } from '../bridge';

/** A short two-note chime, made here (no sound file, no network). */
function chime() {
  playNotes([
    { freq: 880, at: 0, len: 0.6, gain: 0.35 },
    { freq: 1318.5, at: 0.18, len: 0.6, gain: 0.35 },
  ]);
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

/* ------------------------------------------------------------------- the themes */

interface Palette {
  bg: string;
  text: string;
  muted: string;
  prepPanel: string;
  prepTitle: string;
  prepChip: string;
  prepChipText: string;
  readyPanel: string;
  readyTitle: string;
  readyChip: string;
  readyChipText: string;
  ring: string;
  announce: string;
  announceText: string;
  announceSub: string;
  note: string;
  noteText: string;
  panelBorder: string;
}

export const BOARD_PALETTES: Record<BoardThemeName, Palette> = {
  dark: {
    bg: '#0d1016',
    text: '#ffffff',
    muted: 'rgba(255,255,255,0.7)',
    prepPanel: 'rgba(255,255,255,0.04)',
    prepTitle: '#fcd34d',
    prepChip: 'rgba(255,255,255,0.05)',
    prepChipText: 'rgba(253,230,138,0.92)',
    readyPanel: 'rgba(16,185,129,0.06)',
    readyTitle: '#6ee7b7',
    readyChip: 'rgba(16,185,129,0.15)',
    readyChipText: '#6ee7b7',
    ring: '#6ee7b7',
    announce: '#10b981',
    announceText: '#ffffff',
    announceSub: '#022c22',
    note: 'rgba(245,158,11,0.15)',
    noteText: '#fde68a',
    panelBorder: 'transparent',
  },
  light: {
    bg: '#f1f5f9',
    text: '#0f172a',
    muted: '#475569',
    prepPanel: '#ffffff',
    prepTitle: '#b45309',
    prepChip: '#fef3c7',
    prepChipText: '#78350f',
    readyPanel: '#ecfdf5',
    readyTitle: '#047857',
    readyChip: '#059669',
    readyChipText: '#ffffff',
    ring: '#047857',
    announce: '#059669',
    announceText: '#ffffff',
    announceSub: '#d1fae5',
    note: '#fef3c7',
    noteText: '#78350f',
    panelBorder: '#e2e8f0',
  },
  contrast: {
    bg: '#000000',
    text: '#ffffff',
    muted: '#ffffff',
    prepPanel: '#000000',
    prepTitle: '#ffff00',
    prepChip: '#1f1f1f',
    prepChipText: '#ffffff',
    readyPanel: '#000000',
    readyTitle: '#00ff66',
    readyChip: '#00e05a',
    readyChipText: '#000000',
    ring: '#ffff00',
    announce: '#ffff00',
    announceText: '#000000',
    announceSub: '#000000',
    note: '#ffff00',
    noteText: '#000000',
    panelBorder: '#ffffff',
  },
  brand: {
    bg: '#0b1220',
    text: '#ffffff',
    muted: 'rgba(255,255,255,0.7)',
    prepPanel: 'rgba(255,255,255,0.05)',
    prepTitle: '#cbd5e1',
    prepChip: 'rgba(255,255,255,0.07)',
    prepChipText: '#e2e8f0',
    readyPanel: 'rgba(37,99,235,0.12)',
    readyTitle: '#93c5fd',
    readyChip: '#2563eb',
    readyChipText: '#ffffff',
    ring: '#93c5fd',
    announce: '#2563eb',
    announceText: '#ffffff',
    announceSub: '#dbeafe',
    note: 'rgba(245,158,11,0.18)',
    noteText: '#fde68a',
    panelBorder: 'transparent',
  },
};

/** The theme's colours, the accent (when set) on the ready column and the announcement. */
export function boardPalette(display: BoardDisplay): Palette {
  const base = BOARD_PALETTES[display.theme] ?? BOARD_PALETTES.dark;
  if (!display.accent) return base;
  const on = textOn(display.accent);
  return {
    ...base,
    readyTitle: display.accent,
    readyChip: display.accent,
    readyChipText: on,
    ring: display.accent,
    announce: display.accent,
    announceText: on,
    announceSub: on,
  };
}

const SIZE = { xl: '9vmin', lg: '7vmin', md: '5vmin' } as const;

function Numbers({ list, tone, flashing, palette, wide }: { list: BoardNumber[]; tone: 'prep' | 'ready'; flashing: Set<string>; palette: Palette; wide: boolean }) {
  const fit = columnFit(list.length);
  const cols = wide ? Math.min(fit.cols + 2, 6) : fit.cols;
  return (
    <div className="grid content-start gap-[1.5vmin]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {list.map((n) => {
        const flash = flashing.has(n.number);
        const style: CSSProperties = {
          fontSize: SIZE[fit.size],
          background: tone === 'ready' ? palette.readyChip : palette.prepChip,
          color: tone === 'ready' ? palette.readyChipText : palette.prepChipText,
          boxShadow: flash ? `0 0 0 0.6vmin ${palette.ring}` : undefined,
        };
        return (
          <div
            key={n.number}
            className={['rounded-[2vmin] py-[1.2vmin] text-center font-black tabular-nums leading-none transition-colors', flash ? 'r2m-board-flash' : ''].join(' ')}
            style={style}
            dir="ltr"
          >
            {n.number}
          </div>
        );
      })}
    </div>
  );
}

export interface OrderStatusBoardProps {
  bridge: RoleScreenBridge;
  /** The host's name for the shop, until the cloud's board says it. */
  shopName?: string | null;
  /** Every touch on the screen (the host's hidden corner). */
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  /** Drawn over the screen (the host's technician / staff sheet). */
  overlay?: ReactNode;
  /** The look, over the cloud's (a demo's `?theme=`); null = the board's own. */
  display?: BoardDisplay | null;
  /** In the header, next to the clock (the browser's "הקישו להפעלת צליל"). */
  headerExtra?: ReactNode;
}

export function OrderStatusBoard({ bridge, shopName = null, onPointerDown, overlay = null, display: forced = null, headerExtra = null }: OrderStatusBoardProps) {
  const [board, setBoard] = useState<BoardView | null>(null);
  const [flashing, setFlashing] = useState<Map<string, number>>(new Map());
  const [announce, setAnnounce] = useState<string[]>([]);
  const prevReady = useRef<BoardNumber[] | null>(null);
  const soundOn = useRef(true);
  const clock = useClock();
  const display = forced ?? board?.display ?? DEFAULT_BOARD_DISPLAY;
  useEffect(() => {
    soundOn.current = display.sound;
  }, [display.sound]);

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
        if (soundOn.current) chime();
      }
    };
    void bridge.board().then((b) => b && take(b));
    return bridge.on('board', take);
  }, [bridge]);

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

  const palette = boardPalette(display);
  const flashSet = new Set(flashing.keys());
  const updated = board?.updatedAt ? new Date(board.updatedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : null;
  const panel = (bg: string): CSSProperties => ({ background: bg, border: `0.3vmin solid ${palette.panelBorder}` });
  return (
    <div
      dir="rtl"
      className="relative flex h-dvh w-full select-none flex-col overflow-hidden"
      style={{ background: palette.bg, color: palette.text }}
      onPointerDown={(e) => {
        bridge.activity();
        onPointerDown?.(e);
      }}
    >
      <style>{`@keyframes r2mFlash{0%,100%{transform:scale(1)}50%{transform:scale(1.08);filter:brightness(1.25)}}.r2m-board-flash{animation:r2mFlash 1s ease-in-out infinite}@media (prefers-reduced-motion: reduce){.r2m-board-flash{animation:none}}`}</style>
      <header className="flex items-center justify-between gap-[2vmin] px-[3vmin] py-[2vmin]">
        <div className="truncate text-[3.2vmin] font-extrabold">{display.title ?? board?.shopName ?? shopName ?? ''}</div>
        <div className="flex shrink-0 items-center gap-[2vmin]">
          {headerExtra}
          <div className="text-[3.2vmin] font-bold tabular-nums" style={{ color: palette.muted }}>
            {clock}
          </div>
        </div>
      </header>
      {board?.offline ? (
        <div className="mx-[3vmin] mb-[1.5vmin] rounded-xl px-4 py-2 text-center text-[2.2vmin] font-semibold" style={{ background: palette.note, color: palette.noteText }}>
          אין חיבור — מוצג המידע האחרון{updated ? ` (עודכן ${updated})` : ''}
        </div>
      ) : null}
      {board?.notConfigured ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-[4vmin] font-extrabold">המסך עוד לא הוגדר כמסך מוכן / לא מוכן</div>
          <div className="max-w-[70vmin] text-[2.4vmin]" style={{ color: palette.muted }}>
            בדשבורד: הוספת מכשיר מסוג &quot;מסך מוכן / לא מוכן&quot; בסניף, או בעמוד מסכי המטבח — מסך איסוף.
          </div>
        </div>
      ) : (
        <main className={`grid min-h-0 flex-1 gap-[2vmin] px-[3vmin] pb-[3vmin] ${display.showPreparing ? 'grid-cols-[2fr_3fr]' : 'grid-cols-1'}`}>
          {display.showPreparing ? (
            <section className="flex min-h-0 flex-col overflow-hidden rounded-[3vmin] p-[2.5vmin]" style={panel(palette.prepPanel)}>
              <h2 className="mb-[2vmin] text-[4.5vmin] font-black" style={{ color: palette.prepTitle }}>
                בהכנה
              </h2>
              <Numbers list={board?.preparing ?? []} tone="prep" flashing={flashSet} palette={palette} wide={false} />
            </section>
          ) : null}
          <section className="flex min-h-0 flex-col overflow-hidden rounded-[3vmin] p-[2.5vmin]" style={panel(palette.readyPanel)}>
            <h2 className="mb-[2vmin] text-[4.5vmin] font-black" style={{ color: palette.readyTitle }}>
              מוכן לאיסוף
            </h2>
            <Numbers list={board?.ready ?? []} tone="ready" flashing={flashSet} palette={palette} wide={!display.showPreparing} />
          </section>
        </main>
      )}
      {announce.length > 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55">
          <div className="r2m-board-flash rounded-[4vmin] px-[8vmin] py-[5vmin] text-center shadow-2xl" style={{ background: palette.announce }}>
            <div className="text-[4vmin] font-bold" style={{ color: palette.announceSub }}>
              ההזמנה מוכנה
            </div>
            <div className="text-[16vmin] font-black leading-none tabular-nums" style={{ color: palette.announceText }} dir="ltr">
              {announce.slice(0, 3).join(' · ')}
            </div>
          </div>
        </div>
      ) : null}
      {overlay}
    </div>
  );
}
