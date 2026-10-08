'use client';

/**
 * "תצורה אפקטיבית" — before a save: what changes at this level, how small the saved
 * layer is, and what each affected kiosk would actually get (its own and its shop's
 * overrides applied over the new values).
 */

import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  deepMergeKiosk,
  diffKioskConfigs,
  resolveKioskConfig,
  isMediaRef,
  type ConfigChange,
  type KioskConfig,
  type KioskLayer,
} from '@/lib/kioskConfig';
import { fetchKioskSettings, type KioskLevel, type KioskSummary } from '@/lib/kioskApi';

const MAX_KIOSKS = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** A readable label for a config path ("theme.primaryColor" → "צבע ראשי"). */
export function usePathLabel(names: Record<string, string> = {}) {
  const tf = useTranslations('kiosks.fields');
  return (path: string): string => {
    const parts = path.split('.');
    if (parts[0] === 'messages') return tf('messages');
    // The attract button's keys and "גודל טקסט"'s sit one level deeper (attract.cta.<key>, theme.textSizes.<key>).
    const deeper = (parts[0] === 'attract' && parts[1] === 'cta') || (parts[0] === 'theme' && parts[1] === 'textSizes');
    const depth = deeper && parts.length >= 3 ? 3 : 2;
    const head = parts.slice(0, depth).join('.');
    const label = parts.length >= depth && tf.has(head) ? tf(head) : parts[0];
    const rest = parts.slice(depth).filter((p) => !/^\d+$/.test(p));
    const suffix = rest.map((p) => names[p] ?? (UUID.test(p) ? '' : p)).filter(Boolean);
    return suffix.length > 0 ? `${label} · ${suffix.join(' · ')}` : label;
  };
}

export function ValueView({ value }: { value: unknown }) {
  const t = useTranslations('kiosks.review');
  if (value === null || value === undefined) return <span className="text-muted-foreground">{t('none')}</span>;
  if (typeof value === 'boolean') return <span>{value ? t('yes') : t('no')}</span>;
  if (typeof value === 'number') return <span className="tabular-nums">{value}</span>;
  if (typeof value === 'string') {
    if (value === '') return <span className="text-muted-foreground">{t('empty')}</span>;
    if (HEX.test(value)) {
      return (
        <span className="inline-flex items-center gap-1.5" dir="ltr">
          <span className="h-3.5 w-3.5 rounded-full border" style={{ background: value }} />
          <span className="font-mono text-xs">{value}</span>
        </span>
      );
    }
    return <span className="break-words">{value.length > 60 ? `${value.slice(0, 60)}…` : value}</span>;
  }
  if (isMediaRef(value)) {
    return value.kind === 'image' ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={value.url} alt={t('media')} className="h-8 w-12 rounded object-cover" />
    ) : (
      <span>{t('media')}</span>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">{t('empty')}</span>;
    if (value.length <= 6 && value.every((x) => typeof x === 'string' || typeof x === 'number')) {
      return <span>{value.join(', ')}</span>;
    }
    return <span>{t('items', { n: value.length })}</span>;
  }
  if (typeof value === 'object') return <span>{t('items', { n: Object.keys(value as object).length })}</span>;
  return <span>{String(value)}</span>;
}

