'use client';

/**
 * The printing settings ("הגדרות הדפסה") by shop → point of sale → till: the till's own
 * receipt printer (type, address, model), the cash drawer, "ask before printing" and the
 * kitchen tickets' two options. They are till parameters (the server's
 * `printers.SETTING_KEYS`), edited here rather than on the till parameters page.
 *
 * Pick a level in the tree; each setting shows the level's own value, or what it inherits
 * and from where (till → point of sale → shop → company → default).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LayoutGrid, Monitor, Store } from 'lucide-react';
import {
  savePrinterSettings,
  type KitchenOptions,
  type KitchenPrintersPage,
  type PrinterSettingDef,
  type PrinterSettingValue,
  type PrinterSettingValues,
} from '@/lib/kitchenPrintersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  draftToValue,
  ParameterValueInput,
  valueToDraft,
  type ValueDraft,
} from '@/components/dashboard/till-parameters/value-input';

type LevelType = 'shop' | 'area' | 'machine';

interface Level {
  type: LevelType;
  id: string;
  name: string;
  depth: number;
  /** A till's point of sale, when it is one of the shop's. */
  areaId?: string | null;
}

const GROUPS = [
  { id: 'Receipt', keys: ['receiptPrinter', 'receiptPrinterAddress', 'receiptPrinterModel'] },
  { id: 'Payment', keys: ['cashDrawer', 'askBeforePrint'] },
  { id: 'Kitchen', keys: ['kitchenTicketsOnSale', 'kitchenTicketsOnTill'] },
] as const;

/** The server's `receiptPrinter` option for the till's own printer. */
const BUILT_IN = 'מובנית בקופה';
const EXTERNAL_ONLY = new Set(['receiptPrinterAddress', 'receiptPrinterModel']);

