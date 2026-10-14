'use client';

/**
 * "תמיכה מרחוק" (pos-server app/routers/remote_support.py): the allowed QuickSupport signer — "נקבע
 * אוטומטית מהתקנה ראשונה (קופה X, תאריך)" with "אשר" and "החלף", and "השתמש כטביעת האצבע המותרת" from
 * a device's report. A super admin's; shown on the till parameters page and on the device page. The
 * rules and the Hebrew are lib/remoteSupport.ts.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  awaitsConfirmation,
  formatFingerprint,
  parseFingerprints,
  pinErrorText,
  pinNote,
  type SignerPin,
} from '@/lib/remoteSupport';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export const PIN_QUERY = 'remote-support-pin';

/** `GET /remote-support/signer-pin` — with `machineId`, that device against the pin it gets. */
export function useSignerPin(machineId?: string | null, enabled = true, refreshKey?: unknown) {
  return useQuery({
    queryKey: [PIN_QUERY, machineId ?? 'global', refreshKey ?? null],
    queryFn: async () => {
      const { data } = await api.get<SignerPin>('/remote-support/signer-pin', {
        params: machineId ? { machineId } : undefined,
      });
      return data;
    },
    enabled,
  });
}

function errorText(e: unknown, fallback: string): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return pinErrorText(detail) ?? axiosErrorToToastMessage(e, fallback);
}

/** After a change: the pin everywhere, and the parameter's page (its default is the pin). */
export function useRefreshPin(machineId?: string | null) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [PIN_QUERY] });
    void qc.invalidateQueries({ queryKey: ['till-parameters'] });
    void qc.invalidateQueries({ queryKey: ['till-parameter-values'] });
    if (machineId) void qc.invalidateQueries({ queryKey: ['machine', machineId] });
  };
}

export function FingerprintList({ values, className }: { values: string[]; className?: string }) {
  return (
    <div className={cn('space-y-1', className)}>
      {values.map((fp) => (
        <code key={fp} dir="ltr" className="block break-all rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs" title={fp}>
          {formatFingerprint(fp)}
        </code>
      ))}
    </div>
  );
}

function pinTitle(pin: SignerPin): string {
  const note = pinNote(pin, (iso) => formatDateTime(iso));
  if (note) return note;
  if (!pin.value.length) {
    return `עוד אין טביעת אצבע מותרת: היא תיקבע אוטומטית מההתקנה הראשונה מ-${pin.officialHost}.`;
  }
  if (pin.source === 'manual') {
    const by = pin.setBy ? ` ע״י ${pin.setBy}` : '';
    const at = pin.setAt ? `, ${formatDateTime(pin.setAt)}` : '';
    return `טביעת האצבע המותרת נקבעה ידנית${by}${at}`;
  }
  return 'טביעת האצבע המותרת';
}

