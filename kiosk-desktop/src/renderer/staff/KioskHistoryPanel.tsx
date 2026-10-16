/**
 * "היסטוריית עסקאות" in "ניהול הקיוסק" (the manager's code already given) — pos-android ui/kiosk/KioskReprintPanel.kt
 * `KioskReprintSection` and KioskAdminTools.kt `KioskQuickReprints`, with the Windows kiosk's "שובר פריט לא הודפס"
 * (core/kioskReprint.ts; main/service.ts adminHistory / adminReprint):
 *
 *  - "הדפס עסקה אחרונה (העתק)" and "הדפס שוב את הבון האחרון" on top;
 *  - the paid sales of today ("היום", the default), of the week the kiosk keeps ("7 ימים"), or older from the cloud
 *    ("ישנות יותר"), newest first, searched by pickup number / letters, document number, name or amount; each with its
 *    time, pickup label, amount, payment, and how its receipt, bon and item tickets printed ("לא הודפס" per ticket);
 *  - a tap picks a sale (the list itself changes nothing): "שובר פריט" (all its tickets, or "רק מה שלא הודפס"),
 *    "חשבונית (העתק)", "בון למטבח" — each "הדפסה חוזרת", under its permission (the menu's manager alone, else another
 *    manager's code on the pad), recorded; the day's reprints below, read only. Nothing here prints by itself.
 */

import { useEffect, useState } from 'react';
import { cardStyle, type PreviewModel } from '@kiosk-shared/index';
import type { AdminAction, AdminActionResult, AdminHistory, HistoryRow } from '../../shared/bridge';
import { kindLabel, REPRINT_TEXT, ticketStateText, type ReprintKind } from '../../core/kioskReprint';
import { kiosk } from '../bridge';
import { PinPad } from './StaffLayer';

const shekels = (agorot: number) => `₪${(agorot / 100).toFixed(2)}`;
const two = (n: number) => String(n).padStart(2, '0');

/** "14:05" today, "12.10 14:05" another day; nothing when the cloud did not say. */
function whenOf(ms: number, today: boolean): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return today ? hm : `${two(d.getDate())}.${two(d.getMonth() + 1)} ${hm}`;
}

type Range = { days: number; older: boolean };
const RANGES: Array<{ key: string; label: string; range: Range }> = [
  { key: 'today', label: REPRINT_TEXT.today, range: { days: 1, older: false } },
  { key: 'week', label: REPRINT_TEXT.week, range: { days: 7, older: false } },
  { key: 'older', label: REPRINT_TEXT.older, range: { days: 7, older: true } },
];

/** One reprint asked: what, of which sale — kept while the second manager's code is typed. */
type Ask = { action: AdminAction; title: string };

