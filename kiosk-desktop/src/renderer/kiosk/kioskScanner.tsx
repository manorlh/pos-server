/**
 * Barcode scans on the Windows kiosk's customer screens — a USB HID scanner (keyboard bursts),
 * 1D and 2D, no button first — by the same rules as the Android kiosk (core/kioskScan.ts):
 *
 *  - every key is taken at the window, before the screens: no character types anywhere, no
 *    Enter presses a button, no Tab moves the focus (F-keys and Windows-key shortcuts excepted).
 *    On the staff screens a key goes on to a field that has the focus (the technician typing);
 *  - a product found among what the kiosk shows: into the basket with the pop and the flight of
 *    the card's "+", or its sheet when something must be chosen; the attract screen starts the
 *    order (the service screen keeps the dish until "לקחת" / "לשבת");
 *  - not found: "המוצר לא נמצא"; a prepaid voucher ("PV:…"): on "איך תרצו לשלם?" it is redeemed
 *    (`onVoucher`), anywhere else "יש להציג את השובר בקופה";
 *  - ignored on payment, success, details, the rest screens, a sheet and the staff's screens;
 *    the same code within 800 ms counts once.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cardStyle, type PProduct, type PreviewModel } from '@kiosk-shared/index';
import { ORDERING, type KioskScreen } from '../../core/kioskFlow';
import { decideScan, IDLE_END_MS, keyLeftAlone, parseScan, scannedVoucherCode, ScanDedupe, ScanKeyReader, type ScanProduct } from '../../core/kioskScan';

export interface KioskScanInput {
  m: PreviewModel;
  screen: KioskScreen;
  /** A payment holds the kiosk. */
  busy: boolean;
  /** The admin or the technician's screen is open. */
  staff: boolean;
  /** A product sheet or a question is up. */
  sheetOpen: boolean;
  /** What the kiosk shows (its categories' dishes, sold out marked, each with its addPath). */
  shown: PProduct[];
  /** The kiosk's catalog rows: barcode and SKU by product id (also those it does not show). */
  codes: Array<{ id: string; barcode?: string | null; sku: string | null }>;
  screenRef: RefObject<HTMLDivElement | null>;
  /** The card's "+" (the pop and the flight from [from]). */
  add: (p: PProduct, from: DOMRect | null) => void;
  /** Its sheet. */
  choose: (p: PProduct) => void;
  /** "הזמינו כאן". */
  start: () => void;
  /** The customer is here (the inactivity timer). */
  touch: () => void;
  /** "איך תרצו לשלם?" is on the screen with a voucher to take: a voucher scan is redeemed. */
  onVoucher?: ((code: string) => void) | null;
}

type Shown = ScanProduct & { p: PProduct };

const MENU: ReadonlySet<KioskScreen> = new Set(['catalog', 'cart', 'confirm']);

