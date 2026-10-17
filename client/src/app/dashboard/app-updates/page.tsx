'use client';

/**
 * App updates ("עדכוני גרסה" — tills, kiosks and screens) — super admin only. One screen
 * for every platform: the Android till app (APK), the Windows app (installer, .exe) and the
 * kiosk web bundle ("kiosk_web": a zip of the kiosk's screens the Android kiosk shows in a
 * WebView, asked for with `platform=kiosk_web`; rollback allowed, like Windows).
 *
 * Upload a build, send it to a company, shop, point of sale or single device (or the whole
 * organization) — optionally staged to a percent of the devices, and for Windows with a
 * rollback and an install window — and watch it roll out. Each device asks
 * `GET /sync/{id}/app-update` on every sync (the Windows app with `platform=windows`),
 * takes the most specific live assignment of its platform that covers it, downloads,
 * checks the SHA-256, installs, and reports each step; the rollout table shows the last
 * report. Sending tells the devices at once (Ably), so one online picks it up within
 * moments. The pure rules live in lib/appReleases.ts.
 */

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eraser, RotateCcw, Send, Trash2, TriangleAlert, Upload } from 'lucide-react';
import {
  cancelAppReleaseAssignment,
  createAppReleaseAssignment,
  deleteAppReleaseFile,
  fetchAppReleaseAssignments,
  fetchAppReleaseCleanup,
  fetchAppReleaseFileDeleteCheck,
  fetchAppReleaseRollout,
  fetchAppReleases,
  fetchAppReleaseStorageStatus,
  fetchCompanies,
  fetchShops,
  updateAppRelease,
  reuploadAppReleaseFile,
  runAppReleaseCleanup,
  updateAppReleaseAssignment,
  uploadAppRelease,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import {
  APP_PLATFORMS,
  CLEANUP_CONFIRM_WORD,
  CLEANUP_DEFAULT_KEEP,
  allowsDowngrade,
  isWindowsPlatform,
  behindCounts,
  canSend,
  checkInstallWindow,
  cleanupConfirmed,
  fileDeleteBlock,
  fileMissing,
  filterByPlatform,
  newestActiveIds,
  parseKeep,
  knownFallbackReason,
  onlyBehind,
  parseRolloutPercent,
  platformOf,
  platformOfFile,
  rolloutRowKey,
  versionFromInstallerName,
  windowsVersionCode,
  type AppPlatform,
  type PlatformFilter,
} from '@/lib/appReleases';
import type {
  AppRelease,
  AppReleaseAssignment,
  AppReleaseCleanupRow,
  AppReleaseRolloutRow,
  AppReleaseStorageStatus,
  AppUpdateStatus,
  Company,
  Shop,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TimeInput } from '@/components/ui/date-picker';
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
import { SilentUpdateCell } from '@/components/dashboard/machines/device-management';
import { reportOfRolloutRow } from '@/lib/deviceManagement';

/** The rollout table refreshes itself while the page is open. */
const ROLLOUT_REFRESH_MS = 15_000;
const ANY = '__any__';

const ACCEPT: Record<AppPlatform, string> = {
  android: '.apk,application/vnd.android.package-archive',
  windows: '.exe,application/vnd.microsoft.portable-executable,application/x-msdownload',
  windows7: '.exe,application/vnd.microsoft.portable-executable,application/x-msdownload',
  kiosk_web: '.zip,application/zip',
};

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
    : formatDateTime(d);
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
    const msg = (detail as { msg?: string })?.msg;
    const withMsg = (text: string) => (msg ? `${text} (${msg})` : text);
    if (code === 'app_release_version_taken') return t('versionTaken');
    if (code === 'app_release_too_large') return t('tooLarge');
    if (code === 'invalid_apk') return t('invalidApk');
    if (code === 'apk_version_required') return t('versionRequired');
    if (code === 'apk_version_mismatch') return withMsg(t('versionMismatch'));
    if (code === 'invalid_installer') return t('invalidInstaller');
    if (code === 'windows_version_required') return t('windowsVersionRequired');
    if (code === 'windows_version_invalid') return t('windowsVersionInvalid');
    if (code === 'version_code_mismatch') return withMsg(t('versionCodeMismatch'));
    if (code === 'rollout_percent_invalid') return t('rolloutPercentInvalid');
    if (code === 'install_window_invalid') return t('installWindowInvalid');
    if (code === 'downgrade_not_supported_on_android') return t('downgradeAndroid');
    if (code === 'app_release_assignment_cancelled') return t('assignmentCancelled');
    if (code === 'invalid_platform') return t('invalidPlatform');
    if (code === 'invalid_bundle') return withMsg(t('invalidBundle'));
    if (code === 'bundle_version_mismatch') return withMsg(t('bundleVersionMismatch'));
    if (code === 'app_release_retired') return t('retired');
    if (code === 'app_release_file_deleted') return t('fileDeleted');
    if (code === 'app_release_has_assignments') return t('fileHasAssignments');
    if (code === 'app_release_latest') return t('fileLatest');
    if (code === 'app_release_not_retired') return t('fileNotRetired');
    if (code === 'app_release_file_delete_failed') return t('fileDeleteFailed');
    if (code === 'app_release_file_missing') return t('fileMissing');
    if (code === 'app_release_sha_mismatch') return t('shaMismatch');
    if (code === 'app_release_version_mismatch') return withMsg(t('releaseVersionMismatch'));
    if (code === 'app_release_storage_unavailable') return t('storageUnavailable');
    if (code === 'cleanup_confirm_required') return t('cleanupConfirmRequired');
    if (code === 'keep_invalid') return t('keepInvalid');
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
  const [platform, setPlatform] = useState<PlatformFilter>('all');
  const { data: releases = [], isLoading } = useQuery<AppRelease[]>({
    queryKey: ['app-releases'],
    queryFn: () => fetchAppReleases(),
  });
  const { data: storage } = useQuery<AppReleaseStorageStatus>({
    queryKey: ['app-release-storage'],
    queryFn: fetchAppReleaseStorageStatus,
    staleTime: 5 * 60_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <PlatformSwitch value={platform} onChange={setPlatform} withAll />
      </div>
      {storage?.ephemeral ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('storageWarning')}</span>
        </div>
      ) : null}
      <ReleasesCard releases={releases} loading={isLoading} platform={platform} />
      <SendCard releases={releases} platform={platform} />
      <AssignmentsCard releases={releases} platform={platform} />
      <RolloutCard platform={platform} />
    </div>
  );
}

