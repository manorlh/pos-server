'use client';

/**
 * "פרופילי הרשאות" — the super admin's named sets of sections ("הרשאות דשבורד"), applied to
 * users from their permissions dialog. Built-in ones ("מנהל ארגון", "גישה מלאה לפי תפקיד") are
 * listed but not edited. Changing a template does not change users who already received it.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { DASHBOARD_SECTIONS, toggleSection, type AccessLevel } from '@/lib/dashboardAccess';
import {
  createAccessTemplate,
  deleteAccessTemplate,
  fetchAccessTemplates,
  updateAccessTemplate,
  type AccessTemplate,
  type SectionGrants,
} from '@/lib/dashboardAccessApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Draft {
  id?: string;
  name: string;
  sections: SectionGrants;
}

export function AccessTemplatesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('dashboardAccess');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { data: templates, isLoading } = useQuery({
    queryKey: ['dashboard-access', 'templates'],
    queryFn: fetchAccessTemplates,
    enabled: open,
  });
  const [draft, setDraft] = useState<Draft | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['dashboard-access', 'templates'] });
    qc.invalidateQueries({ queryKey: ['dashboard-access', 'catalog'] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id
        ? updateAccessTemplate(d.id, { name: d.name.trim(), sections: d.sections })
        : createAccessTemplate({ name: d.name.trim(), sections: d.sections }),
    onSuccess: () => {
      refresh();
      setDraft(null);
      toast.success(t('templateSaved'));
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('error'))),
  });

  const remove = useMutation({
    mutationFn: (x: AccessTemplate) => deleteAccessTemplate(x.id),
    onSuccess: () => {
      refresh();
      toast.success(t('templateDeleted'));
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('error'))),
  });

  const summary = (sections: SectionGrants) =>
    Object.entries(sections)
      .map(([id, level]) => `${t(`sections.${id}`)} (${t(`levels.${level}`)})`)
      .join(', ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('templatesTitle')}</DialogTitle>
          <p className="text-sm text-muted-foreground">{t('templatesIntro')}</p>
        </DialogHeader>

        {draft ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('templateName')}</Label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="p-2 text-start font-medium" />
                    <th className="w-20 p-2 text-center font-medium">{t('levels.view')}</th>
                    <th className="w-20 p-2 text-center font-medium">{t('levels.edit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {DASHBOARD_SECTIONS.map((s) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <td className="p-2">{t(`sections.${s.id}`)}</td>
                      {(['view', 'edit'] as AccessLevel[]).map((level) => (
                        <td key={level} className="p-2 text-center">
                          <input
                            type="checkbox"
                            className="h-5 w-5 accent-primary"
                            aria-label={`${t(`sections.${s.id}`)} — ${t(`levels.${level}`)}`}
                            checked={level === 'view' ? draft.sections[s.id] !== undefined : draft.sections[s.id] === 'edit'}
                            onChange={(e) =>
                              setDraft({ ...draft, sections: toggleSection(draft.sections, s.id, level, e.target.checked) })
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDraft(null)}>{tc('cancel')}</Button>
              <Button onClick={() => save.mutate(draft)} disabled={!draft.name.trim() || save.isPending}>
                {save.isPending ? tc('saving') : tc('save')}
              </Button>
            </DialogFooter>
          </div>
        ) : isLoading || !templates ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <div className="space-y-3">
            <ul className="divide-y rounded-lg border">
              {templates.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-medium">
                      {x.name}
                      {x.builtin ? <Badge variant="secondary">{t('builtin')}</Badge> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {x.fullAccess ? t('fullAccessHint') : summary(x.sections) || t('noSections')}
                    </div>
                  </div>
                  {!x.builtin ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t('editTemplate')}
                        onClick={() => setDraft({ id: x.id, name: x.name, sections: { ...x.sections } })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={tc('delete')}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(t('deleteTemplateConfirm', { name: x.name }))) remove.mutate(x);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            {templates.every((x) => x.builtin) ? <p className="text-xs text-muted-foreground">{t('noTemplates')}</p> : null}
            <Button size="sm" onClick={() => setDraft({ name: '', sections: {} })}>
              <Plus className="ms-1 h-4 w-4" /> {t('newTemplate')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
