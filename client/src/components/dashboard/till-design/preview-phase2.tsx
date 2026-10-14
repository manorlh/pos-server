'use client';

/**
 * Phase 2's four templates in the preview (P:\specs\till-design-phase2.md §2), from the same
 * regions as the others (the header, the menu, the bill, the bar):
 *
 *  - "לוח מנות" (courses): a lane per course — its state in words ("ממתין", "הוצא 19:44 · לפני
 *    12 דק'", "מוכן 2/3", "הכול מוכן"), "הוצא" / "השהה" at its head — beside the menu sideways,
 *    under it upright; on the handheld the summary grouped by course;
 *  - "עגינת תשלום" (payDock): the 128 dp dock across the bottom (the amount, "חסכתם", card, exact
 *    cash, the banknotes, "תשלום", "עוד") and the bill's selected line with its strip;
 *  - "לילה" (night): the bar's screen in its own palette, the categories on the thumb's side, the
 *    order on the other, the quick add-ons after an add;
 *  - "תפריט ויזואלי" (visual): dish cards (photo 16:10, description, dietary words) and the
 *    floating order drawer; a category with fewer than half its products photographed shows as
 *    text cards.
 */

import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { FIRE_GAP_MIN, gridColumns, sideBillWidth, tileHeight } from '@/lib/tillDesign';
import {
  ActionBar,
  ActionButton,
  Chosen,
  FONT,
  Num,
  PlusSquare,
  R,
  R_SMALL,
  StatusChip,
  Stepper,
  TotalRow,
  ellipsis,
  formatMoney,
  gap,
  pad,
  useBoxSize,
} from './preview-atoms';
import { BillLines, BottomBlock, CategoryRow, CollapsibleSummary, Extras, MenuArea, OrderHeader, SidePanel } from './preview-designed';
import type { CourseLane, PAction, PLine, PProduct, PreviewEvent, PreviewModel } from './preview-model';
import { DIETARY_WORDS, TileName, TilePrice, wrapsName } from './preview-tile-text';

type D = (e: PreviewEvent) => void;

export function Phase2Screen({ m, d }: { m: PreviewModel; d: D }) {
  switch (m.view.template) {
    case 'courses':
      return <CoursesScreen m={m} d={d} />;
    case 'payDock':
      return <PayDockScreen m={m} d={d} />;
    case 'night':
      return <NightScreen m={m} d={d} />;
    default:
      return <VisualScreen m={m} d={d} />;
  }
}

function SmallButton({ m, label, onClick, strong = false }: { m: PreviewModel; label: string; onClick?: () => void; strong?: boolean }) {
  const t = m.t;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 36,
        padding: '0 12px',
        borderRadius: R_SMALL,
        border: `1px solid ${strong ? t.accent : t.border}`,
        background: strong ? t.tint : t.surface,
        color: strong ? t.accent : t.ink,
        fontWeight: 600,
        fontSize: m.fs(14),
        fontFamily: FONT,
        cursor: onClick ? 'pointer' : 'default',
        flex: '0 0 auto',
      }}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------ לוח מנות */

/** The sample's clock: the first course went at 19:44, it is 19:56 now. */
const FIRED_AT = '19:44';
const MINUTES_SINCE = 12;

function laneState(m: PreviewModel, lane: CourseLane, previousFired: boolean): { text: string; amber: boolean } {
  if (lane.course === null) return { text: 'יוצא עם כל שידור', amber: false };
  if (lane.held) return { text: 'מושהה', amber: true };
  if (!lane.fired) {
    const gapMinutes = m.cfg.courses?.fireGapMinutes ?? 0;
    // "זמן להוציא": a reminder on the next waiting lane only, counted from the course before it.
    if (gapMinutes >= FIRE_GAP_MIN && previousFired) {
      const left = gapMinutes - MINUTES_SINCE;
      return left > 0 ? { text: `ממתין · להוציא בעוד ${left} דק'`, amber: true } : { text: 'הגיע הזמן להוציא', amber: true };
    }
    return { text: 'ממתין', amber: true };
  }
  const explicit = (m.state.firedNow ?? []).includes(lane.course);
  const when = explicit ? 'הוצא עכשיו' : `הוצא ${FIRED_AT} · לפני ${MINUTES_SINCE} דק'`;
  if (lane.sent > 0 && lane.ready === lane.sent) return { text: `${when} · הכול מוכן`, amber: false };
  return { text: lane.sent > 0 ? `${when} · מוכן ${lane.ready}/${lane.sent}` : when, amber: false };
}