// ── Platform switch and badge ────────────────────────────────────────────────

function PlatformSwitch({
  value,
  onChange,
  withAll = false,
}: {
  value: PlatformFilter;
  onChange: (v: PlatformFilter) => void;
  withAll?: boolean;
}) {
  const t = useTranslations('appUpdates');
  const options: PlatformFilter[] = withAll ? ['all', ...APP_PLATFORMS] : [...APP_PLATFORMS];
  return (
    <div role="radiogroup" aria-label={t('platform')} className="inline-flex rounded-lg border p-0.5">
      {options.map((o) => (
        <Button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          size="sm"
          variant={value === o ? 'default' : 'ghost'}
          onClick={() => onChange(o)}
        >
          {t(`platforms.${o}`)}
        </Button>
      ))}
    </div>
  );
}

function PlatformBadge({ platform }: { platform?: string | null }) {
  const t = useTranslations('appUpdates');
  const p = platformOf({ platform });
  return (
    <Badge
      variant="outline"
      className={cn(
        p === 'windows' || p === 'windows7'
          ? 'border-sky-300 text-sky-800 dark:border-sky-800 dark:text-sky-300'
          : p === 'kiosk_web'
            ? 'border-violet-300 text-violet-800 dark:border-violet-800 dark:text-violet-300'
            : 'border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300',
      )}
    >
      {t(`platforms.${p}`)}
    </Badge>
  );
}

// ── Releases: upload and list ────────────────────────────────────────────────

