/**
 * "המכשיר הוגדר: קיוסק · סוג רישיון: קיוסק בלבד" (core/deviceLicense.ts, P:\specs\device-license-type.md §7.3): what the
 * cloud set the device up as, shown over its first screen for a few seconds after the pairing (the pairing screen is
 * gone by then), with the warning when the license does not fit the role it opened in. Tapping closes it.
 */

import { useEffect, useState } from 'react';

export interface PairedNoticeText {
  text: string | null;
  warning: string | null;
}

/** How long the notice stays (a warning a little longer). */
export const NOTICE_MS = 12_000;
export const WARNING_MS = 30_000;

let current: PairedNoticeText | null = null;
const listeners = new Set<(n: PairedNoticeText | null) => void>();

export function setPairedNotice(n: PairedNoticeText | null) {
  current = n && (n.text || n.warning) ? n : null;
  for (const fn of listeners) fn(current);
}

export function PairedNotice() {
  const [notice, setNotice] = useState<PairedNoticeText | null>(current);
  useEffect(() => {
    listeners.add(setNotice);
    return () => {
      listeners.delete(setNotice);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setPairedNotice(null), notice.warning ? WARNING_MS : NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return (
    <button
      type="button"
      dir="rtl"
      onClick={() => setPairedNotice(null)}
      className="fixed inset-x-0 bottom-6 z-[9999] mx-auto w-fit max-w-[90vw] space-y-1 rounded-2xl bg-neutral-900/90 px-6 py-3 text-center text-white shadow-2xl"
    >
      {notice.text ? <div className="text-lg font-bold">{notice.text}</div> : null}
      {notice.warning ? <div className="text-sm font-semibold text-amber-300">{notice.warning}</div> : null}
    </button>
  );
}
