'use client';

/**
 * "התראות בנייד" on the company's page (pwa-push-required §3, §6 "ברמת חברה: בהגדרות החברה"):
 * the company level — who must have phone notifications on and how a notification behaves,
 * for its users; a subsidiary inherits from its parent. Hidden when the reader may not see it.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, Loader2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { samePolicy, type CompanyPushPolicy, type PushPolicy } from '@/lib/pushPolicy';
import { fetchCompanyPushPolicy, saveCompanyPushPolicy } from '@/lib/pushPolicyApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PolicyEditor } from './policy-editor';

export function CompanyPushPolicyCard({ companyId }: { companyId: string }) {
  const query = useQuery({
    queryKey: ['push-policy', 'company', companyId],
    queryFn: () => fetchCompanyPushPolicy(companyId),
    retry: false,
  });
  // 403 / 404: not this reader's — the card is simply not there.
  if (!query.data) return null;
  return <CompanyPolicyForm key={query.dataUpdatedAt} data={query.data} />;
}

function CompanyPolicyForm({ data }: { data: CompanyPushPolicy }) {
  const t = useTranslations('pushGate.policy');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<PushPolicy>(data.policy);
  const save = useMutation({
    mutationFn: () => saveCompanyPushPolicy(data.companyId, draft),
    onSuccess: (out) => {
      qc.setQueryData(['push-policy', 'company', data.companyId], out);
      void qc.invalidateQueries({ queryKey: ['push-status'] });
      void qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveFailed'))),
  });
  const changed = !samePolicy(draft, data.policy);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <BellRing className="size-4 text-muted-foreground" aria-hidden />
          {t('title')}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{t('companyHint')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <PolicyEditor
          idPrefix={`company-${data.companyId}`}
          policy={draft}
          onChange={setDraft}
          catalogue={data.catalogue}
          inheritedRequired={data.inherited.required}
          inheritedNotify={data.inherited.notify}
          disabled={!data.canEdit || save.isPending}
        />
        {data.canEdit ? (
          <div className="flex justify-end">
            <Button size="sm" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t('save')}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('readOnly')}</p>
        )}
      </CardContent>
    </Card>
  );
}
