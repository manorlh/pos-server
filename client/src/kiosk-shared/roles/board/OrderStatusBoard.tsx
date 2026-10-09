/**
 * "מסך מוכן / לא מוכן" — the order status board for customers: big pickup numbers, in
 * preparation and ready. A number that turns ready flashes, is announced and chimes. Without
 * internet the last board stays up, with a note.
 *
 * Its look is the board's own (`BoardView.display`, set on the dashboard's KDS page for the pickup
 * screen — pickupBoard.ts `boardDisplayOf`, docs/SPEC_KDS.md §13.4.3, §14): a theme (dark / light /
 * high contrast / brand), an accent colour for the ready numbers, a title, the "בהכנה" numbers on or
 * off, the chime on or off, and the layout:
 *
 *  - "columns"   — "בהכנה" and "מוכן לאיסוף" side by side (the board as it always was);
 *  - "spotlight" — the newest ready number huge, the other ready numbers and "בהכנה" beside it;
 *  - "grid"      — numbers only, one grid that fills the screen (a TV across the room);
 *  - "split"     — the numbers beside a media panel (pictures / videos, or the promo text);
 *  - "ticker"    — the media full screen, the ready numbers in a bar along the bottom.
 *
 * Numbers only (the cloud's pickup payload has no names, phones or notes). Not a till. Shared by the
 * Windows app and the browser board (`/board`) — see roles/bridge.ts for the rule.
 */

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { columnFit, DEFAULT_BOARD_DISPLAY, gridFit, newestFirst, newlyReady, textOn } from '@/lib/pickupBoard';
import type { BoardDisplay, BoardMedia, BoardNumber, BoardThemeName, BoardView } from '@/lib/kdsScreenTypes';
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
  /** The bars of the media layouts (header, ticker's preparing line). */
  bar: string;
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
    bar: '#12161d',
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
    bar: '#ffffff',
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
    bar: '#000000',
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
    bar: '#0f1a2e',
  },
};

