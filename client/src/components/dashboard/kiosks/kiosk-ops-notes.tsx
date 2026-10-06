'use client';

/**
 * A kiosk's "התראות לקופות" open now and its last "סגירה יחד עם ה-Z הסניפי", for the kiosks
 * list and the kiosk's details (docs/SPEC_KIOSK.md §16; the server's kiosk_ops.py).
 */

import { useTranslations } from 'next-intl';
import { BellRing } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { KioskSummary } from '@/lib/kioskApi';

/** The open alerts as a small badge with their lines in the tooltip; nothing when none. */
export function KioskAlertsBadge({ k }: { k: KioskSummary }) {
  const t = useTranslations('kiosks.alerts');
  const alerts = k.alerts ?? [];
  if (alerts.length === 0) return null;
  const help = alerts.some((a) => a.kind === 'help');
  return (
    <span
      title={alerts.map((a) => a.text).join('\n')}
      className={cn(
        'inline-flex items-center gap-1 text-xs font-semibold',
        help ? 'text-blue-700 dark:text-blue-400' : 'text-amber-700 dark:text-amber-400',
      )}
    >
      <BellRing className="h-3.5 w-3.5" /> {t('open')} ({alerts.length})
    </span>
  );
}

/** The open alerts' lines and the last close with the shop's Z, for the details dialog. */
export function KioskOpsNotes({ k }: { k: KioskSummary }) {
  const t = useTranslations('kiosks.alerts');
  const alerts = k.alerts ?? [];
  const close = k.shopZClose ?? null;
  if (alerts.length === 0 && !close) return null;
  const closeText = close
    ? close.state === 'done' && close.zNumber != null
      ? t('shopZClose.doneZ', { number: close.zNumber })
      : t(`shopZClose.${close.state}`)
    : null;
  return (
    <div className="space-y-1.5 rounded-2xl border p-3 text-sm">
      {alerts.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">{t('open')}</div>
          {alerts.map((a) => (
            <div key={a.key} className={a.kind === 'help' ? 'text-blue-700 dark:text-blue-400' : 'text-amber-700 dark:text-amber-400'}>
              {a.text}
              {a.acknowledgedBy ? <span className="text-muted-foreground"> · {a.acknowledgedBy}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {closeText ? (
        <div className={cn(close?.state === 'done' ? 'text-green-700 dark:text-green-400' : close?.state === 'failed' || close?.state === 'expired' ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400')}>
          {closeText}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "אל תאפשר לקיוסק לעבוד עם מסוף לא תואם" (docs/SPEC_KIOSK.md §20): the terminal set for the
 * kiosk — counted only when set on the kiosk itself — beside the one it last reported, and
 * whether card payment is locked on the kiosk because of it.
 */
export function KioskTerminalIdentityNote({ k }: { k: KioskSummary }) {
  const t = useTranslations('kiosks.alerts.identity');
  const id = k.terminalIdentity;
  if (!id) return null;
  const own = id.expectedSource === 'machine' ? id.expected : null;
  const reported = [id.reportedNumber, id.reportedMerchant].filter(Boolean).join(' / ');
  return (
    <div className="space-y-1 rounded-2xl border p-3 text-sm">
      <div className="text-[11px] text-muted-foreground">{t('title')}</div>
      <div>
        {own
          ? t('expected', { number: own })
          : id.expected
            ? t('expectedInherited', { number: id.expected, source: id.expectedSource ?? '—' })
            : t('expectedNone')}
      </div>
      <div dir="auto">{reported ? t('reported', { terminal: reported }) : t('reportedNone')}</div>
      {id.cardLock ? (
        <div className="font-semibold text-red-600 dark:text-red-400">{t(`lock.${id.cardLock}`)}</div>
      ) : null}
    </div>
  );
}
