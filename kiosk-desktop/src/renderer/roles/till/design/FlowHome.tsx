/**
 * "הדבורה" ("זרימה", key `flow`) — the home on the Windows till (pos-android ui/flow/FlowHome.kt, FlowTheme.kt; P:/specs/
 * flow-design.md §1.1–§1.3): the open orders as a list — the order on the screen ("על המסך") and the held sales
 * ("מושהה") — and "+ הזמנה חדשה". The Windows till has no tables: the list is the whole home (Android's narrow home
 * without the map), and a new order is always a pickup — asked its name first when `flow.pickupName` says so
 * ("ask" / "required"), then the quick order. An order already on the screen is asked about first ("השהה והמשך" /
 * "עבור אליה"). The palette is FlowColors.palette (designLayout flowPalette): ours, or the page in `flow.background`.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import type { TillState } from '../../../../shared/till/protocol';
import type { TillDesignView } from '../../../../core/till/tillDesign';
import { money } from '../text';
import { Icon } from '../theme/icons';
import { DT } from './designText';
import { flowPalette, flowPickupAsks, flowVars } from './designLayout';
import type { DesignOps } from './DesignedSell';

/** FlowIcons (24×24 line icons, round caps). */
const RECEIPT = ['M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z', 'M9 8h6', 'M9 12h6', 'M9 16h3.5'];
const BAG = ['M5.5 8h13l-1 12.5h-11z', 'M9 10V7a3 3 0 0 1 6 0v3'];

