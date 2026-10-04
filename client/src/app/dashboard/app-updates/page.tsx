'use client';

/**
 * Till app updates ("עדכון קופות") — super admin only.
 *
 * Upload a build of the till app (an APK), send it to a company, shop, point of sale or
 * single till (or the whole organization), and watch it roll out. Each till asks
 * `GET /sync/{id}/app-update` on every sync, takes the most specific live assignment
 * that applies to it, downloads, checks the SHA-256, installs, and reports each step;
 * the rollout table shows the last report. Sending tells the tills at once (Ably), so
 * a till online picks it up within moments.
 */

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send, Trash2, Upload } from 'lucide-react';
import {
  cancelAppReleaseAssignment,
  createAppReleaseAssignment,
  fetchAppReleaseAssignments,
  fetchAppReleaseRollout,
  fetchAppReleases,
  fetchCompanies,
  fetchShops,
  updateAppRelease,
  uploadAppRelease,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import type {
  AppRelease,
  AppReleaseAssignment,
  AppReleaseRolloutRow,
  AppUpdateStatus,
  Company,
  Shop,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { cn } from '@/lib/utils';

/** The rollout table refreshes itself while the page is open. */
const ROLLOUT_REFRESH_MS = 15_000;
const ANY = '__any__';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatWhen(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
}

/** Hebrew text for this feature's refusal codes; anything else falls back to the generic toast. */
function useAppUpdateErrorText() {
  const t = useTranslations('appUpdates.errors');
  return (err: unknown, fallback: string): string => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    const code =
      typeof detail === 'string'
        ? detail
        : typeof (detail as { code?: unknown })?.code === 'string'
          ? ((detail as { code: string }).code)
          : null;
    if (code === 'app_release_version_taken') return t('versionTaken');
    if (code === 'app_release_too_large') return t('tooLarge');
    if (code === 'invalid_apk') return t('invalidApk');
    if (code === 'apk_version_required') return t('versionRequired');
    if (code === 'apk_version_mismatch') {
      const msg = (detail as { msg?: string })?.msg;
      return msg ? `${t('versionMismatch')} (${msg})` : t('versionMismatch');
    }
    if (code === 'app_release_retired') return t('retired');
    if (code?.endsWith('_not_found')) return t('targetNotFound');
    return axiosErrorToToastMessage(err, fallback);
  };
}

export default function AppUpdatesPage() {
  const t = useTranslations('appUpdates');
  const authHydrated = useAuth((s) => s.authHydrated);
  const role = useAuth((s) => s.user?.role);

  if (!authHydrated) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (role !== 'super_admin') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">{t('noPermission')}</CardContent>
        </Card>
      </div>
    );
  }
  return <AppUpdatesAdmin />;
}

