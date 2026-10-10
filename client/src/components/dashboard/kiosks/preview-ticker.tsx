'use client';

/**
 * "כיתוב רץ" on the web kiosk screens (the dashboard's live preview and the Windows kiosk): a slim
 * strip whose texts, a bullet between them, scroll without end — the till's ui/kiosk/KioskTicker.kt.
 *
 * The strip takes its own row in the screen (under the header, or above the basket / action bar),
 * so it never covers a button. It moves the way it reads (lib/kioskConfig.ts tickerDirection): a
 * Hebrew strip comes in from the left and moves right, an English one the other way. One CSS
 * animation of `transform` on a track of identical loops — the compositor's, no layout per frame —
 * measured once per text (and on a resize). Reduce motion (`general.reduceMotion`, or the
 * device's `prefers-reduced-motion`) stands it still: one text at a time, cut with a fade, the
 * next every few seconds.
 *
 * Shared through `@/kiosk-shared`: only React and `lib/kioskConfig`.
 */

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  TICKER_SIZE_PX,
  TICKER_STATIC_MS,
  textDirection,
  tickerAt,
  tickerColors,
  tickerCopies,
  tickerDirection,
  tickerLoopMs,
  tickerOnScreen,
  tickerScreenOf,
  tickerStaticIndex,
  tickerTextsNow,
  type TickerPosition,
  type TickerSize,
  type TickerSpeed,
} from '@/lib/kioskConfig';
import type { PreviewModel } from './preview-screens';

export const TICKER_CSS = `
@keyframes kioskTickerLtr { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(calc(-1 * var(--k-ticker-loop, 0px)), 0, 0); } }
@keyframes kioskTickerRtl { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(var(--k-ticker-loop, 0px), 0, 0); } }
.kiosk-ticker-track { will-change: transform; }
@media (prefers-reduced-motion: reduce) { .kiosk-ticker-track { animation: none !important; } }
`;

/** How often the strip looks at the clock again (a text's hours begin or end). */
const CLOCK_MS = 30_000;
/**
 * The dashboard's preview ends no screen above its "POWERED BY R2M POS" (the real kiosk does): a
 * strip that is a screen's last row keeps this much room under it there.
 */
export const PREVIEW_FOOTER_PX = 12;
/** The soft edges the texts come in and go out through. */
const EDGE_PX = 18;

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const q = window.matchMedia('(prefers-reduced-motion: reduce)');
  q.addEventListener?.('change', onChange);
  return () => q.removeEventListener?.('change', onChange);
}