/** Typing into a field (the staff screens' inputs). */
function typingInField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** Wires the scanner; returns the note to draw over the screens ("המוצר לא נמצא"). */
export function useKioskScanner(input: KioskScanInput): ReactNode {
  const latest = useRef(input);
  latest.current = input;
  const pending = useRef<string | null>(null);
  const [note, setNote] = useState<{ text: string; id: number; ms: number } | null>(null);

  const say = useCallback((text: string, ms: number) => setNote({ text, id: performance.now(), ms }), []);

  /** The flight starts from the middle of the screen (a scan has no card to start from). */
  const centre = useCallback((): DOMRect | null => {
    const box = latest.current.screenRef.current?.getBoundingClientRect();
    return box ? new DOMRect(box.left + box.width / 2 - 60, box.top + box.height / 2 - 60, 120, 120) : null;
  }, []);

  const put = useCallback(
    (p: PProduct) => {
      const i = latest.current;
      if (p.addPath === 'direct') i.add(p, centre());
      else i.choose(p);
    },
    [centre],
  );

  const onCode = useCallback(
    (raw: string, dedupe: ScanDedupe) => {
      const i = latest.current;
      const code = parseScan(raw);
      const duplicate = !dedupe.accept(code.text, performance.now());
      // A voucher on the payment method step: redeemed there (the cloud checks it).
      const voucher = scannedVoucherCode(raw);
      if (voucher && i.onVoucher && !i.staff) {
        if (!duplicate) {
          i.touch();
          i.onVoucher(voucher);
        }
        return;
      }
      const byId = new Map(i.codes.map((c) => [c.id, c]));
      const shown: Shown[] = i.shown.map((p) => ({ id: p.id, barcode: byId.get(p.id)?.barcode ?? null, sku: byId.get(p.id)?.sku ?? null, soldOut: p.soldOut, p }));
      const all = i.codes.map((c) => ({ barcode: c.barcode ?? null, sku: c.sku }));
      const action = decideScan(code, { screen: i.screen, staff: i.staff, sheetOpen: i.sheetOpen, busy: i.busy }, shown, (s) => s.p.addPath ?? 'sheet', { all, duplicate });
      console.info(`kiosk scan (${code.symbology ?? '?'}${code.aim ? ` ${code.aim}` : ''}) on ${i.screen}: ${action.kind}`);
      switch (action.kind) {
        case 'ignore':
          return;
        case 'not_found':
          // The kiosk's texts (dashboard → kiosk → texts), the built-in Hebrew by default.
          say(i.m.txt('scanNotFound'), 1800);
          return;
        case 'voucher':
          say(i.m.txt('scanVoucherAtTill'), 3500);
          return;
        default: {
          i.touch();
          const p = action.product.p;
          if (action.start === 'now') put(p);
          else {
            pending.current = p.id;
            if (action.start === 'start_order') {
              i.start();
              // The order did not start (the screen changed under the scan): nothing waits.
              window.setTimeout(() => {
                if (latest.current.screen === 'attract') pending.current = null;
              }, 120);
            }
          }
        }
      }
    },
    [put, say],
  );

  // The scanner's keys, before anything on the page sees them.
  useEffect(() => {
    const reader = new ScanKeyReader();
    const dedupe = new ScanDedupe();
    let idleTimer: number | null = null;
    const deliver = (code: string | null) => {
      if (code) onCode(code, dedupe);
    };
    const leftToPage = (e: KeyboardEvent) => keyLeftAlone({ code: e.code, meta: e.metaKey }) || (latest.current.staff && typingInField());
    const onDown = (e: KeyboardEvent) => {
      if (leftToPage(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.isComposing) return;
      deliver(reader.down({ code: e.code, key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, caps: e.getModifierState?.('CapsLock') ?? false, repeat: e.repeat, at: e.timeStamp }));
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      idleTimer = reader.pending ? window.setTimeout(() => deliver(reader.idle(performance.now())), IDLE_END_MS + 20) : null;
    };
    const swallow = (e: KeyboardEvent) => {
      if (leftToPage(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', swallow, true);
    window.addEventListener('keypress', swallow, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', swallow, true);
      window.removeEventListener('keypress', swallow, true);
      if (idleTimer !== null) window.clearTimeout(idleTimer);
    };
  }, [onCode]);

  // The menu is up: the dish scanned before it (attract, service) goes in, after the screen's slide.
  const screen = input.screen;
  useEffect(() => {
    const id = pending.current;
    if (!id) return;
    if (!ORDERING.has(screen)) {
      pending.current = null;
      return;
    }
    if (!MENU.has(screen)) return;
    const timer = window.setTimeout(() => {
      pending.current = null;
      const p = latest.current.shown.find((x) => x.id === id && !x.soldOut);
      if (p) put(p);
      else say(latest.current.m.txt('scanNotFound'), 1800);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [screen, put, say]);

  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), note.ms);
    return () => window.clearTimeout(timer);
  }, [note]);

  return note ? <ScanNote key={note.id} m={input.m} text={note.text} /> : null;
}

function ScanNote({ m, text }: { m: PreviewModel; text: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-[61] flex -translate-y-1/2 justify-center p-6">
      <div className="max-w-[85%] px-6 py-4 text-center text-lg font-extrabold shadow-2xl animate-in fade-in zoom-in-95 duration-200" style={{ ...cardStyle(m), background: m.c.surface }}>
        {text}
      </div>
    </div>
  );
}
