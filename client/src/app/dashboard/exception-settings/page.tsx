'use client';

/**
 * Exception rules ("הגדרות חריגות"): per exception type, on/off and its thresholds, at
 * the organization, a company, a shop, a point of sale or a till. Pick the level with
 * the cascade; each field is set here or left to inherit, and the inherited value shows
 * what it is and which level above decided it (else the built-in default). The most
 * specific level wins, field by field. Saved rules apply to what is detected from then
 * on, and to a rescan on the exceptions page.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  fetchExceptionRules,
  saveExceptionRules,
  type ExceptionRule,
  type RuleInput,
  type RuleLevel,
  type RulesResponse,
} from '@/lib/exceptionsApi';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface DraftRule {
  enabled: boolean | null;
  /** Text as typed; '' = inherit. */
  params: Record<string, string>;
}
type Draft = Record<string, DraftRule>;

function draftOf(data: RulesResponse): Draft {
  const out: Draft = {};
  for (const r of data.rules) {
    out[r.type] = {
      enabled: r.ownEnabled,
      params: Object.fromEntries(
        r.params.map((p) => [p.key, r.ownParams[p.key] != null ? String(r.ownParams[p.key]) : '']),
      ),
    };
  }
  return out;
}

function paramError(rule: ExceptionRule, key: string, text: string): boolean {
  if (text.trim() === '') return false;
  const spec = rule.params.find((p) => p.key === key);
  const n = Number(text);
  if (!spec || !Number.isFinite(n)) return true;
  if (n < spec.min || n > spec.max) return true;
  return spec.integer && !Number.isInteger(n);
}

export default function ExceptionSettingsPage() {
  const t = useTranslations('exceptionSettings');
  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const target = deepestOrgScope(scope);
  const level = target?.level as RuleLevel | undefined;
  const entityId = target?.id ?? null;

  const { data, isLoading, isError } = useQuery<RulesResponse>({
    queryKey: ['exception-rules', level ?? null, entityId],
    queryFn: () => fetchExceptionRules(level as RuleLevel, entityId),
    enabled: !!level,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Link href="/dashboard/exceptions" className="text-primary text-sm hover:underline">
          {t('listLink')}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('scopeTitle')}</CardTitle>
          <p className="text-muted-foreground text-xs">{t('scopeHint')}</p>
        </CardHeader>
        <CardContent>
          <OrgScopeCascade value={scope} onChange={setScope} allowAll />
        </CardContent>
      </Card>

      {!level ? (
        <p className="text-muted-foreground text-sm">{t('chooseScope')}</p>
      ) : isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : isError || !data ? (
        <p className="text-destructive text-sm">{t('loadError')}</p>
      ) : (
        <RulesEditor key={`${level}:${entityId}:${JSON.stringify(data.rules.map((r) => [r.ownEnabled, r.ownParams]))}`} data={data} />
      )}
    </div>
  );
}

