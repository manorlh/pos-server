'use client';

/**
 * "פרטי התוכנה בקובץ" — the software details every open-format file names (A000 1006–1012),
 * a platform setting the super admin keeps (`GET/PUT /system/open-format`, pos-server
 * app/services/open_format/software.py). Shown on the tax-reports page so whoever exports
 * sees what the file will say, and what is still a placeholder.
 *
 * 1006 "מספר תעודת הרישום של התוכנה" is the certificate the Tax Authority issues for the
 * software. Until it is entered the file writes `00000000`, and the simulator answers
 * "ערך השדה לא ולידי / השדה מאופס" — this card says so, and where to enter it.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import {
  OPEN_FORMAT_FIELDS,
  fetchOpenFormatSoftware,
  saveOpenFormatSoftware,
  type OpenFormatField,
  type OpenFormatSoftwareInput,
  type OpenFormatSoftwareSettings,
} from '@/lib/openFormatApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** The value the file is written with, per field, as the owner reads it. */
function shown(data: OpenFormatSoftwareSettings, field: OpenFormatField): string {
  switch (field) {
    case 'registrationNumber':
      return data.effective.registrationNumber;
    case 'softwareName':
      return data.effective.softwareName;
    case 'softwareVersion':
      return data.effective.softwareVersion;
    case 'manufacturerName':
      return data.effective.manufacturerName;
    case 'manufacturerVatNumber':
      return data.effective.manufacturerVatNumber;
    case 'outputDrive':
      return data.outputDrive ?? '';
  }
}

export function OpenFormatSoftwareCard() {
  const t = useTranslations('taxReports.software');
  const isSuperAdmin = useAuth((s) => s.authHydrated && s.user?.role === 'super_admin');
  const [editing, setEditing] = useState(false);
  const { data } = useQuery({ queryKey: ['open-format-software'], queryFn: fetchOpenFormatSoftware });
  if (!data) return null;
  const missing = new Set(data.placeholders);
  const zeroed = missing.has('registrationNumber');
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('hint')}</CardDescription>
        </div>
        {isSuperAdmin && !editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" aria-hidden />
            {t('edit')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {zeroed ? (
          <div role="alert" className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium">{t('registrationMissing')}</p>
              <p className="text-muted-foreground">{isSuperAdmin ? t('registrationWhereSuperAdmin') : t('registrationWhere')}</p>
            </div>
          </div>
        ) : null}
        {editing ? (
          <SoftwareForm data={data} onDone={() => setEditing(false)} />
        ) : (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
            {OPEN_FORMAT_FIELDS.map((field) => (
              <div key={field} className="contents">
                <dt className="text-muted-foreground">{data.labels[field] ?? field}</dt>
                <dd className="font-mono" dir="ltr">
                  {shown(data, field) || '—'}
                  {missing.has(field) ? <span className="ms-2 font-sans text-amber-600">{t('placeholder')}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function SoftwareForm({ data, onDone }: { data: OpenFormatSoftwareSettings; onDone: () => void }) {
  const t = useTranslations('taxReports.software');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [values, setValues] = useState<OpenFormatSoftwareInput>(() => {
    const out = {} as OpenFormatSoftwareInput;
    for (const f of OPEN_FORMAT_FIELDS) out[f] = data[f] ?? '';
    return out;
  });
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = {} as OpenFormatSoftwareInput;
      for (const f of OPEN_FORMAT_FIELDS) body[f] = (values[f] ?? '').trim() || null;
      return saveOpenFormatSoftware(body);
    },
    onSuccess: (out) => {
      qc.setQueryData(['open-format-software'], out);
      toast.success(t('saved'));
      onDone();
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: { field?: string; message?: string } } } })?.response?.data
        ?.detail;
      const message = detail?.message ?? axiosErrorToToastMessage(err, tc('error'));
      setFieldError({ field: detail?.field, message });
      toast.error(message);
    },
  });
  return (
    <div className="space-y-3">
      {OPEN_FORMAT_FIELDS.map((field) => (
        <div key={field} className="space-y-1">
          <Label htmlFor={`of-${field}`}>{data.labels[field] ?? field}</Label>
          <Input
            id={`of-${field}`}
            dir="ltr"
            value={values[field] ?? ''}
            placeholder={field === 'softwareVersion' && data.derivedVersion ? data.derivedVersion : ''}
            aria-invalid={fieldError?.field === field}
            onChange={(e) => {
              setValues((v) => ({ ...v, [field]: e.target.value }));
              setFieldError(null);
            }}
          />
          {fieldError?.field === field ? <p className="text-xs text-destructive">{fieldError.message}</p> : null}
        </div>
      ))}
      {fieldError && !fieldError.field ? <p className="text-xs text-destructive">{fieldError.message}</p> : null}
      <p className="text-xs text-muted-foreground">{t('emptyMeansPlaceholder')}</p>
      <div className="flex gap-2">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
        <Button variant="outline" onClick={onDone}>
          {tc('cancel')}
        </Button>
      </div>
    </div>
  );
}
