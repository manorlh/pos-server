'use client';

/**
 * "בניית חברת הדגמה" — the companies page's button and its confirmation (P:/specs/demo-company.md;
 * pos-server app/routers/demo_company.py). The super admin's only: the server refuses anybody else.
 *
 * The confirmation says plainly that the company is LIVE (real numbering, a real Z, real clearing
 * once a terminal is set) and asks the business details an invoice needs — ח.פ / עוסק, address,
 * phone — all optional now and editable later in the company's details. A second click completes
 * only what is missing and gives fresh pairing codes; the summary page shows the outcome.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, TriangleAlert } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { buildBody, EMPTY_DEMO_FORM, phoneProblem, vatNumberProblem, type DemoCompanyForm } from '@/lib/demoCompany';
import { buildDemoCompany, DEMO_COMPANY_QUERY_KEY, fetchDemoCompany } from '@/lib/demoCompanyApi';
import { useIsSuperAdmin } from '@/components/dashboard/license-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** The last build's answer (what it made, what failed), for the summary page. */
export const DEMO_COMPANY_LAST_BUILD_KEY = ['demo-company-last-build'] as const;

export function DemoCompanyButton() {
  const t = useTranslations('demoCompany');
  const isSuperAdmin = useIsSuperAdmin();
  const [open, setOpen] = useState(false);
  if (!isSuperAdmin) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Building2 className="h-4 w-4 ms-1" aria-hidden /> {t('button')}
      </Button>
      <DemoCompanyDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function DemoCompanyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        {open ? <DemoCompanyConfirm onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function DemoCompanyConfirm({ onClose }: { onClose: () => void }) {
  const t = useTranslations('demoCompany');
  const tb = useTranslations('demoCompany.dialog');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const router = useRouter();
  const [form, setForm] = useState<DemoCompanyForm>(EMPTY_DEMO_FORM);
  const status = useQuery({ queryKey: DEMO_COMPANY_QUERY_KEY, queryFn: fetchDemoCompany });
  const exists = status.data?.exists === true;
  const vatProblem = vatNumberProblem(form.vatNumber);
  const phoneBad = phoneProblem(form.phone);

  const build = useMutation({
    mutationFn: () => buildDemoCompany(buildBody(form)),
    onSuccess: (out) => {
      qc.setQueryData(DEMO_COMPANY_LAST_BUILD_KEY, out);
      qc.setQueryData(DEMO_COMPANY_QUERY_KEY, out);
      void qc.invalidateQueries({ queryKey: ['companies'] });
      void qc.invalidateQueries({ queryKey: ['shops'] });
      const failed = out.failed?.length ?? 0;
      if (failed) toast.warning(t('builtWithFailures', { count: failed }));
      else toast.success(t('built'));
      onClose();
      router.push('/dashboard/demo-company');
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const field = (key: keyof DemoCompanyForm) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 text-sm">
        <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">{tb('liveTitle')}</p>
            <p>{tb('liveBody')}</p>
          </div>
        </div>
        {exists ? (
          <p className="rounded-md border bg-muted/30 p-3">{tb('again', { name: status.data?.company?.name ?? '' })}</p>
        ) : (
          <div className="space-y-1">
            <p>{tb('whatTitle')}</p>
            <ul className="list-inside list-disc space-y-0.5 text-muted-foreground">
              {(['company', 'snack', 'restaurant', 'features', 'devices'] as const).map((k) => (
                <li key={k}>{tb(`what.${k}`)}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-3 rounded-md border p-3">
          <div>
            <p className="font-medium">{tb('detailsTitle')}</p>
            <p className="text-xs text-muted-foreground">{tb('detailsHint')}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="demo-vat">{tb('vatNumber')}</Label>
              <Input id="demo-vat" inputMode="numeric" dir="ltr" {...field('vatNumber')} />
              {vatProblem ? <p className="text-xs text-destructive">{tb(`vatProblem.${vatProblem}`)}</p> : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="demo-dealer">{tb('dealerType')}</Label>
              <select
                id="demo-dealer"
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                value={form.dealerType}
                onChange={(e) => setForm((f) => ({ ...f, dealerType: e.target.value as DemoCompanyForm['dealerType'] }))}
              >
                <option value="">{tb('dealerDefault')}</option>
                <option value="company">{tb('dealer.company')}</option>
                <option value="licensed">{tb('dealer.licensed')}</option>
                <option value="exempt">{tb('dealer.exempt')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="demo-address">{tb('address')}</Label>
              <Input id="demo-address" {...field('address')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="demo-city">{tb('city')}</Label>
              <Input id="demo-city" {...field('city')} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor="demo-phone">{tb('phone')}</Label>
              <Input id="demo-phone" inputMode="tel" dir="ltr" {...field('phone')} />
              {phoneBad ? <p className="text-xs text-destructive">{tb('phoneInvalid')}</p> : null}
            </div>
          </div>
          {exists ? <p className="text-xs text-muted-foreground">{tb('detailsAgain')}</p> : null}
        </div>
        <p className="text-xs text-muted-foreground">{tb('terminal')}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={build.isPending}>
          {tc('cancel')}
        </Button>
        <Button
          onClick={() => build.mutate()}
          disabled={build.isPending || status.isLoading || !!vatProblem || !!phoneBad}
        >
          {build.isPending ? tb('building') : exists ? tb('confirmAgain') : tb('confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}
