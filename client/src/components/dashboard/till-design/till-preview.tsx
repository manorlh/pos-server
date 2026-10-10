'use client';

/**
 * The live preview: the till's order screen at the profile's real size (360×640, 1280×800,
 * 800×1280, 768×1024, 1024×768), scaled to fit its column, rendered from the draft through
 * `forProfile` — the template, its bill position and style, the tiles, the columns, the action
 * bar, the colours, the texts, the fields, the menu order and the favourites — on the real
 * catalog of a till in scope when it has loaded, else the owner's sample (brief §6). A small
 * working till: a tap adds (the next quantity, to the chosen seat), − / + change new lines, the
 * categories filter, the summary opens.
 */

import { useMemo, useReducer, type CSSProperties, type ReactNode } from 'react';
import type { KioskSourceCatalog } from '@/lib/kioskApi';
import type { Mode, Profile, TillDesignConfig, TillDesignLegacy } from '@/lib/tillDesign';
import { FONT, useBoxSize } from './preview-atoms';
import { CleanScreen } from './preview-clean';
import { DesignedScreen } from './preview-designed';
import {
  buildPreviewModel,
  catalogProducts,
  initialState,
  reducePreview,
  tokensFor,
  SAMPLE_PRODUCTS,
  type PreviewEvent,
  type PreviewModel,
} from './preview-model';

const NOOP = () => undefined;

/** One till screen at its real size (no scaling). */
export function TillScreen({ m, d = NOOP }: { m: PreviewModel; d?: (e: PreviewEvent) => void }) {
  return (
    <div
      dir="rtl"
      lang="he"
      style={{
        width: m.W,
        height: m.H,
        position: 'relative',
        overflow: 'hidden',
        background: m.t.bg,
        color: m.t.ink,
        fontFamily: FONT,
        textAlign: 'start',
        lineHeight: 1.35,
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {m.view.template === 'clean' ? <CleanScreen m={m} d={d} /> : <DesignedScreen m={m} d={d} />}
    </div>
  );
}

/**
 * `children` (width × height) scaled down to fit the box's width and `maxHeight`, inside a thin
 * device frame when `frame`.
 */
export function ScaledScreen({
  width,
  height,
  maxHeight,
  frame = true,
  children,
}: {
  width: number;
  height: number;
  maxHeight?: number;
  frame?: boolean;
  children: ReactNode;
}) {
  const [ref, size] = useBoxSize<HTMLDivElement>();
  const bezel = frame ? 10 : 0;
  const fitW = size.w > 0 ? (size.w - 2 * bezel) / width : 0;
  const fitH = maxHeight ? (maxHeight - 2 * bezel) / height : Infinity;
  const scale = Math.max(0.05, Math.min(1, fitW, fitH));
  return (
    <div ref={ref} style={{ width: '100%' }}>
      {size.w > 0 ? (
        <div
          style={{
            width: width * scale + 2 * bezel,
            height: height * scale + 2 * bezel,
            marginInline: 'auto',
            padding: bezel,
            borderRadius: frame ? 18 : 0,
            background: frame ? '#1F242D' : 'transparent',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ width: width * scale, height: height * scale, overflow: 'hidden', borderRadius: frame ? 8 : 0, position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, width, height, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
              {children}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface TillPreviewProps {
  cfg: TillDesignConfig;
  profile: Profile;
  mode: Mode;
  catalog?: KioskSourceCatalog | null;
  legacy?: TillDesignLegacy | null;
  brandColor?: string | null;
  maxHeight?: number;
}

/**
 * The working preview. Its order lives here; give it a `key` of the mode and the catalog so a
 * switch starts the order afresh (a template or profile switch keeps it, as rotation does on
 * the till).
 */
export function TillPreview({ cfg, profile, mode, catalog, legacy, brandColor, maxHeight }: TillPreviewProps) {
  const products = useMemo(() => catalogProducts(catalog)?.products ?? SAMPLE_PRODUCTS, [catalog]);
  const [state, dispatch] = useReducer(reducePreview, undefined, () => initialState(products, mode));
  const m = buildPreviewModel({ cfg, profile, mode, catalog, legacy, brandColor, state });
  return (
    <ScaledScreen width={m.W} height={m.H} maxHeight={maxHeight}>
      <TillScreen m={m} d={dispatch} />
    </ScaledScreen>
  );
}

/** A template's thumbnail: the same screen, small and still (the picker's cards). */
export function TemplateThumb({
  cfg,
  template,
  profile,
  mode,
  catalog,
  legacy,
  brandColor,
  height = 150,
}: {
  cfg: TillDesignConfig;
  template: string;
  profile: Profile;
  mode: Mode;
  catalog?: KioskSourceCatalog | null;
  legacy?: TillDesignLegacy | null;
  brandColor?: string | null;
  height?: number;
}) {
  const m = useMemo(
    () => buildPreviewModel({ cfg, profile, mode, catalog, legacy, brandColor, template }),
    [cfg, profile, mode, catalog, legacy, brandColor, template],
  );
  return (
    <div aria-hidden inert style={{ pointerEvents: 'none' }}>
      <ScaledScreen width={m.W} height={m.H} maxHeight={height} frame={false}>
        <TillScreen m={m} />
      </ScaledScreen>
    </div>
  );
}

/**
 * A phase-2 template's thumbnail ("בקרוב"): a schematic in the draft's colours — the course
 * lanes, the payment dock with banknotes, the night screen, the big photo cards.
 */
export function Phase2Thumb({ cfg, template, height = 150 }: { cfg: TillDesignConfig; template: string; height?: number }) {
  const night = template === 'night';
  const t = tokensFor(night ? { colors: { ...cfg.colors, mode: 'dark' } } : cfg);
  const block = (style: CSSProperties, key?: string | number) => (
    <div key={key} style={{ borderRadius: 3, border: `1px solid ${t.border}`, background: t.surface, ...style }} />
  );
  const w = Math.round(height * 0.75);
  let body: ReactNode;
  if (template === 'courses') {
    body = (
      <div style={{ display: 'flex', gap: 4, height: '100%' }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ height: 6, borderRadius: 2, background: i === 1 ? t.accent : t.border }} />
            {block({ height: 18 })}
            {block({ height: 18 })}
            {i < 2 ? block({ height: 18 }) : null}
          </div>
        ))}
      </div>
    );
  } else if (template === 'payDock') {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: '100%' }}>
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 3 }}>
          {Array.from({ length: 9 }, (_, i) => block({}, i))}
        </div>
        <div style={{ display: 'flex', gap: 3, height: 22 }}>
          <div style={{ flex: 1.4, borderRadius: 3, background: t.accent }} />
          {[0, 1, 2].map((i) => block({ flex: 1 }, i))}
        </div>
      </div>
    );
  } else if (template === 'visual') {
    body = (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, height: '100%' }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ borderRadius: 3, border: `1px solid ${t.border}`, background: t.surface, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, background: t.tint }} />
            <div style={{ height: 8, margin: 3, borderRadius: 2, background: t.border }} />
          </div>
        ))}
      </div>
    );
  } else {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: '100%' }}>
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
          {[0, 1, 2, 3].map((i) => block({}, i))}
        </div>
        <div style={{ height: 22, borderRadius: 3, background: t.accent }} />
      </div>
    );
  }
  return (
    <div aria-hidden style={{ display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: w, height, padding: 6, background: t.bg, borderRadius: 6, border: `1px solid ${t.border}`, boxSizing: 'border-box', opacity: 0.75 }}>{body}</div>
    </div>
  );
}
