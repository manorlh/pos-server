'use client';

/**
 * "כפה סגירה" (lib/remoteCloseForce.ts; pos-server app/services/remote_close_force.py): the request's
 * mode in the remote close / Z dialogs — the tills' `remoteCloseForceByDefault`, which the manager may
 * untick (or tick) for this one request. Indeterminate when the tills' defaults differ.
 */
import { useEffect, useRef } from 'react';
import { FORCE_LABEL } from '@/lib/remoteCloseForce';

export function ForceCloseToggle({
  checked,
  indeterminate = false,
  defaultWords,
  explain,
  note,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  /** "ברירת המחדל בקופה: כפייה" — what the parameter says, beside the box. */
  defaultWords: string;
  /** What the till will do in the chosen mode. */
  explain?: string | null;
  /** Why this till may not follow it (an old build, a kiosk's own rules). */
  note?: string | null;
  onChange: (checked: boolean) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <div className="space-y-1 rounded-lg border p-2">
      <label className="flex min-h-11 items-start gap-2">
        <input
          ref={box}
          type="checkbox"
          className="mt-1 size-4 accent-primary"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          <span className="font-medium">{FORCE_LABEL}</span>
          <span className="text-muted-foreground"> · {defaultWords}</span>
        </span>
      </label>
      {explain ? <p className="text-xs text-muted-foreground">{explain}</p> : null}
      {note ? <p className="text-xs text-amber-700 dark:text-amber-400">{note}</p> : null}
    </div>
  );
}