/** The theme's colours, the accent (when set) on the ready numbers and the announcement. */
export function boardPalette(display: Pick<BoardDisplay, 'theme' | 'accent'>): Palette {
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

function Numbers({
  list,
  tone,
  flashing,
  palette,
  wide,
  scale = 1,
}: {
  list: BoardNumber[];
  tone: 'prep' | 'ready';
  flashing: Set<string>;
  palette: Palette;
  wide: boolean;
  scale?: number;
}) {
  const fit = columnFit(list.length);
  const cols = wide ? Math.min(fit.cols + 2, 6) : fit.cols;
  return (
    <div className="grid content-start gap-[1.5vmin]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {list.map((n) => {
        const flash = flashing.has(n.number);
        const style: CSSProperties = {
          fontSize: `calc(${SIZE[fit.size]} * ${scale})`,
          background: tone === 'ready' ? palette.readyChip : palette.prepChip,
          color: tone === 'ready' ? palette.readyChipText : palette.prepChipText,
          boxShadow: flash ? `0 0 0 0.6vmin ${palette.ring}` : undefined,
        };
        return (
          <div
            key={n.number}
            className={['rounded-[1.6vmin] py-[1.2vmin] text-center font-black tabular-nums leading-none transition-colors', flash ? 'r2m-board-flash' : ''].join(' ')}
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

/** The element's content size, live. */
function useBox(): [(el: HTMLElement | null) => void, { w: number; h: number }] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((e) => {
      const r = e[0]?.contentRect;
      if (r) setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, box];
}

/**
 * The numbers as big as the panel allows, every one of them visible (the new layouts' panels): the
 * columns and rows of the biggest tiles that fit (pickupBoard.ts `gridFit`), never bigger than `max` px.
 */
function FitNumbers({ list, tone, flashing, palette, max }: { list: BoardNumber[]; tone: 'prep' | 'ready'; flashing: Set<string>; palette: Palette; max: number }) {
  const [ref, box] = useBox();
  const gap = 12;
  const fit = gridFit(list.length, Math.max(1, box.w), Math.max(1, box.h), 1.4);
  const tileW = (box.w - gap * (fit.cols - 1)) / fit.cols;
  const tileH = Math.min((box.h - gap * (fit.rows - 1)) / fit.rows, tileW / 1.1);
  // The longest number fits its tile (a heavy digit is about 0.62 em wide).
  const longest = Math.max(3, ...list.map((n) => n.number.length));
  const font = Math.max(14, Math.min(max, tileH * 0.6, (tileW * 0.86) / (0.62 * longest)));
  return (
    <div ref={ref} className="min-h-0 flex-1">
      {box.w > 0 ? (
        <div className="grid content-start" style={{ gap, gridTemplateColumns: `repeat(${fit.cols}, minmax(0, 1fr))`, gridAutoRows: Math.max(Math.min(tileH, font * 1.7), 1) }}>
          {list.map((n) => {
            const flash = flashing.has(n.number);
            return (
              <div
                key={n.number}
                dir="ltr"
                className={`flex items-center justify-center rounded-[1.4vmin] font-black tabular-nums leading-none ${flash ? 'r2m-board-flash' : ''}`}
                style={{
                  fontSize: font,
                  background: tone === 'ready' ? palette.readyChip : palette.prepChip,
                  color: tone === 'ready' ? palette.readyChipText : palette.prepChipText,
                  boxShadow: flash ? `0 0 0 0.6vmin ${palette.ring}` : undefined,
                }}
              >
                {n.number}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Pickup numbers in number order (a customer looks for theirs). */
function byNumber(list: readonly BoardNumber[]): BoardNumber[] {
  return [...list].sort((a, b) => a.number.localeCompare(b.number, 'he', { numeric: true }));
}

export interface OrderStatusBoardProps {
  bridge: RoleScreenBridge;
  /** The host's name for the shop, until the cloud's board says it. */
  shopName?: string | null;
  /** Every touch on the screen (the host's hidden corner). */
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  /** Drawn over the screen (the host's technician / staff sheet). */
  overlay?: ReactNode;
  /** The look, over the cloud's (a demo's `?theme=`, the dashboard's live preview); null = the board's own. */
  display?: BoardDisplay | null;
  /** In the header, next to the clock (the browser's "הקישו להפעלת צליל"). */
  headerExtra?: ReactNode;
  /** No sound at all (the dashboard's preview). */
  silent?: boolean;
  /** Fill the parent instead of the window (the dashboard's preview). */
  embedded?: boolean;
}

export function OrderStatusBoard({
  bridge,
  shopName = null,
  onPointerDown,
  overlay = null,
  display: forced = null,
  headerExtra = null,
  silent = false,
  embedded = false,
}: OrderStatusBoardProps) {
  const [board, setBoard] = useState<BoardView | null>(null);
  const [flashing, setFlashing] = useState<Map<string, number>>(new Map());
  const [announce, setAnnounce] = useState<string[]>([]);
  const prevReady = useRef<BoardNumber[] | null>(null);
  const soundOn = useRef(true);
  const clock = useClock();
  const display = forced ?? board?.display ?? DEFAULT_BOARD_DISPLAY;
  useEffect(() => {
    soundOn.current = display.sound && !silent;
  }, [display.sound, silent]);

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
  const title = display.title ?? board?.shopName ?? shopName ?? '';
  const layout = display.boardLayout ?? 'columns';
  const ready = board?.ready ?? [];
  const preparing = board?.preparing ?? [];
  const parts: BoardParts = { palette, display, ready, preparing, flashSet };
  return (
    <div
      dir="rtl"
      className={`relative flex ${embedded ? 'h-full' : 'h-dvh'} w-full select-none flex-col overflow-hidden`}
      style={{ background: palette.bg, color: palette.text }}
      onPointerDown={(e) => {
        bridge.activity();
        onPointerDown?.(e);
      }}
    >
      <style>{`@keyframes r2mFlash{0%,100%{transform:scale(1)}50%{transform:scale(1.08);filter:brightness(1.25)}}.r2m-board-flash{animation:r2mFlash 1s ease-in-out infinite}@keyframes r2mTicker{from{transform:translateX(0)}to{transform:translateX(50%)}}.r2m-ticker{animation:r2mTicker var(--r2m-ticker-s,30s) linear infinite}@media (prefers-reduced-motion: reduce){.r2m-board-flash,.r2m-ticker{animation:none}}`}</style>
      <header className="flex shrink-0 items-center justify-between gap-[2vmin] px-[3vmin] py-[2vmin]" style={layout === 'ticker' || layout === 'split' ? { background: palette.bar } : undefined}>
        <div className="truncate text-[3.2vmin] font-extrabold">{title}</div>
        <div className="flex shrink-0 items-center gap-[2vmin]">
          {headerExtra}
          <div className="text-[3.2vmin] font-bold tabular-nums" style={{ color: palette.muted }}>
            {clock}
          </div>
        </div>
      </header>
      {board?.offline ? (
        <div className="mx-[3vmin] mb-[1.5vmin] shrink-0 rounded-xl px-4 py-2 text-center text-[2.2vmin] font-semibold" style={{ background: palette.note, color: palette.noteText }}>
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
      ) : layout === 'spotlight' ? (
        <SpotlightLayout {...parts} />
      ) : layout === 'grid' ? (
        <GridLayout {...parts} />
      ) : layout === 'split' ? (
        <SplitLayout {...parts} title={title} />
      ) : layout === 'ticker' ? (
        <TickerLayout {...parts} title={title} />
      ) : (
        <ColumnsLayout {...parts} />
      )}
      {announce.length > 0 && layout !== 'spotlight' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55">
          <div className="r2m-board-flash rounded-[3vmin] px-[8vmin] py-[5vmin] text-center shadow-2xl" style={{ background: palette.announce }}>
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

/* ------------------------------------------------------------------ the layouts */

interface BoardParts {
  palette: Palette;
  display: BoardDisplay;
  ready: BoardNumber[];
  preparing: BoardNumber[];
  flashSet: Set<string>;
}

function panelStyle(palette: Palette, bg: string): CSSProperties {
  return { background: bg, border: `0.3vmin solid ${palette.panelBorder}` };
}

function PanelTitle({ children, color }: { children: ReactNode; color: string }) {
  return (
    <h2 className="mb-[2vmin] shrink-0 text-[4.5vmin] font-black leading-none" style={{ color }}>
      {children}
    </h2>
  );
}

/** "שני טורים": the board as it always was. */
function ColumnsLayout({ palette, display, ready, preparing, flashSet }: BoardParts) {
  return (
    <main className={`grid min-h-0 flex-1 gap-[2vmin] px-[3vmin] pb-[3vmin] ${display.showPreparing ? 'grid-cols-[2fr_3fr]' : 'grid-cols-1'}`}>
      {display.showPreparing ? (
        <section className="flex min-h-0 flex-col overflow-hidden rounded-[2vmin] p-[2.5vmin]" style={panelStyle(palette, palette.prepPanel)}>
          <PanelTitle color={palette.prepTitle}>בהכנה</PanelTitle>
          <Numbers list={preparing} tone="prep" flashing={flashSet} palette={palette} wide={false} />
        </section>
      ) : null}
      <section className="flex min-h-0 flex-col overflow-hidden rounded-[2vmin] p-[2.5vmin]" style={panelStyle(palette, palette.readyPanel)}>
        <PanelTitle color={palette.readyTitle}>מוכן לאיסוף</PanelTitle>
        <Numbers list={ready} tone="ready" flashing={flashSet} palette={palette} wide={!display.showPreparing} />
      </section>
    </main>
  );
}

/** "מוכן עכשיו": the newest ready number huge; the other ready numbers and "בהכנה" beside it. */
function SpotlightLayout({ palette, display, ready, preparing, flashSet }: BoardParts) {
  const [newest, ...older] = newestFirst(ready);
  const rest = byNumber(older);
  const flash = newest ? flashSet.has(newest.number) : false;
  return (
    <main className="grid min-h-0 flex-1 grid-cols-[3fr_2fr] gap-[2vmin] px-[3vmin] pb-[3vmin]">
      <section
        className="flex min-h-0 flex-col items-center justify-center rounded-[2vmin] p-[3vmin] text-center"
        style={newest ? { background: palette.announce, color: palette.announceText } : panelStyle(palette, palette.readyPanel)}
      >
        {newest ? (
          <>
            <div className="text-[5vmin] font-extrabold leading-none" style={{ color: palette.announceSub }}>
              מוכן עכשיו
            </div>
            <div className={`mt-[2vmin] text-[34vmin] font-black leading-[0.9] tabular-nums ${flash ? 'r2m-board-flash' : ''}`} dir="ltr">
              {newest.number}
            </div>
            <div className="mt-[2vmin] text-[3.4vmin] font-bold" style={{ color: palette.announceSub }}>
              אפשר לגשת לדלפק
            </div>
          </>
        ) : (
          <div className="text-[4.5vmin] font-bold" style={{ color: palette.muted }}>
            אין הזמנות מוכנות כרגע
          </div>
        )}
      </section>
      <div className="flex min-h-0 flex-col gap-[2vmin]">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[2vmin] p-[2.5vmin]" style={panelStyle(palette, palette.readyPanel)}>
          <PanelTitle color={palette.readyTitle}>מוכנים לאיסוף</PanelTitle>
          {rest.length ? (
            <FitNumbers list={rest} tone="ready" flashing={flashSet} palette={palette} max={96} />
          ) : (
            <div className="text-[3vmin]" style={{ color: palette.muted }}>
              —
            </div>
          )}
        </section>
        {display.showPreparing ? (
          <section className="flex h-[42%] min-h-0 flex-col overflow-hidden rounded-[2vmin] p-[2.5vmin]" style={panelStyle(palette, palette.prepPanel)}>
            <PanelTitle color={palette.prepTitle}>בהכנה</PanelTitle>
            <FitNumbers list={byNumber(preparing)} tone="prep" flashing={flashSet} palette={palette} max={64} />
          </section>
        ) : null}
      </div>
    </main>
  );
}

/** "רשת מספרים": numbers only, one grid that fills the screen; ready in the accent, "בהכנה" outlined. */
function GridLayout({ palette, display, ready, preparing, flashSet }: BoardParts) {
  // Ready first, then "בהכנה"; each in number order, so a customer finds theirs.
  const shown: Array<BoardNumber & { tone: 'ready' | 'prep' }> = [
    ...byNumber(ready).map((n) => ({ ...n, tone: 'ready' as const })),
    ...(display.showPreparing ? byNumber(preparing).map((n) => ({ ...n, tone: 'prep' as const })) : []),
  ];
  const [setEl, box] = useBox();
  const fit = gridFit(shown.length, Math.max(16, box.w), Math.max(9, box.h));
  const tileH = box.h / fit.rows;
  const tileW = box.w / fit.cols;
  const font = Math.max(16, Math.min(tileH * 0.55, tileW * 0.34));
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-[1.5vmin] px-[3vmin] pb-[3vmin]">
      <div className="flex shrink-0 items-center gap-[3vmin] text-[2.6vmin] font-bold">
        <span className="flex items-center gap-[1vmin]">
          <span className="inline-block h-[2.4vmin] w-[2.4vmin] rounded-[0.4vmin]" style={{ background: palette.readyChip }} /> מוכן לאיסוף
        </span>
        {display.showPreparing ? (
          <span className="flex items-center gap-[1vmin]" style={{ color: palette.muted }}>
            <span className="inline-block h-[2.4vmin] w-[2.4vmin] rounded-[0.4vmin]" style={{ border: `0.4vmin solid ${palette.prepChipText}` }} /> בהכנה
          </span>
        ) : null}
      </div>
      <div ref={setEl} className="min-h-0 flex-1">
        {shown.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[4vmin] font-bold" style={{ color: palette.muted }}>
            אין הזמנות כרגע
          </div>
        ) : (
          <div className="grid h-full gap-[1.2vmin]" style={{ gridTemplateColumns: `repeat(${fit.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${fit.rows}, minmax(0, 1fr))` }}>
            {shown.map((n) => {
              const flash = flashSet.has(n.number);
              return (
                <div
                  key={`${n.tone}:${n.number}`}
                  dir="ltr"
                  className={`flex items-center justify-center rounded-[1.4vmin] font-black tabular-nums leading-none ${flash ? 'r2m-board-flash' : ''}`}
                  style={
                    n.tone === 'ready'
                      ? { background: palette.readyChip, color: palette.readyChipText, fontSize: font, boxShadow: flash ? `0 0 0 0.6vmin ${palette.ring}` : undefined }
                      : { border: `0.4vmin solid ${palette.prepChipText}`, color: palette.prepChipText, fontSize: font * 0.8 }
                  }
                >
                  {n.number}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

/** "מספרים ומדיה": the numbers on the start side, the media panel beside them. */
function SplitLayout({ palette, display, ready, preparing, flashSet, title }: BoardParts & { title: string }) {
  return (
    <main className="grid min-h-0 flex-1 grid-cols-[2fr_3fr] gap-[2vmin] p-[3vmin] pt-[2vmin]">
      <div className="flex min-h-0 flex-col gap-[2vmin]">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[2vmin] p-[2.5vmin]" style={panelStyle(palette, palette.readyPanel)}>
          <PanelTitle color={palette.readyTitle}>מוכן לאיסוף</PanelTitle>
          <FitNumbers list={byNumber(ready)} tone="ready" flashing={flashSet} palette={palette} max={110} />
        </section>
        {display.showPreparing ? (
          <section className="flex h-[38%] min-h-0 flex-col overflow-hidden rounded-[2vmin] p-[2.5vmin]" style={panelStyle(palette, palette.prepPanel)}>
            <PanelTitle color={palette.prepTitle}>בהכנה</PanelTitle>
            <FitNumbers list={byNumber(preparing)} tone="prep" flashing={flashSet} palette={palette} max={64} />
          </section>
        ) : null}
      </div>
      <MediaPanel media={display.media} palette={palette} promo={display.promoText ?? title} className="rounded-[2vmin]" />
    </main>
  );
}

/** "פס מספרים על מדיה": the media full width, the ready numbers in a bar along the bottom. */
function TickerLayout({ palette, display, ready, preparing, flashSet, title }: BoardParts & { title: string }) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <MediaPanel media={display.media} palette={palette} promo={display.promoText ?? title} className="min-h-0 flex-1" />
      {display.showPreparing && preparing.length > 0 ? (
        <div className="flex shrink-0 items-center gap-[2vmin] overflow-hidden px-[3vmin] py-[1.2vmin]" style={{ background: palette.bar, color: palette.prepChipText }}>
          <span className="shrink-0 text-[2.8vmin] font-black" style={{ color: palette.prepTitle }}>
            בהכנה
          </span>
          <span className="truncate text-[3vmin] font-bold tabular-nums" dir="ltr">
            {preparing.map((n) => n.number).join('   ')}
          </span>
        </div>
      ) : null}
      <TickerBar ready={ready} palette={palette} flashSet={flashSet} />
    </main>
  );
}

function TickerBar({ ready, palette, flashSet }: { ready: BoardNumber[]; palette: Palette; flashSet: Set<string> }) {
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [strip, setStrip] = useState<HTMLElement | null>(null);
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    if (!box || !strip) return;
    const check = () => setMoving(strip.scrollWidth > box.clientWidth + 4);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(box);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [box, strip, ready]);
  const chips = (copy: number) =>
    ready.map((n) => (
      <span
        key={`${copy}:${n.number}`}
        dir="ltr"
        className={`shrink-0 rounded-[1.2vmin] px-[2.2vmin] py-[0.6vmin] text-[8vmin] font-black leading-none tabular-nums ${flashSet.has(n.number) ? 'r2m-board-flash' : ''}`}
        style={{ background: palette.announceText, color: palette.announce }}
      >
        {n.number}
      </span>
    ));
  return (
    <div className="flex h-[17vh] shrink-0 items-center gap-[3vmin] overflow-hidden px-[3vmin]" style={{ background: palette.announce, color: palette.announceText }}>
      <span className="shrink-0 text-[4.2vmin] font-black leading-none">מוכן לאיסוף</span>
      <div ref={setBox} className="relative min-w-0 flex-1 overflow-hidden">
        {ready.length === 0 ? (
          <span className="text-[3.4vmin] font-bold" style={{ color: palette.announceSub }}>
            אין הזמנות מוכנות כרגע
          </span>
        ) : (
          <div ref={setStrip} className={`flex w-max gap-[2vmin] ${moving ? 'r2m-ticker' : ''}`} style={{ '--r2m-ticker-s': `${Math.max(12, ready.length * 3)}s` } as CSSProperties}>
            {chips(0)}
            {moving ? chips(1) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The media panel: the pictures and videos in turn (a picture for its seconds, a video to its end),
 * muted, looping; a file that cannot be shown is skipped. None (or none that loads) — the promo
 * text, large, on the accent.
 */
export function MediaPanel({ media, palette, promo, className = '' }: { media: BoardMedia[]; palette: Palette; promo: string; className?: string }) {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const playable = media.filter((m) => !failed.has(m.url));
  const current = playable.length ? playable[index % playable.length] : null;
  const next = () => setIndex((i) => i + 1);
  useEffect(() => {
    if (!current || current.kind === 'video' || playable.length < 2) return;
    const t = setTimeout(next, Math.max(3, current.durationSec) * 1000);
    return () => clearTimeout(t);
  }, [current, playable.length]);
  const fail = (url: string) => setFailed((s) => new Set(s).add(url));
  if (!current) {
    return (
      <section className={`flex min-h-0 items-center justify-center overflow-hidden p-[5vmin] text-center ${className}`} style={{ background: palette.announce, color: palette.announceText }}>
        <div className="max-w-[90%] text-[7vmin] font-black leading-tight">{promo}</div>
      </section>
    );
  }
  return (
    <section className={`relative min-h-0 overflow-hidden bg-black ${className}`}>
      {current.kind === 'video' ? (
        <video
          key={current.url}
          src={current.url}
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          playsInline
          loop={playable.length === 1}
          onEnded={next}
          onError={() => fail(current.url)}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a remote or local file of any size; Next's image optimizer is not for a screen
        <img key={current.url} src={current.url} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => fail(current.url)} />
      )}
    </section>
  );
}
