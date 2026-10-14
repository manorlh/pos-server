'use client';

/**
 * The web till's sign-in blocked by "עובד מחובר בקופה אחת בלבד" (exclusive login v2 §6), as the
 * APK's dialog: "דנה מחובר/ת כרגע בקופה 3 (בר) מאז 14:05", "המכשיר הקודם לא מדווח מאז 14:20" when
 * that device went silent, and the two ways out —
 *
 * * "שחרור באישור מנהל": a manager types their own code (the till's manager-code sheet, scope
 *   `user-session:release`), then `UserSessionGuard.claim(posUserId, { elevationToken })`; a manager
 *   signing in themselves releases with `{ operatorId }` and never sees this;
 * * "בקשת שחרור ממנהל" (only when the phone approvals offer `user_release` with `remote`): the
 *   request to the phone, then the same claim with the approval's `grantId`.
 *
 * The texts and the decisions are lib/exclusiveLogin.ts (tested there); this only lays them out.
 */

import { Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { TEXTS, blockedText, silentText, type Holder } from '@/lib/exclusiveLogin';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface UserSessionBlockedDialogProps {
  /** Who was blocked and where they are signed in (null: closed). */
  holder: Holder | null;
  /** The employee as the till knows them, when the cloud's answer has no name. */
  employeeName: string;
  /** "בקשת שחרור ממנהל" is on for this till. */
  offerRemote: boolean;
  /** A claim with an approval is on its way. */
  busy?: boolean;
  /** A refusal to show under the text ("האישור לא מתיר שחרור עובד בקופה הזו"). */
  error?: string | null;
  onManagerCode: () => void;
  onRemoteRequest: () => void;
  onClose: () => void;
}

export function UserSessionBlockedDialog({
  holder,
  employeeName,
  offerRemote,
  busy = false,
  error = null,
  onManagerCode,
  onRemoteRequest,
  onClose,
}: UserSessionBlockedDialogProps) {
  const silent = holder ? silentText(holder) : null;
  return (
    <Dialog open={holder !== null} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{TEXTS.title}</DialogTitle>
          <DialogDescription className="text-base text-foreground">
            {holder ? blockedText(holder, employeeName) : null}
          </DialogDescription>
        </DialogHeader>
        {silent ? <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">{silent}</p> : null}
        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button size="lg" className="h-12 w-full" disabled={busy} onClick={onManagerCode}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ShieldCheck className="size-4" aria-hidden />}
            {TEXTS.releaseWithCode}
          </Button>
          {offerRemote ? (
            <Button size="lg" variant="outline" className="h-12 w-full" disabled={busy} onClick={onRemoteRequest}>
              <Smartphone className="size-4" aria-hidden />
              {TEXTS.requestFromPhone}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
