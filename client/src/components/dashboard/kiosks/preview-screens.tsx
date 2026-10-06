'use client';

/**
 * The kiosk's screens, drawn from the edited config for the live preview: Wolt-like
 * cards, iOS-soft surfaces, RTL. Every colour, radius, font and text comes from the
 * config through `PreviewModel`, so a change in the editor shows here at once.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Check,
  ChevronRight,
  CircleHelp,
  CreditCard,
  Languages,
  Minus,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  Trash2,
  UtensilsCrossed,
} from 'lucide-react';
import {
  pickupLabel,
  type KioskConfig,
  type KioskMessage,
  type KioskTextKey,
  type MediaRef,
  type MessageScreen,
  type ResolvedThemeColors,
} from '@/lib/kioskConfig';
import type { PreviewScreen } from './editor-context';

/* ----------------------------------------------------------------- model */

export interface PProduct {
  id: string;
  name: string;
  price: number;
  imageUrl: string | null;
  soldOut: boolean;
  description: string | null;
  categoryId: string | null;
}

export interface PCategory {
  id: string;
  name: string;
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
  cart: PLine[];
  setCart: (lines: PLine[]) => void;
  service: 'take_away' | 'eat_in';
  setService: (s: 'take_away' | 'eat_in') => void;
}

/* --------------------------------------------------------------- helpers */

export function cartTotal(lines: PLine[]): number {
  return lines.reduce((s, l) => s + l.unit * l.qty, 0);
}

export function cartCount(lines: PLine[]): number {
  return lines.reduce((s, l) => s + l.qty, 0);
}

