'use client';

/**
 * The kiosk's screens, drawn from the edited config for the live preview: Wolt-like
 * cards, iOS-soft surfaces, RTL. Every colour, radius, font, size, weight and text comes
 * from the config through `PreviewModel`, so a change in the editor shows here at once.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleHelp,
  CreditCard,
  Languages,
  Minus,
  Plus,
  Search,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Trash2,
  UtensilsCrossed,
  WifiOff,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DIETARY_EMOJI,
  MESSAGE_OVERLAY_MS,
  ctaAnimation,
  ctaBounceLift,
  ctaFontSp,
  ctaRadiusPx,
  attractSpans,
  ctaHintShown,
  ctaSubtitleSp,
  fittingCount,
  CTA_HINT_GAP,
  pickupLabel,
  addFrame,
  addMs,
  type AddPath,
  type CtaBox,
  type DietaryTag,
  type KioskConfig,
  type KioskCta,
  type KioskMessage,
  type KioskTextKey,
  type MediaRef,
  type MessageScreen,
  type MotionSpec,
  type ResolvedThemeColors,
} from '@/lib/kioskConfig';
import type { LivePayPhase, PreviewScreen } from '@/kiosk-shared/types';

/* ----------------------------------------------------------------- model */

export interface PProduct {
  id: string;
  name: string;
  price: number;
  imageUrl: string | null;
  soldOut: boolean;
  description: string | null;
  categoryId: string | null;
  dietaryTags: DietaryTag[];
  /** The real kiosk: a bigger picture for the product sheet (imageUrl is the card's). */
  imageLarge?: string | null;
  /**
   * What its "+" does (kioskAddPath): 'direct' — straight into the cart with the pop-and-fly;
   * otherwise, or unknown, its window opens, as a tap on the card does.
   */
  addPath?: AddPath;
}

export interface PCategory {
  id: string;
  name: string;
  /** The rail / strip picture (`categoryRailImage`), or null for an initial. */
  imageUrl: string | null;
  products: PProduct[];
}

export interface POption {
  id: string;
  name: string;
  price: number;
}

export interface PGroup {
  id: string;
  name: string;
  min: number;
  max: number | null;
  options: POption[];
}

export interface PLine {
  key: string;
  product: PProduct;
  qty: number;
  unit: number;
  extras: string[];
  /** The options picked, as the real kiosk writes them on the document (the preview ignores them). */
  options?: Array<{ groupId: string; optionId: string; name: string; price: number }>;
  /** The free note typed for the kitchen (real kiosk). */
  note?: string;
}

/**
 * What the real kiosk (kiosk-desktop) adds over the preview when it drives these screens.
 * Absent in the dashboard's preview, which then draws exactly as before.
 */
export interface KioskLive {
  /** The header's back button (the till's KioskHeader). */
  back?: () => void;
  /** "התחלה מחדש" in the menu's header. */
  startOver?: () => void;
  /** The pay screen's real state, from the terminal. */
  pay?: {
    phase: LivePayPhase;
    /** The status line under the instruction (the terminal's progress, or why it is blocked). */
    message: string | null;
    amount: number;
    canCancel: boolean;
    cancelling: boolean;
    onCancel: () => void;
    onRetry: () => void;
    onBack: () => void;
  };
  /** The success screen's real order. */
  success?: {
    pickupLabel: string;
    paid: number;
    /** ask: the question is shown; the rest say what happened to the receipt. */
    receipt: 'ask' | 'printing' | 'printed' | 'declined' | 'none' | 'failed';
    onReceipt: (print: boolean) => void;
    secondsLeft: number;
    onNewOrder: () => void;
  };
  /** The product sheet's free note as a real field (the kiosk's own keyboard). */
  noteField?: (value: string, onChange: (v: string) => void) => ReactNode;
  /** Hide the customer fields on the cart: the real kiosk asks them on their own screen. */
  detailsScreen?: boolean;
  /** "עזרה" on the attract screen calls the staff (a help request to the tills). */
  help?: () => void;
}

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface PreviewModel {
  cfg: KioskConfig;
  c: ResolvedThemeColors;
  radius: number;
  btnRadius: number;
  wide: boolean;
  cols: number;
  ratio: string;
  font: string;
  txt: (key: KioskTextKey) => string;
  t: Translate;
  money: (shekels: number) => string;
  categories: PCategory[];
  featured: PProduct[];
  logoUrl: string | null;
  brandName: string;
  nowMs: number;
  go: (screen: PreviewScreen) => void;
  openProduct: (p: PProduct) => void;
  /** The card's "+" on a dish with nothing to choose (addPath 'direct'): one more in the cart, flying from `from`. */
  quickAdd?: (p: PProduct, from: DOMRect | null) => void;
  /** A category the customer chose on the rail or the strip (not one the list scrolled into): "כניסה למחלקה". */
  onCategoryPicked?: (id: string) => void;
  cart: PLine[];
  setCart: (lines: PLine[]) => void;
  service: 'take_away' | 'eat_in';
  setService: (s: 'take_away' | 'eat_in') => void;
  motion: MotionSpec;
  /** The product just added (its + shows a ✓ for a moment). */
  justAddedId: string | null;
  /** Grows on every add: re-keys the count badge so it bounces. */
  cartBump: number;
  /**
   * Registers where the add-to-cart flight lands (the bar's badge or the panel's header) — a
   * callback ref, so the model itself carries no ref object (render never reads one).
   */
  setCartTarget: (el: HTMLDivElement | null) => void;
  /** The side order panel is shown (cartStyle = panel on the wide frame). */
  panel: boolean;
  /** The frame's screen, in px (= dp for the layout rules). */
  screen: { w: number; h: number };
  /** The attract button's box on that screen (ctaBox). */
  ctaBox: CtaBox;
  /** Set by the real kiosk only (see KioskLive). */
  live?: KioskLive;
}

/* --------------------------------------------------------------- helpers */

export function cartTotal(lines: PLine[]): number {
  return lines.reduce((s, l) => s + l.unit * l.qty, 0);
}

export function cartCount(lines: PLine[]): number {
  return lines.reduce((s, l) => s + l.qty, 0);
}

export function messagesFor(cfg: KioskConfig, screen: MessageScreen, kinds: KioskMessage['kind'][], nowMs: number): KioskMessage[] {
  return cfg.messages.filter((m) => {
    if (!m.enabled || !m.screens.includes(screen) || !kinds.includes(m.kind)) return false;
    if (m.startsAt && Date.parse(m.startsAt) > nowMs) return false;
    if (m.endsAt && Date.parse(m.endsAt) <= nowMs) return false;
    return true;
  });
}

const STYLE_COLORS: Record<KioskMessage['style'], { bg: string; fg: string }> = {
  info: { bg: '#E0F2FE', fg: '#075985' },
  promo: { bg: '#FAE8FF', fg: '#86198F' },
  warning: { bg: '#FEF3C7', fg: '#92400E' },
  success: { bg: '#DCFCE7', fg: '#166534' },
};

export function cardStyle(m: PreviewModel): CSSProperties {
  const dark = m.cfg.theme.mode === 'dark';
  switch (m.cfg.theme.cardStyle) {
    case 'outlined':
      return { background: m.c.surface, border: `1px solid ${m.c.border}`, borderRadius: m.radius };
    case 'flat':
      return { background: dark ? '#FFFFFF0D' : '#0000000A', borderRadius: m.radius };
    default:
      return {
        background: m.c.surface,
        borderRadius: m.radius,
        boxShadow: dark ? '0 6px 18px rgba(0,0,0,0.45)' : '0 6px 18px rgba(17,24,39,0.08), 0 1px 3px rgba(17,24,39,0.06)',
      };
  }
}

function buttonStyle(m: PreviewModel, variant: 'primary' | 'soft' = 'primary'): CSSProperties {
  if (variant === 'soft') {
    return { background: `${m.c.button}1A`, color: m.c.button, borderRadius: m.btnRadius };
  }
  return { background: m.c.button, color: m.c.buttonText, borderRadius: m.btnRadius };
}

function Img({ src, className, style, alt = '' }: { src: string; className?: string; style?: CSSProperties; alt?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} style={style} draggable={false} />;
}

function MediaView({ media, className, style, muted = true, loop = true, onEnded }: {
  media: MediaRef;
  className?: string;
  style?: CSSProperties;
  muted?: boolean;
  loop?: boolean;
  onEnded?: () => void;
}) {
  if (media.kind === 'video') {
    return (
      <video
        key={media.url}
        src={media.url}
        className={className}
        style={style}
        muted={muted}
        autoPlay
        loop={loop}
        playsInline
        onEnded={onEnded}
      />
    );
  }
  return <Img src={media.url} className={className} style={style} />;
}

function ProductImage({ m, p, className, style }: { m: PreviewModel; p: PProduct; className?: string; style?: CSSProperties }) {
  if (p.imageUrl) {
    return <Img src={p.imageUrl} className={className} style={{ objectFit: 'cover', ...style }} />;
  }
  return (
    <div
      className={`flex items-center justify-center ${className ?? ''}`}
      style={{ background: `linear-gradient(135deg, ${m.c.primary}22, ${m.c.accent}22)`, ...style }}
    >
      <UtensilsCrossed style={{ color: m.c.primary, opacity: 0.55 }} className="h-1/3 w-1/3" />
    </div>
  );
}

/** A category's picture, or its initial on the theme colour. */
function CategoryImage({ m, cat, size, radius }: { m: PreviewModel; cat: PCategory; size: number; radius: number }) {
  const box: CSSProperties = { width: size, height: size, borderRadius: radius };
  if (cat.imageUrl) return <Img src={cat.imageUrl} className="shrink-0 object-cover" style={box} />;
  return (
    <span
      className="flex shrink-0 items-center justify-center font-bold"
      style={{ ...box, background: m.c.primary, color: m.c.buttonText, fontSize: size * 0.42 }}
    >
      {cat.name.trim().charAt(0)}
    </span>
  );
}

/** A screen's own header image (`screenImages`), when set. */
function ScreenImage({ m, k, height = 96 }: { m: PreviewModel; k: keyof KioskConfig['screenImages']; height?: number }) {
  const ref = m.cfg.screenImages?.[k];
  if (!ref) return null;
  return (
    <div className="w-full overflow-hidden" style={{ borderRadius: m.radius, height }}>
      <Img src={ref.url} className="h-full w-full object-cover" />
    </div>
  );
}

