'use client';

/**
 * "הדפסה" — how one kitchen screen / board prints (docs/SPEC_KDS.md §17, pos-server app/services/kds_print.py):
 * ללא הדפסה / דרך קופה בסניף (ללא התקנה) / גשר Windows (מותקן) / אפליקציית אנדרואיד (מובנה); through a till: which
 * till (or automatic) and which printer; "הדפסת בדיקה"; the how-to per device (iPad, Android tablet, Windows Chrome).
 * Saved on the screen itself (its till level of the parameters `kdsPrintPath` / `kdsPrintHost` / `kdsPrintPrinter`).
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Clock, Loader2, Printer, XCircle } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { errorCodeOf } from '@/lib/workflowMode';
import { getScreenPrint, saveScreenPrint, testScreenPrint, type KdsDevice, type KdsPrintCard, type KdsPrintTarget } from '@/lib/kdsApi';
import {
  KDS_DEVICE_LABELS,
  KDS_PRINT_HOW_TO,
  KDS_PRINT_PATHS,
  KDS_PRINT_PATH_HINTS,
  KDS_PRINT_PATH_LABELS,
  howToFor,
  jobPhase,
  jobText,
  relayLine,
  relayWhyText,
  type KdsPrintPath,
} from '@/lib/kdsPrint';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const AUTO = '__auto__';
const OWN = '__own__';

/** The table's cell: how the screen prints, one word. */
export function PrintCell({ device, onEdit, canEdit }: { device: KdsDevice; onEdit: () => void; canEdit: boolean }) {
  return (
    <Button size="sm" variant="ghost" className="h-8 gap-1 px-2" onClick={onEdit} disabled={!device.machineId} aria-label="הדפסה">
      <Printer className="h-4 w-4" /> {canEdit ? 'הדפסה' : 'הצגה'}
    </Button>
  );
}

function hostLabel(t: KdsPrintTarget): string {
  const bits = [t.hostName ?? '—'];
  if (t.sameArea) bits.push('באותה נקודת מכירה');
  if (t.printServer) bits.push('שרת ההדפסות');
  if (!t.online) bits.push('לא מחוברת');
  if (!t.allowed) bits.push('לא ברשימת הקופות המותרות');
  return bits.join(' · ');
}