export function OptionsCard({ page }: { page: KitchenPrintersPage }) {
  const t = useTranslations('kitchenPrinters.options');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const options = page.options;

  const areaIds = new Set(page.areas.map((a) => a.id));
  const levels: Level[] = [
    { type: 'shop', id: page.shopId, name: t('shop'), depth: 0 },
    ...page.areas.flatMap((a) => [
      { type: 'area' as const, id: a.id, name: t('area', { name: a.name }), depth: 1 },
      ...page.machines
        .filter((m) => m.areaId === a.id)
        .map((m) => ({ type: 'machine' as const, id: m.id, name: t('machine', { name: m.name }), depth: 2, areaId: a.id })),
    ]),
    ...page.machines
      .filter((m) => !m.areaId || !areaIds.has(m.areaId))
      .map((m) => ({ type: 'machine' as const, id: m.id, name: t('machine', { name: m.name }), depth: 1, areaId: null })),
  ];
  const [selectedKey, setSelectedKey] = useState(`shop:${page.shopId}`);
  const level = levels.find((l) => `${l.type}:${l.id}` === selectedKey) ?? levels[0];

  const valuesOf = (type: LevelType, id: string): PrinterSettingValues =>
    type === 'shop' ? options.shop : type === 'area' ? options.areas[id] ?? {} : options.machines[id] ?? {};
  const areaName = (id: string) => page.areas.find((a) => a.id === id)?.name ?? '';

  /** What `level` takes for `key` when it has no value of its own, and from where. */
  const inheritedOf = (lv: Level, key: string): { value: PrinterSettingValue | null; source: string } => {
    if (lv.type === 'machine' && lv.areaId) {
      const fromArea = valuesOf('area', lv.areaId)[key];
      if (fromArea !== undefined) return { value: fromArea, source: t('fromArea', { name: areaName(lv.areaId) }) };
    }
    if (lv.type !== 'shop' && options.shop[key] !== undefined) {
      return { value: options.shop[key], source: t('fromShop') };
    }
    return {
      value: options.inherited[key] ?? null,
      source: options.fromCompany.includes(key) ? t('fromCompany') : t('fromDefault'),
    };
  };

  const save = useMutation({
    mutationFn: (v: { level: Level; key: string; value: PrinterSettingValue | null }) =>
      savePrinterSettings(page.shopId, v.level.type, v.level.id, { [v.key]: v.value }),
    onSuccess: (next: KitchenOptions) => {
      qc.setQueryData<KitchenPrintersPage>(['kitchen-printers', page.shopId], (old) =>
        old ? { ...old, options: next } : old,
      );
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const own = valuesOf(level.type, level.id);
  const effective = (key: string) => (own[key] !== undefined ? own[key] : inheritedOf(level, key).value);
  const external = effective('receiptPrinter') !== BUILT_IN;
  const defs = new Map(options.parameters.map((p) => [p.key, p]));

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
      </div>
      <div className="grid gap-3 rounded-lg border p-3 md:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label={t('levels')} className="space-y-0.5 md:border-e md:pe-3">
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{t('levels')}</p>
          {levels.map((lv, i) => {
            const key = `${lv.type}:${lv.id}`;
            const count = Object.keys(valuesOf(lv.type, lv.id)).length;
            const Icon = lv.type === 'shop' ? Store : lv.type === 'area' ? LayoutGrid : Monitor;
            const firstLoose = lv.type === 'machine' && !lv.areaId && levels[i - 1]?.areaId !== null;
            return (
              <div key={key}>
                {firstLoose && page.areas.length > 0 ? (
                  <p className="px-2 pt-2 pb-0.5 ps-6 text-xs text-muted-foreground">{t('noArea')}</p>
                ) : null}
                <button
                  type="button"
                  onClick={() => setSelectedKey(key)}
                  aria-current={key === selectedKey ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted',
                    key === selectedKey && 'bg-muted font-medium',
                  )}
                  style={{ paddingInlineStart: `${0.5 + lv.depth * 1.25}rem` }}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{lv.name}</span>
                  {count > 0 ? (
                    <Badge variant="secondary" className="shrink-0" title={t('overrides', { count })}>
                      {count}
                    </Badge>
                  ) : null}
                </button>
              </div>
            );
          })}
        </nav>

        <div className="min-w-0 space-y-4">
          <p className="text-base font-semibold">{level.name}</p>
          {GROUPS.map((group) => {
            const shown = group.keys.filter((k) => defs.has(k));
            if (shown.length === 0) return null;
            return (
              <div key={group.id} className="space-y-1">
                <p className="text-sm font-semibold">{t(`group${group.id}`)}</p>
                {group.id === 'Receipt' ? (
                  <p className="text-xs text-muted-foreground">{t('groupReceiptHint')}</p>
                ) : group.id === 'Kitchen' ? (
                  <p className="text-xs text-muted-foreground">{t('groupKitchenHint')}</p>
                ) : null}
                <div className="divide-y">
                  {shown.map((key) => {
                    if (EXTERNAL_ONLY.has(key) && !external && own[key] === undefined) {
                      return key === 'receiptPrinterAddress' ? (
                        <p key={key} className="py-2 text-xs text-muted-foreground">
                          {t('externalOnly')}
                        </p>
                      ) : null;
                    }
                    const value = own[key];
                    return (
                      <SettingRow
                        key={`${selectedKey}:${key}:${JSON.stringify(value ?? null)}`}
                        def={defs.get(key)!}
                        own={value}
                        inherited={inheritedOf(level, key)}
                        canEdit={page.canEdit}
                        saving={save.isPending}
                        onSave={(v) => save.mutate({ level, key, value: v })}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function SettingRow({
  def,
  own,
  inherited,
  canEdit,
  saving,
  onSave,
}: {
  def: PrinterSettingDef;
  own: PrinterSettingValue | undefined;
  inherited: { value: PrinterSettingValue | null; source: string };
  canEdit: boolean;
  saving: boolean;
  onSave: (value: PrinterSettingValue | null) => void;
}) {
  const t = useTranslations('kitchenPrinters.options');
  const isOwn = own !== undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ValueDraft>(valueToDraft(isOwn ? own : inherited.value));
  const draftValue = draftToValue(def.valueType, draft, def.enumOptions);
  const dirty = draftValue !== null && draftValue !== own;
  // A switch or a list saves as it changes; text waits for "שמור".
  const instant = def.valueType === 'boolean' || def.valueType === 'enum';

  const format = (v: PrinterSettingValue | null) =>
    v === null ? t('none') : typeof v === 'boolean' ? (v ? t('on') : t('off')) : v === '' ? t('empty') : String(v);

  const change = (next: ValueDraft) => {
    setDraft(next);
    const value = draftToValue(def.valueType, next, def.enumOptions);
    if (instant && value !== null && value !== own) onSave(value);
  };

  return (
    <div className="grid gap-2 py-2.5 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        <p className="text-sm font-medium">{def.label}</p>
        {def.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground" title={def.description}>
            {def.description}
          </p>
        ) : null}
      </div>
      {isOwn || editing ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-48 max-w-sm flex-1">
              <ParameterValueInput
                type={def.valueType}
                enumOptions={def.enumOptions}
                draft={draft}
                onChange={change}
                disabled={!canEdit || saving}
              />
            </div>
            {canEdit && (!instant || !isOwn) && (dirty || !isOwn) ? (
              <Button size="sm" disabled={saving || draftValue === null} onClick={() => draftValue !== null && onSave(draftValue)}>
                {t('save')}
              </Button>
            ) : null}
            {canEdit ? (
              isOwn ? (
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => onSave(null)}>
                  {t('inheritAgain')}
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  {t('cancel')}
                </Button>
              )
            ) : null}
          </div>
          {isOwn ? (
            <p className="text-xs text-muted-foreground">
              <Badge variant="outline" className="me-1">
                {t('setHere')}
              </Badge>
              {t('above', { value: format(inherited.value), source: inherited.source })}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{format(inherited.value)}</span>
          <Badge variant="secondary">{inherited.source}</Badge>
          {canEdit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft(valueToDraft(inherited.value));
                setEditing(true);
              }}
            >
              {t('override')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