function ReleasesCard({
  releases,
  loading,
  platform,
}: {
  releases: AppRelease[];
  loading: boolean;
  platform: PlatformFilter;
}) {
  const t = useTranslations('appUpdates');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useAppUpdateErrorText();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadPlatform, setUploadPlatform] = useState<AppPlatform>(platform === 'all' ? 'android' : platform);
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

  const isWindows = isWindowsPlatform(uploadPlatform);
  // A kiosk web bundle carries its version in its manifest.json: no version fields.
  const isKioskWeb = uploadPlatform === 'kiosk_web';
  const nameFromFile = isWindows ? versionFromInstallerName(file?.name) : null;
  const windowsName = versionName.trim() || nameFromFile || '';
  const windowsCode = isWindows && windowsName ? windowsVersionCode(windowsName) : null;
  const windowsNameInvalid = isWindows && versionName.trim() !== '' && windowsCode === null;
  const windowsNameMissing = isWindows && !!file && !windowsName;

  const upload = useMutation({
    mutationFn: () =>
      uploadAppRelease(
        file as File,
        {
          platform: uploadPlatform,
          versionName: !isKioskWeb ? versionName.trim() || undefined : undefined,
          versionCode: !isWindows && !isKioskWeb && versionCode.trim() ? Number(versionCode) : undefined,
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

  const codeInvalid =
    !isWindows && !isKioskWeb && versionCode.trim() !== '' && !/^[1-9][0-9]*$/.test(versionCode.trim());
  const shown = filterByPlatform(releases, platform);
  const newestIds = newestActiveIds(releases);
  const [deleting, setDeleting] = useState<AppRelease | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{t('releasesTitle')}</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setCleanupOpen(true)}>
          <Eraser className="h-4 w-4 ms-1" />
          {t('cleanup.button')}
        </Button>
      </CardHeader>
      <FileDeleteDialog release={deleting} onClose={() => setDeleting(null)} />
      <CleanupDialog open={cleanupOpen} platform={platform} onClose={() => setCleanupOpen(false)} />
      <CardContent className="space-y-4">
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{t('uploadTitle')}</p>
            <PlatformSwitch
              value={uploadPlatform}
              onChange={(p) => {
                if (p === 'all') return;
                setUploadPlatform(p);
                reset();
              }}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1 lg:col-span-2">
              <Label htmlFor="release-file">
                {isWindows ? t('fileInstaller') : isKioskWeb ? t('fileBundle') : t('file')}
              </Label>
              <Input
                id="release-file"
                ref={fileRef}
                type="file"
                accept={ACCEPT[uploadPlatform]}
                onChange={(e) => {
                  const chosen = e.target.files?.[0] ?? null;
                  setFile(chosen);
                  const guessed = platformOfFile(chosen?.name);
                  if (guessed && guessed !== uploadPlatform) setUploadPlatform(guessed);
                }}
              />
            </div>
            {isKioskWeb ? null : (
              <div className="space-y-1">
                <Label htmlFor="release-version-name">{t('versionName')}</Label>
                <Input
                  id="release-version-name"
                  dir="ltr"
                  value={versionName}
                  maxLength={64}
                  placeholder={isWindows ? nameFromFile ?? t('fromFileName') : t('fromApk')}
                  aria-invalid={windowsNameInvalid || windowsNameMissing || undefined}
                  onChange={(e) => setVersionName(e.target.value)}
                />
                {isWindows && windowsCode !== null ? (
                  <p className="text-muted-foreground text-xs tabular-nums" dir="rtl">
                    {t('windowsCodePreview', { code: windowsCode })}
                  </p>
                ) : null}
              </div>
            )}
            {isWindows || isKioskWeb ? null : (
              <div className="space-y-1">
                <Label htmlFor="release-version-code">{t('versionCode')}</Label>
                <Input
                  id="release-version-code"
                  dir="ltr"
                  inputMode="numeric"
                  value={versionCode}
                  placeholder={t('fromApk')}
                  aria-invalid={codeInvalid || undefined}
                  onChange={(e) => setVersionCode(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-1 sm:col-span-2 lg:col-span-4">
              <Label htmlFor="release-notes">{t('notes')}</Label>
              <textarea
                id="release-notes"
                className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={notes}
                maxLength={4000}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            {isWindows ? t('uploadHintWindows') : isKioskWeb ? t('uploadHintKioskWeb') : t('uploadHint')}
          </p>
          {windowsNameInvalid ? (
            <p className="text-destructive text-xs">{t('errors.windowsVersionInvalid')}</p>
          ) : windowsNameMissing ? (
            <p className="text-destructive text-xs">{t('errors.windowsVersionRequired')}</p>
          ) : null}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              disabled={!file || codeInvalid || windowsNameInvalid || windowsNameMissing || upload.isPending}
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
                <TableHead>{t('platform')}</TableHead>
                <TableHead>{t('size')}</TableHead>
                <TableHead>{t('uploadedAt')}</TableHead>
                <TableHead>{t('notes')}</TableHead>
                <TableHead>{t('assignments')}</TableHead>
                <TableHead>{tc('active')}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">{t('fileDelete.action')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ) : shown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    {t('noReleases')}
                  </TableCell>
                </TableRow>
              ) : (
                shown.map((r) => {
                  const block = fileDeleteBlock(r, newestIds);
                  return (
                  <TableRow key={r.id} className={cn(!r.isActive && 'text-muted-foreground')}>
                    <TableCell>
                      <div className="font-medium font-mono text-xs" dir="ltr">
                        {r.versionName}
                      </div>
                      <div className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                        {t('codeShort', { code: r.versionCode })}
                      </div>
                      {r.bridgeApi != null ? (
                        <div className="text-violet-700 dark:text-violet-300 text-xs tabular-nums" dir="ltr">
                          {t('bridgeApiShort', { n: r.bridgeApi })}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <PlatformBadge platform={r.platform} />
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <span dir="ltr" className={cn(r.fileDeletedAt && 'line-through')}>
                        {formatBytes(r.sizeBytes)}
                      </span>
                      {r.fileDeletedAt ? (
                        <div>
                          <Badge
                            variant="outline"
                            className="border-rose-300 text-rose-800 dark:border-rose-800 dark:text-rose-300"
                            title={formatWhen(r.fileDeletedAt)}
                          >
                            {t('fileDelete.deletedBadge')}
                          </Badge>
                        </div>
                      ) : fileMissing(r) ? (
                        <div className="mt-1 space-y-1">
                          <Badge
                            variant="outline"
                            className="h-auto whitespace-normal border-amber-300 text-start text-amber-800 dark:border-amber-800 dark:text-amber-300"
                            title={t('fileMissing.hint')}
                          >
                            {t('fileMissing.badge')}
                          </Badge>
                          <ReuploadButton release={r} />
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">{formatWhen(r.createdAt)}</TableCell>
                    <TableCell className="max-w-72 whitespace-pre-wrap text-xs">{r.notes ?? ''}</TableCell>
                    <TableCell className="tabular-nums">{r.assignmentCount}</TableCell>
                    <TableCell>
                      <Switch
                        checked={r.isActive}
                        disabled={toggle.isPending || !!r.fileDeletedAt}
                        onCheckedChange={() => {
                          if (r.isActive && !window.confirm(t('retireConfirm', { version: r.versionName }))) {
                            return;
                          }
                          toggle.mutate(r);
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      {block === 'deleted' ? null : (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t('fileDelete.action')}
                          title={block ? t(`fileDelete.blocked.${block}`) : t('fileDelete.action')}
                          disabled={block !== null}
                          onClick={() => setDeleting(r)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
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

// ── Uploading a missing file again ───────────────────────────────────────────

/** "העלאה מחדש": pick the same build's file; the server checks its SHA-256 and version. */
function ReuploadButton({ release }: { release: AppRelease }) {
  const t = useTranslations('appUpdates');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useAppUpdateErrorText();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const reupload = useMutation({
    mutationFn: (file: File) => reuploadAppReleaseFile(release.id, file, setProgress),
    onSuccess: (r) => {
      setProgress(null);
      invalidateReleases(qc);
      toast.success(t('fileMissing.done', { version: r.versionName }));
    },
    onError: (err: unknown) => {
      setProgress(null);
      toast.error(errorText(err, tc('error')));
    },
  });
  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={ACCEPT[platformOf(release)]}
        aria-label={t('fileMissing.reupload')}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          e.target.value = '';
          if (chosen) reupload.mutate(chosen);
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={reupload.isPending}
        title={t('fileMissing.hint')}
        onClick={() => inputRef.current?.click()}
      >
        <RotateCcw className="h-4 w-4 ms-1" />
        {reupload.isPending ? t('fileMissing.reuploading') : t('fileMissing.reupload')}
      </Button>
      {progress !== null ? (
        <span className="text-muted-foreground text-xs tabular-nums">{Math.round(progress * 100)}%</span>
      ) : null}
    </div>
  );
}

// ── Deleting old files ───────────────────────────────────────────────────────

function invalidateReleases(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['app-releases'] });
  qc.invalidateQueries({ queryKey: ['app-release-assignments'] });
  qc.invalidateQueries({ queryKey: ['app-release-rollout'] });
}

/** A refusal code as the page's error text (the reasons the server lists). */
function codeText(errorText: ReturnType<typeof useAppUpdateErrorText>, code: string): string {
  return errorText({ response: { data: { detail: code } } }, code);
}

/** "מחיקת קובץ": the server's check first (guards + devices still on it), then one confirm. */
function FileDeleteDialog({ release, onClose }: { release: AppRelease | null; onClose: () => void }) {
  const t = useTranslations('appUpdates');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useAppUpdateErrorText();
  const check = useQuery({
    queryKey: ['app-release-file-check', release?.id],
    queryFn: () => fetchAppReleaseFileDeleteCheck(release!.id),
    enabled: release !== null,
    staleTime: 0,
    gcTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => deleteAppReleaseFile(release!.id, !!check.data?.needsRetire),
    onSuccess: (out) => {
      invalidateReleases(qc);
      toast.success(t('fileDelete.done', { version: out.release.versionName, size: formatBytes(out.freedBytes) }));
      onClose();
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });
  const data = check.data;

  return (
    <Dialog open={release !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('fileDelete.title', { version: release?.versionName ?? '' })}</DialogTitle>
          <DialogDescription>{t('fileDelete.explain')}</DialogDescription>
        </DialogHeader>
        {check.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : check.isError ? (
          <p className="text-destructive text-sm">{errorText(check.error, tc('error'))}</p>
        ) : data ? (
          <div className="space-y-2 text-sm">
            <p>
              {t('fileDelete.size')}:{' '}
              <span dir="ltr" className="tabular-nums">
                {formatBytes(data.sizeBytes)}
              </span>
            </p>
            {data.reasons.length > 0 ? (
              <ul className="text-destructive list-disc ps-5">
                {data.reasons.map((code) => (
                  <li key={code}>{codeText(errorText, code)}</li>
                ))}
              </ul>
            ) : null}
            {data.allowed && data.needsRetire ? (
              <p className="text-amber-700 dark:text-amber-400">{t('fileDelete.alsoRetire')}</p>
            ) : null}
            {data.devicesOnVersion > 0 ? (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                {t('fileDelete.devicesWarning', { count: data.devicesOnVersion })}
              </p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button variant="destructive" disabled={!data?.allowed || remove.isPending} onClick={() => remove.mutate()}>
            <Trash2 className="h-4 w-4 ms-1" />
            {remove.isPending
              ? t('fileDelete.deleting')
              : data?.needsRetire
                ? t('fileDelete.confirmRetire')
                : t('fileDelete.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function reasonsText(row: AppReleaseCleanupRow, errorText: ReturnType<typeof useAppUpdateErrorText>): string {
  return row.reasons.map((code) => codeText(errorText, code)).join(' · ');
}

/**
 * "ניקוי גרסאות ישנות": per platform keep the newest N (default 3) releases that still have
 * their file; preview what goes (and the space it frees), confirm by typing "מחק".
 */
function CleanupDialog({
  open,
  platform,
  onClose,
}: {
  open: boolean;
  platform: PlatformFilter;
  onClose: () => void;
}) {
  const t = useTranslations('appUpdates');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useAppUpdateErrorText();
  const [keepText, setKeepText] = useState(String(CLEANUP_DEFAULT_KEEP));
  const [typed, setTyped] = useState('');
  const keep = parseKeep(keepText);
  const only = platform === 'all' ? undefined : platform;
  const preview = useQuery({
    queryKey: ['app-release-cleanup', keep, only],
    queryFn: () => fetchAppReleaseCleanup(keep as number, only),
    enabled: open && keep !== null,
    staleTime: 0,
    gcTime: 0,
  });
  const ids = (preview.data?.platforms ?? []).flatMap((p) => p.delete.map((r) => r.releaseId));
  const close = () => {
    setTyped('');
    onClose();
  };
  const run = useMutation({
    mutationFn: () =>
      runAppReleaseCleanup({ keep: keep as number, platform: only, releaseIds: ids, confirm: typed.trim() }),
    onSuccess: (out) => {
      invalidateReleases(qc);
      qc.invalidateQueries({ queryKey: ['app-release-cleanup'] });
      if (out.failed.length > 0) {
        toast.warning(
          t('cleanup.partial', { count: out.deleted.length, failed: out.failed.length, size: formatBytes(out.freedBytes) }),
        );
      } else {
        toast.success(t('cleanup.done', { count: out.deleted.length, size: formatBytes(out.freedBytes) }));
      }
      close();
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? close() : undefined)}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('cleanup.title')}</DialogTitle>
          <DialogDescription>{t('cleanup.explain')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Label htmlFor="cleanup-keep">{t('cleanup.keep')}</Label>
          <Input
            id="cleanup-keep"
            dir="ltr"
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            className="h-8 w-20"
            value={keepText}
            aria-invalid={keep === null || undefined}
            onChange={(e) => setKeepText(e.target.value)}
          />
          <span className="text-muted-foreground text-xs">
            {platform === 'all' ? t('cleanup.perPlatform') : t(`platforms.${platform}`)}
          </span>
        </div>
        {keep === null ? <p className="text-destructive text-xs">{t('errors.keepInvalid')}</p> : null}
        {preview.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : preview.isError ? (
          <p className="text-destructive text-sm">{errorText(preview.error, tc('error'))}</p>
        ) : preview.data ? (
          <div className="space-y-3">
            {preview.data.platforms.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('cleanup.nothing')}</p>
            ) : (
              preview.data.platforms.map((p) => (
                <div key={p.platform} className="space-y-1 rounded-lg border p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <PlatformBadge platform={p.platform} />
                    <span className="text-muted-foreground text-xs">
                      {t('cleanup.platformSummary', {
                        kept: p.kept.length,
                        count: p.delete.length,
                        size: formatBytes(p.totalBytes),
                      })}
                    </span>
                  </div>
                  {p.delete.length > 0 ? (
                    <ul className="space-y-0.5 text-sm">
                      {p.delete.map((r) => (
                        <li key={r.releaseId} className="flex flex-wrap items-center gap-x-2">
                          <span className="font-mono text-xs" dir="ltr">
                            {r.versionName}
                          </span>
                          <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                            {formatBytes(r.sizeBytes)}
                          </span>
                          {r.isActive ? (
                            <span className="text-amber-700 dark:text-amber-400 text-xs">{t('cleanup.willRetire')}</span>
                          ) : null}
                          {r.devicesOnVersion > 0 ? (
                            <span className="text-amber-700 dark:text-amber-400 text-xs">
                              {t('cleanup.devicesOn', { count: r.devicesOnVersion })}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {p.skipped.length > 0 ? (
                    <ul className="text-muted-foreground space-y-0.5 text-xs">
                      {p.skipped.map((r) => (
                        <li key={r.releaseId}>
                          <span className="font-mono" dir="ltr">
                            {r.versionName}
                          </span>{' '}
                          — {t('cleanup.skipped')}: {reasonsText(r, errorText)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))
            )}
            <p className="text-sm font-medium">
              {t('cleanup.total', { count: preview.data.totalCount, size: formatBytes(preview.data.totalBytes) })}
            </p>
            {preview.data.totalCount > 0 ? (
              <div className="space-y-1">
                <Label htmlFor="cleanup-confirm">{t('cleanup.typeToConfirm', { word: CLEANUP_CONFIRM_WORD })}</Label>
                <Input
                  id="cleanup-confirm"
                  className="max-w-40"
                  value={typed}
                  autoComplete="off"
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {tc('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={ids.length === 0 || !cleanupConfirmed(typed) || keep === null || run.isPending}
            onClick={() => run.mutate()}
          >
            <Trash2 className="h-4 w-4 ms-1" />
            {run.isPending ? t('fileDelete.deleting') : t('cleanup.run', { count: ids.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Send ─────────────────────────────────────────────────────────────────────

function SendCard({ releases, platform }: { releases: AppRelease[]; platform: PlatformFilter }) {
  const t = useTranslations('appUpdates');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useAppUpdateErrorText();
  const activeTenantId = useAuth((s) => s.activeTenantId);
  const [releaseId, setReleaseId] = useState('');
  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const [autoInstall, setAutoInstall] = useState(false);
  const [percentText, setPercentText] = useState('100');
  const [allowDowngrade, setAllowDowngrade] = useState(false);
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');

  // A release whose file was deleted can never be sent again.
  const active = filterByPlatform(releases.filter(canSend), platform);
  const release = active.find((r) => r.id === releaseId) ?? null;
  const releasePlatform = release ? platformOf(release) : null;
  const isWindows = isWindowsPlatform(releasePlatform);
  // Rollback and the install window: the Windows app and kiosk web bundles (never Android).
  const canRollback = allowsDowngrade(releasePlatform);
  const target = deepestOrgScope(scope);
  const targetId = target ? (target.level === 'tenant' ? activeTenantId : target.id) : null;
  const percent = parseRolloutPercent(percentText);
  const window_ = canRollback ? checkInstallWindow(windowStart, windowEnd) : ({ ok: true, window: null } as const);

  const send = useMutation({
    mutationFn: () =>
      createAppReleaseAssignment(releaseId, {
        level: target!.level,
        targetId: targetId as string,
        autoInstall,
        rolloutPercent: percent ?? 100,
        allowDowngrade: canRollback && allowDowngrade,
        installWindow: window_.ok ? window_.window : null,
      }),
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ['app-releases'] });
      qc.invalidateQueries({ queryKey: ['app-release-assignments'] });
      qc.invalidateQueries({ queryKey: ['app-release-rollout'] });
      toast.success(t('sent', { count: a.machineCount }));
      setScope(EMPTY_ORG_SCOPE);
      setAutoInstall(false);
      setPercentText('100');
      setAllowDowngrade(false);
      setWindowStart('');
      setWindowEnd('');
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });

  const releaseItems = active.map((r) => ({
    value: r.id,
    label: `${r.versionName} (${t('codeShort', { code: r.versionCode })})${
      platform === 'all' ? ` · ${t(`platforms.${platformOf(r)}`)}` : ''
    }`,
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
        <div className="space-y-1 max-w-48">
          <Label htmlFor="rollout-percent">{t('rolloutPercent')}</Label>
          <div className="flex items-center gap-1.5">
            <Input
              id="rollout-percent"
              dir="ltr"
              inputMode="numeric"
              type="number"
              min={1}
              max={100}
              value={percentText}
              aria-invalid={percent === null || undefined}
              onChange={(e) => setPercentText(e.target.value)}
            />
            <span className="text-muted-foreground text-sm">%</span>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">{t('rolloutHint')}</p>
        {percent === null ? <p className="text-destructive text-xs">{t('errors.rolloutPercentInvalid')}</p> : null}
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
        {canRollback ? (
          <div className="space-y-3 rounded-lg border p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={allowDowngrade}
                onChange={(e) => setAllowDowngrade(e.target.checked)}
              />
              {t('allowDowngrade')}
            </label>
            <p className="text-muted-foreground text-xs">
              {isWindows ? t('allowDowngradeHint') : t('allowDowngradeHintKioskWeb')}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{t('installWindowFrom')}</span>
              <TimeInput
                dir="ltr"
                className="w-28"
                aria-label={t('installWindowFrom')}
                value={windowStart}
                aria-invalid={!window_.ok || undefined}
                onChange={(e) => setWindowStart(e.target.value)}
              />
              <span>{t('installWindowTo')}</span>
              <TimeInput
                dir="ltr"
                className="w-28"
                aria-label={t('installWindowTo')}
                value={windowEnd}
                aria-invalid={!window_.ok || undefined}
                onChange={(e) => setWindowEnd(e.target.value)}
              />
              <span className="text-muted-foreground text-xs">{t('installWindowOptional')}</span>
            </div>
            <p className="text-muted-foreground text-xs">
              {isWindows ? t('installWindowHint') : t('installWindowHintKioskWeb')}
            </p>
            {!window_.ok ? <p className="text-destructive text-xs">{t('errors.installWindowInvalid')}</p> : null}
          </div>
        ) : releasePlatform === 'android' ? (
          <p className="text-muted-foreground text-xs">{t('androidNoRollback')}</p>
        ) : null}
        <Button
          size="sm"
          disabled={!release || !target || !targetId || percent === null || !window_.ok || send.isPending}
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

/** The rollout percent of one live assignment, editable in place (PATCH). */
function RolloutPercentCell({ assignment }: { assignment: AppReleaseAssignment }) {
  const t = useTranslations('appUpdates');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useAppUpdateErrorText();
  const current = assignment.rolloutPercent ?? 100;
  const [text, setText] = useState(String(current));
  const percent = parseRolloutPercent(text);
  const dirty = percent !== null && percent !== current;

  const save = useMutation({
    mutationFn: () => updateAppReleaseAssignment(assignment.id, { rolloutPercent: percent ?? current }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-release-assignments'] });
      qc.invalidateQueries({ queryKey: ['app-release-rollout'] });
      toast.success(t('percentUpdated'));
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });

  return (
    <div className="flex items-center gap-1">
      <Input
        dir="ltr"
        type="number"
        inputMode="numeric"
        min={1}
        max={100}
        className="h-7 w-16 text-xs"
        aria-label={t('rolloutPercent')}
        value={text}
        aria-invalid={percent === null || undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && dirty && !save.isPending) save.mutate();
        }}
      />
      <span className="text-muted-foreground text-xs">%</span>
      {dirty ? (
        <Button size="xs" variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>
          {t('save')}
        </Button>
      ) : null}
    </div>
  );
}

function AssignmentsCard({ releases, platform }: { releases: AppRelease[]; platform: PlatformFilter }) {
  const t = useTranslations('appUpdates');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useAppUpdateErrorText();

  const withAssignments = filterByPlatform(releases, platform).filter((r) => r.assignmentCount > 0);
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
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('version')}</TableHead>
                <TableHead>{t('platform')}</TableHead>
                <TableHead>{t('level')}</TableHead>
                <TableHead>{t('target')}</TableHead>
                <TableHead>{t('tills')}</TableHead>
                <TableHead>{t('rollout')}</TableHead>
                <TableHead>{t('autoInstallShort')}</TableHead>
                <TableHead>{t('window')}</TableHead>
                <TableHead>{t('sentAt')}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={10}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="py-6 text-center text-muted-foreground">
                    {t('noAssignments')}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs" dir="ltr">
                      {a.versionName}
                      {a.allowDowngrade ? (
                        <div className="font-sans text-amber-700 dark:text-amber-400">{t('rollbackShort')}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <PlatformBadge platform={a.platform} />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{t(`levels.${a.level}`)}</Badge>
                    </TableCell>
                    <TableCell className={a.targetName ? '' : 'text-muted-foreground'}>
                      {targetLabel(a)}
                    </TableCell>
                    <TableCell className="tabular-nums">{a.machineCount}</TableCell>
                    <TableCell>
                      <RolloutPercentCell key={`${a.id}:${a.rolloutPercent ?? 100}`} assignment={a} />
                    </TableCell>
                    <TableCell>{a.autoInstall ? tc('yes') : tc('no')}</TableCell>
                    <TableCell className="text-xs tabular-nums" dir="ltr">
                      {a.installWindow
                        ? t('installWindowShort', { start: a.installWindow.start, end: a.installWindow.end })
                        : <span dir="rtl" className="text-muted-foreground">{t('anyTime')}</span>}
                    </TableCell>
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

/** What the badge says: the device's last report, else "installed" if it already runs the
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

function RolloutCard({ platform }: { platform: PlatformFilter }) {
  const t = useTranslations('appUpdates');
  const [companyId, setCompanyId] = useState('');
  const [shopId, setShopId] = useState('');
  const [behindOnly, setBehindOnly] = useState(false);

  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ['companies'], queryFn: fetchCompanies });
  const { data: shops = [] } = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });
  // Every platform in one request: the counts of devices behind are per platform.
  const { data: allRows = [], isLoading } = useQuery<AppReleaseRolloutRow[]>({
    queryKey: ['app-release-rollout', companyId, shopId],
    queryFn: () => fetchAppReleaseRollout({ companyId: companyId || undefined, shopId: shopId || undefined }),
    refetchInterval: ROLLOUT_REFRESH_MS,
  });

  const companyShops = companyId ? shops.filter((s) => s.companyId === companyId) : shops;
  const behind = behindCounts(allRows);
  const rows = onlyBehind(filterByPlatform(allRows, platform), behindOnly);
  const countedPlatforms = platform === 'all' ? APP_PLATFORMS : [platform];
  // The kiosk web rows' own column (what the kiosk shows, what is configured, why it fell back).
  const showWeb = platform === 'all' || platform === 'kiosk_web';
  // +1: "עדכון שקט" (components/dashboard/machines/device-management.tsx).
  const columns = (showWeb ? 10 : 9) + 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('rolloutTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
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
          <label className="flex h-8 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={behindOnly}
              onChange={(e) => setBehindOnly(e.target.checked)}
            />
            {t('onlyBehind')}
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {countedPlatforms.map((p) => (
            <span
              key={p}
              className={cn(
                'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                behind[p] > 0
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {t('behindCount', { platform: t(`platforms.${p}`), count: behind[p] })}
            </span>
          ))}
        </div>
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('company')}</TableHead>
                <TableHead>{t('shop')}</TableHead>
                <TableHead>{t('area')}</TableHead>
                <TableHead>{t('device')}</TableHead>
                <TableHead>{t('platform')}</TableHead>
                <TableHead>{t('deviceRole')}</TableHead>
                <TableHead>{t('currentVersion')}</TableHead>
                <TableHead>{t('targetVersion')}</TableHead>
                <TableHead>{t('status')}</TableHead>
                <TableHead>עדכון שקט</TableHead>
                {showWeb ? <TableHead>{t('renderer')}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={columns}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns} className="py-6 text-center text-muted-foreground">
                    {t('noTills')}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const state = rolloutState(row);
                  return (
                    <TableRow
                      key={rolloutRowKey(row)}
                      className={cn(row.behind && 'bg-amber-50/70 dark:bg-amber-950/30')}
                    >
                      <TableCell>{row.companyName ?? ''}</TableCell>
                      <TableCell>{row.shopName ?? ''}</TableCell>
                      <TableCell className={row.areaName ? '' : 'text-muted-foreground'}>
                        {row.areaName ?? t('noArea')}
                      </TableCell>
                      <TableCell className="font-medium">{row.machineName}</TableCell>
                      <TableCell>
                        <PlatformBadge platform={row.platform} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.deviceRole === 'kiosk' || row.deviceRole === 'till'
                          ? t(`roles.${row.deviceRole}`)
                          : row.deviceRole ?? ''}
                      </TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">
                        {row.currentVersion ?? '—'}
                        {row.behindNewest && row.newestVersion ? (
                          <div className="font-sans text-muted-foreground" dir="rtl">
                            {t('newest', { version: row.newestVersion })}
                          </div>
                        ) : null}
                        {row.bundleSource === 'bundled' || row.bundleSource === 'downloaded' ? (
                          <div className="font-sans text-muted-foreground" dir="rtl">
                            {t(`bundleSources.${row.bundleSource}`)}
                          </div>
                        ) : null}
                        {row.pendingVersion ? (
                          <div className="font-sans text-sky-700 dark:text-sky-300" dir="rtl">
                            {t('pendingVersion', { version: row.pendingVersion })}
                          </div>
                        ) : null}
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
                            <div className="flex flex-wrap items-center gap-1">
                              <span
                                className={cn(
                                  'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                                  STATUS_STYLE[state],
                                )}
                              >
                                {t(`statuses.${state}`)}
                              </span>
                              {row.behind ? (
                                <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                                  {t('behind')}
                                </span>
                              ) : null}
                            </div>
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
                      <TableCell>
                        <SilentUpdateCell
                          target={{
                            id: row.machineId,
                            name: row.machineName,
                            shopId: row.shopId,
                            platform: row.platform,
                            deviceManagement: reportOfRolloutRow(row),
                          }}
                        />
                      </TableCell>
                      {showWeb ? (
                        <TableCell>
                          <RendererCell row={row} />
                        </TableCell>
                      ) : null}
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

/** A kiosk web row's renderer: what the kiosk shows now, what is configured, why it fell back. */
function RendererCell({ row }: { row: AppReleaseRolloutRow }) {
  const t = useTranslations('appUpdates');
  if (platformOf(row) !== 'kiosk_web') return null;
  if (row.renderer !== 'native' && row.renderer !== 'web') {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  const configured =
    row.rendererConfigured === 'native' || row.rendererConfigured === 'web' ? row.rendererConfigured : null;
  const reason = knownFallbackReason(row.fallbackReason);
  return (
    <div className="space-y-0.5 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <span
          className={cn(
            'inline-block rounded-full px-2 py-0.5 font-medium',
            row.renderer === 'web'
              ? 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {t(`renderers.${row.renderer}`)}
        </span>
        {configured ? (
          <span className="text-muted-foreground">
            {t('rendererConfigured', { renderer: t(`renderers.${configured}`) })}
          </span>
        ) : null}
      </div>
      {row.fallbackReason ? (
        <div className="text-amber-700 dark:text-amber-400" dir="auto">
          {reason ? t(`fallbackReasons.${reason}`) : row.fallbackReason}
        </div>
      ) : null}
      {row.webStatusMessage ? (
        <div className="max-w-64 break-words text-muted-foreground" dir="auto">
          {row.webStatusMessage}
        </div>
      ) : null}
      {row.webStatusAt ? <div className="text-muted-foreground">{formatWhen(row.webStatusAt)}</div> : null}
    </div>
  );
}
