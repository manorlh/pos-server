'use client';

/**
 * The live preview: the kiosk's screens in a phone or tablet frame, rendered from the
 * config being edited (not the saved one), on the real catalog of the shop's till when
 * there is one. A small working kiosk: tap the CTA, pick a product, add (with the
 * add-to-cart motion), pay on the pinpad beside the screen.
 */

import { layoutOf, productColumns } from '@/lib/kioskLayout';
import { useCallback, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Smartphone, Tablet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import { fetchGroups, fetchProductMenu, fetchUpsells } from '@/lib/menuApi';
import { enterCategory, pickKioskUpsell, type UpsellMoment, type UpsellPick, type UpsellRuleLite } from '@/lib/kioskUpsell';
import {
  aspectRatioCss,
  buttonRadius,
  cartPanelShown,
  categoryRailImage,
  checkoutStepsNow,
  ctaBox,
  fontStack,
  catalogColumns,
  kioskCatalogView,
  messagePlacement,
  addMs,
  motionSpec,
  kioskRenderProfile,
  profileMotion,
  pickupLabel,
  resolveThemeColors,
  stepMode,
  tickerBandPx,
  transitionSpec,
  upsellStepModeKey,
  typeScaleFactor,
  typeWeights,
  type DietaryTag,
  type KioskConfig,
  type KioskFont,
  type KioskTextKey,
  type MessageScreen,
} from '@/lib/kioskConfig';
import type { KioskSourceCatalog } from '@/lib/kioskApi';
import type { PreviewScreen } from './editor-context';
import {
  AttractCta,
  AttractServiceButtons,
  AttractScreen,
  CartScreen,
  ConfirmSheet,
  Flyer,
  KioskBackdrop,
  KioskWallpaper,
  KioskStatusBar,
  MessageOverlay,
  UpsellWindow,
  PausedScreen,
  PayScreen,
  PREVIEW_CSS,
  ServiceScreen,
  serviceAsked,
  serviceOnAttractOf,
  SuccessScreen,
  TipScreen,
  chromeRoot,
  statusLinePx,
  type Flight,
  type PausedVariant,
  type PCategory,
  type PGroup,
  type PLine,
  type PProduct,
  type PreviewModel,
} from './preview-screens';
import { DetailsPreview, detailsFields } from './preview-entry';
import { GuidedFrame, LayoutCatalog, LayoutProductSheet, ReachFrame, ReachSheets, ReachToggle } from '@/kiosk-shared/layouts';
import { configuredText, defaultText, kioskTextOf, webTextIn } from '@/lib/kioskTexts';
import { KioskSwap, screenOrder } from './preview-motion';
import { PREVIEW_FOOTER_PX, TickerFrame } from './preview-ticker';
import { useGoogleFonts } from './use-google-fonts';

/** "הצג" in "הנפשות ומעברים": the transition the preview plays on demand. */
export type MotionDemo = 'categorySwitch' | 'itemsEnter' | 'screenChange' | 'sheet' | 'addToCart' | 'speed';

/** What the editor can ask of the live preview. */
export interface KioskPreviewControls {
  play: (demo: MotionDemo) => void;
}

const SCREENS: PreviewScreen[] = ['attract', 'service', 'catalog', 'product', 'cart', 'tip', 'details', 'pay', 'success', 'paused'];
const PAUSED_VARIANTS: PausedVariant[] = ['paused', 'closed', 'noPayment', 'offline'];

type Frame = 'phone' | 'tablet';

const FRAME_SIZE: Record<Frame, { w: number; h: number }> = {
  phone: { w: 300, h: 620 },
  tablet: { w: 400, h: 600 },
};

/**
 * The device each frame stands for, in dp, for the till's width rules: a phone and a PORTRAIT
 * tablet. The side order panel needs a wide (landscape) screen on the till (900 dp and up), so
 * both frames show the bar, as the till does on them.
 */
const FRAME_DEVICE_DP: Record<Frame, number> = { phone: 360, tablet: 800 };

/** The preview's sample pause ("הפסקה"): ending in half an hour, on a round five minutes — so "נחזור ב-HH:MM" shows. */
function samplePauseEnd(nowMs: number): string {
  const step = 5 * 60_000;
  return new Date(Math.ceil((nowMs + 30 * 60_000) / step) * step).toISOString();
}

/** Demo data when there is no till to read a catalog from. */
function useSampleCatalog(): { categories: { id: string; name: string }[]; products: PProduct[] } {
  const t = useTranslations('kiosks.preview.sample');
  return useMemo(() => {
    const categories = [
      { id: 's-burgers', name: t('cat1') },
      { id: 's-drinks', name: t('cat2') },
      { id: 's-desserts', name: t('cat3') },
    ];
    const p = (id: string, categoryId: string, price: number, tags: DietaryTag[], soldOut = false, desc = false): PProduct => ({
      id,
      name: t(id),
      price,
      imageUrl: null,
      soldOut,
      description: desc ? t(`${id}d`) : null,
      categoryId,
      dietaryTags: tags,
      addPath: SAMPLE_SIMPLE.has(id) ? 'direct' : 'sheet',
    });
    return {
      categories,
      products: [
        p('p1', 's-burgers', 54, ['meat'], false, true),
        p('p2', 's-burgers', 59, ['meat', 'spicy'], false, true),
        p('p3', 's-burgers', 49, ['vegan', 'gluten_free'], true, true),
        p('p4', 's-drinks', 12, ['vegan', 'gluten_free']),
        p('p5', 's-drinks', 16, ['vegan'], false, true),
        p('p6', 's-desserts', 28, ['vegetarian', 'dairy'], false, true),
      ],
    };
  }, [t]);
}

/** The sample dishes with nothing to choose (no size, no extras): their "+" adds straight in. */
const SAMPLE_SIMPLE = new Set(['p4', 'p5', 'p6']);

/** The modifier groups and allergens of a real product, for the product sheet; sample ones otherwise. */
function useProductGroups(productId: string | null, real: boolean): { groups: PGroup[]; allergens: string[] } {
  const ts = useTranslations('kiosks.preview.sample');
  const ta = useTranslations('menu.allergens');
  const menu = useQuery({
    queryKey: ['kiosk-preview-menu', productId],
    queryFn: () => fetchProductMenu(productId as string),
    enabled: real && !!productId,
    retry: false,
    staleTime: 60_000,
  });
  const groups = useQuery({
    queryKey: ['kiosk-preview-groups'],
    queryFn: fetchGroups,
    enabled: real && !!productId,
    retry: false,
    staleTime: 60_000,
  });
  return useMemo(() => {
    if (!real) {
      if (productId && SAMPLE_SIMPLE.has(productId)) return { groups: [], allergens: [ta('gluten')] };
      return {
        groups: [
          {
            id: 'g-size',
            name: ts('groupSize'),
            min: 1,
            max: 1,
            options: [
              { id: 'o-reg', name: ts('optRegular'), price: 0 },
              { id: 'o-large', name: ts('optLarge'), price: 8 },
            ],
          },
          {
            id: 'g-extras',
            name: ts('groupExtras'),
            min: 0,
            max: 3,
            options: [
              { id: 'o-cheese', name: ts('optCheese'), price: 5 },
              { id: 'o-onion', name: ts('optOnion'), price: 4 },
              { id: 'o-egg', name: ts('optEgg'), price: 6 },
            ],
          },
        ],
        allergens: [ta('gluten'), ta('sesame')],
      };
    }
    const m = menu.data;
    const all = groups.data?.items ?? [];
    if (!m) return { groups: [], allergens: [] };
    const ids = m.links.mode === 'groups' ? m.links.groupIds : m.links.mode === 'inherit' ? m.links.inheritedGroupIds : [];
    const out: PGroup[] = [];
    for (const id of ids) {
      const g = all.find((x) => x.id === id && x.isActive);
      if (!g) continue;
      out.push({
        id: g.id,
        name: g.name,
        min: g.minSelect,
        max: g.kind === 'choice' && g.maxSelect === null ? 1 : g.maxSelect,
        options: g.options.filter((o) => o.isActive).map((o) => ({ id: o.id, name: o.name, price: o.price })),
      });
    }
    const allergens = (m.allergens ?? []).map((a) => (ta.has(a) ? ta(a) : a));
    return { groups: out, allergens };
  }, [real, productId, menu.data, groups.data, ts, ta]);
}

export function KioskPreview({
  config,
  catalog,
  categoryImageUrls,
  fonts,
  screen,
  onScreen,
  brandName,
  nowMs,
  onCtaMove,
  controls,
  previewLang = 'he',
}: {
  config: KioskConfig;
  catalog: KioskSourceCatalog | null;
  categoryImageUrls: Record<string, string>;
  fonts: KioskFont[];
  screen: PreviewScreen;
  onScreen: (s: PreviewScreen) => void;
  brandName: string;
  nowMs: number;
  /** Dragging the attract button in a custom place: its new centre, in percent. */
  onCtaMove?: (x: number, y: number) => void;
  /** "הצג" of "הנפשות ומעברים": the editor plays a transition here. */
  controls?: Ref<KioskPreviewControls>;
  /** The texts editor's language tab: the screens' words in it (lib/kioskTexts.ts). */
  previewLang?: string;
}) {
  const t = useTranslations('kiosks.preview');
  const tb = useTranslations('kiosks.builtin');
  const sample = useSampleCatalog();
  const [frame, setFrame] = useState<Frame>('phone');
  const [cart, setCart] = useState<PLine[]>([]);
  const [service, setService] = useState<'take_away' | 'eat_in'>('take_away');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pausedVariant, setPausedVariant] = useState<PausedVariant>('paused');
  const [visit, setVisit] = useState(0);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [cartBump, setCartBump] = useState(0);
  /** The tip chosen on the preview's tip step (shown on its pay screen). */
  const [previewTip, setPreviewTip] = useState(0);
  /** "נגיש": this customer's ♿ (layout.reachToggle), back as configured on the attract screen. */
  const [reachToggled, setReachToggled] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const cartTargetRef = useRef<HTMLDivElement | null>(null);
  const setCartTarget = useCallback((el: HTMLDivElement | null) => {
    cartTargetRef.current = el;
  }, []);
  const justAddedTimer = useRef<number | null>(null);
  const flightSeq = useRef(0);
  // "הגדלת מכירה": the window up, and the rules asked and steps reached in this order.
  const [upsellWin, setUpsellWin] = useState<{ pick: UpsellPick; then: PreviewScreen | null; added: Record<string, number>; moment?: UpsellMoment } | null>(null);
  const upsellAsked = useRef<string[]>([]);
  const upsellSteps = useRef<string[]>([]);

  const font = fonts.find((f) => f.id === config.theme.font);
  useGoogleFonts([font]);

  const real = !!catalog && catalog.products.length > 0;
  const view = useMemo(() => {
    const source = real
      ? {
          categories: catalog!.categories,
          products: catalog!.products.map(
            (p): PProduct & { available: boolean } => ({
              id: p.id,
              name: p.name,
              price: p.price,
              imageUrl: p.imageUrl,
              soldOut: !p.available,
              description: p.description,
              categoryId: p.categoryId,
              dietaryTags: p.dietaryTags,
              available: p.available,
            }),
          ),
        }
      : {
          categories: sample.categories,
          products: sample.products.map((p) => ({ ...p, available: !p.soldOut })),
        };
    return kioskCatalogView(source.categories, source.products, config);
  }, [real, catalog, sample, config]);

  const categories: PCategory[] = useMemo(
    () =>
      view.categories.map((row) => ({
        id: row.category.id,
        name: row.category.name,
        imageUrl: categoryRailImage(row.category.id, config.catalog, categoryImageUrls),
        products: row.products.map((x) => ({ ...x.product, soldOut: x.soldOut })),
      })),
    [view, config.catalog, categoryImageUrls],
  );
  const featured = useMemo(() => view.featured.map((x) => ({ ...x.product, soldOut: x.soldOut })), [view]);
  const allProducts = useMemo(() => categories.flatMap((c) => c.products), [categories]);
  const firstAvailable = allProducts.find((p) => !p.soldOut) ?? allProducts[0] ?? null;
  const product = allProducts.find((p) => p.id === productId) ?? firstAvailable;
  const { groups, allergens } = useProductGroups(product?.id ?? null, real);

  // The menu's upsell rules (the kiosk's are those marked "קיוסק"), on a real catalog.
  const upsellQuery = useQuery({ queryKey: ['kiosk-preview-upsells'], queryFn: fetchUpsells, enabled: real, retry: false, staleTime: 60_000 });
  const kioskRules: UpsellRuleLite[] = useMemo(
    () =>
      (upsellQuery.data?.items ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        triggerType: r.triggerType,
        triggerIds: r.triggerIds,
        action: r.action,
        options: r.options?.length ? r.options.map((o) => ({ type: o.type, id: o.id })) : r.productId ? [{ type: 'product' as const, id: r.productId }] : [],
        prompt: r.prompt ?? null,
        message: r.message,
        showPrice: r.showPrice,
        places: r.places ?? null,
        where: r.where ?? null,
        imageUrl: r.imageUrl ?? null,
        priority: r.priority,
        isActive: r.isActive,
        startTime: r.startTime,
        endTime: r.endTime,
        weekdays: r.weekdays,
      })),
    [upsellQuery.data],
  );

  // The cart and pay screens with nothing chosen yet show a sample basket.
  const sampleCart: PLine[] = useMemo(
    () =>
      allProducts
        .filter((p) => !p.soldOut)
        .slice(0, 2)
        .map((p, i) => ({ key: `sample-${p.id}`, product: p, qty: i === 0 ? 2 : 1, unit: p.price, extras: [] })),
    [allProducts],
  );
  const effectiveCart =
    cart.length > 0 ? cart : screen === 'cart' || screen === 'tip' || screen === 'details' || screen === 'pay' || screen === 'success' ? sampleCart : cart;
  /** The steps between the basket and the payment, as the kiosk asks them now (the tip, the details, in their order). */
  const checkoutSteps = checkoutStepsNow(config.payment, detailsFields(config, service).length > 0, false)
    // "איך תרצו לשלם?" (payMethod) has no preview screen yet: the preview goes from the last step to the payment.
    .filter((s): s is 'tip' | 'details' => s !== 'payMethod');
  /** Where a step goes on to: the next checkout step, else the payment. */
  const after = (s: 'cart' | 'tip' | 'details'): PreviewScreen => (s === 'cart' ? checkoutSteps[0] : checkoutSteps[checkoutSteps.indexOf(s) + 1]) ?? 'pay';
  const before = (s: 'tip' | 'details'): PreviewScreen => checkoutSteps[checkoutSteps.indexOf(s) - 1] ?? 'cart';

  const wide = frame === 'tablet';
  const panel = cartPanelShown(config.theme, FRAME_DEVICE_DP[frame]);
  const side = config.theme.categoryLayout !== 'top';
  // "אפקטים": the preview draws the configured profile ("auto" — the device's choice — previews the full look).
  const profile = kioskRenderProfile(config.motion.effects);
  const played = profileMotion(config.motion, profile);
  const motion = motionSpec(config.theme, config.general, played);
  const transitions = transitionSpec(played, config.general);
  const colors = resolveThemeColors(config.theme);
  // "גודל מוצרים" (layout.productSize) moves the density's columns.
  const cols = productColumns(catalogColumns(config.theme.gridDensity, wide, panel, side), layoutOf(config).productSize, FRAME_DEVICE_DP[frame]);

  /** The window for [moment], if a rule for the kiosk asks one (true: shown). */
  const offerUpsell = (moment: UpsellMoment, then: PreviewScreen | null): boolean => {
    if (!config.general.upsellEnabled || upsellWin || kioskRules.length === 0) return false;
    // "חובה / רשות / כבוי" for this moment (payment.stepModes.upsell*).
    if (stepMode(config, upsellStepModeKey(moment)) === 'off') return false;
    const pick = pickKioskUpsell(kioskRules, moment, {
      asked: upsellAsked.current,
      inCart: cart.map((l) => l.product.id),
      cap: config.upsell.maxShown,
      now: new Date(),
      sellable: (id) => allProducts.some((p) => p.id === id && !p.soldOut),
      productsOf: (ids) => allProducts.filter((p) => p.categoryId !== null && ids.includes(p.categoryId)).map((p) => p.id),
    });
    if (!pick) return false;
    upsellAsked.current = [...upsellAsked.current, pick.rule.id];
    setUpsellWin({ pick, then, added: {}, moment });
    return true;
  };
  /** The order reached [code] (each step once in an order). */
  const reachStep = (code: string, then: PreviewScreen | null = null): boolean => {
    if (upsellSteps.current.includes(code)) return false;
    upsellSteps.current = [...upsellSteps.current, code];
    return offerUpsell({ kind: 'step', code }, then);
  };

  const navigate = (target: PreviewScreen) => {
    // On the way to payment: a rule for "to_pay" first (the menu's "בכל הזמנה" too).
    if (target === 'pay' && (screen === 'cart' || screen === 'catalog') && reachStep('to_pay', 'pay')) return;
    // "לתשלום" from the basket: the checkout steps first (the tip, the details), as on the kiosk.
    const s = target === 'pay' && (screen === 'cart' || screen === 'catalog') ? after('cart') : target;
    setConfirming(false);
    if (s !== 'product') setProductId(null);
    if (s === 'cart' || s === 'attract') setPreviewTip(0);
    setVisit((v) => v + 1);
    onScreen(s);
    if (s === 'attract') {
      setReachToggled(false);
      upsellAsked.current = [];
      upsellSteps.current = [];
      setUpsellWin(null);
    }
    if (s === 'catalog' && (screen === 'attract' || screen === 'service') && !reachStep('order_start')) reachStep('to_catalog');
    if (s === 'cart' && screen === 'catalog') reachStep('to_cart');
  };

  const closeUpsell = () => {
    const then = upsellWin?.then ?? null;
    setUpsellWin(null);
    if (then) navigate(then);
  };
  const addFromUpsell = (p: PProduct, from: DOMRect | null) => {
    if (!upsellWin) return;
    const key = `${p.id}-u-${upsellWin.pick.rule.id}`;
    addLine({ key, product: p, qty: 1, unit: p.price, extras: [], options: [] }, from, (l) => l.key === key, true);
    if (upsellWin.pick.items.length <= 1) closeUpsell();
    else setUpsellWin({ ...upsellWin, added: { ...upsellWin.added, [p.id]: (upsellWin.added[p.id] ?? 0) + 1 } });
  };

  // "כיתוב רץ" on the attract screen: its start button and the rest are laid out on what the strip leaves.
  // The style's status line (tech) takes its height off the top of every screen.
  const statusPx = statusLinePx({ cfg: config, c: colors });
  const ticker = screen === 'attract' ? tickerBandPx(config, 'attract', new Date(nowMs), PREVIEW_FOOTER_PX) : { top: 0, bottom: 0 };
  const band = { top: ticker.top + statusPx, bottom: ticker.bottom };
  const attractH = FRAME_SIZE[frame].h - band.top - band.bottom;
  const attractBox = ctaBox(config.attract.cta, FRAME_SIZE[frame].w, attractH);
  /** The start button's box over the whole frame (below a strip at the top). */
  const ctaOnFrame = band.top > 0 ? { ...attractBox, y: attractBox.y + band.top } : attractBox;
  const model: PreviewModel = {
    cfg: config,
    c: colors,
    radius: config.theme.cornerRadius,
    btnRadius: buttonRadius(config.theme),
    wide,
    cols,
    ratio: aspectRatioCss(config.theme.imageRatio),
    font: fontStack(config.theme.font, fonts),
    // Every customer text through the registry, in the editor's language (lib/kioskTexts.ts).
    txt: (key: KioskTextKey) => configuredText(config, previewLang, key) ?? (previewLang === 'he' ? tb(key) : (defaultText(previewLang, key) ?? tb(key))),
    t: (key, values) => webTextIn(config, previewLang, key, values) ?? t(key, values),
    kt: (key, values) => kioskTextOf(config, previewLang, key, values),
    mealOptions: (p) =>
      kioskRules
        .filter((r) => r.action === 'upgrade' && r.triggerType === 'product' && r.triggerIds.includes(p.id))
        .flatMap((r) => r.options.filter((o) => o.type === 'product').map((o) => allProducts.find((x) => x.id === o.id && !x.soldOut)))
        .filter((x): x is PProduct => !!x)
        .slice(0, 3),
    reach: { toggled: reachToggled, toggle: () => setReachToggled((v) => !v) },
    money: (n) => formatCurrency(n),
    categories,
    featured,
    logoUrl: config.theme.logo?.url ?? null,
    brandName,
    nowMs,
    go: navigate,
    openProduct: (p) => {
      setProductId(p.id);
      onScreen('product');
    },
    quickAdd: (p, from) => {
      const plain = (l: PLine) => l.product.id === p.id && l.extras.length === 0 && !l.note && (l.options?.length ?? 0) === 0;
      // At most one plain line per dish (the next joins it), so its key is unique.
      addLine({ key: `${p.id}-plain`, product: p, qty: 1, unit: p.price, extras: [], options: [] }, from, plain);
    },
    onCategoryPicked: (id) => {
      reachStep(enterCategory(id));
    },
    cart: effectiveCart,
    setCart,
    service,
    setService,
    motion,
    transitions,
    justAddedId: justAdded,
    cartBump,
    setCartTarget,
    panel,
    screen: { w: FRAME_SIZE[frame].w, h: attractH },
    ctaBox: attractBox,
    light: profile === 'light',
  };

  // A flight that lands bounces the badge then; a reduce-motion fade already did at the tap.
  const removeFlight = useCallback((flight: Flight) => {
    setFlights((list) => list.filter((f) => f.id !== flight.id));
    if (flight.lands) setCartBump((n) => n + 1);
  }, []);

  /** `merge`: the cart line this one joins (the same plain dish, as on the till); `stay`: from an upsell window. */
  const addLine = (line: PLine, from: DOMRect | null, merge?: (l: PLine) => boolean, stay = false) => {
    setCart((c) => {
      const i = merge ? c.findIndex(merge) : -1;
      return i >= 0 ? c.map((l, j) => (j === i ? { ...l, qty: l.qty + line.qty } : l)) : [...c, line];
    });
    setJustAdded(line.product.id);
    if (justAddedTimer.current) window.clearTimeout(justAddedTimer.current);
    justAddedTimer.current = window.setTimeout(() => setJustAdded(null), 900);
    const box = screenRef.current?.getBoundingClientRect();
    const lands = motion.flyMs > 0;
    if (addMs(motion) > 0 && from && box && (!lands || cartTargetRef.current)) {
      flightSeq.current += 1;
      setFlights((list) => [
        ...list.slice(-7),
        {
          id: flightSeq.current,
          x: from.left + from.width / 2 - box.left,
          y: from.top + from.height / 2 - box.top,
          imageUrl: line.product.imageUrl,
          name: line.product.name,
          lands,
        },
      ]);
      if (!lands) setCartBump((n) => n + 1);
    } else {
      setCartBump((n) => n + 1);
    }
    if (stay) return;
    setProductId(null);
    // "הגדלת מכירה" on adding an item ("פריט" / "כל פריטי מחלקה").
    if (offerUpsell({ kind: 'added', productId: line.product.id, categoryIds: line.product.categoryId ? [line.product.categoryId] : [] }, null)) {
      onScreen('catalog');
      return;
    }
    const mode = config.general.skipCart;
    if (mode === 'direct') onScreen('pay');
    else {
      if (mode === 'confirm') setConfirming(true);
      onScreen('catalog');
    }
  };

  /* "הצג": play one transition here, through the screens' own paths (a tap on the rail, a "+"). */
  const onCatalog = screen === 'catalog' || screen === 'product';
  const toCatalogThen = (then: () => void) => {
    if (screen === 'catalog') return then();
    navigate('catalog');
    window.setTimeout(then, (screen === 'product' ? 60 : transitions.screenMs) + 160);
  };
  const tapNextCategory = () => {
    const items = Array.from(screenRef.current?.querySelectorAll<HTMLElement>('[data-cat]') ?? []);
    if (items.length < 2) return;
    const at = items.findIndex((el) => el.dataset.active !== undefined);
    items[(at + 1) % items.length].click();
  };
  const tapAdd = () => {
    const root = screenRef.current;
    const plus = root?.querySelector<HTMLElement>('[data-add="direct"]');
    if (plus) return plus.click();
    const card = root?.querySelector<HTMLElement>('[data-product]');
    const p = allProducts.find((x) => x.id === card?.dataset.product && !x.soldOut);
    if (card && p) model.quickAdd?.(p, card.getBoundingClientRect());
  };
  const nextScreen = (s: PreviewScreen): PreviewScreen => {
    // The service screen only when it is a step: asked, and not on the attract screen's buttons ("ללא" never).
    const service = serviceAsked(model) && !serviceOnAttractOf(model);
    if (s === 'attract') return service ? 'service' : 'catalog';
    if (s === 'service') return 'catalog';
    if (s === 'catalog' || s === 'product') return 'cart';
    if (s === 'cart') return after('cart');
    if (s === 'tip' || s === 'details') return after(s);
    if (s === 'pay') return 'success';
    return 'attract';
  };
  const play = (demo: MotionDemo) => {
    if (demo === 'screenChange') return navigate(nextScreen(screen));
    if (demo === 'sheet') {
      const open = () => {
        if (!firstAvailable) return;
        setProductId(firstAvailable.id);
        onScreen('product');
      };
      if (screen === 'product') {
        navigate('catalog');
        window.setTimeout(open, transitions.sheetMs + 200);
      } else if (onCatalog) open();
      else toCatalogThen(open);
      return;
    }
    if (demo === 'addToCart') return toCatalogThen(tapAdd);
    // The category switch, its dishes coming in, the speed: the next category on the rail.
    toCatalogThen(tapNextCategory);
  };
  useImperativeHandle(controls, () => ({ play }));

  const size = FRAME_SIZE[frame];
  const upsell = allProducts.filter((p) => !p.soldOut && !effectiveCart.some((l) => l.product.id === p.id)).slice(0, 4);
  // The ordering screens' message: one overlay per visit (the product sheet belongs to the catalog visit).
  const messageScreen = (screen === 'product' ? 'catalog' : screen) as MessageScreen;
  const overlay = messagePlacement(messageScreen) === 'overlay-center';
  const weights = typeWeights(config.theme.typeWeight);
  const chrome = chromeRoot(model);
  const rootVars = {
    '--k-scale': String(typeScaleFactor(config.theme.typeScale)),
    '--k-w-body': String(weights.body),
    '--font-weight-medium': String(weights.medium),
    '--font-weight-semibold': String(weights.semibold),
    '--font-weight-bold': String(weights.bold),
    '--font-weight-extrabold': String(weights.extrabold),
    '--font-weight-black': String(weights.black),
  } as CSSProperties;

  return (
    <div className="space-y-3">
      <style>{PREVIEW_CSS}</style>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{t('title')}</span>
        <div className="inline-flex rounded-xl bg-muted p-1">
          {(['phone', 'tablet'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={frame === f}
              onClick={() => setFrame(f)}
              className={cn(
                'flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs transition-all duration-200',
                frame === f ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground',
              )}
            >
              {f === 'phone' ? <Smartphone className="h-3.5 w-3.5" /> : <Tablet className="h-3.5 w-3.5" />}
              {t(f)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {SCREENS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => navigate(s)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs transition-all duration-200',
              screen === s ? 'bg-foreground text-background shadow-sm' : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`screens.${s}`)}
          </button>
        ))}
      </div>
      {screen === 'paused' ? (
        <div className="inline-flex flex-wrap rounded-xl bg-muted p-1 text-xs">
          {PAUSED_VARIANTS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setPausedVariant(v)}
              className={cn('rounded-lg px-2.5 py-1 transition-all', pausedVariant === v ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}
            >
              {t(`pausedVariant.${v}`)}
            </button>
          ))}
        </div>
      ) : null}
      {screen === 'paused' && pausedVariant === 'paused' ? <p className="text-xs text-muted-foreground">{t('rest.sampleEnd')}</p> : null}

      <div className="flex justify-center">
        <div
          className={cn(
            'relative shrink-0 bg-neutral-900 shadow-2xl ring-1 ring-black/10 transition-all duration-500',
            frame === 'phone' ? 'rounded-[44px] p-2.5' : 'rounded-[28px] p-3',
          )}
          style={{ width: size.w + (frame === 'phone' ? 20 : 24) }}
        >
          {frame === 'phone' ? (
            <div className="absolute left-1/2 top-4 z-40 h-5 w-24 -translate-x-1/2 rounded-full bg-neutral-900" />
          ) : null}
          <div
            ref={screenRef}
            dir={previewLang === 'he' || previewLang === 'ar' ? 'rtl' : 'ltr'}
            className={cn('k-root relative overflow-hidden', config.general.reduceMotion && 'k-reduce', chrome.className)}
            style={{
              ...rootVars,
              ...chrome.style,
              width: size.w,
              height: size.h,
              borderRadius: frame === 'phone' ? 34 : 18,
              background: colors.background,
              color: colors.text,
              fontFamily: model.font,
            }}
          >
            {/* "תמונת רקע": once, behind every screen (or only the rest screens), under its veil. */}
            <KioskWallpaper m={model} screen={screen} />
            {/* The style's backdrop pattern (tech): behind every screen. */}
            <KioskBackdrop m={model} />
            <div className={cn('relative h-full', frame === 'phone' && 'pt-7')} style={statusPx > 0 ? { paddingTop: (frame === 'phone' ? 28 : 0) + statusPx } : undefined}>
              {/* "שורת מצב" (tech): the state, the order's number and the time, over the screens. */}
              <KioskStatusBar
                m={model}
                screen={screen === 'paused' ? pausedVariant : screen}
                pickup={screen === 'success' ? pickupLabel(config.pickup.prefix, Number.isFinite(config.pickup.start) ? config.pickup.start : 1) : null}
                top={frame === 'phone' ? 28 : 0}
              />
              {/* "מעבר בין מסכים": the screen swaps with the chosen transition (the product sheet belongs to the catalog). */}
              {/* "נגיש" (layout.reach): the screens in the bottom half under a display (kiosk-shared/layouts). */}
              <ReachFrame m={model} screen={screen === 'product' ? 'catalog' : screen} dish={screen === 'product' ? product : null} category={activeCategory}>
              <KioskSwap
                id={screen === 'product' ? 'catalog' : screen}
                fx={transitions.screenChange}
                ms={transitions.screenMs}
                order={screenOrder}
                className="h-full"
                slotClassName="h-full"
                render={(s) => (
                  // "כיתוב רץ" as the first or last row of the screens without a header bar of their own.
                  <TickerFrame m={model} screen={s} footerGap={PREVIEW_FOOTER_PX}>{
                  s === 'attract' ? (
                    <AttractScreen m={model} />
                  ) : s === 'service' ? (
                    <GuidedFrame m={model} screen={s}>
                      <ServiceScreen m={model} />
                    </GuidedFrame>
                  ) : s === 'catalog' ? (
                    // "מבנה הקיוסק": the layout's menu screen (today's for standard).
                    <GuidedFrame m={model} screen={s}>
                      <LayoutCatalog m={model} activeCategory={activeCategory} onCategory={setActiveCategory} />
                    </GuidedFrame>
                  ) : s === 'cart' ? (
                    <GuidedFrame m={model} screen={s}>
                      <CartScreen m={model} upsell={upsell} />
                    </GuidedFrame>
                  ) : s === 'tip' ? (
                    <TipScreen
                      m={model}
                      steps={checkoutSteps}
                      onDone={(tip) => {
                        setPreviewTip(tip);
                        navigate(after('tip'));
                      }}
                    />
                  ) : s === 'details' ? (
                    <DetailsPreview m={model} onDone={() => navigate(after('details'))} onBack={() => navigate(before('details'))} />
                  ) : s === 'pay' ? (
                    <PayScreen m={model} tipAgorot={previewTip} />
                  ) : s === 'success' ? (
                    <SuccessScreen m={model} />
                  ) : (
                    <PausedScreen m={model} variant={pausedVariant} pause={{ until: samplePauseEnd(nowMs) }} />
                  )
                  }</TickerFrame>
                )}
              />
              </ReachFrame>
              {upsellWin ? (
                <UpsellWindow
                  m={model}
                  title={upsellWin.pick.rule.prompt || upsellWin.pick.rule.message || config.texts?.upsellTitle || tb('upsellTitle')}
                  text={upsellWin.pick.rule.prompt && upsellWin.pick.rule.message !== upsellWin.pick.rule.prompt ? upsellWin.pick.rule.message ?? null : null}
                  imageUrl={upsellWin.pick.rule.imageUrl ?? null}
                  items={upsellWin.pick.items.map((id) => allProducts.find((p) => p.id === id)).filter((p): p is PProduct => !!p)}
                  added={upsellWin.added}
                  showPrice={upsellWin.pick.rule.showPrice !== false}
                  onAdd={addFromUpsell}
                  onContinue={closeUpsell}
                  onSkip={closeUpsell}
                  required={stepMode(config, upsellStepModeKey(upsellWin.moment ?? { kind: 'added' })) === 'required'}
                />
              ) : null}
              {screen === 'product' && product ? (
                <ReachSheets m={model}>
                  <LayoutProductSheet
                    key={`${product.id}-${groups.length}`}
                    m={model}
                    product={product}
                    groups={groups}
                    allergens={allergens}
                    onClose={() => navigate('catalog')}
                    onAdd={addLine}
                  />
                </ReachSheets>
              ) : null}
              <ReachToggle m={model} bottom={PREVIEW_FOOTER_PX + 6} />
              {screen === 'attract' ? (
                serviceOnAttractOf(model) ? (
                  <AttractServiceButtons m={model} box={ctaOnFrame} onPick={(t) => {
                    setService(t);
                    navigate('catalog');
                  }} />
                ) : (
                  <AttractCta m={model} box={ctaOnFrame} screen={{ w: FRAME_SIZE[frame].w, h: FRAME_SIZE[frame].h - band.bottom }} onMove={onCtaMove} />
                )
              ) : null}
              <div className="pointer-events-none absolute inset-x-0 bottom-0.5 z-20 text-center text-[8px] font-medium tracking-[0.12em]" style={{ color: colors.mutedText, opacity: 0.6 }}>
                POWERED BY R2M POS
              </div>
              {confirming && screen === 'catalog' ? (
                <ConfirmSheet m={model} onMore={() => setConfirming(false)} onPay={() => navigate('pay')} />
              ) : null}
              {overlay ? (
                <MessageOverlay key={`${messageScreen}-${visit}`} m={model} screen={messageScreen} suppressed={screen === 'product' || confirming} />
              ) : null}
            </div>
            {flights.map((f) => (
              <Flyer
                key={f.id}
                flight={f}
                motion={motion}
                dp={size.w / FRAME_DEVICE_DP[frame]}
                surface={colors.surface}
                text={colors.text}
                containerRef={screenRef}
                targetRef={cartTargetRef}
                onDone={removeFlight}
              />
            ))}
          </div>
        </div>
      </div>
      {config.theme.cartStyle === 'panel' ? <p className="text-center text-[11px] text-muted-foreground">{t('panelWideOnly')}</p> : null}
      <p className="text-center text-[11px] text-muted-foreground">{real ? t('realCatalog', { name: catalog!.machineName }) : t('sampleNote')}</p>
    </div>
  );
}
