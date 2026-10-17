/**
 * "ניהול קטלוג" (pos-android ui/catalogadmin/CatalogAdminScreen.kt, ProductFilterChips.kt, SalesChannelPicker.kt,
 * ProductPhotoPicker.kt, PriceLevelDialog.kt, MachineCatalogScreen.kt; core/till/catalogAdmin.ts, main/till/tillCatalogAdmin.ts):
 * a compact bar (the title, what it lists, the approval held, "עוד"), the search, ONE chip row (out of scope, state, channel,
 * the categories with their counts) and rows — a picture, the name on two lines, the tags, the price; no buttons on a row. A
 * tap opens the product page (each action says what it changes, each section as its permission allows); "בחירת כמה מוצרים"
 * (or a long press) chooses several. The categories and "קטלוג למסוף" are panels of the same screen. Everything the engine
 * decides is in `view`; the screen holds only the form being typed, the dialogs open, and the products chosen.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CATALOG_ADMIN_TEXT as T,
  PHOTO_JPEG_QUALITY,
  SALES_CHANNELS,
  channelHint,
  channelLabel,
  draftError,
  machineCount,
  squareCrop,
  twoDecimals,
  type AvailabilityChange,
  type AvailabilityScope,
  type CatalogAdminState,
  type CatalogPageView,
  type GateView,
  type MachineCatalogMode,
  type ProductDraft,
  type SalesChannel,
  type StateFilter,
} from '../../../../core/till/catalogAdmin';
import type { PriceLevel } from '../../../../core/till/tillPriceLevel';

/** A picture for the product: the bytes (base64, already squared and made small here), or its removal. */
export type CatalogPhotoArg = { data: string; keepBackground: boolean; enhance: boolean } | { remove: true };

export interface CatalogAdminActions {
  panel(panel: CatalogAdminState['panel']): void;
  filter(f: Partial<{ query: string; categoryId: string | null; channel: SalesChannel | null; state: StateFilter; showOutOfScope: boolean }>): void;
  more(): void;
  page(productId: string | null): void;
  pageClose(): void;
  save(productId: string, draft: ProductDraft, photo: CatalogPhotoArg | null): void;
  add(draft: ProductDraft, photo: CatalogPhotoArg | null): void;
  priceLevel(level: PriceLevel): void;
  priceCancel(): void;
  setAvailable(a: { productIds: string[]; change: AvailabilityChange; scope: AvailabilityScope; permanent?: boolean }): void;
  moveCategory(productIds: string[], categoryId: string): void;
  categoryAdd(name: string): void;
  categoryRename(categoryId: string, name: string): void;
  categoryActive(a: { categoryId: string; scope: AvailabilityScope; active: boolean | null; permanent?: boolean }): void;
  machineAuth(): void;
  machineSave(mode: MachineCatalogMode, productIds: string[]): void;
  release(): void;
  dismiss(): void;
  /** "חסום / אזל — לפי ערוץ, רמה וזמן": the item-block sheet (BlocksScreen) for a product or a category. */
  block?(item: { productId?: string; categoryId?: string }): void;
}

/** The list on the screen at most (the engine sends ≤ its page; this caps a long checklist too). */
const MACHINE_ROWS = 300;

/* ---------------------------------------------------------------------------------------------------- the picture */

/**
 * A picked file as the till sends it (ProductPhoto: the largest centred square, at most 800 px, JPEG 85 — a PNG when it has
 * transparency of its own, so a cut-out never turns black). Browser APIs only, when a file is picked.
 */
export async function preparePhoto(file: Blob): Promise<{ data: string; preview: string }> {
  const bitmap = await createImageBitmap(file);
  const crop = squareCrop(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = crop.out;
  canvas.height = crop.out;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no canvas');
  g.drawImage(bitmap, crop.left, crop.top, crop.side, crop.side, 0, 0, crop.out, crop.out);
  bitmap.close?.();
  const pixels = g.getImageData(0, 0, crop.out, crop.out).data;
  let alpha = false;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 255) {
      alpha = true;
      break;
    }
  }
  const url = alpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY);
  return { data: url.slice(url.indexOf(',') + 1), preview: url };
}

/* ------------------------------------------------------------------------------------------------------- pieces */

function GateNote({ gate }: { gate: GateView }) {
  if (gate.approval) return <span className="t-cadm-approval">{T.needsApproval}</span>;
  return null;
}

function Section({ title, gate, children }: { title: string; gate: GateView; children: React.ReactNode }) {
  return (
    <section className="t-cadm-section">
      <div className="t-cadm-section-head">
        <h3>{title}</h3>
        <GateNote gate={gate} />
      </div>
      {children}
      {gate.reason ? <p className="t-bad t-small">{gate.reason}</p> : null}
    </section>
  );
}