function RulesEditor({ data }: { data: RulesResponse }) {
  const t = useTranslations('exceptionSettings');
  const te = useTranslations('exceptions');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const stored = useMemo(() => draftOf(data), [data]);
  const [draft, setDraft] = useState<Draft>(stored);

  const dirtyTypes = data.rules
    .filter((r) => JSON.stringify(draft[r.type]) !== JSON.stringify(stored[r.type]))
    .map((r) => r.type);
  const invalid = data.rules.some((r) =>
    Object.entries(draft[r.type]?.params ?? {}).some(([k, v]) => paramError(r, k, v)),
  );

  const save = useMutation({
    mutationFn: () => {
      const rules: RuleInput[] = dirtyTypes.map((type) => {
        const d = draft[type];
        return {
          type,
          enabled: d.enabled,
          params: Object.fromEntries(
            Object.entries(d.params).map(([k, v]) => [k, v.trim() === '' ? null : Number(v)]),
          ),
        };
      });
      return saveExceptionRules(data.level, data.id, rules);
    },
    onSuccess: () => {
      toast.success(t('saved'));
      qc.invalidateQueries({ queryKey: ['exception-rules'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const levelName = (l: string | null | undefined) => (l ? t(`levels.${l}`) : t('defaultSource'));
  const set = (type: string, next: Partial<DraftRule>) =>
    setDraft((d) => ({ ...d, [type]: { ...d[type], ...next } }));

  return (
    <>
      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        {t('editingLevel', { level: t(`levels.${data.level}`) })}
        {!data.canWrite ? <p className="text-amber-600 dark:text-amber-400 mt-1 text-xs">{t('readOnly')}</p> : null}
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <ul className="divide-y">
          {data.rules.map((rule) => {
            const d = draft[rule.type];
            const effectiveOn = d.enabled ?? rule.inheritedEnabled;
            const disabled = !data.canWrite || !rule.available;
            return (
              <li
                key={rule.type}
                className={cn(
                  'grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_15rem_minmax(0,18rem)] md:items-start md:gap-4',
                  !rule.available && 'opacity-60',
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{te(`types.${rule.type}`)}</span>
                    {rule.available ? (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          effectiveOn
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {effectiveOn ? t('on') : t('off')}
                      </span>
                    ) : (
                      <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
                        {t('future')}
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">{t(`desc.${rule.type}`)}</p>
                </div>

                <div className="space-y-1">
                  <TriState
                    value={d.enabled}
                    disabled={disabled}
                    onChange={(v) => set(rule.type, { enabled: v })}
                    labels={[t('on'), t('off'), t('inherit')]}
                  />
                  {d.enabled === null ? (
                    <p className="text-muted-foreground text-xs">
                      {t('inheritNote', {
                        state: rule.inheritedEnabled ? t('on') : t('off'),
                        source: levelName(rule.inheritedSources.enabled),
                      })}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  {rule.params.length === 0 ? (
                    <p className="text-muted-foreground text-xs">{t('noThreshold')}</p>
                  ) : (
                    rule.params.map((p) => {
                      const text = d.params[p.key] ?? '';
                      const bad = paramError(rule, p.key, text);
                      return (
                        <div key={p.key} className="space-y-0.5">
                          <label className="text-xs font-medium" htmlFor={`${rule.type}-${p.key}`}>
                            {t(`params.${p.key}`)}
                          </label>
                          <Input
                            id={`${rule.type}-${p.key}`}
                            inputMode="decimal"
                            value={text}
                            disabled={disabled}
                            aria-invalid={bad}
                            className={cn(bad && 'border-destructive')}
                            placeholder={String(rule.inheritedParams[p.key] ?? p.default)}
                            onChange={(e) =>
                              set(rule.type, { params: { ...d.params, [p.key]: e.target.value } })
                            }
                          />
                          {text.trim() === '' ? (
                            <p className="text-muted-foreground text-xs">
                              {t('inheritValue', {
                                value: rule.inheritedParams[p.key] ?? p.default,
                                source: levelName(rule.inheritedSources[p.key]),
                              })}
                            </p>
                          ) : bad ? (
                            <p className="text-destructive text-xs">
                              {t('range', { min: p.min, max: p.max })}
                            </p>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="flex gap-2">
        <Button
          onClick={() => save.mutate()}
          disabled={!data.canWrite || dirtyTypes.length === 0 || invalid || save.isPending}
        >
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
        <Button variant="outline" disabled={dirtyTypes.length === 0 || save.isPending} onClick={() => setDraft(stored)}>
          {t('discard')}
        </Button>
      </div>
    </>
  );
}

/** On / off / inherit — `null` is inherit. */
function TriState({
  value,
  onChange,
  labels,
  disabled,
}: {
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  labels: [string, string, string];
  disabled?: boolean;
}) {
  const choices: Array<{ v: boolean | null; label: string }> = [
    { v: true, label: labels[0] },
    { v: false, label: labels[1] },
    { v: null, label: labels[2] },
  ];
  return (
    <div className="inline-flex w-full overflow-hidden rounded-md border text-xs" role="radiogroup">
      {choices.map((c) => (
        <button
          key={String(c.v)}
          type="button"
          role="radio"
          aria-checked={value === c.v}
          disabled={disabled}
          onClick={() => onChange(c.v)}
          className={cn(
            'flex-1 px-2 py-1.5 transition-colors disabled:cursor-not-allowed',
            value === c.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
