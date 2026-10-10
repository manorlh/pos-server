'use client';

/**
 * The state of the tills a Z from the cloud takes, shown before it is made, with the
 * explicit confirmation (pos-server docs/SPEC_OFFLINE_TILL_Z.md §4.6.1): open shifts, tills
 * not seen and when, documents and Zs the till reported unsent. Used by support's Z and by
 * the Z wizard's cloud run.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import { numberRanges } from '@/lib/supportZ';
import { flaggedTills, offSyncedTills, tillLabel, type TillDataState } from '@/lib/zDataState';

export function ZDataStateWarning({ tills }: { tills: readonly (TillDataState | null | undefined)[] }) {
  const t = useTranslations('zDataState');
  const flagged = flaggedTills(tills);
  const off = offSyncedTills(tills);
  return (
    <>
      {/* Off for the night, closed and fully synced: listed, nothing to confirm. */}
      {off.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {off.map((s) => (
            <li key={s.machineId}>
              {t('till', { till: tillLabel(s) })} · {t('offSynced')}
              {s.lastHeartbeatAt ? ` · ${t('lastSeen', { at: formatDateTime(s.lastHeartbeatAt) })}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {flagged.length > 0 ? <FlaggedTills flagged={flagged} /> : null}
    </>
  );
}

function FlaggedTills({ flagged }: { flagged: TillDataState[] }) {
  const t = useTranslations('zDataState');
  return (
    <div className="space-y-2 rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
      <p className="flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        {t('title')}
      </p>
      <p className="text-xs text-amber-900/80 dark:text-amber-200/80">{t('explain')}</p>
      <ul className="space-y-2">
        {flagged.map((s) => (
          <li key={s.machineId} className="space-y-0.5">
            <p className="font-medium">
              {t('till', { till: tillLabel(s) })} ·{' '}
              {s.lastHeartbeatAt ? t('lastSeen', { at: formatDateTime(s.lastHeartbeatAt) }) : t('neverSeen')}
            </p>
            <ul className="list-disc ps-5 text-xs">
              {s.warnings.includes('open_shifts') ? (
                <li>
                  {t('openShifts', { count: s.openShifts.length || (s.tillReportedOpenShiftId ? 1 : 0) })}
                  {s.openShifts.length > 0
                    ? ` (${s.openShifts
                        .map((o) => (o.openedAt ? `#${o.sequenceNumber ?? '—'} ${formatDateTime(o.openedAt)}` : `#${o.sequenceNumber ?? '—'}`))
                        .join(', ')})`
                    : ''}
                  {s.tillReportedOpenShiftId ? ` · ${t('tillReportedOpen')}` : ''}
                </li>
              ) : null}
              {s.warnings.includes('not_synced') ? <li>{t('notSynced')}</li> : null}
              {s.warnings.includes('unsynced_documents') ? (
                <li>
                  {t('unsynced', { documents: s.unsyncedDocuments ?? 0, items: s.unsyncedItems ?? 0 })}
                  {s.unsyncedAt ? ` · ${t('reportedAt', { at: formatDateTime(s.unsyncedAt) })}` : ''}
                </li>
              ) : null}
              {s.warnings.includes('offline_zs') ? (
                <li>
                  {s.offlineZs.numbers.length > 0
                    ? t('offlineZsNumbers', { count: s.offlineZs.pending, numbers: numberRanges(s.offlineZs.numbers) })
                    : t('offlineZs', { count: s.offlineZs.pending })}
                  {s.offlineZs.conflict ? ` · ${t('offlineConflict')}` : ''}
                </li>
              ) : null}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "אני מאשר שהנתונים בענן הם הנתונים הקיימים". */
export function CloudDataConfirm({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('zDataState');
  return (
    <label className="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {t('confirm')}
    </label>
  );
}
