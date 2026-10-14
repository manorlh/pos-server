'use client';

/**
 * "מסך לקוח" — the slideshow's editor (P:/specs/customer-display-transitions.md §2, §3א): several
 * files uploaded at once (or dropped here), each compressed in the background ("בעיבוד…" until
 * ready — the layer may be saved meanwhile); a thumbnail per slide, a video's from its first
 * frame; dragged to reorder (or moved with the arrows / the keyboard); each slide's duration and its
 * own transition over the global one; and per file, on how many of the devices showing it it is —
 * "חסר בקופה N" with "העלה מחדש" once the server deleted it and a device lacks it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, ArrowDown, ArrowUp, CloudOff, GripVertical, ImagePlus, Loader2, RefreshCw, Trash2, Video } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  CD_TEXT,
  DURATION_MAX,
  DURATION_MIN,
  IMAGE_TYPES,
  PLAYLIST_MAX,
  VIDEO_TYPES,
  acceptFiles,
  clampDuration,
  dropIndex,
  moveItem,
  pendingItemOf,
  pendingMediaIds,
  presenceSummary,
  withFile,
  type CdLevel,
  type CdMediaFile,
  type CdPresenceFile,
  type CdTransition,
  type PlaylistItem,
} from '@/lib/customerDisplay';
import { TRANSITIONS, isTransition, slideSeconds } from '@/lib/customerDisplayPlayer';
import {
  customerDisplayErrorMessage,
  getCustomerDisplayMedia,
  getCustomerDisplayMediaPresence,
  reuploadCustomerDisplayMedia,
  uploadCustomerDisplayMedia,
} from '@/lib/customerDisplayApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type PlaylistUpdate = (fn: (items: PlaylistItem[]) => PlaylistItem[]) => void;

const ACCEPT = [...IMAGE_TYPES, ...VIDEO_TYPES].join(',');
const POLL_MS = 3_000;

/* ------------------------------------------------------------------ thumbnails */

/** First-frame posters of videos and their lengths, by source (for the page's life). */
const posters = new Map<string, string | null>();
const lengths = new Map<string, number>();

/** A video's first frame drawn small (null when the browser may not read it: another origin), and its length. */
function capturePoster(src: string): Promise<{ poster: string | null; length: number | null }> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    if (!src.startsWith('blob:')) v.crossOrigin = 'anonymous';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    let settled = false;
    const finish = (poster: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const length = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      v.removeAttribute('src');
      v.load();
      resolve({ poster, length });
    };
    const timer = setTimeout(() => finish(null), 15_000);
    v.addEventListener('loadeddata', () => {
      try {
        v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
      } catch {
        finish(null);
      }
    }, { once: true });
    v.addEventListener('seeked', () => {
      try {
        const w = v.videoWidth;
        const h = v.videoHeight;
        if (!w || !h) return finish(null);
        const scale = Math.min(1, 320 / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.75));
      } catch {
        finish(null);
      }
    }, { once: true });
    v.addEventListener('error', () => finish(null), { once: true });
    v.src = src;
  });
}

function VideoThumb({ src, onLength }: { src: string; onLength: (src: string, sec: number) => void }) {
  const [poster, setPoster] = useState<string | null | undefined>(() => posters.get(src));
  useEffect(() => {
    let alive = true;
    const known = lengths.get(src);
    if (posters.has(src)) {
      if (known) onLength(src, known);
      return;
    }
    void capturePoster(src).then(({ poster: p, length }) => {
      posters.set(src, p);
      if (length) lengths.set(src, length);
      if (!alive) return;
      setPoster(p);
      if (length) onLength(src, length);
    });
    return () => {
      alive = false;
    };
  }, [src, onLength]);
  if (poster) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={poster} alt="" className="h-full w-full object-cover" />;
  }
  if (poster === null) {
    // The browser's own first frame (a poster the canvas may not read).
    return <video src={`${src}#t=0.1`} muted playsInline preload="metadata" className="h-full w-full object-cover" />;
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-muted">
      <Video className="h-5 w-5 text-muted-foreground" aria-hidden />
    </div>
  );
}

