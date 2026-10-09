'use client';

/**
 * "התראות SMS על חריגות" — the SMS alert rules of a company or one of its shops
 * (`/exception-alerts`): which exception kinds, from which amount / percent, "N in M
 * minutes", to whom (Israeli mobiles, optionally linked to a dashboard user), quiet hours,
 * at most one message per window with a digest afterwards, on/off — and "שליחת הודעת
 * בדיקה" through the active provider. In development the provider is a dry run: nothing is
 * sent, and the banner says so. Every attempt is in "יומן חריגות"; every change to a rule
 * is in its history.
 *
 * Who: like the other settings pages — the company's rules for super admin / distributor /
 * company manager, a shop's rules also for that shop's manager (the server decides,
 * `canWrite`).
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, ChevronDown, ChevronUp, FlaskConical, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { usePageScope, useScope } from '@/lib/scope';
import type { UserRole } from '@/lib/types';
import {
  COUNT_SCOPES,
  SEVERITIES,
  dispatchTone,
  draftFromRule,
  emptyDraft,
  quietHoursText,
  thresholdsApply,
  validateDraft,
  type AlertRule,
  type DraftErrors,
  type LogKind,
  type ProviderInfo,
  type RuleDraft,
} from '@/lib/exceptionAlerts';
import {
  createAlertRule,
  deleteAlertRule,
  fetchAlertRules,
  fetchAlertUsers,
  fetchLogKinds,
  fetchRuleChanges,
  fetchRuleDispatches,
  sendAlertTest,
  updateAlertRule,
} from '@/lib/exceptionAlertsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const ALLOWED: UserRole[] = ['super_admin', 'distributor', 'merchant_admin', 'company_manager', 'shop_manager'];

const TONE_CLASS = {
  ok: 'text-emerald-700 dark:text-emerald-300',
  muted: 'text-slate-600 dark:text-slate-300',
  warn: 'text-amber-700 dark:text-amber-300',
  error: 'text-red-700 dark:text-red-300',
} as const;

/** The server's 422 `{code, field}` (or a plain code) → the Hebrew line. */
function useRuleErrorText() {
  const t = useTranslations('exceptionAlerts');
  const tc = useTranslations('common');
  return (err: unknown): string => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    const code = typeof detail === 'string' ? detail : (detail as { code?: string } | undefined)?.code;
    if (code && t.has(`errors.${code}`)) return t(`errors.${code}`);
    return axiosErrorToToastMessage(err, tc('error'));
  };
}

export default function ExceptionAlertsPage() {
  const t = useTranslations('exceptionAlerts');
  const role = useAuth((s) => s.user?.role);
  const authHydrated = useAuth((s) => s.authHydrated);
  const { resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'company' });
  const allowed = !!role && ALLOWED.includes(role);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <BellRing className="size-6" />
            {t('title')}
          </h1>
          <p className="text-muted-foreground max-w-3xl text-sm">{t('subtitle')}</p>
        </div>
        <Link href="/dashboard/exceptions-log" className="text-primary text-sm hover:underline">
          {t('logLink')}
        </Link>
      </div>
      {/* feat/event-live: the phone (push) channel — personal, set on "התראות". */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 text-sm">
        <span>
          <span className="font-semibold">{t('pushChannel')}</span> <span className="text-muted-foreground">{t('pushChannelHint')}</span>
        </span>
        <Link href="/dashboard/alerts" className="text-primary hover:underline">
          {t('pushChannelLink')}
        </Link>
      </div>
      {authHydrated && !allowed ? (
        <p className="text-muted-foreground text-sm">{t('noPermission')}</p>
      ) : (
        <ScopeGate resolution={resolution}>
          {effective.companyId ? (
            <AlertsBody
              key={`${effective.companyId}:${effective.shopId ?? ''}`}
              companyId={effective.companyId}
              shopId={effective.shopId ?? null}
            />
          ) : (
            <p className="text-muted-foreground text-sm">{t('chooseCompany')}</p>
          )}
        </ScopeGate>
      )}
    </div>
  );
}

