'use client';

/**
 * Accounting settings (הגדרות הנהלת חשבונות) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2.3.
 *
 * The account mapping of a company, or a shop's override of it: the scope bar picks the
 * level. A shop field left empty inherits the company's value (shown as its placeholder).
 * What an export can never go without is flagged at the top.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import {
  ACCOUNT_KEYS,
  CORE_ACCOUNT_KEYS,
  fetchAccountingSettings,
  saveAccountingSettings,
  type AccountKey,
  type AccountingSettings,
  type AccountingSettingsValues,
} from '@/lib/accountingApi';
import { CARD_ACQUIRERS, CARD_BRANDS, useCardBrandLabels } from '@/lib/cardBrands';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

const SELECT =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

interface FormState {
  movementType: string;
  branchCode: string;
  encoding: string;
  method: string;
  accounts: Record<string, string>;
  /** Code → account, one input per known brand / acquirer. */
  brands: Record<string, string>;
  acquirers: Record<string, string>;
  voucherSalesAsLiability: '' | 'true' | 'false';
  exportLevel: '' | 'company' | 'shop';
  consolidate: '' | 'true' | 'false';
  costCenter: string;
}

function toForm(v: AccountingSettingsValues | null | undefined): FormState {
  return {
    movementType: v?.movementType ?? '',
    branchCode: v?.branchCode ?? '',
    encoding: v?.encoding ?? '',
    method: v?.method ?? '',
    accounts: { ...(v?.accounts ?? {}) } as Record<string, string>,
    brands: { ...(v?.cardBrands ?? {}) },
    acquirers: { ...(v?.cardAcquirers ?? {}) },
    voucherSalesAsLiability:
      v?.voucherSalesAsLiability === undefined ? '' : v.voucherSalesAsLiability ? 'true' : 'false',
    exportLevel: v?.exportLevel ?? '',
    consolidate: v?.consolidate === undefined ? '' : v.consolidate ? 'true' : 'false',
    costCenter: v?.costCenter ?? '',
  };
}

function cleanMap(m: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, account] of Object.entries(m)) {
    if (code.trim() && account.trim()) out[code.trim().toLowerCase()] = account.trim();
  }
  return out;
}

function fromForm(f: FormState): AccountingSettingsValues {
  const accounts: Partial<Record<AccountKey, string>> = {};
  for (const k of ACCOUNT_KEYS) {
    const v = (f.accounts[k] ?? '').trim();
    if (v) accounts[k] = v;
  }
  return {
    movementType: f.movementType.trim() || undefined,
    branchCode: f.branchCode.trim() || undefined,
    encoding: (f.encoding || undefined) as AccountingSettingsValues['encoding'],
    method: (f.method || undefined) as AccountingSettingsValues['method'],
    accounts,
    cardBrands: cleanMap(f.brands),
    cardAcquirers: cleanMap(f.acquirers),
    voucherSalesAsLiability:
      f.voucherSalesAsLiability === '' ? undefined : f.voucherSalesAsLiability === 'true',
    exportLevel: f.exportLevel || undefined,
    consolidate: f.consolidate === '' ? undefined : f.consolidate === 'true',
    costCenter: f.costCenter.trim() || undefined,
  };
}