function messagesFor(cfg: KioskConfig, screen: MessageScreen, kinds: KioskMessage['kind'][], nowMs: number): KioskMessage[] {
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

/** A screen's own header image (`screenImages`), when set. */
function ScreenImage({ m, k, height = 96 }: { m: PreviewModel; k: keyof KioskConfig['screenImages']; height?: number }) {
  const ref = m.cfg.screenImages?.[k];
  if (!ref) return null;
  return (
    <div className="overflow-hidden" style={{ borderRadius: m.radius, height }}>
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

function MessageCard({ m, msg, compact = false }: { m: PreviewModel; msg: KioskMessage; compact?: boolean }) {
  const tone = STYLE_COLORS[msg.style];
  return (
    <div
      className="flex shrink-0 items-stretch overflow-hidden"
      style={{ ...cardStyle(m), background: tone.bg, color: tone.fg, width: compact ? 220 : '100%' }}
    >
      {msg.image ? <Img src={msg.image.url} className="w-20 shrink-0 object-cover" /> : null}
      <div className="min-w-0 flex-1 p-3">
        <div className="text-sm font-bold leading-snug">{msg.title || m.t('untitledMessage')}</div>
        {msg.body ? <div className="mt-0.5 line-clamp-2 text-xs opacity-80">{msg.body}</div> : null}
      </div>
      {msg.kind === 'banner' && msg.productId ? <ChevronRight className="m-2 h-4 w-4 self-center rotate-180 opacity-60" /> : null}
    </div>
  );
}

function BigButton({ m, children, onClick, variant = 'primary', className = '' }: {
  m: PreviewModel;
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'soft';
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-center gap-2 px-4 py-3 text-[15px] font-bold transition-transform duration-150 active:scale-[0.98] ${className}`}
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

/* ---------------------------------------------------------------- attract */

function PlaylistHero({ m }: { m: PreviewModel }) {
  const list = m.cfg.attract.playlist;
  const [index, setIndex] = useState(0);
  const i = list.length > 0 ? index % list.length : 0;
  const item = list[i];
  useEffect(() => {
    if (!item || list.length < 2 || item.media.kind === 'video') return;
    const id = window.setTimeout(() => setIndex((x) => x + 1), Math.max(2, item.durationSec) * 1000);
    return () => window.clearTimeout(id);
  }, [item, list.length]);

  if (!item) {
    return (
      <div
        className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden"
        style={{ borderRadius: m.radius, background: `linear-gradient(135deg, ${m.c.primary}, ${m.c.accent})` }}
      >
        <div className="absolute -start-10 -top-10 h-40 w-40 rounded-full bg-white/15 blur-2xl" />
        <div className="absolute -bottom-12 -end-8 h-44 w-44 rounded-full bg-black/10 blur-2xl" />
        <Logo m={m} size={64} />
      </div>
    );
  }
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden bg-black" style={{ borderRadius: m.radius }}>
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

export function AttractScreen({ m }: { m: PreviewModel }) {
  const { cfg } = m;
  const promos = messagesFor(cfg, 'attract', ['banner', 'notice'], m.nowMs);
  const langs = cfg.general.languages;
  const next = () => m.go(cfg.general.serviceTypes.length > 1 ? 'service' : 'catalog');
  const section = (s: string) => {
    if (s === 'hero') return <PlaylistHero key={s} m={m} />;
    if (s === 'promos') {
      return promos.length > 0 ? (
        <div key={s} className="-mx-4 flex gap-2.5 overflow-x-auto px-4 [scrollbar-width:none]">
          {promos.map((msg) => (
            <MessageCard key={msg.id} m={m} msg={msg} compact={promos.length > 1} />
          ))}
        </div>
      ) : null;
    }
    if (s === 'categories') {
      return m.categories.length > 0 ? (
        <div key={s} className="-mx-4 flex gap-2.5 overflow-x-auto px-4 [scrollbar-width:none]">
          {m.categories.slice(0, 8).map((cat) => (
            <div key={cat.id} className="w-20 shrink-0 text-center">
              <div className="mx-auto h-16 w-16 overflow-hidden" style={{ ...cardStyle(m), borderRadius: Math.max(12, m.radius) }}>
                {cat.imageUrl ? (
                  <Img src={cat.imageUrl} className="h-full w-full object-cover" />
                ) : (
                  <ProductImage m={m} p={cat.products[0] ?? { id: '', name: '', price: 0, imageUrl: null, soldOut: false, description: null, categoryId: null }} className="h-full w-full" />
                )}
              </div>
              <div className="mt-1 truncate text-[11px] font-medium">{cat.name}</div>
            </div>
          ))}
        </div>
      ) : null;
    }
    if (s === 'club' && cfg.club.enabled) {
      return (
        <div key={s} className="flex items-center gap-3 p-3" style={cardStyle(m)}>
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
      );
    }
    return null;
  };

  return (
    <ScreenBody
      m={m}
      footer={
        <div className="space-y-2">
          <BigButton m={m} onClick={next} className="kiosk-pulse py-4 text-lg">
            {m.txt('attractCta')}
          </BigButton>
        </div>
      }
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <Logo m={m} />
          <div className="flex items-center gap-1.5">
            {langs.length > 1 ? (
              <span className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium" style={{ ...buttonStyle(m, 'soft') }}>
                <Languages className="h-3.5 w-3.5" />
                {langs.map((l) => l.toUpperCase()).join(' · ')}
              </span>
            ) : null}
            {cfg.attract.showHelp ? (
              <span className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium" style={buttonStyle(m, 'soft')} title={m.txt('helpText')}>
                <CircleHelp className="h-3.5 w-3.5" /> {m.t('help')}
              </span>
            ) : null}
          </div>
        </div>
        <div>
          <h2 className="text-2xl font-extrabold leading-tight">{m.txt('attractTitle')}</h2>
          <p className="mt-1 text-sm" style={{ color: m.c.mutedText }}>
            {m.txt('attractSubtitle')}
          </p>
        </div>
        {cfg.attract.sections.map(section)}
      </div>
    </ScreenBody>
  );
}

/* ---------------------------------------------------------------- service */

export function ServiceScreen({ m }: { m: PreviewModel }) {
  const { cfg } = m;
  const types = cfg.general.serviceTypes;
  const notices = messagesFor(cfg, 'service', ['banner', 'notice'], m.nowMs);
  return (
    <ScreenBody m={m}>
      <div className="space-y-4 p-4">
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
        {notices.map((msg) => (
          <MessageCard key={msg.id} m={m} msg={msg} />
        ))}
      </div>
    </ScreenBody>
  );
}

/* ---------------------------------------------------------------- catalog */

function ProductCard({ m, p }: { m: PreviewModel; p: PProduct }) {
  const showDesc = m.cfg.theme.showDescriptions && p.description;
  const large = m.cfg.theme.gridDensity === 'large';
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
          <span className="absolute start-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold text-white">{m.t('soldOut')}</span>
        ) : (
          <span
            className="absolute bottom-2 end-2 flex h-7 w-7 items-center justify-center shadow-md transition-transform duration-150 group-hover:scale-110"
            style={{ ...buttonStyle(m), borderRadius: 999 }}
          >
            <Plus className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className={large ? 'space-y-1 p-3' : 'space-y-0.5 p-2'} style={p.soldOut ? { opacity: 0.6 } : undefined}>
        <div className={`line-clamp-2 font-bold leading-snug ${large ? 'text-base' : 'text-[13px]'}`}>{p.name}</div>
        {showDesc ? (
          <div className="line-clamp-2 text-[11px] leading-snug" style={{ color: m.c.mutedText }}>
            {p.description}
          </div>
        ) : null}
        <div className="text-[13px] font-bold tabular-nums" style={{ color: m.c.primary }}>
          {m.money(p.price)}
        </div>
      </div>
    </button>
  );
}

function CategoryNav({ m, active, onPick }: { m: PreviewModel; active: string | null; onPick: (id: string) => void }) {
  const style = m.cfg.theme.categoryStyle;
  if (style === 'images') {
    return (
      <div className="flex gap-2 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
        {m.categories.map((cat) => {
          const on = cat.id === active;
          return (
            <button key={cat.id} type="button" onClick={() => onPick(cat.id)} className="w-16 shrink-0 text-center">
              <div
                className="mx-auto h-12 w-12 overflow-hidden transition-all duration-200"
                style={{ borderRadius: Math.max(10, m.radius * 0.7), outline: on ? `2px solid ${m.c.button}` : 'none', outlineOffset: 2 }}
              >
                {cat.imageUrl ? (
                  <Img src={cat.imageUrl} className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full" style={{ background: `${m.c.primary}26` }} />
                )}
              </div>
              <div className="mt-1 truncate text-[10px] font-semibold" style={{ color: on ? m.c.button : m.c.text }}>
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
              className="shrink-0 border-b-2 pb-2 pt-1 text-[13px] font-semibold transition-colors duration-200"
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
            className="shrink-0 px-3.5 py-1.5 text-[13px] font-semibold transition-all duration-200"
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

export function CartBar({ m }: { m: PreviewModel }) {
  const count = cartCount(m.cart);
  if (count === 0) return null;
  return (
    <BigButton m={m} onClick={() => m.go(m.cfg.general.skipCart === 'off' ? 'cart' : 'pay')} className="justify-between shadow-lg animate-in slide-in-from-bottom-4 duration-300">
      <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-white/25 px-1.5 text-xs tabular-nums">{count}</span>
      <span>{m.cfg.general.skipCart === 'off' ? m.t('viewCart') : m.txt('checkoutCta')}</span>
      <span className="tabular-nums">{m.money(cartTotal(m.cart))}</span>
    </BigButton>
  );
}

export function CatalogScreen({ m, activeCategory, onCategory }: { m: PreviewModel; activeCategory: string | null; onCategory: (id: string) => void }) {
  const { cfg } = m;
  const banners = messagesFor(cfg, 'catalog', ['banner'], m.nowMs);
  const notices = messagesFor(cfg, 'catalog', ['notice'], m.nowMs);
  const current = m.categories.find((c) => c.id === activeCategory) ?? m.categories[0];
  const header = cfg.screenImages?.catalogHeader;
  return (
    <ScreenBody m={m} footer={<CartBar m={m} />}>
      <div className="sticky top-0 z-10 space-y-2 pb-1 pt-3 backdrop-blur-md" style={{ background: `${m.c.background}E6` }}>
        <div className="flex items-center gap-2 px-3">
          <Logo m={m} size={30} />
          <h2 className="flex-1 truncate text-lg font-extrabold">{m.txt('catalogTitle')}</h2>
          <span className="px-2 py-0.5 text-[11px] font-semibold" style={buttonStyle(m, 'soft')}>
            {m.service === 'take_away' ? m.txt('takeAwayLabel') : m.txt('eatInLabel')}
          </span>
        </div>
        {cfg.general.searchEnabled ? (
          <div className="mx-3 flex items-center gap-2 px-3 py-2 text-xs" style={{ ...cardStyle(m), borderRadius: 999, color: m.c.mutedText }}>
            <Search className="h-3.5 w-3.5" /> {m.t('search')}
          </div>
        ) : null}
        <CategoryNav m={m} active={current?.id ?? null} onPick={onCategory} />
      </div>
      <div className="space-y-4 px-3 pb-4 pt-1">
        {header ? (
          <div className="overflow-hidden" style={{ borderRadius: m.radius, height: 88 }}>
            <Img src={header.url} className="h-full w-full object-cover" />
          </div>
        ) : null}
        {banners.length > 0 ? (
          <div className="-mx-3 flex gap-2.5 overflow-x-auto px-3 [scrollbar-width:none]">
            {banners.map((msg) => (
              <MessageCard key={msg.id} m={m} msg={msg} compact={banners.length > 1} />
            ))}
          </div>
        ) : null}
        {notices.map((msg) => (
          <MessageCard key={msg.id} m={m} msg={msg} />
        ))}
        {m.featured.length > 0 ? (
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
        ) : null}
        {current ? (
          <section key={current.id} className="space-y-2 animate-in fade-in duration-300">
            <h3 className="text-sm font-extrabold">{current.name}</h3>
            <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${m.cols}, minmax(0, 1fr))` }}>
              {current.products.map((p) => (
                <ProductCard key={p.id} m={m} p={p} />
              ))}
            </div>
          </section>
        ) : (
          <p className="py-10 text-center text-sm" style={{ color: m.c.mutedText }}>
            {m.t('empty')}
          </p>
        )}
      </div>
    </ScreenBody>
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
}: {
  m: PreviewModel;
  product: PProduct;
  groups: PGroup[];
  allergens: string[];
  onClose: () => void;
  onAdd: (line: PLine) => void;
}) {
  const { cfg } = m;
  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(groups.map((g) => [g.id, g.min > 0 && g.options[0] ? [g.options[0].id] : []])),
  );
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState<string[]>([]);
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
  const quick = [m.t('quickNote1'), m.t('quickNote2'), m.t('quickNote3')];

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end">
      <button type="button" aria-label="close" className="absolute inset-0 bg-black/40 animate-in fade-in duration-200" onClick={onClose} />
      <div
        className="relative flex max-h-[90%] flex-col overflow-hidden animate-in slide-in-from-bottom duration-300"
        style={{ background: m.c.surface, color: m.c.text, borderTopLeftRadius: Math.max(16, m.radius), borderTopRightRadius: Math.max(16, m.radius) }}
      >
        <div className="absolute inset-x-0 top-2 z-10 mx-auto h-1.5 w-10 rounded-full bg-white/80 shadow" />
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
          <div className="w-full" style={{ aspectRatio: m.ratio }}>
            <ProductImage m={m} p={product} className="h-full w-full" />
          </div>
          <div className="space-y-4 p-4">
            <div>
              <h3 className="text-xl font-extrabold leading-tight">{product.name}</h3>
              {cfg.theme.showDescriptions && product.description ? (
                <p className="mt-1 text-sm" style={{ color: m.c.mutedText }}>
                  {product.description}
                </p>
              ) : null}
              <div className="mt-1.5 font-bold tabular-nums" style={{ color: m.c.primary }}>
                {m.money(product.price)}
              </div>
              {cfg.general.showAllergens && allergens.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  <span className="text-[11px]" style={{ color: m.c.mutedText }}>
                    {m.t('allergens')}:
                  </span>
                  {allergens.map((a) => (
                    <span key={a} className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: '#FEF3C7', color: '#92400E' }}>
                      {a}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            {groups.map((g) => (
              <div key={g.id} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">{g.name}</span>
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
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
            {cfg.general.quickNotesEnabled ? (
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
              <div className="px-3 py-2.5 text-xs" style={{ border: `1px solid ${m.c.border}`, borderRadius: Math.min(m.radius, 14), color: m.c.mutedText }}>
                {m.t('notePlaceholder')}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-3 border-t p-3" style={{ borderColor: m.c.border }}>
          <Stepper m={m} value={qty} onChange={(n) => setQty(Math.max(1, n))} />
          <BigButton
            m={m}
            onClick={() =>
              onAdd({
                key: `${product.id}-${Date.now()}`,
                product,
                qty,
                unit,
                extras: [...extras.map((o) => o.name), ...notes],
              })
            }
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
    <div className="absolute inset-0 z-30 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40 animate-in fade-in duration-200" />
      <div
        className="relative space-y-3 p-4 animate-in slide-in-from-bottom duration-300"
        style={{ background: m.c.surface, color: m.c.text, borderTopLeftRadius: Math.max(16, m.radius), borderTopRightRadius: Math.max(16, m.radius) }}
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

/* ------------------------------------------------------------------- cart */

export function CartScreen({ m, upsell }: { m: PreviewModel; upsell: PProduct[] }) {
  const { cfg } = m;
  const total = cartTotal(m.cart);
  const min = cfg.payment.minOrderAgorot / 100;
  const below = min > 0 && total < min;
  const notices = messagesFor(cfg, 'cart', ['banner', 'notice'], m.nowMs);
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
          <BigButton m={m} onClick={() => m.go('pay')} className={below || m.cart.length === 0 ? 'opacity-50' : ''}>
            <span>{m.txt('checkoutCta')}</span>
            <span className="tabular-nums">· {m.money(total)}</span>
          </BigButton>
        </div>
      }
    >
      <div className="space-y-4 p-4">
        <ScreenImage m={m} k="cart" height={80} />
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold">{m.txt('cartTitle')}</h2>
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
                  <div className="truncate text-[11px]" style={{ color: m.c.mutedText }}>
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
        {notices.map((msg) => (
          <MessageCard key={msg.id} m={m} msg={msg} />
        ))}
        {askName || askPhone || (m.service === 'eat_in' && cfg.general.askTableNumber) ? (
          <section className="space-y-2">
            <h3 className="text-sm font-extrabold">{m.txt('customerTitle')}</h3>
            <p className="text-[11px] leading-snug" style={{ color: m.c.mutedText }}>
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

export function PayScreen({ m }: { m: PreviewModel }) {
  const { cfg } = m;
  const [tip, setTip] = useState<number | null>(null);
  const base = cartTotal(m.cart);
  const tipAmount = tip ? Math.round(base * tip) / 100 : 0;
  const notices = messagesFor(cfg, 'pay', ['banner', 'notice'], m.nowMs);
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
        <div className="relative my-2 h-40 w-40">
          <div className="absolute inset-0 rounded-full kiosk-ring" style={{ background: `${m.c.button}14` }} />
          <div
            className="absolute inset-x-6 bottom-4 top-14 flex items-end justify-center pb-2 shadow-lg"
            style={{ background: m.cfg.theme.mode === 'dark' ? '#2A303B' : '#1F2937', borderRadius: 18 }}
          >
            <span className="h-1.5 w-14 rounded-full bg-emerald-400/80" />
          </div>
          <div
            className="kiosk-card absolute left-1/2 top-2 flex h-14 w-24 flex-col justify-between p-2 shadow-xl"
            style={{ background: `linear-gradient(135deg, ${m.c.primary}, ${m.c.accent})`, borderRadius: 10, color: '#fff' }}
          >
            <CreditCard className="h-4 w-4" />
            <span className="text-[8px] tracking-widest">•••• 4242</span>
          </div>
        </div>
        <p className="text-base font-bold">{m.txt('payInstruction')}</p>
        <p className="text-[11px]" style={{ color: m.c.mutedText }}>
          {m.t('cardOnly')}
        </p>
        {notices.map((msg) => (
          <MessageCard key={msg.id} m={m} msg={msg} />
        ))}
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
  const label = pickupLabel(cfg.pickup.prefix, Number.isFinite(cfg.pickup.start) ? cfg.pickup.start : 1);
  const notices = messagesFor(cfg, 'success', ['banner', 'notice'], m.nowMs);
  const receipt = cfg.payment.receiptPolicy;
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
        <div className="flex flex-wrap justify-center gap-1.5 text-[11px]">
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
        {receipt === 'ask' ? (
          <div className="w-full space-y-2">
            <div className="text-sm font-semibold">{m.t('receiptAsk')}</div>
            <div className="grid grid-cols-2 gap-2">
              <BigButton m={m} variant="soft">
                {m.t('receiptNo')}
              </BigButton>
              <BigButton m={m}>{m.t('receiptYes')}</BigButton>
            </div>
          </div>
        ) : null}
        {notices.map((msg) => (
          <MessageCard key={msg.id} m={m} msg={msg} />
        ))}
        <p className="mt-auto text-[11px]" style={{ color: m.c.mutedText }}>
          {m.t('resetsIn', { n: cfg.timers.successSec })}
        </p>
      </div>
    </ScreenBody>
  );
}

/* ----------------------------------------------------------------- paused */

export function PausedScreen({ m, variant }: { m: PreviewModel; variant: 'paused' | 'closed' }) {
  const { cfg } = m;
  const title =
    variant === 'paused' ? cfg.operations.pausedTitle || m.txt('pausedTitle') : m.txt('closedTitle');
  const body = variant === 'paused' ? cfg.operations.pausedBody || m.txt('pausedBody') : m.txt('closedBody');
  const closed = messagesFor(cfg, 'paused', ['closed', 'notice', 'banner'], m.nowMs);
  const image = cfg.screenImages?.paused;
  return (
    <ScreenBody m={m}>
      <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
        {image ? (
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
        {closed.map((msg) => (
          <MessageCard key={msg.id} m={m} msg={msg} />
        ))}
      </div>
    </ScreenBody>
  );
}

/** The keyframes the preview's small animations use. */
export const PREVIEW_CSS = `
@keyframes kioskCardTap { 0%, 15% { transform: translate(-50%, -6px) rotate(-8deg); } 45%, 60% { transform: translate(-50%, 34px) rotate(0deg); } 85%, 100% { transform: translate(-50%, -6px) rotate(-8deg); } }
@keyframes kioskRing { 0% { transform: scale(0.85); opacity: 0.9; } 100% { transform: scale(1.15); opacity: 0; } }
@keyframes kioskPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.025); } }
@keyframes kioskPop { 0% { transform: scale(0.4); opacity: 0; } 70% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); } }
.kiosk-card { animation: kioskCardTap 2.6s ease-in-out infinite; transform: translate(-50%, -6px); }
.kiosk-ring { animation: kioskRing 1.8s ease-out infinite; }
.kiosk-pulse { animation: kioskPulse 2.4s ease-in-out infinite; }
.kiosk-pop { animation: kioskPop 0.5s cubic-bezier(.2,.9,.3,1.2) both; }
@media (prefers-reduced-motion: reduce) { .kiosk-card, .kiosk-ring, .kiosk-pulse, .kiosk-pop { animation: none; } }
`;