function ProviderBanner({ provider }: { provider: ProviderInfo }) {
  const t = useTranslations('exceptionAlerts.provider');
  if (provider.provider === 'dry_run') {
    return (
      <div className="rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm dark:border-sky-800 dark:bg-sky-950/40">
        <p className="flex items-center gap-2 font-medium">
          <FlaskConical className="size-4" />
          {t('dryRunTitle')}
        </p>
        <p className="text-muted-foreground mt-1">{t('dryRunBody')}</p>
      </div>
    );
  }
  const mode = provider.configured === false || !provider.mode ? 'none' : provider.mode;
  const known = ['mock', 'test', 'live', 'none'].includes(mode) ? mode : 'none';
  return (
    <div
      className={cn(
        'rounded-lg border p-3 text-sm',
        provider.dryRun || known !== 'live'
          ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40'
          : 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40',
      )}
    >
      <p className="font-medium">{t('queueTitle')}</p>
      <p className="text-muted-foreground mt-1">{t('queueMode', { mode: t(`modes.${known}`) })}</p>
      {known === 'live' && !provider.liveSendingEnabled ? <p className="mt-1">{t('liveOff')}</p> : null}
      {known === 'live' && provider.liveRestrictedToTestNumbers ? <p className="mt-1">{t('restricted')}</p> : null}
    </div>
  );
}