function AppUpdatesAdmin() {
  const t = useTranslations('appUpdates');
  const { data: releases = [], isLoading } = useQuery<AppRelease[]>({
    queryKey: ['app-releases'],
    queryFn: fetchAppReleases,
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      <ReleasesCard releases={releases} loading={isLoading} />
      <SendCard releases={releases} />
      <AssignmentsCard releases={releases} />
      <RolloutCard />
    </div>
  );
}

// ── Releases: upload and list ────────────────────────────────────────────────

function ReleasesCard({ releases, loading }: { releases: AppRelease[]; loading: boolean }) {
  const t = useTranslations('appUpdates');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useAppUpdateErrorText();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [versionName, setVersionName] = useState('');
  const [versionCode, setVersionCode] = useState('');
  const [notes, setNotes] = useState('');
  const [progress, setProgress] = useState<number | null>(null);

  const reset = () => {
    setFile(null);
    setVersionName('');
    setVersionCode('');
    setNotes('');
    setProgress(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const upload = useMutation({
    mutationFn: () =>
      uploadAppRelease(
        file as File,
        {
          versionName: versionName.trim() || undefined,
          versionCode: versionCode.trim() ? Number(versionCode) : undefined,
          notes: notes.trim() || undefined,
        },
        setProgress,
      ),
    onSuccess: (release) => {
      qc.invalidateQueries({ queryKey: ['app-releases'] });
      toast.success(t('uploaded', { version: release.versionName }));
      reset();
    },
    onError: (err: unknown) => {
      setProgress(null);
      toast.error(errorText(err, tc('error')));
    },
  });

  const toggle = useMutation({
    mutationFn: (r: AppRelease) => updateAppRelease(r.id, { isActive: !r.isActive }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-releases'] });
      qc.invalidateQueries({ queryKey: ['app-release-rollout'] });
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });

  const codeInvalid = versionCode.trim() !== '' && !/^[1-9][0-9]*$/.test(versionCode.trim());

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('releasesTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm font-medium">{t('uploadTitle')}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1 lg:col-span-2">
              <Label htmlFor="apk-file">{t('file')}</Label>
              <Input
                id="apk-file"
                ref={fileRef}
                type="file"
                accept=".apk,application/vnd.android.package-archive"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="apk-version-name">{t('versionName')}</Label>
              <Input
                id="apk-version-name"
                dir="ltr"
                value={versionName}
                maxLength={64}
                placeholder={t('fromApk')}
                onChange={(e) => setVersionName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="apk-version-code">{t('versionCode')}</Label>
              <Input
                id="apk-version-code"
                dir="ltr"
                inputMode="numeric"
                value={versionCode}
                placeholder={t('fromApk')}
                aria-invalid={codeInvalid || undefined}
                onChange={(e) => setVersionCode(e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2 lg:col-span-4">
              <Label htmlFor="apk-notes">{t('notes')}</Label>
              <textarea
                id="apk-notes"
                className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={notes}
                maxLength={4000}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">{t('uploadHint')}</p>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              disabled={!file || codeInvalid || upload.isPending}
              onClick={() => upload.mutate()}
            >
              <Upload className="h-4 w-4 ms-1" />
              {upload.isPending ? t('uploading') : t('upload')}
            </Button>
            {progress !== null ? (
              <span className="text-muted-foreground text-xs tabular-nums">{Math.round(progress * 100)}%</span>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('version')}</TableHead>
                <TableHead>{t('size')}</TableHead>
                <TableHead>{t('uploadedAt')}</TableHead>
                <TableHead>{t('notes')}</TableHead>
                <TableHead>{t('assignments')}</TableHead>
                <TableHead>{tc('active')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ) : releases.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                    {t('noReleases')}
                  </TableCell>
                </TableRow>
              ) : (
                releases.map((r) => (
                  <TableRow key={r.id} className={cn(!r.isActive && 'text-muted-foreground')}>
                    <TableCell>
                      <div className="font-medium font-mono text-xs" dir="ltr">
                        {r.versionName}
                      </div>
                      <div className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                        {t('codeShort', { code: r.versionCode })}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums" dir="ltr">
                      {formatBytes(r.sizeBytes)}
                    </TableCell>
                    <TableCell className="text-xs">{formatWhen(r.createdAt)}</TableCell>
                    <TableCell className="max-w-72 whitespace-pre-wrap text-xs">{r.notes ?? ''}</TableCell>
                    <TableCell className="tabular-nums">{r.assignmentCount}</TableCell>
                    <TableCell>
                      <Switch
                        checked={r.isActive}
                        disabled={toggle.isPending}
                        onCheckedChange={() => {
                          if (r.isActive && !window.confirm(t('retireConfirm', { version: r.versionName }))) {
                            return;
                          }
                          toggle.mutate(r);
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Send ─────────────────────────────────────────────────────────────────────

function SendCard({ releases }: { releases: AppRelease[] }) {
  const t = useTranslations('appUpdates');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useAppUpdateErrorText();
  const activeTenantId = useAuth((s) => s.activeTenantId);
  const [releaseId, setReleaseId] = useState('');
  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const [autoInstall, setAutoInstall] = useState(false);

  const active = releases.filter((r) => r.isActive);
  const release = active.find((r) => r.id === releaseId) ?? null;
  const target = deepestOrgScope(scope);
  const targetId = target ? (target.level === 'tenant' ? activeTenantId : target.id) : null;

  const send = useMutation({
    mutationFn: () =>
      createAppReleaseAssignment(releaseId, {
        level: target!.level,
        targetId: targetId as string,
        autoInstall,
      }),
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ['app-releases'] });
      qc.invalidateQueries({ queryKey: ['app-release-assignments'] });
      qc.invalidateQueries({ queryKey: ['app-release-rollout'] });
      toast.success(t('sent', { count: a.machineCount }));
      setScope(EMPTY_ORG_SCOPE);
      setAutoInstall(false);
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });

  const releaseItems = active.map((r) => ({
    value: r.id,
    label: `${r.versionName} (${t('codeShort', { code: r.versionCode })})`,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sendTitle')}</CardTitle>
        <p className="text-muted-foreground text-sm">{t('sendHint')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1 max-w-md">
          <Label>{t('release')}</Label>
          <Select
            value={releaseId || null}
            onValueChange={(v) => setReleaseId(v ? String(v) : '')}
            items={releaseItems}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('chooseRelease')} />
            </SelectTrigger>
            <SelectContent>
              {releaseItems.map((o) => (
                <SelectItem key={o.value} value={o.value} label={o.label}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <OrgScopeCascade value={scope} onChange={setScope} allowAll />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={autoInstall}
            onChange={(e) => setAutoInstall(e.target.checked)}
          />
          {t('autoInstall')}
        </label>
        <p className="text-muted-foreground text-xs">{t('autoInstallHint')}</p>
        <Button
          size="sm"
          disabled={!release || !target || !targetId || send.isPending}
          onClick={() => {
            const where = target ? t(`levels.${target.level}`) : '';
            if (window.confirm(t('sendConfirm', { version: release!.versionName, level: where }))) {
              send.mutate();
            }
          }}
        >
          <Send className="h-4 w-4 ms-1" />
          {send.isPending ? t('sending') : t('send')}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Live assignments ─────────────────────────────────────────────────────────

function AssignmentsCard({ releases }: { releases: AppRelease[] }) {
  const t = useTranslations('appUpdates');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useAppUpdateErrorText();

  const withAssignments = releases.filter((r) => r.assignmentCount > 0);
  const results = useQueries({
    queries: withAssignments.map((r) => ({
      queryKey: ['app-release-assignments', r.id],
      queryFn: () => fetchAppReleaseAssignments(r.id),
    })),
  });
  const loading = results.some((q) => q.isLoading);
  const rows: AppReleaseAssignment[] = results
    .flatMap((q) => q.data ?? [])
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  const cancel = useMutation({
    mutationFn: (id: string) => cancelAppReleaseAssignment(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-releases'] });
      qc.invalidateQueries({ queryKey: ['app-release-assignments'] });
      qc.invalidateQueries({ queryKey: ['app-release-rollout'] });
      toast.success(t('cancelled'));
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });

  const targetLabel = (a: AppReleaseAssignment) =>
    a.targetName
      ? a.targetContext
        ? `${a.targetName} · ${a.targetContext}`
        : a.targetName
      : t('deletedTarget');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('assignmentsTitle')}</CardTitle>
        <p className="text-muted-foreground text-sm">{t('precedence')}</p>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('version')}</TableHead>
                <TableHead>{t('level')}</TableHead>
                <TableHead>{t('target')}</TableHead>
                <TableHead>{t('tills')}</TableHead>
                <TableHead>{t('autoInstallShort')}</TableHead>
                <TableHead>{t('sentAt')}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    {t('noAssignments')}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs" dir="ltr">
                      {a.versionName}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{t(`levels.${a.level}`)}</Badge>
                    </TableCell>
                    <TableCell className={a.targetName ? '' : 'text-muted-foreground'}>
                      {targetLabel(a)}
                    </TableCell>
                    <TableCell className="tabular-nums">{a.machineCount}</TableCell>
                    <TableCell>{a.autoInstall ? tc('yes') : tc('no')}</TableCell>
                    <TableCell className="text-xs">{formatWhen(a.createdAt)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t('cancel')}
                        className="text-destructive hover:text-destructive"
                        disabled={cancel.isPending}
                        onClick={() => {
                          if (window.confirm(t('cancelConfirm'))) cancel.mutate(a.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Rollout ──────────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<AppUpdateStatus | 'pending', string> = {
  pending: 'bg-muted text-muted-foreground',
  downloading: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  downloaded: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  installing: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  installed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  declined: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
};

/** What the badge says: the till's last report, else "installed" if it already runs the
 *  target, else "pending" while a target is assigned. Null when nothing is assigned. */
function rolloutState(row: AppReleaseRolloutRow): AppUpdateStatus | 'pending' | null {
  if (!row.releaseId) return null;
  if (row.status) return row.status;
  return row.upToDate ? 'installed' : 'pending';
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  anyLabel: string;
  disabled?: boolean;
}) {
  const items = [{ value: ANY, label: anyLabel }, ...options];
  return (
    <div className="space-y-1 w-56">
      <Label>{label}</Label>
      <Select
        value={value || ANY}
        onValueChange={(v) => onChange(!v || v === ANY ? '' : String(v))}
        items={items}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((o) => (
            <SelectItem key={o.value} value={o.value} label={o.label}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function RolloutCard() {
  const t = useTranslations('appUpdates');
  const [companyId, setCompanyId] = useState('');
  const [shopId, setShopId] = useState('');

  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ['companies'], queryFn: fetchCompanies });
  const { data: shops = [] } = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const { data: rows = [], isLoading } = useQuery<AppReleaseRolloutRow[]>({
    queryKey: ['app-release-rollout', companyId, shopId],
    queryFn: () => fetchAppReleaseRollout({ companyId: companyId || undefined, shopId: shopId || undefined }),
    refetchInterval: ROLLOUT_REFRESH_MS,
  });

  const companyShops = companyId ? shops.filter((s) => s.companyId === companyId) : shops;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('rolloutTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-3">
          <FilterSelect
            label={t('company')}
            value={companyId}
            onChange={(v) => {
              setCompanyId(v);
              setShopId('');
            }}
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
            anyLabel={t('allCompanies')}
          />
          <FilterSelect
            label={t('shop')}
            value={shopId}
            onChange={setShopId}
            options={companyShops.map((s) => ({ value: s.id, label: s.name }))}
            anyLabel={t('allShops')}
          />
        </div>
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('company')}</TableHead>
                <TableHead>{t('shop')}</TableHead>
                <TableHead>{t('area')}</TableHead>
                <TableHead>{t('till')}</TableHead>
                <TableHead>{t('currentVersion')}</TableHead>
                <TableHead>{t('targetVersion')}</TableHead>
                <TableHead>{t('status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    {t('noTills')}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const state = rolloutState(row);
                  return (
                    <TableRow key={row.machineId}>
                      <TableCell>{row.companyName ?? ''}</TableCell>
                      <TableCell>{row.shopName ?? ''}</TableCell>
                      <TableCell className={row.areaName ? '' : 'text-muted-foreground'}>
                        {row.areaName ?? t('noArea')}
                      </TableCell>
                      <TableCell className="font-medium">{row.machineName}</TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">
                        {row.currentVersion ?? '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">
                        {row.targetVersion ?? '—'}
                        {row.targetVersion && row.assignmentLevel ? (
                          <div className="font-sans text-muted-foreground" dir="rtl">
                            {t(`levels.${row.assignmentLevel}`)}
                            {row.autoInstall ? ` · ${t('autoInstallShort')}` : ''}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {state ? (
                          <div className="space-y-0.5">
                            <span
                              className={cn(
                                'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                                STATUS_STYLE[state],
                              )}
                            >
                              {t(`statuses.${state}`)}
                            </span>
                            {row.statusAt ? (
                              <div className="text-muted-foreground text-xs">{formatWhen(row.statusAt)}</div>
                            ) : null}
                            {row.statusMessage ? (
                              <div className="max-w-64 text-xs text-muted-foreground break-words" dir="auto">
                                {row.statusMessage}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">{t('notAssigned')}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