export function KioskHistoryPanel({ m, onDone }: { m: PreviewModel; onDone?: () => void }) {
  const [range, setRange] = useState<Range>(RANGES[0].range);
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const [history, setHistory] = useState<AdminHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);

  // The search box settles before it asks (the cloud's part is a request).
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(typed.trim()), 350);
    return () => window.clearTimeout(id);
  }, [typed]);

  useEffect(() => {
    if (!kiosk.adminHistory) return;
    let live = true;
    setLoading(true);
    kiosk
      .adminHistory({ days: range.days, older: range.older, query })
      .then((h) => {
        if (live) setHistory(h);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [range, query, version]);

  if (!kiosk.adminHistory) return null;

  const run = async (action: AdminAction, title: string, code?: string): Promise<AdminActionResult> => {
    setBusy(true);
    const r = await kiosk.adminAction(code ? ({ ...action, code } as AdminAction) : action).catch((e: unknown) => ({ ok: false, message: String(e) }) as AdminActionResult);
    setBusy(false);
    if (r.needsCode) {
      setAsk({ action, title });
      return r;
    }
    setAsk(null);
    setNote({ ok: r.ok, text: r.message ?? (r.ok ? REPRINT_TEXT.done : 'לא בוצע') });
    setVersion((v) => v + 1);
    onDone?.();
    return r;
  };

  const reprint = (row: HistoryRow, kind: ReprintKind, only: 'all' | 'failed' = 'all') =>
    void run({ type: 'reprint', kind, orderId: row.localId, only }, REPRINT_TEXT.approve(only === 'failed' ? REPRINT_TEXT.itemTicketsFailed : kindLabel(kind), row.label));

  const rows = history?.rows ?? [];
  const current = rows.find((r) => r.localId === picked) ?? rows[0] ?? null;
  const today = history ? new Date().toDateString() : '';
  const btn = { background: m.c.button, color: m.c.buttonText, borderRadius: 8 } as const;
  const soft = { background: `${m.c.button}1A`, color: m.c.button, borderRadius: 8 } as const;

  return (
    <section className="space-y-2 p-3 text-sm" style={cardStyle(m)} data-testid="kiosk-history">
      <h3 className="text-sm font-extrabold">{REPRINT_TEXT.history}</h3>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} className="px-3 py-1.5 text-xs font-bold disabled:opacity-40" style={soft} onClick={() => void run({ type: 'reprintLast' }, REPRINT_TEXT.lastSale)}>
          {REPRINT_TEXT.lastSale}
        </button>
        {history?.bonsOn ? (
          <button type="button" disabled={busy || !history.lastBon} className="px-3 py-1.5 text-xs font-bold disabled:opacity-40" style={soft} onClick={() => void run({ type: 'reprintLastBon' }, REPRINT_TEXT.lastBon)}>
            {REPRINT_TEXT.lastBon}
          </button>
        ) : null}
      </div>
      {note ? <div className={`rounded-lg p-2 text-center text-xs font-semibold ${note.ok ? 'bg-black/5' : 'bg-red-50 text-red-700'}`}>{note.text}</div> : null}
      {history && history.unprintedTickets > 0 ? <div className="text-xs font-bold text-red-600">{REPRINT_TEXT.ticketsAlert(history.unprintedTickets)}</div> : null}
      <div className="text-xs" style={{ color: m.c.mutedText }}>
        {REPRINT_TEXT.historySub}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value.slice(0, 40))}
          placeholder={REPRINT_TEXT.search}
          className="min-w-0 flex-1 rounded border px-2 py-1.5 text-sm"
          style={{ borderColor: m.c.border, background: m.c.surface, color: m.c.text }}
        />
        {RANGES.map((r) => {
          const on = r.range.days === range.days && r.range.older === range.older;
          return (
            <button key={r.key} type="button" className="px-3 py-1.5 text-xs font-bold" style={on ? btn : soft} onClick={() => setRange(r.range)}>
              {r.label}
            </button>
          );
        })}
      </div>
      {history?.cloud === 'failed' ? <div className="text-xs font-semibold text-red-600">{REPRINT_TEXT.cloudFailed}</div> : null}
      {history?.cloud === 'unsupported' ? <div className="text-xs font-semibold text-amber-700">{REPRINT_TEXT.cloudUnsupported}</div> : null}
      {loading && !history ? <div className="text-xs">…</div> : null}
      {history && rows.length === 0 ? <div>{range.days === 1 && !range.older && !query ? REPRINT_TEXT.noOrdersToday : REPRINT_TEXT.empty}</div> : null}
      <div className="space-y-1">
        {rows.map((r) => {
          const on = r.localId === current?.localId;
          const failed = r.tickets.filter((t) => t.state === 'failed').length;
          const isToday = r.at > 0 && new Date(r.at).toDateString() === today;
          return (
            <button
              key={r.localId}
              type="button"
              onClick={() => setPicked(r.localId)}
              className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 border-t px-1 py-1.5 text-start text-xs"
              style={{ borderColor: m.c.border, background: on ? `${m.c.button}14` : 'transparent' }}
            >
              <span className="min-w-12 font-bold" dir="ltr">
                {r.pickupLabel ?? r.label}
              </span>
              <span>{[whenOf(r.at, isToday), shekels(r.totalAgorot), r.payment, r.number ? `#${r.number}` : null, r.customerName].filter(Boolean).join(' · ')}</span>
              {r.bonFailed ? <span className="font-bold text-red-600">בון: {r.bon}</span> : null}
              {failed > 0 ? <span className="font-bold text-red-600">{REPRINT_TEXT.ticketsNotPrinted}{failed > 1 ? ` (${failed})` : ''}</span> : null}
              {r.source === 'cloud' ? <span style={{ color: m.c.mutedText }}>(מהענן)</span> : null}
            </button>
          );
        })}
      </div>
      {history && history.total > rows.length ? (
        <div className="text-xs" style={{ color: m.c.mutedText }}>
          מוצגות {rows.length} מתוך {history.total} — חיפוש מצמצם
        </div>
      ) : null}
      {current ? (
        <div className="space-y-1.5 rounded-lg border p-2" style={{ borderColor: m.c.border }} data-testid="kiosk-history-picked">
          <div className="font-bold">
            {[current.pickupLabel, whenOf(current.at, current.at > 0 && new Date(current.at).toDateString() === today), shekels(current.totalAgorot), current.number ? `#${current.number}` : null]
              .filter(Boolean)
              .join(' · ')}
          </div>
          <div className="text-xs">
            תשלום: {current.payment ?? '—'} · קבלה: {current.receipt} · בון: <span className={current.bonFailed ? 'font-bold text-red-600' : ''}>{current.bon}</span>
          </div>
          {current.tickets.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <span>{REPRINT_TEXT.itemTickets}:</span>
              {current.tickets.map((t) => (
                <span
                  key={t.index}
                  className={`rounded-full px-2 py-0.5 ${t.state === 'failed' ? 'bg-red-600 font-bold text-white' : 'bg-black/5'}`}
                  title={t.prints > 1 ? `הודפס ${t.prints} פעמים` : undefined}
                >
                  <span dir="ltr">{`${t.index}/${t.count}`}</span> {ticketStateText(t.state)}
                  {t.prints > 1 ? ` · ${t.prints}×` : ''}
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-0.5">
            {current.kinds.map((k) => (
              <button key={k} type="button" disabled={busy} className="px-3 py-1.5 text-xs font-bold disabled:opacity-40" style={btn} onClick={() => reprint(current, k)}>
                {kindLabel(k)}
              </button>
            ))}
            {current.kinds.includes('item_tickets') && current.tickets.some((t) => t.state === 'failed') ? (
              <button type="button" disabled={busy} className="px-3 py-1.5 text-xs font-bold disabled:opacity-40" style={{ ...btn, background: '#DC2626', color: '#fff' }} onClick={() => reprint(current, 'item_tickets', 'failed')}>
                {REPRINT_TEXT.itemTicketsFailed}
              </button>
            ) : null}
          </div>
          {current.source === 'cloud' && !current.kinds.includes('invoice_copy') ? <div className="text-xs">{REPRINT_TEXT.noDocument}</div> : null}
          {history && !history.alone ? (
            <div className="text-xs" style={{ color: m.c.mutedText }}>
              {REPRINT_TEXT.needsManager}
            </div>
          ) : null}
        </div>
      ) : null}
      {history && history.log.length > 0 ? (
        <div className="space-y-0.5 pt-1">
          <div className="text-xs font-bold">{REPRINT_TEXT.log}</div>
          {history.log.map((e, i) => (
            <div key={`${e.at}-${i}`} className="text-xs" style={{ color: m.c.mutedText }}>
              {[
                whenOf(e.at, true),
                kindLabel(e.kind) + (e.tickets && e.tickets.length > 0 && e.kind === 'item_tickets' ? ` (${e.tickets.join(', ')})` : ''),
                e.label,
                e.by,
                e.failed ? 'לא הודפס' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          ))}
        </div>
      ) : null}
      {ask ? (
        <PinPad
          m={m}
          title={`${ask.title} — קוד מנהל`}
          onCancel={() => setAsk(null)}
          onSubmit={async (code) => {
            const r = await run(ask.action, ask.title, code);
            return r.needsCode ? (r.message ?? REPRINT_TEXT.needsManager) : null;
          }}
        />
      ) : null}
    </section>
  );
}