function AlertsBody({ companyId, shopId }: { companyId: string; shopId: string | null }) {
  const t = useTranslations('exceptionAlerts');
  const qc = useQueryClient();
  const errorText = useRuleErrorText();
  const rules = useQuery({
    queryKey: ['exception-alert-rules', companyId, shopId],
    queryFn: () => fetchAlertRules(companyId, shopId),
  });
  const kinds = useQuery({ queryKey: ['exception-log-kinds'], queryFn: fetchLogKinds, staleTime: 60 * 60 * 1000 });
  const [editing, setEditing] = useState<{ rule: AlertRule | null; draft: RuleDraft } | null>(null);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['exception-alert-rules', companyId] });

  const toggle = useMutation({
    mutationFn: (r: AlertRule) => updateAlertRule(r.id, { enabled: !r.enabled }),
    onSuccess: () => {
      toast.success(t('saved'));
      invalidate();
    },
    onError: (err: unknown) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: (r: AlertRule) => deleteAlertRule(r.id),
    onSuccess: () => {
      toast.success(t('deleted'));
      setDeleting(null);
      invalidate();
    },
    onError: (err: unknown) => toast.error(errorText(err)),
  });
  const test = useMutation({
    mutationFn: (r: AlertRule) => sendAlertTest(r.id),
    onSuccess: (res, r) => {
      const count = res.dispatches.length;
      toast.success(res.dryRun ? t('testSentDry', { count }) : t('testSent', { count }));
      qc.invalidateQueries({ queryKey: ['exception-alert-dispatches', r.id] });
    },
    onError: (err: unknown) => toast.error(errorText(err)),
  });

  if (rules.isLoading || kinds.isLoading) return <Skeleton className="h-48 w-full" />;
  if (rules.isError || !rules.data) {
    return <p className="text-destructive text-sm">{errorText(rules.error)}</p>;
  }
  const data = rules.data;
  const catalog = kinds.data?.kinds ?? [];
  const canCreate = data.canWriteCompany || !!data.canWriteShop;

  return (
    <div className="space-y-4">
      <ProviderBanner provider={data.provider} />
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        {canCreate ? (
          <Button
            size="sm"
            onClick={() => setEditing({ rule: null, draft: emptyDraft(data.canWriteCompany ? '' : (shopId ?? '')) })}
          >
            <Plus className="size-4" />
            {t('newRule')}
          </Button>
        ) : null}
      </div>
      {data.rules.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border p-8 text-center text-sm">{t('empty')}</p>
      ) : (
        <div className="space-y-3">
          {data.rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              catalog={catalog}
              busy={toggle.isPending || test.isPending}
              onToggle={() => toggle.mutate(rule)}
              onEdit={() => setEditing({ rule, draft: draftFromRule(rule) })}
              onTest={() => test.mutate(rule)}
              onDelete={() => setDeleting(rule)}
            />
          ))}
        </div>
      )}

      {editing ? (
        <RuleEditor
          companyId={companyId}
          catalog={catalog}
          editing={editing}
          canWriteCompany={data.canWriteCompany}
          fixedShopId={data.canWriteCompany ? null : shopId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      ) : null}

      <Dialog open={deleting !== null} onOpenChange={(open) => (!open ? setDeleting(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('delete')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{deleting ? t('deleteConfirm', { name: deleting.name }) : null}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function useRuleSummary(catalog: LogKind[]) {
  const t = useTranslations('exceptionAlerts');
  const tl = useTranslations('exceptionsLog');
  return (rule: AlertRule): string[] => {
    const label = (k: string) => catalog.find((c) => c.key === k)?.label ?? k;
    const parts: string[] = [];
    parts.push(rule.kinds.length ? rule.kinds.map(label).join(', ') : t('summary.allKinds'));
    if (rule.minSeverity) parts.push(t('summary.severityFrom', { severity: tl(`severities.${rule.minSeverity}`) }));
    if (rule.minAmount != null) parts.push(t('summary.amount', { amount: rule.minAmount }));
    if (rule.minPercent != null) parts.push(t('summary.percent', { percent: rule.minPercent }));
    if (rule.countThreshold && rule.countWindowMinutes) {
      parts.push(
        t('summary.count', {
          count: rule.countThreshold,
          minutes: rule.countWindowMinutes,
          scope: t(`fields.countScopes.${rule.countScope}`),
        }),
      );
    }
    const quiet = quietHoursText(rule.quietFrom, rule.quietTo);
    if (quiet) parts.push(t('summary.quiet', { range: quiet }));
    parts.push(rule.rateLimitMinutes > 0 ? t('summary.rate', { minutes: rule.rateLimitMinutes }) : t('summary.noRate'));
    if (rule.digestEnabled && (rule.rateLimitMinutes > 0 || quiet)) parts.push(t('summary.digest'));
    return parts;
  };
}

function RuleCard({
  rule,
  catalog,
  busy,
  onToggle,
  onEdit,
  onTest,
  onDelete,
}: {
  rule: AlertRule;
  catalog: LogKind[];
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('exceptionAlerts');
  const summary = useRuleSummary(catalog)(rule);
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardContent className="space-y-2 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Switch
            checked={rule.enabled}
            disabled={!rule.canWrite || busy}
            onCheckedChange={() => onToggle()}
            aria-label={rule.enabled ? t('enabled') : t('disabled')}
          />
          <span className="font-medium">{rule.name}</span>
          <Badge variant="outline">{rule.shopName ?? t('companyWide')}</Badge>
          {!rule.enabled ? <Badge variant="secondary">{t('disabled')}</Badge> : null}
          <div className="ms-auto flex flex-wrap gap-1">
            {rule.canWrite ? (
              <>
                <Button size="sm" variant="outline" onClick={onTest} disabled={busy || !rule.recipients.length}>
                  <Send className="size-4" />
                  {t('test')}
                </Button>
                <Button size="sm" variant="ghost" onClick={onEdit} title={t('editRule')}>
                  <Pencil className="size-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={onDelete} title={t('delete')}>
                  <Trash2 className="size-4" />
                </Button>
              </>
            ) : (
              <span className="text-muted-foreground text-xs">{t('readOnly')}</span>
            )}
          </div>
        </div>
        <p className="text-muted-foreground text-sm">{summary.join(' · ')}</p>
        <p className="text-sm">
          {rule.recipients.map((r) => [r.label, r.phone].filter(Boolean).join(' ')).join(' , ')}
        </p>
        <button
          type="button"
          className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          {t('recent')} · {t('changes')}
        </button>
        {open ? <RuleHistory ruleId={rule.id} /> : null}
      </CardContent>
    </Card>
  );
}

function RuleHistory({ ruleId }: { ruleId: string }) {
  const t = useTranslations('exceptionAlerts');
  const dispatches = useQuery({
    queryKey: ['exception-alert-dispatches', ruleId],
    queryFn: () => fetchRuleDispatches(ruleId),
  });
  const changes = useQuery({ queryKey: ['exception-alert-changes', ruleId], queryFn: () => fetchRuleChanges(ruleId) });
  return (
    <div className="grid gap-3 border-t pt-3 md:grid-cols-2">
      <div className="space-y-1">
        <h3 className="text-xs font-medium">{t('recent')}</h3>
        {dispatches.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : !dispatches.data?.length ? (
          <p className="text-muted-foreground text-xs">{t('noRecent')}</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {dispatches.data.map((d) => (
              <li key={d.id} title={d.text ?? undefined}>
                <span className="text-muted-foreground">{formatDateTime(d.at)}</span> ·{' '}
                {t(`dispatchKinds.${d.kind}`)} ·{' '}
                <span className={TONE_CLASS[dispatchTone(d.status)]}>{d.statusLabel}</span> ·{' '}
                {[d.recipientLabel, d.recipient].filter(Boolean).join(' ')}
                {d.digestCount && d.kind === 'digest' ? ` (${d.digestCount})` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1">
        <h3 className="text-xs font-medium">{t('changes')}</h3>
        {changes.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : !changes.data?.length ? (
          <p className="text-muted-foreground text-xs">{t('noChanges')}</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {changes.data.map((c) => (
              <li key={c.id}>
                <span className="text-muted-foreground">{formatDateTime(c.at)}</span> · {t(`actions.${c.action}`)} ·{' '}
                {c.userEmail ?? '—'}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FieldError({ code }: { code?: string }) {
  const t = useTranslations('exceptionAlerts');
  if (!code) return null;
  return <p className="text-destructive text-xs">{t.has(`errors.${code}`) ? t(`errors.${code}`) : code}</p>;
}

function RuleEditor({
  companyId,
  catalog,
  editing,
  canWriteCompany,
  fixedShopId,
  onClose,
  onSaved,
}: {
  companyId: string;
  catalog: LogKind[];
  editing: { rule: AlertRule | null; draft: RuleDraft };
  canWriteCompany: boolean;
  fixedShopId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('exceptionAlerts');
  const tl = useTranslations('exceptionsLog');
  const errorText = useRuleErrorText();
  const { shops } = useScope();
  const [draft, setDraft] = useState<RuleDraft>(editing.draft);
  const [errors, setErrors] = useState<DraftErrors>({});
  const users = useQuery({ queryKey: ['exception-alert-users', companyId], queryFn: () => fetchAlertUsers(companyId) });
  const companyShops = useMemo(() => shops.filter((s) => s.companyId === companyId), [shops, companyId]);
  const applies = thresholdsApply(draft.kinds, catalog);
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      const { errors: found, body } = validateDraft(draft);
      setErrors(found);
      if (!body) throw new Error('invalid');
      return editing.rule ? updateAlertRule(editing.rule.id, body) : createAlertRule(companyId, body);
    },
    onSuccess: () => {
      toast.success(t('saved'));
      onSaved();
    },
    onError: (err: unknown) => {
      if (err instanceof Error && err.message === 'invalid') return;
      const detail = (err as { response?: { data?: { detail?: { code?: string; field?: string } } } })?.response?.data
        ?.detail;
      if (detail && typeof detail === 'object' && detail.field) setErrors({ [detail.field]: detail.code });
      toast.error(errorText(err));
    },
  });

  const toggleKind = (key: string) =>
    set('kinds', draft.kinds.includes(key) ? draft.kinds.filter((k) => k !== key) : [...draft.kinds, key]);
  const setRecipient = (i: number, patch: Partial<RuleDraft['recipients'][number]>) =>
    set('recipients', draft.recipients.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const shopLocked = !!editing.rule || !canWriteCompany;

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing.rule ? t('editRule') : t('newRule')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="rule-name">{t('fields.name')}</Label>
              <Input
                id="rule-name"
                value={draft.name}
                maxLength={120}
                placeholder={t('fields.namePlaceholder')}
                onChange={(e) => set('name', e.target.value)}
              />
              <FieldError code={errors.name} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-shop">{t('fields.shop')}</Label>
              <select
                id="rule-shop"
                className="border-input bg-background h-9 w-full rounded-md border px-2"
                value={draft.shopId}
                disabled={shopLocked}
                onChange={(e) => set('shopId', e.target.value)}
              >
                {canWriteCompany || !draft.shopId ? <option value="">{t('fields.allShops')}</option> : null}
                {companyShops
                  .filter((s) => canWriteCompany || s.id === (fixedShopId ?? draft.shopId))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="font-medium">{t('fields.kinds')}</legend>
            <p className="text-muted-foreground text-xs">{t('fields.kindsHint')}</p>
            <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
              {catalog.map((k) => (
                <label key={k.key} className="flex items-center gap-2">
                  <input type="checkbox" checked={draft.kinds.includes(k.key)} onChange={() => toggleKind(k.key)} />
                  <span>{k.label}</span>
                  <span className="text-muted-foreground text-xs">· {tl(`severities.${k.severity}`)}</span>
                </label>
              ))}
            </div>
            <FieldError code={errors.kinds} />
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="rule-severity">{t('fields.minSeverity')}</Label>
                <select
                  id="rule-severity"
                  className="border-input bg-background h-9 w-full rounded-md border px-2"
                  value={draft.minSeverity}
                  onChange={(e) => set('minSeverity', e.target.value as RuleDraft['minSeverity'])}
                >
                  <option value="">{t('fields.anySeverity')}</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {tl(`severities.${s}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-amount">{t('fields.minAmount')}</Label>
                <Input
                  id="rule-amount"
                  inputMode="decimal"
                  value={draft.minAmount}
                  disabled={!applies.amount}
                  onChange={(e) => set('minAmount', e.target.value)}
                />
                <p className="text-muted-foreground text-xs">{t('fields.minAmountHint')}</p>
                <FieldError code={errors.minAmount} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-percent">{t('fields.minPercent')}</Label>
                <Input
                  id="rule-percent"
                  inputMode="decimal"
                  value={draft.minPercent}
                  disabled={!applies.percent}
                  onChange={(e) => set('minPercent', e.target.value)}
                />
                <p className="text-muted-foreground text-xs">{t('fields.minPercentHint')}</p>
                <FieldError code={errors.minPercent} />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="font-medium">
              {t('fields.count')} / {t('fields.window')}
            </legend>
            <p className="text-muted-foreground text-xs">{t('fields.countHint')}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="rule-count">{t('fields.count')}</Label>
                <Input
                  id="rule-count"
                  inputMode="numeric"
                  value={draft.countThreshold}
                  onChange={(e) => set('countThreshold', e.target.value)}
                />
                <FieldError code={errors.countThreshold} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-window">{t('fields.window')}</Label>
                <Input
                  id="rule-window"
                  inputMode="numeric"
                  value={draft.countWindowMinutes}
                  onChange={(e) => set('countWindowMinutes', e.target.value)}
                />
                <FieldError code={errors.countWindowMinutes} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-count-scope">{t('fields.countScope')}</Label>
                <select
                  id="rule-count-scope"
                  className="border-input bg-background h-9 w-full rounded-md border px-2"
                  value={draft.countScope}
                  onChange={(e) => set('countScope', e.target.value as RuleDraft['countScope'])}
                >
                  {COUNT_SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {t(`fields.countScopes.${s}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="font-medium">{t('fields.recipients')}</legend>
            <p className="text-muted-foreground text-xs">{t('fields.recipientsHint')}</p>
            {draft.recipients.map((r, i) => (
              <div key={i} className="grid items-start gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <div>
                  <Input
                    dir="ltr"
                    inputMode="tel"
                    placeholder="050-1234567"
                    aria-label={t('fields.phone')}
                    value={r.phone}
                    onChange={(e) => setRecipient(i, { phone: e.target.value })}
                  />
                  <FieldError code={errors[`recipients.${i}`]} />
                </div>
                <Input
                  placeholder={t('fields.label')}
                  aria-label={t('fields.label')}
                  value={r.label}
                  maxLength={60}
                  onChange={(e) => setRecipient(i, { label: e.target.value })}
                />
                <select
                  className="border-input bg-background h-9 w-full rounded-md border px-2"
                  aria-label={t('fields.user')}
                  value={r.userId}
                  onChange={(e) => {
                    const user = users.data?.find((u) => u.id === e.target.value);
                    setRecipient(i, { userId: e.target.value, label: r.label || user?.name || '' });
                  }}
                >
                  <option value="">{t('fields.noUser')}</option>
                  {(users.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  title={t('fields.remove')}
                  onClick={() => set('recipients', draft.recipients.filter((_, j) => j !== i))}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            <FieldError code={errors.recipients} />
            {draft.recipients.length < 10 ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => set('recipients', [...draft.recipients, { phone: '', label: '', userId: '' }])}
              >
                <Plus className="size-4" />
                {t('fields.addRecipient')}
              </Button>
            ) : null}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="font-medium">{t('fields.quiet')}</legend>
            <p className="text-muted-foreground text-xs">{t('fields.quietHint')}</p>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="rule-quiet-from">{t('fields.quietFrom')}</Label>
                <Input
                  id="rule-quiet-from"
                  type="time"
                  dir="ltr"
                  value={draft.quietFrom}
                  onChange={(e) => set('quietFrom', e.target.value)}
                />
                <FieldError code={errors.quietFrom} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-quiet-to">{t('fields.quietTo')}</Label>
                <Input
                  id="rule-quiet-to"
                  type="time"
                  dir="ltr"
                  value={draft.quietTo}
                  onChange={(e) => set('quietTo', e.target.value)}
                />
                <FieldError code={errors.quietTo} />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="rule-rate">{t('fields.rateLimit')}</Label>
                <Input
                  id="rule-rate"
                  inputMode="numeric"
                  value={draft.rateLimitMinutes}
                  onChange={(e) => set('rateLimitMinutes', e.target.value)}
                />
                <p className="text-muted-foreground text-xs">{t('fields.rateLimitHint')}</p>
                <FieldError code={errors.rateLimitMinutes} />
              </div>
            </div>
            <label className="flex items-center gap-2">
              <Switch checked={draft.digestEnabled} onCheckedChange={(v) => set('digestEnabled', v)} />
              {t('fields.digest')}
            </label>
          </fieldset>

          <label className="flex items-center gap-2">
            <Switch checked={draft.enabled} onCheckedChange={(v) => set('enabled', v)} />
            {t('fields.enabled')}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
