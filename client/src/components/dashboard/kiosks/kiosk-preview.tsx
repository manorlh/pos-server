'use client';

/**
 * The live preview: the kiosk's screens in a phone or tablet frame, rendered from the
 * config being edited (not the saved one), on the real catalog of the shop's till when
 * there is one. A small working kiosk: tap the CTA, pick a product, add (with the
 * add-to-cart motion), pay on the pinpad beside the screen.
 */

import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Smartphone, Tablet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import { fetchGroups, fetchProductMenu } from '@/lib/menuApi';
import {
  aspectRatioCss,
  buttonRadius,
  cartPanelShown,
  categoryRailImage,
  ctaBox,
  fontStack,
  gridColumns,
  kioskCatalogView,
  messagePlacement,
  motionSpec,
  resolveThemeColors,
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
  AttractScreen,
  CartScreen,
  CatalogScreen,
  ConfirmSheet,
  Flyer,
  MessageOverlay,
  PausedScreen,
  PayScreen,
  PREVIEW_CSS,
  ProductSheet,
  ServiceScreen,
  SuccessScreen,
  type Flight,
  type PausedVariant,
  type PCategory,
  type PGroup,
  type PLine,
  type PProduct,
  type PreviewModel,
} from './preview-screens';
import { useGoogleFonts } from './use-google-fonts';

const SCREENS: PreviewScreen[] = ['attract', 'service', 'catalog', 'product', 'cart', 'pay', 'success', 'paused'];
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
  }, [real, menu.data, groups.data, ts, ta]);
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
  const screenRef = useRef<HTMLDivElement>(null);
  const cartTargetRef = useRef<HTMLDivElement | null>(null);
  const setCartTarget = useCallback((el: HTMLDivElement | null) => {
    cartTargetRef.current = el;
  }, []);
  const justAddedTimer = useRef<number | null>(null);
  const flightSeq = useRef(0);

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

  // The cart and pay screens with nothing chosen yet show a sample basket.
  const sampleCart: PLine[] = useMemo(
    () =>
      allProducts
        .filter((p) => !p.soldOut)
        .slice(0, 2)
        .map((p, i) => ({ key: `sample-${p.id}`, product: p, qty: i === 0 ? 2 : 1, unit: p.price, extras: [] })),
    [allProducts],
  );
  const effectiveCart = cart.length > 0 ? cart : screen === 'cart' || screen === 'pay' || screen === 'success' ? sampleCart : cart;

  const wide = frame === 'tablet';
  const panel = cartPanelShown(config.theme, FRAME_DEVICE_DP[frame]);
  const side = config.theme.categoryLayout !== 'top';
  const motion = motionSpec(config.theme, config.general);
  const colors = resolveThemeColors(config.theme);
  const cols = Math.max(
    1,
    gridColumns(config.theme.gridDensity, wide) - (panel ? 1 : 0) - (side && !wide && config.theme.gridDensity === 'compact' ? 1 : 0),
  );

  const navigate = (s: PreviewScreen) => {
    setConfirming(false);
    if (s !== 'product') setProductId(null);
    setVisit((v) => v + 1);
    onScreen(s);
  };

  const model: PreviewModel = {
    cfg: config,
    c: colors,
    radius: config.theme.cornerRadius,
    btnRadius: buttonRadius(config.theme),
    wide,
    cols,
    ratio: aspectRatioCss(config.theme.imageRatio),
    font: fontStack(config.theme.font, fonts),
    txt: (key: KioskTextKey) => config.texts?.[key] || tb(key),
    t: (key, values) => t(key, values),
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
    cart: effectiveCart,
    setCart,
    service,
    setService,
    motion,
    justAddedId: justAdded,
    cartBump,
    setCartTarget,
    panel,
    screen: { w: FRAME_SIZE[frame].w, h: FRAME_SIZE[frame].h },
    ctaBox: ctaBox(config.attract.cta, FRAME_SIZE[frame].w, FRAME_SIZE[frame].h),
  };

  const removeFlight = useCallback((id: number) => setFlights((list) => list.filter((f) => f.id !== id)), []);

  const addLine = (line: PLine, from: DOMRect | null) => {
    setCart((c) => [...c, line]);
    setCartBump((n) => n + 1);
    setJustAdded(line.product.id);
    if (justAddedTimer.current) window.clearTimeout(justAddedTimer.current);
    justAddedTimer.current = window.setTimeout(() => setJustAdded(null), 900);
    const box = screenRef.current?.getBoundingClientRect();
    if (motion.flyMs > 0 && from && box) {
      flightSeq.current += 1;
      setFlights((list) => [
        ...list,
        {
          id: flightSeq.current,
          x: from.left + from.width / 2 - box.left,
          y: from.top + from.height / 2 - box.top,
          imageUrl: line.product.imageUrl,
        },
      ]);
    }
    setProductId(null);
    const mode = config.general.skipCart;
    if (mode === 'direct') onScreen('pay');
    else {
      if (mode === 'confirm') setConfirming(true);
      onScreen('catalog');
    }
  };

  const size = FRAME_SIZE[frame];
  const bgImage = config.theme.backgroundImage?.url;
  const upsell = allProducts.filter((p) => !p.soldOut && !effectiveCart.some((l) => l.product.id === p.id)).slice(0, 4);
  // The ordering screens' message: one overlay per visit (the product sheet belongs to the catalog visit).
  const messageScreen = (screen === 'product' ? 'catalog' : screen) as MessageScreen;
  const overlay = messagePlacement(messageScreen) === 'overlay-center';
  const weights = typeWeights(config.theme.typeWeight);
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
            dir="rtl"
            className={cn('k-root relative overflow-hidden', config.general.reduceMotion && 'k-reduce')}
            style={{
              ...rootVars,
              width: size.w,
              height: size.h,
              borderRadius: frame === 'phone' ? 34 : 18,
              background: colors.background,
              color: colors.text,
              fontFamily: model.font,
            }}
          >
            {bgImage ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={bgImage} alt="" className="absolute inset-0 h-full w-full object-cover" />
                <div
                  className="absolute inset-0"
                  style={{ background: screen === 'attract' ? `${colors.background}66` : `${colors.background}D9` }}
                />
              </>
            ) : null}
            <div className={cn('relative h-full', frame === 'phone' && 'pt-7')}>
              <div key={screen === 'product' ? 'catalog' : screen} className="h-full animate-in fade-in slide-in-from-bottom-2 duration-300">
                {screen === 'attract' ? (
                  <AttractScreen m={model} />
                ) : screen === 'service' ? (
                  <ServiceScreen m={model} />
                ) : screen === 'catalog' || screen === 'product' ? (
                  <CatalogScreen m={model} activeCategory={activeCategory} onCategory={setActiveCategory} />
                ) : screen === 'cart' ? (
                  <CartScreen m={model} upsell={upsell} />
                ) : screen === 'pay' ? (
                  <PayScreen m={model} />
                ) : screen === 'success' ? (
                  <SuccessScreen m={model} />
                ) : (
                  <PausedScreen m={model} variant={pausedVariant} />
                )}
              </div>
              {screen === 'product' && product ? (
                <ProductSheet
                  key={`${product.id}-${groups.length}`}
                  m={model}
                  product={product}
                  groups={groups}
                  allergens={allergens}
                  onClose={() => navigate('catalog')}
                  onAdd={addLine}
                />
              ) : null}
              {screen === 'attract' ? <AttractCta m={model} box={model.ctaBox} screen={model.screen} onMove={onCtaMove} /> : null}
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
                color={colors.button}
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
