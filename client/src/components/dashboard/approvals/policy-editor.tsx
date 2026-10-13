'use client';

/**
 * The approval policy of one level (`GET/PUT /approvals/policy`): the master switch, then every
 * request type of the catalogue grouped by phase, each opening to every field of the catalogue.
 * A field is either inherited — its value and the level it comes from ("ברירת מחדל" when none) —
 * or set at this level ("קבע כאן"), and can go back to inherit. Nothing here names a type, a
 * field or a role: the catalogue does (owner: "הכל דינמי וניתן לשינוי").
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ChevronDown, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  ESCALATE_FIELD,
  REASONS_MAX,
  REASON_MAX_LENGTH,
  clearOwnType,
  draftFromPolicy,
  effectiveEnabled,
  effectiveValue,
  fieldRange,
  formatAmount,
  formatPercent,
  inheritedSource,
  inheritedValue,
  isOverridden,
  limitKeyOf,
  moveItem,
  overrideStart,
  overriddenCount,
  ownValue,
  policyBody,
  policyDirty,
  policyErrors,
  roleLabel,
  rolesForMaps,
  setOwnField,
  setRoleLimit,
  typesByPhase,
  type CatalogField,
  type CatalogRole,
  type CatalogType,
  type FieldError,
  type LimitUnit,
  type PolicyDoc,
  type PolicyResponse,
  type RoleLimit,
} from '@/lib/approvals';
import { saveApprovalPolicy } from '@/lib/approvalsApi';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { PolicyApproversCard, policyApproversKey } from './policy-approvers-card';

const NATIVE_SELECT =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

type T = ReturnType<typeof useTranslations>;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function optionLabel(t: T, field: string, option: string): string {
  if (field === 'methods' && t.has(`methods.${option}`)) return t(`methods.${option}`);
  return t.has(`options.${field}.${option}`) ? t(`options.${field}.${option}`) : option;
}

function limitText(unit: LimitUnit | null, v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  if (unit === 'percent') return formatPercent(n);
  if (unit === 'amount') return formatAmount(n);
  return String(n);
}

/** A value of any field kind as one line of text (the inherited value, the type's summary). */
function valueText(t: T, field: CatalogField, value: unknown, roles: CatalogRole[], unit: LimitUnit | null): string {
  if (value === null || value === undefined) return field.key === ESCALATE_FIELD ? t('escalationOff') : '—';
  switch (field.kind) {
    case 'bool':
      return value ? t('on') : t('off');
    case 'enum':
      return optionLabel(t, field.key, String(value));
    case 'int':
      return field.key === ESCALATE_FIELD && value === 0 ? t('escalationOff') : t('secondsValue', { n: String(value) });
    case 'methods':
      return asList(value).map((m) => optionLabel(t, 'methods', m)).join(', ') || '—';
    case 'roles':
      return asList(value).map((r) => roleLabel(roles, r)).join(', ') || t('none');
    case 'strings':
      return asList(value).join(' · ') || t('none');
    case 'roleLimits': {
      const key = limitKeyOf(unit);
      const parts = Object.entries(asRecord(value))
        .map(([role, lim]) => {
          const v = key ? asRecord(lim)[key] : undefined;
          return v === null || v === undefined ? null : `${roleLabel(roles, role)}: ${limitText(unit, v)}`;
        })
        .filter(Boolean);
      return parts.join(', ') || t('limits.none');
    }
    case 'roleBools': {
      const on = Object.entries(asRecord(value))
        .filter(([, v]) => v === true)
        .map(([role]) => roleLabel(roles, role));
      return on.join(', ') || t('none');
    }
    default:
      return JSON.stringify(value);
  }
}

function errorText(t: T, field: CatalogField, error: FieldError): string {
  switch (error) {
    case 'range': {
      const { min, max } = fieldRange(field);
      return t(field.key === ESCALATE_FIELD ? 'errors.escalation' : 'errors.range', { min: min ?? 0, max: max ?? 0 });
    }
    case 'tooMany':
      return t('errors.tooMany', { max: REASONS_MAX });
    case 'tooLong':
      return t('errors.tooLong', { max: REASON_MAX_LENGTH });
    default:
      return t(`errors.${error}`);
  }
}

