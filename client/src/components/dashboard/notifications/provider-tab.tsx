'use client';

/**
 * "הגדרות ספק" — the 019 SMS account of a company (or the organization's default).
 *
 * * Mode mock / test / live. "live" is the super admin's alone, and the server-wide
 *   switch (`liveSendingEnabled`) is always shown: while it is off, live sends nothing.
 * * The token is write-only: the page shows "מוגדר" / "לא מוגדר" and when it changed;
 *   the field starts empty, `token` is sent only when someone typed a new one, and ""
 *   (the "הסרה" button) removes it. Nothing keeps the typed value after a save.
 * * Balance: the server returns null — "יתרה לא ידועה", never a made-up number.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, KeyRound, Pause, Play, Plus, Save, Trash2, X } from 'lucide-react';
import { normalizeIsraeliMobile } from '@/lib/clubSignup';
import {
  fetchProvider,
  isValidSmsSender,
  pauseProvider,
  resumeProvider,
  saveProvider,
  type ProviderConfig,
  type ProviderMode,
  type ProviderPatch,
} from '@/lib/notificationsApi';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { NC, ReasonDialog, SimpleSelect, formatWhen, useNcErrorText } from './shared';

/** The events a company may switch on (Campaign is a later phase; the server drops it). */
const EVENT_TOGGLES = ['OrderReady', 'OtpCode', 'ClubWelcome', 'EquipmentAlert'] as const;

const LIMITS = {
  ratePerMinute: [0, 600],
  dailyQuota: [0, 100000],
  alertThreshold: [0, 100000],
  orderReadyTtlMinutes: [1, 120],
} as const;
type NumberKey = keyof typeof LIMITS;

function numberError(value: string, key: NumberKey): boolean {
  if (value.trim() === '') return key === 'orderReadyTtlMinutes';
  const n = Number(value);
  const [lo, hi] = LIMITS[key];
  return !Number.isInteger(n) || n < lo || n > hi;
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={(v) => onChange(!!v)} disabled={disabled} />
    </div>
  );
}