/** The global pin: where it came from, its fingerprints, "אשר" while automatic, and "החלף". */
export function SignerPinNote({
  pin,
  machineId,
  className,
}: {
  pin: SignerPin | undefined;
  machineId?: string | null;
  className?: string;
}) {
  const [replacing, setReplacing] = useState(false);
  const refresh = useRefreshPin(machineId);
  const confirm = useMutation({
    mutationFn: async () => {
      const { data } = await api.post<SignerPin>('/remote-support/signer-pin/confirm', { value: pin?.value ?? [] });
      return data;
    },
    onSuccess: () => {
      toast.success('טביעת האצבע אושרה');
      refresh();
    },
    onError: (e) => toast.error(errorText(e, 'האישור נכשל')),
  });
  if (!pin) return null;
  const awaits = awaitsConfirmation(pin);
  return (
    <div
      className={cn(
        'space-y-2 rounded-md border p-3 text-sm',
        awaits ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950' : 'bg-muted/30',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{pinTitle(pin)}</p>
          {pin.value.length ? <FingerprintList values={pin.value} /> : null}
          {awaits ? (
            <p className="text-xs text-muted-foreground">
              בדקו שזו טביעת האצבע של TeamViewer ואשרו, או החליפו. מעכשיו כל קופה מתקינה רק QuickSupport שחתום בתעודה הזו.
            </p>
          ) : null}
          {!pin.active ? <p className="text-xs text-amber-700 dark:text-amber-300">הפרמטר כבוי: הקופות לא מקבלות אותו.</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {awaits ? (
          <Button size="sm" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
            {confirm.isPending ? <Loader2 className="me-1 h-4 w-4 animate-spin" aria-hidden /> : <Check className="me-1 h-4 w-4" aria-hidden />}
            אשר
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => setReplacing(true)}>
          {pin.value.length ? 'החלף' : 'הזן טביעת אצבע'}
        </Button>
      </div>
      {replacing ? (
        <ReplacePinDialog current={pin.value} onClose={() => setReplacing(false)} onDone={refresh} />
      ) : null}
    </div>
  );
}

/**
 * The parameters page's `remoteSupportSignerSha256`: its global value's origin and actions. Read again
 * whenever the parameter's default changes (the edit dialog writes the same value).
 */
export function GlobalSignerPin({ defaultValue }: { defaultValue: unknown }) {
  const { data } = useSignerPin(null, true, String(defaultValue ?? ''));
  return <SignerPinNote pin={data} className="mt-2" />;
}

/** "החלף": the fingerprint(s) typed or pasted — checked here as the server checks them. */
export function ReplacePinDialog({
  current,
  onClose,
  onDone,
}: {
  current: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState(current.join('\n'));
  const parsed = parseFingerprints(text);
  const save = useMutation({
    mutationFn: async () => {
      const { data } = await api.put<SignerPin>('/remote-support/signer-pin', { sha256: parsed.value });
      return data;
    },
    onSuccess: () => {
      toast.success('טביעת האצבע המותרת עודכנה');
      onDone();
      onClose();
    },
    onError: (e) => toast.error(errorText(e, 'השמירה נכשלה')),
  });
  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>החלפת טביעת האצבע המותרת של QuickSupport</DialogTitle>
          <DialogDescription>
            SHA-256 של תעודת החותם: 64 תווים הקסדצימליים לכל טביעה, עם נקודתיים או בלי. כמה טביעות: אחת בכל שורה
            או מופרדות בפסיק. חל על כל הקופות שלא נקבעה להן טביעה אחרת (בחברה, בסניף או בקופה).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="qs-pin" className="text-xs">
            טביעת אצבע
          </Label>
          <textarea
            id="qs-pin"
            dir="ltr"
            className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
          {text.trim() && parsed.error ? <p className="text-xs text-destructive">{parsed.error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            ביטול
          </Button>
          <Button disabled={!!parsed.error || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="me-1 h-4 w-4 animate-spin" aria-hidden /> : null}
            שמור
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "השתמש כטביעת האצבע המותרת": the device's reported fingerprint(s) become the global pin. */
export function UseAsPinDialog({
  machineId,
  machineName,
  fingerprints,
  onClose,
}: {
  machineId: string;
  machineName: string;
  fingerprints: string[];
  onClose: () => void;
}) {
  const refresh = useRefreshPin(machineId);
  const save = useMutation({
    mutationFn: async () => {
      const { data } = await api.put<SignerPin>('/remote-support/signer-pin', { fromMachineId: machineId });
      return data;
    },
    onSuccess: () => {
      toast.success('טביעת האצבע המותרת עודכנה');
      refresh();
      onClose();
    },
    onError: (e) => toast.error(errorText(e, 'השמירה נכשלה')),
  });
  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>השתמש כטביעת האצבע המותרת — {machineName}</DialogTitle>
          <DialogDescription>
            טביעת האצבע ש-QuickSupport במכשיר הזה דיווח עליה תהיה הטביעה המותרת לכל הקופות (שלא נקבעה להן טביעה אחרת).
            מאותו רגע הקופות מתקינות ומעדכנות רק QuickSupport שחתום בתעודה הזו. ודאו שזו התעודה של TeamViewer.
          </DialogDescription>
        </DialogHeader>
        <FingerprintList values={fingerprints} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            ביטול
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="me-1 h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="me-1 h-4 w-4" aria-hidden />}
            השתמש כטביעת האצבע המותרת
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
