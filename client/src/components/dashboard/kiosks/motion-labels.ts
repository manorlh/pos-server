'use client';

/**
 * "הנפשות": the Motion Engine's names in Hebrew (he.json `kiosks.motion.*`), an icon per event and
 * group, the events the big live preview can play, and the small formats the screen shares.
 */

import { useTranslations } from 'next-intl';
import {
  ArrowLeftRight,
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

/** The Motion Engine's words. */
export function useMotionText() {
  const t = useTranslations('kiosks.motion');
  return {
    t,
    eventName: (e: MotionEventKey) => t(`events.${e}.name`),
    eventDesc: (e: MotionEventKey) => t(`events.${e}.desc`),
    kind: (k: MotionType) => t(`kinds.${k}`),
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