export function PolicyEditor({ data }: { data: PolicyResponse }) {
  const t = useTranslations('approvals.settings');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const stored = useMemo(() => draftFromPolicy(data), [data]);
  const [draft, setDraft] = useState<PolicyDoc>(stored);
  // Bumped by "בטל שינויים": the boxes that keep their own text start again from the draft.
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const catalog = data.catalog;
  const readOnly = !data.canWrite;
  const errors = useMemo(() => policyErrors(draft, catalog.fields), [draft, catalog.fields]);
  const dirty = policyDirty(draft, data);
  const invalid = Object.keys(errors).length > 0;
  const levelName = (source: string | null | undefined) =>
    source && t.has(`levels.${source}`) ? t(`levels.${source}`) : source ? source : t('defaultSource');

  const save = useMutation({
    mutationFn: () => saveApprovalPolicy(data.level, data.id, policyBody(draft)),
    onSuccess: (next) => {
      toast.success(t('saved'));
      // The editor is keyed on the stored values: it starts again from what the server kept.
      qc.setQueryData(['approvals', 'policy', data.level, data.id], next);
      // Who receives the requests follows what was saved.
      void qc.invalidateQueries({ queryKey: policyApproversKey(data.level, data.id) });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const masterOn = effectiveEnabled(draft, data);

  return (
    <div className="space-y-4">
      <div className="bg-muted/40 rounded-lg border p-3 text-sm">
        {t('editingLevel', { level: levelName(data.level) })}
        {readOnly ? <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t('readOnly')}</p> : null}
      </div>

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold">{t('master')}</p>
            <p className="text-muted-foreground text-xs">{t('masterHint')}</p>
          </div>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              masterOn ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-muted text-muted-foreground',
            )}
          >
            {masterOn ? t('on') : t('off')}
          </span>
        </div>
        <div className="max-w-sm">
          <TriState
            value={draft.enabled}
            disabled={readOnly}
            onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
            labels={[t('on'), t('off'), t('inherit')]}
          />
        </div>
        {draft.enabled === null ? (
          <p className="text-muted-foreground text-xs">
            {t('inheritNote', { value: data.inherited.enabled ? t('on') : t('off'), source: levelName(data.inheritedSources.enabled) })}
          </p>
        ) : null}
      </Card>

      <PolicyApproversCard level={data.level} id={data.id} catalog={catalog} />

      {typesByPhase(catalog.types).map((group) => (
        <section key={group.phase} className="space-y-2">
          <div>
            <h2 className="text-base font-semibold">{t('phase', { n: group.phase })}</h2>
            {t.has(`phaseHints.${group.phase}`) ? (
              <p className="text-muted-foreground text-xs">{t(`phaseHints.${group.phase}`)}</p>
            ) : null}
          </div>
          <Card className="gap-0 overflow-hidden py-0">
            <ul className="divide-y">
              {group.types.map((type) => (
                <TypeRow
                  key={`${type.key}:${version}`}
                  type={type}
                  data={data}
                  draft={draft}
                  errors={errors}
                  readOnly={readOnly}
                  open={open.has(type.key)}
                  onToggle={() => toggleOpen(type.key)}
                  onChange={setDraft}
                  levelName={levelName}
                />
              ))}
            </ul>
          </Card>
        </section>
      ))}

      <div className="bg-background/95 sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t py-3">
        <Button onClick={() => save.mutate()} disabled={readOnly || !dirty || invalid || save.isPending}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
        <Button
          variant="outline"
          disabled={!dirty || save.isPending}
          onClick={() => {
            setDraft(stored);
            setVersion((v) => v + 1);
          }}
        >
          {t('discard')}
        </Button>
        {invalid ? <span className="text-destructive text-xs">{t('invalid')}</span> : null}
      </div>
    </div>
  );
}

