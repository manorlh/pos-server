'use client';

/**
 * A shop Z that leaves tills behind — the `shopZOpenTills` till parameter.
 *
 * The shop's rule (resolved by the server at shop level: the shop's value, else its
 * company's, else the default) decides what happens when a shop Z would leave a till
 * with an open shift, or with closed shifts it does not take, outside the Z:
 *
 * * `block` — `POST /z-runs` answers 409 `open_tills_block_z` with the tills: every till
 *   has to be closed or included first.
 * * `confirm` — 409 `open_tills_need_confirmation` until the request carries
 *   `confirmOpenTills: true`; the tills and who confirmed are then frozen on the Z.
 *
 * A per-till Z (zScope = machine) is not subject to it.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Ban, Info } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import type { ZOpenTill, ZOpenTillsLeftOut } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type OpenTillsCode = 'open_tills_block_z' | 'open_tills_need_confirmation';

/** The 409 of a shop Z that leaves tills behind, or null for any other failure. */
export function openTillsRefusal(err: unknown): { code: OpenTillsCode; tills: ZOpenTill[] } | null {
  const res = (err as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
  if (res?.status !== 409) return null;
  const detail = res.data?.detail as { code?: unknown; tills?: unknown } | undefined;
  if (!detail || typeof detail !== 'object') return null;
  if (detail.code !== 'open_tills_block_z' && detail.code !== 'open_tills_need_confirmation') return null;
  return { code: detail.code, tills: Array.isArray(detail.tills) ? (detail.tills as ZOpenTill[]) : [] };
}

/** One shop's tills a run was refused over. */
export interface OpenTillsHold<R> {
  run: R;
  shopName: string;
  tills: ZOpenTill[];
}

function useTillName() {
  const t = useTranslations('zWizard');
  return (till: ZOpenTill) => {
    const numbered = till.posNumber ? t('tillNumbered', { number: till.posNumber }) : null;
    return [numbered, till.name].filter(Boolean).join(' · ') || till.id;
  };
}

/** The tills, each linking to its machine page (where it can be closed or looked at). */
export function OpenTillList({ tills }: { tills: ZOpenTill[] }) {
  const t = useTranslations('zWizard.openTills');
  const name = useTillName();
  return (
    <ul className="list-disc space-y-0.5 ps-6">
      {tills.map((till) => (
        <li key={till.id}>
          <Link href={`/dashboard/machines/${till.id}`} className="font-medium hover:underline">
            {name(till)}
          </Link>{' '}
          <span className="text-muted-foreground text-xs">
            ({till.openShiftId ? t('openShift') : t('closedOnly')})
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Before starting: which tills the current selection leaves behind, and what the rule will do. */
export function OpenTillsNotice({ rule, tills }: { rule: 'block' | 'confirm'; tills: ZOpenTill[] }) {
  const t = useTranslations('zWizard.openTills');
  if (tills.length === 0) return null;
  const block = rule === 'block';
  return (
    <div
      className={
        block
          ? 'space-y-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm'
          : 'space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950'
      }
    >
      <p className={block ? 'flex gap-2 font-medium text-destructive' : 'flex gap-2 font-medium'}>
        {block ? (
          <Ban className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
        )}
        {block ? t('noticeBlock', { count: tills.length }) : t('noticeConfirm', { count: tills.length })}
      </p>
      <OpenTillList tills={tills} />
      <p className="text-muted-foreground text-xs">{t('fixHint')}</p>
    </div>
  );
}

/** After a refused start: the shops whose rule requires every till to be closed first. */
export function OpenTillsBlocked<R>({ holds }: { holds: OpenTillsHold<R>[] }) {
  const t = useTranslations('zWizard.openTills');
  if (holds.length === 0) return null;
  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
      {holds.map((h) => (
        <div key={h.shopName} className="space-y-1">
          <p className="flex gap-2 font-medium text-destructive">
            <Ban className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
            {t('blockedTitle', { shop: h.shopName })}
          </p>
          <OpenTillList tills={h.tills} />
        </div>
      ))}
      <p className="text-muted-foreground text-xs">{t('fixHint')}</p>
    </div>
  );
}

/**
 * The operator's confirmation, required (a ticked box) before the runs are sent again
 * with `confirmOpenTills: true`. Mounted only while there is something to confirm, so
 * the box starts unticked every time.
 */
export function OpenTillsConfirmDialog<R>({
  holds,
  pending,
  onConfirm,
  onCancel,
}: {
  holds: OpenTillsHold<R>[];
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('zWizard.openTills');
  const tc = useTranslations('common');
  const [agreed, setAgreed] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('confirmTitle')}</DialogTitle>
          <p className="text-sm text-muted-foreground">{t('confirmIntro')}</p>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {holds.map((h) => (
            <div key={h.shopName} className="space-y-1">
              {holds.length > 1 ? <p className="font-medium">{h.shopName}</p> : null}
              <OpenTillList tills={h.tills} />
            </div>
          ))}
          <label className="flex items-start gap-2 rounded-md border p-2 pointer-coarse:min-h-10">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              required
            />
            <span>{t('confirmCheck')}</span>
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {tc('cancel')}
          </Button>
          <Button type="button" disabled={!agreed || pending} onClick={onConfirm}>
            {pending ? t('confirmGoing') : t('confirmGo')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** On a Z (and its run): the tills it was produced without, and who confirmed it. */
export function OpenTillsRecord({ left }: { left: ZOpenTillsLeftOut | null | undefined }) {
  const t = useTranslations('zWizard.openTills');
  if (!left || left.tills.length === 0) return null;
  const tills = left.tills.map((till) => till.posNumber || till.name || till.id).join(', ');
  return (
    <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
      <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
      <span>
        {left.confirmedByName
          ? t('record', { tills, by: left.confirmedByName })
          : t('recordNoWho', { tills })}
        {left.confirmedAt ? (
          <span className="text-muted-foreground text-xs"> · {formatDateTime(left.confirmedAt)}</span>
        ) : null}
      </span>
    </div>
  );
}
