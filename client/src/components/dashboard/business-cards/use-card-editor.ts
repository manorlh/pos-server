'use client';

/**
 * The card editor's working state: the draft, undo / redo, and autosave with optimistic
 * concurrency (the server's `draft_version`; a stale write answers 409 and the editor offers to
 * reload or overwrite — never a silent loss).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { CardDoc } from '@/lib/businessCards';
import { getCard, putDraft, type CardDetail } from '@/lib/businessCardsApi';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

const AUTOSAVE_MS = 1200;
const GROUP_MS = 800;
const HISTORY = 60;

/** JSON with sorted keys: "is the draft different?" independent of key order. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

interface History {
  doc: CardDoc;
  past: CardDoc[];
  future: CardDoc[];
}

export function useCardEditor(cardId: string, initial: CardDetail, canEdit: boolean) {
  const [h, setH] = useState<History>({ doc: initial.draft, past: [], future: [] });
  const [version, setVersion] = useState(initial.draftVersion);
  const [savedJson, setSavedJson] = useState(() => stableJson(initial.draft));
  const [state, setState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(initial.draftUpdatedAt);
  const lastPush = useRef(0);
  const inflight = useRef<Promise<boolean> | null>(null);

  const dirty = stableJson(h.doc) !== savedJson;

  const update = useCallback((fn: (d: CardDoc) => CardDoc) => {
    const now = Date.now();
    const group = now - lastPush.current < GROUP_MS;
    lastPush.current = now;
    setH((s) => {
      const next = fn(s.doc);
      if (next === s.doc) return s;
      return { doc: next, past: group && s.past.length ? s.past : [...s.past.slice(-(HISTORY - 1)), s.doc], future: [] };
    });
  }, []);

  const undo = useCallback(() => {
    lastPush.current = 0;
    setH((s) => (s.past.length ? { doc: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [s.doc, ...s.future] } : s));
  }, []);

  const redo = useCallback(() => {
    lastPush.current = 0;
    setH((s) => (s.future.length ? { doc: s.future[0], past: [...s.past, s.doc], future: s.future.slice(1) } : s));
  }, []);

  const docRef = useRef(h.doc);
  const versionRef = useRef(version);
  useEffect(() => {
    docRef.current = h.doc;
    versionRef.current = version;
  });

  /** Write the draft now. Resolves true when the server has it. */
  const saveNow = useCallback(async (opts?: { force?: boolean }): Promise<boolean> => {
    if (!canEdit) return true;
    if (inflight.current) await inflight.current;
    const sending = docRef.current;
    const sendingJson = stableJson(sending);
    let expected = versionRef.current;
    const run = (async () => {
      setState('saving');
      try {
        if (opts?.force) {
          const fresh = await getCard(cardId);
          expected = fresh.draftVersion;
        }
        const res = await putDraft(cardId, sending, expected);
        versionRef.current = res.draftVersion;
        setVersion(res.draftVersion);
        setSavedJson(sendingJson);
        setSavedAt(res.draftUpdatedAt);
        setState(stableJson(docRef.current) === sendingJson ? 'saved' : 'dirty');
        return true;
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        setState(status === 409 ? 'conflict' : 'error');
        return false;
      }
    })();
    inflight.current = run;
    try {
      return await run;
    } finally {
      inflight.current = null;
    }
  }, [cardId, canEdit]);

  // Autosave: a moment after the last change (and again after a failed attempt).
  useEffect(() => {
    if (!canEdit || !dirty || state === 'conflict' || state === 'saving') return;
    const timer = setTimeout(() => void saveNow(), state === 'error' ? AUTOSAVE_MS * 4 : AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [h.doc, dirty, state, canEdit, saveNow]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty && state !== 'saving') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, state]);

  /** Take the server's draft (after a conflict, a restored revision…), dropping local edits. */
  const replace = useCallback((detail: CardDetail) => {
    lastPush.current = 0;
    setH({ doc: detail.draft, past: [], future: [] });
    setVersion(detail.draftVersion);
    versionRef.current = detail.draftVersion;
    setSavedJson(stableJson(detail.draft));
    setSavedAt(detail.draftUpdatedAt);
    setState('saved');
  }, []);

  const reload = useCallback(async () => {
    replace(await getCard(cardId));
  }, [cardId, replace]);

  return {
    doc: h.doc,
    version,
    dirty,
    state: (dirty && (state === 'saved' || state === 'idle') ? 'dirty' : state) as SaveState,
    savedAt,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    update,
    undo,
    redo,
    saveNow,
    reload,
    replace,
  };
}

export type CardEditorState = ReturnType<typeof useCardEditor>;
