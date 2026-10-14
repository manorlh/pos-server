'use client';

/**
 * "הנפשות": the Motion Engine's names in Hebrew (he.json `kiosks.motion.*`), an icon per event and
 * group, the events the big live preview can play, and the small formats the screen shares.
 */

import { useTranslations } from 'next-intl';
import {
  Armchair,
  ArrowLeftRight,
  ArrowRightLeft,
  ChevronsDown,
  CircleArrowLeft,
  CircleCheckBig,
  CreditCard,
  Hand,
  Hash,
  Hourglass,
  House,
  Layers,
  LayoutGrid,
  Loader,
  LoaderCircle,
  MessageSquareText,
  MousePointerClick,
  PackagePlus,
  PackageX,
  PanelTop,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  SquareCheck,
  Tag,
  Timer,
  Trash2,
  TriangleAlert,
  Utensils,
  type LucideIcon,
} from 'lucide-react';
import type {
  MotionDirection,
  MotionEasing,
  MotionEventKey,
  MotionFallback,
  MotionGlobalSpeed,
  MotionParam,
  MotionPreset,
  MotionSurface,
  MotionType,
} from '@/lib/kioskMotionEngine';
import type { MotionEventGroup } from '@/lib/kioskMotionEditor';
import type { MotionDemo } from './kiosk-preview';

export const MOTION_EVENT_ICONS: Record<MotionEventKey, LucideIcon> = {
  productPress: MousePointerClick,
  addToCart: PackagePlus,
  cartBadge: ShoppingCart,
  toast: MessageSquareText,
  modalOpen: PanelTop,
  select: SquareCheck,
  quantityChange: Hash,
  priceChange: Tag,
  categorySwitch: ArrowLeftRight,
  itemsEnter: LayoutGrid,
  cartOpen: ShoppingBag,
  remove: Trash2,
  continueReady: CircleArrowLeft,
  error: TriangleAlert,
  serviceChoice: Utensils,
  upsell: Sparkles,
  pageTransition: Layers,
  payment: CreditCard,
  paymentProgress: LoaderCircle,
  success: CircleCheckBig,
  idle: Hand,
  timeout: Timer,
  soldOut: PackageX,
  loading: Loader,
  scrollHint: ChevronsDown,
  homeReturn: House,
  tableOpen: Armchair,
  tabSwitch: ArrowRightLeft,
};

export const MOTION_GROUP_ICONS: Record<MotionEventGroup, LucideIcon> = {
  products: ShoppingCart,
  navigation: Layers,
  payment: CreditCard,
  waiting: Hourglass,
};

/** "הצג בתצוגה המקדימה": the events the big live preview plays through its own screens. */
export const LIVE_PREVIEW_DEMOS: Partial<Record<MotionEventKey, MotionDemo>> = {
  categorySwitch: 'categorySwitch',
  itemsEnter: 'itemsEnter',
  pageTransition: 'screenChange',
  modalOpen: 'sheet',
  addToCart: 'addToCart',
};

/** A multiplier as the screen writes it: "1.30". */
export function formatMultiplier(k: number): string {
  return k.toFixed(2);
}

/** A translator of the motion screen's keys (`kiosks.motion.*`, the till's `tillDesign.motion.*` over them). */
export type MotionT = ((key: string, values?: Record<string, string | number>) => string) & { has: (key: string) => boolean };

/**
 * The Motion Engine's words. On the till (`surface: 'till'`) its own words come first — "עיצוב קופה" →
 * "הנפשות" (he.json `tillDesign.motion.*`): its screen's title and hints, its events' descriptions where they
 * mean a till's (payment: the payment screen rising), its presets ("legacy" is today's till), its stage.
 */
export function useMotionText(surface: MotionSurface = 'kiosk') {
  const k = useTranslations('kiosks.motion');
  const till = useTranslations('tillDesign.motion');
  const own = surface === 'till';
  /** A key of the screen: the till's own wording when it has one, else the kiosk's. */
  const t: MotionT = Object.assign(
    (key: string, values?: Record<string, string | number>) => (own && till.has(key) ? till(key, values) : k(key, values)),
    { has: (key: string) => (own && till.has(key)) || k.has(key) },
  );
  return {
    t,
    surface,
    eventName: (e: MotionEventKey) => t(`events.${e}.name`),
    eventDesc: (e: MotionEventKey) => t(`events.${e}.desc`),
    kind: (kind: MotionType) => t(`kinds.${kind}`),
    param: (p: MotionParam) => t(`params.${p}`),
    direction: (d: MotionDirection) => t(`directions.${d}`),
    easing: (e: MotionEasing) => t(`easings.${e}`),
    fallback: (f: MotionFallback) => t(`fallbacks.${f}`),
    presetName: (p: MotionPreset) => t(`presets.${p}.name`),
    presetDesc: (p: MotionPreset) => t(`presets.${p}.desc`),
    group: (g: MotionEventGroup) => t(`groups.${g}`),
    globalSpeed: (s: MotionGlobalSpeed) => t(`globalSpeeds.${s}`),
  };
}

export type MotionText = ReturnType<typeof useMotionText>;
