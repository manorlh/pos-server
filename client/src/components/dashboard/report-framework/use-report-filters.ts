'use client';

/**
 * A report's filters, held in the URL (lib/reportFilters.ts): the bar edits a draft, "הפק דוח"
 * writes it to the URL (a history entry, so Back undoes it), and the report runs on what the
 * URL says. Back / forward / a pasted link reset the draft to the URL.
 *
 * Client-side filters (the free-text search, a filter the page applies to its rows) apply as
 * they are typed, once the report has run: written with `replace`, no history entry per
 * keystroke, and without running the draft's other, unsent changes.
 *
 * `spec` must be a module constant (it is compared by identity).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  activeReportFilters,
  clearedReportFilters,
  parseReportFilters,
  reportApiParams,
  writeReportFilters,
  type ReportFilterKey,
  type ReportFilterSpec,
  type ReportFilterValues,
} from '@/lib/reportFilters';
import { todayIso } from '@/lib/reportWindow';

export interface ReportFiltersController {
  spec: ReportFilterSpec;
  /** What the bar shows (not yet run). */
  draft: ReportFilterValues;
  draftExtras: Record<string, string>;
  /** What the report runs on — the URL — or null before the first run. */
  applied: { values: ReportFilterValues; extras: Record<string, string> } | null;
  /** The applied filters as the server takes them (null before the first run). */
  apiParams: Record<string, string | number> | null;
  /** The applied filters that narrow something. */
  active: ReportFilterKey[];
  /** The draft differs from what was run. */
  dirty: boolean;
  set: (patch: Partial<ReportFilterValues>) => void;
  setExtra: (key: string, value: string) => void;
  run: () => void;
  clearAll: () => void;
  isClient: (key: ReportFilterKey) => boolean;
}

/** The value field of each filter that can be client-side. */
const CLIENT_FIELDS: Partial<Record<ReportFilterKey, keyof ReportFilterValues>> = {
  search: 'q',
  method: 'method',
  category: 'categoryId',
  product: 'productId',
  docType: 'docType',
  area: 'areaId',
  cashier: 'cashierId',
};

export function useReportFilters(spec: ReportFilterSpec): ReportFiltersController {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();
  const today = todayIso();

  const parsed = useMemo(() => parseReportFilters(new URLSearchParams(urlKey), spec, today), [urlKey, spec, today]);
  const clientFields = useMemo(
    () =>
      (spec.clientFilters ?? [])
        .map((k) => CLIENT_FIELDS[k])
        .filter((f): f is keyof ReportFilterValues => Boolean(f)),
    [spec],
  );

  const [draft, setDraft] = useState({ values: parsed.values, extras: parsed.extras });
  const [syncedKey, setSyncedKey] = useState(urlKey);
  // The URL our own client-side filter wrote: syncing it must not drop the draft's other edits.
  const [clientWriteKey, setClientWriteKey] = useState<string | null>(null);
  if (syncedKey !== urlKey) {
    setSyncedKey(urlKey);
    if (urlKey === clientWriteKey) {
      const values = { ...draft.values };
      for (const f of clientFields) (values as Record<string, unknown>)[f] = parsed.values[f];
      setDraft({ ...draft, values });
    } else {
      // Run, Back, a link, the scope bar: the bar shows what the URL says.
      setDraft({ values: parsed.values, extras: parsed.extras });
    }
  }

  const hrefFor = useCallback(
    (values: ReportFilterValues, extras: Record<string, string>) =>
      writeReportFilters(new URLSearchParams(urlKey), values, extras, spec).toString(),
    [spec, urlKey],
  );
  const go = useCallback(
    (query: string, mode: 'push' | 'replace') => {
      const href = query ? `${pathname}?${query}` : pathname;
      if (mode === 'push') router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [pathname, router],
  );

  const pending = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );

  const set = useCallback(
    (patch: Partial<ReportFilterValues>) => {
      setDraft((prev) => ({ ...prev, values: { ...prev.values, ...patch } }));
      const fields = Object.keys(patch) as (keyof ReportFilterValues)[];
      if (!parsed.applied || fields.length === 0 || !fields.every((f) => clientFields.includes(f))) return;
      // Only the client-side fields change in the URL; the draft's unsent server filters wait for "הפק דוח".
      const query = hrefFor({ ...parsed.values, ...patch }, parsed.extras);
      if (pending.current !== null) window.clearTimeout(pending.current);
      pending.current = window.setTimeout(
        () => {
          pending.current = null;
          setClientWriteKey(query);
          go(query, 'replace');
        },
        fields.includes('q') ? 300 : 0,
      );
    },
    [clientFields, go, hrefFor, parsed],
  );

  const setExtra = useCallback((key: string, value: string) => {
    setDraft((prev) => ({ ...prev, extras: { ...prev.extras, [key]: value } }));
  }, []);

  const run = useCallback(() => go(hrefFor(draft.values, draft.extras), 'push'), [draft, go, hrefFor]);
  const clearAll = useCallback(() => {
    const cleared = clearedReportFilters(spec, today);
    setDraft({ values: cleared.values, extras: cleared.extras });
    if (parsed.applied) go(hrefFor(cleared.values, cleared.extras), 'push');
  }, [go, hrefFor, parsed.applied, spec, today]);

  const isClient = useCallback((key: ReportFilterKey) => (spec.clientFilters ?? []).includes(key), [spec]);

  const applied = useMemo(
    () => (parsed.applied ? { values: parsed.values, extras: parsed.extras } : null),
    [parsed],
  );
  const apiParams = useMemo(() => (parsed.applied ? reportApiParams(parsed.values, spec) : null), [parsed, spec]);
  const active = useMemo(() => (applied ? activeReportFilters(applied.values, spec) : []), [applied, spec]);
  const dirty =
    !parsed.applied ||
    JSON.stringify(draft.values) !== JSON.stringify(parsed.values) ||
    JSON.stringify(draft.extras) !== JSON.stringify(parsed.extras);

  return {
    spec,
    draft: draft.values,
    draftExtras: draft.extras,
    applied,
    apiParams,
    active,
    dirty,
    set,
    setExtra,
    run,
    clearAll,
    isClient,
  };
}
