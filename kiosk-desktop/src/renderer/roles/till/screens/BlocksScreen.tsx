/**
 * "חסומים כעת" and "חסום / אזל" (pos-android ui/blocks/ItemBlocksUi.kt, ItemBlockSheet.kt; core/till/itemBlocks.ts,
 * main/till/tillItemBlocks.ts): the blocks in force with "שחרר" / "שחרר הכל", "חסום פריט" (a picker of the catalog's items and
 * departments), and the sheet of one item — its blocks, then what / where / level / kind / kiosk display / how long / why.
 * The options and their access are the engine's (the operator's reach); a manager's code is the engine's dialog; the cloud
 * decides last. The screen holds only the choices being made.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Catalog } from '../../../../shared/till/protocol';
import { IB_TEXT, type BlockRowView, type BlockSheetView, type BlocksListView } from '../../../../core/till/itemBlocks';
import { T } from '../text';

export interface BlocksActions {
  list(): Promise<BlocksListView | undefined>;
  sheet(item: { productId?: string; categoryId?: string }): Promise<BlockSheetView | undefined>;
  block(request: Record<string, unknown>): Promise<boolean>;
  release(ids: string[]): Promise<boolean>;
}

function Row({ row, onRelease }: { row: BlockRowView; onRelease?: () => void }) {
  const w = row.words;
  return (
    <li className="t-block-row">
      <div>
        <span className={`t-block-pill ${row.kind === 'blocked' ? 't-block-pill-blocked' : 't-block-pill-soldout'}`}>{w.pill}</span>
        {w.name ? <strong> {w.name}</strong> : null}
      </div>
      <div className="t-small">
        {w.level}
        {w.channels ? ` · ${w.channels}` : ''}
        {w.kiosk ? ` · ${w.kiosk}` : ''}
        {w.auto ? ` · ${w.auto}` : ''}
      </div>
      <div className="t-small t-muted">{w.meta}</div>
      {w.note ? <div className="t-small">{w.note}</div> : null}
      {row.releasable && onRelease ? (
        <button type="button" className="t-btn t-btn-danger t-btn-wide" onClick={onRelease}>
          {IB_TEXT.release}
        </button>
      ) : row.why ? (
        <div className="t-small t-muted">{row.why}</div>
      ) : null}
    </li>
  );
}

/** "חסומים כעת". */
export function BlocksScreen({ actions, catalog, back }: { actions: BlocksActions; catalog: Catalog | null; back(): void }) {
  const [view, setView] = useState<BlocksListView | null>(null);
  const [picking, setPicking] = useState(false);
  const [item, setItem] = useState<{ productId?: string; categoryId?: string } | null>(null);
  const load = useCallback(() => void actions.list().then((v) => v && setView(v)), [actions]);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, [load]);
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">{IB_TEXT.title}</h1>
        <div>
          <button type="button" className="t-btn t-btn-ghost" onClick={load}>
            {IB_TEXT.refresh}
          </button>
          <button type="button" className="t-btn t-btn-ghost" onClick={back}>
            {T.back}
          </button>
        </div>
      </div>
      {view?.banner ? <p className="t-warn">{view.banner}</p> : null}
      {view?.live && view.mayBlock ? (
        <button type="button" className="t-btn t-btn-primary" onClick={() => setPicking(true)}>
          {IB_TEXT.blockItem}
        </button>
      ) : null}
      {!view ? <p className="t-muted">{IB_TEXT.loading}</p> : view.rows.length === 0 ? <p className="t-muted">{IB_TEXT.empty}</p> : null}
      <ul className="t-menu">
        {(view?.rows ?? []).map((r) => (
          <Row key={r.id} row={r} onRelease={view?.live ? () => void actions.release([r.id]).then(load) : undefined} />
        ))}
      </ul>
      {picking ? (
        <ItemPicker
          catalog={catalog}
          onPick={(it) => {
            setPicking(false);
            setItem(it);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
      {item ? (
        <BlockSheet
          item={item}
          actions={actions}
          onDone={() => {
            setItem(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

/** "בחרו פריט או מחלקה לחסימה": up to 12 departments, then up to 40 items, by name. */
function ItemPicker({ catalog, onPick, onClose }: { catalog: Catalog | null; onPick(item: { productId?: string; categoryId?: string }): void; onClose(): void }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const departments = (catalog?.departments ?? []).filter((d) => !query || d.name.toLowerCase().includes(query)).slice(0, 12);
  const products = (catalog?.products ?? []).filter((p) => !query || p.name.toLowerCase().includes(query)).slice(0, 40);
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={IB_TEXT.pickerTitle} onClick={onClose}>
      <div className="t-dialog t-dialog-wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="t-dialog-title">{IB_TEXT.pickerTitle}</h2>
        <input className="t-input" autoFocus placeholder={IB_TEXT.pickerSearch} maxLength={60} value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="t-menu t-picker">
          {departments.map((d) => (
            <li key={`c:${d.id}`}>
              <button type="button" className="t-menu-row" onClick={() => onPick({ categoryId: d.id })}>
                {IB_TEXT.department(d.name)}
              </button>
            </li>
          ))}
          {products.map((p) => (
            <li key={`p:${p.id}`}>
              <button type="button" className="t-menu-row" onClick={() => onPick({ productId: p.id })}>
                {p.name}
              </button>
            </li>
          ))}
        </ul>
        <div className="t-dialog-actions">
          <button type="button" className="t-btn t-btn-ghost" onClick={onClose}>
            {IB_TEXT.close}
          </button>
        </div>
      </div>
    </div>
  );
}

type DurationKey = 'm30' | 'm60' | 'm120' | 'at' | 'eod' | 'none';
const DURATIONS: Array<{ k: DurationKey; label: string }> = [
  { k: 'm30', label: IB_TEXT.d30 },
  { k: 'm60', label: IB_TEXT.d60 },
  { k: 'm120', label: IB_TEXT.d120 },
  { k: 'at', label: IB_TEXT.dAt },
  { k: 'eod', label: IB_TEXT.dEndOfDay },
  { k: 'none', label: IB_TEXT.dNone },
];

/** "חסום / אזל · <פריט>" — one sheet for every way in (the tile held, the list's "חסום פריט"). */
export function BlockSheet({ item, actions, onDone }: { item: { productId?: string; categoryId?: string }; actions: BlocksActions; onDone(): void }) {
  const [v, setV] = useState<BlockSheetView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [what, setWhat] = useState<'product' | 'category'>(item.categoryId ? 'category' : 'product');
  const [channels, setChannels] = useState<string[]>([]);
  const [level, setLevel] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [kind, setKind] = useState<'sold_out' | 'blocked'>('sold_out');
  const [kiosk, setKiosk] = useState<'hide' | 'grey' | null>(null);
  const [dur, setDur] = useState<DurationKey>('eod');
  const [at, setAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useCallback(
    () =>
      void actions.sheet(item).then((x) => {
        if (!x) return;
        setV(x);
        setChannels((c) => (c.length ? c : x.defaults.channels));
        setLevel((l) => l ?? x.defaults.level);
      }),
    [actions, item],
  );
  useEffect(() => reload(), [reload]);
  const formShown = !!v && v.mayBlock && (v.rows.length === 0 || expanded);
  const free = (a: string) => a !== 'locked_till' && a !== 'locked_permission';
  const atOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(at.trim());
  const ready = formShown && channels.length > 0 && !!level && (dur !== 'at' || atOk) && (level !== 'event' || !!eventId) && !busy;
  const duration = useMemo(() => {
    if (dur === 'm30') return { mode: 'minutes', minutes: 30 };
    if (dur === 'm60') return { mode: 'minutes', minutes: 60 };
    if (dur === 'm120') return { mode: 'minutes', minutes: 120 };
    if (dur === 'at') return { mode: 'time', at: at.trim() };
    if (dur === 'none') return { mode: 'none' };
    return { mode: 'end_of_day' };
  }, [dur, at]);
  const confirm = async () => {
    if (!v || !level) return;
    const target = what === 'category' && v.what.length ? { categoryId: v.what.find((w) => w.v === 'category')!.id } : v.productId ? { productId: v.productId } : { categoryId: v.categoryId };
    setBusy(true);
    const ok = await actions.block({
      ...target,
      kind,
      channels,
      level,
      levelId: level === 'machine' ? (device ?? v.machineId) : level === 'event' ? eventId : null,
      kioskDisplay: channels.includes('kiosk') ? kiosk : null,
      note,
      duration,
    });
    setBusy(false);
    if (ok) onDone();
  };
  const releasable = (v?.rows ?? []).filter((r) => r.releasable);
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={v?.title ?? IB_TEXT.title} onClick={onDone}>
      <div className="t-dialog t-dialog-wide t-block-sheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="t-dialog-title">{v?.title ?? IB_TEXT.loading}</h2>
        {v?.banner ? <p className="t-warn">{v.banner}</p> : null}
        {v && v.rows.length > 0 ? (
          <section>
            <h3 className="t-menu-title">{IB_TEXT.nowBlocked}</h3>
            <ul className="t-menu">
              {v.rows.map((r) => (
                <Row key={r.id} row={r} onRelease={v.live ? () => void actions.release([r.id]).then(reload) : undefined} />
              ))}
            </ul>
            {releasable.length >= 2 && v.live ? (
              <button type="button" className="t-btn t-btn-danger t-btn-wide" onClick={() => void actions.release(releasable.map((r) => r.id)).then(reload)}>
                {IB_TEXT.releaseAll(releasable.length)}
              </button>
            ) : null}
          </section>
        ) : v && v.live && !v.mayBlock ? (
          <p className="t-muted">{IB_TEXT.notBlocked}</p>
        ) : null}
        {v && !v.mayBlock && v.live ? <p className="t-muted">{IB_TEXT.tillMayNot}</p> : null}
        {v && v.mayBlock && v.rows.length > 0 && !expanded ? (
          <button type="button" className="t-btn" onClick={() => setExpanded(true)}>
            {IB_TEXT.another}
          </button>
        ) : null}
        {formShown && v ? (
          <div className="t-block-form">
            {v.what.length > 0 ? (
              <fieldset>
                <legend>{IB_TEXT.what}</legend>
                {v.what.map((w) => (
                  <button key={w.v} type="button" className={`t-chip${what === w.v ? ' t-chip-on' : ''}`} onClick={() => setWhat(w.v)}>
                    {w.label}
                  </button>
                ))}
              </fieldset>
            ) : null}
            <fieldset>
              <legend>{IB_TEXT.where}</legend>
              {v.channels.map((c) => {
                const on = channels.includes(c.v);
                return (
                  <button
                    key={c.v}
                    type="button"
                    disabled={!free(c.access)}
                    className={`t-chip${on ? ' t-chip-on' : ''}`}
                    onClick={() => setChannels((cur) => (on ? (cur.length > 1 ? cur.filter((x) => x !== c.v) : cur) : [...cur, c.v]))}
                  >
                    {!free(c.access) ? '🔒 ' : ''}
                    {c.label}
                  </button>
                );
              })}
              {channels.length === 0 ? <p className="t-small t-bad">{IB_TEXT.pickChannel}</p> : null}
            </fieldset>
            <fieldset>
              <legend>{IB_TEXT.level}</legend>
              {v.levels
                .filter((l) => l.v !== 'machine' || channels.includes('pos') || channels.includes('kiosk'))
                .map((l) => (
                  <button key={l.v} type="button" disabled={!free(l.access)} className={`t-chip${level === l.v ? ' t-chip-on' : ''}`} onClick={() => setLevel(l.v)}>
                    {!free(l.access) ? '🔒 ' : ''}
                    {l.label}
                  </button>
                ))}
              {v.notes.map((n) => (
                <p key={n} className="t-small t-muted">
                  {n}
                </p>
              ))}
              {level === 'machine' && v.devices.length > 0 ? (
                <div>
                  {v.devices.map((d) => (
                    <button key={d.id} type="button" disabled={!free(d.access)} className={`t-chip${(device ?? v.machineId) === d.id ? ' t-chip-on' : ''}`} onClick={() => setDevice(d.id)}>
                      {d.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {level === 'event' ? (
                <div>
                  {v.events.length === 0 ? <p className="t-small t-bad">{IB_TEXT.pickEvent}</p> : null}
                  {v.events.map((e) => (
                    <button key={e.id} type="button" className={`t-chip${eventId === e.id ? ' t-chip-on' : ''}`} onClick={() => setEventId(e.id)}>
                      {e.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </fieldset>
            <fieldset>
              <legend>{IB_TEXT.kind}</legend>
              <button type="button" className={`t-chip${kind === 'sold_out' ? ' t-chip-on' : ''}`} onClick={() => setKind('sold_out')}>
                {IB_TEXT.kindSoldOut}
              </button>
              <button type="button" className={`t-chip${kind === 'blocked' ? ' t-chip-on' : ''}`} onClick={() => setKind('blocked')}>
                {IB_TEXT.kindBlocked}
              </button>
              <p className="t-small t-muted">{kind === 'sold_out' ? IB_TEXT.hintSoldOut : IB_TEXT.hintBlocked}</p>
            </fieldset>
            {channels.includes('kiosk') ? (
              <fieldset>
                <legend>{IB_TEXT.kioskDisplay}</legend>
                {(
                  [
                    [null, IB_TEXT.kioskDefault],
                    ['hide', IB_TEXT.kioskHide],
                    ['grey', IB_TEXT.kioskGrey],
                  ] as const
                ).map(([k, label]) => (
                  <button key={label} type="button" className={`t-chip${kiosk === k ? ' t-chip-on' : ''}`} onClick={() => setKiosk(k)}>
                    {label}
                  </button>
                ))}
              </fieldset>
            ) : null}
            <fieldset>
              <legend>{IB_TEXT.duration}</legend>
              {DURATIONS.map((d) => (
                <button key={d.k} type="button" className={`t-chip${dur === d.k ? ' t-chip-on' : ''}`} onClick={() => setDur(d.k)}>
                  {d.label}
                </button>
              ))}
              {dur === 'at' ? (
                <label className="t-field">
                  <span>{IB_TEXT.atLabel}</span>
                  <input className="t-input" value={at} maxLength={5} inputMode="numeric" onChange={(e) => setAt(e.target.value.replace(/[^\d:]/g, ''))} />
                  {at && !atOk ? <span className="t-small t-bad">{IB_TEXT.badTime}</span> : null}
                </label>
              ) : null}
            </fieldset>
            <label className="t-field">
              <span>{IB_TEXT.note}</span>
              <input className="t-input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
        ) : null}
        <div className="t-dialog-actions">
          <button type="button" className="t-btn t-btn-ghost" onClick={onDone}>
            {formShown ? IB_TEXT.cancel : IB_TEXT.close}
          </button>
          {formShown ? (
            <button type="button" className={`t-btn ${kind === 'blocked' ? 't-btn-danger' : 't-btn-primary'}`} disabled={!ready} onClick={() => void confirm()}>
              {kind === 'blocked' ? IB_TEXT.confirmBlocked : IB_TEXT.confirmSoldOut}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
