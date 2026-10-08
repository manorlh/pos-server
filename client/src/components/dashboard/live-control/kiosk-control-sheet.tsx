'use client';

/**
 * "שליטה מרחוק בקיוסקים" (pos-server app/routers/kiosk_live.py, kiosks.py): each kiosk's live state
 * — online, flow, paused, its banner, today's orders — with pause / resume (a message and an end),
 * a banner on the screen without pausing, and quick hides of a product or a category on the shop's
 * kiosks ("הגריל סגור") until a time. `KioskControlPanel` is the body (the kiosks page's tab);
 * `KioskControlSheet` the same in a sheet.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EyeOff, Megaphone, Pause, Play, Wifi, WifiOff, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { EXTEND_BY, durationValid, formatLeft, formatUntil, parseHhmm, secondsLeft, type DurationChoice } from '@/lib/liveControl';
import {
  clearKioskBanner,
  clearKioskHide,
  createKioskHide,
  extendKioskHide,
  fetchKioskLive,
  kioskCommand,
  liveKeys,
  setKioskBanner,
  type KioskLiveRow,
} from '@/lib/liveControlApi';
import { useTick } from './active-blocks';
import { DurationPicker } from './duration-picker';
import { ItemPicker, type PickedItem } from './item-picker';
import type { LiveControlScope, LiveControlSheetProps } from './types';

const PAUSE_MINUTES = [15, 30, 60] as const;

type Dialogs = { kind: 'pause' | 'banner'; kiosk: KioskLiveRow } | { kind: 'hide' } | null;

export function useKioskLive(scope: LiveControlScope) {
  const s = { companyId: scope.companyId ?? null, shopId: scope.shopId ?? null };
  return useQuery({ queryKey: liveKeys.kiosks(s), queryFn: () => fetchKioskLive(s), refetchInterval: 10_000 });
}

function PauseDialog({ kiosk, onClose }: { kiosk: KioskLiveRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'manual' | 'minutes' | 'time' | 'next_open'>('minutes');
  const [minutes, setMinutes] = useState<number>(15);
  const [at, setAt] = useState('');
  const ok = mode !== 'time' || parseHhmm(at) != null;
  const pause = useMutation({
    mutationFn: () =>
      kioskCommand(kiosk.machineId, {
        action: 'pause',
        message: message.trim() || undefined,
        untilMode: mode,
        minutes: mode === 'minutes' ? minutes : undefined,
        untilTime: mode === 'time' ? parseHhmm(at) ?? undefined : undefined,
      }),
    onSuccess: () => {
      toast.success(`${kiosk.name} נעצר`);
      qc.invalidateQueries({ queryKey: ['kiosks'] });
      onClose();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'העצירה נכשלה')),
  });
  const chip = (active: boolean) => cn('min-h-10 rounded-full border px-3 text-sm', active ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>עצירת {kiosk.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} placeholder="הודעה ללקוחות (לא חובה) — נחזור בקרוב" className="h-11" />
          <div className="flex flex-wrap gap-2">
            {PAUSE_MINUTES.map((m) => (
              <button key={m} type="button" className={chip(mode === 'minutes' && minutes === m)} onClick={() => { setMode('minutes'); setMinutes(m); }}>
                {m === 60 ? 'שעה' : `${m} דק׳`}
              </button>
            ))}
            <button type="button" className={chip(mode === 'time')} onClick={() => setMode('time')}>עד שעה</button>
            <button type="button" className={chip(mode === 'next_open')} onClick={() => setMode('next_open')}>עד הפתיחה הבאה</button>
            <button type="button" className={chip(mode === 'manual')} onClick={() => setMode('manual')}>עד שאחדש</button>
          </div>
          {mode === 'time' ? <Input type="time" dir="ltr" value={at} onChange={(e) => setAt(e.target.value)} className="h-11 max-w-40" /> : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="min-h-11">ביטול</Button>
          <Button onClick={() => pause.mutate()} disabled={!ok || pause.isPending} className="min-h-11">עצור</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BannerDialog({ kiosk, onClose }: { kiosk: KioskLiveRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState(kiosk.banner?.message ?? '');
  const [duration, setDuration] = useState<DurationChoice>({ mode: 'minutes', minutes: 60 });
  const save = useMutation({
    mutationFn: () => setKioskBanner(kiosk.machineId, message.trim(), duration),
    onSuccess: () => {
      toast.success('ההודעה מוצגת בקיוסק');
      qc.invalidateQueries({ queryKey: ['kiosks'] });
      onClose();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'השמירה נכשלה')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>הודעה על מסך {kiosk.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} placeholder="למשל: הגריל ייפתח שוב ב-14:00" className="h-11" />
          <p className="text-xs text-muted-foreground">הקיוסק ממשיך למכור; ההודעה מוצגת בראש המסכים.</p>
          <DurationPicker value={duration} onChange={setDuration} shopId={kiosk.shopId} verb="מוצג עד" />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="min-h-11">ביטול</Button>
          <Button onClick={() => save.mutate()} disabled={!message.trim() || !durationValid(duration) || save.isPending} className="min-h-11">הצג</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HideDialog({ shopId, context, onClose }: { shopId: string; context?: LiveControlSheetProps['context']; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'product' | 'category'>(context?.categoryId ? 'category' : 'product');
  const [item, setItem] = useState<PickedItem | null>(null);
  const [note, setNote] = useState('');
  const [duration, setDuration] = useState<DurationChoice>({ mode: 'minutes', minutes: 60 });
  const save = useMutation({
    mutationFn: () => createKioskHide({ shopId, kind, itemId: item!.id, duration, note: note.trim() || undefined }),
    onSuccess: (h) => {
      const until = formatUntil(h.until, Date.now());
      toast.success(`${h.itemName ?? ''} מוסתר בקיוסקים${until ? ` עד ${until}` : ''}`);
      qc.invalidateQueries({ queryKey: ['kiosks'] });
      onClose();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'ההסתרה נכשלה')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>הסתרה מהירה בקיוסקים</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {(['product', 'category'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => { setKind(k); setItem(null); }}
                className={cn('min-h-11 rounded-xl border', kind === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted')}
              >
                {k === 'product' ? 'מוצר' : 'מחלקה'}
              </button>
            ))}
          </div>
          <ItemPicker kind={kind} value={item} onChange={setItem} shopId={shopId} />
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="הערה (לא חובה) — הגריל סגור" className="h-11" />
          <Label>לכמה זמן</Label>
          <DurationPicker value={duration} onChange={setDuration} shopId={shopId} verb="מוסתר עד" />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="min-h-11">ביטול</Button>
          <Button onClick={() => save.mutate()} disabled={!item || !durationValid(duration) || save.isPending} className="min-h-11">הסתר</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function KioskControlPanel({ scope, context }: { scope: LiveControlScope; context?: LiveControlSheetProps['context'] }) {
  const qc = useQueryClient();
  const now = useTick(15_000);
  const live = useKioskLive(scope);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['kiosks'] });
  const resume = useMutation({
    mutationFn: (k: KioskLiveRow) => kioskCommand(k.machineId, { action: 'resume' }),
    onSuccess: () => { toast.success('הקיוסק חזר למכירה'); refresh(); },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'החידוש נכשל')),
  });
  const dropBanner = useMutation({
    mutationFn: (k: KioskLiveRow) => clearKioskBanner(k.machineId),
    onSuccess: () => { toast.success('ההודעה הוסרה'); refresh(); },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'ההסרה נכשלה')),
  });
  const extend = useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number }) => extendKioskHide(id, minutes),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'ההארכה נכשלה')),
  });
  const show = useMutation({
    mutationFn: (id: string) => clearKioskHide(id),
    onSuccess: () => { toast.success('מוצג שוב בקיוסקים'); refresh(); },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'הפעולה נכשלה')),
  });

  const kiosks = (live.data?.kiosks ?? []).filter((k) => !context?.machineId || k.machineId === context.machineId);
  const shopId = scope.shopId ?? kiosks[0]?.shopId ?? null;

  if (live.isPending) {
    return <Skeleton className="h-28 w-full rounded-xl" />;
  }
  return (
    <div className="space-y-5">
      <section className="space-y-2" aria-label="קיוסקים">
        {kiosks.length === 0 ? <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">אין קיוסקים בהיקף</p> : null}
        {kiosks.map((k) => {
          const pausedLeft = formatLeft(secondsLeft(k.pausedUntil, now));
          const bannerLeft = formatLeft(secondsLeft(k.banner?.until ?? null, now));
          return (
            <div key={k.machineId} className={cn('space-y-2 rounded-xl border bg-card p-3 shadow-sm', k.paused && 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20')}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{k.name}</span>
                {k.online ? <Badge variant="outline" className="gap-1"><Wifi className="size-3" aria-hidden />מחובר</Badge> : <Badge variant="secondary" className="gap-1"><WifiOff className="size-3" aria-hidden />לא מחובר</Badge>}
                {k.paused ? <Badge variant="destructive">עצור{pausedLeft ? ` · ${pausedLeft}` : ''}</Badge> : <Badge variant="outline">פעיל</Badge>}
                <span className="ms-auto text-xs text-muted-foreground">{k.ordersToday} הזמנות היום</span>
              </div>
              {k.paused && k.pauseMessage ? <p className="text-sm">“{k.pauseMessage}”</p> : null}
              {k.banner ? (
                <div className="flex items-center gap-2 rounded-lg bg-muted px-2 py-1.5 text-sm">
                  <Megaphone className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{k.banner.message}</span>
                  {bannerLeft ? <span className="shrink-0 text-xs text-muted-foreground">{bannerLeft}</span> : null}
                  <button type="button" className="shrink-0 p-1" aria-label="הסר הודעה" onClick={() => dropBanner.mutate(k)}>
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {k.paused ? (
                  <Button size="sm" className="min-h-10 gap-1" disabled={resume.isPending} onClick={() => resume.mutate(k)}>
                    <Play className="size-4" aria-hidden />חדש מכירה
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="min-h-10 gap-1" onClick={() => setDialog({ kind: 'pause', kiosk: k })}>
                    <Pause className="size-4" aria-hidden />עצור
                  </Button>
                )}
                <Button size="sm" variant="outline" className="min-h-10 gap-1" onClick={() => setDialog({ kind: 'banner', kiosk: k })}>
                  <Megaphone className="size-4" aria-hidden />הודעה על המסך
                </Button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="space-y-2" aria-label="הסתרות מהירות">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">מוסתר עכשיו בקיוסקים</h3>
          <Button size="sm" variant="outline" className="min-h-10 gap-1" disabled={!shopId} onClick={() => setDialog({ kind: 'hide' })}>
            <EyeOff className="size-4" aria-hidden />הסתר מוצר / מחלקה
          </Button>
        </div>
        {!shopId ? <p className="text-sm text-muted-foreground">בחרו סניף כדי להסתיר בקיוסקים שלו.</p> : null}
        {(live.data?.hides ?? []).length === 0 ? (
          <p className="rounded-xl border border-dashed p-3 text-center text-sm text-muted-foreground">אין הסתרות פעילות</p>
        ) : (
          <ul className="space-y-2">
            {(live.data?.hides ?? []).map((h) => {
              const left = formatLeft(secondsLeft(h.until, now));
              return (
                <li key={h.id} className="rounded-xl border bg-card p-3">
                  <div className="flex items-center gap-2">
                    <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {h.kind === 'category' ? 'מחלקה · ' : ''}{h.itemName}
                    </span>
                    <span className="shrink-0 text-sm">{h.until ? `עד ${formatUntil(h.until, now)}` : 'עד שאציג'}{left ? ` · ${left}` : ''}</span>
                  </div>
                  {h.note ? <p className="text-sm text-muted-foreground">“{h.note}”</p> : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {h.until ? EXTEND_BY.map((m) => (
                      <Button key={m} size="sm" variant="outline" className="h-9" onClick={() => extend.mutate({ id: h.id, minutes: m })}>הארך +{m}</Button>
                    )) : null}
                    <Button size="sm" variant="outline" className="h-9" onClick={() => show.mutate(h.id)}>הצג שוב</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {dialog?.kind === 'pause' ? <PauseDialog kiosk={dialog.kiosk} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'banner' ? <BannerDialog kiosk={dialog.kiosk} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'hide' && shopId ? <HideDialog shopId={shopId} context={context} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

export function KioskControlSheet({ scope, context, onDone }: LiveControlSheetProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>שליטה מרחוק בקיוסקים</DialogTitle>
        </DialogHeader>
        <KioskControlPanel scope={scope} context={context} />
      </DialogContent>
    </Dialog>
  );
}