function LaneLine({ m, l, lane }: { m: PreviewModel; l: PLine; lane: CourseLane }) {
  const t = m.t;
  const status = l.status === 'new' ? (lane.fired && !lane.held ? 'new' : 'pending') : 'sent';
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: R_SMALL, background: t.surface, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: m.fs(15), fontWeight: 600, minWidth: 0, ...ellipsis(1) }}>
          <Num style={{ color: t.ink2, marginLeft: 6 }}>{`×${l.qty}`}</Num>
          {l.name}
        </span>
        {l.seat > 0 ? <span style={{ fontSize: m.fs(12), color: t.ink2, flex: '0 0 auto' }}>{`ס${l.seat}`}</span> : null}
      </div>
      {l.note ? <span style={{ fontSize: m.fs(13), color: t.ink2, ...ellipsis(1) }}>{l.note}</span> : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {l.status !== 'new' && l.ready ? (
          <span style={{ fontSize: m.fs(12), fontWeight: 700, color: t.accent, border: `1px solid ${t.accent}`, borderRadius: 6, padding: '1px 8px' }}>מוכן</span>
        ) : (
          <StatusChip m={m} status={status} />
        )}
      </div>
    </div>
  );
}

function fireEvent(m: PreviewModel, lane: CourseLane): PreviewEvent {
  const fired = m.lanes.filter((l) => l.fired && l.course !== null).map((l) => l.course as number);
  return { type: 'fire', course: lane.course as number, lineIds: lane.lines.map((l) => l.id), fired };
}