function Logo({ m, size = 44 }: { m: PreviewModel; size?: number }) {
  if (m.logoUrl) {
    return (
      <Img
        src={m.logoUrl}
        className="object-contain"
        style={{ height: size, maxWidth: size * 3, borderRadius: Math.min(m.radius, 12) }}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center font-bold"
      style={{
        height: size,
        width: size,
        borderRadius: Math.min(m.radius, size / 2),
        background: m.c.primary,
        color: m.c.buttonText,
        fontSize: size * 0.42,
      }}
      aria-label={m.t('noLogo')}
    >
      {(m.brandName || 'R').trim().charAt(0)}
    </div>
  );
}

function MessageCard({ m, msg, centered = false }: { m: PreviewModel; msg: KioskMessage; centered?: boolean }) {
  const tone = STYLE_COLORS[msg.style];
  if (centered) {
    return (
      <div className="w-full overflow-hidden text-center" style={{ ...cardStyle(m), background: tone.bg, color: tone.fg }}>
        {msg.image ? <Img src={msg.image.url} className="h-24 w-full object-cover" /> : null}
        <div className="space-y-0.5 p-3">
          <div className="text-sm font-bold leading-snug">{msg.title || m.t('untitledMessage')}</div>
          {msg.body ? <div className="text-xs opacity-80">{msg.body}</div> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-stretch overflow-hidden" style={{ ...cardStyle(m), background: tone.bg, color: tone.fg }}>
      {msg.image ? <Img src={msg.image.url} className="w-20 shrink-0 object-cover" /> : null}
      <div className="min-w-0 flex-1 p-3">
        <div className="text-sm font-bold leading-snug">{msg.title || m.t('untitledMessage')}</div>
        {msg.body ? <div className="mt-0.5 line-clamp-2 text-xs opacity-80">{msg.body}</div> : null}
      </div>
      {msg.kind === 'banner' && msg.productId ? <ChevronRight className="m-2 h-4 w-4 self-center rotate-180 opacity-60" /> : null}
    </div>
  );
}

/** The calm screens' messages: a centred block (inline-center). */
function CenteredMessages({ m, list, className = '' }: { m: PreviewModel; list: KioskMessage[]; className?: string }) {
  if (list.length === 0) return null;
  return (
    <div className={`flex w-full flex-col items-center justify-center gap-2 ${className}`}>
      {list.map((msg) => (
        <MessageCard key={msg.id} m={m} msg={msg} centered />
      ))}
    </div>
  );
}

/**
 * An ordering screen's message (overlay-center): one centred card over a dimmed backdrop,
 * closed by a tap or ✕, hiding itself after MESSAGE_OVERLAY_MS — at most one per visit.
 */
export function MessageOverlay({ m, screen, suppressed }: { m: PreviewModel; screen: MessageScreen; suppressed: boolean }) {
  const msg = messagesFor(m.cfg, screen, ['banner', 'notice'], m.nowMs)[0] ?? null;
  const msgId = msg?.id ?? null;
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!msgId) return;
    const id = window.setTimeout(() => setOpen(false), MESSAGE_OVERLAY_MS);
    return () => window.clearTimeout(id);
  }, [msgId]);
  if (!msg || !open || suppressed) return null;
  const tone = STYLE_COLORS[msg.style];
  const product = msg.kind === 'banner' && msg.productId ? m.categories.flatMap((c) => c.products).find((p) => p.id === msg.productId) : undefined;
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 p-6 animate-in fade-in duration-200"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        className="relative w-full max-w-[85%] overflow-hidden text-center shadow-2xl animate-in zoom-in-95 duration-300"
        style={{ ...cardStyle(m), background: m.c.surface, color: m.c.text }}
      >
        <button
          type="button"
          aria-label={m.t('close')}
          className="absolute end-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white"
          onClick={() => setOpen(false)}
        >
          <X className="h-4 w-4" />
        </button>
        {msg.image ? <Img src={msg.image.url} className="h-28 w-full object-cover" /> : <div className="h-2" style={{ background: tone.fg }} />}
        <div className="space-y-1 p-4">
          <div className="text-lg font-extrabold leading-snug">{msg.title || m.t('untitledMessage')}</div>
          {msg.body ? (
            <div className="text-sm" style={{ color: m.c.mutedText }}>
              {msg.body}
            </div>
          ) : null}
          {product ? (
            <button
              type="button"
              className="mt-2 w-full px-4 py-2.5 text-sm font-bold"
              style={buttonStyle(m)}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                m.openProduct(product);
              }}
            >
              {m.t('openProduct', { name: product.name })}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BigButton({ m, children, onClick, variant = 'primary', className = '', disabledLook = false }: {
  m: PreviewModel;
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  variant?: 'primary' | 'soft';
  className?: string;
  disabledLook?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-center gap-2 px-4 py-3 kt-15 font-bold transition-transform duration-150 active:scale-[0.98] ${disabledLook ? 'opacity-50' : ''} ${className}`}
      style={buttonStyle(m, variant)}
    >
      {children}
    </button>
  );
}

function Stepper({ m, value, onChange, small = false }: { m: PreviewModel; value: number; onChange: (n: number) => void; small?: boolean }) {
  const size = small ? 26 : 34;
  const btn: CSSProperties = { width: size, height: size, borderRadius: 999, background: `${m.c.button}1A`, color: m.c.button };
  return (
    <div className="flex items-center gap-2.5">
      <button type="button" style={btn} className="flex items-center justify-center" onClick={() => onChange(value - 1)}>
        {value <= 1 && small ? <Trash2 className="h-3.5 w-3.5" /> : <Minus className="h-4 w-4" />}
      </button>
      <span className="min-w-4 text-center text-sm font-bold tabular-nums">{value}</span>
      <button type="button" style={btn} className="flex items-center justify-center" onClick={() => onChange(value + 1)}>
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

/** A money amount that counts up to its new value (instantly with no motion). */
function CountUp({ value, ms, format }: { value: number; ms: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    if (ms <= 0) return;
    const from = shownRef.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const v = from + (value - from) * (1 - Math.pow(1 - k, 3));
      shownRef.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{format(ms > 0 ? Math.round(shown * 100) / 100 : value)}</>;
}

/** The scrolling body of a screen, with an optional sticky bottom area. */
function ScreenBody({ children, footer, m }: { children: ReactNode; footer?: ReactNode; m: PreviewModel }) {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">{children}</div>
      {footer ? (
        <div className="shrink-0 p-3" style={{ background: `linear-gradient(to top, ${m.c.background}, ${m.c.background}00)` }}>
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/** Small emoji chips of a product's dietary marks (gluten-free also in words). */
function DietaryChips({ m, tags }: { m: PreviewModel; tags: DietaryTag[] }) {
  if (!m.cfg.general.showDietary || tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-0.5">
      {tags.map((tag) => (
        <span
          key={tag}
          title={m.t(`diet.${tag}`)}
          className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px kt-10 leading-tight"
          style={{ background: m.cfg.theme.mode === 'dark' ? '#FFFFFF14' : '#0000000A' }}
        >
          <span aria-hidden>{DIETARY_EMOJI[tag]}</span>
          {tag === 'gluten_free' ? <span>{m.t('diet.gluten_free')}</span> : null}
        </span>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- attract */

/** The attract playlist; `fill`: behind the whole screen, as the till draws its hero. */
function PlaylistHero({ m, fill = false }: { m: PreviewModel; fill?: boolean }) {
  const list = m.cfg.attract.playlist;
  const [index, setIndex] = useState(0);
  const i = list.length > 0 ? index % list.length : 0;
  const item = list[i];
  useEffect(() => {
    if (!item || list.length < 2 || item.media.kind === 'video') return;
    const id = window.setTimeout(() => setIndex((x) => x + 1), Math.max(2, item.durationSec) * 1000);
    return () => window.clearTimeout(id);
  }, [item, list.length]);

  const frame = fill ? 'absolute inset-0 overflow-hidden' : 'relative aspect-[4/3] w-full overflow-hidden';
  if (!item) {
    return (
      <div
        className={cn(frame, 'flex items-center justify-center')}
        style={{ borderRadius: fill ? 0 : m.radius, background: `linear-gradient(135deg, ${m.c.primary}, ${m.c.accent})` }}
      >
        <div className="absolute -start-10 -top-10 h-40 w-40 rounded-full bg-white/15 blur-2xl" />
        <div className="absolute -bottom-12 -end-8 h-44 w-44 rounded-full bg-black/10 blur-2xl" />
        {fill ? null : <Logo m={m} size={64} />}
      </div>
    );
  }
  return (
    <div className={cn(frame, 'bg-black')} style={{ borderRadius: fill ? 0 : m.radius }}>
      <MediaView
        key={`${i}-${item.media.url}`}
        media={item.media}
        className="absolute inset-0 h-full w-full object-cover animate-in fade-in duration-700"
        loop={list.length < 2}
        muted
        onEnded={() => setIndex((x) => x + 1)}
      />
      {list.length > 1 ? (
        <div className="absolute inset-x-0 bottom-2 flex justify-center gap-1">
          {list.map((_, j) => (
            <span key={j} className="h-1.5 rounded-full bg-white/90 transition-all duration-300" style={{ width: j === i ? 16 : 6, opacity: j === i ? 1 : 0.5 }} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Where the attract screen starts an order (the service screen, or straight to the menu). */
export function attractNext(m: PreviewModel): void {
  m.go(m.cfg.general.serviceTypes.length > 1 ? 'service' : 'catalog');
}

const CTA_WEIGHT_CSS: Record<KioskCta['fontWeight'], number> = { regular: 400, bold: 700, black: 900 };

/** The bounce's keyframes, sampled from the till's own curve (ctaBounceLift). */
const CTA_BOUNCE_KEYFRAMES = (() => {
  const steps: string[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i * 0.02;
    steps.push(`${(t * 100).toFixed(0)}% { transform: translateY(${(-14 * ctaBounceLift(t)).toFixed(2)}px); }`);
  }
  steps.push('100% { transform: translateY(0px); }');
  return `@keyframes kioskCtaBounce { ${steps.join(' ')} }`;
})();

/**
 * "כפתור מסך הפתיחה" drawn where the till draws it (ctaBox: physical `left`/`top`, never
 * inline-start), with its colours, corners, border, icon, motion and second line; the
 * "גע במסך כדי להתחיל" hint under it with tap-anywhere. In a custom place it can be dragged
 * (`onMove` gets the new centre in percent).
 */
export function AttractCta({
  m,
  box,
  screen,
  onMove,
}: {
  m: PreviewModel;
  box: CtaBox;
  screen: { w: number; h: number };
  onMove?: (x: number, y: number) => void;
}) {
  const cta = m.cfg.attract.cta;
  const drag = useRef<{ id: number; moved: boolean; sx: number; sy: number } | null>(null);
  const fill = cta.fillColor ?? m.c.button;
  const text = cta.textColor ?? m.c.buttonText;
  const radius = ctaRadiusPx(cta, box.h, m.cfg.theme);
  const fontSp = ctaFontSp(cta, box.h);
  const subtitle = cta.subtitle.trim();
  const animation = ctaAnimation(cta, m.cfg.general);
  const draggable = cta.position === 'custom' && !!onMove;
  const icon =
    cta.icon === 'cart' ? (
      <ShoppingCart style={{ width: fontSp * 1.1, height: fontSp * 1.1 }} />
    ) : cta.icon === 'arrow' ? (
      // Forward in reading order: left in Hebrew.
      <ArrowLeft style={{ width: fontSp * 1.1, height: fontSp * 1.1 }} />
    ) : cta.icon === 'hand' ? (
      <span style={{ fontSize: fontSp * 1.1, lineHeight: 1 }}>👆</span>
    ) : cta.icon === 'star' ? (
      <span style={{ fontSize: fontSp * 1.1, lineHeight: 1 }}>★</span>
    ) : null;

  const moveTo = (e: PointerEvent<HTMLButtonElement>) => {
    const parent = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!parent || !onMove || parent.width <= 0 || parent.height <= 0) return;
    const pct = (v: number) => Math.max(0, Math.min(100, Math.round(v * 100)));
    onMove(pct((e.clientX - parent.left) / parent.width), pct((e.clientY - parent.top) / parent.height));
  };

  return (
    <>
      {animation === 'glow' ? (
        <span
          aria-hidden
          className="kiosk-cta-glow pointer-events-none absolute"
          style={{ left: box.x, top: box.y, width: box.w, height: box.h, borderRadius: radius, background: fill }}
        />
      ) : null}
      <button
        type="button"
        aria-label={m.txt('attractCta')}
        className={cn(
          'absolute z-20 flex items-center justify-center overflow-hidden px-4',
          animation === 'pulse' && 'kiosk-cta-pulse',
          animation === 'bounce' && 'kiosk-cta-bounce',
          draggable && 'cursor-grab touch-none active:cursor-grabbing',
        )}
        style={{
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          background: fill,
          color: text,
          borderRadius: radius,
          border: cta.borderWidth > 0 ? `${cta.borderWidth}px solid ${cta.borderColor ?? text}` : undefined,
          boxShadow: cta.shadow ? '0 10px 24px rgba(0,0,0,0.20), 0 2px 6px rgba(0,0,0,0.12)' : undefined,
          gap: 12,
        }}
        onPointerDown={(e) => {
          if (!draggable) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { id: e.pointerId, moved: false, sx: e.clientX, sy: e.clientY };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
          d.moved = true;
          moveTo(e);
        }}
        onPointerUp={(e) => {
          if (drag.current?.id === e.pointerId) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onClick={(e) => {
          e.stopPropagation();
          const dragged = drag.current?.moved;
          drag.current = null;
          if (!dragged) attractNext(m);
        }}
      >
        {cta.iconPosition === 'start' ? icon : null}
        <span className="flex min-w-0 flex-col items-center leading-tight">
          <span
            className={subtitle ? 'max-w-full truncate' : 'line-clamp-2 text-center'}
            style={{ fontSize: fontSp, fontWeight: CTA_WEIGHT_CSS[cta.fontWeight] ?? 700 }}
          >
            {m.txt('attractCta')}
          </span>
          {subtitle ? (
            <span className="max-w-full truncate opacity-85" style={{ fontSize: ctaSubtitleSp(cta, box.h), fontWeight: 400 }}>
              {subtitle}
            </span>
          ) : null}
        </span>
        {cta.iconPosition === 'end' ? icon : null}
      </button>
      {ctaHintShown(cta, box, screen.h) ? (
        <span
          aria-hidden
          className="pointer-events-none absolute z-20 whitespace-nowrap kt-13 font-medium"
          style={{ left: box.x + box.w / 2, top: box.y + box.h + CTA_HINT_GAP, transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.8)' }}
        >
          {m.t('tapToStart')}
        </span>
      ) : null}
    </>
  );
}

/** Between the stacked title and sections, and from the messages above them (the till's ATTRACT_GAP_DP). */
const ATTRACT_STACK_GAP = 16;

/** The header pills over the hero, as the till draws them (white, dark text). */
const ATTRACT_PILL: CSSProperties = { background: 'rgba(255,255,255,0.92)', color: '#14161A', borderRadius: 9999 };

/** A stacked item the fitting left out: still measured (same width), never drawn or touched. */
const ATTRACT_HIDDEN: CSSProperties = { position: 'absolute', insetInline: 0, top: 0, visibility: 'hidden', pointerEvents: 'none' };

/**
 * The till's AttractStack: in the span [top, bottom], the messages take what the stack leaves;
 * the stack (title first, then the sections) sits at the bottom, and a section that does not fit
 * is left out (fittingCount) — it never slides under the button.
 */
function AttractStack({
  top,
  bottom,
  messages,
  items,
  measureKey,
}: {
  top: number;
  bottom: number;
  messages: ReactNode;
  items: Array<{ key: string; node: ReactNode }>;
  /** Whatever changes the items' heights (texts, sizes): measured again when it changes. */
  measureKey: string;
}) {
  const span = Math.max(0, bottom - top);
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  // How many items show, and their height together (the stack sits on the span's bottom).
  const [fit, setFit] = useState({ keep: items.length, used: 0 });
  const signature = items.map((i) => i.key).join('|');
  const count = items.length;
  // Measured before the browser paints (and again whenever an item's size changes, below).
  useLayoutEffect(() => {
    const next = measureStack(refs.current, count, span);
    if (next.keep !== fit.keep || next.used !== fit.used) setFit(next);
  }, [count, span, fit, signature, measureKey]);
  useEffect(() => {
    const n = signature ? signature.split('|').length : 0;
    const ro = new ResizeObserver(() => {
      const next = measureStack(refs.current, n, span);
      setFit((f) => (f.keep === next.keep && f.used === next.used ? f : next));
    });
    for (let i = 0; i < n; i++) {
      const el = refs.current[i];
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  }, [span, signature]);
  // As on the till: the stack on the bottom, never past it; the messages get what is left
  // above it (less the gap), down to nothing.
  return (
    <div className="absolute inset-x-4 overflow-hidden" style={{ top, height: span }}>
      <div
        className="absolute inset-x-0 top-0 flex items-center justify-center overflow-hidden"
        style={{ bottom: Math.min(span, fit.used + (fit.keep > 0 ? ATTRACT_STACK_GAP : 0)) }}
      >
        {messages}
      </div>
      <div className="absolute inset-x-0 bottom-0 flex flex-col" style={{ rowGap: ATTRACT_STACK_GAP }}>
        {items.map((item, i) => (
          <div
            key={item.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            style={i < fit.keep ? undefined : ATTRACT_HIDDEN}
            aria-hidden={i < fit.keep ? undefined : true}
          >
            {item.node}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The stack's items' heights → how many fit in the span (fittingCount) and their height together. */
function measureStack(els: Array<HTMLDivElement | null>, count: number, span: number): { keep: number; used: number } {
  const heights = Array.from({ length: count }, (_, i) => els[i]?.offsetHeight ?? 0);
  const keep = fittingCount(span, heights, ATTRACT_STACK_GAP, Math.min(1, count));
  const used = heights.slice(0, keep).reduce((a, h) => a + h, 0) + ATTRACT_STACK_GAP * Math.max(0, keep - 1);
  return { keep, used };
}

/** "לקחת / לשבת" on the attract screen: two buttons in the button's place (servicePlacement = attract). */
export function AttractServiceButtons({ m, box, onPick }: { m: PreviewModel; box: CtaBox; onPick: (t: 'take_away' | 'eat_in') => void }) {
  const cta = m.cfg.attract.cta;
  const fill = cta.fillColor ?? m.c.button;
  const text = cta.textColor ?? m.c.buttonText;
  const radius = ctaRadiusPx(cta, box.h, m.cfg.theme);
  const fontSp = ctaFontSp({ ...cta, subtitle: '' }, box.h);
  return (
    <div className="absolute z-20 flex gap-3" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
      {m.cfg.general.serviceTypes.map((t) => (
        <button
          key={t}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPick(t);
          }}
          className="flex flex-1 items-center justify-center px-2"
          style={{
            background: fill,
            color: text,
            borderRadius: radius,
            fontSize: fontSp,
            fontWeight: CTA_WEIGHT_CSS[cta.fontWeight] ?? 700,
            boxShadow: cta.shadow ? '0 10px 24px rgba(0,0,0,0.20), 0 2px 6px rgba(0,0,0,0.12)' : undefined,
          }}
        >
          {m.txt(t === 'take_away' ? 'takeAwayLabel' : 'eatInLabel')}
        </button>
      ))}
    </div>
  );
}

export function AttractScreen({ m }: { m: PreviewModel }) {
  const { cfg } = m;
  const messages = messagesFor(cfg, 'attract', ['banner', 'notice'], m.nowMs);
  const langs = cfg.general.languages;
  const cta = cfg.attract.cta;
  const sections = cfg.attract.sections;
  const next = () => attractNext(m);
  // The phone frame's notch, a 16 px margin and the 44 px logo: where the header ends.
  const notch = m.wide ? 0 : 28;
  const headerBottom = notch + 16 + 44 + 8;
  // Nothing of the content under the button or its hint — the till's KioskCtaLayout.spans,
  // in the frame's coordinates (the button's); this screen starts below the phone's notch.
  const spans = attractSpans(cta, m.ctaBox, m.screen.h, headerBottom);
  const local = (frameY: number) => frameY - notch;
  const promos =
    sections.includes('promos') && messages.length > 0 ? <CenteredMessages m={m} list={messages} /> : null;

  const items: Array<{ key: string; node: ReactNode }> = [
    {
      key: 'title',
      node: (
        <div>
          <h2 className="text-2xl font-extrabold leading-tight text-white">{m.txt('attractTitle')}</h2>
          <p className="mt-1 text-sm text-white/90">{m.txt('attractSubtitle')}</p>
        </div>
      ),
    },
  ];
  for (const s of sections) {
    if (s === 'categories' && m.categories.length > 0) {
      items.push({
        key: s,
        node: (
          <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 [scrollbar-width:none]">
            {m.categories.slice(0, 8).map((cat) => (
              <button
                key={cat.id}
                type="button"
                className="w-20 shrink-0 p-1.5 text-center"
                style={cardStyle(m)}
                onClick={(e) => {
                  e.stopPropagation();
                  next();
                }}
              >
                <div className="mx-auto flex justify-center">
                  <CategoryImage m={m} cat={cat} size={56} radius={Math.max(10, m.radius - 4)} />
                </div>
                <div className="mt-1 truncate kt-11 font-medium">{cat.name}</div>
              </button>
            ))}
          </div>
        ),
      });
    }
    if (s === 'club' && cfg.club.enabled) {
      items.push({
        key: s,
        node: (
          <div className="flex items-center gap-3 p-3" style={cardStyle(m)}>
            <div className="rounded-xl bg-white p-1.5">
              {/^https?:\/\//i.test(cfg.club.joinUrl) ? (
                <QRCodeSVG value={cfg.club.joinUrl} size={64} level="M" />
              ) : (
                <div className="h-16 w-16 rounded bg-neutral-200" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold">{cfg.club.title || m.t('clubTitle')}</div>
              <div className="text-xs" style={{ color: m.c.mutedText }}>
                {cfg.club.body || m.t('clubScan')}
              </div>
            </div>
          </div>
        ),
      });
    }
  }

  return (
    <div className={cn('relative h-full overflow-hidden', cta.tapAnywhere && 'cursor-pointer')} onClick={cta.tapAnywhere ? next : undefined}>
      {/* The hero fills the screen behind everything, as on the till; a veil keeps the text readable. */}
      {sections.includes('hero') ? <PlaylistHero m={m} fill /> : null}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.10), rgba(0,0,0,0) 45%, rgba(0,0,0,0.55))' }}
      />
      <div className="absolute inset-x-4 flex items-center justify-between gap-2" style={{ top: 16, height: 44 }}>
        <Logo m={m} />
        <div className="flex items-center gap-1.5">
          {langs.length > 1 ? (
            <span className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium" style={ATTRACT_PILL}>
              <Languages className="h-3.5 w-3.5" />
              {langs.map((l) => l.toUpperCase()).join(' · ')}
            </span>
          ) : null}
          {cfg.attract.showHelp ? (
            m.live?.help ? (
              <button
                type="button"
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium"
                style={ATTRACT_PILL}
                title={m.txt('helpText')}
                onClick={(e) => {
                  e.stopPropagation();
                  m.live?.help?.();
                }}
              >
                <CircleHelp className="h-3.5 w-3.5" /> {m.t('help')}
              </button>
            ) : (
              <span className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium" style={ATTRACT_PILL} title={m.txt('helpText')}>
                <CircleHelp className="h-3.5 w-3.5" /> {m.t('help')}
              </span>
            )
          ) : null}
        </div>
      </div>
      {!spans.shared ? (
        <div className="absolute inset-x-4 flex items-center justify-center overflow-hidden" style={{ top: local(spans.messagesTop), height: Math.max(0, spans.messagesBottom - spans.messagesTop) }}>
          {promos}
        </div>
      ) : null}
      <AttractStack
        top={local(spans.stackTop)}
        bottom={local(spans.stackBottom)}
        messages={spans.shared ? promos : null}
        items={items}
        measureKey={[m.txt('attractTitle'), m.txt('attractSubtitle'), m.categories.length, cfg.club.title, cfg.club.body, m.screen.w, cfg.theme.typeScale, cfg.theme.font].join('|')}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- service */

/** The real kiosk's back button at a header's start (the till's KioskHeader); nothing in the preview. */
function LiveBack({ m, size = 36 }: { m: PreviewModel; size?: number }) {
  const back = m.live?.back;
  if (!back) return null;
  return (
    <button
      type="button"
      aria-label={m.t('back')}
      onClick={back}
      className="flex shrink-0 items-center justify-center rounded-full transition-transform duration-150 active:scale-95"
      style={{ width: size, height: size, background: `${m.c.button}1A`, color: m.c.button }}
    >
      <ChevronRight className="h-5 w-5" />
    </button>
  );
}

export function ServiceScreen({ m }: { m: PreviewModel }) {
  const { cfg } = m;
  const types = cfg.general.serviceTypes;
  return (
    <ScreenBody m={m}>
      <div className="space-y-4 p-4">
        {m.live?.back ? (
          <div className="flex items-center">
            <LiveBack m={m} />
          </div>
        ) : null}
        <ScreenImage m={m} k="service" height={110} />
        <h2 className="pt-2 text-center text-xl font-extrabold">{m.txt('serviceTitle')}</h2>
        {types.length < 2 ? (
          <p className="rounded-xl px-3 py-2 text-center text-xs" style={{ background: `${m.c.accent}1F`, color: m.c.text }}>
            {m.t('skippedService')}
          </p>
        ) : null}
        <div className={m.wide ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
          {types.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                m.setService(type);
                m.go('catalog');
              }}
              className="flex w-full flex-col items-center gap-3 p-6 transition-transform duration-150 active:scale-[0.98]"
              style={{ ...cardStyle(m), outline: m.service === type ? `2px solid ${m.c.button}` : undefined }}
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full" style={{ background: `${m.c.button}1A`, color: m.c.button }}>
                {type === 'take_away' ? <ShoppingBag className="h-8 w-8" /> : <UtensilsCrossed className="h-8 w-8" />}
              </span>
              <span className="text-lg font-bold">{type === 'take_away' ? m.txt('takeAwayLabel') : m.txt('eatInLabel')}</span>
              {type === 'eat_in' && cfg.general.askTableNumber ? (
                <span className="text-xs" style={{ color: m.c.mutedText }}>
                  {m.t('askTable')}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </ScreenBody>
  );
}

/* ---------------------------------------------------------------- catalog */

function ProductCard({ m, p }: { m: PreviewModel; p: PProduct }) {
  const showDesc = m.cfg.theme.showDescriptions && p.description;
  const large = m.cfg.theme.gridDensity === 'large';
  const added = m.justAddedId === p.id;
  return (
    <button
      type="button"
      disabled={p.soldOut}
      onClick={() => m.openProduct(p)}
      className="group relative flex w-full flex-col overflow-hidden text-start transition-transform duration-150 active:scale-[0.98] disabled:cursor-not-allowed"
      style={cardStyle(m)}
    >
      <div className="relative w-full overflow-hidden" style={{ aspectRatio: m.ratio }}>
        <ProductImage m={m} p={p} className="h-full w-full" style={p.soldOut ? { filter: 'grayscale(1)', opacity: 0.55 } : undefined} />
        {p.soldOut ? (
          <span className="absolute start-2 top-2 rounded-full bg-black/70 px-2 py-0.5 kt-10 font-bold text-white">{m.t('soldOut')}</span>
        ) : (
          <span
            className="absolute bottom-2 end-2 flex h-7 w-7 items-center justify-center shadow-md transition-all duration-200 group-hover:scale-110"
            style={{ ...buttonStyle(m), borderRadius: 999, background: added ? m.c.accent : m.c.button }}
            onClick={(e) => {
              // Nothing to choose: straight in, the picture flying from its card. Anything else
              // goes on to the card, which opens the dish's window.
              if (p.addPath !== 'direct' || !m.quickAdd) return;
              e.stopPropagation();
              m.quickAdd(p, e.currentTarget.parentElement?.getBoundingClientRect() ?? null);
            }}
          >
            {added ? <Check className="h-4 w-4 kiosk-pop" /> : <Plus className="h-4 w-4" />}
          </span>
        )}
      </div>
      <div className={large ? 'space-y-1 p-3' : 'space-y-0.5 p-2'} style={p.soldOut ? { opacity: 0.6 } : undefined}>
        <div className={`line-clamp-2 font-bold leading-snug ${large ? 'text-base' : 'kt-13'}`}>{p.name}</div>
        {showDesc ? (
          <div className="line-clamp-2 kt-11 leading-snug" style={{ color: m.c.mutedText }}>
            {p.description}
          </div>
        ) : null}
        <DietaryChips m={m} tags={p.dietaryTags} />
        <div className="kt-13 font-bold tabular-nums" style={{ color: m.c.primary }}>
          {m.money(p.price)}
        </div>
      </div>
    </button>
  );
}

/** The top strip (categoryLayout = top), styled by categoryStyle. */
function CategoryStrip({ m, active, onPick }: { m: PreviewModel; active: string | null; onPick: (id: string) => void }) {
  const style = m.cfg.theme.categoryStyle;
  if (style === 'images') {
    return (
      <div className="flex gap-2 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
        {m.categories.map((cat) => {
          const on = cat.id === active;
          return (
            <button key={cat.id} type="button" onClick={() => onPick(cat.id)} className="w-16 shrink-0 text-center">
              <div
                className="mx-auto flex w-fit justify-center transition-all duration-200"
                style={{ borderRadius: Math.max(10, m.radius * 0.7), outline: on ? `2px solid ${m.c.button}` : 'none', outlineOffset: 2 }}
              >
                <CategoryImage m={m} cat={cat} size={48} radius={Math.max(10, m.radius * 0.7)} />
              </div>
              <div className="mt-1 truncate kt-10 font-semibold" style={{ color: on ? m.c.button : m.c.text }}>
                {cat.name}
              </div>
            </button>
          );
        })}
      </div>
    );
  }
  if (style === 'tabs') {
    return (
      <div className="flex gap-4 overflow-x-auto border-b px-3 [scrollbar-width:none]" style={{ borderColor: m.c.border }}>
        {m.categories.map((cat) => {
          const on = cat.id === active;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => onPick(cat.id)}
              className="shrink-0 border-b-2 pb-2 pt-1 kt-13 font-semibold transition-colors duration-200"
              style={{ borderColor: on ? m.c.button : 'transparent', color: on ? m.c.button : m.c.mutedText }}
            >
              {cat.name}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div className="flex gap-2 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
      {m.categories.map((cat) => {
        const on = cat.id === active;
        return (
          <button
            key={cat.id}
            type="button"
            onClick={() => onPick(cat.id)}
            className="shrink-0 px-3.5 py-1.5 kt-13 font-semibold transition-all duration-200"
            style={
              on
                ? { background: m.c.button, color: m.c.buttonText, borderRadius: 999 }
                : { background: m.cfg.theme.mode === 'dark' ? '#FFFFFF14' : '#0000000D', color: m.c.text, borderRadius: 999 }
            }
          >
            {cat.name}
          </button>
        );
      })}
    </div>
  );
}

/** The side rail (categoryLayout = side) on the start side, styled by categoryStyle. */
function CategoryRail({
  m,
  active,
  onPick,
  railRef,
}: {
  m: PreviewModel;
  active: string | null;
  onPick: (id: string) => void;
  railRef: RefObject<HTMLDivElement | null>;
}) {
  const style = m.cfg.theme.categoryStyle;
  const imageSize = style === 'images' ? (m.wide ? 56 : 48) : 36;
  return (
    <div
      ref={railRef}
      className="relative flex w-[76px] shrink-0 flex-col gap-1 overflow-y-auto border-e py-2 [scrollbar-width:none]"
      style={{ borderColor: m.c.border, background: m.cfg.theme.mode === 'dark' ? '#00000026' : '#FFFFFF80' }}
    >
      {m.categories.map((cat) => {
        const on = cat.id === active;
        // chips: a pill behind the selected item; tabs: an indicator bar; images: a ring on the tile.
        const itemStyle: CSSProperties = style === 'chips' && on ? { background: `${m.c.button}1F`, borderRadius: 999 } : {};
        return (
          <button
            key={cat.id}
            type="button"
            data-cat={cat.id}
            onClick={() => onPick(cat.id)}
            className="relative mx-1 flex flex-col items-center gap-1 px-1 py-1.5 text-center transition-all duration-200"
            style={itemStyle}
          >
            {style === 'tabs' && on ? (
              <span className="absolute inset-y-1 start-0 w-[3px] rounded-full" style={{ background: m.c.button }} aria-hidden />
            ) : null}
            <span
              className="transition-transform duration-200"
              style={
                style === 'images' && on
                  ? { outline: `2px solid ${m.c.button}`, outlineOffset: 2, borderRadius: Math.max(8, m.radius * 0.6) }
                  : { transform: on ? 'scale(1.05)' : undefined }
              }
            >
              <CategoryImage m={m} cat={cat} size={imageSize} radius={style === 'chips' ? 999 : Math.max(8, m.radius * 0.6)} />
            </span>
            <span className={`line-clamp-2 w-full kt-10 leading-tight ${on ? 'font-bold' : ''}`} style={{ color: on ? m.c.button : m.c.text }}>
              {cat.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The element the add-to-cart flight lands on, registered through a callback ref. */
function CartTarget({
  register,
  className,
  style,
  children,
}: {
  register: (el: HTMLDivElement | null) => void;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div ref={register} className={className} style={style}>
      {children}
    </div>
  );
}

export function CartBar({ m }: { m: PreviewModel }) {
  const count = cartCount(m.cart);
  if (count === 0) return null;
  const bounce = m.motion.bounce > 0;
  return (
    <BigButton
      m={m}
      onClick={() => m.go(m.cfg.general.skipCart === 'off' ? 'cart' : 'pay')}
      className="justify-between shadow-lg animate-in slide-in-from-bottom-4 duration-300"
    >
      <CartTarget
        register={m.setCartTarget}
        key={m.cartBump}
        className={`flex h-6 min-w-6 items-center justify-center rounded-full bg-white/25 px-1.5 text-xs tabular-nums ${bounce ? 'kiosk-bounce' : ''}`}
        style={{ ['--k-bounce' as string]: String(m.motion.bounce || 1) } as CSSProperties}
      >
        {count}
      </CartTarget>
      <span>{m.cfg.general.skipCart === 'off' ? m.t('viewCart') : m.txt('checkoutCta')}</span>
      <span className="tabular-nums">
        <CountUp value={cartTotal(m.cart)} ms={m.motion.countUpMs} format={m.money} />
      </span>
    </BigButton>
  );
}

/** The side order panel (cartStyle = panel, wide frame) on the end side. */
function CartPanel({ m }: { m: PreviewModel }) {
  const count = cartCount(m.cart);
  const bounce = m.motion.bounce > 0;
  return (
    <div className="flex w-[132px] shrink-0 flex-col border-s" style={{ borderColor: m.c.border, background: m.c.surface }}>
      <CartTarget
        register={m.setCartTarget}
        className="flex items-center justify-between gap-1 border-b px-2 py-2"
        style={{ borderColor: m.c.border }}
      >
        <span className="truncate text-xs font-extrabold">{m.txt('cartTitle')}</span>
        <span
          key={m.cartBump}
          className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 kt-10 font-bold tabular-nums ${bounce && count > 0 ? 'kiosk-bounce' : ''}`}
          style={{ background: m.c.button, color: m.c.buttonText, ['--k-bounce' as string]: String(m.motion.bounce || 1) } as CSSProperties}
        >
          {count}
        </span>
      </CartTarget>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2 [scrollbar-width:none]">
        {m.cart.length === 0 ? (
          <p className="pt-6 text-center kt-11" style={{ color: m.c.mutedText }}>
            {m.t('cartEmpty')}
          </p>
        ) : (
          m.cart.map((l) => (
            <div key={l.key} className="space-y-1 rounded-lg p-1.5" style={{ background: m.cfg.theme.mode === 'dark' ? '#FFFFFF0D' : '#0000000A' }}>
              <div className="line-clamp-2 kt-11 font-semibold leading-tight">{l.product.name}</div>
              <div className="flex items-center justify-between gap-1">
                <span className="kt-10 tabular-nums" style={{ color: m.c.primary }}>
                  {m.money(l.unit * l.qty)}
                </span>
                <span className="kt-10 tabular-nums" style={{ color: m.c.mutedText }}>
                  ×{l.qty}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="space-y-1.5 border-t p-2" style={{ borderColor: m.c.border }}>
        <div className="flex items-center justify-between kt-11 font-bold">
          <span>{m.t('total')}</span>
          <span className="tabular-nums">
            <CountUp value={cartTotal(m.cart)} ms={m.motion.countUpMs} format={m.money} />
          </span>
        </div>
        <button
          type="button"
          className={`w-full px-2 py-2 kt-11 font-bold ${count === 0 ? 'opacity-50' : ''}`}
          style={buttonStyle(m)}
          onClick={() => count > 0 && m.go(m.cfg.general.skipCart === 'off' ? 'cart' : 'pay')}
        >
          {m.txt('checkoutCta')}
        </button>
      </div>
    </div>
  );
}

function FeaturedRow({ m }: { m: PreviewModel }) {
  if (m.featured.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-extrabold">
        <Sparkles className="h-4 w-4" style={{ color: m.c.accent }} /> {m.t('featured')}
      </h3>
      <div className="-mx-3 flex gap-2.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none]">
        {m.featured.map((p) => (
          <div key={p.id} className="w-32 shrink-0">
            <ProductCard m={m} p={p} />
          </div>
        ))}
      </div>
    </section>
  );
}

function CatalogHeader({ m, children }: { m: PreviewModel; children?: ReactNode }) {
  const header = m.cfg.screenImages?.catalogHeader;
  return (
    <div className="z-10 shrink-0 space-y-2 pb-1 pt-3 backdrop-blur-md" style={{ background: `${m.c.background}E6` }}>
      <div className="flex items-center gap-2 px-3">
        <LiveBack m={m} size={32} />
        <Logo m={m} size={30} />
        <h2 className="flex-1 truncate text-lg font-extrabold">{m.txt('catalogTitle')}</h2>
        <span className="px-2 py-0.5 kt-11 font-semibold" style={buttonStyle(m, 'soft')}>
          {m.service === 'take_away' ? m.txt('takeAwayLabel') : m.txt('eatInLabel')}
        </span>
        {m.live?.startOver ? (
          <button type="button" onClick={m.live.startOver} className="px-2.5 py-1 kt-11 font-semibold" style={{ ...cardStyle(m), borderRadius: 999 }}>
            {m.t('startOver')}
          </button>
        ) : null}
      </div>
      {header ? (
        <div className="mx-3 overflow-hidden" style={{ borderRadius: m.radius, height: 64 }}>
          <Img src={header.url} className="h-full w-full object-cover" />
        </div>
      ) : null}
      {m.cfg.general.searchEnabled && !m.live ? (
        <div className="mx-3 flex items-center gap-2 px-3 py-2 text-xs" style={{ ...cardStyle(m), borderRadius: 999, color: m.c.mutedText }}>
          <Search className="h-3.5 w-3.5" /> {m.t('search')}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function ProductGrid({ m, products }: { m: PreviewModel; products: PProduct[] }) {
  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${m.cols}, minmax(0, 1fr))` }}>
      {products.map((p) => (
        <ProductCard key={p.id} m={m} p={p} />
      ))}
    </div>
  );
}

/** Side layout: the rail, every category as a section, the rail following the visible one. */
function SideCatalog({ m }: { m: PreviewModel }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(m.categories[0]?.id ?? null);
  const current = m.categories.some((c) => c.id === active) ? active : (m.categories[0]?.id ?? null);

  // Keep the active rail item in view without scrolling the dashboard page around it.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || !current) return;
    const item = rail.querySelector<HTMLElement>(`[data-cat="${CSS.escape(current)}"]`);
    if (!item) return;
    if (item.offsetTop < rail.scrollTop) rail.scrollTo({ top: item.offsetTop - 8 });
    else if (item.offsetTop + item.offsetHeight > rail.scrollTop + rail.clientHeight) {
      rail.scrollTo({ top: item.offsetTop + item.offsetHeight - rail.clientHeight + 8 });
    }
  }, [current]);

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const sections = Array.from(scroller.querySelectorAll<HTMLElement>('[data-section]'));
    let found: string | null = sections[0]?.dataset.section ?? null;
    for (const s of sections) {
      if (s.offsetTop <= scroller.scrollTop + 16) found = s.dataset.section ?? found;
    }
    if (found && found !== active) setActive(found);
  };

  const one = m.cfg.catalog.oneCategory;
  const pick = (id: string) => {
    setActive(id);
    m.onCategoryPicked?.(id);
    if (one) {
      scrollerRef.current?.scrollTo({ top: 0 });
      return;
    }
    const scroller = scrollerRef.current;
    const section = scroller?.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
    if (scroller && section) {
      scroller.scrollTo({ top: section.offsetTop - 4, behavior: m.motion.flyMs > 0 ? 'smooth' : 'auto' });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CatalogHeader m={m} />
      <div className="flex min-h-0 flex-1">
        <CategoryRail m={m} active={current} onPick={pick} railRef={railRef} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollerRef} onScroll={one ? undefined : onScroll} className="relative min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4 pt-2 [scrollbar-width:none]">
            {one ? null : <FeaturedRow m={m} />}
            {(one ? m.categories.filter((c) => c.id === current) : m.categories).map((cat) => (
              <section key={cat.id} data-section={cat.id} className={cn('space-y-2', one && 'animate-in fade-in duration-300')}>
                <h3 className="text-sm font-extrabold">{cat.name}</h3>
                <ProductGrid m={m} products={cat.products} />
              </section>
            ))}
            {m.categories.length === 0 ? (
              <p className="py-10 text-center text-sm" style={{ color: m.c.mutedText }}>
                {m.t('empty')}
              </p>
            ) : null}
          </div>
          {!m.panel ? (
            <div className="shrink-0 p-2" style={{ background: `linear-gradient(to top, ${m.c.background}, ${m.c.background}00)` }}>
              <CartBar m={m} />
            </div>
          ) : null}
        </div>
        {m.panel ? <CartPanel m={m} /> : null}
      </div>
    </div>
  );
}

/**
 * Top layout: the strip over the dishes. "הצג כל מחלקה בנפרד" (catalog.oneCategory) as on the
 * side rail: one category at a time, or the whole menu in one list that the strip follows.
 */
function TopCatalog({ m, activeCategory, onCategory }: { m: PreviewModel; activeCategory: string | null; onCategory: (id: string) => void }) {
  const current = m.categories.find((c) => c.id === activeCategory) ?? m.categories[0];
  const one = m.cfg.catalog.oneCategory;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pick = (id: string) => {
    onCategory(id);
    m.onCategoryPicked?.(id);
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (one) {
      scroller.scrollTo({ top: 0 });
      return;
    }
    const section = scroller.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
    if (section) scroller.scrollTo({ top: section.offsetTop - 4, behavior: m.motion.flyMs > 0 ? 'smooth' : 'auto' });
  };
  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let found: string | null = null;
    for (const s of Array.from(scroller.querySelectorAll<HTMLElement>('[data-section]'))) {
      if (s.offsetTop <= scroller.scrollTop + 16) found = s.dataset.section ?? found;
    }
    if (found && found !== current?.id) onCategory(found);
  };
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <CatalogHeader m={m}>
          <CategoryStrip m={m} active={current?.id ?? null} onPick={pick} />
        </CatalogHeader>
        <div ref={scrollerRef} onScroll={one ? undefined : onScroll} className="relative min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4 pt-1 [scrollbar-width:none]">
          {one ? null : <FeaturedRow m={m} />}
          {!one && m.categories.length > 0 ? (
            m.categories.map((cat) => (
              <section key={cat.id} data-section={cat.id} className="space-y-2">
                <h3 className="text-sm font-extrabold">{cat.name}</h3>
                <ProductGrid m={m} products={cat.products} />
              </section>
            ))
          ) : current ? (
            <section key={current.id} className="space-y-2 animate-in fade-in duration-300">
              <h3 className="text-sm font-extrabold">{current.name}</h3>
              <ProductGrid m={m} products={current.products} />
            </section>
          ) : (
            <p className="py-10 text-center text-sm" style={{ color: m.c.mutedText }}>
              {m.t('empty')}
            </p>
          )}
        </div>
        {!m.panel ? (
          <div className="shrink-0 p-2" style={{ background: `linear-gradient(to top, ${m.c.background}, ${m.c.background}00)` }}>
            <CartBar m={m} />
          </div>
        ) : null}
      </div>
      {m.panel ? <CartPanel m={m} /> : null}
    </div>
  );
}

export function CatalogScreen({ m, activeCategory, onCategory }: { m: PreviewModel; activeCategory: string | null; onCategory: (id: string) => void }) {
  return m.cfg.theme.categoryLayout === 'top' ? (
    <TopCatalog m={m} activeCategory={activeCategory} onCategory={onCategory} />
  ) : (
    <SideCatalog m={m} />
  );
}

/* ---------------------------------------------------------------- product */

export function ProductSheet({
  m,
  product,
  groups,
  allergens,
  onClose,
  onAdd,
  quickNotes,
}: {
  m: PreviewModel;
  product: PProduct;
  groups: PGroup[];
  allergens: string[];
  onClose: () => void;
  /** `from`: where the add button was, for the add-to-cart flight. */
  onAdd: (line: PLine, from: DOMRect | null) => void;
  /** The menu's quick notes for this product (the real kiosk); the preview shows samples. */
  quickNotes?: string[];
}) {
  const { cfg } = m;
  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(groups.map((g) => [g.id, g.min > 0 && g.options[0] ? [g.options[0].id] : []])),
  );
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState<string[]>([]);
  const [note, setNote] = useState('');
  // A required group with fewer than its minimum picked: nothing goes in the order yet.
  const missing = groups.some((g) => (picked[g.id] ?? []).length < g.min);
  const extras = groups.flatMap((g) => g.options.filter((o) => (picked[g.id] ?? []).includes(o.id)));
  const unit = product.price + extras.reduce((s, o) => s + o.price, 0);
  const toggle = (g: PGroup, id: string) => {
    setPicked((prev) => {
      const cur = prev[g.id] ?? [];
      if (g.max === 1) return { ...prev, [g.id]: [id] };
      if (cur.includes(id)) return { ...prev, [g.id]: cur.filter((x) => x !== id) };
      if (g.max !== null && cur.length >= g.max) return prev;
      return { ...prev, [g.id]: [...cur, id] };
    });
  };
  const quick = quickNotes ?? [m.t('quickNote1'), m.t('quickNote2'), m.t('quickNote3')];
  const showDietary = cfg.general.showDietary;
  const picture = product.imageLarge ? { ...product, imageUrl: product.imageLarge } : product;
  const pictureRef = useRef<HTMLDivElement>(null);
  /** Where the add flies from: the picture's part in view, else the button. */
  const flyFrom = (button: DOMRect): DOMRect => {
    const pic = pictureRef.current?.getBoundingClientRect();
    const view = pictureRef.current?.parentElement?.getBoundingClientRect();
    if (!pic || !view) return button;
    const top = Math.max(pic.top, view.top);
    return pic.bottom - top >= 60 ? new DOMRect(pic.left, top, pic.width, pic.bottom - top) : button;
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center p-3">
      <button type="button" aria-label={m.t('close')} className="absolute inset-0 bg-black/40 animate-in fade-in duration-200" onClick={onClose} />
      <div
        className="relative flex max-h-[90%] w-full max-w-[420px] flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-300"
        style={{ background: m.c.surface, color: m.c.text, borderRadius: Math.max(16, m.radius) }}
      >
        <div className="absolute inset-x-0 top-2 z-10 mx-auto h-1.5 w-10 rounded-full bg-white/80 shadow" />
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
          <div ref={pictureRef} className="w-full" style={{ aspectRatio: m.ratio }}>
            <ProductImage m={m} p={picture} className="h-full w-full" />
          </div>
          <div className="space-y-4 p-4">
            <div>
              <h3 className="text-xl font-extrabold leading-tight">{product.name}</h3>
              {product.description ? (
                <p className="mt-1 text-sm" style={{ color: m.c.mutedText }}>
                  {product.description}
                </p>
              ) : null}
              <div className="mt-1.5 font-bold tabular-nums" style={{ color: m.c.primary }}>
                {m.money(product.price)}
              </div>
              {showDietary && product.dietaryTags.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {product.dietaryTags.map((tag) => (
                    <li
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 kt-11 font-medium"
                      style={{ background: m.cfg.theme.mode === 'dark' ? '#FFFFFF14' : '#0000000D' }}
                    >
                      <span aria-hidden>{DIETARY_EMOJI[tag]}</span>
                      {m.t(`diet.${tag}`)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {showDietary && cfg.general.showAllergens && allergens.length > 0 ? (
                <div className="mt-2">
                  <span className="inline-flex flex-wrap items-center gap-1 rounded-full px-2.5 py-1 kt-11 font-medium" style={{ background: '#FEF3C7', color: '#92400E' }}>
                    <span className="font-bold">{m.t('allergens')}:</span> {allergens.join(', ')}
                  </span>
                </div>
              ) : null}
            </div>
            {groups.map((g) => (
              <div key={g.id} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">{g.name}</span>
                  <span
                    className="rounded-full px-2 py-0.5 kt-10 font-semibold"
                    style={g.min > 0 ? { background: `${m.c.button}1A`, color: m.c.button } : { background: '#0000000D', color: m.c.mutedText }}
                  >
                    {g.min > 0 ? m.t('required') : g.max ? m.t('chooseUpTo', { n: g.max }) : m.t('optional')}
                  </span>
                </div>
                <div className="overflow-hidden" style={{ ...cardStyle(m), boxShadow: 'none', border: `1px solid ${m.c.border}` }}>
                  {g.options.map((o, i) => {
                    const on = (picked[g.id] ?? []).includes(o.id);
                    const radio = g.max === 1;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => toggle(g, o.id)}
                        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-start text-sm"
                        style={{ borderTop: i > 0 ? `1px solid ${m.c.border}` : undefined }}
                      >
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center transition-colors duration-150"
                          style={{
                            borderRadius: radio ? 999 : 6,
                            border: `2px solid ${on ? m.c.button : m.c.border}`,
                            background: on ? m.c.button : 'transparent',
                            color: m.c.buttonText,
                          }}
                        >
                          {on ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <span className="flex-1">{o.name}</span>
                        {o.price > 0 ? <span className="text-xs tabular-nums" style={{ color: m.c.mutedText }}>+{m.money(o.price)}</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {cfg.general.quickNotesEnabled && quick.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {quick.map((q) => {
                  const on = notes.includes(q);
                  return (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setNotes(on ? notes.filter((x) => x !== q) : [...notes, q])}
                      className="px-3 py-1 text-xs font-medium transition-colors duration-150"
                      style={on ? { ...buttonStyle(m), borderRadius: 999 } : { background: '#0000000D', borderRadius: 999 }}
                    >
                      {q}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {cfg.general.notesEnabled ? (
              m.live?.noteField ? (
                m.live.noteField(note, setNote)
              ) : (
                <div className="px-3 py-2.5 text-xs" style={{ border: `1px solid ${m.c.border}`, borderRadius: Math.min(m.radius, 14), color: m.c.mutedText }}>
                  {m.t('notePlaceholder')}
                </div>
              )
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-3 border-t p-3" style={{ borderColor: m.c.border }}>
          <Stepper m={m} value={qty} onChange={(n) => setQty(Math.max(1, n))} />
          <BigButton
            m={m}
            disabledLook={missing}
            onClick={(e) => {
              if (missing) return;
              const typed = note.trim();
              onAdd(
                {
                  key: `${product.id}-${Date.now()}`,
                  product,
                  qty,
                  unit,
                  extras: [...extras.map((o) => o.name), ...notes, ...(typed ? [typed] : [])],
                  options: groups.flatMap((g) =>
                    g.options.filter((o) => (picked[g.id] ?? []).includes(o.id)).map((o) => ({ groupId: g.id, optionId: o.id, name: o.name, price: o.price })),
                  ),
                  note: [...notes, ...(typed ? [typed] : [])].join(' · ') || undefined,
                },
                flyFrom(e.currentTarget.getBoundingClientRect()),
              );
            }}
          >
            {m.t('addToCart', { price: m.money(unit * qty) })}
          </BigButton>
        </div>
      </div>
    </div>
  );
}

/** "Added — add more / pay" for skipCart = confirm. */
export function ConfirmSheet({ m, onMore, onPay }: { m: PreviewModel; onMore: () => void; onPay: () => void }) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center p-3">
      <div className="absolute inset-0 bg-black/40 animate-in fade-in duration-200" />
      <div
        className="relative w-full max-w-[420px] space-y-3 p-4 animate-in fade-in zoom-in-95 duration-300"
        style={{ background: m.c.surface, color: m.c.text, borderRadius: Math.max(16, m.radius) }}
      >
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: m.c.accent, color: '#fff' }}>
            <Check className="h-4 w-4" />
          </span>
          <span className="font-bold">{m.t('confirmTitle')}</span>
          <span className="ms-auto text-sm font-bold tabular-nums">{m.money(cartTotal(m.cart))}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <BigButton m={m} variant="soft" onClick={onMore}>
            {m.t('addMore')}
          </BigButton>
          <BigButton m={m} onClick={onPay}>
            {m.txt('checkoutCta')}
          </BigButton>
        </div>
      </div>
    </div>
  );
}

/**
 * The add-to-cart flight (the till's KioskFlyLayer, docs/SPEC_KIOSK.md §18): the dish's picture
 * and name pop out by its card, then fly on an arc into the cart, shrinking and fading; with
 * reduce motion only a fade where the dish was. Never takes taps, so every tap flies its own.
 */
export interface Flight {
  id: number;
  /** Where it starts (the dish's picture), in the screen's px. */
  x: number;
  y: number;
  imageUrl: string | null;
  name: string;
  /** Lands on the cart (the badge bounces then); a reduce-motion fade does not. */
  lands: boolean;
}

/** The flying card's width on the device, in dp (the till's FLY_CARD_DP). */
const FLY_CARD_DP = 128;

export function Flyer({
  flight,
  motion,
  dp,
  surface,
  text,
  containerRef,
  targetRef,
  onDone,
}: {
  flight: Flight;
  motion: MotionSpec;
  /** Screen px to a device dp (the frame's scale). */
  dp: number;
  surface: string;
  text: string;
  containerRef: RefObject<HTMLDivElement | null>;
  targetRef: RefObject<HTMLDivElement | null>;
  onDone: (flight: Flight) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The numbers, not the object: the preview re-renders while a flight is in the air.
  const { popMs, popScale, flyMs, arcDp, fadeMs } = motion;
  useEffect(() => {
    const spec: MotionSpec = { popMs, popScale, flyMs, arcDp, fadeMs, bounce: 0, countUpMs: 0 };
    const el = ref.current;
    const box = containerRef.current?.getBoundingClientRect();
    const target = targetRef.current?.getBoundingClientRect();
    const total = addMs(spec);
    const flies = flyMs > 0;
    if (!el || !box || total <= 0 || (flies && !target) || typeof el.animate !== 'function') {
      const id = window.setTimeout(() => onDone(flight), 0);
      return () => window.clearTimeout(id);
    }
    const from = { x: flight.x, y: flight.y };
    const to = flies && target ? { x: target.left + target.width / 2 - box.left, y: target.top + target.height / 2 - box.top } : from;
    const steps = 18;
    const frames: Keyframe[] = Array.from({ length: steps + 1 }, (_, i) => {
      const f = addFrame(spec, (total * i) / steps, from, to, dp);
      return {
        offset: i / steps,
        transform: `translate(${f.x - from.x}px, ${f.y - from.y}px) scale(${f.scale})`,
        opacity: f.alpha,
        boxShadow: `0 ${Math.round(10 * f.shadow * dp)}px ${Math.round(28 * f.shadow * dp)}px rgba(0,0,0,${(0.3 * f.shadow).toFixed(3)})`,
      };
    });
    const anim = el.animate(frames, { duration: total, easing: 'linear', fill: 'forwards' });
    anim.onfinish = () => onDone(flight);
    return () => anim.cancel();
  }, [flight, popMs, popScale, flyMs, arcDp, fadeMs, dp, containerRef, targetRef, onDone]);
  const w = Math.round(FLY_CARD_DP * dp);
  const h = w + Math.round(30 * dp);
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute z-50 flex flex-col overflow-hidden"
      style={{ left: flight.x - w / 2, top: flight.y - h / 2, width: w, height: h, borderRadius: Math.round(18 * dp), background: surface, color: text, opacity: 0, willChange: 'transform, opacity' }}
    >
      <div className="w-full shrink-0 overflow-hidden" style={{ height: w, background: '#00000010' }}>
        {flight.imageUrl ? <Img src={flight.imageUrl} className="h-full w-full object-cover" /> : null}
      </div>
      <div className="flex flex-1 items-center justify-center truncate px-1.5 text-center font-bold" style={{ fontSize: Math.max(9, Math.round(15 * dp)) }}>
        {flight.name}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- upsell */

/**
 * "הגדלת מכירה" — the window (the till's KioskUpsellUi.kt, docs/SPEC_KIOSK.md §21), the same in
 * every style. One item (a special): its big picture — the rule's own, else the dish's, else
 * its name on a quiet card, never an empty box — title, text, "הוספה להזמנה" / "לא תודה".
 * Several (up to six): tiles with picture, name, price and a quick "+", the window staying
 * while items go in ("המשך" closes it); each add flies to the cart from its picture.
 */
export function UpsellWindow({
  m,
  title,
  text,
  imageUrl,
  items,
  added,
  showPrice,
  onAdd,
  onContinue,
  onSkip,
}: {
  m: PreviewModel;
  title: string;
  text: string | null;
  imageUrl: string | null;
  items: PProduct[];
  added: Record<string, number>;
  showPrice: boolean;
  onAdd: (p: PProduct, from: DOMRect | null) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const picture = (p: PProduct, own: string | null, className: string) =>
    own || p.imageUrl ? (
      <Img src={(own || p.imageUrl) as string} className={className} style={{ objectFit: 'cover' }} />
    ) : (
      <div
        className={`flex items-center justify-center p-2 text-center font-bold ${className}`}
        style={{ background: `linear-gradient(135deg, ${m.c.primary}22, ${m.c.accent}22)`, color: m.c.primary }}
      >
        {p.name}
      </div>
    );
  const single = items.length <= 1 ? items[0] : null;
  const anyAdded = Object.keys(added).length > 0;
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center p-3">
      <button type="button" aria-label={m.t('close')} className="absolute inset-0 bg-black/40 animate-in fade-in duration-200" onClick={onSkip} />
      <div
        className="relative flex max-h-[90%] w-full max-w-[420px] flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-300"
        style={{ background: m.c.surface, color: m.c.text, borderRadius: Math.max(16, m.radius) }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
          {single ? (
            <>
              <div data-fly-from className="w-full" style={{ aspectRatio: '16 / 10' }}>
                {picture(single, imageUrl, 'h-full w-full')}
              </div>
              <div className="space-y-1 p-4 text-center">
                <div className="text-lg font-extrabold leading-tight">{title}</div>
                {text ? <div className="kt-13" style={{ color: m.c.mutedText }}>{text}</div> : null}
                {single.name !== title ? <div className="kt-15 font-bold">{single.name}</div> : null}
              </div>
            </>
          ) : (
            <div className="space-y-3 p-4">
              <div>
                <div className="text-lg font-extrabold leading-tight">{title}</div>
                {text ? <div className="kt-13" style={{ color: m.c.mutedText }}>{text}</div> : null}
              </div>
              <div className={`grid gap-2 ${items.length === 4 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                {items.map((p) => {
                  const count = added[p.id] ?? 0;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={(e) => onAdd(p, e.currentTarget.querySelector('[data-fly-from]')?.getBoundingClientRect() ?? null)}
                      className="flex flex-col overflow-hidden text-start transition-transform duration-150 active:scale-[0.98]"
                      style={cardStyle(m)}
                    >
                      <div data-fly-from className="relative w-full" style={{ aspectRatio: '4 / 3' }}>
                        {picture(p, null, 'h-full w-full kt-11')}
                        {count > 0 ? (
                          <span className="absolute start-1 top-1 rounded-full px-1.5 py-0.5 kt-10 font-bold text-white" style={{ background: m.c.accent }}>
                            ✓ ×{count}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1 p-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2 kt-11 font-bold leading-snug">{p.name}</div>
                          {showPrice ? <div className="kt-11 font-bold tabular-nums" style={{ color: m.c.primary }}>+{m.money(p.price)}</div> : null}
                        </div>
                        <span
                          className="flex h-6 w-6 shrink-0 items-center justify-center"
                          style={{ ...buttonStyle(m), borderRadius: 999, background: count > 0 ? m.c.accent : m.c.button }}
                        >
                          {count > 0 ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t p-3" style={{ borderColor: m.c.border }}>
          {single ? (
            <>
              <BigButton m={m} variant="soft" onClick={onSkip}>
                {m.t('upsellSkip')}
              </BigButton>
              <BigButton
                m={m}
                onClick={(e) => {
                  const box = e.currentTarget.closest('.relative')?.querySelector('[data-fly-from]')?.getBoundingClientRect() ?? null;
                  onAdd(single, box);
                }}
              >
                {showPrice ? m.t('upsellAddToOrder', { price: m.money(single.price) }) : m.t('upsellContinue')}
              </BigButton>
            </>
          ) : anyAdded ? (
            <BigButton m={m} onClick={onContinue}>
              {m.t('upsellContinue')}
            </BigButton>
          ) : (
            <BigButton m={m} variant="soft" onClick={onSkip}>
              {m.t('upsellSkip')}
            </BigButton>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- cart */

export function CartScreen({ m, upsell }: { m: PreviewModel; upsell: PProduct[] }) {
  const { cfg } = m;
  const total = cartTotal(m.cart);
  const min = cfg.payment.minOrderAgorot / 100;
  const below = min > 0 && total < min;
  const askName = cfg.payment.customerName !== 'off';
  const askPhone = cfg.payment.customerPhone !== 'off';
  const field = (label: string, required: boolean, ltr = false) => (
    <div className="flex items-center justify-between px-3 py-2.5 text-sm" style={{ border: `1px solid ${m.c.border}`, borderRadius: Math.min(m.radius, 14) }}>
      <span style={{ color: m.c.mutedText }}>
        {label}
        {required ? <span style={{ color: '#DC2626' }}> *</span> : null}
      </span>
      <span dir={ltr ? 'ltr' : undefined} className="text-xs" style={{ color: m.c.mutedText }}>
        {ltr ? '05X-XXXXXXX' : ''}
      </span>
    </div>
  );
  return (
    <ScreenBody
      m={m}
      footer={
        <div className="space-y-1.5">
          {below ? (
            <p className="text-center text-xs font-medium" style={{ color: '#B45309' }}>
              {m.t('minOrder', { amount: m.money(min) })}
            </p>
          ) : null}
          <BigButton m={m} onClick={() => m.go('pay')} disabledLook={below || m.cart.length === 0}>
            <span>{m.txt('checkoutCta')}</span>
            <span className="tabular-nums">· {m.money(total)}</span>
          </BigButton>
        </div>
      }
    >
      <div className="space-y-4 p-4">
        <ScreenImage m={m} k="cart" height={80} />
        <div className="flex items-center justify-between gap-2">
          <LiveBack m={m} />
          <h2 className="flex-1 text-xl font-extrabold">{m.txt('cartTitle')}</h2>
          <button type="button" className="px-3 py-1 text-xs font-semibold" style={buttonStyle(m, 'soft')} onClick={() => m.go('catalog')}>
            {m.t('addMore')}
          </button>
        </div>
        <div className="divide-y overflow-hidden" style={{ ...cardStyle(m) }}>
          {m.cart.map((l) => (
            <div key={l.key} className="flex items-center gap-3 p-3" style={{ borderColor: m.c.border }}>
              <ProductImage m={m} p={l.product} className="h-12 w-12 shrink-0" style={{ borderRadius: Math.min(m.radius, 12) }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold">{l.product.name}</div>
                {l.extras.length > 0 ? (
                  <div className="truncate kt-11" style={{ color: m.c.mutedText }}>
                    {l.extras.join(' · ')}
                  </div>
                ) : null}
                <div className="text-xs font-bold tabular-nums" style={{ color: m.c.primary }}>
                  {m.money(l.unit * l.qty)}
                </div>
              </div>
              <Stepper
                m={m}
                small
                value={l.qty}
                onChange={(n) =>
                  m.setCart(n <= 0 ? m.cart.filter((x) => x.key !== l.key) : m.cart.map((x) => (x.key === l.key ? { ...x, qty: n } : x)))
                }
              />
            </div>
          ))}
          {m.cart.length === 0 ? (
            <p className="p-6 text-center text-sm" style={{ color: m.c.mutedText }}>
              {m.t('cartEmpty')}
            </p>
          ) : null}
        </div>
        {cfg.general.upsellEnabled && upsell.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-sm font-extrabold">{m.txt('upsellTitle')}</h3>
            <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 [scrollbar-width:none]">
              {upsell.map((p) => (
                <div key={p.id} className="w-28 shrink-0">
                  <ProductCard m={m} p={p} />
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {!m.live?.detailsScreen && (askName || askPhone || (m.service === 'eat_in' && cfg.general.askTableNumber)) ? (
          <section className="space-y-2">
            <h3 className="text-sm font-extrabold">{m.txt('customerTitle')}</h3>
            <p className="kt-11 leading-snug" style={{ color: m.c.mutedText }}>
              {m.txt('customerExplain')}
            </p>
            {askName ? field(m.t('name'), cfg.payment.customerName === 'required') : null}
            {askPhone ? field(m.t('phone'), cfg.payment.customerPhone === 'required', true) : null}
            {m.service === 'eat_in' && cfg.general.askTableNumber ? field(m.t('table'), true) : null}
          </section>
        ) : null}
      </div>
    </ScreenBody>
  );
}

/* -------------------------------------------------------------------- pay */

/**
 * The kiosk charges on an external pinpad standing next to its screen: a small kiosk
 * silhouette, an arrow, and the pinpad beside it with the card tapping it — never a card
 * on the screen itself.
 */
function PinpadScene({ m, muted = false }: { m: PreviewModel; muted?: boolean }) {
  const dark = m.cfg.theme.mode === 'dark';
  const body = dark ? '#2A303B' : '#1F2937';
  return (
    <div className={`relative flex h-36 items-end justify-center gap-3 ${muted ? 'opacity-50 grayscale' : ''}`} dir="rtl" aria-hidden>
      {/* The kiosk's own screen. */}
      <div className="flex h-32 w-20 flex-col items-center justify-start gap-1 rounded-lg p-1.5 shadow-md" style={{ background: body }}>
        <div className="flex w-full flex-1 flex-col items-center justify-center gap-1 rounded" style={{ background: m.c.background }}>
          <span className="h-1 w-8 rounded-full" style={{ background: `${m.c.text}55` }} />
          <span className="h-1.5 w-10 rounded-full" style={{ background: m.c.primary }} />
          <span className="h-1 w-6 rounded-full" style={{ background: `${m.c.text}33` }} />
        </div>
        <span className="h-1 w-6 rounded-full bg-white/30" />
      </div>
      {!muted ? <ArrowLeft className="kiosk-nudge mb-10 h-5 w-5" style={{ color: m.c.button }} /> : <span className="mb-10 w-5" />}
      {/* The pinpad beside it. */}
      <div className="relative">
        {!muted ? <span className="kiosk-ring absolute -inset-3 rounded-2xl" style={{ background: `${m.c.button}26` }} /> : null}
        <div className="relative flex h-24 w-14 flex-col items-center gap-1 rounded-xl p-1.5 shadow-lg" style={{ background: body }}>
          <span className="h-5 w-full rounded" style={{ background: muted ? '#4B5563' : '#10B981CC' }} />
          <span className="grid grid-cols-3 gap-0.5">
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className="h-1.5 w-2.5 rounded-sm bg-white/35" />
            ))}
          </span>
        </div>
        {!muted ? (
          <div
            className="kiosk-card absolute left-1/2 -top-12 flex h-9 w-14 flex-col justify-between rounded-md p-1 shadow-xl"
            style={{ background: `linear-gradient(135deg, ${m.c.primary}, ${m.c.accent})`, color: '#fff' }}
          >
            <CreditCard className="h-3 w-3" />
            <span className="kt-8 tracking-widest">••42</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The real kiosk's payment, as the till shows it: preparing (a spinner), the card awaited on
 * the pinpad (with "ביטול" while allowed), declined (try again / back to the order), unknown
 * (checked with the terminal — never charged again, no button), or blocked before anything was
 * sent (no internet / no pinpad).
 */
function LivePay({ m, live }: { m: PreviewModel; live: NonNullable<KioskLive['pay']> }) {
  const spinner = (
    <span
      aria-hidden
      className="inline-block h-10 w-10 animate-spin rounded-full border-4"
      style={{ borderColor: `${m.c.button}33`, borderTopColor: m.c.button }}
    />
  );
  return (
    <ScreenBody m={m}>
      <div className="flex min-h-full flex-col items-center gap-4 p-4 text-center">
        <ScreenImage m={m} k="pay" height={80} />
        <h2 className="text-xl font-extrabold">{m.txt('payTitle')}</h2>
        <div className="text-4xl font-black tabular-nums" style={{ color: m.c.text }}>
          {m.money(live.amount)}
        </div>
        {live.phase === 'unknown' ? (
          <div className="flex w-full flex-col items-center gap-3 p-4" style={cardStyle(m)}>
            {spinner}
            <div className="text-lg font-extrabold">{m.t('payUnknownTitle')}</div>
            <div className="text-sm" style={{ color: m.c.mutedText }}>
              {m.t('payUnknownBody')}
            </div>
          </div>
        ) : live.phase === 'declined' || live.phase === 'blocked' ? (
          <div className="flex w-full flex-col items-center gap-3 p-4" style={cardStyle(m)}>
            <span className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: '#FEE2E2', color: '#B91C1C' }}>
              <X className="h-7 w-7" />
            </span>
            <div className="text-lg font-extrabold">{live.phase === 'declined' ? m.t('payDeclined') : m.t('payBlockedTitle')}</div>
            {live.message ? (
              <div className="text-sm" style={{ color: m.c.mutedText }}>
                {live.message}
              </div>
            ) : null}
            <div className="grid w-full grid-cols-2 gap-2">
              <BigButton m={m} variant="soft" onClick={live.onBack}>
                {m.t('payBack')}
              </BigButton>
              {live.phase === 'declined' ? (
                <BigButton m={m} onClick={live.onRetry}>
                  {m.t('payRetry')}
                </BigButton>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/kiosk/card_terminals.png" alt="" className="w-full max-w-[300px] animate-in fade-in duration-500" style={{ aspectRatio: '900 / 480' }} />
            {live.phase === 'starting' || live.phase === 'idle' ? (
              <div className="flex flex-col items-center gap-2">
                {spinner}
                <p className="text-base font-bold">{m.t('payPreparing')}</p>
              </div>
            ) : (
              <p className="text-base font-bold">{m.txt('payInstruction')}</p>
            )}
            {live.message ? (
              <p className="kt-13" style={{ color: m.c.mutedText }}>
                {live.message}
              </p>
            ) : null}
            <p className="kt-11" style={{ color: m.c.mutedText }}>
              {m.t('cardOnly')}
            </p>
            {live.canCancel ? (
              <div className="mt-auto w-full">
                <BigButton m={m} variant="soft" onClick={live.onCancel} disabledLook={live.cancelling}>
                  {live.cancelling ? m.t('payCancelling') : m.t('payCancel')}
                </BigButton>
              </div>
            ) : null}
          </>
        )}
      </div>
    </ScreenBody>
  );
}

export function PayScreen({ m }: { m: PreviewModel }) {
  const { cfg } = m;
  const [tip, setTip] = useState<number | null>(null);
  const base = cartTotal(m.cart);
  const tipAmount = tip ? Math.round(base * tip) / 100 : 0;
  if (m.live?.pay) return <LivePay m={m} live={m.live.pay} />;
  return (
    <ScreenBody m={m}>
      <div className="flex min-h-full flex-col items-center gap-4 p-4 text-center">
        <ScreenImage m={m} k="pay" height={80} />
        <h2 className="text-xl font-extrabold">{m.txt('payTitle')}</h2>
        <div className="text-4xl font-black tabular-nums" style={{ color: m.c.text }}>
          {m.money(base + tipAmount)}
        </div>
        {cfg.payment.tipEnabled ? (
          <div className="w-full space-y-1.5">
            <div className="text-xs font-semibold" style={{ color: m.c.mutedText }}>
              {m.t('tip')}
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {[null, ...cfg.payment.tipPresets].map((p) => {
                const on = tip === p;
                return (
                  <button
                    key={p ?? 'none'}
                    type="button"
                    onClick={() => setTip(p)}
                    className="min-w-14 px-3 py-2 text-sm font-bold transition-all duration-150"
                    style={on ? buttonStyle(m) : { ...cardStyle(m), borderRadius: m.btnRadius }}
                  >
                    {p === null ? m.t('noTip') : `${p}%`}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/kiosk/card_terminals.png" alt="" className="w-full max-w-[300px] animate-in fade-in duration-500" style={{ aspectRatio: '900 / 480' }} />
        <p className="text-base font-bold">{m.txt('payInstruction')}</p>
        <p className="kt-11" style={{ color: m.c.mutedText }}>
          {m.t('cardOnly')}
        </p>
        <button type="button" className="mt-auto text-xs underline" style={{ color: m.c.mutedText }} onClick={() => m.go('success')}>
          {m.t('simulatePaid')}
        </button>
      </div>
    </ScreenBody>
  );
}

/* ---------------------------------------------------------------- success */

export function SuccessScreen({ m }: { m: PreviewModel }) {
  const { cfg } = m;
  const live = m.live?.success;
  const label = live ? live.pickupLabel : pickupLabel(cfg.pickup.prefix, Number.isFinite(cfg.pickup.start) ? cfg.pickup.start : 1);
  const messages = messagesFor(cfg, 'success', ['banner', 'notice'], m.nowMs);
  // The real kiosk: the question only while it is still asked; what happened to the receipt after.
  const receipt = live ? (live.receipt === 'ask' ? 'ask' : live.receipt === 'printing' || live.receipt === 'printed' ? 'always' : 'never') : cfg.payment.receiptPolicy;
  return (
    <ScreenBody m={m}>
      <div className="flex min-h-full flex-col items-center gap-3 p-5 text-center">
        <ScreenImage m={m} k="success" height={80} />
        <span className="kiosk-pop mt-2 flex h-16 w-16 items-center justify-center rounded-full shadow-lg" style={{ background: m.c.accent, color: '#fff' }}>
          <Check className="h-9 w-9" strokeWidth={3} />
        </span>
        <h2 className="text-xl font-extrabold">{m.txt('successTitle')}</h2>
        <div className="w-full space-y-1 p-4" style={cardStyle(m)}>
          <div className="text-xs font-semibold" style={{ color: m.c.mutedText }}>
            {m.txt('pickupLabel')}
          </div>
          <div className="text-6xl font-black tabular-nums" dir="ltr" style={{ color: m.c.primary }}>
            {label}
          </div>
        </div>
        <p className="text-sm" style={{ color: m.c.mutedText }}>
          {m.txt('successBody')}
        </p>
        {cfg.success.image ? <MediaView media={cfg.success.image} className="aspect-video w-full max-w-[260px] object-cover" style={{ borderRadius: m.radius }} /> : null}
        {cfg.success.message.trim() ? <p className="text-base font-semibold">{cfg.success.message}</p> : null}
        <div className="flex flex-wrap justify-center gap-1.5 kt-11">
          <span className="rounded-full px-2.5 py-1" style={{ background: `${m.c.accent}1F` }}>
            {m.t('bonSent')}
          </span>
          {cfg.printing.pickupSlip ? (
            <span className="rounded-full px-2.5 py-1" style={{ background: `${m.c.accent}1F` }}>
              {m.t('pickupSlip')}
            </span>
          ) : null}
          {receipt === 'always' ? (
            <span className="rounded-full px-2.5 py-1" style={{ background: `${m.c.accent}1F` }}>
              {m.t('receiptAlways')}
            </span>
          ) : null}
        </div>
        <CenteredMessages m={m} list={messages} className="flex-1" />
        {receipt === 'ask' ? (
          <div className="w-full space-y-2">
            <div className="text-sm font-semibold">{m.t('receiptAsk')}</div>
            <div className="grid grid-cols-2 gap-2">
              <BigButton m={m} variant="soft" onClick={live ? () => live.onReceipt(false) : undefined}>
                {m.t('receiptNo')}
              </BigButton>
              <BigButton m={m} onClick={live ? () => live.onReceipt(true) : undefined}>
                {m.t('receiptYes')}
              </BigButton>
            </div>
          </div>
        ) : null}
        {live ? (
          <div className="mt-auto w-full space-y-1.5">
            <BigButton m={m} variant="soft" onClick={live.onNewOrder}>
              {m.t('newOrder')}
            </BigButton>
            <p className="kt-11" style={{ color: m.c.mutedText }}>
              {m.t('resetsIn', { n: live.secondsLeft })}
            </p>
          </div>
        ) : (
          <p className="mt-auto kt-11" style={{ color: m.c.mutedText }}>
            {m.t('resetsIn', { n: cfg.timers.successSec })}
          </p>
        )}
      </div>
    </ScreenBody>
  );
}

/* ----------------------------------------------------------------- paused */

export type PausedVariant = 'paused' | 'closed' | 'noPayment' | 'offline';

export function PausedScreen({ m, variant }: { m: PreviewModel; variant: PausedVariant }) {
  const { cfg } = m;
  const title =
    variant === 'paused'
      ? cfg.operations.pausedTitle || m.txt('pausedTitle')
      : variant === 'closed'
        ? m.txt('closedTitle')
        : variant === 'offline'
          ? m.txt('offlineTitle')
          : m.txt('noPaymentTitle');
  const body =
    variant === 'paused'
      ? cfg.operations.pausedBody || m.txt('pausedBody')
      : variant === 'closed'
        ? m.txt('closedBody')
        : variant === 'offline'
          ? m.txt('offlineBody')
          : m.txt('noPaymentBody');
  // The till's own "no payment" / "no internet" screens carry no business messages.
  const own = variant === 'noPayment' || variant === 'offline';
  const messages = own ? [] : messagesFor(cfg, 'paused', ['closed', 'notice', 'banner'], m.nowMs);
  const image = cfg.screenImages?.paused;
  return (
    <ScreenBody m={m}>
      <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
        {variant === 'noPayment' ? (
          <PinpadScene m={m} muted />
        ) : variant === 'offline' ? (
          <span className="flex h-20 w-20 items-center justify-center rounded-full" style={{ background: '#FEF3C7', color: '#B45309' }}>
            <WifiOff className="h-10 w-10" />
          </span>
        ) : image ? (
          <div className="w-full overflow-hidden" style={{ borderRadius: m.radius, height: 120 }}>
            <Img src={image.url} className="h-full w-full object-cover" />
          </div>
        ) : (
          <Logo m={m} size={64} />
        )}
        <h2 className="text-2xl font-extrabold">{title}</h2>
        <p className="text-sm" style={{ color: m.c.mutedText }}>
          {body}
        </p>
        {variant === 'closed' && cfg.hours.enabled ? (
          <div className="w-full space-y-1 p-3 text-xs" style={cardStyle(m)}>
            {cfg.hours.ranges.map((r, i) => (
              <div key={i} className="flex justify-between gap-2">
                <span>{r.days.map((d) => m.t(`day${d}`)).join(' ')}</span>
                <span dir="ltr" className="tabular-nums">
                  {r.open}–{r.close}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <CenteredMessages m={m} list={messages} />
      </div>
    </ScreenBody>
  );
}

/**
 * The preview's keyframes, and its type scale / weight: Tailwind's text sizes are
 * re-pointed through --k-scale inside `.k-root` (and the fixed `kt-N` sizes with them).
 */
export const PREVIEW_CSS = `
${CTA_BOUNCE_KEYFRAMES}
@keyframes kioskCtaPulse { from { transform: scale(1); } to { transform: scale(1.04); } }
@keyframes kioskCtaGlow { 0% { transform: scale(1, 1); opacity: 0.55; } 100% { transform: scale(1.10, 1.45); opacity: 0; } }
.kiosk-cta-pulse { animation: kioskCtaPulse 1100ms ease-in-out infinite alternate; }
.kiosk-cta-bounce { animation: kioskCtaBounce 1800ms linear infinite; }
.kiosk-cta-glow { z-index: 19; animation: kioskCtaGlow 1800ms ease-out infinite; }
.k-root { --text-xs: calc(0.75rem * var(--k-scale)); --text-sm: calc(0.875rem * var(--k-scale)); --text-base: calc(1rem * var(--k-scale)); --text-lg: calc(1.125rem * var(--k-scale)); --text-xl: calc(1.25rem * var(--k-scale)); --text-2xl: calc(1.5rem * var(--k-scale)); --text-4xl: calc(2.25rem * var(--k-scale)); --text-6xl: calc(3.75rem * var(--k-scale)); font-weight: var(--k-w-body); }
.k-root .kt-8 { font-size: calc(8px * var(--k-scale)); }
.k-root .kt-10 { font-size: calc(10px * var(--k-scale)); }
.k-root .kt-11 { font-size: calc(11px * var(--k-scale)); }
.k-root .kt-13 { font-size: calc(13px * var(--k-scale)); }
.k-root .kt-15 { font-size: calc(15px * var(--k-scale)); }
@keyframes kioskCardTap { 0%, 15% { transform: translate(-50%, -4px) rotate(-10deg); } 45%, 62% { transform: translate(-50%, 46px) rotate(0deg); } 85%, 100% { transform: translate(-50%, -4px) rotate(-10deg); } }
@keyframes kioskRing { 0% { transform: scale(0.85); opacity: 0.9; } 100% { transform: scale(1.2); opacity: 0; } }
@keyframes kioskPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.025); } }
@keyframes kioskPop { 0% { transform: scale(0.4); opacity: 0; } 70% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); } }
@keyframes kioskNudge { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(-5px); } }
@keyframes kioskBounce { 0% { transform: scale(1); } 40% { transform: scale(var(--k-bounce, 1.2)); } 100% { transform: scale(1); } }
.kiosk-card { animation: kioskCardTap 2.6s ease-in-out infinite; transform: translate(-50%, -4px); }
.kiosk-ring { animation: kioskRing 1.8s ease-out infinite; }
.kiosk-pulse { animation: kioskPulse 2.4s ease-in-out infinite; }
.kiosk-pop { animation: kioskPop 0.5s cubic-bezier(.2,.9,.3,1.2) both; }
.kiosk-nudge { animation: kioskNudge 1.4s ease-in-out infinite; }
.kiosk-bounce { animation: kioskBounce 0.45s cubic-bezier(.3,1.6,.5,1) both; }
.k-reduce *, .k-reduce *::before, .k-reduce *::after { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) { .kiosk-card, .kiosk-ring, .kiosk-pulse, .kiosk-pop, .kiosk-nudge, .kiosk-bounce { animation: none; } }
`;
