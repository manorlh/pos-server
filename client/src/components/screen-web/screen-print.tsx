'use client';

/**
 * "דרך קופה בסניף" on the browser screen (docs/SPEC_KDS.md §17, lib/kdsRelayPrinter.ts):
 *
 *  - `PrintTray`: the bons on their way, a small stack in the corner that never blocks the screen —
 *    "ממתין למדפסת — <קופה>", "הודפס בקופה <קופה>", "לא הודפס — נסו שוב" (with the button);
 *  - `ScreenPrintSection` (the staff sheet): how this screen prints now, where its bons go, the how-to for this
 *    device, and "הדפסת בדיקה".
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Printer, RotateCw, X, XCircle } from 'lucide-react';
import type { BridgeState } from '@/lib/kioskBridge';
import { KDS_PRINT_PATH_HINTS, KDS_PRINT_PATH_LABELS, howToFor, relayLine, type KdsPrintStatus } from '@/lib/kdsPrint';
import type { KdsRelayPrinter, TrayItem } from '@/lib/kdsRelayPrinter';
import { bridgeLine } from '@/lib/screenBridge';

export function useRelayPrinter(printer: KdsRelayPrinter | null): { status: KdsPrintStatus | null; items: TrayItem[] } {
  const [state, setState] = useState<{ status: KdsPrintStatus | null; items: TrayItem[] }>(() => ({
    status: printer?.status() ?? null,
    items: printer?.items() ?? [],
  }));
  useEffect(() => {
    if (!printer) return;
    const update = () => setState({ status: printer.status(), items: printer.items() });
    update();
    return printer.onChange(update);
  }, [printer]);
  return state;
}

export function PrintTray({ printer, items }: { printer: KdsRelayPrinter; items: TrayItem[] }) {
  if (items.length === 0) return null;
  return (
    <div dir="rtl" className="pointer-events-none fixed bottom-3 start-3 z-[80] flex w-[min(92vw,380px)] flex-col gap-2" aria-live="polite">
      {items.map((it) => {
        const tone =
          it.phase === 'done'
            ? 'bg-emerald-600 text-white'
            : it.phase === 'failed'
              ? 'bg-red-600 text-white'
              : 'bg-neutral-900/90 text-white';
        const Icon = it.phase === 'done' ? CheckCircle2 : it.phase === 'failed' ? XCircle : it.phase === 'waiting' ? Clock : Printer;
        return (
          <div key={it.id} className={`pointer-events-auto flex items-center gap-2 rounded-xl px-3 py-2 text-base font-bold shadow-lg ${tone}`}>
            <Icon size={20} className={it.phase === 'sending' || it.phase === 'waiting' ? 'shrink-0 animate-pulse' : 'shrink-0'} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold opacity-80">{it.title}</span>
              <span className="block truncate">{it.text}</span>
            </span>
            {it.phase === 'failed' ? (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white/20 px-2.5 py-1.5 text-sm font-extrabold active:scale-[0.96]"
                onClick={() => void printer.retry(it.id)}
              >
                <RotateCw size={16} /> נסו שוב
              </button>
            ) : null}
            {it.phase !== 'sending' ? (
              <button type="button" aria-label="סגירה" className="shrink-0 rounded-lg p-1 opacity-70" onClick={() => printer.dismiss(it.id)}>
                <X size={16} />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function ScreenPrintSection({
  printer,
  bridgeState,
}: {
  printer: KdsRelayPrinter;
  bridgeState: BridgeState | null;
}) {
  const { status, items } = useRelayPrinter(printer);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void printer.refresh();
  }, [printer]);
  const path = status?.effectivePath ?? null;
  const row = 'flex justify-between gap-3 border-b border-neutral-100 py-1.5 text-sm last:border-0';
  const test = items.find((i) => i.test) ?? null;
  return (
    <div className="space-y-2 rounded-2xl bg-white p-4">
      <div className="flex items-center gap-2 font-extrabold">
        <Printer size={18} /> הדפסה
      </div>
      <div className={row}>
        <span className="text-neutral-500">איך המסך מדפיס</span>
        <b>{path ? KDS_PRINT_PATH_LABELS[path] : 'טוען…'}</b>
      </div>
      {path === 'relay' ? (
        <div className={row}>
          <span className="text-neutral-500">הבונים מודפסים</span>
          <b className={status?.relay?.ready ? 'text-emerald-700' : 'text-red-700'}>{relayLine(status)}</b>
        </div>
      ) : path === 'bridge' ? (
        <div className={row}>
          <span className="text-neutral-500">גשר Windows</span>
          <b>{bridgeLine(bridgeState)}</b>
        </div>
      ) : null}
      {path && path !== 'none' && path !== 'relay' && path !== 'bridge' ? <p className="text-xs text-neutral-500">{KDS_PRINT_PATH_HINTS[path]}</p> : null}
      {path === 'relay' ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            disabled={busy || !status?.relay?.ready}
            className="inline-flex items-center gap-2 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-bold text-white active:scale-[0.97] disabled:opacity-40"
            onClick={async () => {
              setBusy(true);
              const r = await printer.print(null, 'הדפסת בדיקה', { test: true });
              setNote(r.ok ? null : (r.message ?? 'ההדפסה נכשלה'));
              setBusy(false);
            }}
          >
            <Printer size={16} /> הדפסת בדיקה
          </button>
          {test ? <span className="text-sm font-semibold">{test.text}</span> : null}
          {note ? <span className="text-sm font-semibold text-red-700">{note}</span> : null}
        </div>
      ) : null}
      <details className="rounded-xl bg-neutral-50 p-3 text-sm">
        <summary className="cursor-pointer font-bold">איך מגדירים הדפסה במכשיר הזה</summary>
        {howToFor(status?.deviceKind).map((h) => (
          <div key={h.title} className="mt-2 space-y-1">
            <div className="font-bold">
              {h.title} — מומלץ: {KDS_PRINT_PATH_LABELS[h.recommended]}
            </div>
            <ol className="list-decimal space-y-0.5 ps-5 text-neutral-700">
              {h.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        ))}
        <p className="mt-2 text-xs text-neutral-500">את הבחירה משנים בדשבורד: מסכי מטבח ← המסך ← הדפסה.</p>
      </details>
    </div>
  );
}