function TypeRow({
  type,
  data,
  draft,
  errors,
  readOnly,
  open,
  onToggle,
  onChange,
  levelName,
}: {
  type: CatalogType;
  data: PolicyResponse;
  draft: PolicyDoc;
  errors: Record<string, FieldError>;
  readOnly: boolean;
  open: boolean;
  onToggle: () => void;
  onChange: (update: (d: PolicyDoc) => PolicyDoc) => void;
  levelName: (source: string | null | undefined) => string;
}) {
  const t = useTranslations('approvals.settings');
  const on = effectiveValue(draft, data, type.key, 'enabled') === true;
  const count = overriddenCount(draft, type.key);
  const hasError = Object.keys(errors).some((k) => k.startsWith(`${type.key}.`));
  const panelId = `approval-type-${type.key}`;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="hover:bg-muted/50 flex w-full items-start gap-3 px-4 py-3 text-start"
      >
        <ChevronDown className={cn('mt-1 size-4 shrink-0 transition-transform', !open && 'rotate-90')} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{type.label}</span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                on ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-muted text-muted-foreground',
              )}
            >
              {on ? t('on') : t('off')}
            </span>
            {count ? <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs">{t('overrides', { count })}</span> : null}
            {hasError ? <span className="text-destructive text-xs">{t('invalid')}</span> : null}
          </span>
          <span className="text-muted-foreground mt-0.5 block text-xs">
            {[type.sees ? t('sees', { sees: type.sees }) : null, t(`limitBy.${type.limitUnit ?? 'none'}`)].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
      {open ? (
        <div id={panelId} className="bg-muted/20 space-y-1 border-t px-4 py-3">
          {data.catalog.fields.map((field) =>
            field.kind === 'roleLimits' && !type.limitUnit ? null : (
              <FieldRow
                key={field.key}
                type={type}
                field={field}
                data={data}
                draft={draft}
                error={errors[`${type.key}.${field.key}`] ?? null}
                readOnly={readOnly}
                onChange={onChange}
                levelName={levelName}
              />
            ),
          )}
          {count && !readOnly ? (
            <div className="pt-2">
              <Button variant="ghost" size="sm" onClick={() => onChange((d) => clearOwnType(d, type.key))}>
                <RotateCcw className="size-3.5" aria-hidden />
                {t('clearType')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function FieldRow({
  type,
  field,
  data,
  draft,
  error,
  readOnly,
  onChange,
  levelName,
}: {
  type: CatalogType;
  field: CatalogField;
  data: PolicyResponse;
  draft: PolicyDoc;
  error: FieldError | null;
  readOnly: boolean;
  onChange: (update: (d: PolicyDoc) => PolicyDoc) => void;
  levelName: (source: string | null | undefined) => string;
}) {
  const t = useTranslations('approvals.settings');
  const roles = data.catalog.roles;
  const overridden = isOverridden(draft, type.key, field.key);
  const inherited = inheritedValue(data, type.key, field.key);
  const source = inheritedSource(data, type.key, field.key);
  const set = (value: unknown) => onChange((d) => setOwnField(d, type.key, field.key, value));
  const value = ownValue(draft, type.key, field.key);
  // The per-role maps list the roles that approve this type (as they apply with the draft).
  const approverRoles = effectiveValue(draft, data, type.key, 'approverRoles');

  return (
    <div className="grid gap-2 border-b py-2.5 last:border-0 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{field.label}</p>
        {overridden ? (
          <p className="text-primary text-xs">{t('setHereNote')}</p>
        ) : (
          <p className="text-muted-foreground text-xs">{t('inheritedFrom', { source: levelName(source) })}</p>
        )}
      </div>
      <div className="min-w-0 space-y-1.5">
        {overridden ? (
          <FieldInput
            field={field}
            type={type}
            value={value}
            roles={roles}
            approverRoles={approverRoles}
            disabled={readOnly}
            onChange={set}
          />
        ) : (
          <p className="text-sm break-words">{valueText(t, field, inherited, roles, type.limitUnit)}</p>
        )}
        {error ? <p className="text-destructive text-xs">{errorText(t, field, error)}</p> : null}
        {!readOnly ? (
          overridden ? (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => set(null)}>
              <RotateCcw className="size-3" aria-hidden />
              {t('inheritBtn', { value: valueText(t, field, inherited, roles, type.limitUnit), source: levelName(source) })}
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => set(overrideStart(field, inherited))}>
              {t('setHere')}
            </Button>
          )
        ) : null}
      </div>
    </div>
  );
}

function FieldInput({
  field,
  type,
  value,
  roles,
  approverRoles,
  disabled,
  onChange,
}: {
  field: CatalogField;
  type: CatalogType;
  value: unknown;
  roles: CatalogRole[];
  approverRoles: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations('approvals.settings');
  const id = `approval-${type.key}-${field.key}`;
  switch (field.kind) {
    case 'bool':
      return (
        <label className="flex items-center gap-2 text-sm" htmlFor={id}>
          <Switch id={id} checked={value === true} disabled={disabled} onCheckedChange={(v) => onChange(v)} />
          {value === true ? t('on') : t('off')}
        </label>
      );
    case 'enum':
      return (
        <select
          id={id}
          aria-label={field.label}
          className={cn(NATIVE_SELECT, 'max-w-xs')}
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {optionLabel(t, field.key, o)}
            </option>
          ))}
        </select>
      );
    case 'int':
      return <IntInput id={id} field={field} value={value} disabled={disabled} onChange={onChange} />;
    case 'methods': {
      const chosen = asList(value);
      return (
        <div className="flex flex-wrap gap-3">
          {(field.options ?? ['pin', 'remote']).map((o) => (
            <label key={o} className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary size-4"
                checked={chosen.includes(o)}
                disabled={disabled}
                onChange={() => onChange(chosen.includes(o) ? chosen.filter((x) => x !== o) : [...chosen, o])}
              />
              {optionLabel(t, 'methods', o)}
            </label>
          ))}
        </div>
      );
    }
    case 'roles':
      return <RolesPicker roles={roles} value={asList(value)} disabled={disabled} onChange={onChange} />;
    case 'strings':
      return <ReasonsEditor value={asList(value)} disabled={disabled} onChange={onChange} />;
    case 'roleLimits':
      return (
        <RoleLimitsEditor
          roles={roles}
          roleKeys={rolesForMaps(approverRoles, value)}
          unit={type.limitUnit}
          value={asRecord(value) as Record<string, RoleLimit>}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'roleBools': {
      const map = asRecord(value);
      const keys = rolesForMaps(approverRoles, value);
      if (!keys.length) return <p className="text-muted-foreground text-xs">{t('noRolesYet')}</p>;
      return (
        <div className="grid gap-1 sm:grid-cols-2">
          {keys.map((role) => (
            <label key={role} className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary size-4"
                checked={map[role] === true}
                disabled={disabled}
                onChange={(e) => onChange({ ...map, [role]: e.target.checked })}
              />
              {roleLabel(roles, role)}
            </label>
          ))}
        </div>
      );
    }
    default:
      return <p className="text-muted-foreground text-xs">{JSON.stringify(value)}</p>;
  }
}

/** Seconds; escalation also has "כבוי" (0 at this level). A box that is not a whole number stays as typed and is flagged. */
function IntInput({
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string;
  field: CatalogField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations('approvals.settings');
  const escalation = field.key === ESCALATE_FIELD;
  const off = escalation && value === 0;
  const parse = (text: string): unknown => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : text);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {escalation ? (
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={!off}
            disabled={disabled}
            onCheckedChange={(v) => onChange(v ? Math.max(field.min ?? 60, 60) : 0)}
            aria-label={field.label}
          />
          {off ? t('escalationOff') : t('escalationAfter')}
        </label>
      ) : null}
      {off ? null : (
        <span className="flex items-center gap-2 text-sm">
          <Input
            id={id}
            inputMode="numeric"
            className="h-9 w-28"
            value={value === null || value === undefined ? '' : String(value)}
            disabled={disabled}
            aria-label={field.label}
            onChange={(e) => onChange(parse(e.target.value))}
          />
          {t('seconds')}
        </span>
      )}
    </div>
  );
}

function RolesPicker({
  roles,
  value,
  disabled,
  onChange,
}: {
  roles: CatalogRole[];
  value: string[];
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations('approvals.settings');
  // A role in the value that the catalogue no longer has (a deleted custom role) still shows.
  const unknown = value.filter((k) => !roles.some((r) => r.key === k));
  const groups: Array<{ kind: string; items: Array<{ key: string; label: string }> }> = [
    { kind: 'till', items: roles.filter((r) => r.kind === 'till') },
    { kind: 'dash', items: roles.filter((r) => r.kind === 'dash') },
    { kind: 'other', items: unknown.map((k) => ({ key: k, label: k })) },
  ].filter((g) => g.items.length > 0);
  const toggle = (key: string) => onChange(value.includes(key) ? value.filter((x) => x !== key) : [...value, key]);
  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <fieldset key={g.kind} className="space-y-1">
          <legend className="text-muted-foreground text-xs">{t.has(`roleKinds.${g.kind}`) ? t(`roleKinds.${g.kind}`) : g.kind}</legend>
          <div className="grid gap-x-3 sm:grid-cols-2">
            {g.items.map((r) => (
              <label key={r.key} className="flex min-h-9 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary size-4"
                  checked={value.includes(r.key)}
                  disabled={disabled}
                  onChange={() => toggle(r.key)}
                />
                {r.label}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function LimitInput({
  initial,
  disabled,
  label,
  onChange,
}: {
  initial: string;
  disabled: boolean;
  label: string;
  onChange: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <Input
      inputMode="decimal"
      className="h-9 w-28"
      value={text}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}

function RoleLimitsEditor({
  roles,
  roleKeys,
  unit,
  value,
  disabled,
  onChange,
}: {
  roles: CatalogRole[];
  roleKeys: string[];
  unit: LimitUnit | null;
  value: Record<string, RoleLimit>;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const t = useTranslations('approvals.settings');
  const key = limitKeyOf(unit);
  if (!key) return null;
  if (!roleKeys.length) return <p className="text-muted-foreground text-xs">{t('noRolesYet')}</p>;
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground text-xs">{t('limits.hint')}</p>
      {roleKeys.map((role) => {
        const current = value[role]?.[key];
        return (
          <div key={role} className="flex flex-wrap items-center justify-between gap-2 sm:justify-start">
            <span className="min-w-36 text-sm">{roleLabel(roles, role)}</span>
            <span className="flex items-center gap-1.5 text-sm">
              <LimitInput
                initial={current === null || current === undefined ? '' : String(current)}
                disabled={disabled}
                label={`${roleLabel(roles, role)} — ${t(`limitBy.${unit}`)}`}
                onChange={(text) => onChange(setRoleLimit(value, role, key, text))}
              />
              <span className="text-muted-foreground">{t(`limits.unit.${unit}`)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The fixed reasons: add, remove, reorder; at most 20, each at most 60 characters. */
function ReasonsEditor({ value, disabled, onChange }: { value: string[]; disabled: boolean; onChange: (value: unknown) => void }) {
  const t = useTranslations('approvals.settings');
  const [adding, setAdding] = useState('');
  const full = value.length >= REASONS_MAX;
  const add = () => {
    const text = adding.trim();
    if (!text || full) return;
    onChange([...value, text.slice(0, REASON_MAX_LENGTH)]);
    setAdding('');
  };
  return (
    <div className="space-y-1.5">
      {value.length === 0 ? <p className="text-muted-foreground text-xs">{t('reasons.empty')}</p> : null}
      <ol className="space-y-1">
        {value.map((reason, i) => (
          <li key={i} className="flex items-center gap-1">
            <Input
              className="h-9 min-w-0 flex-1"
              value={reason}
              maxLength={REASON_MAX_LENGTH}
              disabled={disabled}
              aria-label={t('reasons.item', { n: i + 1 })}
              onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              disabled={disabled || i === 0}
              aria-label={t('reasons.up')}
              onClick={() => onChange(moveItem(value, i, i - 1))}
            >
              <ArrowUp className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              disabled={disabled || i === value.length - 1}
              aria-label={t('reasons.down')}
              onClick={() => onChange(moveItem(value, i, i + 1))}
            >
              <ArrowDown className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              disabled={disabled}
              aria-label={t('reasons.remove')}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Trash2 className="text-destructive size-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ol>
      {!disabled ? (
        <div className="flex items-center gap-1">
          <Input
            className="h-9 min-w-0 flex-1"
            value={adding}
            maxLength={REASON_MAX_LENGTH}
            placeholder={t('reasons.placeholder')}
            disabled={full}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button variant="outline" size="sm" className="h-9" disabled={full || !adding.trim()} onClick={add}>
            <Plus className="size-4" aria-hidden />
            {t('reasons.add')}
          </Button>
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">{t('reasons.count', { count: value.length, max: REASONS_MAX, length: REASON_MAX_LENGTH })}</p>
    </div>
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
    <div className="inline-flex w-full overflow-hidden rounded-md border text-sm" role="radiogroup">
      {choices.map((c) => (
        <button
          key={String(c.v)}
          type="button"
          role="radio"
          aria-checked={value === c.v}
          disabled={disabled}
          onClick={() => onChange(c.v)}
          className={cn(
            'min-h-9 flex-1 px-2 py-1.5 transition-colors disabled:cursor-not-allowed',
            value === c.v ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