function ProviderForm({
  data,
  companyId,
  isSuperAdmin,
  onSaved,
}: {
  data: ProviderConfig;
  companyId: string | null;
  isSuperAdmin: boolean;
  onSaved: (next: ProviderConfig) => void;
}) {
  const t = useTranslations(`${NC}.provider`);
  const tn = useTranslations(`${NC}.notifications`);
  const errorText = useNcErrorText();
  const fresh = !data.configured || !!data.inherited;

  const [mode, setMode] = useState<string>(data.mode ?? 'mock');
  const [accountUsername, setAccountUsername] = useState(data.accountUsername ?? '');
  const [sender, setSender] = useState(data.sender ?? '');
  const [brandName, setBrandName] = useState(data.brandName ?? '');
  const [numbers, setNumbers] = useState<Record<NumberKey, string>>({
    ratePerMinute: data.ratePerMinute != null ? String(data.ratePerMinute) : '',
    dailyQuota: data.dailyQuota != null ? String(data.dailyQuota) : '',
    alertThreshold: data.alertThreshold != null ? String(data.alertThreshold) : '',
    orderReadyTtlMinutes: String(data.orderReadyTtlMinutes ?? 10),
  });
  const [testNumbers, setTestNumbers] = useState<string[]>(data.testNumbers ?? []);
  const [newNumber, setNewNumber] = useState('');
  const [newNumberError, setNewNumberError] = useState<string | null>(null);
  const [liveRestricted, setLiveRestricted] = useState(data.liveRestrictedToTestNumbers ?? true);
  const [events, setEvents] = useState<Record<string, boolean>>(data.enabledEvents ?? {});
  const [dlrPolling, setDlrPolling] = useState(!!data.dlrPollingEnabled);
  // Write-only: typed here, sent once, gone with the form after the save.
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);

  const senderInvalid = sender.trim() !== '' && !isValidSmsSender(sender.trim());
  const numberInvalid = (Object.keys(LIMITS) as NumberKey[]).some((k) => numberError(numbers[k], k));

  const save = useMutation({
    mutationFn: () => {
      const patch: ProviderPatch = {
        accountUsername: accountUsername.trim(),
        sender: sender.trim(),
        brandName: brandName.trim(),
        testNumbers,
        enabledEvents: Object.fromEntries(EVENT_TOGGLES.map((e) => [e, !!events[e]])),
        dlrPollingEnabled: dlrPolling,
      };
      for (const key of Object.keys(LIMITS) as NumberKey[]) {
        if (numbers[key].trim() !== '') patch[key] = Number(numbers[key]);
      }
      // Sent only when changed (a new account takes it too, unless it is "live"): the
      // server refuses "live" — and switching the test-numbers lock off — from anyone
      // but the super admin, even when the value is unchanged.
      if (mode !== data.mode || (fresh && mode !== 'live')) patch.mode = mode as ProviderMode;
      if (liveRestricted !== data.liveRestrictedToTestNumbers || (fresh && liveRestricted)) {
        patch.liveRestrictedToTestNumbers = liveRestricted;
      }
      if (removeToken) patch.token = '';
      else if (token.trim()) patch.token = token.trim();
      return saveProvider(companyId, patch);
    },
    onSuccess: (next) => {
      setToken('');
      setRemoveToken(false);
      toast.success(t('saved'));
      onSaved(next);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const addNumber = () => {
    const result = normalizeIsraeliMobile(newNumber);
    if (!result.ok) {
      setNewNumberError(t(`phoneErrors.${result.code}`));
      return;
    }
    if (testNumbers.length >= 20) {
      setNewNumberError(t('testNumbersMax'));
      return;
    }
    setTestNumbers((list) => (list.includes(result.e164) ? list : [...list, result.e164]));
    setNewNumber('');
    setNewNumberError(null);
  };

  const modeOptions = (['mock', 'test', 'live'] as const).map((m) => ({
    value: m,
    label: t(`modes.${m}`),
    disabled: m === 'live' && !isSuperAdmin && data.mode !== 'live',
  }));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!senderInvalid && !numberInvalid && !save.isPending) save.mutate();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>{t('accountTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <SimpleSelect id="pv-mode" label={t('mode')} value={mode} onChange={setMode} options={modeOptions} />
              <p className="text-xs text-muted-foreground">{t(`modeHints.${mode}`)}</p>
              {!isSuperAdmin ? <p className="text-xs text-muted-foreground">{t('liveSuperAdminOnly')}</p> : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-user">{t('username')}</Label>
              <Input
                id="pv-user"
                value={accountUsername}
                onChange={(e) => setAccountUsername(e.target.value)}
                maxLength={100}
                autoComplete="off"
                dir="ltr"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-sender">{t('sender')}</Label>
              <Input
                id="pv-sender"
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                maxLength={11}
                dir="ltr"
                aria-invalid={senderInvalid || undefined}
                aria-describedby="pv-sender-hint"
              />
              <p id="pv-sender-hint" className={cn('text-xs', senderInvalid ? 'text-destructive' : 'text-muted-foreground')}>
                {senderInvalid ? t('senderInvalid') : t('senderHint')}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-brand">{t('brandName')}</Label>
              <Input id="pv-brand" value={brandName} onChange={(e) => setBrandName(e.target.value)} maxLength={60} />
              <p className="text-xs text-muted-foreground">{t('brandNameHint')}</p>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <KeyRound className="h-4 w-4" aria-hidden />
              <span className="text-sm font-medium">{t('token')}</span>
              <Badge variant={data.token?.set ? 'secondary' : 'outline'}>
                {data.token?.set ? t('tokenSet') : t('tokenNotSet')}
              </Badge>
              {data.token?.set && data.token.updatedAt ? (
                <span className="text-xs text-muted-foreground">
                  {t('tokenUpdated', { at: formatWhen(data.token.updatedAt) })}
                </span>
              ) : null}
            </div>
            <Label htmlFor="pv-token" className="sr-only">
              {t('tokenNew')}
            </Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="pv-token"
                type="password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  if (e.target.value) setRemoveToken(false);
                }}
                placeholder={data.token?.set ? t('tokenReplacePlaceholder') : t('tokenNewPlaceholder')}
                autoComplete="new-password"
                spellCheck={false}
                dir="ltr"
                className="max-w-sm"
              />
              {data.token?.set ? (
                <Button
                  type="button"
                  variant={removeToken ? 'destructive' : 'ghost'}
                  size="sm"
                  aria-pressed={removeToken}
                  onClick={() => {
                    setRemoveToken((v) => !v);
                    setToken('');
                  }}
                >
                  <Trash2 aria-hidden />
                  {removeToken ? t('tokenWillBeRemoved') : t('tokenRemove')}
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{t('tokenHint')}</p>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <span className="font-medium">{t('balance')}: </span>
            <span>{t('balanceUnknown')}</span>
            <p className="text-xs text-muted-foreground">{t('balanceHint')}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('limitsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {(Object.keys(LIMITS) as NumberKey[]).map((key) => {
            const bad = numberError(numbers[key], key);
            return (
              <div key={key} className="space-y-1">
                <Label htmlFor={`pv-${key}`}>{t(`limits.${key}`)}</Label>
                <Input
                  id={`pv-${key}`}
                  type="number"
                  inputMode="numeric"
                  min={LIMITS[key][0]}
                  max={LIMITS[key][1]}
                  value={numbers[key]}
                  onChange={(e) => setNumbers((n) => ({ ...n, [key]: e.target.value }))}
                  aria-invalid={bad || undefined}
                  dir="ltr"
                  className="max-w-[10rem]"
                />
                <p className={cn('text-xs', bad ? 'text-destructive' : 'text-muted-foreground')}>
                  {t(`limitHints.${key}`, { min: LIMITS[key][0], max: LIMITS[key][1] })}
                </p>
              </div>
            );
          })}
          {data.lastAlert ? (
            <div className="sm:col-span-2 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div>
                <p className="font-medium">{t('lastAlert')}</p>
                <p>{data.lastAlert}</p>
                {data.lastAlertAt ? <p className="text-xs text-muted-foreground">{formatWhen(data.lastAlertAt)}</p> : null}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('testNumbersTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('testNumbersHint')}</p>
          {testNumbers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('testNumbersEmpty')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {testNumbers.map((n) => (
                <li key={n} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm">
                  <span dir="ltr" className="font-mono">
                    {n}
                  </span>
                  <button
                    type="button"
                    className="rounded-full p-0.5 hover:bg-muted"
                    aria-label={t('testNumberRemove', { number: n })}
                    onClick={() => setTestNumbers((list) => list.filter((x) => x !== n))}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-1">
            <Label htmlFor="pv-new-number">{t('testNumberAdd')}</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="pv-new-number"
                type="tel"
                inputMode="tel"
                value={newNumber}
                onChange={(e) => {
                  setNewNumber(e.target.value);
                  setNewNumberError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addNumber();
                  }
                }}
                dir="ltr"
                className="max-w-[14rem]"
                aria-invalid={!!newNumberError || undefined}
                aria-describedby="pv-new-number-error"
              />
              <Button type="button" variant="outline" onClick={addNumber} disabled={!newNumber.trim()}>
                <Plus aria-hidden />
                {t('add')}
              </Button>
            </div>
            {newNumberError ? (
              <p id="pv-new-number-error" className="text-xs text-destructive">
                {newNumberError}
              </p>
            ) : null}
          </div>
          <ToggleRow
            id="pv-live-restricted"
            label={t('liveRestricted')}
            hint={t('liveRestrictedHint')}
            checked={liveRestricted}
            onChange={setLiveRestricted}
            disabled={!isSuperAdmin && liveRestricted}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('eventsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {EVENT_TOGGLES.map((e) => (
            <ToggleRow
              key={e}
              id={`pv-event-${e}`}
              label={tn(`events.${e}`)}
              checked={!!events[e]}
              onChange={(v) => setEvents((cur) => ({ ...cur, [e]: v }))}
            />
          ))}
          <ToggleRow
            id="pv-dlr"
            label={t('dlrPolling')}
            hint={t('dlrPollingHint')}
            checked={dlrPolling}
            onChange={setDlrPolling}
          />
        </CardContent>
      </Card>

      <div className="sticky bottom-0 z-10 -mx-1 flex justify-end gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
        <Button type="submit" disabled={senderInvalid || numberInvalid || save.isPending}>
          <Save aria-hidden />
          {save.isPending ? t('saving') : t('save')}
        </Button>
      </div>
    </form>
  );
}

export function ProviderTab({ companyId, isSuperAdmin }: { companyId: string | null; isSuperAdmin: boolean }) {
  const t = useTranslations(`${NC}.provider`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const queryKey = ['notifications-provider', companyId];
  const [pauseOpen, setPauseOpen] = useState(false);
  // The form re-reads the saved values after its own save only (which also drops the
  // typed token); pausing must not throw away edits still being typed.
  const [formVersion, setFormVersion] = useState(0);

  const provider = useQuery({
    queryKey,
    queryFn: () => fetchProvider(companyId),
    refetchOnWindowFocus: false,
  });
  const data = provider.data;

  const apply = (next: ProviderConfig) => {
    qc.setQueryData(queryKey, next);
  };

  const pause = useMutation({
    mutationFn: (reason: string) => pauseProvider(companyId, reason),
    onSuccess: (next) => {
      setPauseOpen(false);
      apply(next);
      toast.success(t('paused'));
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const resume = useMutation({
    mutationFn: () => resumeProvider(companyId),
    onSuccess: (next) => {
      apply(next);
      toast.success(t('resumed'));
    },
    onError: (err) => toast.error(errorText(err)),
  });

  if (provider.isLoading) return <Skeleton className="h-64 w-full" />;
  if (provider.isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorText(provider.error)}
      </p>
    );
  }

  const ownAccount = data.configured && !data.inherited;

  return (
    <div className="space-y-4">
      <div
        className={cn(
          'flex gap-2 rounded-lg border p-3 text-sm',
          data.liveSendingEnabled ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/10',
        )}
        role="note"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{data.liveSendingEnabled ? t('liveSwitchOn') : t('liveSwitchOff')}</p>
          <p className="text-xs text-muted-foreground">
            {data.liveSendingEnabled ? t('liveSwitchOnHint') : t('liveSwitchOffHint')}
          </p>
        </div>
      </div>

      {!data.configured ? (
        <p className="rounded-lg border bg-muted/30 p-3 text-sm">{t('notConfigured')}</p>
      ) : data.inherited ? (
        <p className="rounded-lg border bg-muted/30 p-3 text-sm">{t('inherited')}</p>
      ) : null}

      {ownAccount ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <Badge variant={data.paused ? 'destructive' : 'secondary'}>
            {data.paused ? t('statusPaused') : t('statusActive')}
          </Badge>
          {data.paused ? (
            <span className="text-xs text-muted-foreground">
              {[data.pausedReason, formatWhen(data.pausedAt)].filter(Boolean).join(' · ')}
            </span>
          ) : null}
          <span className="flex-1" />
          {data.paused ? (
            <Button size="sm" onClick={() => resume.mutate()} disabled={resume.isPending}>
              <Play aria-hidden />
              {t('resume')}
            </Button>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => setPauseOpen(true)}>
              <Pause aria-hidden />
              {t('pause')}
            </Button>
          )}
        </div>
      ) : null}

      <ProviderForm
        key={formVersion}
        data={data}
        companyId={companyId}
        isSuperAdmin={isSuperAdmin}
        onSaved={(next) => {
          apply(next);
          setFormVersion((v) => v + 1);
        }}
      />

      <ReasonDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        title={t('pauseTitle')}
        description={t('pauseHint')}
        confirmLabel={t('pause')}
        onConfirm={(reason) => pause.mutate(reason)}
        pending={pause.isPending}
        destructive
        required={false}
      />
    </div>
  );
}
