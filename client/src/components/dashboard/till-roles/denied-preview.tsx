'use client';

/**
 * "מה יראה מלצר" (P:/specs/denied-actions-ui.md §5): for the role chosen — the waiter by default — which of the
 * till's options it does not see, which ask a manager's code, and which are shown with "אין הרשאה" on tap. Reads
 * the matrix as it is now (unsaved edits included), the role's "כשאין הרשאה", and — where the role inherits — the
 * level's (the shop in scope, else the company). The rule itself: lib/deniedPreview.ts.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { deniedPreview, effectiveDeniedUi, legacyHides, type TillEntry } from '@/lib/deniedPreview';
import type { DeniedUi, MatrixDraft, TillRole } from '@/lib/tillRoles';
import { fetchDrawerParamsLevel } from '@/lib/tillRolesApi';
import { SELECT } from './role-dialogs';

function EntryList({ title, entries, none, tone }: { title: string; entries: TillEntry[]; none: string; tone: string }) {
  return (
    <div className="min-w-[14rem] flex-1 space-y-1">
      <div className={`text-xs font-semibold ${tone}`}>{title}</div>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{none}</p>
      ) : (
        <ul className="space-y-0.5 text-sm">
          {entries.map((e) => (
            <li key={e.key}>
              {e.label} <span className="text-xs text-muted-foreground">· {e.where}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DeniedPreviewCard({
  companyId,
  shopId,
  roles,
  draft,
}: {
  companyId: string;
  shopId?: string | null;
  roles: TillRole[];
  draft: MatrixDraft;
}) {
  const t = useTranslations('tillRoles');
  const waiter = roles.find((r) => r.builtinKey === 'waiter') ?? roles[0];
  const [roleId, setRoleId] = useState<string>(waiter?.id ?? '');
  const scopeType: 'company' | 'shop' = shopId ? 'shop' : 'company';
  const scopeId = shopId ?? companyId;
  const level = useQuery({
    queryKey: ['till-drawer-params', companyId, scopeType, scopeId],
    queryFn: () => fetchDrawerParamsLevel(companyId, scopeType, scopeId),
  });
  const role = roles.find((r) => r.id === roleId) ?? waiter;
  if (!role) return null;

  const levelValue = (key: string): unknown => {
    const d = level.data;
    if (!d) return undefined;
    return key in (d.own ?? {}) ? d.own[key] : d.inherited?.[key];
  };
  const own = draft.deniedUi && role.id in draft.deniedUi ? draft.deniedUi[role.id] : (role.deniedUi ?? null);
  const mode = effectiveDeniedUi(own, levelValue('deniedActionUi'));
  const preview = deniedPreview(
    { ...role.permissions, ...(draft.states[role.id] ?? {}) },
    mode,
    legacyHides(levelValue('permissionsDeniedUi')),
  );
  const modeLabel = (m: DeniedUi) => (m === 'hide' ? t('deniedUiHide') : m === 'code' ? t('deniedUiCode') : t('deniedUiShow'));
  const levelLabel = scopeType === 'shop' ? t('previewLevelShop') : t('previewLevelCompany');

  return (
    <details className="rounded-lg border bg-card p-3">
      <summary className="cursor-pointer text-sm font-medium">{t('previewTitle', { role: role.name })}</summary>
      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            {t('previewRole')}
            <select
              className={`${SELECT} w-44`}
              aria-label={t('previewRole')}
              value={role.id}
              onChange={(e) => setRoleId(e.target.value)}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <span className="text-sm text-muted-foreground">
            {t('previewMode', {
              mode: own ? modeLabel(mode) : t('previewModeFromLevel', { mode: modeLabel(mode), level: levelLabel }),
            })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{t('previewHint', { level: levelLabel })}</p>
        <div className="flex flex-wrap gap-4">
          <EntryList title={t('previewHidden', { count: preview.hidden.length })} entries={preview.hidden} none={t('previewNone')} tone="text-destructive" />
          <EntryList title={t('previewCode', { count: preview.code.length })} entries={preview.code} none={t('previewNone')} tone="text-amber-700 dark:text-amber-400" />
          <EntryList title={t('previewDenied', { count: preview.denied.length })} entries={preview.denied} none={t('previewNone')} tone="text-muted-foreground" />
        </div>
      </div>
    </details>
  );
}
