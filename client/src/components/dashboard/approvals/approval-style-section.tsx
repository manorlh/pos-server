'use client';

/**
 * "סגנון האישור" (P:\specs\table-restore-payments.md §4): for every till permission that may need
 * a manager, how the manager answers — "אישור מנהל" (the action stays the employee's), "מנהל
 * מבצע" (the manager does it as themselves, once) or "שניהם" (the till's sheet offers the two).
 * A "כל ההרשאות" row (`*`: every permission this level does not name) and one row per permission
 * by its till-roles group; each set here or inherited, showing the inherited value and its level.
 * The editing rules are lib/approvals.ts (`setStyle`, `resolveStyle`, `inheritedStyleSummary`).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import {
  STYLE_ALL,
  inheritedStyleSummary,
  ownStyle,
  ownStyleCount,
  resolveStyle,
  setStyle,
  styleCatalogOf,
  stylePermissionGroups,
  type ApprovalStyle,
  type PolicyDoc,
  type PolicyResponse,
} from '@/lib/approvals';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function ApprovalStyleSection({
  data,
  draft,
  readOnly,
  onChange,
  levelName,
}: {
  data: PolicyResponse;
  draft: PolicyDoc;
  readOnly: boolean;
  onChange: (update: (d: PolicyDoc) => PolicyDoc) => void;
  levelName: (source: string | null | undefined) => string;
}) {
  const t = useTranslations('approvals.style');
  const [open, setOpen] = useState(false);
  const catalog = styleCatalogOf(data.catalog);
  const codes = catalog.permissions.map((p) => p.code);
  if (!codes.length) return null;

  const styleText = (s: ApprovalStyle | null) => (s ? t(`options.${s}`) : t('mixed'));
  const all = ownStyle(draft, STYLE_ALL);
  const summary = inheritedStyleSummary(data, codes, catalog.default);
  const count = ownStyleCount(draft);
  const set = (code: string, style: ApprovalStyle | null) => onChange((d) => setStyle(d, code, style));

  return (
    <Card className="gap-3 p-4">
      <div>
        <h2 className="font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground text-xs">{t('hint')}</p>
      </div>

      <div className="space-y-1.5 rounded-lg border p-3">
        <p className="text-sm font-medium">{t('all')}</p>
        <p className="text-muted-foreground text-xs">{t('allHint')}</p>
        <StyleChoice
          options={catalog.options}
          value={all}
          disabled={readOnly}
          label={t('all')}
          onChange={(v) => set(STYLE_ALL, v)}
        />
        {all === null ? (
          <p className="text-muted-foreground text-xs">
            {summary.mixed
              ? t('inheritMixed')
              : t('inheritNote', { value: styleText(summary.style), source: levelName(summary.source) })}
          </p>
        ) : null}
      </div>

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-muted/50 flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-start text-sm font-medium"
      >
        <ChevronDown className={cn('size-4 shrink-0 transition-transform', !open && 'rotate-90')} aria-hidden />
        {t('perPermission')}
        {count ? <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs">{t('ownCount', { count })}</span> : null}
      </button>

      {open
        ? stylePermissionGroups(catalog.permissions).map((g) => (
            <section key={g.group || 'other'} className="space-y-1">
              <h3 className="text-muted-foreground text-xs font-semibold">
                {g.group && t.has(`groups.${g.group}`) ? t(`groups.${g.group}`) : g.group || t('groups.other')}
              </h3>
              <ul className="divide-y rounded-lg border">
                {g.permissions.map((p) => {
                  const r = resolveStyle(draft, data, p.code, catalog.default);
                  return (
                    <li
                      key={p.code}
                      className="grid gap-1.5 px-3 py-2 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] md:items-center md:gap-4"
                    >
                      <div className="min-w-0">
                        <p className="text-sm">{p.label}</p>
                        {r.from === 'inherited' ? (
                          <p className="text-muted-foreground text-xs">
                            {t('inheritNote', { value: styleText(r.style), source: levelName(r.source) })}
                          </p>
                        ) : r.from === 'ownAll' ? (
                          <p className="text-muted-foreground text-xs">{t('byAll', { value: styleText(r.style) })}</p>
                        ) : null}
                      </div>
                      <StyleChoice
                        options={catalog.options}
                        value={ownStyle(draft, p.code)}
                        disabled={readOnly}
                        label={p.label}
                        onChange={(v) => set(p.code, v)}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        : null}
    </Card>
  );
}

/** אישור מנהל / מנהל מבצע / שניהם / ירושה — `null` is inherit. */
function StyleChoice({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: ApprovalStyle[];
  value: ApprovalStyle | null;
  onChange: (value: ApprovalStyle | null) => void;
  label: string;
  disabled?: boolean;
}) {
  const t = useTranslations('approvals.style');
  const choices: Array<{ v: ApprovalStyle | null; label: string }> = [
    ...options.map((o) => ({ v: o, label: t(`options.${o}`) })),
    { v: null, label: t('inherit') },
  ];
  return (
    <div className="inline-flex w-full overflow-hidden rounded-md border text-xs" role="radiogroup" aria-label={label}>
      {choices.map((c) => (
        <button
          key={String(c.v)}
          type="button"
          role="radio"
          aria-checked={value === c.v}
          disabled={disabled}
          onClick={() => onChange(c.v)}
          className={cn(
            'min-h-9 flex-1 px-1.5 py-1.5 transition-colors disabled:cursor-not-allowed',
            value === c.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
