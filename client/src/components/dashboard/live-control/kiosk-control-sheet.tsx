'use client';

/**
 * "שליטה מרחוק בקיוסקים" (pos-server app/routers/kiosk_live.py, kiosks.py): each kiosk's live state
 * — online, flow, paused, its banner, today's orders — with pause / resume (a message and an end),
 * a banner on the screen without pausing, and quick hides of a product or a category on the shop's
 * kiosks ("הגריל סגור") until a time. A quick hide is a block — the shop, "קיוסקים בלבד", "הסתר"
 * (specs/item-blocks-targets.md §7) — and "מוסתר עכשיו" lists every hand block in force that reaches
 * the shop's kiosks, with its kind, level, target and look. `KioskControlPanel` is the body (the
 * kiosks page's tab); `KioskControlSheet` the same in a sheet.
 *
 * Pause / resume are fire-and-forget ("פקודות שנשלחו", lib/deviceCommandsStore.ts): the pause
 * dialog closes at once, the answer is followed in the background (the tray, the kiosk row's
 * chip), and only that kiosk's button is busy during its own HTTP call — other kiosks and
 * actions stay available.
 */
import { useState } from 'react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, EyeOff, Loader2, Megaphone, PackageX, Pause, Play, Wifi, WifiOff, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DeviceCommandChip } from '@/components/dashboard/device-commands/command-chip';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { phaseOfKiosk } from '@/lib/deviceCommands';
import { trackCommand } from '@/lib/deviceCommandsStore';
import type { KioskCommandOut } from '@/lib/kioskApi';
import { cn } from '@/lib/utils';
import {
  EXTEND_BY,
  KIOSK_LOOK_BADGES,
  TARGET_LABELS,
  durationValid,
  formatLeft,
  formatUntil,
  kindLabel,
  levelLabel,
  parseHhmm,
  secondsLeft,
  targetOf,
  type DurationChoice,
} from '@/lib/liveControl';
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

/** The body of `kioskCommand` (POST /kiosks/{id}/commands). */
type KioskLiveCommand = Parameters<typeof kioskCommand>[1];

/** A pause / resume on its way: what was sent, and to which kiosk (fixed at the click). */
interface KioskLiveSend {
  kiosk: { machineId: string; name: string };
  body: KioskLiveCommand;
}

const KIOSK_LIVE_COMMAND_KEY = ['kiosk-live-command'] as const;
const SEND_FAILED: Record<KioskLiveCommand['action'], string> = { pause: 'העצירה נכשלה', resume: 'החידוש נכשל' };

/**
 * Pause / resume, fire-and-forget: each click is its own mutation (several kiosks at once are
 * fine). The answer is tracked in "פקודות שנשלחו" (which pops its own small notice and puts the
 * chip on the kiosk's row); a refusal or a failed call is an error toast. Nothing waits for the kiosk.
 */
function useKioskLiveCommand(onAnswered: () => void) {
  const command = useMutation({
    mutationKey: KIOSK_LIVE_COMMAND_KEY,
    mutationFn: ({ kiosk, body }: KioskLiveSend): Promise<KioskCommandOut> => kioskCommand(kiosk.machineId, body),
    onSuccess: (res, { kiosk, body }) => {
      if (res?.status === 'refused') {
        toast.error(`${kiosk.name}: ${res.detail || 'נדחה'}`);
      } else if (res?.id) {
        const p = phaseOfKiosk(res.status, res.detail);
        trackCommand({
          kind: 'kiosk',
          id: res.id,
          action: res.action ?? body.action,
          machineId: kiosk.machineId,
          machineName: kiosk.name,
          phase: p.phase,
          detail: p.detail,
        });
      }
      onAnswered();
    },
    onError: (e, { body }) => toast.error(axiosErrorToToastMessage(e, SEND_FAILED[body.action])),
  });
  const pending = useMutationState({
    filters: { mutationKey: KIOSK_LIVE_COMMAND_KEY, status: 'pending' },
    select: (m) => (m.state.variables as KioskLiveSend | undefined)?.kiosk.machineId,
  });
  return {
    send: (k: KioskLiveRow, body: KioskLiveCommand) => command.mutate({ kiosk: { machineId: k.machineId, name: k.name }, body }),
    /** Only this kiosk's own POST on its way (≈1 s) — never the kiosk's answer. */
    isSending: (machineId: string) => pending.includes(machineId),
  };
}