function LineIcon({ paths, size = 24 }: { paths: string[]; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

interface Row {
  key: string;
  kind: 'live' | 'held';
  heldId?: string;
  title: string;
  sub: string;
  total: number;
}

export function FlowHome({
  state,
  design,
  dark,
  brand,
  onOrder,
  onHeldSheet,
  ops,
}: {
  state: TillState;
  design: TillDesignView;
  /** The till's theme is dark now (the page then takes our dark set, without a chosen background). */
  dark: boolean;
  /** The design's accent or the brand colour (#RRGGBB); null — ours. */
  brand: string | null;
  /** To the order screen (the quick order on the till). */
  onOrder(): void;
  /** Today's held sales sheet (where a held sale comes back without `ops.resume`). */
  onHeldSheet?(): void;
  ops?: DesignOps;
}) {
  const palette = useMemo(() => flowPalette(design.flow.background, design.colors.accent ?? brand, dark), [design.flow.background, design.colors.accent, brand, dark]);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [liveAsk, setLiveAsk] = useState(false);
  const [askName, setAskName] = useState<string | null>(null);
  const sell = state.sell;
  const liveLines = sell.lines.filter((l) => !l.refund);
  const now = Date.now();

  const rows: Row[] = [];
  if (liveLines.length > 0) {
    const takeAway = state.order?.dining === 'take_away';
    rows.push({
      key: 'live',
      kind: 'live',
      title: state.order?.name?.trim() || (takeAway ? DT.flowPickupTitle : DT.flowQuickTitle),
      sub: DT.flowItems(String(liveLines.reduce((s, l) => s + l.qty, 0))),
      total: sell.totalAgorot,
    });
  }
  for (const h of state.held?.sales ?? []) {
    const at = Date.parse(h.at);
    const minutes = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : null;
    rows.push({
      key: `held:${h.id}`,
      kind: 'held',
      heldId: h.id,
      title: h.label?.trim() || DT.flowPickupTitle,
      sub: [DT.flowItems(String(h.itemCount)), minutes !== null ? DT.minutes(minutes) : null].filter(Boolean).join(' · '),
      total: h.totalAgorot,
    });
  }
  const q = query.trim();
  const shown = q ? rows.filter((r) => r.title.includes(q) || r.sub.includes(q)) : rows;

  const askMode = flowPickupAsks(design.flow.pickupName);
  const startPickup = () => {
    if (askMode !== 'off') return setAskName('');
    onOrder();
  };
  const newOrder = () => (liveLines.length > 0 ? setLiveAsk(true) : startPickup());
  const openRow = (r: Row) => {
    if (r.kind === 'live') return onOrder();
    if (r.heldId && ops?.resume && sell.lines.length === 0) {
      ops.resume(r.heldId);
      return onOrder();
    }
    onHeldSheet?.();
  };

  return (
    <div className="f-home" style={flowVars(palette) as CSSProperties} data-dark={palette.dark ? '1' : '0'}>
      <div className="f-top">
        {searching ? (
          <>
            <div className="f-search">
              <Icon name="search" size={20} />
              <input autoFocus value={query} placeholder={DT.flowSearchHint} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button
              type="button"
              className="f-icon"
              aria-label={DT.flowClose}
              onClick={() => {
                setSearching(false);
                setQuery('');
              }}
            >
              <Icon name="close" />
            </button>
          </>
        ) : (
          <>
            <h1 className="f-title">{DT.flowOrders}</h1>
            <button type="button" className="f-icon" aria-label={DT.flowSearch} onClick={() => setSearching(true)}>
              <Icon name="search" />
            </button>
          </>
        )}
      </div>
      <div className="f-body">
        {shown.length === 0 ? (
          <div className="f-empty">
            <span className="f-empty-icon">{searching && q ? <Icon name="search" size={40} /> : <LineIcon paths={RECEIPT} size={40} />}</span>
            <strong>{searching && q ? DT.flowSearchEmpty : DT.flowEmptyTitle}</strong>
            {searching && q ? null : <span>{DT.flowEmptyBody}</span>}
          </div>
        ) : (
          <ol className="f-list">
            {shown.map((r) => (
              <li key={r.key}>
                <button type="button" className="f-row" onClick={() => openRow(r)}>
                  <span className={`f-row-badge${r.kind === 'live' ? ' f-row-badge-live' : ''}`}>
                    <LineIcon paths={BAG} />
                  </span>
                  <span className="f-row-text">
                    <span className="f-row-title">{r.title}</span>
                    {r.sub ? <span className="f-row-sub">{r.sub}</span> : null}
                  </span>
                  <span className="f-row-end">
                    <span className="f-row-amount">{money(r.total)}</span>
                    <span className="f-row-state">
                      <span className={`f-dot${r.kind === 'live' ? ' f-dot-live' : ''}`} />
                      {r.kind === 'live' ? DT.flowStateLive : DT.flowStateHeld}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
        <button type="button" className="f-new" onClick={newOrder}>
          <Icon name="add" />
          <span>{DT.flowNewOrder}</span>
        </button>
      </div>

      {liveAsk ? (
        <div className="t-overlay" role="dialog" aria-modal="true" aria-label={DT.flowLiveTitle} onClick={() => setLiveAsk(false)}>
          <div className="t-dialog f-card" onClick={(e) => e.stopPropagation()}>
            <h2 className="t-dialog-title">{DT.flowLiveTitle}</h2>
            <p className="t-dialog-body">{DT.flowLiveBody}</p>
            {ops?.park ? (
              <button
                type="button"
                className="f-primary"
                onClick={() => {
                  setLiveAsk(false);
                  ops.park?.(state.order?.name ?? null);
                  startPickup();
                }}
              >
                {DT.flowLiveHold}
              </button>
            ) : null}
            <button
              type="button"
              className="f-secondary"
              onClick={() => {
                setLiveAsk(false);
                onOrder();
              }}
            >
              {DT.flowLiveGo}
            </button>
          </div>
        </div>
      ) : null}

      {askName !== null ? (
        // The wizard's name step (FlowWizardUi): "שם להזמנה?", then the quick order taken away.
        <div className="t-overlay" role="dialog" aria-modal="true" aria-label={DT.flowQName} onClick={() => setAskName(null)}>
          <div className="t-dialog f-card" onClick={(e) => e.stopPropagation()}>
            <div className="f-card-head">
              <button type="button" className="f-icon" aria-label={DT.flowClose} onClick={() => setAskName(null)}>
                <Icon name="close" />
              </button>
            </div>
            <h2 className="f-question">{DT.flowQName}</h2>
            <input className="f-input" autoFocus value={askName} placeholder={DT.flowNameHint} maxLength={40} onChange={(e) => setAskName(e.target.value)} />
            {askMode === 'ask' ? <p className="f-hint">{DT.flowNameOptional}</p> : null}
            <button
              type="button"
              className="f-primary"
              disabled={askMode === 'required' && askName.trim() === ''}
              onClick={() => {
                const name = askName.trim();
                setAskName(null);
                // A pickup is taken away — said where the till asks it (fields.serviceType), the name where one was typed.
                const takeAway = design.fields.serviceType !== 'off';
                if (ops?.orderDetails && (takeAway || name)) ops.orderDetails({ ...(takeAway ? { dining: 'take_away' as const } : {}), ...(name ? { name } : {}) });
                onOrder();
              }}
            >
              {DT.flowOpenOrder}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