function ChangeList({ changes, label }: { changes: ConfigChange[]; label: (path: string) => string }) {
  const t = useTranslations('kiosks.review');
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">{t('noChanges')}</p>;
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 bg-muted/60 px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <span />
        <span>{t('before')}</span>
        <span>{t('after')}</span>
      </div>
      <ul className="max-h-64 divide-y overflow-y-auto">
        {changes.map((c) => (
          <li key={c.path} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 px-3 py-1.5 text-sm">
            <span className="truncate font-medium" title={c.path}>
              {label(c.path)}
            </span>
            <span className="min-w-0 text-muted-foreground line-through decoration-muted-foreground/40">
              <ValueView value={c.before} />
            </span>
            <span className="min-w-0">
              <ValueView value={c.after} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReviewDialog({
  open,
  onOpenChange,
  level,
  targetId,
  saved,
  draft,
  layer,
  inheritedLayers,
  kiosks,
  names,
  saving,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  level: KioskLevel;
  targetId: string;
  /** The effective config this level has now. */
  saved: KioskConfig;
  draft: KioskConfig;
  /** The layer that will be saved. */
  layer: KioskLayer;
  /** What the parent layers set explicitly (GET /kiosks/settings), null on an older server. */
  inheritedLayers: KioskLayer | null;
  /** Kiosks in scope; the affected ones are picked here. */
  kiosks: KioskSummary[];
  names: Record<string, string>;
  saving: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations('kiosks.review');
  const label = usePathLabel(names);
  const [showJson, setShowJson] = useState(false);
  const here = useMemo(() => diffKioskConfigs(saved, draft), [saved, draft]);

  const affected = useMemo(() => {
    if (level === 'machine') return [];
    return kiosks.filter((k) => (level === 'shop' ? k.shopId === targetId : k.companyId === targetId));
  }, [kiosks, level, targetId]);
  const shown = affected.slice(0, MAX_KIOSKS);
  const shopIds = level === 'company' ? Array.from(new Set(shown.map((k) => k.shopId).filter((x): x is string => !!x))) : [];

  const machineQueries = useQueries({
    queries: shown.map((k) => ({
      queryKey: ['kiosk-settings', 'machine', k.machineId],
      queryFn: () => fetchKioskSettings('machine', k.machineId),
      enabled: open,
      staleTime: 15_000,
    })),
  });
  const shopQueries = useQueries({
    queries: shopIds.map((id) => ({
      queryKey: ['kiosk-settings', 'shop', id],
      queryFn: () => fetchKioskSettings('shop', id),
      enabled: open,
      staleTime: 15_000,
    })),
  });
  const loading = machineQueries.some((q) => q.isLoading) || shopQueries.some((q) => q.isLoading);

  const perKiosk = shown.map((k, i) => {
    const ms = machineQueries[i]?.data;
    if (!ms) return { kiosk: k, changes: null as ConfigChange[] | null };
    const shopLayer = level === 'company' ? shopQueries[shopIds.indexOf(k.shopId ?? '')]?.data?.overrides : undefined;
    // Resolved as the server will: defaults, the style's preset, then the layers.
    const next =
      level === 'shop'
        ? inheritedLayers
          ? resolveKioskConfig(inheritedLayers, layer, ms.overrides)
          : deepMergeKiosk(draft, ms.overrides)
        : resolveKioskConfig(layer, shopLayer ?? {}, ms.overrides);
    return { kiosk: k, changes: diffKioskConfigs(ms.effective, next) };
  });

  const layerCount = diffKioskConfigs({}, layer).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('changesHere')}</h3>
          <ChangeList changes={here} label={label} />
          <p className="text-xs text-muted-foreground">{t('layerSize', { n: layerCount })}</p>
        </section>

        {level !== 'machine' ? (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t('perKiosk')}</h3>
            {affected.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noKiosks')}</p>
            ) : loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {t('loadingKiosks')}
              </p>
            ) : (
              <ul className="space-y-2">
                {perKiosk.map(({ kiosk, changes }) => (
                  <li key={kiosk.machineId} className="rounded-xl border p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {kiosk.name}
                        {kiosk.shopName ? <span className="text-xs text-muted-foreground"> · {kiosk.shopName}</span> : null}
                      </span>
                      {changes === null ? (
                        <Badge variant="outline">{t('unknown')}</Badge>
                      ) : changes.length === 0 ? (
                        <Badge variant="outline">{t('kioskNoChange')}</Badge>
                      ) : (
                        <Badge>{t('kioskChanges', { n: changes.length })}</Badge>
                      )}
                    </div>
                    {changes && changes.length > 0 && changes.length !== here.length ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {changes.map((c) => label(c.path)).join(' · ')}
                      </p>
                    ) : null}
                  </li>
                ))}
                {affected.length > shown.length ? (
                  <li className="text-xs text-muted-foreground">{t('moreKiosks', { n: affected.length - shown.length })}</li>
                ) : null}
              </ul>
            )}
          </section>
        ) : null}

        <section className="space-y-1">
          <Button type="button" variant="link" size="xs" onClick={() => setShowJson((v) => !v)}>
            {showJson ? t('hideJson') : t('showJson')}
          </Button>
          {showJson ? (
            <pre dir="ltr" className="max-h-72 overflow-auto rounded-xl bg-muted p-3 text-[11px] leading-relaxed">
              {JSON.stringify(draft, null, 2)}
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