function Lane({ m, d, lane, width, previousFired }: { m: PreviewModel; d: D; lane: CourseLane; width: number | string; previousFired: boolean }) {
  const t = m.t;
  const state = laneState(m, lane, previousFired);
  return (
    <div style={{ width, flex: typeof width === 'number' ? `0 0 ${width}px` : '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, border: `1px solid ${t.border}`, borderRadius: R, background: t.bg, padding: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: m.fs(16), fontWeight: 700, ...ellipsis(1) }}>{lane.name}</div>
          <div style={{ fontSize: m.fs(12), fontWeight: 600, color: state.amber ? t.amberInk : t.ink2, ...ellipsis(2) }}>{state.text}</div>
        </div>
        {lane.course !== null && !lane.fired ? (
          <div style={{ display: 'flex', gap: 6 }}>
            {lane.unsent && !lane.held ? <SmallButton m={m} label="השהה" onClick={() => d({ type: 'hold', course: lane.course as number })} /> : null}
            <SmallButton m={m} label="הוצא" strong onClick={() => d(fireEvent(m, lane))} />
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, overflow: 'hidden' }}>
        {lane.lines.map((l) => (
          <LaneLine key={l.id} m={m} l={l} lane={lane} />
        ))}
      </div>
    </div>
  );
}

/** The lanes side by side; the ones that do not fit scroll ("עוד 2 שלבים"). */
function LanesBoard({ m, d }: { m: PreviewModel; d: D }) {
  const [ref, size] = useBoxSize<HTMLDivElement>();
  const G = gap(m);
  const laneWidth = 190;
  const fits = Math.max(1, Math.floor((size.w + G) / (laneWidth + G)));
  const lanes = m.lanes;
  const shown = lanes.slice(0, fits);
  const rest = lanes.length - shown.length;
  const width = Math.floor((size.w - G * (shown.length - 1)) / Math.max(1, shown.length));
  return (
    <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div ref={ref} style={{ flex: '1 1 0', minHeight: 0, display: 'flex', gap: G, overflow: 'hidden' }}>
        {size.w > 0
          ? shown.map((lane, i) => (
              <Lane key={String(lane.course)} m={m} d={d} lane={lane} width={width} previousFired={i > 0 && shown[i - 1].fired && shown[i - 1].course !== null} />
            ))
          : null}
        {lanes.length === 0 ? <p style={{ color: m.t.ink2, fontSize: m.fs(15), padding: 16 }}>{m.text('emptyOrder')}</p> : null}
      </div>
      {rest > 0 ? <span style={{ fontSize: m.fs(12), color: m.t.ink2 }}>{rest === 1 ? 'עוד שלב אחד ←' : `עוד ${rest} שלבים ←`}</span> : null}
    </div>
  );
}

/** The handheld: the summary that opens upward, grouped by course, "הוצא" on each waiting group. */
function CourseSummary({ m, d }: { m: PreviewModel; d: D }) {
  const t = m.t;
  const P = pad(m);
  const open = m.summaryOpen;
  return (
    <div style={{ flex: '0 0 auto', background: t.surface, borderTop: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', maxHeight: open ? '70%' : undefined }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => d({ type: 'summary', open: !open })}
        style={{ height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `0 ${P}px`, border: 'none', borderBottom: `1px solid ${t.border}`, background: 'transparent', color: t.ink, fontFamily: FONT, fontSize: m.fs(15), cursor: 'pointer' }}
      >
        <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {open ? <ChevronDown size={20} /> : <ChevronUp size={20} />}
          {`${m.text('summary')} · ${m.units} פריטים`}
        </span>
        <Num style={{ fontSize: m.fs(22), fontWeight: 700 }}>{formatMoney(m.total)}</Num>
      </button>
      {open ? (
        <div style={{ overflow: 'hidden', padding: `8px ${P}px`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {m.lanes.map((lane, i) => {
            const state = laneState(m, lane, i > 0 && m.lanes[i - 1].fired && m.lanes[i - 1].course !== null);
            return (
              <div key={String(lane.course)} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontSize: m.fs(15), fontWeight: 700 }}>{lane.name}</span>
                    <span style={{ fontSize: m.fs(12), color: state.amber ? t.amberInk : t.ink2, marginInlineStart: 8 }}>{state.text}</span>
                  </span>
                  {lane.course !== null && !lane.fired ? <SmallButton m={m} label="הוצא" strong onClick={() => d(fireEvent(m, lane))} /> : null}
                </div>
                {lane.lines.map((l) => (
                  <span key={l.id} style={{ fontSize: m.fs(14), color: t.ink, ...ellipsis(1) }}>
                    <Num style={{ color: t.ink2, marginLeft: 6 }}>{`×${l.qty}`}</Num>
                    {l.name}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
      <div style={{ padding: `10px ${P}px ${P}px` }}>
        <ActionBar m={m} layout="handheld" />
      </div>
    </div>
  );
}

function CoursesScreen({ m, d }: { m: PreviewModel; d: D }) {
  const t = m.t;
  const P = pad(m);
  if (m.handheld) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <OrderHeader m={m} />
        <MenuArea m={m} d={d} />
        <CourseSummary m={m} d={d} />
      </div>
    );
  }
  const board = (
    <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: P, background: t.surface }}>
      <LanesBoard m={m} d={d} />
      <ActionBar m={m} layout="row" />
    </div>
  );
  const sideways = m.W > m.H;
  if (sideways) {
    const width = sideBillWidth('courses', m.W);
    return (
      <div style={{ display: 'flex', height: '100%' }}>
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <OrderHeader m={m} />
          <MenuArea m={m} d={d} />
        </div>
        <div style={{ width, flex: `0 0 ${width}px`, display: 'flex', borderInlineStart: `1px solid ${t.border}` }}>{board}</div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <OrderHeader m={m} />
      <div style={{ flex: '0 0 50%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <MenuArea m={m} d={d} />
      </div>
      <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', borderTop: `1px solid ${t.border}` }}>{board}</div>
    </div>
  );
}

/* ------------------------------------------------------------ עגינת תשלום */

function DockButton({ m, a, height, grow = 1, label }: { m: PreviewModel; a: PAction; height: number; grow?: number; label?: Pick<PAction, 'label' | 'sub'> }) {
  return <ActionButton m={m} a={label ? { ...a, ...label } : a} height={height} style={{ flex: `${grow} 1 0`, minWidth: 0 }} />;
}

/** The dock's buttons: the main one (a quick order's card, a table's "שדר") first and widest, then the rest and "עוד". */
function dockActions(m: PreviewModel): { main: PAction | null; rest: PAction[]; more: PAction } {
  const empty = m.lines.length === 0;
  const list = m.actions.map((a) => (empty ? { ...a, disabled: true } : a));
  const mainKey = m.mode === 'table' ? 'send' : list.some((a) => a.action === 'fastCard') ? 'fastCard' : 'pay';
  const main = list.find((a) => a.action === mainKey) ?? null;
  // "מימין לשמאל": the amount, the main button, exact cash, the banknotes (fewer on a narrower
  // screen), the rest, "תשלום", "עוד".
  const rank = (a: PAction) => (a.action === 'fastCash' ? 0 : a.action === 'cashWithChange' ? 1 : a.action === 'note' ? 2 : a.action === 'pay' ? 9 : 5);
  const maxNotes = m.W >= 1200 ? 3 : m.W >= 1000 ? 2 : 1;
  let notes = 0;
  const rest = list
    .filter((a) => a !== main)
    .filter((a) => a.action !== 'note' || ++notes <= maxNotes)
    .sort((a, b) => rank(a) - rank(b))
    .map((a) => ({ ...a, primary: false, label: a.action === 'pay' && m.mode === 'quick' ? m.text('pay') : a.label }));
  const more: PAction = { key: 'more', action: 'more', label: 'עוד', primary: false, disabled: false };
  return { main: main ? { ...main, primary: true } : null, rest, more };
}

function dockLabel(m: PreviewModel, a: PAction): Pick<PAction, 'label' | 'sub'> | undefined {
  // "מזומן מדויק ₪117.20" (fastCash) and "אשראי" when the button has no label of its own.
  const own = m.cfg.actionBar?.quick?.find((i) => i.action === a.action)?.label?.trim();
  if (own) return undefined;
  if (a.action === 'fastCash') return { label: 'מזומן מדויק', sub: formatMoney(m.due) };
  if (a.action === 'fastCard') return { label: 'אשראי' };
  return undefined;
}

function PayDock({ m }: { m: PreviewModel }) {
  const t = m.t;
  const P = pad(m);
  const { main, rest, more } = dockActions(m);
  const empty = m.lines.length === 0;
  const amount = (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: m.handheld ? 0 : 200, flex: m.handheld ? '1 1 auto' : '0 0 auto' }}>
      <span style={{ fontSize: m.fs(m.handheld ? 22 : 28), fontWeight: 700, whiteSpace: 'nowrap' }}>
        {'לתשלום '}
        <Num>{formatMoney(m.due)}</Num>
      </span>
      <span style={{ fontSize: m.fs(13), color: t.ink2, whiteSpace: 'nowrap' }}>
        {empty ? (
          m.text('emptyOrder')
        ) : (
          <>
            {m.savings > 0 ? (
              <>
                {'חסכתם '}
                <Num>{formatMoney(m.savings)}</Num>
                {' · '}
              </>
            ) : null}
            {`${m.units} פריטים`}
          </>
        )}
      </span>
    </div>
  );
  if (m.handheld) {
    // Two compact rows: the amount and the saving; card, exact cash, "עוד".
    const exact = rest.find((a) => a.action === 'fastCash');
    return (
      <div style={{ flex: '0 0 auto', background: t.surface, borderTop: `1px solid ${t.border}`, padding: `8px ${P}px ${P}px`, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {amount}
        <div style={{ display: 'flex', gap: 8 }}>
          {main ? <DockButton m={m} a={main} height={52} grow={1.4} label={dockLabel(m, main)} /> : null}
          {exact ? <DockButton m={m} a={exact} height={52} label={{ label: 'מזומן מדויק' }} /> : null}
          <DockButton m={m} a={more} height={52} grow={0.7} />
        </div>
      </div>
    );
  }
  return (
    <div style={{ flex: '0 0 128px', height: 128, boxSizing: 'border-box', background: t.surface, borderTop: `1px solid ${t.border}`, padding: `16px ${P}px`, display: 'flex', alignItems: 'center', gap: 10 }}>
      {amount}
      {main ? <DockButton m={m} a={main} height={96} grow={1.6} label={dockLabel(m, main)} /> : null}
      {rest.map((a) => (
        <DockButton key={a.key} m={m} a={a} height={96} label={dockLabel(m, a)} />
      ))}
      <ActionButton m={m} a={more} height={96} style={{ flex: '0 0 104px' }} />
    </div>
  );
}

/** The bill's lines, one selectable: a tap selects it ("נבחר"), its strip opens under the lines. */
function SelectableLines({ m, d }: { m: PreviewModel; d: D }) {
  const t = m.t;
  const selected = m.lines.find((l) => l.id === m.state.selectedLine) ?? null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden' }}>
        {m.lines.length === 0 ? <p style={{ color: t.ink2, fontSize: m.fs(15), padding: '16px 0', textAlign: 'center' }}>{m.text('emptyOrder')}</p> : null}
        {m.lines.map((l) => {
          const on = l.id === selected?.id;
          return (
            <button
              key={l.id}
              type="button"
              aria-pressed={on}
              onClick={() => d({ type: 'select', lineId: l.id })}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                minHeight: 48,
                padding: '6px 10px',
                borderRadius: R_SMALL,
                border: `1px solid ${on ? t.accent : t.border}`,
                background: on ? t.tint : t.surface,
                color: t.ink,
                fontFamily: FONT,
                textAlign: 'start',
                cursor: 'pointer',
              }}
            >
              <span style={{ minWidth: 0, fontSize: m.fs(15), fontWeight: on ? 700 : 600, ...ellipsis(1) }}>
                <Num style={{ color: t.ink2, marginLeft: 6, fontWeight: 500 }}>{`×${l.qty}`}</Num>
                {l.name}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
                {on ? <Chosen t={t} label="נבחר" /> : null}
                <Num style={{ fontSize: m.fs(15), fontWeight: 600 }}>{formatMoney(l.qty * l.unit)}</Num>
              </span>
            </button>
          );
        })}
        {m.savings > 0 ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: m.fs(13), color: t.ink2, padding: '0 10px' }}>
            <span>מבצע: 2 קולה ב-₪24</span>
            <Num>{`-${formatMoney(m.savings)}`}</Num>
          </div>
        ) : null}
      </div>
      {selected ? (
        <div style={{ border: `1px solid ${t.accent}`, borderRadius: R, background: t.surface, padding: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: m.fs(15), fontWeight: 700, flex: '1 1 100%', ...ellipsis(1) }}>{selected.name}</span>
          <Stepper m={m} qty={selected.qty} size={36} onStep={(delta) => d({ type: 'step', lineId: selected.id, delta })} />
          <SmallButton m={m} label="הנחה לשורה" />
          <SmallButton m={m} label="הערה" />
          <SmallButton m={m} label="הסר" onClick={() => d({ type: 'step', lineId: selected.id, delta: -selected.qty })} />
        </div>
      ) : null}
    </div>
  );
}

function PayDockScreen({ m, d }: { m: PreviewModel; d: D }) {
  const t = m.t;
  const P = pad(m);
  const bill = m.view.billPosition[m.mode];
  const menu = (
    <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <OrderHeader m={m} />
      <Extras m={m} d={d} />
      <MenuArea m={m} d={d} />
    </div>
  );
  if (m.handheld) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {menu}
        {m.summaryOpen ? (
          <div style={{ flex: '0 1 auto', maxHeight: '40%', overflow: 'hidden', padding: `8px ${P}px`, borderTop: `1px solid ${t.border}`, background: t.surface }}>
            <SelectableLines m={m} d={d} />
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => d({ type: 'summary', open: !m.summaryOpen })}
          style={{ height: 44, border: 'none', borderTop: `1px solid ${t.border}`, background: t.surface, color: t.ink, fontFamily: FONT, fontSize: m.fs(14), fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer' }}
        >
          {m.summaryOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          {`${m.text('summary')} · ${m.units} פריטים`}
        </button>
        <PayDock m={m} />
      </div>
    );
  }
  const side = bill === 'end' || bill === 'start';
  const billPane = (
    <div
      style={
        side
          ? { width: sideBillWidth('payDock', m.W), flex: `0 0 ${sideBillWidth('payDock', m.W)}px`, background: t.surface, borderInlineStart: bill === 'end' ? `1px solid ${t.border}` : undefined, borderInlineEnd: bill === 'start' ? `1px solid ${t.border}` : undefined, padding: P, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden' }
          : { flex: '0 0 auto', maxHeight: '30%', background: t.surface, borderTop: `1px solid ${t.border}`, padding: P, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden' }
      }
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: m.fs(18), fontWeight: 700 }}>{m.text('orderTitle')}</span>
        <span style={{ fontSize: m.fs(13), color: t.ink2 }}>{`${m.units} פריטים`}</span>
      </div>
      <SelectableLines m={m} d={d} />
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {side ? (
        <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex' }}>{bill === 'start' ? [<div key="b" style={{ display: 'flex' }}>{billPane}</div>, <div key="m" style={{ flex: '1 1 0', minWidth: 0, display: 'flex' }}>{menu}</div>] : [<div key="m" style={{ flex: '1 1 0', minWidth: 0, display: 'flex' }}>{menu}</div>, <div key="b" style={{ display: 'flex' }}>{billPane}</div>]}</div>
      ) : (
        <>
          {menu}
          {billPane}
        </>
      )}
      <PayDock m={m} />
    </div>
  );
}

/* ------------------------------------------------------------ לילה */

/** The quick add-ons after an add (the sample's drinks; a product with no optional group has none). */
const SAMPLE_ADDONS: Record<string, string[]> = {
  'p-beer': ['חצי', 'שליש', 'צ׳ייסר'],
  'p-cola': ['קרח', 'לימון'],
  'p-lemonade': ['קרח', 'נענע', 'כפול'],
};

function QuickAddons({ m, d }: { m: PreviewModel; d: D }) {
  const t = m.t;
  const P = pad(m);
  const id = m.state.lastAdded;
  const addons = id && m.cfg.night?.quickAddons !== false ? SAMPLE_ADDONS[id] : undefined;
  const product = m.allProducts.find((p) => p.id === id);
  if (!addons || !product) return null;
  return (
    <div style={{ margin: `0 ${P}px 10px`, padding: 8, borderRadius: R, border: `2px solid ${t.accent}`, background: t.surface, display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
      <span style={{ fontSize: m.fs(14), color: t.ink2, whiteSpace: 'nowrap' }}>{`תוספות ל${product.name}`}</span>
      {addons.slice(0, 6).map((a) => (
        <span key={a} style={{ height: 64, minWidth: 88, padding: '0 14px', borderRadius: R_SMALL, border: `2px solid ${t.border}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: m.fs(18), fontWeight: 700 }}>
          {a}
        </span>
      ))}
      <button type="button" aria-label="סגירה" onClick={() => d({ type: 'addons', productId: null })} style={{ marginInlineStart: 'auto', width: 64, height: 64, borderRadius: R_SMALL, border: `2px solid ${t.border}`, background: 'transparent', color: t.ink, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
        <X size={24} />
      </button>
    </div>
  );
}

function NightScreen({ m: base, d }: { m: PreviewModel; d: D }) {
  // The thumbs' layout (§2.3): the categories on one side (right by default), the order on the
  // other; upright: the categories over the keys and the order under them.
  const hand = base.cfg.night?.hand === 'left' ? 'left' : 'right';
  const sideways = base.W > base.H && !base.handheld;
  const chosen = base.view.billPosition[base.mode];
  const auto = chosen === 'end' || chosen === 'start' || chosen === 'bottom';
  const bill = !auto ? chosen : sideways ? (hand === 'right' ? 'end' : 'start') : 'bottom';
  const m: PreviewModel = {
    ...base,
    view: { ...base.view, categoryBar: sideways ? 'side' : 'top', billPosition: { table: bill, quick: bill } },
  };
  const menu = (
    <div key="menu" style={{ flex: '1 1 0', minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <OrderHeader m={m} />
      <Extras m={m} d={d} />
      <QuickAddons m={m} d={d} />
      <MenuArea m={m} d={d} railAtEnd={hand === 'left'} />
    </div>
  );
  if (bill === 'end' || bill === 'start') {
    const panel = <SidePanel key="panel" m={m} d={d} side={bill} />;
    return <div style={{ display: 'flex', height: '100%' }}>{bill === 'start' ? [panel, menu] : [menu, panel]}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {menu}
      {m.handheld || bill === 'sheet' ? <CollapsibleSummary m={m} d={d} sheet={bill === 'sheet'} /> : <BottomBlock m={m} d={d} />}
    </div>
  );
}

/* ------------------------------------------------------------ תפריט ויזואלי */

/** The categories with at least half their products photographed (the others show as text cards). */
function photographedCategories(products: readonly PProduct[]): Set<string | null> {
  const by = new Map<string | null, { all: number; photo: number }>();
  for (const p of products) {
    const row = by.get(p.categoryId) ?? { all: 0, photo: 0 };
    row.all += 1;
    if (p.imageUrl) row.photo += 1;
    by.set(p.categoryId, row);
  }
  return new Set([...by].filter(([, r]) => r.photo * 2 >= r.all && r.photo > 0).map(([id]) => id));
}

function DietaryWords({ m, p }: { m: PreviewModel; p: PProduct }) {
  if (!m.dietaryShown || !p.dietary?.length) return null;
  return (
    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {p.dietary.map((tag) => (
        <span key={tag} style={{ fontSize: m.fs(12), color: m.t.ink2, border: `1px solid ${m.t.border}`, borderRadius: 6, padding: '0 6px' }}>
          {DIETARY_WORDS[tag] ?? tag}
        </span>
      ))}
    </span>
  );
}

function DishCard({ m, p, d, photoArea, h }: { m: PreviewModel; p: PProduct; d: D; photoArea: boolean; h: number }) {
  const t = m.t;
  const lines = Math.max(0, Math.min(2, m.cfg.visual?.descriptionLines ?? 2));
  const photo = photoArea && m.showImages ? p.imageUrl : null;
  const added = m.state.lastAdded === p.id;
  const face: CSSProperties = { aspectRatio: '16 / 10', width: '100%', background: t.tint, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8, boxSizing: 'border-box' };
  const wrap = wrapsName(m);
  // The name under the photo: as many lines as the setting allows (up to two beside a description), the
  // badge at the top-left of the card's text.
  const nameLines = Math.max(1, Math.min(m.productText.productNameMaxLines, p.description && lines > 0 ? 2 : 3));
  return (
    <div
      style={{
        ...(wrap ? { minHeight: h } : { height: h }),
        position: 'relative',
        minWidth: 0,
        borderRadius: R,
        border: `1px solid ${added ? t.accent : t.border}`,
        background: t.surface,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        opacity: p.available ? 1 : 0.45,
      }}
    >
      {photoArea && m.showImages ? (
        photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt="" style={{ display: 'block', width: '100%', aspectRatio: '16 / 10', objectFit: 'cover' }} />
        ) : (
          <div style={face}>
            <span style={{ fontSize: m.fs(22), fontWeight: 700, textAlign: 'center', color: t.ink, ...ellipsis(2) }}>{p.name}</span>
          </div>
        )
      ) : null}
      <div style={{ flex: '1 1 auto', minHeight: 0, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <TileName
          m={m}
          p={p}
          d={d}
          size={m.fs(18)}
          tileLines={p.description && lines > 0 ? 1 : 2}
          style={{ flex: '0 1 auto', height: Math.ceil(m.fs(18) * 1.2 * nameLines) }}
        />
        {p.description && lines > 0 ? <span style={{ fontSize: m.fs(13), color: t.ink2, lineHeight: 1.35, ...ellipsis(lines) }}>{p.description}</span> : null}
        <DietaryWords m={m} p={p} />
        <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <TilePrice agorot={p.price} size={m.fs(16)} weight={600} />
          {added ? <span style={{ fontSize: m.fs(12), fontWeight: 700, color: t.accent }}>נוסף</span> : null}
          <button type="button" aria-label={`הוספת ${p.name}`} onClick={() => d({ type: 'add', product: p })} style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}>
            <PlusSquare m={m} size={40} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The handheld's row: a square 88 dp photo, the name, a line of description and the price. */
function DishRow({ m, p, d, photoArea }: { m: PreviewModel; p: PProduct; d: D; photoArea: boolean }) {
  const t = m.t;
  const photo = photoArea && m.showImages ? p.imageUrl : null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 8, borderRadius: R, border: `1px solid ${t.border}`, background: t.surface, opacity: p.available ? 1 : 0.45 }}>
      {photoArea && m.showImages ? (
        photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt="" style={{ width: 88, height: 88, objectFit: 'cover', borderRadius: R_SMALL, flex: '0 0 88px' }} />
        ) : (
          <span style={{ width: 88, height: 88, flex: '0 0 88px', borderRadius: R_SMALL, background: t.tint }} />
        )
      ) : null}
      <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TileName m={m} p={p} d={d} size={m.fs(16)} tileLines={1} style={{ height: Math.ceil(m.fs(16) * 1.2 * Math.min(2, m.productText.productNameMaxLines)) }} />
        {p.description && (m.cfg.visual?.descriptionLines ?? 2) > 0 ? <span style={{ fontSize: m.fs(13), color: t.ink2, ...ellipsis(1) }}>{p.description}</span> : null}
        <span style={{ display: 'flex' }}>
          <TilePrice agorot={p.price} size={m.fs(15)} weight={600} />
        </span>
      </span>
      <button type="button" aria-label={`הוספת ${p.name}`} onClick={() => d({ type: 'add', product: p })} style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}>
        <PlusSquare m={m} size={40} />
      </button>
    </div>
  );
}

function DishGrid({ m, d }: { m: PreviewModel; d: D }) {
  const [ref, size] = useBoxSize<HTMLDivElement>();
  const G = gap(m);
  const photographed = photographedCategories(m.allProducts);
  let body: ReactNode = null;
  if (size.w > 0) {
    if (m.handheld) {
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: G }}>
          {m.products.slice(0, 8).map((p) => (
            <DishRow key={p.id} m={m} p={p} d={d} photoArea={photographed.has(p.categoryId)} />
          ))}
        </div>
      );
    } else {
      const cols = gridColumns({ style: 'dish', size: m.tileSize, paneWidth: size.w, handheld: false, columns: m.view.columns, gap: G });
      const tileW = (size.w - (cols - 1) * G) / cols;
      const anyPhoto = m.products.some((p) => photographed.has(p.categoryId));
      const h = tileHeight({ style: 'dish', size: m.tileSize, density: m.view.density, tileWidth: tileW, withPhoto: anyPhoto && m.showImages });
      body = (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: wrapsName(m) ? `minmax(${h}px, auto)` : h, gap: G }}>
          {m.products.slice(0, cols * Math.max(1, Math.ceil((size.h + G) / (h + G)))).map((p) => (
            <DishCard key={p.id} m={m} p={p} d={d} photoArea={photographed.has(p.categoryId)} h={h} />
          ))}
        </div>
      );
    }
  }
  return (
    <div ref={ref} style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      {body}
    </div>
  );
}

function VisualTabs({ m, d }: { m: PreviewModel; d: D }) {
  if (m.handheld) return <CategoryRow m={m} d={d} />;
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${m.t.border}`, overflow: 'hidden', flex: '0 0 auto' }}>
      {[{ id: null as string | null, name: 'הכל' }, ...m.categories].map((c) => {
        const on = m.state.category === c.id;
        return (
          <button
            key={c.id ?? 'all'}
            type="button"
            aria-pressed={on}
            onClick={() => d({ type: 'category', id: c.id })}
            style={{ height: 52, padding: '0 18px', border: 'none', borderBottom: `3px solid ${on ? m.t.accent : 'transparent'}`, background: 'transparent', color: on ? m.t.accent : m.t.ink, fontWeight: on ? 700 : 500, fontSize: m.fs(18), fontFamily: FONT, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

/** The floating drawer: closed — "הזמנה · 3 פריטים · ₪142 ⌃"; open — beside (sideways) or under (upright) the menu. */
function Drawer({ m, d }: { m: PreviewModel; d: D }) {
  const t = m.t;
  const P = pad(m);
  const open = !!m.state.drawerOpen;
  const sideways = m.W > m.H;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => d({ type: 'drawer', open: true })}
        style={{ position: 'absolute', left: P, bottom: P, height: 56, padding: '0 18px', borderRadius: R, border: `1px solid ${t.accent}`, background: t.accent, color: t.onAccent, fontFamily: FONT, fontSize: m.fs(16), fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
      >
        <ChevronUp size={20} />
        {`${m.text('orderTitle')} · ${m.units} פריטים · `}
        <Num>{formatMoney(m.total)}</Num>
      </button>
    );
  }
  const box: CSSProperties = sideways
    ? { position: 'absolute', left: 0, top: 0, bottom: 0, width: sideBillWidth('visual', m.W), borderInlineStart: `1px solid ${t.border}` }
    : { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '70%', borderTop: `1px solid ${t.border}` };
  return (
    <div style={{ ...box, background: t.surface, display: 'flex', flexDirection: 'column', padding: P, gap: 12, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: m.fs(18), fontWeight: 700 }}>{`${m.text('orderTitle')} · ${m.units} פריטים`}</span>
        <button type="button" aria-label="סגירה" onClick={() => d({ type: 'drawer', open: false })} style={{ width: 44, height: 44, borderRadius: R_SMALL, border: `1px solid ${t.border}`, background: t.surface, color: t.ink, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          {sideways ? <X size={20} /> : <ChevronDown size={20} />}
        </button>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
        <BillLines m={m} d={d} wide={false} />
      </div>
      <TotalRow m={m} />
      <ActionBar m={m} layout="stack" />
    </div>
  );
}

function VisualScreen({ m, d }: { m: PreviewModel; d: D }) {
  const P = pad(m);
  const bill = m.view.billPosition[m.mode];
  const menu = (
    <div key="menu" style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <OrderHeader m={m} />
      <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: `0 ${P}px ${P}px` }}>
        <VisualTabs m={m} d={d} />
        <DishGrid m={m} d={d} />
      </div>
    </div>
  );
  if (bill === 'drawer') {
    return (
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%' }}>
        {menu}
        <Drawer m={m} d={d} />
      </div>
    );
  }
  if (bill === 'end' || bill === 'start') {
    const panel = <SidePanel key="panel" m={m} d={d} side={bill} />;
    return <div style={{ display: 'flex', height: '100%' }}>{bill === 'start' ? [panel, menu] : [menu, panel]}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {menu}
      {m.handheld || bill === 'sheet' ? <CollapsibleSummary m={m} d={d} sheet={bill === 'sheet'} /> : <BottomBlock m={m} d={d} />}
    </div>
  );
}

