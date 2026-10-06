'use client';

/**
 * The "תצורת עבודה" card for one level (company / shop / point of sale / till):
 * the master switch, the default mode, the profiles, the fields relevant to the
 * chosen mode(s) — each saying whether it is set here or inherited — and, beside it,
 * the effective configuration the server computes for the unsaved changes (debounced
 * preview), with the §2 errors (blocking the save) and warnings.
 *
 * pos-server docs/SPEC_KDS.md §1–2, §8; the pure rules are in lib/workflowMode.ts.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, ChevronLeft, CircleAlert, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { previewWorkflow, saveWorkflow } from '@/lib/kdsApi';
import {
  INACTIVITY_MAX,
  INACTIVITY_MIN,
  MODES,
  PAYMENT_POLICIES,
  PROFILE_NAMES,
  SOURCES,
  applyProfile,
  chooseDefaultMode,
  currentValues,
  isSetHere,
  issueText,
  issuesFor,
  pendingChanges,
  profileOf,
  secondsFromInput,
  stepsFor,
  toggleMode,
  toggleTarget,
  visibleFields,
  visibleTargets,
  withFixes,
  workflowRejection,
  type WorkflowConfig,
  type WorkflowField,
  type WorkflowIssue,
  type WorkflowLevelView,
  type WorkflowModeName,
  type WorkflowValues,
} from '@/lib/workflowMode';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

/** `value`, once it has stopped changing for `ms` — so editing does not preview per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

type Rejection = { key: string; errors: WorkflowIssue[]; warnings: WorkflowIssue[] };

export function WorkflowEditor({
  view,
  onSaved,
}: {
  view: WorkflowLevelView;
  /** The level as saved (the PUT's answer). */
  onSaved: (next: WorkflowLevelView) => void;
}) {
  const t = useTranslations('kds.workflow');
  const tc = useTranslations('common');
  const { scopeType, scopeId } = view;

  const [draft, setDraft] = useState<WorkflowValues>({});
  // Remounts the inactivity inputs (their text is local) after a revert / discard.
  const [resetKey, setResetKey] = useState(0);
  const [rejected, setRejected] = useState<Rejection | null>(null);

  const changes = useMemo(() => pendingChanges(view.own, draft), [view.own, draft]);
  const changesKey = JSON.stringify(changes);
  const dirty = changesKey !== '{}';
  const current = useMemo(() => currentValues(view, draft), [view, draft]);

  const settledKey = useDebounced(changesKey, 350);
  const preview = useQuery({
    queryKey: ['workflow-preview', scopeType, scopeId, settledKey],
    queryFn: () => previewWorkflow({ scopeType, scopeId, values: JSON.parse(settledKey) as WorkflowValues }),
    enabled: settledKey !== '{}',
    placeholderData: keepPreviousData,
  });
  const shown: WorkflowLevelView = settledKey !== '{}' && preview.data ? preview.data : view;
  const computing = dirty && (settledKey !== changesKey || preview.isFetching);
  const serverRejection = rejected && rejected.key === changesKey ? rejected : null;
  const errors = serverRejection ? serverRejection.errors : shown.errors;
  const warnings = serverRejection ? serverRejection.warnings : shown.warnings;

  const save = useMutation({
    mutationFn: (values: WorkflowValues) => saveWorkflow({ scopeType, scopeId, values }),
    onSuccess: (next) => {
      toast.success(t('saved'));
      onSaved(next);
    },
    onError: (err: unknown, values) => {
      const refusal = workflowRejection(err);
      if (refusal) {
        setRejected({ key: JSON.stringify(values), ...refusal });
        toast.error(t('rejected'));
      } else {
        toast.error(axiosErrorToToastMessage(err, tc('error')));
      }
    },
  });

  const patch = (p: WorkflowValues) => setDraft((d) => ({ ...d, ...withFixes(view, d, p) }));
  const revert = (field: WorkflowField) => {
    patch({ [field]: null } as WorkflowValues);
    setResetKey((k) => k + 1);
  };
  const discard = () => {
    setDraft({});
    setRejected(null);
    setResetKey((k) => k + 1);
  };

  const visible = visibleFields(current, [...errors, ...warnings]);
  const shows = (f: WorkflowField) => visible.includes(f);
  const activeProfile = profileOf(current, view.profiles);
  const blocked = errors.length > 0;

  const label = (key: string, fallback: string) => (t.has(key) ? t(key) : fallback);
  const modeName = (m: string) => label(`modes.${m}.name`, m);

  const row = (field: WorkflowField) => ({
    field,
    setHere: isSetHere(field, view.own, draft),
    onRevert: () => revert(field),
    errors: issuesFor(field, errors),
    warnings: issuesFor(field, warnings),
  });

  const boolField = (field: WorkflowField) => (
    <FieldRow key={field} {...row(field)}>
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="space-y-1">
          <span className="block font-medium">{t(`fields.${field}.label`)}</span>
          <span className="block text-xs text-muted-foreground">{t(`fields.${field}.hint`)}</span>
        </span>
        <Switch
          checked={current[field] === true}
          onCheckedChange={(on) => patch({ [field]: on } as WorkflowValues)}
          aria-label={t(`fields.${field}.label`)}
        />
      </label>
    </FieldRow>
  );

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('cardTitle', { level: t(`levels.${scopeType}`) })}</CardTitle>
          <p className="text-xs text-muted-foreground">{t('cardHint')}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* The master switch. */}
          <FieldRow {...row('enabled')} prominent>
            <div className="space-y-3">
              <div className="font-semibold">{t('master')}</div>
              <Segmented
                value={current.enabled ? 'on' : 'off'}
                onChange={(v) => patch({ enabled: v === 'on' })}
                options={[
                  { value: 'off', label: t('masterOffLabel') },
                  { value: 'on', label: t('masterOnLabel') },
                ]}
                ariaLabel={t('master')}
              />
              <p className="text-sm text-muted-foreground">{current.enabled ? t('masterOn') : t('masterOff')}</p>
            </div>
          </FieldRow>

          {current.enabled ? (
            <>
              {/* The default mode: two big cards. */}
              <FieldRow {...row('defaultMode')}>
                <div className="space-y-3">
                  <div className="font-medium">{t('fields.defaultMode.label')}</div>
                  <div role="radiogroup" aria-label={t('fields.defaultMode.label')} className="grid gap-3 sm:grid-cols-2">
                    {MODES.map((mode) => {
                      const selected = current.defaultMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => patch(chooseDefaultMode(current, mode))}
                          className={cn(
                            'relative min-h-24 rounded-xl border-2 p-4 text-start transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                            selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                          )}
                        >
                          {selected ? (
                            <Check className="absolute end-3 top-3 h-5 w-5 text-primary" aria-hidden />
                          ) : null}
                          <p className="pe-7 text-sm leading-relaxed">
                            <span className="text-base font-semibold">{t(`modes.${mode}.name`)}</span>
                            {' — '}
                            {t(`modes.${mode}.desc`)}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('modeNote')}</p>
                </div>
              </FieldRow>

              {/* The steps of each allowed mode, the default first. */}
              <div className="space-y-2 rounded-lg border border-dashed p-4">
                {[current.defaultMode, ...current.allowedModes.filter((m) => m !== current.defaultMode)].map((mode) => (
                  <StepsLine
                    key={mode}
                    title={t('stepsTitle', { mode: modeName(mode) })}
                    steps={(shown.effective.steps?.[mode as WorkflowModeName] ?? stepsFor(mode as WorkflowModeName)).map(
                      (s) => label(`steps.${s}`, s),
                    )}
                  />
                ))}
              </div>

              {/* Profiles: a quick fill of the fields. */}
              <div className="space-y-2">
                <div className="font-medium">{t('profilesTitle')}</div>
                <div className="flex flex-wrap gap-2">
                  {PROFILE_NAMES.filter((p) => view.profiles[p]).map((name) => (
                    <Button
                      key={name}
                      type="button"
                      variant={activeProfile === name ? 'default' : 'outline'}
                      className="h-10 px-4"
                      onClick={() => patch(applyProfile(name, view.profiles, current))}
                    >
                      {activeProfile === name ? <Check className="h-4 w-4" aria-hidden /> : null}
                      {t(`profiles.${name}`)}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t('profilesHint')}</p>
              </div>

              {/* Allowed modes. */}
              <FieldRow {...row('allowedModes')}>
                <FieldTitle label={t('fields.allowedModes.label')} hint={t('fields.allowedModes.hint')} />
                <div className="flex flex-wrap gap-3">
                  {MODES.map((mode) => (
                    <CheckTile
                      key={mode}
                      checked={current.allowedModes.includes(mode)}
                      disabled={mode === current.defaultMode}
                      onChange={(on) => patch({ allowedModes: toggleMode(current, mode, on) })}
                      label={t(`modes.${mode}.name`)}
                    />
                  ))}
                </div>
              </FieldRow>

              {shows('workerCanSwitch') ? boolField('workerCanSwitch') : null}

              {/* The kind of till. */}
              <FieldRow {...row('source')}>
                <FieldTitle label={t('fields.source.label')} hint={t('fields.source.hint')} />
                <Segmented
                  value={current.source}
                  onChange={(v) => patch({ source: v as WorkflowConfig['source'] })}
                  options={SOURCES.map((s) => ({ value: s, label: t(`sources.${s}`) }))}
                  ariaLabel={t('fields.source.label')}
                />
              </FieldRow>

              {/* Targets. */}
              <FieldRow {...row('targets')}>
                <FieldTitle label={t('fields.targets.label')} hint={t('fields.targets.hint')} />
                <div className="grid gap-2 sm:grid-cols-2">
                  {visibleTargets(current).map((target) => {
                    const checked = current.targets.includes(target);
                    return (
                      <CheckTile
                        key={target}
                        checked={checked}
                        disabled={checked && current.targets.length === 1}
                        onChange={(on) => patch({ targets: toggleTarget(current.targets, target, on) })}
                        label={t(`targets.${target}.name`)}
                        hint={t(`targets.${target}.hint`)}
                      />
                    );
                  })}
                </div>
              </FieldRow>

              {shows('paymentPolicy') ? (
                <FieldRow {...row('paymentPolicy')}>
                  <FieldTitle label={t('fields.paymentPolicy.label')} hint={t('fields.paymentPolicy.hint')} />
                  <Segmented
                    value={current.paymentPolicy}
                    onChange={(v) => patch({ paymentPolicy: v as WorkflowConfig['paymentPolicy'] })}
                    options={PAYMENT_POLICIES.map((p) => ({ value: p, label: t(`policies.${p}`) }))}
                    ariaLabel={t('fields.paymentPolicy.label')}
                  />
                </FieldRow>
              ) : null}

              {(['requireStartPreparation', 'requireExpo', 'trackHandover', 'readyNotification', 'printerFallback'] as const)
                .filter(shows)
                .map(boolField)}
            </>
          ) : null}

          {/* Inactivity (§G) — applies whether the configuration is on or off. */}
          {(['inactivityTable', 'inactivityQuick', 'inactivityKiosk'] as const).some(shows) ? (
            <div className="space-y-3 rounded-lg border p-4">
              <FieldTitle label={t('inactivity.title')} hint={t('inactivity.hint', { min: INACTIVITY_MIN, max: INACTIVITY_MAX })} />
              <div className="grid gap-3 sm:grid-cols-3">
                {(['inactivityTable', 'inactivityQuick', 'inactivityKiosk'] as const).filter(shows).map((field) => {
                  const r = row(field);
                  const inherited = view.inherited[field];
                  return (
                    <div key={field} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <label htmlFor={`wf-${field}`} className="text-sm font-medium">
                          {t(`fields.${field}.label`)}
                        </label>
                        <SourceBadge setHere={r.setHere} onRevert={r.onRevert} compact />
                      </div>
                      <InactivityInput
                        key={`${field}:${resetKey}`}
                        id={`wf-${field}`}
                        initial={r.setHere ? current[field] : null}
                        placeholder={
                          inherited !== null && inherited !== undefined
                            ? t('inactivity.inheritedPlaceholder', { n: inherited })
                            : t('inactivity.off')
                        }
                        invalid={r.errors.length > 0}
                        onChange={(n) => patch({ [field]: n } as WorkflowValues)}
                      />
                      <p className="text-xs text-muted-foreground">{t(`fields.${field}.hint`)}</p>
                      <IssueList errors={r.errors} warnings={r.warnings} />
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Save. */}
          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button
              size="lg"
              className="h-11 px-6"
              disabled={!dirty || blocked || computing || save.isPending}
              onClick={() => save.mutate(changes)}
            >
              {save.isPending ? t('saving') : t('save')}
            </Button>
            <Button variant="outline" size="lg" className="h-11" disabled={!dirty || save.isPending} onClick={discard}>
              {t('discard')}
            </Button>
            <span className="text-sm text-muted-foreground">
              {!dirty
                ? t('noChanges')
                : blocked
                  ? t('saveBlocked')
                  : computing
                    ? t('computing')
                    : t('unsaved', { count: Object.keys(changes).length })}
            </span>
          </div>
        </CardContent>
      </Card>

      <EffectivePanel
        view={shown}
        errors={errors}
        warnings={warnings}
        computing={computing}
        failed={dirty && preview.isError}
      />
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────────

function FieldTitle({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <div className="font-medium">{label}</div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SourceBadge({ setHere, onRevert, compact }: { setHere: boolean; onRevert: () => void; compact?: boolean }) {
  const t = useTranslations('kds.workflow');
  if (!setHere) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {t('inherited')}
      </Badge>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <Badge variant="secondary">{t('setHere')}</Badge>
      <Button
        type="button"
        size={compact ? 'icon-sm' : 'sm'}
        variant="ghost"
        onClick={onRevert}
        aria-label={t('revert')}
        title={t('revert')}
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        {compact ? null : t('revert')}
      </Button>
    </span>
  );
}

function FieldRow({
  setHere,
  onRevert,
  errors,
  warnings,
  prominent,
  children,
}: {
  field: WorkflowField;
  setHere: boolean;
  onRevert: () => void;
  errors: WorkflowIssue[];
  warnings: WorkflowIssue[];
  prominent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'space-y-3 rounded-lg border p-4',
        prominent && 'bg-muted/30',
        errors.length > 0 && 'border-destructive/60',
        errors.length === 0 && warnings.length > 0 && 'border-amber-500/50',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-3">{children}</div>
        <SourceBadge setHere={setHere} onRevert={onRevert} />
      </div>
      <IssueList errors={errors} warnings={warnings} />
    </div>
  );
}

function IssueList({ errors, warnings, withField }: { errors: WorkflowIssue[]; warnings: WorkflowIssue[]; withField?: boolean }) {
  const t = useTranslations('kds');
  if (errors.length === 0 && warnings.length === 0) return null;
  const text = (i: WorkflowIssue) => t(`issues.${issueText(i.code)}`, { code: i.code });
  const field = (i: WorkflowIssue) =>
    withField && i.field && t.has(`workflow.fields.${i.field}.label`) ? t(`workflow.fields.${i.field}.label`) : null;
  return (
    <ul className="space-y-1.5">
      {errors.map((i, n) => (
        <li key={`e${n}`} role="alert" className="flex gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {field(i) ? <span className="font-medium">{field(i)}: </span> : null}
            {text(i)}
          </span>
        </li>
      ))}
      {warnings.map((i, n) => (
        <li key={`w${n}`} className="flex gap-2 text-sm text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {field(i) ? <span className="font-medium">{field(i)}: </span> : null}
            {text(i)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Segmented({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-11 min-w-24 rounded-lg border-2 px-4 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted/60',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function CheckTile({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label
      className={cn(
        'flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border-2 px-3 py-2.5 transition-colors',
        checked ? 'border-primary/70 bg-primary/5' : 'border-border hover:bg-muted/50',
        disabled && 'cursor-not-allowed opacity-80',
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

function StepsLine({ title, steps }: { title: string; steps: string[] }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <ol className="flex flex-wrap items-center gap-1.5">
        {steps.map((s, i) => (
          <li key={`${s}-${i}`} className="flex items-center gap-1.5">
            <span className="rounded-full bg-muted px-3 py-1 text-sm font-medium">{s}</span>
            {i < steps.length - 1 ? <ChevronLeft className="h-4 w-4 text-muted-foreground rtl:rotate-0 ltr:rotate-180" aria-hidden /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Seconds, or empty — the text stays local so clearing the box to retype does not jump to the inherited value. */
function InactivityInput({
  id,
  initial,
  placeholder,
  invalid,
  onChange,
}: {
  id: string;
  initial: number | null;
  placeholder: string;
  invalid: boolean;
  onChange: (seconds: number | null) => void;
}) {
  const [text, setText] = useState(initial === null || initial === undefined ? '' : String(initial));
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={INACTIVITY_MIN}
      max={INACTIVITY_MAX}
      step={1}
      dir="ltr"
      className="h-10 text-start"
      value={text}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        setText(e.target.value);
        onChange(secondsFromInput(e.target.value));
      }}
    />
  );
}

// ── The effective configuration ─────────────────────────────────────────────────

function EffectivePanel({
  view,
  errors,
  warnings,
  computing,
  failed,
}: {
  view: WorkflowLevelView;
  errors: WorkflowIssue[];
  warnings: WorkflowIssue[];
  computing: boolean;
  failed: boolean;
}) {
  const t = useTranslations('kds.workflow');
  const tc = useTranslations('common');
  const e = view.effective;
  const label = (key: string, fallback: string) => (t.has(key) ? t(key) : fallback);
  const yesNo = (v: boolean) => (v ? tc('yes') : tc('no'));
  const seconds = (n: number | null) => (n === null || n === undefined ? t('inactivity.off') : t('effective.seconds', { n }));

  const rows: [string, string][] = [
    [t('effective.status'), e.enabled ? t('effective.on') : t('effective.off')],
    [t('fields.defaultMode.label'), label(`modes.${e.defaultMode}.name`, e.defaultMode)],
    [t('fields.allowedModes.label'), (e.allowedModes ?? []).map((m) => label(`modes.${m}.name`, m)).join(' · ')],
    [t('fields.workerCanSwitch.label'), yesNo(e.workerCanSwitch)],
    [t('fields.source.label'), label(`sources.${e.source}`, e.source)],
    [t('fields.targets.label'), (e.targets ?? []).map((x) => label(`targets.${x}.name`, x)).join(' · ')],
    [t('fields.paymentPolicy.label'), label(`policies.${e.paymentPolicy}`, e.paymentPolicy)],
    [t('fields.requireStartPreparation.label'), yesNo(e.requireStartPreparation)],
    [t('fields.requireExpo.label'), yesNo(e.requireExpo)],
    [t('fields.trackHandover.label'), yesNo(e.trackHandover)],
    [t('fields.readyNotification.label'), yesNo(e.readyNotification)],
    [t('fields.printerFallback.label'), yesNo(e.printerFallback)],
    [t('fields.inactivityTable.label'), seconds(e.inactivityTable)],
    [t('fields.inactivityQuick.label'), seconds(e.inactivityQuick)],
    [t('fields.inactivityKiosk.label'), seconds(e.inactivityKiosk)],
  ];

  const devices = view.devices;

  return (
    <Card className="lg:sticky lg:top-4">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          {t('effective.title')}
          {computing ? (
            <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {t('computing')}
            </span>
          ) : null}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{t('effective.hint')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed ? <p className="text-sm text-destructive">{t('effective.failed')}</p> : null}

        <div className="flex flex-wrap gap-2">
          <Badge variant={e.enabled ? 'default' : 'outline'}>{e.enabled ? t('effective.on') : t('effective.off')}</Badge>
          <Badge variant="outline">
            {t('effective.profile')}: {e.profile ? label(`profiles.${e.profile}`, e.profile) : t('effective.custom')}
          </Badge>
          {e.kioskFulfillmentMode ? (
            <Badge variant="secondary">{t('effective.kiosk', { mode: e.kioskFulfillmentMode })}</Badge>
          ) : null}
        </div>

        <div className="text-sm">
          <span className="text-muted-foreground">{t('effective.version')}: </span>
          <span className="font-mono" dir="ltr">
            {e.configVersion}
          </span>
        </div>

        {!e.enabled ? <p className="text-xs text-muted-foreground">{t('effective.legacy')}</p> : null}

        <dl className="divide-y rounded-lg border text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 px-3 py-1.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-end font-medium">{v || '—'}</dd>
            </div>
          ))}
        </dl>

        <div className="space-y-1 text-sm">
          <div className="font-medium">{t('effective.devices')}</div>
          {devices ? (
            <p className="text-muted-foreground">
              {t('effective.deviceCounts', {
                station: devices.station ?? 0,
                expo: devices.expo ?? 0,
                pickup: devices.pickup ?? 0,
                manager: devices.manager ?? 0,
              })}
            </p>
          ) : (
            <p className="text-muted-foreground">{t('effective.devicesCompany')}</p>
          )}
        </div>

        <div className="space-y-2">
          {errors.length > 0 ? <div className="text-sm font-semibold text-destructive">{t('effective.errors')}</div> : null}
          {errors.length === 0 && warnings.length > 0 ? (
            <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">{t('effective.warnings')}</div>
          ) : null}
          {errors.length === 0 && warnings.length === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
              <Check className="h-4 w-4" aria-hidden />
              {t('effective.noIssues')}
            </p>
          ) : (
            <IssueList errors={errors} warnings={warnings} withField />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
