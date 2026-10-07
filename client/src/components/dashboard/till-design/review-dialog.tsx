'use client';

/**
 * Before a save: what changes at this level (before → after, in words), how small the saved
 * layer is, and — at a shop or a point of sale — which of its tills get each change (a till or
 * its point of sale that sets the value itself keeps its own).
 */

import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ValueView } from '@/components/dashboard/kiosks/review-dialog';
import {
  actionLabelOf,
  diffConfigs,
  getPath,
  type ActionItem,
  type ConfigChange,
  type TillDesignConfig,
  type TillDesignLayer,
} from '@/lib/tillDesign';
import { fetchTillDesignSettings, type TillDesignLevel, type TillDesignTargets } from '@/lib/tillDesignApi';

const MAX_TILLS = 12;

/** The vocabulary group a path's value is worded from. */
const VOCAB_OF: Record<string, string> = {
  tileSize: 'tileSize',
  tileStyle: 'tileStyle',
  density: 'density',
  billPosition: 'billPosition',
  categoryBar: 'categoryBar',
  images: 'images',
  textSize: 'textSize',
  'colors.mode': 'colorMode',
  'behavior.summary': 'summary',
  'tables.mapStyle': 'mapStyle',
  'tables.showChairs': 'showChairs',
};

/** A config path in words ("profiles.handheld.template" → "מסופון F20 · תבנית"). */
export function useTillPathLabel() {
  const t = useTranslations('tillDesign.paths');
  const tp = useTranslations('tillDesign.profiles');
  const tl = useTranslations('tillDesign.layout');
  const tx = useTranslations('tillDesign.texts');
  return (path: string): string => {
    const parts = path.split('.');
    if (parts[0] === 'profiles' && parts.length >= 3) {
      const key = parts[2];
      return `${tp.has(parts[1]) ? tp(parts[1]) : parts[1]} · ${key === 'template' ? t('template') : tl.has(key) ? tl(key) : key}`;
    }
    if (parts[0] === 'texts' && parts[1]) return `${t('texts')} · ${tx.has(parts[1]) ? tx(parts[1]) : parts[1]}`;
    const head = parts.slice(0, 2).join('.');
    if (t.has(head)) return t(head);
    if (t.has(parts[0])) return t(parts[0]);
    return path;
  };
}

function TillValue({ path, value, cfg }: { path: string; value: unknown; cfg: TillDesignConfig }) {
  const tv = useTranslations('tillDesign.values');
  const tt = useTranslations('tillDesign.templates');
  const tf = useTranslations('tillDesign.values.fieldMode');
  const tr = useTranslations('tillDesign.review');
  const parts = path.split('.');
  const last = parts[parts.length - 1];
  if (value === null || value === undefined) return <span className="text-muted-foreground">{tr('asBase')}</span>;
  if ((path === 'template' || (parts[0] === 'profiles' && last === 'template')) && typeof value === 'string' && tt.has(`${value}.name`)) {
    return <span>{tt(`${value}.name`)}</span>;
  }
  if (parts[0] === 'actionBar' && Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">{tr('auto')}</span>;
    return <span>{(value as ActionItem[]).map((a) => actionLabelOf(a, cfg)).join(' · ')}</span>;
  }
  if ((parts[0] === 'menu' || path === 'bar.favorites') && Array.isArray(value)) {
    return value.length === 0 ? <span className="text-muted-foreground">{tr('tillOrder')}</span> : <span>{tr('items', { n: value.length })}</span>;
  }
  if (parts[0] === 'quickCash' && last === 'notes' && Array.isArray(value)) {
    return value.length === 0 ? <span className="text-muted-foreground">{tr('auto')}</span> : <span dir="ltr">{(value as number[]).map((n) => `₪${n}`).join(', ')}</span>;
  }
  if (parts[0] === 'fields' && typeof value === 'string' && tf.has(value)) return <span>{tf(value)}</span>;
  if (path.endsWith('columns') && value === 0) return <span>{tr('auto')}</span>;
  const vocab = VOCAB_OF[`${parts[0]}.${last}`] ?? VOCAB_OF[last];
  if (vocab && typeof value === 'string' && tv.has(`${vocab}.${value}`)) return <span>{tv(`${vocab}.${value}`)}</span>;
  return <ValueView value={value} />;
}

