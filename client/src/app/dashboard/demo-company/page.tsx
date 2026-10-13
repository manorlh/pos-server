'use client';

/**
 * "חברת הדגמה" — the summary after "בניית חברת הדגמה" (P:/specs/demo-company.md; pos-server
 * app/routers/demo_company.py). The super admin's page: the company and what it still needs for a
 * legal invoice, each shop's devices with a live pairing code to type on each, what to try in each
 * shop, and — right after a build — what it made and what failed.
 *
 * Codes live 15 minutes: "השלמה וקודים חדשים" gives a new one to every device not paired yet (and
 * completes anything missing; nothing the owner changed is touched).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  deviceState,
  formatCode,
  minutesLeft,
  pairingProgress,
  type DemoCompanySummary,
  type DemoDevice,
  type DemoShop,
} from '@/lib/demoCompany';
import { buildDemoCompany, DEMO_COMPANY_QUERY_KEY, fetchDemoCompany } from '@/lib/demoCompanyApi';
import { DEMO_COMPANY_LAST_BUILD_KEY, DemoCompanyDialog } from '@/components/dashboard/demo-company-dialog';
import { useIsSuperAdmin } from '@/components/dashboard/license-fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** "Now", every 30 seconds — the codes' minutes left. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export default function DemoCompanyPage() {
  const t = useTranslations('demoCompany');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const isSuperAdmin = useIsSuperAdmin();
  const now = useNow();
  const [dialogOpen, setDialogOpen] = useState(false);
  const summary = useQuery({ queryKey: DEMO_COMPANY_QUERY_KEY, queryFn: fetchDemoCompany, enabled: isSuperAdmin });
  const lastBuild = useQuery<DemoCompanySummary | null>({
    queryKey: DEMO_COMPANY_LAST_BUILD_KEY,
    queryFn: async () => null,
    enabled: false,
    staleTime: Infinity,
  });
  const refresh = useMutation({
    mutationFn: () => buildDemoCompany(),
    onSuccess: (out) => {
      qc.setQueryData(DEMO_COMPANY_LAST_BUILD_KEY, out);
      qc.setQueryData(DEMO_COMPANY_QUERY_KEY, out);
      toast.success(t('refreshed'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  if (!isSuperAdmin) {
    return <p className="text-sm text-muted-foreground">{t('superAdminOnly')}</p>;
  }
  const data = summary.data;
  const progress = pairingProgress(data?.shops, now);
  const build = lastBuild.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('pageTitle')}</h1>
          <p className="text-muted-foreground text-sm">{t('pageSubtitle')}</p>
        </div>
        {data?.exists ? (
          <Button size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw className={`h-4 w-4 ms-1 ${refresh.isPending ? 'animate-spin' : ''}`} aria-hidden />
            {refresh.isPending ? t('refreshing') : t('refresh')}
          </Button>
        ) : null}
      </div>

      {summary.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : summary.isError || !data ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(summary.error, tc('error'))}</p>
      ) : !data.exists ? (
        <Card>
          <CardContent className="space-y-3 pt-6 text-sm">
            <p>{t('notBuilt')}</p>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              {t('button')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <CompanyCard data={data} />
          {build ? <BuildOutcome build={build} /> : null}
          <p className="text-sm text-muted-foreground">
            {t('progress', { paired: progress.paired, total: progress.total })}
            {progress.expired > 0 ? ` ${t('someExpired')}` : ''}
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            {(data.shops ?? []).map((shop) => (
              <ShopCard key={shop.key} shop={shop} now={now} />
            ))}
          </div>
          <OwnerTodo data={data} />
          {(data.removedByOwner?.length ?? 0) > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{t('removedTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-xs text-muted-foreground">
                <p>{t('removedHint')}</p>
                <ul className="list-inside list-disc">
                  {data.removedByOwner!.map((r) => (
                    <li key={r.key}>{r.label}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
      <DemoCompanyDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

function CompanyCard({ data }: { data: DemoCompanySummary }) {
  const t = useTranslations('demoCompany');
  const c = data.company!;
  const missing = data.missingDetails ?? [];
  const row = (label: string, value: string | null | undefined) => (
    <div className="flex gap-2">
      <span className="text-muted-foreground">{label}:</span>
      <span>{value?.trim() ? value : '—'}</span>
    </div>
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Link href={`/dashboard/companies/${c.id}`} className="hover:underline">
            {c.name}
          </Link>
          <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
            {t('live')}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid gap-1 sm:grid-cols-2">
          {row(t('details.vatNumber'), c.vatNumber)}
          {row(t('details.address'), [c.address, c.city].filter(Boolean).join(', '))}
          {row(t('details.phone'), c.phone)}
        </div>
        {missing.length > 0 ? (
          <p className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('missing', { fields: missing.map((m) => t(`details.${m}`)).join(', ') })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BuildOutcome({ build }: { build: DemoCompanySummary }) {
  const t = useTranslations('demoCompany');
  const created = build.created ?? [];
  const failed = build.failed ?? [];
  const notes = build.notes ?? [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {created.length > 0 ? t('createdTitle', { count: created.length }) : t('nothingNew')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {created.length > 0 ? (
          <ul className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {created.map((c) => (
              <li key={c.key} className="flex items-start gap-1.5">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
                <span>{c.label}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {failed.length > 0 ? (
          <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2">
            <p className="font-medium text-destructive">{t('failedTitle', { count: failed.length })}</p>
            <ul className="list-inside list-disc text-xs">
              {failed.map((f) => (
                <li key={f.key}>
                  {f.label}: {f.message}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t('failedHint')}</p>
          </div>
        ) : null}
        {notes.map((n) => (
          <p key={n} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

function ShopCard({ shop, now }: { shop: DemoShop; now: Date }) {
  const t = useTranslations('demoCompany');
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {shop.id ? (
            <Link href={`/dashboard/shops/${shop.id}`} className="hover:underline">
              {shop.name}
            </Link>
          ) : (
            shop.name
          )}
          {!shop.present ? <Badge variant="secondary">{t('shopRemoved')}</Badge> : null}
          {shop.trainingMode ? <Badge variant="secondary">{t('training')}</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-2">
          <p className="font-medium">{t('devicesTitle')}</p>
          <ul className="divide-y rounded-md border">
            {shop.devices.map((d) => (
              <DeviceRow key={d.key} device={d} now={now} />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('devicesHint')}</p>
        </div>
        <div className="space-y-1">
          <p className="font-medium">{t('checklistTitle')}</p>
          <ol className="list-inside list-decimal space-y-0.5 text-muted-foreground">
            {shop.checklist.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

function DeviceRow({ device, now }: { device: DemoDevice; now: Date }) {
  const t = useTranslations('demoCompany.device');
  const state = deviceState(device, now);
  const left = minutesLeft(device.expiresAt, now);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div>
        <p>{device.label}</p>
        <p className="text-xs text-muted-foreground">{device.roleLabel}</p>
      </div>
      {state === 'paired' ? (
        <Badge variant="outline" className="border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
          {device.machineName ? t('pairedAs', { name: device.machineName }) : t('paired')}
        </Badge>
      ) : state === 'waiting' && device.code ? (
        <div className="text-end">
          <p className="font-mono text-lg font-semibold tracking-widest" dir="ltr">
            {formatCode(device.code)}
          </p>
          <p className="text-xs text-muted-foreground">{t('minutesLeft', { minutes: left ?? 0 })}</p>
        </div>
      ) : (
        <Badge variant="secondary">{t('expired')}</Badge>
      )}
    </li>
  );
}

function OwnerTodo({ data }: { data: DemoCompanySummary }) {
  const t = useTranslations('demoCompany.todo');
  const toSet = data.employeesToSetCode ?? [];
  const items = [
    ...((data.missingDetails?.length ?? 0) > 0 ? ['details'] : []),
    'logo',
    'terminal',
    toSet.length > 0 ? 'codesRandom' : 'codes',
    'printers',
    'club',
  ];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="list-inside list-disc space-y-0.5 text-sm text-muted-foreground">
          {items.map((k) => (
            <li key={k}>
              {t(k)}
              {k === 'codesRandom' ? <span className="block ps-5 text-xs">{toSet.join(' · ')}</span> : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
