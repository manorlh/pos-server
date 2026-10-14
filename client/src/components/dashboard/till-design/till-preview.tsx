'use client';

/**
 * The live preview: the till's order screen at the profile's real size (360×640, 1280×800,
 * 800×1280, 768×1024, 1024×768), scaled to fit its column, rendered from the draft through
 * `forProfile` — the template, its bill position and style, the tiles, the columns, the action
 * bar, the colours, the texts, the fields, the menu order and the favourites — on the real
 * catalog of a till in scope when it has loaded, else the owner's sample (brief §6). A small
 * working till: a tap adds (the next quantity, to the chosen seat), − / + change new lines, the
 * categories filter, the summary opens. Phase 2's four templates draw through preview-phase2.tsx;
 * "לוח מנות" in a quick order is "נקי", as on the till.
 */

import { useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { KioskSourceCatalog } from '@/lib/kioskApi';
import { PHASE2_NEW_TEMPLATES, forProfile, type Mode, type Profile, type Template, type TillDesignConfig, type TillDesignLegacy } from '@/lib/tillDesign';
import { FONT, useBoxSize } from './preview-atoms';
import { CleanScreen } from './preview-clean';
import { DesignedScreen } from './preview-designed';
import { Phase2Screen } from './preview-phase2';
import {
  buildPreviewModel,
  catalogProducts,
  initialState,
  reducePreview,
  SAMPLE_PRODUCTS,
  showcaseProductId,
  type PreviewEvent,
  type PreviewModel,
} from './preview-model';
import { InfoSheet, useTileFonts } from './preview-tile-text';

const NOOP = () => undefined;

/** One till screen at its real size (no scaling); the item's sheet ("תג i") over it when open. */
export function TillScreen({ m, d = NOOP }: { m: PreviewModel; d?: (e: PreviewEvent) => void }) {
  useTileFonts();
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
      {m.view.template === 'clean' ? (
        <CleanScreen m={m} d={d} />
      ) : PHASE2_NEW_TEMPLATES.includes(m.view.template) ? (
        <Phase2Screen m={m} d={d} />
      ) : (
        <DesignedScreen m={m} d={d} />
      )}
      <InfoSheet m={m} d={d} />
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
  /** "לוח מנות": the company's courses ("שלבי הגשה"). */
  courseNames?: string[];
  /** "תג i": a count the editor bumps to open the item's sheet on the longest name (0: never asked). */
  openInfo?: number;
}

/** What a mode of a profile draws: "לוח מנות" has no courses in a quick order — "נקי" there. */
export function drawnTemplate(cfg: TillDesignConfig, profile: Profile, mode: Mode): Template | undefined {
  return mode === 'quick' && forProfile(cfg, profile).template === 'courses' ? 'clean' : undefined;
}

/**
 * The working preview. Its order lives here; give it a `key` of the mode and the catalog so a
 * switch starts the order afresh (a template or profile switch keeps it, as rotation does on
 * the till).
 */
export function TillPreview({ cfg, profile, mode, catalog, legacy, brandColor, maxHeight, courseNames, openInfo = 0 }: TillPreviewProps) {
  const products = useMemo(() => catalogProducts(catalog)?.products ?? SAMPLE_PRODUCTS, [catalog]);
  const [state, dispatch] = useReducer(reducePreview, undefined, () => initialState(products, mode, forProfile(cfg, profile).template));
  // "פתח את חלון התיאור": the sheet of the product with the longest name (the case it is for) — on a new
  // request only, not again when the preview starts afresh (another mode or catalog).
  const handled = useRef(openInfo);
  useEffect(() => {
    if (openInfo === handled.current) return;
    handled.current = openInfo;
    dispatch({ type: 'info', productId: showcaseProductId(products) });
  }, [openInfo, products]);
  const forced = drawnTemplate(cfg, profile, mode);
  const m = buildPreviewModel({ cfg, profile, mode, catalog, legacy, brandColor, state, courseNames, template: forced });
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
    // "לוח מנות" is a table's screen: its card shows the lanes whatever the preview's mode.
    () => buildPreviewModel({ cfg, profile, mode: template === 'courses' ? 'table' : mode, catalog, legacy, brandColor, template }),
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
