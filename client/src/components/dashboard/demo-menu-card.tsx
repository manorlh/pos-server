'use client';

/**
 * "תפריט דמה" on a shop (docs/SPEC_TRAINING_MODE.md, "תפריט דמה"): load a ready menu from a
 * template — restaurant, bar, cafe, or restaurant and bar — so a new customer can practise
 * on it, and remove exactly what it created later on (pos-server app/routers/demo_menu.py).
 * Loaded from this page, the menu is created in the shop's company and sold only in this
 * shop. It works with or without training mode; turning training mode off offers to
 * remove it too.
 *
 * Everyone who sees the shop sees what is loaded; loading and removing are for `canManage`.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { UtensilsCrossed } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  fetchDemoMenuStatus,
  fetchDemoRemovePreview,
  fetchDemoTemplates,
  loadDemoMenu,
  removeDemoMenu,
  type DemoMenuLoad,
  type DemoTemplate,
} from '@/lib/demoMenuApi';
import { apiErrorInfo, entityCountEntries, templateCountsAsEntities } from '@/lib/trainingMode';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

/** Entity counts in words — "6 מחלקות, 40 פריטים, …" — in the template's order, zeros left out. */
export function useDemoCountsText() {
  const t = useTranslations('demoMenu.entity');
  const one = (type: string, count: number) => (t.has(type) ? t(type, { count }) : `${type}: ${count}`);
  return {
    one,
    lines: (counts: Record<string, number> | null | undefined) =>
      entityCountEntries(counts).map(([type, count]) => ({ type, text: one(type, count) })),
    text: (counts: Record<string, number> | null | undefined) =>
      entityCountEntries(counts)
        .map(([type, count]) => one(type, count))
        .join(', '),
  };
}

/** Everything a demo menu shows up in: the menu pages, the shop's assortment, the wizard. */
function invalidateMenu(qc: QueryClient, shopId: string) {
  void qc.invalidateQueries({ queryKey: ['demo-menu-status'] });
  void qc.invalidateQueries({ queryKey: ['training-disable-preview', shopId] });
  void qc.invalidateQueries({ queryKey: ['products'] });
  void qc.invalidateQueries({ queryKey: ['categories'] });
  void qc.invalidateQueries({ queryKey: ['catalog-import-summary'] });
  void qc.invalidateQueries({ queryKey: ['shop-product-overrides', shopId] });
}

