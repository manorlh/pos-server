/**
 * The till's state as the engine says it (§3.3): the last `state` from the link, the catalog
 * (fetched once, again when its version moves), the link's status, and `run(op, args)` — an op
 * with its refusal turned into a Hebrew toast. The screens hold no fiscal state of their own.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Catalog, OpArgs, TillOp, TillState } from '../../../shared/till/protocol';
import { EngineCallError, type EngineLink, type LinkStatus } from '../../host/TillHost';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'ok';
}

export interface TillEngineView {
  state: TillState | null;
  catalog: Catalog | null;
  status: LinkStatus;
  toasts: Toast[];
  /** The op's value, or undefined after a refusal (already shown as a toast). */
  run<K extends TillOp>(op: K, args?: OpArgs[K]): Promise<unknown>;
  dismissToast(id: number): void;
}

const TOAST_MS = 4000;

export function useTillEngine(link: EngineLink): TillEngineView {
  const [snap, setSnap] = useState(() => link.snapshot());
  const [status, setStatus] = useState<LinkStatus>(() => link.status());
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const toast = useCallback((text: string, tone: Toast['tone']) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((list) => [...list.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  useEffect(() => {
    const offEvents = link.on((e) => {
      if (e.ev === 'state') setSnap(link.snapshot());
      else if (e.ev === 'toast') {
        const d = e.data as { text?: unknown; tone?: unknown };
        if (typeof d.text === 'string') toast(d.text, d.tone === 'error' ? 'error' : d.tone === 'ok' ? 'ok' : 'info');
      }
    });
    const offStatus = link.onStatus((s) => {
      setStatus(s);
      setSnap(link.snapshot());
    });
    if (!link.snapshot()) void link.hello().then(() => setSnap(link.snapshot()), () => undefined);
    return () => {
      offEvents();
      offStatus();
    };
  }, [link, toast]);

  const catalogVersion = snap?.state.sell.catalogVersion ?? null;
  useEffect(() => {
    if (catalogVersion === null) return;
    let alive = true;
    link.call('catalog.snapshot', {}).then(
      (c) => alive && setCatalog(c as Catalog),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [link, catalogVersion]);

  const run = useCallback(
    async <K extends TillOp>(op: K, args?: OpArgs[K]) => {
      try {
        return await link.call(op, args);
      } catch (e) {
        toast(e instanceof EngineCallError ? e.message : 'מנוע הקופה לא זמין', 'error');
        return undefined;
      }
    },
    [link, toast],
  );

  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  return { state: snap?.state ?? null, catalog, status, toasts, run, dismissToast };
}
