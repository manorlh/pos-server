/**
 * "היסטוריה" (Android nav_history): today's documents of this till, newest first, each with "הדפס העתק" — a copy needs
 * the REPRINT right (the engine asks a manager's code when the user has it only by approval).
 */

import { useEffect, useState } from 'react';
import { money, T } from '../text';

export interface HistoryRow {
  id: string;
  ref: string;
  totalAgorot: number;
  at: string;
  cashier: string;
  methods: Array<'cash' | 'card'>;
}

export function HistoryScreen({ load, reprint, back }: { load(): Promise<HistoryRow[] | undefined>; reprint(id: string): void; back(): void }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    void load().then((r) => alive && setRows(r ?? []));
    return () => {
      alive = false;
    };
  }, [load]);
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
            <span className="t-history-ref">#{r.ref}</span>
            <span className="t-muted t-small">
              {new Date(r.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} · {r.cashier} · {r.methods.map((m) => (m === 'cash' ? T.cash : T.card)).join(' + ')}
            </span>
            <strong>{money(r.totalAgorot)}</strong>
            <button type="button" className="t-btn t-btn-small" onClick={() => reprint(r.id)}>
              {T.printCopy}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
