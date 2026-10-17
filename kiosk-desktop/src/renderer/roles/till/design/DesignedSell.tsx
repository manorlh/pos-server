/**
 * A designed order screen ("עיצוב קופה", pos-server docs/SPEC_TILL_DESIGN.md; pos-android ui/sell/design/
 * DesignedOrderScreen.kt) for the Windows till's quick order — every template but clean: the order's header with its ⋮,
 * the mode's extras (the service type and the name, "כמות לפריט הבא", the open tabs, the favourites, the professional
 * keyboard or its search field), the categories (chips on top, a rail at the side, לילה's two rows), the product grid in
 * the template's tile style, the bill at its position (a side panel, a block under the menu, the summary that opens over
 * it, the order sheet, תפריט ויזואלי's floating drawer) and the action bar — or עגינת תשלום's dock.
 *
 * Every action is today's: an add is `sell.add`, the bill's edits CartActions' ops, the bar's buttons the till's `quick`
 * handler (the payment's own one-tap paths) and "pay" the payment screen. What the Windows till has no flow for is left
 * off (the Android button whose flow is not there): see designLayout.ts BAR_ACTIONS_NOT_HERE and the report.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Catalog, Department, Product, TillState } from '../../../../shared/till/protocol';
import type { TillDesignView } from '../../../../core/till/tillDesign';
import type { CartActions, CartView, QuickButton } from '../parts/CartPane';
import { PresetChips } from '../parts/TillSheets';
import { money } from '../text';
import { Icon } from '../theme/icons';
import { DesignGrid } from './DesignGrid';
import { BillHead, BillLines, SelectedLineStrip, SummaryBar, TotalsBlock, type BillRules } from './DesignBill';
import { ActionBar, Dropdown, PayDock, type Face, type MenuEntry } from './DesignBar';
import { DT } from './designText';
import {
  barButtons,
  designBillCollapsible,
  drawerFraction,
  fKeyAction,
  HEBREW_ROWS,
  keyboardTyped,
  nightBillPosition,
  nightBillWidthDp,
  NUMPAD_ROWS,
  payDockPlan,
  payDockPrimary,
  pluLookup,
  quantityKeypadTyped,
  sideBillWidthDp,
  type BarButton,
  type KeyboardMode,
} from './designLayout';

/** The engine's ops a designed screen needs beyond today's sell screen (TillApp passes them; absent — the nearest of today's). */
export interface DesignOps {
  /** `sell.add` with a quantity ("כמות לפריט הבא", the keyboard's "כמות"). */
  addQty?(productId: string, qty: number): void;
  /** `order.details`: "לקחת" / "לשבת" from the screen's chips, a pickup's name. */
  orderDetails?(d: { dining?: 'take_away' | 'eat_in' | null; name?: string | null }): void;
  /** `held.resume`: an open tab back on the screen. */
  resume?(id: string): void;
  /** `held.hold` under a name ("השהה והמשך"). */
  park?(label: string | null): void;
}

export interface DesignedSellProps {
  state: TillState;
  catalog: Catalog | null;
  /** The departments and products in the design's menu order (designLayout orderedCatalog). */
  departments: Department[];
  /** What the grid shows now (the tab, the search). */
  products: Product[];
  design: TillDesignView;
  cart: CartActions;
  cartView: CartView;
  quick?(b: QuickButton): void;
  onAdd(productId: string): void;
  onDepartment(id: string | null): void;
  onSearch(text: string): void;
  onHold?(productId: string): void;
  onInfo(p: Product): void;
  /** The search box (the scanner's Enter adds, a voucher goes to the payment): SellScreen's own input. */
  searchInput(className: string, autoFocus: boolean): ReactNode;
  shiftOpen: boolean;
  goShift?(): void;
  ops?: DesignOps;
  /** "זרימה": back to the orders (the flow's home). */
  onBack?(): void;
}