/** The device asks for less motion (`prefers-reduced-motion: reduce`). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

/** Now, again every `everyMs` (only while mounted). */
function useClock(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

/** One loop: every text, each followed by its bullet (the last one's leads into the next loop). */
function Loop({ texts, dir, hidden, refEl }: { texts: string[]; dir: 'rtl' | 'ltr'; hidden?: boolean; refEl?: (el: HTMLDivElement | null) => void }) {
  return (
    <div ref={refEl} dir={dir} aria-hidden={hidden || undefined} style={{ display: 'flex', flexShrink: 0, alignItems: 'center' }}>
      {texts.map((t, i) => (
        <Fragment key={i}>
          <span dir="auto">{t}</span>
          <span aria-hidden style={{ paddingInline: '1.1em', opacity: 0.7 }}>
            •
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/** The moving strip: identical loops in a row, the row sliding one loop's width, again and again. */
function ScrollingTexts({ texts, dir, speed, pauseOnTouch }: { texts: string[]; dir: 'rtl' | 'ltr'; speed: TickerSpeed; pauseOnTouch: boolean }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const loopRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ box: 0, loop: 0 });
  const [held, setHeld] = useState(false);
  const key = texts.join('\u0000');

  // Measured once per text (and when the strip or the font changes size) — never per frame.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const loop = loopRef.current;
    if (!box || !loop) return;
    const measure = () =>
      setSize((s) => {
        const next = { box: box.clientWidth, loop: Math.round(loop.getBoundingClientRect().width * 100) / 100 };
        return next.box === s.box && next.loop === s.loop ? s : next;
      });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(loop);
    return () => ro.disconnect();
  }, [key, dir]);

  const copies = tickerCopies(size.box, size.loop);
  const running = size.loop > 0;
  const fade = `linear-gradient(to right, transparent, #000 ${EDGE_PX}px, #000 calc(100% - ${EDGE_PX}px), transparent)`;
  // Inline styles only: the Windows kiosk's Tailwind does not scan this file.
  const track: CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    display: 'flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
    [dir === 'rtl' ? 'right' : 'left']: 0,
    ['--k-ticker-loop' as string]: `${size.loop}px`,
    animation: running ? `${dir === 'rtl' ? 'kioskTickerRtl' : 'kioskTickerLtr'} ${tickerLoopMs(size.loop, speed)}ms linear infinite` : 'none',
    animationPlayState: held ? 'paused' : 'running',
  } as CSSProperties;
  const hold = pauseOnTouch
    ? {
        onPointerDown: () => setHeld(true),
        onPointerUp: () => setHeld(false),
        onPointerCancel: () => setHeld(false),
        onPointerLeave: () => setHeld(false),
      }
    : {};
  return (
    <div ref={boxRef} style={{ position: 'relative', height: '100%', overflow: 'hidden', maskImage: fade, WebkitMaskImage: fade }} {...hold}>
      <div className="kiosk-ticker-track" dir={dir} style={track}>
        {Array.from({ length: copies }, (_, i) => (
          <Loop key={i} texts={texts} dir={dir} hidden={i > 0} refEl={i === 0 ? (el) => { loopRef.current = el; } : undefined} />
        ))}
      </div>
    </div>
  );
}

/** Reduce motion: one text standing still, cut with a fade at its end, the next every few seconds. */
function StillTexts({ texts, dir }: { texts: string[]; dir: 'rtl' | 'ltr' }) {
  const [since] = useState(() => Date.now());
  const now = useClock(texts.length > 1 ? TICKER_STATIC_MS : 3_600_000);
  const text = texts[tickerStaticIndex(texts.length, now - since)] ?? '';
  const d = textDirection(text) ?? dir;
  const fade = `linear-gradient(to ${d === 'rtl' ? 'left' : 'right'}, #000 calc(100% - ${EDGE_PX * 2}px), transparent)`;
  return (
    <div dir={d} style={{ display: 'flex', height: '100%', alignItems: 'center', overflow: 'hidden', paddingInline: 12, maskImage: fade, WebkitMaskImage: fade }}>
      <span style={{ whiteSpace: 'nowrap' }}>{text}</span>
    </div>
  );
}

/**
 * The strip itself, for given texts (the slot passes the ones running now; the dashboard's card its
 * own sample). Nothing when there is nothing to say.
 */
export function KioskTickerStrip({
  texts,
  speed,
  size,
  bg,
  fg,
  still,
  pauseOnTouch = false,
  fallbackDir = 'rtl',
  label,
  className,
}: {
  texts: string[];
  speed: TickerSpeed;
  size: TickerSize;
  bg: string;
  fg: string;
  /** Reduce motion: no scrolling. */
  still: boolean;
  pauseOnTouch?: boolean;
  fallbackDir?: 'rtl' | 'ltr';
  label?: string;
  className?: string;
}) {
  const prefersStill = usePrefersReducedMotion();
  if (texts.length === 0) return null;
  const dims = TICKER_SIZE_PX[size] ?? TICKER_SIZE_PX.m;
  const dir = tickerDirection(texts, fallbackDir);
  return (
    <div
      role="marquee"
      aria-label={label}
      className={className}
      style={{
        height: `calc(${dims.height}px * var(--k-scale, 1))`,
        fontSize: `calc(${dims.font}px * var(--k-scale, 1))`,
        background: bg,
        color: fg,
        fontWeight: 600,
        flexShrink: 0,
        lineHeight: 1.2,
      }}
    >
      <style>{TICKER_CSS}</style>
      {still || prefersStill ? <StillTexts texts={texts} dir={dir} /> : <ScrollingTexts texts={texts} dir={dir} speed={speed} pauseOnTouch={pauseOnTouch} />}
    </div>
  );
}

/**
 * The strip in its place on a screen: shown only when it runs on `screen` at `position` and has a
 * text now. `gapBelow`: px kept free under it (see TickerFrame).
 */
export function TickerSlot({ m, screen, position, gapBelow = 0 }: { m: PreviewModel; screen: string; position: TickerPosition; gapBelow?: number }) {
  const ticker = m.cfg.ticker;
  const on = tickerAt(ticker, screen, position);
  if (!on || !ticker) return null;
  return <LiveTicker m={m} screen={screen} gapBelow={gapBelow} />;
}

function LiveTicker({ m, screen, gapBelow }: { m: PreviewModel; screen: string; gapBelow: number }) {
  const now = useClock(CLOCK_MS);
  const ticker = m.cfg.ticker;
  const texts = tickerTextsNow(ticker, screen, new Date(now));
  if (texts.length === 0) return null;
  const { bg, fg } = tickerColors(ticker, m.c);
  return (
    <div style={{ flexShrink: 0, paddingBottom: gapBelow > 0 ? gapBelow : undefined }}>
      <KioskTickerStrip
        texts={texts}
        speed={ticker.speed}
        size={ticker.size}
        bg={bg}
        fg={fg}
        still={m.cfg.general.reduceMotion}
        pauseOnTouch={ticker.pauseOnTouch}
        label={m.t('tickerLabel')}
      />
    </div>
  );
}

/**
 * The screens that have no header or basket bar of their own to sit by (attract, service, the
 * details / tip step, pay, success): the strip as their first or last row, the screen in the rest.
 * The menu and the basket place it themselves (under the header, above the bar); every other
 * screen passes through untouched. `footerGap`: room kept under a bottom strip for "POWERED BY
 * R2M POS" where the host does not end the screen above it (the full-bleed attract screen).
 */
export function TickerFrame({ m, screen, footerGap = 0, children }: { m: PreviewModel; screen: string; footerGap?: number; children: ReactNode }) {
  const s = tickerScreenOf(screen);
  if (!s || s === 'catalog' || s === 'cart' || !tickerOnScreen(m.cfg.ticker, screen)) return <>{children}</>;
  const top = (m.cfg.ticker.position ?? 'top') === 'top';
  return (
    <div style={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
      {top ? <TickerSlot m={m} screen={screen} position="top" /> : null}
      <div style={{ position: 'relative', minHeight: 0, flex: '1 1 0%' }}>{children}</div>
      {top ? null : <TickerSlot m={m} screen={screen} position="bottom" gapBelow={footerGap} />}
    </div>
  );
}
