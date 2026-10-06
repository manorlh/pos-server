'use client';

/**
 * On an exception about a Z: the link to it (`details.zReportId`), and — for
 * `local_shop_z_mismatch` — what the main till printed beside the cloud's recomputation.
 * The printed Z is the Z (stored as printed, never corrected); the cloud's figures are an
 * internal check for support only.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import { mismatchRowsOf, zExceptionRefOf } from '@/lib/localShopZ';
import { discrepancyValue } from '@/lib/offlineZ';

export function ZExceptionLink({ details }: { details?: Record<string, unknown> | null }) {
  const t = useTranslations('independentTill.mismatch');
  const ref = zExceptionRefOf(details);
  if (!ref) return null;
  return (
    <Link
      href={`/dashboard/z-reports/${ref.zReportId}`}
      className="text-primary inline-flex items-center gap-1 hover:underline"
    >
      <ExternalLink className="size-3" />
      {ref.zNumber ? t('zLink', { n: ref.zNumber }) : t('zLinkNoNumber')}
    </Link>
  );
}

export function ZMismatchTable({ details }: { details?: Record<string, unknown> | null }) {
  const t = useTranslations('independentTill.mismatch');
  const tz = useTranslations('zReports');
  const rows = mismatchRowsOf(details);
  if (rows.length === 0) return null;
  const label = (field: string, key: string) => (tz.has(`offlineKeys.${field}`) ? tz(`offlineKeys.${field}`) : key);
  return (
    <table className="w-full max-w-xl text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="py-1 text-start font-normal">{t('key')}</th>
          <th className="py-1 text-end font-normal">{t('printed')}</th>
          <th className="py-1 text-end font-normal">{t('cloud')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t">
            <td className="py-1" title={r.key}>
              {label(r.field, r.key)}
            </td>
            <td className="py-1 text-end tabular-nums">{discrepancyValue(r.printed)}</td>
            <td className="py-1 text-end tabular-nums text-muted-foreground">{discrepancyValue(r.cloud)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