export default function AccountingSettingsPage() {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const cardLabels = useCardBrandLabels();
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'company' });
  const shopId = effective.shopId ?? null;
  const companyId = scope.shop?.companyId ?? effective.companyId ?? null;
  const atShop = Boolean(shopId);

  const { data, isLoading, isError, error } = useQuery<AccountingSettings>({
    queryKey: ['accounting-settings', companyId, shopId],
    queryFn: () => fetchAccountingSettings(companyId!, shopId),
    enabled: Boolean(companyId),
  });

  const own = atShop ? data?.shop : data?.company;
  const inherited = atShop ? data?.company : null;
  const [form, setForm] = useState<FormState>(() => toForm(null));
  useEffect(() => {
    // Reset the form whenever the level or what is stored for it changes.
    setForm(toForm(own));
  }, [own]);

  const save = useMutation({
    mutationFn: () => saveAccountingSettings({ companyId: companyId!, shopId, settings: fromForm(form) }),
    onSuccess: (next) => {
      qc.setQueryData(['accounting-settings', companyId, shopId], next);
      toast.success(t('saved'));
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const accountLabel = (k: string) => t(`accounts.${k}`);
  const missingLabel = (m: string) =>
    m === 'movementType' ? t('fields.movementType') : accountLabel(m.replace('accounts.', ''));
  const inheritedHint = (v?: string | null) => (atShop && v ? t('inherits', { value: v }) : undefined);

  const coreSet = useMemo(() => new Set<string>(CORE_ACCOUNT_KEYS), []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('settingsTitle')}</h1>
        <p className="text-muted-foreground text-sm">{t('settingsSubtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        {!companyId ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{t('pickCompany')}</p>
        ) : isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
        ) : data ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Card>
              <CardContent className="flex flex-wrap items-center gap-3 pt-6 text-sm">
                <Badge variant="secondary">
                  {atShop
                    ? t('levelShop', { shop: scope.shop?.name ?? '' })
                    : t('levelCompany', { company: scope.company?.name ?? '' })}
                </Badge>
                {data.missing.length === 0 ? (
                  <span className="flex items-center gap-1.5 text-emerald-700">
                    <CheckCircle2 className="h-4 w-4" aria-hidden /> {t('complete')}
                  </span>
                ) : (
                  <span className="text-destructive flex flex-wrap items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" aria-hidden />
                    {t('missing')}: {data.missing.map(missingLabel).join(' · ')}
                  </span>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('fileSection')}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.movementType')}</Label>
                  <Input
                    maxLength={3}
                    value={form.movementType}
                    placeholder={inherited?.movementType ?? ''}
                    onChange={(e) => setForm({ ...form, movementType: e.target.value })}
                    dir="ltr"
                  />
                  <p className="text-muted-foreground text-xs">{t('hints.movementType')}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.branchCode')}</Label>
                  <Input
                    maxLength={9}
                    value={form.branchCode}
                    placeholder={inherited?.branchCode ?? ''}
                    onChange={(e) => setForm({ ...form, branchCode: e.target.value })}
                    dir="ltr"
                  />
                  <p className="text-muted-foreground text-xs">{t('hints.branchCode')}</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.encoding')}</Label>
                  <select
                    className={SELECT}
                    value={form.encoding}
                    onChange={(e) => setForm({ ...form, encoding: e.target.value })}
                  >
                    <option value="">{atShop ? t('inheritOption') : t('encoding.cp1255')}</option>
                    <option value="cp1255">{t('encoding.cp1255')}</option>
                    <option value="cp862">{t('encoding.cp862')}</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.method')}</Label>
                  <select
                    className={SELECT}
                    value={form.method}
                    onChange={(e) => setForm({ ...form, method: e.target.value })}
                  >
                    <option value="">{atShop ? t('inheritOption') : t('method.flexible')}</option>
                    <option value="flexible">{t('method.flexible')}</option>
                    <option value="detailed">{t('method.detailed')}</option>
                  </select>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('accountsSection')}</CardTitle>
                <p className="text-muted-foreground text-xs">{t('accountsHint')}</p>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {ACCOUNT_KEYS.map((k) => {
                  const missing = data.missing.includes(`accounts.${k}`);
                  return (
                    <div key={k} className="space-y-1">
                      <Label className="flex items-center gap-1 text-xs">
                        {accountLabel(k)}
                        {coreSet.has(k) ? <span className="text-destructive">*</span> : null}
                        <span className="text-muted-foreground">({t(`sides.${k}`)})</span>
                      </Label>
                      <Input
                        maxLength={15}
                        dir="ltr"
                        value={form.accounts[k] ?? ''}
                        placeholder={inherited?.accounts?.[k] ?? ''}
                        aria-invalid={missing || undefined}
                        title={inheritedHint(inherited?.accounts?.[k])}
                        onChange={(e) =>
                          setForm({ ...form, accounts: { ...form.accounts, [k]: e.target.value } })
                        }
                      />
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('brandsSection')}</CardTitle>
                <p className="text-muted-foreground text-xs">{t('brandsHint')}</p>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs font-medium">{t('acquirersTitle')}</p>
                <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                  {CARD_ACQUIRERS.map((code) => (
                    <div key={code} className="space-y-1">
                      <Label className="text-xs">{cardLabels.acquirer(code)}</Label>
                      <Input
                        dir="ltr"
                        maxLength={15}
                        value={form.acquirers[code] ?? ''}
                        placeholder={inherited?.cardAcquirers?.[code] ?? ''}
                        onChange={(e) =>
                          setForm({ ...form, acquirers: { ...form.acquirers, [code]: e.target.value } })
                        }
                      />
                    </div>
                  ))}
                </div>
                <p className="pt-2 text-xs font-medium">{t('brandsTitle')}</p>
                <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
                  {CARD_BRANDS.map((code) => (
                    <div key={code} className="space-y-1">
                      <Label className="text-xs">{cardLabels.brand(code)}</Label>
                      <Input
                        dir="ltr"
                        maxLength={15}
                        value={form.brands[code] ?? ''}
                        placeholder={inherited?.cardBrands?.[code] ?? ''}
                        onChange={(e) =>
                          setForm({ ...form, brands: { ...form.brands, [code]: e.target.value } })
                        }
                      />
                    </div>
                  ))}
                </div>

                <div className="space-y-1 pt-4">
                  <Label className="text-xs">{t('fields.voucherSalesAsLiability')}</Label>
                  <select
                    className={`${SELECT} max-w-sm`}
                    value={form.voucherSalesAsLiability}
                    onChange={(e) =>
                      setForm({ ...form, voucherSalesAsLiability: e.target.value as FormState['voucherSalesAsLiability'] })
                    }
                  >
                    <option value="">{atShop ? t('inheritOption') : t('voucherIncome')}</option>
                    <option value="false">{t('voucherIncome')}</option>
                    <option value="true">{t('voucherLiability')}</option>
                  </select>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('levelSection')}</CardTitle>
                <p className="text-muted-foreground text-xs">{t('levelHint')}</p>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-3">
                {!atShop && (
                  <div className="space-y-1">
                    <Label className="text-xs">{t('fields.exportLevel')}</Label>
                    <select
                      className={SELECT}
                      value={form.exportLevel}
                      onChange={(e) => setForm({ ...form, exportLevel: e.target.value as FormState['exportLevel'] })}
                    >
                      <option value="">{t('exportLevel.company')}</option>
                      <option value="company">{t('exportLevel.company')}</option>
                      <option value="shop">{t('exportLevel.shop')}</option>
                    </select>
                  </div>
                )}
                {!atShop && (
                  <div className="space-y-1">
                    <Label className="text-xs">{t('fields.consolidate')}</Label>
                    <select
                      className={SELECT}
                      value={form.consolidate}
                      disabled={form.exportLevel === 'shop'}
                      onChange={(e) => setForm({ ...form, consolidate: e.target.value as FormState['consolidate'] })}
                    >
                      <option value="">{t('consolidate.false')}</option>
                      <option value="false">{t('consolidate.false')}</option>
                      <option value="true">{t('consolidate.true')}</option>
                    </select>
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.costCenter')}</Label>
                  <Input
                    maxLength={5}
                    dir="ltr"
                    value={form.costCenter}
                    placeholder={inherited?.costCenter || (atShop ? form.branchCode || inherited?.branchCode || '' : '')}
                    onChange={(e) => setForm({ ...form, costCenter: e.target.value })}
                  />
                  <p className="text-muted-foreground text-xs">{t('hints.costCenter')}</p>
                </div>
                {atShop && (
                  <p className="text-muted-foreground text-xs md:col-span-2">
                    {t('levelFromCompany', {
                      level: t(`exportLevel.${inherited?.exportLevel === 'shop' ? 'shop' : 'company'}`),
                    })}
                  </p>
                )}
              </CardContent>
            </Card>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? tc('saving') : tc('save')}
              </Button>
              <p className="text-muted-foreground text-xs">{t('verifyNote')}</p>
            </div>
          </form>
        ) : null}
      </ScopeGate>
    </div>
  );
}
