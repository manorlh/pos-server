/**
 * "היסטוריה" (Android nav_history): today's documents of this till, newest first, each with "הדפס העתק" — a copy needs
 * the REPRINT right (the engine asks a manager's code when the user has it only by approval). A document opens its detail
 * (DetailViewModel): its lines with what is left to credit, and "זיכוי" — the quantities picked (everything left, to start
 * with), the sum the engine computes, and "בצע זיכוי": a credit note (330) linked to the original — by cash, or to the
 * original's card at the terminal. The engine asks REFUND (a manager whose own limit covers the sum) and refuses what the
 * Android till refuses.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DocumentDetail } from '../../../../shared/till/protocol';
import { money, T } from '../text';

export interface HistoryRow {
  id: string;
  ref: string;
  totalAgorot: number;
  at: string;
  cashier: string;
  methods: Array<'cash' | 'card'>;
  documentType?: number;
  status?: string;
}

export interface HistoryActions {
  load(): Promise<HistoryRow[] | undefined>;
  reprint(id: string): void;
  back(): void;
  /** The document's detail; with [quantities], what crediting them gives back. */
  detail?(id: string, quantities?: Record<string, number>): Promise<DocumentDetail | undefined>;
  /** "בצע זיכוי". */
  refund?(id: string, quantities: Record<string, number>): Promise<boolean>;
  /** "כשאין הרשאה" = להסתיר: the refund's entries left out. */
  refundHidden?: boolean;
}

export function HistoryScreen({ load, reprint, back, detail, refund, refundHidden }: HistoryActions) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const reload = useCallback(() => {
    let alive = true;
    void load().then((r) => alive && setRows(r ?? []));
    return () => {
      alive = false;
    };
  }, [load]);
  useEffect(() => reload(), [reload]);
  if (open && detail) {
    return (
      <DocumentScreen
        id={open}
        detail={detail}
        refund={refund}
        refundHidden={refundHidden === true}
        reprint={reprint}
        back={() => {
          setOpen(null);
          reload();
        }}
      />
    );
  }
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">{T.history}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={back}>
          {T.back}
        </button>
      </div>
      {rows === null ? <p className="t-muted">…</p> : rows.length === 0 ? <p className="t-muted">{T.historyEmpty}</p> : null}
      <ul className="t-history">
        {(rows ?? []).map((r) => (
          <li key={r.id} className="t-history-row">
            <span className="t-history-ref">
              #{r.ref}
              {r.documentType === 330 || r.documentType === -400 ? ` · ${T.creditNote}` : ''}
            </span>
            <span className="t-muted t-small">
              {new Date(r.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} · {r.cashier} · {r.methods.map((m) => (m === 'cash' ? T.cash : T.card)).join(' + ')}
            </span>
            <strong>{money(r.totalAgorot)}</strong>
            {detail ? (
              <button type="button" className="t-btn t-btn-small t-btn-ghost" onClick={() => setOpen(r.id)}>
                {T.details}
              </button>
            ) : null}
            <button type="button" className="t-btn t-btn-small" onClick={() => reprint(r.id)}>
              {T.printCopy}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocumentScreen({
  id,
  detail,
  refund,
  refundHidden,
  reprint,
  back,
}: {
  id: string;
  detail(id: string, quantities?: Record<string, number>): Promise<DocumentDetail | undefined>;
  refund?(id: string, quantities: Record<string, number>): Promise<boolean>;
  refundHidden: boolean;
  reprint(id: string): void;
  back(): void;
}) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [mode, setMode] = useState(false);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [sum, setSum] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void detail(id).then((d) => {
      if (!alive || !d) return;
      setDoc(d);
      // Default to crediting everything still outstanding — the common case is a full return.
      setQty(Object.fromEntries(d.lines.map((l) => [l.itemId, l.remainingQty])));
    });
    return () => {
      alive = false;
    };
  }, [detail, id]);
  useEffect(() => {
    if (!mode) return;
    let alive = true;
    void detail(id, qty).then((d) => alive && setSum(d?.selectedAgorot ?? null));
    return () => {
      alive = false;
    };
  }, [detail, id, qty, mode]);
  if (!doc) return <div className="t-report">…</div>;
  const anything = Object.values(qty).some((n) => n > 0);
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">{mode ? T.refundTitle(doc.ref) : `#${doc.ref}${doc.isRefundDocument ? ` · ${T.creditNote}` : ''}`}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={mode ? () => setMode(false) : back}>
          {T.back}
        </button>
      </div>
      <p className="t-muted t-small">
        {new Date(doc.at).toLocaleString('he-IL')} · {doc.cashier} · {money(doc.totalAgorot)}
      </p>
      <ul className="t-menu">
        {doc.lines.map((l) => (
          <li key={l.itemId} className="t-menu-row">
            <span>
              {l.name} × {l.originalQty}
            </span>
            <small className="t-reason">{l.remainingQty < l.originalQty ? (l.remainingQty > 0 ? T.refundRemaining(String(l.remainingQty)) : T.receiptNothingLeft) : money(l.unitNetAgorot * l.originalQty)}</small>
            {mode && l.remainingQty > 0 ? (
              <div className="t-qty">
                <button type="button" className="t-step" aria-label="פחות" disabled={(qty[l.itemId] ?? 0) <= 0} onClick={() => setQty((q) => ({ ...q, [l.itemId]: Math.max(0, (q[l.itemId] ?? 0) - 1) }))}>
                  −
                </button>
                <span className="t-qty-n">{qty[l.itemId] ?? 0}</span>
                <button type="button" className="t-step" aria-label="עוד" disabled={(qty[l.itemId] ?? 0) >= l.remainingQty} onClick={() => setQty((q) => ({ ...q, [l.itemId]: Math.min(l.remainingQty, (q[l.itemId] ?? 0) + 1) }))}>
                  +
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {mode ? (
        <>
          <div className="t-total-row">
            <span>{T.refundAmount}</span>
            <strong className="t-total">{money(sum ?? 0)}</strong>
          </div>
          <p className="t-muted t-small">{T.refundNote}</p>
          <button
            type="button"
            className="t-btn t-btn-primary t-btn-wide"
            disabled={!anything}
            onClick={() =>
              void refund?.(id, qty).then((ok) => {
                if (ok) {
                  setMode(false);
                  back();
                }
              })
            }
          >
            {T.refundConfirm} · {doc.refundMethod === 'card' ? T.refundCard : T.refundCash}
          </button>
        </>
      ) : (
        <div className="t-done-actions">
          {!doc.isRefundDocument && refund && !refundHidden ? (
            <button type="button" className="t-btn t-btn-primary" disabled={!doc.anythingRefundable} onClick={() => setMode(true)}>
              {doc.anythingRefundable ? T.refund : T.refundNothingLeft}
            </button>
          ) : null}
          <button type="button" className="t-btn" onClick={() => reprint(id)}>
            {T.printCopy}
          </button>
        </div>
      )}
    </div>
  );
}