function Toggle({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  return (
    <label className="t-cadm-toggle">
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** "פעיל / לא פעיל" at a level (ScopeDialog): the action, "חסימה קבועה", where — each level saying what it reaches. */
function ScopeDialog({
  title,
  activeHere,
  view,
  isProduct,
  onApply,
  onClose,
}: {
  title: string;
  activeHere: boolean;
  view: CatalogAdminState;
  isProduct: boolean;
  onApply(scope: AvailabilityScope, active: boolean | null, permanent: boolean | undefined): void;
  onClose(): void;
}) {
  const start = view.availabilityScope === 'area' && !view.hasArea ? 'machine' : view.availabilityScope;
  const [scope, setScope] = useState<AvailabilityScope>(start);
  const [action, setAction] = useState<'off' | 'on' | 'inherit'>(activeHere ? 'off' : 'on');
  const [permanent, setPermanent] = useState(false);
  const actions: Array<['off' | 'on' | 'inherit', string]> = [
    ['off', T.makeInactive],
    ['on', T.makeActive],
    ['inherit', T.makeInherit],
  ];
  return (
    <div className="t-overlay" role="dialog" aria-modal="true">
      <div className="t-dialog t-cadm-dialog">
        <h2 className="t-dialog-title">{title}</h2>
        <p className="t-cadm-label">{T.scopeAction}</p>
        {actions.map(([key, label]) => (
          <label key={key} className="t-cadm-radio">
            <input type="radio" name="cadm-action" checked={action === key} onChange={() => setAction(key)} />
            <span>{label}</span>
          </label>
        ))}
        {action === 'off' ? (
          <label className="t-cadm-radio">
            <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} />
            <span>
              {T.permanent}
              <br />
              <span className="t-muted t-small">{T.permanentHint}</span>
            </span>
          </label>
        ) : null}
        <p className="t-cadm-label">{T.scopeWhere}</p>
        {view.scopeOptions.map((o) => (
          <label key={o.key} className={`t-cadm-radio${o.enabled ? '' : ' t-cadm-off'}`}>
            <input type="radio" name="cadm-scope" disabled={!o.enabled} checked={scope === o.key} onChange={() => setScope(o.key)} />
            <span>
              {o.label}
              {o.enabled ? '' : ` ${T.scopeNoArea}`}
              {o.enabled ? (
                <>
                  <br />
                  <span className="t-muted t-small">{o.affects}</span>
                </>
              ) : null}
            </span>
          </label>
        ))}
        {isProduct ? <p className="t-muted t-small">{T.affectsOfflineOk}</p> : null}
        <div className="t-cadm-actions">
          <button type="button" className="t-btn t-btn-primary" disabled={view.busy} onClick={() => onApply(scope, action === 'off' ? false : action === 'on' ? true : null, action === 'off' ? permanent : undefined)}>
            {T.save}
          </button>
          <button type="button" className="t-btn t-btn-ghost" disabled={view.busy} onClick={onClose}>
            {T.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

function PickCategory({ title, categories, onPick, onClose }: { title: string; categories: CatalogAdminState['categories']; onPick(id: string): void; onClose(): void }) {
  return (
    <div className="t-overlay" role="dialog" aria-modal="true">
      <div className="t-dialog t-cadm-dialog">
        <h2 className="t-dialog-title">{title}</h2>
        <div className="t-cadm-picklist">
          {categories.map((c) => (
            <button key={c.id} type="button" className="t-btn t-btn-ghost t-cadm-pick" onClick={() => onPick(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
        <div className="t-cadm-actions">
          <button type="button" className="t-btn t-btn-ghost" onClick={onClose}>
            {T.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

function NameDialog({ title, initial, busy, onSave, onClose }: { title: string; initial: string; busy: boolean; onSave(name: string): void; onClose(): void }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="t-overlay" role="dialog" aria-modal="true">
      <div className="t-dialog t-cadm-dialog">
        <h2 className="t-dialog-title">{title}</h2>
        <label className="t-field">
          <span>{T.fieldName}</span>
          <input className="t-input" value={name} maxLength={120} onChange={(e) => (setName(e.target.value), setError(null))} />
        </label>
        {error ? <p className="t-bad t-small">{error}</p> : null}
        <div className="t-cadm-actions">
          <button type="button" className="t-btn t-btn-primary" disabled={busy} onClick={() => (name.trim() ? onSave(name.trim()) : setError(T.nameRequired))}>
            {busy ? T.saving : T.save}
          </button>
          <button type="button" className="t-btn t-btn-ghost" disabled={busy} onClick={onClose}>
            {T.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------- the product page */

function ProductPage({ page, view, actions, onAvailability, onSay }: { page: CatalogPageView; view: CatalogAdminState; actions: CatalogAdminActions; onAvailability(): void; onSay(t: string): void }) {
  const [draft, setDraft] = useState<ProductDraft>(page.draft);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ arg: CatalogPhotoArg; preview: string | null } | null>(null);
  const [working, setWorking] = useState(false);
  const [confirmTicket, setConfirmTicket] = useState<boolean | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setDraft(page.draft);
    setPhoto(null);
    setError(null);
    // A new opening (its key) starts the form again; the same page's refreshed state never wipes the typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.key]);
  const g = page.gates;
  const isNew = page.mode === 'new';
  const canPrice = g.price.usable && !view.busy;
  const canEdit = g.edit.usable && !view.busy;
  const anyEditable = g.price.usable || g.edit.usable;
  const set = (patch: Partial<ProductDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setWorking(true);
    try {
      const p = await preparePhoto(file);
      setPhoto({ arg: { data: p.data, keepBackground: false, enhance: true }, preview: p.preview });
    } catch {
      onSay(T.photoUnreadable);
    } finally {
      setWorking(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const save = () => {
    const err = draftError(draft);
    if (err) return setError(err);
    const out = { ...draft, name: draft.name.trim() };
    if (isNew) actions.add(out, photo?.arg ?? null);
    else actions.save(page.productId!, out, photo?.arg ?? null);
  };
  const shownImage = photo ? photo.preview : page.imageUrl;
  return (
    <div className="t-overlay t-cadm-sheet-wrap" role="dialog" aria-modal="true">
      <div className="t-cadm-sheet">
        <div className="t-cadm-sheet-head">
          <h2 className="t-dialog-title">{page.title}</h2>
          <button type="button" className="t-btn t-btn-ghost" onClick={actions.pageClose}>
            {T.close}
          </button>
        </div>
        <div className="t-cadm-sheet-body">
          {page.outOfScope ? <p className="t-warn t-small">{T.tagOutOfScopeLong}</p> : null}

          {!isNew && (g.availability.offered || g.block) ? (
            <Section title={T.sectionAvailability} gate={g.availability}>
              {g.availability.offered ? (
                <div className="t-cadm-row-actions">
                  <button type="button" className="t-btn" disabled={view.busy} onClick={() => (g.availability.reason ? onSay(g.availability.reason) : onAvailability())}>
                    {page.isAvailable ? T.makeInactive : T.makeActive}
                  </button>
                  <button
                    type="button"
                    className="t-btn"
                    disabled={view.busy}
                    onClick={() => (g.availability.reason ? onSay(g.availability.reason) : actions.setAvailable({ productIds: [page.productId!], change: 'sold_out_today', scope: view.availabilityScope }))}
                  >
                    {T.soldOutToday}
                  </button>
                </div>
              ) : null}
              {g.availability.offered ? <p className="t-muted t-small">{page.availabilityAffects}</p> : null}
              {g.block && actions.block ? (
                <>
                  <button type="button" className="t-btn t-btn-ghost" disabled={view.busy} onClick={() => actions.block!({ productId: page.productId! })}>
                    {T.blockMore}
                  </button>
                  <p className="t-muted t-small">{T.affectsBlock}</p>
                </>
              ) : null}
            </Section>
          ) : null}

          {g.price.offered ? (
            <Section title={T.sectionPrice} gate={g.price}>
              <label className="t-field">
                <span>{T.fieldPrice}</span>
                <input
                  className="t-input"
                  inputMode="decimal"
                  dir="ltr"
                  value={draft.price}
                  disabled={!canPrice}
                  onChange={(e) => set({ price: e.target.value })}
                  onBlur={() => {
                    const v = twoDecimals(draft.price);
                    if (v) set({ price: v });
                  }}
                />
              </label>
              <p className="t-muted t-small">{`${T.affectsPrice} · ${T.affectsNeedsNetwork}`}</p>
            </Section>
          ) : null}

          {g.edit.offered ? (
            <Section title={T.sectionDetails} gate={g.edit}>
              {!isNew ? <p className="t-muted t-small">{T.affectsMaster}</p> : null}
              <label className="t-field">
                <span>{T.fieldName}</span>
                <input className="t-input" value={draft.name} disabled={!canEdit} maxLength={200} onChange={(e) => set({ name: e.target.value })} />
              </label>
              {view.categories.length === 0 ? (
                <p className="t-bad t-small">{T.noCategories}</p>
              ) : (
                <label className="t-field">
                  <span>{T.fieldCategory}</span>
                  <select className="t-input" value={draft.categoryId} disabled={!canEdit} onChange={(e) => set({ categoryId: e.target.value })}>
                    {draft.categoryId === '' ? <option value="">{T.pickCategory}</option> : null}
                    {view.categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="t-field">
                <span>{T.fieldSku}</span>
                <input className="t-input" dir="ltr" value={draft.sku} placeholder={T.skuAuto} disabled={!isNew || !canEdit} onChange={(e) => set({ sku: e.target.value })} />
              </label>
              <label className="t-field">
                <span>{T.fieldBarcode}</span>
                <input className="t-input" dir="ltr" value={draft.barcode} disabled={!canEdit} onChange={(e) => set({ barcode: e.target.value })} />
              </label>
              <label className="t-field">
                <span>{T.fieldDescription}</span>
                <textarea className="t-input t-cadm-textarea" value={draft.description} disabled={!canEdit} onChange={(e) => set({ description: e.target.value })} />
              </label>
              <label className="t-field">
                <span>{T.fieldStock}</span>
                <input className="t-input" inputMode="numeric" dir="ltr" value={draft.stockQuantity} disabled={!canEdit} onChange={(e) => set({ stockQuantity: e.target.value.replace(/\D+/g, '') })} />
              </label>
              <Toggle label={T.fieldOpenPrice} on={draft.isOpenPrice} disabled={!canEdit} onChange={(v) => set({ isOpenPrice: v })} />
              <Toggle label={T.fieldWeighed} on={draft.isWeighed} disabled={!canEdit} onChange={(v) => set({ isWeighed: v })} />
              {draft.isWeighed ? (
                <label className="t-field">
                  <span>{T.fieldUnit}</span>
                  <input className="t-input" value={draft.unitLabel} maxLength={16} disabled={!canEdit} onChange={(e) => set({ unitLabel: e.target.value.slice(0, 16) })} />
                </label>
              ) : null}
              <Toggle label={T.fieldPrintTicket} on={draft.printTicket} disabled={!canEdit} onChange={(v) => (isNew ? set({ printTicket: v }) : setConfirmTicket(v))} />
              {!isNew && draft.printTicket !== page.cloudPrintTicket ? <p className="t-warn t-small">{T.ticketOverrides(page.cloudTicket)}</p> : null}
              <div className="t-field">
                <span>{T.fieldChannel}</span>
                <div className="t-chips t-cadm-segments">
                  {SALES_CHANNELS.map((c) => (
                    <button key={c} type="button" disabled={!canEdit} className={`t-chip${draft.salesChannel === c ? ' t-chip-on' : ''}`} onClick={() => set({ salesChannel: c })}>
                      {channelLabel(c)}
                    </button>
                  ))}
                </div>
                {channelHint(draft.salesChannel) ? <p className="t-warn t-small">{channelHint(draft.salesChannel)}</p> : null}
              </div>
              {page.photoEnabled && canEdit ? (
                <div className="t-field t-cadm-photo">
                  <span>{T.photoTitle}</span>
                  <div className="t-cadm-photo-row">
                    <div className="t-cadm-thumb t-cadm-thumb-big">{shownImage && !(photo && 'remove' in photo.arg) ? <img src={shownImage} alt="" /> : <span>{T.photoNone}</span>}</div>
                    <div className="t-cadm-photo-actions">
                      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="t-cadm-file" onChange={(e) => void pick(e.target.files?.[0])} />
                      <button type="button" className="t-btn" disabled={working} onClick={() => fileRef.current?.click()}>
                        {working ? T.photoWorking : T.photoUpload}
                      </button>
                      {!isNew && page.imageUrl && !photo ? (
                        <button type="button" className="t-btn t-btn-danger" onClick={() => setPhoto({ arg: { remove: true }, preview: null })}>
                          {T.photoRemove}
                        </button>
                      ) : null}
                      {photo ? (
                        <button type="button" className="t-btn t-btn-ghost" onClick={() => setPhoto(null)}>
                          {T.photoUndo}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {photo && 'data' in photo.arg ? (
                    <>
                      <p className="t-muted t-small">{T.photoNew}</p>
                      <Toggle label={T.photoRemoveBackground} on={!photo.arg.keepBackground} onChange={(v) => setPhoto({ ...photo, arg: { ...(photo.arg as { data: string; keepBackground: boolean; enhance: boolean }), keepBackground: !v } })} />
                      <Toggle label={T.photoEnhance} on={photo.arg.enhance} onChange={(v) => setPhoto({ ...photo, arg: { ...(photo.arg as { data: string; keepBackground: boolean; enhance: boolean }), enhance: v } })} />
                    </>
                  ) : photo ? (
                    <p className="t-muted t-small">{T.photoRemoving}</p>
                  ) : null}
                </div>
              ) : null}
            </Section>
          ) : null}
          {error ? <p className="t-bad">{error}</p> : null}
        </div>
        {anyEditable ? (
          <div className="t-cadm-sheet-foot">
            <button type="button" className="t-btn t-btn-primary" disabled={view.busy || working} onClick={save}>
              {view.busy ? T.saving : T.save}
            </button>
          </div>
        ) : null}
      </div>
      {confirmTicket !== null ? (
        <div className="t-overlay" role="dialog" aria-modal="true">
          <div className="t-dialog">
            <h2 className="t-dialog-title">{T.ticketConfirmTitle}</h2>
            <p className="t-dialog-body">{confirmTicket ? T.ticketConfirmOn(page.cloudTicket) : T.ticketConfirmOff(page.cloudTicket)}</p>
            <div className="t-cadm-actions">
              <button type="button" className="t-btn t-btn-primary" onClick={() => (set({ printTicket: confirmTicket }), setConfirmTicket(null))}>
                {T.ticketConfirmGo}
              </button>
              <button type="button" className="t-btn t-btn-ghost" onClick={() => setConfirmTicket(null)}>
                {T.cancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** "איפה לשנות?" (PriceLevelDialog): the cloud's default picked; a refused level greyed with its reason. */
function PriceLevelDialog({ ask, actions }: { ask: NonNullable<CatalogAdminState['priceAsk']>; actions: CatalogAdminActions }) {
  const [picked, setPicked] = useState<PriceLevel | null>(ask.preselected);
  return (
    <div className="t-overlay" role="dialog" aria-modal="true">
      <div className="t-dialog t-cadm-dialog">
        <h2 className="t-dialog-title">{ask.title}</h2>
        {ask.choices.map((c) => (
          <label key={c.level} className={`t-cadm-radio${c.enabled ? '' : ' t-cadm-off'}`}>
            <input type="radio" name="cadm-price-level" disabled={!c.enabled} checked={picked === c.level} onChange={() => setPicked(c.level)} />
            <span>
              {c.label}
              {c.refusal ? (
                <>
                  <br />
                  <span className="t-bad t-small">{c.refusal}</span>
                </>
              ) : null}
            </span>
          </label>
        ))}
        <div className="t-cadm-actions">
          <button type="button" className="t-btn t-btn-primary" disabled={picked === null} onClick={() => picked && actions.priceLevel(picked)}>
            {T.save}
          </button>
          <button type="button" className="t-btn t-btn-ghost" onClick={actions.priceCancel}>
            {T.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------- "קטלוג למסוף" */

function MachinePanel({ view, actions }: { view: CatalogAdminState; actions: CatalogAdminActions }) {
  const m = view.machine;
  // What is stored, by its content (a new state with the same list keeps the draft).
  const savedKey = m ? `${m.mode}|${m.selected.join(',')}` : '';
  const saved = useMemo(() => ({ mode: m?.mode ?? 'all', selected: m?.selected ?? [] }), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<{ mode: MachineCatalogMode; selected: Set<string> } | null>(null);
  const [query, setQuery] = useState('');
  const [cap, setCap] = useState(MACHINE_ROWS);
  useEffect(() => setDraft(null), [savedKey]);
  if (!m) return null;
  if (!m.authorized) {
    return (
      <div className="t-cadm-center">
        <p>{T.machineManagerOnly}</p>
        <button type="button" className="t-btn t-btn-primary" onClick={actions.machineAuth}>
          {T.machineAskManager}
        </button>
      </div>
    );
  }
  const mode = draft?.mode ?? m.mode;
  const selected = draft?.selected ?? new Set(saved.selected);
  const dirty = draft !== null && (draft.mode !== m.mode || draft.selected.size !== saved.selected.length || saved.selected.some((id) => !draft.selected.has(id)));
  const edit = (next: { mode?: MachineCatalogMode; selected?: Set<string> }) => setDraft({ mode: next.mode ?? mode, selected: next.selected ?? selected });
  const all = m.groups.flatMap((g) => g.products.map((p) => ({ id: p.id, isGeneral: false })));
  const count = machineCount(selected, all);
  const q = query.trim().toLowerCase();
  let left = cap;
  return (
    <div className="t-cadm-machine">
      <div className="t-cadm-modes">
        {(
          [
            ['all', T.machineModeAll, T.machineModeAllHint],
            ['selected', T.machineModeSelected, T.machineModeSelectedHint],
          ] as const
        ).map(([key, title, hint]) => (
          <label key={key} className={`t-cadm-mode${mode === key ? ' t-cadm-mode-on' : ''}`}>
            <input type="radio" name="cadm-machine-mode" checked={mode === key} disabled={view.busy} onChange={() => edit({ mode: key })} />
            <span>
              <strong>{title}</strong>
              <br />
              <span className="t-muted t-small">{hint}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'selected' ? (
        <>
          <p className="t-strong">{T.machineCount(count.selected, count.total)}</p>
          <p className="t-muted t-small">{T.machineGeneralNote}</p>
          {count.selected === 0 ? <p className="t-bad t-small">{T.machineEmptyWarning}</p> : null}
          <input className="t-input" placeholder={T.machineSearch} value={query} onChange={(e) => (setQuery(e.target.value), setCap(MACHINE_ROWS))} />
          {m.groups.map((g) => {
            const rows = g.products.filter((p) => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q));
            if (rows.length === 0 || left <= 0) return null;
            const ids = rows.map((p) => p.id);
            const on = ids.filter((id) => selected.has(id)).length;
            const shown = rows.slice(0, left);
            left -= shown.length;
            return (
              <div key={g.categoryId} className="t-cadm-group">
                <div className="t-cadm-group-head">
                  <strong>{`${g.name}  ${on}/${ids.length}`}</strong>
                  <button type="button" className="t-btn t-btn-small t-btn-ghost" disabled={view.busy || on === ids.length} onClick={() => edit({ selected: new Set([...selected, ...ids]) })}>
                    {T.machineSelectAll}
                  </button>
                  <button type="button" className="t-btn t-btn-small t-btn-ghost" disabled={view.busy || on === 0} onClick={() => edit({ selected: new Set([...selected].filter((id) => !ids.includes(id))) })}>
                    {T.machineClear}
                  </button>
                </div>
                {shown.map((p) => (
                  <label key={p.id} className="t-cadm-check">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      disabled={view.busy}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(p.id);
                        else next.delete(p.id);
                        edit({ selected: next });
                      }}
                    />
                    <span className="t-cadm-check-name">
                      {p.name}
                      <br />
                      <span className="t-muted t-small">{p.code}</span>
                    </span>
                    {p.locked ? <span className="t-bad t-small">{T.machineLocked}</span> : null}
                  </label>
                ))}
              </div>
            );
          })}
          {left <= 0 ? (
            <button type="button" className="t-btn t-btn-ghost" onClick={() => setCap(cap + MACHINE_ROWS)}>
              {T.more}
            </button>
          ) : null}
        </>
      ) : null}
      <div className="t-cadm-bar">
        <span className="t-warn t-small">{dirty ? T.machineUnsaved : ''}</span>
        <button type="button" className="t-btn t-btn-ghost" disabled={!dirty || view.busy} onClick={() => setDraft(null)}>
          {T.machineDiscard}
        </button>
        <button type="button" className="t-btn t-btn-primary" disabled={!dirty || view.busy} onClick={() => actions.machineSave(mode, [...selected])}>
          {T.machineSave}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- categories */

function CategoriesPanel({ view, actions, onSay }: { view: CatalogAdminState; actions: CatalogAdminActions; onSay(t: string): void }) {
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ id: string; name: string; inactive: boolean } | null>(null);
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null);
  const [scoping, setScoping] = useState<{ id: string; name: string; inactive: boolean } | null>(null);
  const g = view.gates;
  const shown = view.categories.filter((c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    if (!view.busy && view.note?.tone === 'ok') setNaming(null);
  }, [view.busy, view.note]);
  return (
    <div className="t-cadm-panel">
      <input className="t-input" placeholder={T.search} value={query} onChange={(e) => setQuery(e.target.value)} />
      {g.create.offered ? (
        <button type="button" className="t-btn t-btn-ghost t-cadm-add-cat" onClick={() => (g.create.reason ? onSay(g.create.reason) : setNaming({ id: null, name: '' }))}>
          {`+ ${T.addCategory}`}
        </button>
      ) : null}
      <ul className="t-list t-cadm-cats">
        {shown.map((c) => (
          <li key={c.id}>
            <button type="button" className="t-list-row t-cadm-cat" onClick={() => setMenu(c)}>
              <span>{c.name}</span>
              {c.inactive ? <span className="t-bad t-small">{T.inactiveTag}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {menu ? (
        <div className="t-overlay" role="dialog" aria-modal="true">
          <div className="t-dialog t-cadm-dialog">
            <h2 className="t-dialog-title">{menu.name}</h2>
            {[g.edit.reason, g.availability.reason].filter((x, i, a) => x && a.indexOf(x) === i).map((r) => (
              <p key={r} className="t-bad t-small">
                {r}
              </p>
            ))}
            <div className="t-cadm-sheet-list">
              {g.edit.offered ? (
                <button type="button" className="t-btn" disabled={!g.edit.usable} onClick={() => (setNaming({ id: menu.id, name: menu.name }), setMenu(null))}>
                  {T.editCategory}
                </button>
              ) : null}
              {g.availability.offered ? (
                <button type="button" className="t-btn" disabled={!g.availability.usable} onClick={() => (setScoping(menu), setMenu(null))}>
                  {T.activeButton}
                </button>
              ) : null}
              {actions.block ? (
                <button type="button" className="t-btn" onClick={() => (actions.block!({ categoryId: menu.id }), setMenu(null))}>
                  {T.blockAction}
                </button>
              ) : null}
              <button type="button" className="t-btn t-btn-ghost" onClick={() => setMenu(null)}>
                {T.cancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {naming ? (
        <NameDialog
          title={naming.id ? T.editCategory : T.addCategory}
          initial={naming.name}
          busy={view.busy}
          onClose={() => setNaming(null)}
          onSave={(name) => (naming.id ? actions.categoryRename(naming.id, name) : actions.categoryAdd(name))}
        />
      ) : null}
      {scoping ? (
        <ScopeDialog
          title={scoping.name}
          activeHere={!scoping.inactive}
          view={view}
          isProduct={false}
          onClose={() => setScoping(null)}
          onApply={(scope, active, permanent) => {
            setScoping(null);
            actions.categoryActive({ categoryId: scoping.id, scope, active, permanent });
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------- the screen */

export function CatalogAdminScreen({ view, actions, back }: { view: CatalogAdminState | undefined; actions: CatalogAdminActions; back(): void }) {
  const [query, setQuery] = useState(view?.filter.query ?? '');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [scoping, setScoping] = useState<{ ids: string[]; name: string; activeHere: boolean } | null>(null);
  const [moving, setMoving] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  // A write that went through ends the choosing.
  const busy = view?.busy === true;
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && view?.note && view.note.tone !== 'error') {
      setSelecting(false);
      setSelected(new Set());
    }
    wasBusy.current = busy;
  }, [busy, view?.note]);
  if (!view || !view.open) return null;
  const g = view.gates;
  const typed = (v: string) => {
    setQuery(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => actions.filter({ query: v }), 250);
  };
  const say = (t: string) => setLocal(t);
  const goBack = () => {
    if (selecting) {
      setSelecting(false);
      setSelected(new Set());
    } else if (view.panel !== 'products') actions.panel('products');
    else back();
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const chosen = view.rows.filter((r) => selected.has(r.id)).map((r) => r.id);
  const barButton = (gate: GateView, label: string, run: () => void) =>
    gate.offered ? (
      <button key={label} type="button" className={`t-btn t-btn-small${gate.usable ? '' : ' t-cadm-greyed'}`} disabled={chosen.length === 0 || busy} onClick={() => (gate.reason ? say(gate.reason) : run())}>
        {label + (gate.approval ? ` · ${T.needsApproval}` : '')}
      </button>
    ) : null;
  const note = local ? { text: local, tone: 'info' as const } : view.note;
  return (
    <div className="t-report t-cadm">
      <div className="t-cadm-top">
        <button type="button" className="t-btn t-btn-ghost" onClick={goBack}>
          {T.back}
        </button>
        <div className="t-cadm-titles">
          <h1 className="t-report-title t-cadm-title">{selecting ? T.selectedCount(selected.size) : view.title}</h1>
          <span className="t-muted t-small t-cadm-scope">{view.scopeLine}</span>
        </div>
        {view.approvedBy ? (
          <button type="button" className="t-btn t-btn-ghost t-btn-small" onClick={actions.release}>
            {T.approvedBy(view.approvedBy)}
          </button>
        ) : null}
        <div className="t-cadm-more">
          <button type="button" className="t-btn t-btn-ghost" aria-haspopup="menu" onClick={() => setMenuOpen(!menuOpen)}>
            {T.more}
          </button>
          {menuOpen ? (
            <div className="t-cadm-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => (setMenuOpen(false), actions.panel('products'))}>
                {T.products}
              </button>
              {view.canSelect ? (
                <button type="button" role="menuitem" onClick={() => (setMenuOpen(false), actions.panel('products'), setSelecting(true))}>
                  {T.selectMany}
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={() => (setMenuOpen(false), actions.panel('categories'))}>
                {T.categories}
              </button>
              <button type="button" role="menuitem" onClick={() => (setMenuOpen(false), actions.panel('till'))}>
                {T.machineTab}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {note ? (
        <p className={`t-cadm-note ${note.tone === 'error' ? 't-bad' : note.tone === 'ok' ? 't-ok' : 't-warn'}`} role="status" onClick={() => (local ? setLocal(null) : actions.dismiss())}>
          {note.text}
        </p>
      ) : null}

      {view.panel === 'till' ? <MachinePanel view={view} actions={actions} /> : null}
      {view.panel === 'categories' ? <CategoriesPanel view={view} actions={actions} onSay={say} /> : null}

      {view.panel === 'products' ? (
        <>
          <div className="t-cadm-search">
            <input className="t-input" type="search" placeholder={T.search} value={query} onChange={(e) => typed(e.target.value)} />
            {query ? (
              <button type="button" className="t-btn t-btn-ghost" onClick={() => typed('')}>
                {T.clear}
              </button>
            ) : null}
          </div>
          <div className="t-cadm-chiprow">
            {view.offerOutOfScope ? (
              <button type="button" className={`t-chip${view.filter.showOutOfScope ? ' t-chip-on' : ''}`} onClick={() => actions.filter({ showOutOfScope: !view.filter.showOutOfScope })}>
                {T.showOutOfScope}
              </button>
            ) : null}
            <select className={`t-input t-cadm-select${view.filter.state !== 'any' ? ' t-cadm-select-on' : ''}`} value={view.filter.state} onChange={(e) => actions.filter({ state: e.target.value as StateFilter })}>
              {view.stateChips.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              className={`t-input t-cadm-select${view.filter.channel ? ' t-cadm-select-on' : ''}`}
              value={view.filter.channel ?? ''}
              onChange={(e) => actions.filter({ channel: e.target.value ? (e.target.value as SalesChannel) : null })}
            >
              {view.channelChips.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            {view.categoryChips.map((c) => (
              <button key={`c:${c.key}`} type="button" className={`t-chip${c.on ? ' t-chip-on' : ''}`} onClick={() => actions.filter({ categoryId: c.key || null })}>
                {c.label}
              </button>
            ))}
          </div>
          {view.rows.length === 0 ? <p className="t-muted t-cadm-empty">{T.empty}</p> : null}
          <ul className="t-cadm-rows">
            {view.rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`t-cadm-row${r.inScope ? '' : ' t-cadm-row-out'}${selected.has(r.id) ? ' t-cadm-row-on' : ''}`}
                  onClick={() => (selecting ? toggle(r.id) : actions.page(r.id))}
                  onContextMenu={(e) => {
                    // A long press (or the right button): start choosing several.
                    e.preventDefault();
                    if (!view.canSelect) return;
                    setSelecting(true);
                    setSelected(new Set([...selected, r.id]));
                  }}
                >
                  {selecting ? <input type="checkbox" readOnly tabIndex={-1} checked={selected.has(r.id)} className="t-cadm-rowcheck" /> : null}
                  <span className="t-cadm-thumb">{r.imageUrl ? <img src={r.imageUrl} alt="" loading="lazy" /> : <span>{r.name.slice(0, 1)}</span>}</span>
                  <span className="t-cadm-main">
                    <span className="t-cadm-name">{r.name}</span>
                    {r.tags.length > 0 || r.channel ? (
                      <span className="t-cadm-tags">
                        {r.tags.map((t) => (
                          <span key={t.tag} className={`t-cadm-tag t-cadm-tag-${t.tag}`}>
                            {t.label}
                          </span>
                        ))}
                        {r.channel ? <span className="t-cadm-tag t-cadm-tag-channel">{r.channel}</span> : null}
                      </span>
                    ) : null}
                  </span>
                  <span className="t-cadm-price" dir="ltr">
                    {r.price}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {view.rows.length < view.total ? (
            <button type="button" className="t-btn t-btn-ghost" onClick={actions.more}>
              {`${T.more} (${view.total - view.rows.length})`}
            </button>
          ) : null}
          {selecting ? (
            <div className="t-cadm-selbar">
              <div className="t-cadm-selbar-head">
                <strong>{T.selectedCount(chosen.length)}</strong>
                <button type="button" className="t-btn t-btn-ghost t-btn-small" onClick={() => setSelected(chosen.length < view.rows.length ? new Set(view.rows.map((r) => r.id)) : new Set())}>
                  {chosen.length < view.rows.length ? T.selectAll : T.selectNone}
                </button>
              </div>
              <div className="t-cadm-selbar-actions">
                {barButton(g.availability, T.makeActive, () => setScoping({ ids: chosen, name: '', activeHere: false }))}
                {barButton(g.availability, T.makeInactive, () => setScoping({ ids: chosen, name: '', activeHere: true }))}
                {barButton(g.availability, T.soldOutToday, () => actions.setAvailable({ productIds: chosen, change: 'sold_out_today', scope: view.availabilityScope }))}
                {barButton(g.edit, T.moveCategory, () => setMoving(true))}
              </div>
            </div>
          ) : g.create.offered ? (
            <button type="button" className={`t-cadm-fab${g.create.usable ? '' : ' t-cadm-greyed'}`} aria-label={T.addProduct} onClick={() => (g.create.reason ? say(g.create.reason) : actions.page(null))}>
              +
            </button>
          ) : null}
        </>
      ) : null}

      {view.page ? (
        <ProductPage
          page={view.page}
          view={view}
          actions={actions}
          onSay={say}
          onAvailability={() => setScoping({ ids: [view.page!.productId!], name: view.page!.title, activeHere: view.page!.isAvailable })}
        />
      ) : null}
      {scoping ? (
        <ScopeDialog
          title={scoping.name || T.selectedCount(scoping.ids.length)}
          activeHere={scoping.activeHere}
          view={view}
          isProduct
          onClose={() => setScoping(null)}
          onApply={(scope, active, permanent) => {
            setScoping(null);
            actions.setAvailable({ productIds: scoping.ids, change: active === true ? 'on' : active === false ? 'off' : 'inherit', scope, ...(permanent === undefined ? {} : { permanent }) });
          }}
        />
      ) : null}
      {moving ? (
        <PickCategory
          title={T.moveCategory}
          categories={view.categories}
          onClose={() => setMoving(false)}
          onPick={(id) => {
            setMoving(false);
            actions.moveCategory(chosen, id);
          }}
        />
      ) : null}
      {view.priceAsk ? <PriceLevelDialog ask={view.priceAsk} actions={actions} /> : null}
    </div>
  );
}