const TENDERS = new Set(['fastCard', 'cashWithChange', 'fastCash', 'cashNotes']);

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 1280, h: 800 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth || 1280, h: el.clientHeight || 800 });
    read();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function DesignedSell(props: DesignedSellProps) {
  const { state, design, cart, cartView, quick, onAdd, onDepartment, onSearch, onHold, onInfo, shiftOpen, ops } = props;
  const sell = state.sell;
  const texts = design.texts;
  const features = new Set(design.features);
  const night = features.has('thumbs') || design.drawn === 'night';
  const visual = features.has('dishCards') || design.tileStyle === 'dish';
  const dock = features.has('payDock');
  const selecting = features.has('selectedLine');
  const presets = features.has('quantityPresets');
  const searchField = features.has('searchField');
  const keyboardOn = searchField && design.professional.keyboard;
  const fKeysOn = searchField && design.professional.fKeys;
  const hidden = new Set(cartView.hidden ?? []);
  const rules: BillRules = { discountShown: !hidden.has('DISCOUNT'), voidShown: !hidden.has('LINE_VOID'), othShown: cartView.othEnabled === true && !hidden.has('OTH') };
  const heldCount = cartView.heldCount ?? 0;
  const scale = design.textSize === 'large' && !night ? 1.15 : 1;

  const [rootRef, size] = useSize<HTMLDivElement>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(design.behavior.summary === 'open');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [nextQty, setNextQty] = useState({ n: 1, custom: false });
  const [keypad, setKeypad] = useState<string | null>(null);
  const [kbMode, setKbMode] = useState<KeyboardMode | null>(null);
  const [kbInput, setKbInput] = useState('');
  const [kbMessage, setKbMessage] = useState<string | null>(null);

  const handheld = design.profile === 'handheld' || size.w < 600;
  const portrait = !handheld && size.h > size.w;
  const resolved = night ? nightBillPosition(design.billPosition, design.night.hand) : design.billPosition;
  const position = resolved;
  const collapsible = designBillCollapsible(position, handheld, design.summaryCollapsible, size.w, size.h);
  const lines = sell.lines;
  const hasLines = lines.length > 0;
  const total = sell.totalAgorot;
  const refund = total < 0 || (sell.refundTotalAgorot ?? 0) > 0 || sell.refundMode === true;
  const payable = shiftOpen && hasLines && total > 0 && !refund;
  const countText = DT.items(sell.itemCount);
  const totalText = money(Math.abs(total));
  const selected = selecting && selectedLine ? (lines.find((l) => l.lineId === selectedLine) ?? null) : null;

  // The count of each product already in the order (the tiles' badge).
  const inCart = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) if (!l.refund) m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty);
    return m;
  }, [lines]);

  /* ---------------------------------------------------------------- an add */

  const onTile = (p: Product) => {
    if (selectedLine) setSelectedLine(null);
    // The bar's presets, or the keyboard's "כמות": the next add takes it, then 1.
    if (nextQty.n > 1) {
      if (ops?.addQty) ops.addQty(p.id, nextQty.n);
      else onAdd(p.id);
      setNextQty({ n: 1, custom: false });
      return;
    }
    onAdd(p.id);
  };

  /* ---------------------------------------------------------------- the bar */

  const buttons = barButtons(design.actionBar, design.quickCash.offered).filter(
    (b) => b.action !== 'discount' || rules.discountShown || !!sell.basketDiscount,
  );
  const faceOf = (b: BarButton): Face => {
    switch (b.action) {
      case 'pay':
        if (refund)
          return { button: b, title: total < 0 ? DT.refundPay(money(-total)) : DT.evenPay, enabled: shiftOpen && hasLines, primary: b.primary };
        return { button: b, title: DT.labelAmount(b.label || texts.pay, money(total)), enabled: shiftOpen && hasLines, primary: b.primary };
      case 'fastCash':
        return { button: b, title: DT.labelAmount(b.label, money(total)), enabled: payable, primary: false };
      case 'cashNotes':
        return {
          button: b,
          title: money((b.noteShekels ?? 0) * 100),
          subtitle: DT.noteChange(money(Math.max(0, (b.noteShekels ?? 0) * 100 - total))),
          enabled: payable,
          primary: false,
        };
      case 'discount':
        return { button: b, title: b.label, enabled: hasLines, primary: !!b.presetId && b.presetId === sell.basketDiscount?.preset?.id };
      case 'hold':
        return { button: b, title: b.label, enabled: !!cart.hold && hasLines && !refund, primary: false };
      case 'clear':
        return { button: b, title: b.label, enabled: hasLines, primary: false };
      case 'orderDetails':
        return { button: b, title: b.label, enabled: true, primary: false };
      default:
        return { button: b, title: b.label, enabled: TENDERS.has(b.action) ? payable : true, primary: b.primary };
    }
  };
  const faces = buttons.map(faceOf);
  const onBar = (b: BarButton) => {
    if (b.action === 'pay') return cart.pay();
    quick?.({ action: b.action, label: b.label, ...(b.presetId ? { presetId: b.presetId } : {}), ...(b.noteShekels ? { noteShekels: b.noteShekels } : {}) });
  };

  /* ---------------------------------------------------------------- the ⋮ */

  const orderEntries: MenuEntry[] = [
    ...(cart.basketDiscount && (rules.discountShown || sell.basketDiscount) ? [{ label: DT.menuDiscount, enabled: hasLines, onClick: () => cart.basketDiscount?.() }] : []),
    ...(cart.orderEdit ? [{ label: DT.menuDetails, onClick: () => cart.orderEdit?.() }] : []),
    ...(cart.hold ? [{ label: DT.menuHold, enabled: hasLines && !refund, onClick: () => cart.hold?.() }] : []),
    ...(cart.held && heldCount > 0 ? [{ label: DT.menuHeld(heldCount), onClick: () => cart.held?.() }] : []),
    { label: DT.menuClear, enabled: hasLines, destructive: true, onClick: () => cart.clear() },
  ];

  /* ---------------------------------------------------------------- קופה מקצועית */

  const openKeyboard = (m: KeyboardMode) => {
    setKbMode(m);
    setKbInput(m === 'search' ? sell.search : '');
    setKbMessage(null);
  };
  const kbSet = (next: string) => {
    setKbInput(next);
    if (kbMode === 'search') onSearch(next);
    setKbMessage(null);
  };
  const kbOk = () => {
    if (kbMode === 'search') return setKbMode(null);
    if (kbMode === 'code') {
      const p = pluLookup(kbInput, props.catalog?.products ?? []);
      if (p) {
        onTile(p);
        setKbInput('');
      } else if (kbInput.trim()) setKbMessage(DT.kbNotFound(kbInput.trim()));
      return;
    }
    if (kbMode === 'quantity') {
      const n = Number(kbInput);
      if (Number.isInteger(n) && n >= 1) setNextQty({ n, custom: true });
      setKbMode(null);
      setKbInput('');
    }
  };
  // F1–F3 the keyboard's modes, F9 the payment, F10 the exact cash, Esc clears (a USB keyboard, §3.2).
  const fKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  fKeyRef.current = (e: KeyboardEvent) => {
    const a = fKeyAction(e.key);
    if (!a) return;
    if (a === 'search' || a === 'code' || a === 'quantity') {
      if (!keyboardOn) return;
      e.preventDefault();
      openKeyboard(a);
    } else if (a === 'pay') {
      e.preventDefault();
      cart.pay();
    } else if (a === 'exactCash') {
      e.preventDefault();
      if (payable && buttons.some((b) => b.action === 'fastCash')) quick?.({ action: 'fastCash', label: '' });
    } else if (a === 'clear') {
      if (kbMode) kbSet('');
      else onSearch('');
    }
  };
  useEffect(() => {
    if (!fKeysOn) return;
    const on = (e: KeyboardEvent) => fKeyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [fKeysOn]);

  /* ---------------------------------------------------------------- the menu pane */

  const serviceMode = design.fields.serviceType;
  const nameMode = design.fields.customerName;
  const dining = state.order?.dining ?? null;
  const orderName = state.order?.name ?? null;
  const fields =
    serviceMode !== 'off' || nameMode !== 'off' ? (
      <div className="d-strip-row">
        {serviceMode !== 'off' ? (
          <>
            {!handheld ? <span className="d-strip-label">{texts.serviceType}</span> : null}
            <button type="button" className={`d-chip d-chip-64${dining === 'take_away' ? ' d-chip-on' : ''}`} onClick={() => (ops?.orderDetails ? ops.orderDetails({ dining: 'take_away' }) : cart.orderEdit?.())}>
              {texts.takeAway}
            </button>
            <button type="button" className={`d-chip d-chip-64${dining === 'eat_in' ? ' d-chip-on' : ''}`} onClick={() => (ops?.orderDetails ? ops.orderDetails({ dining: 'eat_in' }) : cart.orderEdit?.())}>
              {texts.eatIn}
            </button>
          </>
        ) : null}
        {nameMode !== 'off' ? (
          <button type="button" className={`d-name-field${nameMode === 'required' && !orderName ? ' d-name-missing' : ''}${orderName ? '' : ' d-name-empty'}`} onClick={() => cart.orderEdit?.()}>
            {orderName || texts.customerName}
          </button>
        ) : (
          <span className="d-grow" />
        )}
      </div>
    ) : null;

  const quantityRow = presets ? (
    <div className="d-strip-row d-scroll-x">
      {!handheld ? <span className="d-strip-label">{texts.nextQuantity}</span> : null}
      <span className={`d-qty-box${nextQty.n > 1 ? ' d-qty-box-on' : ''}`} aria-label={DT.quantityValue(nextQty.n)}>
        <bdi>{nextQty.n}</bdi>
      </span>
      {design.bar.quantityPresets.map((n) => (
        <button key={n} type="button" className={`d-chip d-chip-48${!nextQty.custom && n === nextQty.n ? ' d-chip-on' : ''}`} onClick={() => setNextQty({ n, custom: false })}>
          {n}
        </button>
      ))}
      <button type="button" className={`d-chip${nextQty.custom ? ' d-chip-on' : ''}`} onClick={() => setKeypad('')}>
        {texts.otherQuantity}
      </button>
    </div>
  ) : null;

  // "חשבונות פתוחים": the bar's quick order — its held sales with a name as tabs.
  const tabsOn = design.bar.openTabs && (design.template === 'fast' || design.template === 'night');
  const tabs = tabsOn ? (state.held?.sales ?? []).filter((h) => (h.label ?? '').trim() !== '') : [];
  const tabsRow = tabsOn ? (
    <div className="d-strip-row d-scroll-x d-surface">
      {orderName && hasLines ? <span className="d-chip d-chip-on">{orderName}</span> : null}
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className="d-chip d-chip-96"
          onClick={() => (!hasLines && ops?.resume ? ops.resume(t.id) : cart.held?.())}
        >
          {`${t.label} · ${money(t.totalAgorot)}`}
        </button>
      ))}
      <button type="button" className="d-chip d-chip-96 d-chip-new" onClick={() => cart.hold?.()}>
        {DT.tabNew}
      </button>
    </div>
  ) : null;

  const favorites = features.has('favorites') && design.bar.favorites.length > 0 ? design.bar.favorites.map((id) => props.catalog?.products.find((p) => p.id === id)).filter((p): p is Product => !!p) : [];
  const favoritesRow =
    favorites.length > 0 ? (
      <div className="d-strip-row">
        <span className="d-strip-label">{texts.favorites}</span>
        <div className="d-scroll-x d-fav-list">
          {favorites.map((p) => {
            const n = inCart.get(p.id) ?? 0;
            return (
              <button key={p.id} type="button" className={`d-fav${p.sale ? ' d-off' : ''}`} onClick={() => onTile(p)}>
                <span className="d-fav-name">{p.name}</span>
                {p.sale ? <span className="d-red d-fav-sub">{DT.outOfStock}</span> : <span className="d-fav-sub">{money(p.priceAgorot)}</span>}
                {n > 0 ? <span className="d-count">{n}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
    ) : null;

  const keyboardHead = keyboardOn ? (
    <div className="d-kb-head">
      <div className="d-strip-row d-kb-modes">
        {(['search', 'code', 'quantity'] as const).map((m) => (
          <button key={m} type="button" className={`d-chip d-chip-64${kbMode === m ? ' d-chip-on' : ''}`} onClick={() => openKeyboard(m)}>
            {DT.kbModes[m]}
          </button>
        ))}
        {kbMode ? (
          <>
            <span className="d-grow" />
            <button type="button" className="d-icon-btn" aria-label={DT.kbClose} onClick={() => setKbMode(null)}>
              <Icon name="close" />
            </button>
          </>
        ) : null}
      </div>
      {kbMode ? (
        <div className="d-kb-field">
          <span className={kbInput ? '' : 'd-muted'}>{kbInput ? (kbMode === 'quantity' ? <bdi>{kbInput}</bdi> : kbInput) : DT.kbHints[kbMode]}</span>
          {kbMessage ? <span className="d-red d-small">{kbMessage}</span> : null}
        </div>
      ) : null}
    </div>
  ) : null;
  const keys =
    keyboardOn && kbMode ? (
      <div className="d-keys" dir="ltr">
        {(kbMode === 'quantity' ? [...NUMPAD_ROWS.slice(0, 3), '0'] : [...HEBREW_ROWS]).map((row) => (
          <div key={row} className="d-keys-row">
            {row.split('').map((c) => (
              <button key={c} type="button" className="d-key-btn" onClick={() => kbSet(keyboardTyped(kbInput, c, kbMode))}>
                {c}
              </button>
            ))}
          </div>
        ))}
        <div className="d-keys-row">
          <button type="button" className="d-key-btn" onClick={() => kbSet('')}>
            {DT.keypadClear}
          </button>
          <button type="button" className="d-key-btn" onClick={() => kbSet(kbInput.slice(0, -1))}>
            ⌫
          </button>
          {kbMode !== 'quantity' ? (
            <button type="button" className="d-key-btn d-key-3" onClick={() => kbSet(keyboardTyped(kbInput, ' ', kbMode))}>
              {DT.kbSpace}
            </button>
          ) : null}
          <button type="button" className={`d-key-btn d-key-ok${kbMode !== 'quantity' ? ' d-key-15' : ''}`} onClick={kbOk}>
            {DT.ok}
          </button>
        </div>
      </div>
    ) : null;

  const searchRow = keyboardOn
    ? null
    : searchField
      ? (
          <div className="d-search-field">
            <Icon name="search" size={20} />
            {props.searchInput('d-search-input', false)}
            {sell.search ? (
              <button type="button" className="d-icon-btn" aria-label={DT.searchClear} onClick={() => onSearch('')}>
                <Icon name="close" size={20} />
              </button>
            ) : null}
          </div>
        )
      : searchOpen
        ? (
            <div className="d-search-field">
              <Icon name="search" size={20} />
              {props.searchInput('d-search-input', true)}
              <button
                type="button"
                className="d-icon-btn"
                aria-label={DT.searchClear}
                onClick={() => {
                  onSearch('');
                  setSearchOpen(false);
                }}
              >
                <Icon name="close" size={20} />
              </button>
            </div>
          )
        : null;

  const tabsAll: Array<string | null> = [null, ...props.departments.map((d) => d.id)];
  const nameOf = new Map(props.departments.map((d) => [d.id, d.name] as const));
  const chip = (id: string | null, cls = '') => (
    <button key={id ?? 'all'} type="button" role="tab" aria-selected={sell.departmentId === id} className={`d-chip${cls}${sell.departmentId === id ? ' d-chip-on' : ''}`} onClick={() => onDepartment(id)}>
      {id === null ? DT.all : nameOf.get(id)}
    </button>
  );
  const nightRail = night && !handheld && (position === 'end' || position === 'start');
  const rail = (design.categoryBar === 'side' || nightRail) && !handheld;
  const railAtEnd = nightRail && position === 'start';
  const twoRows = night && !handheld && !rail;
  const railEl = rail ? (
    <div className="d-rail" role="tablist" style={{ width: night ? (size.w >= 1500 ? 180 : 150) : 120 }}>
      {tabsAll.map((id) => chip(id, ' d-rail-chip'))}
    </div>
  ) : null;
  const searching = searchOpen && !searchField;
  const categoryBar = rail || searching ? null : twoRows ? (
    <div className="d-two-rows" role="tablist">
      {tabsAll.map((id) => chip(id, ' d-chip-120'))}
    </div>
  ) : (
    <div className="d-chips" role="tablist">
      {tabsAll.map((id) => chip(id))}
    </div>
  );

  const emptyText = (props.catalog?.products.length ?? 0) === 0 ? DT.emptyCatalog : DT.noMatch;
  const grid = (
    <DesignGrid
      products={props.products}
      style={design.tileStyle}
      fixedColumns={design.columns}
      tileSize={design.tileSize}
      density={design.density}
      handheld={handheld}
      night={night}
      portrait={portrait}
      scale={scale}
      descriptionLines={design.visual.descriptionLines}
      dietaryShown={visual && design.visual.dietary === 'show'}
      inCart={inCart}
      tileText={state.tileText}
      emptyText={emptyText}
      onTap={onTile}
      onInfo={onInfo}
      onHold={onHold}
    />
  );

  const menuPane = (
    <section className="d-menu" aria-label="תפריט">
      {fields}
      {quantityRow}
      {tabsRow}
      {favoritesRow}
      {keyboardHead}
      {searchRow}
      {!shiftOpen ? (
        <div className="t-warn d-warn" role="note">
          <span>{DT.noShift}</span>
          {props.goShift ? (
            <button type="button" className="t-btn t-btn-small" onClick={props.goShift}>
              פתיחת משמרת
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="d-menu-body">
        {rail && !railAtEnd ? railEl : null}
        <div className="d-menu-main">
          {categoryBar}
          {grid}
        </div>
        {rail && railAtEnd ? railEl : null}
      </div>
      {keys}
    </section>
  );

  /* ---------------------------------------------------------------- the bill */

  const presetRow =
    cart.preset && cartView.presetButtons && cartView.presetButtons.length > 0 && (rules.discountShown || sell.basketDiscount?.preset) ? (
      <div className="d-presets">
        <PresetChips
          items={rules.discountShown ? cartView.presetButtons : cartView.presetButtons.filter((p) => p.id === sell.basketDiscount?.preset?.id)}
          activeId={sell.basketDiscount?.preset?.id ?? null}
          disabled={!hasLines || sell.refundMode === true}
          onTap={(id) => cart.preset?.(id)}
        />
      </div>
    ) : null;
  const billLines = (layout: 'side' | 'block' | 'summary', width: number) => (
    <BillLines
      sell={sell}
      style={design.billStyle}
      layout={layout}
      actions={cart}
      rules={rules}
      emptyText={texts.emptyOrder}
      selecting={selecting}
      selectedId={selectedLine}
      onSelect={setSelectedLine}
      widthDp={width}
      seatGeneral={texts.seatGeneral}
    />
  );
  const strip = selected ? <SelectedLineStrip line={selected} actions={cart} rules={rules} onDone={() => setSelectedLine(null)} /> : null;
  const bar = (stacked: boolean) => (dock ? null : <ActionBar faces={faces} stacked={stacked} handheld={handheld} night={night} onClick={onBar} />);
  const summaryLabel = DT.labelAmount(texts.summary, countText);

  let body: ReactNode;
  if (position === 'end' || position === 'start') {
    const panelW = night ? nightBillWidthDp(size.w) : sideBillWidthDp(size.w, design.template);
    const panel = (
      <aside className="d-panel" style={{ width: panelW }} aria-label={texts.orderTitle}>
        <BillHead title={texts.orderTitle} count={countText} />
        <div className="d-panel-lines">{billLines('side', panelW)}</div>
        {strip}
        {presetRow}
        <TotalsBlock sell={sell} withTotal={!dock} shiftOpen={shiftOpen} />
        {bar(true)}
      </aside>
    );
    // In RTL the row runs from the right: "start" puts the bill there.
    body = (
      <div className="d-row-body">
        {position === 'start' ? panel : null}
        {menuPane}
        {position === 'end' ? panel : null}
      </div>
    );
  } else if (position === 'drawer') {
    const side = size.w > size.h;
    const fraction = drawerFraction(size.w);
    body = (
      <div className="d-stack-body">
        {menuPane}
        {!drawerOpen ? (
          <button type="button" className="d-pill" aria-label={DT.summaryOpen} onClick={() => setDrawerOpen(true)}>
            <span>{DT.drawerLabel(texts.orderTitle, countText, totalText)}</span>
            <span aria-hidden="true">⌃</span>
          </button>
        ) : (
          <>
            <div className="d-scrim" onClick={() => setDrawerOpen(false)} />
            <aside className={side ? 'd-drawer d-drawer-side' : 'd-drawer d-drawer-bottom'} style={side ? { width: `${fraction * 100}%` } : undefined}>
              <BillHead title={texts.orderTitle} count={countText} />
              <div className="d-panel-lines">{billLines('side', side ? size.w * fraction : size.w)}</div>
              {presetRow}
              <TotalsBlock sell={sell} withTotal shiftOpen={shiftOpen} />
              {bar(true)}
            </aside>
          </>
        )}
      </div>
    );
  } else if (position === 'sheet') {
    body = (
      <>
        <div className="d-stack-body">
          {menuPane}
          {sheetOpen ? (
            <>
              <div className="d-scrim" onClick={() => setSheetOpen(false)} />
              <div className="d-overlay d-overlay-sheet">
                <div className="d-sheet-head">
                  <span className="d-grow" />
                  <strong>{texts.orderTitle}</strong>
                  <span className="d-grow" />
                  <button type="button" className="d-icon-btn" aria-label={DT.summaryClose} onClick={() => setSheetOpen(false)}>
                    <Icon name="close" />
                  </button>
                </div>
                <div className="d-panel-lines">{billLines('summary', size.w)}</div>
                {presetRow}
                <TotalsBlock sell={sell} withTotal shiftOpen={shiftOpen} />
              </div>
            </>
          ) : null}
        </div>
        <SummaryBar label={summaryLabel} total={totalText} open={false} onClick={() => setSheetOpen(true)} />
        {bar(false)}
      </>
    );
  } else if (collapsible) {
    body = (
      <>
        <div className="d-stack-body">
          {menuPane}
          {summaryOpen ? (
            <>
              <div className="d-scrim" onClick={() => setSummaryOpen(false)} />
              <div className="d-overlay" style={{ maxHeight: '60%' }}>
                <BillHead title={texts.orderTitle} count={countText} />
                <div className="d-panel-lines">{billLines('summary', size.w)}</div>
                {strip}
                {presetRow}
                <TotalsBlock sell={sell} withTotal={false} shiftOpen={shiftOpen} />
              </div>
            </>
          ) : null}
        </div>
        <SummaryBar label={summaryLabel} total={totalText} open={summaryOpen} onClick={() => setSummaryOpen(!summaryOpen)} />
        {bar(false)}
      </>
    );
  } else {
    body = (
      <>
        <div className="d-stack-body">{menuPane}</div>
        <div className="d-block">
          <BillHead title={texts.orderTitle} count={countText} />
          <div className="d-block-lines" style={{ maxHeight: Math.round(size.h * 0.3) }}>
            {billLines('block', size.w)}
          </div>
          {strip}
          {presetRow}
          <TotalsBlock sell={sell} withTotal={!dock} shiftOpen={shiftOpen} />
          {bar(false)}
        </div>
      </>
    );
  }

  /* ---------------------------------------------------------------- the dock */

  let dockEl: ReactNode = null;
  if (dock) {
    const primary = payDockPrimary(buttons);
    let dockFaces = faces.map((f) => ({
      ...f,
      ...(f.button.action === 'fastCash' ? { title: DT.exactCash, subtitle: money(total) } : {}),
      primary: f.button.action === primary,
    }));
    if (refund) dockFaces = dockFaces.filter((f) => f.button.action === 'pay').map((f) => ({ ...f, primary: true }));
    const plan = payDockPlan(dockFaces.map((f) => f.button), size.w, handheld, primary);
    const shown = dockFaces.filter((f) => plan.shown.includes(f.button));
    const more: MenuEntry[] = [
      ...dockFaces
        .filter((f) => plan.overflow.includes(f.button))
        .map((f) => ({ label: [f.title, f.subtitle].filter(Boolean).join(' · '), enabled: f.enabled, onClick: () => onBar(f.button) })),
      ...orderEntries.filter((e) => e.label !== DT.menuHeld(heldCount)),
    ];
    const discount = (sell.basketDiscount?.amountAgorot ?? 0) + (sell.lineDiscountsAgorot ?? 0) + (sell.promotionsAgorot ?? 0);
    dockEl = (
      <PayDock
        amount={totalText}
        savings={design.payDock.savings && discount > 0 && total >= 0 ? DT.dockSaved(money(discount)) : null}
        detail={hasLines ? countText : texts.emptyOrder}
        faces={shown}
        more={more}
        handheld={handheld}
        onClick={onBar}
      />
    );
  }

  /* ---------------------------------------------------------------- the header */

  const subtitle = [
    sell.itemCount > 0 ? countText : null,
    dining === 'take_away' ? texts.takeAway : dining === 'eat_in' ? texts.eatIn : null,
    orderName?.trim() || null,
  ]
    .filter(Boolean)
    .join(' · ');
  const header = (
    <header className="d-header">
      {props.onBack ? (
        <button type="button" className="d-icon-btn d-head-btn" aria-label={DT.flowBack} onClick={props.onBack}>
          <Icon name="arrowBack" size={22} />
        </button>
      ) : null}
      <div className="d-header-text">
        <strong>{texts.orderTitle}</strong>
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      {!searchField ? (
        <button type="button" className="d-icon-btn d-head-btn" aria-label={DT.search} aria-pressed={searchOpen} onClick={() => setSearchOpen(!searchOpen)}>
          <Icon name="search" size={22} />
        </button>
      ) : null}
      <span className="d-rel">
        <button type="button" className="d-icon-btn d-head-btn" aria-label={DT.more} aria-expanded={moreOpen} onClick={() => setMoreOpen(true)}>
          <Icon name="moreVert" size={22} />
          {heldCount > 0 ? <span className="d-head-badge">{heldCount}</span> : null}
        </button>
        {moreOpen ? <Dropdown entries={orderEntries} onClose={() => setMoreOpen(false)} /> : null}
      </span>
    </header>
  );

  return (
    <div
      ref={rootRef}
      className={`d-root${night ? ' d-night' : ''}${handheld ? ' d-handheld' : ''}`}
      data-tile={design.tileStyle}
      style={{ ['--d-scale' as string]: String(scale) }}
    >
      {header}
      {body}
      {dockEl}
      {keypad !== null ? (
        <div className="t-overlay" role="dialog" aria-modal="true" aria-label={texts.otherQuantity} onClick={() => setKeypad(null)}>
          <div className="t-dialog d-keypad" onClick={(e) => e.stopPropagation()}>
            <h2 className="t-dialog-title">{texts.otherQuantity}</h2>
            <div className="d-keypad-value">
              <bdi>{keypad || '—'}</bdi>
            </div>
            <div className="d-keypad-grid" dir="ltr">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} type="button" className="d-key-btn" onClick={() => setKeypad(quantityKeypadTyped(keypad, d))}>
                  {d}
                </button>
              ))}
              <button type="button" className="d-key-btn" onClick={() => setKeypad(keypad.slice(0, -1))}>
                {DT.keypadClear}
              </button>
              <button type="button" className="d-key-btn" onClick={() => setKeypad(quantityKeypadTyped(keypad, '0'))}>
                0
              </button>
              <button
                type="button"
                className="d-key-btn d-key-ok"
                disabled={!keypad}
                onClick={() => {
                  const n = Number(keypad);
                  if (n >= 1) setNextQty({ n, custom: true });
                  setKeypad(null);
                }}
              >
                {DT.ok}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