export function ScreenPrintDialog({ shopId, device, onClose }: { shopId: string; device: KdsDevice; onClose: () => void }) {
  const machineId = device.machineId as string;
  const qc = useQueryClient();
  const key = ['kds-screen-print', shopId, machineId];
  const [testId, setTestId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: key,
    queryFn: () => getScreenPrint(shopId, machineId),
    // A test on its way: its answer.
    refetchInterval: (query) => {
      const data = query.state.data as KdsPrintCard | undefined;
      const test = testId ? data?.recentJobs.find((j) => j.id === testId) : null;
      return test && jobPhase(test) === 'waiting' ? 2_000 : false;
    },
  });
  const card = q.data;
  const [path, setPath] = useState<KdsPrintPath | null>(null);
  const [host, setHost] = useState<string>(AUTO);
  const [printer, setPrinter] = useState<string>(OWN);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!card || loaded) return;
    // The form starts from what the screen has (set here once, when the card first arrives).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPath(card.own.path);
    setHost(card.own.hostMachineId ?? AUTO);
    setPrinter(card.own.printerId ?? OWN);
    setLoaded(true);
  }, [card, loaded]);

  const hosts = useMemo(() => {
    const seen = new Map<string, KdsPrintTarget>();
    for (const t of card?.targets ?? []) if (!seen.has(t.hostMachineId)) seen.set(t.hostMachineId, t);
    return [...seen.values()];
  }, [card]);
  // The printers: the chosen till's (its own first), or every printer a bon may go to when automatic.
  const printers = useMemo(
    () => (card?.targets ?? []).filter((t) => t.printerId && (host === AUTO || t.hostMachineId === host)),
    [card, host],
  );

  const save = useMutation({
    mutationFn: () =>
      saveScreenPrint(shopId, machineId, {
        path,
        hostMachineId: path === 'relay' && host !== AUTO ? host : null,
        printerId: path === 'relay' && printer !== OWN ? printer : null,
      }),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      toast.success('ההגדרות נשמרו');
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, 'השמירה נכשלה')),
  });
  const test = useMutation({
    mutationFn: () => testScreenPrint(shopId, machineId),
    onSuccess: (job) => {
      setTestId(job.id);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err: unknown) => {
      const code = errorCodeOf(err);
      toast.error(code ? relayWhyText(code) : axiosErrorToToastMessage(err, 'ההדפסה נכשלה'));
    },
  });

  const canEdit = !!card?.canEdit;
  const status = card?.status ?? null;
  const devicePath = status?.devicePath ?? 'bridge';
  // Not set on the screen: as its shop / point of sale says (the card's effective value while unchanged), else by the device.
  const shownPath: KdsPrintPath = path ?? (card && card.own.path === null ? card.effective.path : 'device');
  const effective = shownPath === 'device' ? devicePath : shownPath;
  const dirty =
    !!card &&
    (path !== card.own.path ||
      (effective === 'relay' && ((host === AUTO ? null : host) !== card.own.hostMachineId || (printer === OWN ? null : printer) !== card.own.printerId)));
  const testJob = testId ? (card?.recentJobs.find((j) => j.id === testId) ?? null) : null;
  const kind = status?.deviceKind ?? null;
  const guides = useMemo(() => {
    const mine = howToFor(kind);
    const rest = Object.values(KDS_PRINT_HOW_TO).filter((h) => !mine.includes(h));
    return [...mine, ...rest];
  }, [kind]);

  const hostItems = [{ value: AUTO, label: 'אוטומטי (מומלץ)' }, ...hosts.map((t) => ({ value: t.hostMachineId, label: hostLabel(t) }))];
  const printerItems = [
    { value: OWN, label: host === AUTO ? 'לפי הקופה שנבחרה (המדפסת שלה)' : 'המדפסת של הקופה' },
    ...printers.map((t) => ({ value: t.printerId as string, label: t.local ? t.name : `${t.name} · ${t.hostName ?? ''}` })),
  ];

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>הדפסה — {device.name}</DialogTitle>
          <DialogDescription>
            איך המסך מדפיס בון. {kind ? `המכשיר: ${KDS_DEVICE_LABELS[kind]}.` : ''}
          </DialogDescription>
        </DialogHeader>

        {!card ? (
          <div className="flex justify-center p-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>איך המסך מדפיס</Label>
              <div role="radiogroup" aria-label="איך המסך מדפיס" className="grid gap-2 sm:grid-cols-2">
                {KDS_PRINT_PATHS.map((p) => {
                  const on = effective === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={!canEdit}
                      onClick={() => setPath(p)}
                      className={cn(
                        'min-h-11 rounded-lg border-2 px-3 py-2 text-start transition-colors disabled:cursor-default',
                        on ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        {KDS_PRINT_PATH_LABELS[p]}
                        {p === devicePath && path === null ? <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">ברירת מחדל</Badge> : null}
                      </span>
                      <span className="block text-xs text-muted-foreground">{KDS_PRINT_PATH_HINTS[p]}</span>
                    </button>
                  );
                })}
              </div>
              {canEdit && path !== null ? (
                <button type="button" className="text-xs text-primary hover:underline" onClick={() => setPath(null)}>
                  חזרה לברירת המחדל ({KDS_PRINT_PATH_LABELS[devicePath]}, או מה שנקבע לסניף)
                </button>
              ) : null}
              {kind === 'ipad' && effective !== 'relay' && effective !== 'none' ? (
                <p role="note" className="rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  {'באייפד אין גשר ואין אפליקציה — הוא מדפיס רק "דרך קופה בסניף".'}
                </p>
              ) : null}
            </div>

            {effective === 'relay' ? (
              <div className="space-y-3 rounded-lg border p-3">
                {!card.remotePrint.enabled ? (
                  <p role="note" className="rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                    {'"הדפסה בקופה אחרת" (remotePrintEnabled) כבויה למסך הזה — הפעילו אותה בהגדרות ההדפסה של הסניף.'}
                  </p>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>הקופה שמדפיסה</Label>
                    <Select value={host} onValueChange={(v) => { setHost(v ? String(v) : AUTO); setPrinter(OWN); }} items={hostItems} disabled={!canEdit}>
                      <SelectTrigger className="h-10" aria-label="הקופה שמדפיסה">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {hostItems.map((o) => (
                          <SelectItem key={o.value} value={o.value} label={o.label}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>המדפסת</Label>
                    <Select value={printer} onValueChange={(v) => setPrinter(v ? String(v) : OWN)} items={printerItems} disabled={!canEdit}>
                      <SelectTrigger className="h-10" aria-label="המדפסת">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {printerItems.map((o) => (
                          <SelectItem key={o.value} value={o.value} label={o.label}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  אוטומטי: קופה של אותה נקודת מכירה אם יש, אחרת של הסניף — שרת ההדפסות קודם, אחר כך קופה מחוברת עם מדפסת מובנית.
                  בון שלא נלקח תוך {card.remotePrint.timeoutSec} שניות מוצג במסך {'"לא הודפס — נסו שוב"'} ונרשם ב{'"בעיות"'}.
                </p>
                <div className={cn('rounded-md p-2 text-sm font-medium', status?.relay?.ready ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300')}>
                  {dirty ? 'שמרו כדי לראות לאן הבונים יגיעו' : relayLine(status)}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {effective === 'relay' ? (
                <Button variant="outline" size="sm" disabled={!canEdit || dirty || !status?.relay?.ready || test.isPending} onClick={() => test.mutate()}>
                  <Printer className="h-4 w-4" /> הדפסת בדיקה
                </Button>
              ) : effective === 'none' ? null : (
                <span className="text-xs text-muted-foreground">הדפסת בדיקה ב{effective === 'bridge' ? 'גשר' : 'אפליקציה'} — מהמכשיר עצמו (שש נגיעות בפינה ← הדפסה).</span>
              )}
              {testJob ? <JobLine phase={jobPhase(testJob)} text={jobText(jobPhase(testJob), testJob.targetMachineName, testJob.error)} /> : null}
            </div>

            {card.recentJobs.filter((j) => j.id !== testId).length > 0 ? (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">הדפסות אחרונות מהמסך</Label>
                {card.recentJobs
                  .filter((j) => j.id !== testId)
                  .map((j) => (
                    <JobLine key={j.id} phase={jobPhase(j)} text={`${j.test ? 'בדיקה · ' : ''}${jobText(jobPhase(j), j.targetMachineName, j.error)}`} />
                  ))}
              </div>
            ) : null}

            <details className="rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer font-medium">איך מגדירים — לפי סוג המכשיר</summary>
              {guides.map((h) => (
                <div key={h.title} className="mt-3 space-y-1">
                  <div className="font-medium">
                    {h.title} — מומלץ: {KDS_PRINT_PATH_LABELS[h.recommended]}
                  </div>
                  <ol className="list-decimal space-y-0.5 ps-5 text-muted-foreground">
                    {h.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </div>
              ))}
            </details>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            סגירה
          </Button>
          {canEdit ? (
            <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'שומר…' : 'שמירה'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JobLine({ phase, text }: { phase: ReturnType<typeof jobPhase>; text: string }) {
  const Icon = phase === 'done' ? CheckCircle2 : phase === 'failed' ? XCircle : Clock;
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm', phase === 'done' ? 'text-emerald-700' : phase === 'failed' ? 'text-red-700' : 'text-muted-foreground')}>
      <Icon className="h-4 w-4" /> {text}
    </span>
  );
}