export function DemoMenuCard({
  companyId,
  shopId,
  companyName,
}: {
  companyId: string;
  shopId: string;
  /** For the load confirmation: "… בחברה X". */
  companyName?: string | null;
}) {
  const t = useTranslations('demoMenu');
  const status = useQuery({
    queryKey: ['demo-menu-status', companyId, shopId],
    queryFn: () => fetchDemoMenuStatus(companyId, shopId),
    enabled: !!companyId,
  });
  const data = status.data;
  const canManage = data?.canManage === true;
  const loads = data?.loads ?? [];
  const loaded = !!data && (data.loaded || loads.length > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <UtensilsCrossed className="h-4 w-4" aria-hidden />
          {t('title')}
          {loaded ? (
            <Badge variant="outline" className="border-orange-300 text-orange-700 dark:border-orange-800 dark:text-orange-300">
              {t('loaded')}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t('desc')}</p>
        {status.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : status.isError || !data ? (
          <p className="text-sm text-destructive">{t('loadError')}</p>
        ) : (
          <>
            {loads.map((load) => (
              <LoadRow key={load.loadId} load={load} shopId={shopId} canManage={canManage} />
            ))}
            {!loaded ? (
              canManage ? (
                <TemplatePicker companyId={companyId} shopId={shopId} companyName={companyName} />
              ) : (
                <p className="text-sm text-muted-foreground">{t('none')}</p>
              )
            ) : null}
            {!canManage ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('readOnly')}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A load that reaches this shop: what it is, when, what it made, and its removal. */
function LoadRow({ load, shopId, canManage }: { load: DemoMenuLoad; shopId: string; canManage: boolean }) {
  const t = useTranslations('demoMenu');
  const counts = useDemoCountsText();
  const [removeOpen, setRemoveOpen] = useState(false);
  const made = counts.text(load.counts);
  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1 text-sm">
        <p className="font-medium">{load.templateName || load.template}</p>
        <p className="text-xs text-muted-foreground">
          {t('loadedAt', { at: formatDateTime(load.createdAt) })} ·{' '}
          {load.shopId ? t('scopeShop') : t('scopeCompany')}
        </p>
        {made ? <p className="text-xs">{made}</p> : null}
      </div>
      {canManage ? (
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setRemoveOpen(true)}>
          {t('remove')}
        </Button>
      ) : null}
      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent className="max-w-md">
          {removeOpen ? <RemoveDialogBody load={load} shopId={shopId} onClose={() => setRemoveOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RemoveDialogBody({ load, shopId, onClose }: { load: DemoMenuLoad; shopId: string; onClose: () => void }) {
  const t = useTranslations('demoMenu.removeDialog');
  const tc = useTranslations('common');
  const counts = useDemoCountsText();
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ['demo-menu-remove-preview', load.loadId],
    queryFn: () => fetchDemoRemovePreview(load.loadId),
    staleTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => removeDemoMenu(load.loadId),
    onSuccess: (out) => {
      const deactivated = counts.text(out.deactivated);
      toast.success(deactivated ? t('doneWithInactive', { items: deactivated }) : t('done'));
      qc.removeQueries({ queryKey: ['demo-menu-remove-preview', load.loadId] });
      invalidateMenu(qc, shopId);
      onClose();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  const p = preview.data;
  const lines = counts.lines(p?.counts);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title', { name: p?.templateName || load.templateName || load.template })}</DialogTitle>
      </DialogHeader>
      {preview.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : preview.isError || !p ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(preview.error, tc('error'))}</p>
      ) : (
        <div className="space-y-3 text-sm">
          {lines.length > 0 ? (
            <>
              <p>{t('body')}</p>
              <ul className="list-inside list-disc space-y-0.5 rounded-md border bg-muted/30 p-3">
                {lines.map((l) => (
                  <li key={l.type}>{l.text}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-muted-foreground">{t('nothing')}</p>
          )}
          {p.soldProducts > 0 ? (
            <p className="text-amber-700 dark:text-amber-400">{t('sold', { count: p.soldProducts })}</p>
          ) : null}
          {p.missing > 0 ? <p className="text-xs text-muted-foreground">{t('missing', { count: p.missing })}</p> : null}
          <p className="text-xs text-muted-foreground">{t('untouched')}</p>
          {!load.shopId ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('companyWide')}</p> : null}
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={remove.isPending}>
          {tc('cancel')}
        </Button>
        <Button variant="destructive" onClick={() => remove.mutate()} disabled={!p || remove.isPending}>
          {remove.isPending ? t('working') : t('confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}

/** No demo menu reaches the shop: pick a template and load it. */
function TemplatePicker({
  companyId,
  shopId,
  companyName,
}: {
  companyId: string;
  shopId: string;
  companyName?: string | null;
}) {
  const t = useTranslations('demoMenu');
  const counts = useDemoCountsText();
  const templates = useQuery({ queryKey: ['demo-menu-templates'], queryFn: fetchDemoTemplates, staleTime: 5 * 60_000 });
  const [picked, setPicked] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const list = templates.data ?? [];
  const chosen = list.find((tpl) => tpl.key === picked) ?? list[0] ?? null;

  if (templates.isLoading) return <Skeleton className="h-24 w-full" />;
  if (templates.isError) return <p className="text-sm text-destructive">{t('templatesError')}</p>;
  if (list.length === 0) return <p className="text-sm text-muted-foreground">{t('noTemplates')}</p>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('none')}</p>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('pickTemplate')}</p>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t('pickTemplate')}>
          {list.map((tpl) => {
            const on = chosen?.key === tpl.key;
            return (
              <button
                key={tpl.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPicked(tpl.key)}
                className={cn(
                  'space-y-1 rounded-md border p-3 text-start transition-colors',
                  on ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'bg-background hover:bg-muted',
                )}
              >
                <span className="block text-sm font-medium">{tpl.name}</span>
                {tpl.description ? <span className="block text-xs text-muted-foreground">{tpl.description}</span> : null}
                <span className="block text-xs">{counts.text(templateCountsAsEntities(tpl.counts))}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={!chosen}>
          {t('load')}
        </Button>
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          {confirmOpen && chosen ? (
            <LoadDialogBody
              template={chosen}
              companyId={companyId}
              shopId={shopId}
              companyName={companyName}
              onClose={() => setConfirmOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LoadDialogBody({
  template,
  companyId,
  shopId,
  companyName,
  onClose,
}: {
  template: DemoTemplate;
  companyId: string;
  shopId: string;
  companyName?: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('demoMenu.loadDialog');
  const tc = useTranslations('common');
  const counts = useDemoCountsText();
  const qc = useQueryClient();
  const load = useMutation({
    mutationFn: () => loadDemoMenu({ companyId, shopId, template: template.key }),
    onSuccess: (out) => {
      toast.success(t('done', { name: out.templateName || template.name }));
      invalidateMenu(qc, shopId);
      onClose();
    },
    onError: (err: unknown) => {
      const { code } = apiErrorInfo(err);
      if (code === 'demo_menu_loaded') {
        toast.warning(t('alreadyLoaded'));
        invalidateMenu(qc, shopId);
        onClose();
        return;
      }
      toast.error(code === 'unknown_template' ? t('unknownTemplate') : axiosErrorToToastMessage(err, tc('error')));
    },
  });
  const made = counts.text(templateCountsAsEntities(template.counts));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title', { name: template.name })}</DialogTitle>
      </DialogHeader>
      <div className="space-y-2 text-sm">
        <p>{companyName ? t('body', { counts: made, company: companyName }) : t('bodyNoCompany', { counts: made })}</p>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={load.isPending}>
          {tc('cancel')}
        </Button>
        <Button onClick={() => load.mutate()} disabled={load.isPending}>
          {load.isPending ? t('working') : t('confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}