function ChangeList({ changes, label, cfg }: { changes: ConfigChange[]; label: (p: string) => string; cfg: TillDesignConfig }) {
  const t = useTranslations('tillDesign.review');
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">{t('noChanges')}</p>;
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 bg-muted/60 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <span />
        <span>{t('before')}</span>
        <span>{t('after')}</span>
      </div>
      <ul className="max-h-72 divide-y overflow-y-auto">
        {changes.map((c) => (
          <li key={c.path} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 px-3 py-1.5 text-sm">
            <span className="truncate font-medium" title={c.path}>
              {label(c.path)}
            </span>
            <span className="min-w-0 text-muted-foreground line-through decoration-muted-foreground/40">
              <TillValue path={c.path} value={c.before} cfg={cfg} />
            </span>
            <span className="min-w-0">
              <TillValue path={c.path} value={c.after} cfg={cfg} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Whether a stored layer sets `path` itself (a value, an object with something in it). */
function layerSets(layer: TillDesignLayer | undefined, path: string): boolean {
  const v = getPath(layer, path);
  if (v === undefined || v === null) return false;
  if (typeof v === 'object' && !Array.isArray(v)) return Object.keys(v as object).length > 0;
  return true;
}

export function ReviewDialog({
  open,
  onOpenChange,
  level,
  targetId,
  saved,
  draft,
  layer,
  targets,
  saving,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  level: TillDesignLevel;
  targetId: string;
  saved: TillDesignConfig;
  draft: TillDesignConfig;
  layer: TillDesignLayer;
  targets: TillDesignTargets | null;
  saving: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations('tillDesign.review');
  const label = useTillPathLabel();
  const [showJson, setShowJson] = useState(false);
  const here = useMemo(() => diffConfigs(saved, draft), [saved, draft]);
  const layerCount = diffConfigs({}, layer).length;

  const tills = useMemo(() => {
    if (!targets || level === 'machine' || level === 'company') return [];
    return level === 'area' ? targets.machines.filter((m) => m.areaId === targetId) : targets.machines;
  }, [targets, level, targetId]);
  const shown = tills.slice(0, MAX_TILLS);
  const areaIds = level === 'shop' ? Array.from(new Set(shown.map((m) => m.areaId).filter((x): x is string => !!x))) : [];
  const machineQueries = useQueries({
    queries: shown.map((m) => ({
      queryKey: ['till-design-settings', 'machine', m.id],
      queryFn: () => fetchTillDesignSettings('machine', m.id),
      enabled: open,
      staleTime: 15_000,
    })),
  });
  const areaQueries = useQueries({
    queries: areaIds.map((id) => ({
      queryKey: ['till-design-settings', 'area', id],
      queryFn: () => fetchTillDesignSettings('area', id),
      enabled: open,
      staleTime: 15_000,
    })),
  });
  const loading = machineQueries.some((q) => q.isLoading) || areaQueries.some((q) => q.isLoading);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('changesHere')}</h3>
          <ChangeList changes={here} label={label} cfg={draft} />
          <p className="text-xs text-muted-foreground">{t('layerSize', { n: layerCount })}</p>
        </section>

        {level === 'company' ? <p className="text-sm text-muted-foreground">{t('companyScope')}</p> : null}
        {level === 'shop' || level === 'area' ? (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t('perTill')}</h3>
            {tills.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noTills')}</p>
            ) : loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {t('loadingTills')}
              </p>
            ) : (
              <ul className="space-y-2">
                {shown.map((m, i) => {
                  const own = machineQueries[i]?.data?.overrides;
                  const area = m.areaId ? areaQueries[areaIds.indexOf(m.areaId)]?.data?.overrides : undefined;
                  const known = !!machineQueries[i]?.data;
                  const kept = here.filter((c) => layerSets(own, c.path) || (level === 'shop' && layerSets(area, c.path)));
                  const reach = here.length - kept.length;
                  return (
                    <li key={m.id} className="rounded-lg border p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          {m.name}
                          {m.areaName ? <span className="text-xs text-muted-foreground"> · {m.areaName}</span> : null}
                        </span>
                        {!known ? (
                          <Badge variant="outline">{t('unknown')}</Badge>
                        ) : reach === 0 ? (
                          <Badge variant="outline">{t('tillNoChange')}</Badge>
                        ) : (
                          <Badge>{t('tillChanges', { n: reach })}</Badge>
                        )}
                      </div>
                      {known && kept.length > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">{t('keepsOwn', { list: kept.map((c) => label(c.path)).join(' · ') })}</p>
                      ) : null}
                    </li>
                  );
                })}
                {tills.length > shown.length ? <li className="text-xs text-muted-foreground">{t('moreTills', { n: tills.length - shown.length })}</li> : null}
              </ul>
            )}
          </section>
        ) : null}

        <section className="space-y-1">
          <Button type="button" variant="link" size="xs" onClick={() => setShowJson((v) => !v)}>
            {showJson ? t('hideJson') : t('showJson')}
          </Button>
          {showJson ? (
            <pre dir="ltr" className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-[11px] leading-relaxed">
              {JSON.stringify(layer, null, 2)}
            </pre>
          ) : null}
        </section>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('back')}
          </Button>
          <Button disabled={saving || here.length === 0} onClick={onConfirm}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