function Thumb({ item, src, onLength }: { item: PlaylistItem; src: string | undefined; onLength: (src: string, sec: number) => void }) {
  return (
    <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded bg-muted">
      {!src ? (
        <div className="flex h-full w-full items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
        </div>
      ) : item.kind === 'video' ? (
        <VideoThumb key={src} src={src} onLength={onLength} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      )}
      {item.kind === 'video' ? <Video className="absolute bottom-0.5 end-0.5 h-3.5 w-3.5 text-white drop-shadow" aria-hidden /> : null}
    </div>
  );
}

function bytesLabel(n: number | null | undefined): string {
  if (!n) return '';
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

function clock(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ the editor */

export function PlaylistEditor({
  items,
  update,
  refresh,
  level,
  entityId,
  globalTransition,
  videoUntilEnd,
  videoQuality,
  playingUrl,
  onBusy,
}: {
  items: PlaylistItem[];
  /** A change made here (the playlist becomes this layer's own). */
  update: PlaylistUpdate;
  /** A file got ready: its URL into this layer's own playlist only (an inherited one is the server's to fill). */
  refresh: PlaylistUpdate;
  level: CdLevel;
  entityId: string;
  globalTransition: CdTransition;
  videoUntilEnd: boolean;
  videoQuality: string;
  /** The slide the preview shows now. */
  playingUrl?: string | null;
  onBusy?: (busy: boolean) => void;
}) {
  const t = useTranslations('customerDisplayMotion');
  const qc = useQueryClient();
  const [files, setFiles] = useState<Record<string, CdMediaFile>>({});
  const [local, setLocal] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [videoLengths, setVideoLengths] = useState<Record<string, number>>({});
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragRects = useRef<{ top: number; height: number }[]>([]);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const reuploadRef = useRef<HTMLInputElement>(null);
  const reuploadFor = useRef<string | null>(null);
  const localRef = useRef(local);

  useEffect(() => {
    localRef.current = local;
  }, [local]);
  useEffect(() => () => Object.values(localRef.current).forEach((u) => URL.revokeObjectURL(u)), []);
  useEffect(() => {
    onBusy?.(progress !== null);
  }, [progress, onBusy]);

  const presence = useQuery({
    queryKey: ['customer-display-presence', level, entityId],
    queryFn: () => getCustomerDisplayMediaPresence(level, entityId),
    refetchInterval: 60_000,
  });
  const presenceById = useMemo(() => {
    const out: Record<string, CdPresenceFile> = {};
    for (const f of presence.data ?? []) out[f.id] = f;
    return out;
  }, [presence.data]);

  // Ask after the files still being compressed (the playlist's, and the ones uploaded again) — not
  // after one known done (an inherited playlist's slide keeps no URL here: the server fills it).
  const waiting = useMemo(
    () =>
      [
        ...new Set([
          ...pendingMediaIds(items).filter((id) => !files[id] || files[id].status === 'processing'),
          ...Object.values(files).filter((f) => f.status === 'processing').map((f) => f.id),
        ]),
      ].sort(),
    [items, files],
  );
  const waitingKey = waiting.join(',');
  useEffect(() => {
    if (!waitingKey) return;
    const ids = waitingKey.split(',');
    let alive = true;
    const tick = async () => {
      try {
        const got = await getCustomerDisplayMedia(ids);
        if (!alive) return;
        setFiles((prev) => {
          const next = { ...prev };
          for (const f of got) next[f.id] = f;
          return next;
        });
        const done = got.filter((f) => f.status === 'ready' || f.status === 'deleted');
        if (done.length) {
          refresh((list) => {
            let changed = false;
            const out = list.map((i) => {
              const f = done.find((d) => d.id === i.mediaId);
              if (!f) return i;
              const n = withFile(i, f);
              if (n.url !== i.url || n.sha256 !== i.sha256) changed = true;
              return n;
            });
            return changed ? out : list;
          });
        }
        if (got.some((f) => f.status !== 'processing')) void qc.invalidateQueries({ queryKey: ['customer-display-presence', level, entityId] });
      } catch {
        /* asked again at the next tick */
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [waitingKey, refresh, qc, level, entityId]);

  const fileOf = (item: PlaylistItem): CdMediaFile | undefined =>
    item.mediaId ? (files[item.mediaId] ?? presenceById[item.mediaId]) : undefined;
  const srcOf = (item: PlaylistItem): string | undefined => item.url ?? (item.mediaId ? local[item.mediaId] : undefined);
  const noteLength = useCallback((src: string, sec: number) => setVideoLengths((m) => (m[src] === sec ? m : { ...m, [src]: sec })), []);

  const addFiles = async (list: File[]) => {
    const { accepted, rejected } = acceptFiles(list, PLAYLIST_MAX - items.length);
    if (rejected.length) {
      const key = { type: 'rejectType', size: 'rejectSize', full: 'rejectFull' } as const;
      toast.error(t('rejected', { count: rejected.length, names: rejected.map((r) => t(key[r.reason], { name: r.name })).join(' · ') }));
    }
    if (!accepted.length) return;
    setProgress({ done: 0, total: accepted.length });
    for (let i = 0; i < accepted.length; i++) {
      const f = accepted[i];
      try {
        const made = await uploadCustomerDisplayMedia(level, entityId, f, videoQuality);
        const src = URL.createObjectURL(f);
        setLocal((m) => ({ ...m, [made.id]: src }));
        setFiles((m) => ({ ...m, [made.id]: made }));
        update((cur) => (cur.length >= PLAYLIST_MAX ? cur : [...cur, pendingItemOf(made)]));
      } catch (err) {
        toast.error(customerDisplayErrorMessage(err) ?? axiosErrorToToastMessage(err, t('uploadFailed', { name: f.name })));
      }
      setProgress({ done: i + 1, total: accepted.length });
    }
    setProgress(null);
  };

  const reupload = async (mediaId: string, file: File) => {
    try {
      const made = await reuploadCustomerDisplayMedia(mediaId, level, entityId, file, videoQuality);
      const src = URL.createObjectURL(file);
      setLocal((m) => ({ ...m, [made.id]: src }));
      setFiles((m) => ({ ...m, [made.id]: made }));
      toast.success(t('reuploaded'));
    } catch (err) {
      toast.error(customerDisplayErrorMessage(err) ?? axiosErrorToToastMessage(err, t('uploadFailed', { name: file.name })));
    }
  };

  const move = (from: number, to: number) => update((cur) => moveItem(cur, from, to));
  const patch = (i: number, fn: (p: PlaylistItem) => PlaylistItem) => update((cur) => cur.map((p, j) => (j === i ? fn(p) : p)));

  const startDrag = (i: number, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRects.current = items.map((_, j) => {
      const r = rowRefs.current[j]?.getBoundingClientRect();
      return { top: r?.top ?? 0, height: r?.height ?? 0 };
    });
    setDrag({ from: i, to: i });
  };
  const moveDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const to = dropIndex(e.clientY, dragRects.current, drag.from);
    if (to !== drag.to) setDrag({ ...drag, to });
  };
  const endDrag = () => {
    if (drag && drag.to !== drag.from) move(drag.from, drag.to);
    setDrag(null);
  };

  const order = drag ? moveItem(items.map((_, i) => i), drag.from, drag.to) : items.map((_, i) => i);
  const roundSec = items.reduce((s, it) => {
    const src = srcOf(it);
    return s + slideSeconds(it, videoUntilEnd, src ? videoLengths[src] : undefined);
  }, 0);
  const transitionName = (k: CdTransition) => t(`transitions.${k}`);

  return (
    <div
      className="space-y-2"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {order.map((i) => {
        const item = items[i];
        const file = fileOf(item);
        const status = file?.status ?? (item.url ? 'ready' : 'processing');
        const summary = presenceSummary(item.mediaId ? presenceById[item.mediaId] : undefined);
        const src = srcOf(item);
        const gone = file ? !file.onServer : false;
        const length = src ? videoLengths[src] : undefined;
        return (
          <div
            key={`${item.mediaId ?? item.url ?? 'x'}-${i}`}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            className={cn(
              'flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 transition-shadow',
              drag?.from === i && 'opacity-70 shadow-lg ring-2 ring-primary',
              playingUrl && item.url === playingUrl && drag === null && 'border-primary',
            )}
          >
            <button
              type="button"
              aria-label={t('dragHandle')}
              title={t('dragHandle')}
              className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
              onPointerDown={(e) => startDrag(i, e)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' && i > 0) {
                  e.preventDefault();
                  move(i, i - 1);
                } else if (e.key === 'ArrowDown' && i < items.length - 1) {
                  e.preventDefault();
                  move(i, i + 1);
                }
              }}
            >
              <GripVertical className="h-4 w-4" />
            </button>
            <Thumb item={item} src={src} onLength={noteLength} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div dir="ltr" className="truncate text-start text-xs text-muted-foreground">
                {item.url ? item.url.split('/').pop() : t('processing')}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                {status === 'processing' ? (
                  <span className="flex items-center gap-1 text-primary">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    {t('processing')}
                  </span>
                ) : null}
                {status === 'failed' ? (
                  <span className="flex items-center gap-1 text-destructive">
                    <AlertTriangle className="h-3 w-3" aria-hidden />
                    {t('failed')}
                  </span>
                ) : null}
                {file?.warning ? (
                  <span className="text-amber-600 dark:text-amber-400">{file.warning === 'ffmpeg_missing' ? t('uncompressed') : t('compressFailed')}</span>
                ) : file?.status === 'ready' && file.sourceBytes && file.bytes && file.bytes < file.sourceBytes ? (
                  <span className="text-muted-foreground">{t('compressed', { from: bytesLabel(file.sourceBytes), to: bytesLabel(file.bytes) })}</span>
                ) : null}
                {summary && status !== 'processing' ? (
                  <span className="text-muted-foreground">{summary.total ? t('presence', { held: summary.held, total: summary.total }) : t('presenceNone')}</span>
                ) : null}
                {gone ? (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <CloudOff className="h-3 w-3" aria-hidden />
                    {t('notOnServer')}
                  </span>
                ) : null}
                {summary?.missing.length ? (
                  <span className="text-destructive">{t('missingOn', { names: summary.missing.map((d) => d.name).join(', ') })}</span>
                ) : null}
                {item.mediaId && (status === 'failed' || summary?.missing.length) ? (
                  <button
                    type="button"
                    className="flex items-center gap-1 font-medium text-primary underline"
                    onClick={() => {
                      reuploadFor.current = item.mediaId ?? null;
                      reuploadRef.current?.click();
                    }}
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden />
                    {t('reupload')}
                  </button>
                ) : null}
              </div>
            </div>
            {item.kind === 'video' && videoUntilEnd ? (
              <span className="w-24 text-center text-xs text-muted-foreground">
                {t('untilEnd')}
                {length ? ` (${clock(length)})` : ''}
              </span>
            ) : (
              <label className="flex items-center gap-1 text-xs">
                <Input
                  type="number"
                  min={DURATION_MIN}
                  max={DURATION_MAX}
                  className="h-8 w-16"
                  value={item.durationSec}
                  onChange={(e) => patch(i, (p) => ({ ...p, durationSec: clampDuration(Number(e.target.value)) }))}
                />
                <span className="text-muted-foreground">{CD_TEXT.seconds}</span>
              </label>
            )}
            <label className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">{t('itemTransition')}</span>
              <select
                className="h-8 rounded-md border bg-background px-1 text-xs"
                value={item.transition ?? ''}
                onChange={(e) =>
                  patch(i, (p) => {
                    const next = { ...p };
                    if (isTransition(e.target.value)) next.transition = e.target.value;
                    else delete next.transition;
                    return next;
                  })
                }
              >
                <option value="">{t('itemTransitionInherit', { name: transitionName(globalTransition) })}</option>
                {TRANSITIONS.map((k) => (
                  <option key={k} value={k}>
                    {transitionName(k)}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="ghost" size="icon" aria-label={CD_TEXT.moveUp} disabled={i === 0} onClick={() => move(i, i - 1)}>
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon" aria-label={CD_TEXT.moveDown} disabled={i === items.length - 1} onClick={() => move(i, i + 1)}>
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon" aria-label={CD_TEXT.remove} onClick={() => update((cur) => cur.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (list.length) void addFiles(list);
        }}
      />
      <input
        ref={reuploadRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          const id = reuploadFor.current;
          reuploadFor.current = null;
          if (f && id) void reupload(id, f);
        }}
      />
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={progress !== null || items.length >= PLAYLIST_MAX}
          onClick={() => fileRef.current?.click()}
        >
          {progress ? <Loader2 className="me-1 h-4 w-4 animate-spin" /> : <ImagePlus className="me-1 h-4 w-4" />}
          {progress ? t('uploading', { done: progress.done, total: progress.total }) : t('addFiles')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('dropHere')}</span>
        {items.length ? <span className="text-xs text-muted-foreground">{t('roundTime', { sec: Math.round(roundSec) })}</span> : null}
      </div>
      {pendingMediaIds(items).length ? <p className="text-xs text-muted-foreground">{t('pendingSaveHint')}</p> : null}
    </div>
  );
}
