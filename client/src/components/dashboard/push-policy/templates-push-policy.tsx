'use client';

/**
 * "התראות בנייד לפי תבנית ותפקיד" — the super admin's level between the company and the user
 * (pwa-push-required §6 "ברמת תבנית או תפקיד: בתבניות הרשאות הדשבורד"), inside "פרופילי
 * הרשאות": per dashboard template (built in or saved) and per role, `required` and the
 * categories' behaviour. The template wins over the role; a user's own setting wins over both.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { EMPTY_POLICY, samePolicy, type PlatformPushPolicy, type PushPolicy } from '@/lib/pushPolicy';
import { fetchPlatformPushPolicy, savePlatformPushPolicy } from '@/lib/pushPolicyApi';
import { Button } from '@/components/ui/button';
import { ModeSelect, PolicyEditor } from './policy-editor';

type Part = 'templates' | 'roles';

export function TemplatesPushPolicy({ enabled }: { enabled: boolean }) {
  const query = useQuery({
    queryKey: ['push-policy', 'platform'],
    queryFn: fetchPlatformPushPolicy,
    enabled,
    retry: false,
  });
  if (!query.data) return null;
  return <PlatformForm key={query.dataUpdatedAt} data={query.data} />;
}

function PlatformForm({ data }: { data: PlatformPushPolicy }) {
  const t = useTranslations('pushGate.policy');
  const tu = useTranslations('users');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<{ templates: Record<string, PushPolicy>; roles: Record<string, PushPolicy> }>({
    templates: data.templates,
    roles: data.roles,
  });
  const [open, setOpen] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => savePlatformPushPolicy(draft),
    onSuccess: (out) => {
      qc.setQueryData(['push-policy', 'platform'], out);
      void qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveFailed'))),
  });
  const changed = (['templates', 'roles'] as Part[]).some((part) => {
    const keys = new Set([...Object.keys(draft[part]), ...Object.keys(data[part])]);
    return [...keys].some((k) => !samePolicy(draft[part][k] ?? EMPTY_POLICY, data[part][k] ?? EMPTY_POLICY));
  });
  const set = (part: Part, key: string, policy: PushPolicy) =>
    setDraft((d) => ({ ...d, [part]: { ...d[part], [key]: policy } }));

  const row = (part: Part, key: string, label: string) => {
    const policy = draft[part][key] ?? EMPTY_POLICY;
    const id = `${part}-${key}`;
    const expanded = open === id;
    return (
      <li key={id} className="space-y-2 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-sm">{label}</span>
          <ModeSelect
            className="w-40"
            ariaLabel={`${label} — ${t('required')}`}
            value={policy.required}
            inherited={null}
            inheritLabel={t('inheritCompany')}
            onChange={(m) => set(part, key, { ...policy, required: m })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title={t('showCategories')}
            aria-label={`${label} — ${t('showCategories')}`}
            aria-expanded={expanded}
            onClick={() => setOpen(expanded ? null : id)}
          >
            {expanded ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
          </Button>
        </div>
        {expanded ? (
          <PolicyEditor
            idPrefix={id}
            hideRequired
            policy={policy}
            onChange={(p) => set(part, key, p)}
            catalogue={data.catalogue}
            inheritedRequired={null}
          />
        ) : null}
      </li>
    );
  };

  return (
    <section className="space-y-3 rounded-lg border p-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <BellRing className="size-4 text-muted-foreground" aria-hidden />
          {t('templatesTitle')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('templatesHint')}</p>
      </div>
      <div>
        <h4 className="text-xs font-medium text-muted-foreground">{t('templates')}</h4>
        <ul className="divide-y">{data.templateList.map((x) => row('templates', x.id, x.name))}</ul>
      </div>
      <div>
        <h4 className="text-xs font-medium text-muted-foreground">{t('roles')}</h4>
        <ul className="divide-y">
          {data.catalogue.roles.map((r) => row('roles', r, tu.has(`roles.${r}`) ? tu(`roles.${r}`) : r))}
        </ul>
      </div>
      <div className="flex justify-end">
        <Button size="sm" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t('save')}
        </Button>
      </div>
    </section>
  );
}