function PauseDialog({ kiosk, onSend, onClose }: { kiosk: KioskLiveRow; onSend: (k: KioskLiveRow, body: KioskLiveCommand) => void; onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'manual' | 'minutes' | 'time' | 'next_open'>('minutes');
  const [minutes, setMinutes] = useState<number>(15);
  const [at, setAt] = useState('');
  const ok = mode !== 'time' || parseHhmm(at) != null;
  // Sent in the background; the dialog closes at once (no waiting for the kiosk).
  const pause = () => {
    onSend(kiosk, {
      action: 'pause',
      message: message.trim() || undefined,
      untilMode: mode,
      minutes: mode === 'minutes' ? minutes : undefined,
      untilTime: mode === 'time' ? parseHhmm(at) ?? undefined : undefined,
    });
    onClose();
  };
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
          <Button onClick={pause} disabled={!ok} className="min-h-11">עצור</Button>
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
      // A hide is a block ("קיוסקים בלבד" + "הסתר"): "חסומים כעת" shows it too.
      qc.invalidateQueries({ queryKey: ['item-blocks'] });
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
          <p className="text-xs text-muted-foreground">נשמר כחסימה של כל קיוסקי הסניף (קיוסקים בלבד, &quot;הסתר&quot;) — הקופות ממשיכות למכור.</p>
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
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['kiosks'] });
    // The hides are blocks: "חסומים כעת" moves with them.
    qc.invalidateQueries({ queryKey: ['item-blocks'] });
  };
  const command = useKioskLiveCommand(() => void refresh());
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
  // A quick hide is per shop: the scope's, the only one the kiosks are in, or one picked here.
  const kioskShops = [...new Map(kiosks.filter((k) => k.shopId).map((k) => [k.shopId as string, k.shopName ?? ''])).entries()];
  const [hideShop, setHideShop] = useState<string | null>(null);
  const shopId = scope.shopId ?? (kioskShops.length === 1 ? kioskShops[0][0] : hideShop);

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
          const sending = command.isSending(k.machineId);
          return (
            <div key={k.machineId} className={cn('min-w-0 space-y-2 rounded-xl border bg-card p-3 shadow-sm', k.paused && 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20')}>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="font-medium">{k.name}</span>
                {k.online ? <Badge variant="outline" className="gap-1"><Wifi className="size-3" aria-hidden />מחובר</Badge> : <Badge variant="secondary" className="gap-1"><WifiOff className="size-3" aria-hidden />לא מחובר</Badge>}
                {k.paused ? <Badge variant="destructive">עצור{pausedLeft ? ` · ${pausedLeft}` : ''}</Badge> : <Badge variant="outline">פעיל</Badge>}
                {/* The last command sent to this kiosk and where it stands ("פקודות שנשלחו"). */}
                <DeviceCommandChip machineId={k.machineId} />
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
                  <Button size="sm" className="min-h-10 gap-1" disabled={sending} onClick={() => command.send(k, { action: 'resume' })}>
                    {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}חדש מכירה
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="min-h-10 gap-1" disabled={sending} onClick={() => setDialog({ kind: 'pause', kiosk: k })}>
                    {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Pause className="size-4" aria-hidden />}עצור
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
        {!scope.shopId && kioskShops.length > 1 ? (
          <select
            className="h-11 w-full rounded-lg border bg-background px-3 text-sm"
            value={hideShop ?? ''}
            onChange={(e) => setHideShop(e.target.value || null)}
            aria-label="סניף להסתרה"
          >
            <option value="">בחרו סניף להסתרה</option>
            {kioskShops.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
        {!shopId ? <p className="text-sm text-muted-foreground">בחרו סניף כדי להסתיר בקיוסקים שלו.</p> : null}
        <p className="text-xs text-muted-foreground">
          כל חסימה בתוקף שמגיעה לקיוסקים של הסניף. &quot;הסתר מוצר / מחלקה&quot; כאן = חסימה של קיוסקים בלבד עם &quot;הסתר&quot;.
        </p>
        {(live.data?.hides ?? []).length === 0 ? (
          <p className="rounded-xl border border-dashed p-3 text-center text-sm text-muted-foreground">אין הסתרות פעילות</p>
        ) : (
          <ul className="space-y-2">
            {(live.data?.hides ?? []).map((h) => {
              const left = formatLeft(secondsLeft(h.until, now));
              // A block of any level / target that reaches the kiosks: say which, when the server sends it.
              const reach = h.scope ? targetOf({ scope: h.scope, target: h.target }) : null;
              const where = h.scope ? levelLabel({ scope: h.scope, scopeName: h.scopeName ?? null, level: h.level }) : null;
              return (
                <li key={h.id} className="rounded-xl border bg-card p-3">
                  <div className="flex items-center gap-2">
                    {h.kioskDisplay === 'hide' || !h.blockKind ? (
                      <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    ) : h.blockKind === 'blocked' ? (
                      <Ban className="size-4 shrink-0 text-destructive" aria-hidden />
                    ) : (
                      <PackageX className="size-4 shrink-0 text-amber-600" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {h.kind === 'category' ? `מחלקה · ${h.itemName ?? ''}` : h.itemName}
                    </span>
                    <span className="shrink-0 text-sm">{h.until ? `עד ${formatUntil(h.until, now)}` : 'עד ביטול'}{left ? ` · ${left}` : ''}</span>
                  </div>
                  {h.blockKind || where || reach ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      {h.blockKind ? <Badge variant={h.blockKind === 'blocked' ? 'destructive' : 'secondary'}>{kindLabel(h.blockKind)}</Badge> : null}
                      {reach ? <Badge variant="outline">{TARGET_LABELS[reach]}</Badge> : null}
                      {h.kioskDisplay ? <Badge variant="outline">{KIOSK_LOOK_BADGES[h.kioskDisplay]}</Badge> : null}
                      {where ? <span className="text-muted-foreground">{where}</span> : null}
                    </div>
                  ) : null}
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

      {dialog?.kind === 'pause' ? <PauseDialog kiosk={dialog.kiosk} onSend={command.send} onClose={() => setDialog(null)} /> : null}
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
