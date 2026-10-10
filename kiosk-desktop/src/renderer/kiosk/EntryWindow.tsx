/**
 * The kiosk's entry window — the centred window everything a customer types is typed in (the
 * Android kiosk's KioskEntryWindow.kt): a dimmed backdrop, a card in the kiosk's style, the
 * caption and the business, the question, the value drawn with its own blinking caret (no <input>:
 * nothing may raise the Windows touch keyboard), the problem under it, the counter, the keyboard
 * or the digits pad, "המשך" (and "דלג" for an optional step), ✕. It walks through its steps
 * (name → phone → table). Shared with the dashboard's live preview (preview-entry.tsx).
 */

import { NOTE_MAX } from '../../core/kioskKeys';
import type { EntryStep, PreviewModel } from '@kiosk-shared/index';

export { EntryWindow, type EntryStep } from '@kiosk-shared/index';

/** A window the kiosk draws over everything (the product sheet's note). */
export interface EntryRequest {
  caption: string;
  steps: EntryStep[];
}

/** "הערות למנה": the dish's free note for the kitchen, up to 80 characters, "שמירה". */
export function noteEntry(m: PreviewModel, value: string, onSave: (v: string) => void): EntryRequest {
  return {
    caption: m.txt('detailsCaption'),
    steps: [
      {
        key: 'note',
        icon: 'note',
        title: m.txt('noteTitle'),
        hint: m.txt('noteHint'),
        initial: value,
        max: NOTE_MAX,
        confirmLabel: m.txt('noteSave'),
        commit: onSave,
      },
    ],
  };
}
