'use client';

/**
 * "הוחלפה קופה" — the till's device replacements, on its page (pos-server
 * docs/SPEC_OFFLINE_TILL_Z.md §4.6.2): when, who, why, the old and the new device, and
 * whether support produced the till's Z from the cloud first. Newest first.
 */

import { useTranslations } from 'next-intl';
import { formatDateTime } from '@/lib/format';
import type { TillReplacement } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function deviceText(d?: Record<string, unknown> | null): string {
  if (!d) return '—';
  const parts = [d.deviceModel, d.model, d.serialNumber ?? d.serial].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  return parts.length > 0 ? parts.join(' · ') : '—';
}

export function TillReplacements({ replacements }: { replacements?: TillReplacement[] | null }) {
  const t = useTranslations('tillReplaced');
  const rows = [...(replacements ?? [])].reverse();
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="space-y-0.5 border-b pb-2 last:border-b-0 last:pb-0">
              <p className="font-medium">
                {t('line', { at: formatDateTime(r.at), by: r.by ?? '—' })}
              </p>
              <p className="text-xs text-muted-foreground">{t('reason', { reason: r.reason ?? t('noReason') })}</p>
              <p className="text-xs">
                {t('devices', { old: deviceText(r.oldDevice), next: deviceText(r.newDevice) })}
              </p>
              <p className="text-xs">
                {r.supportZFirst
                  ? t('supportZFirst', { number: String(r.supportZ?.zNumber ?? '—') })
                  : t('noSupportZ')}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
