/**
 * The kiosk's own keyboard (a touch kiosk has no physical one, and the Windows touch keyboard does
 * not come up reliably in kiosk mode): Hebrew letters, digits, space and delete; a digits-only
 * pad for the phone and the table number. Styled from the kiosk's theme.
 */

import { Delete } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { PreviewModel } from '@kiosk-shared/index';

const HEBREW = [
  ['ק', 'ר', 'א', 'ט', 'ו', 'ן', 'ם', 'פ'],
  ['ש', 'ד', 'ג', 'כ', 'ע', 'י', 'ח', 'ל', 'ך', 'ף'],
  ['ז', 'ס', 'ב', 'ה', 'נ', 'מ', 'צ', 'ת', 'ץ'],
];
const DIGITS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', '⌫'],
];

export function Keyboard({ m, mode, onKey }: { m: PreviewModel; mode: 'text' | 'digits'; onKey: (key: string) => void }) {
  const key: CSSProperties = {
    background: m.cfg.theme.mode === 'dark' ? '#FFFFFF14' : '#FFFFFF',
    color: m.c.text,
    borderRadius: Math.min(10, m.radius),
    boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
  };
  const press = (k: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    onKey(k);
  };
  if (mode === 'digits') {
    return (
      <div className="mx-auto grid w-full max-w-[280px] grid-cols-3 gap-2 p-2" dir="ltr">
        {DIGITS.flat().map((k, i) =>
          k === '' ? (
            <span key={i} />
          ) : (
            <button key={i} type="button" onPointerDown={press(k === '⌫' ? 'Backspace' : k)} className="flex h-12 items-center justify-center text-xl font-bold active:scale-95" style={key}>
              {k === '⌫' ? <Delete className="h-5 w-5" /> : k}
            </button>
          ),
        )}
      </div>
    );
  }
  return (
    <div className="w-full space-y-1.5 p-2" style={{ background: m.cfg.theme.mode === 'dark' ? '#00000040' : '#0000000A', borderRadius: m.radius }}>
      {HEBREW.map((row, r) => (
        <div key={r} className="flex justify-center gap-1">
          {row.map((k) => (
            <button key={k} type="button" onPointerDown={press(k)} className="flex h-10 min-w-0 flex-1 items-center justify-center text-base font-semibold active:scale-95" style={key}>
              {k}
            </button>
          ))}
        </div>
      ))}
      <div className="flex justify-center gap-1">
        <button type="button" onPointerDown={press('Backspace')} className="flex h-10 w-16 items-center justify-center active:scale-95" style={key}>
          <Delete className="h-5 w-5" />
        </button>
        <button type="button" onPointerDown={press(' ')} className="h-10 flex-1 active:scale-95" style={key} aria-label="space" />
        {['1', '2', '3'].map((k) => (
          <button key={k} type="button" onPointerDown={press(k)} className="flex h-10 w-10 items-center justify-center font-semibold active:scale-95" style={key}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Apply a key to a value (Backspace removes the last character), keeping it within `max`. */
export function applyKey(value: string, k: string, max: number): string {
  if (k === 'Backspace') return value.slice(0, -1);
  if (value.length >= max) return value;
  return value + k;
}
