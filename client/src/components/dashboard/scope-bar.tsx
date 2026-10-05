'use client';

/**
 * The dashboard's single scope control: organization ▸ company ▸ shop ▸ device.
 *
 * Four selects in a row, each narrowed by the one before it. Choosing a level
 * clears everything deeper (the provider enforces that; the bar only has to show
 * it), and every choice goes into the URL, so this control is also the app's
 * address bar for "where am I looking".
 *
 * The bar reacts to the page it sits above. Each page registers a
 * `PageScopeSpec`; levels deeper than the page's `maxLevel` render disabled with
 * a plain reason next to them, instead of accepting a value the page would throw
 * away. Levels the page needs but does not yet have are marked as required.
 */

import { useTranslations } from 'next-intl';
import { Building2, Layers, Monitor, RotateCcw, Store } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useScope } from '@/lib/scope';
import { companyPathLabel, MAX_TREE_INDENT_DEPTH } from '@/lib/companyTree';
import { SCOPE_LEVEL_ORDER, levelEnabledForSpec } from '@/lib/pageScope';
import type { ScopeLevel } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NumberPill } from '@/components/dashboard/number-pill';
import { numberedLabel } from '@/lib/orgNumber';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL = '__all__';

/** Nesting depth as leading indent inside a select popup row. */
function indentStyle(depth: number): React.CSSProperties {
  const steps = Math.min(depth, MAX_TREE_INDENT_DEPTH);
  return { paddingInlineStart: `${steps * 0.85}rem` };
}

function ScopeField({
  label,
  icon: Icon,
  disabled,
  disabledHint,
  required,
  requiredHint,
  children,
}: {
  label: string;
  icon: React.ElementType;
  disabled: boolean;
  disabledHint: string;
  required: boolean;
  requiredHint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-[11rem] flex-1 space-y-1">
      <Label className={cn('flex items-center gap-1.5 text-xs', disabled && 'text-muted-foreground/60')}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
        {required ? (
          <Badge variant="secondary" className="ms-1">
            {requiredHint}
          </Badge>
        ) : null}
      </Label>
      <div className={disabled ? 'pointer-events-none opacity-50' : undefined}>{children}</div>
      {disabled ? <p className="text-[11px] text-muted-foreground">{disabledHint}</p> : null}
    </div>
  );
}

export function ScopeBar() {
  const t = useTranslations('scope');
  const scope = useScope();
  const tenants = useAuth((s) => s.tenants);
  const activeTenantId = useAuth((s) => s.activeTenantId);

  const tenantName =
    tenants.find((tenant) => tenant.id === activeTenantId)?.name ?? t('organization');

  const spec = scope.spec;
  const resolution = scope.resolution;

  const companyEnabled = levelEnabledForSpec(spec, 'company');
  const shopEnabled = levelEnabledForSpec(spec, 'shop');
  const machineEnabled = levelEnabledForSpec(spec, 'machine');

  const requiredLevel: ScopeLevel | null =
    resolution?.status === 'needs' ? resolution.needed : null;
  const isRequired = (level: ScopeLevel) =>
    requiredLevel !== null && SCOPE_LEVEL_ORDER[level] === SCOPE_LEVEL_ORDER[requiredLevel];

  const companyItems = [
    { value: ALL, label: t('allCompanies') },
    ...scope.tree.flat.map((node) => ({
      value: node.company.id,
      // The trigger shows the whole path, so a nested company still reads
      // unambiguously once the popup is closed.
      label: numberedLabel(
        node.company.companyNumber,
        companyPathLabel(scope.tree, node.company.id, node.company.name),
      ),
    })),
  ];

  const shopItems = [
    { value: ALL, label: t('allShops') },
    ...scope.shopOptions.map((shop) => ({
      value: shop.id,
      label: numberedLabel(shop.shopNumber, shop.name),
    })),
  ];

  const machineItems = [
    { value: ALL, label: t('allMachines') },
    ...scope.machineOptions.map((machine) => ({ value: machine.id, label: machine.name })),
  ];

  const hasSelection = Boolean(scope.companyId || scope.shopId || scope.machineId);

  return (
    <section
      aria-label={t('barLabel')}
      className="rounded-lg border bg-card p-3 shadow-sm"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[9rem] space-y-1">
          <Label className="flex items-center gap-1.5 text-xs">
            <Layers className="h-3.5 w-3.5" aria-hidden />
            {t('organization')}
          </Label>
          <div className="flex h-8 items-center rounded-lg border border-dashed border-border px-2.5 text-sm font-medium">
            <span className="truncate">{tenantName}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('organizationHint')}</p>
        </div>

        <ScopeField
          label={t('company')}
          icon={Building2}
          disabled={!companyEnabled}
          disabledHint={t('notUsedHere')}
          required={isRequired('company')}
          requiredHint={t('requiredHere')}
        >
          <Select
            value={scope.companyId ?? ALL}
            onValueChange={(v) => scope.setCompany(!v || v === ALL ? null : (v as string))}
            items={companyItems}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('allCompanies')} />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value={ALL} label={t('allCompanies')}>
                {t('allCompanies')}
              </SelectItem>
              {scope.tree.flat.map((node) => (
                <SelectItem
                  key={node.company.id}
                  value={node.company.id}
                  label={numberedLabel(
                    node.company.companyNumber,
                    companyPathLabel(scope.tree, node.company.id, node.company.name),
                  )}
                >
                  <span style={indentStyle(node.depth)} className="flex items-center gap-1.5">
                    {node.depth > 0 ? (
                      <span aria-hidden className="text-muted-foreground">
                        ↳
                      </span>
                    ) : null}
                    <NumberPill n={node.company.companyNumber} />
                    <span className="truncate">{node.company.name}</span>
                    {node.parentMissing ? (
                      <span
                        aria-hidden
                        title={t('parentOutsideScope')}
                        className="text-muted-foreground"
                      >
                        ·
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ScopeField>

        <ScopeField
          label={t('shop')}
          icon={Store}
          disabled={!shopEnabled}
          disabledHint={t('notUsedHere')}
          required={isRequired('shop')}
          requiredHint={t('requiredHere')}
        >
          <Select
            value={scope.shopId ?? ALL}
            onValueChange={(v) => scope.setShop(!v || v === ALL ? null : (v as string))}
            items={shopItems}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('allShops')} />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value={ALL} label={t('allShops')}>
                {t('allShops')}
              </SelectItem>
              {scope.shopOptions.map((shop) => (
                <SelectItem
                  key={shop.id}
                  value={shop.id}
                  label={numberedLabel(shop.shopNumber, shop.name)}
                >
                  <span className="flex items-center gap-1.5">
                    <NumberPill n={shop.shopNumber} />
                    <span className="truncate">{shop.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ScopeField>

        <ScopeField
          label={t('machine')}
          icon={Monitor}
          disabled={!machineEnabled}
          disabledHint={t('notUsedHere')}
          required={isRequired('machine')}
          requiredHint={t('requiredHere')}
        >
          <Select
            value={scope.machineId ?? ALL}
            onValueChange={(v) => scope.setMachine(!v || v === ALL ? null : (v as string))}
            items={machineItems}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('allMachines')} />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value={ALL} label={t('allMachines')}>
                {t('allMachines')}
              </SelectItem>
              {scope.machineOptions.map((machine) => (
                <SelectItem key={machine.id} value={machine.id} label={machine.name}>
                  {machine.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ScopeField>

        <div className="space-y-1">
          <Label className="text-xs text-transparent" aria-hidden>
            {t('reset')}
          </Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!hasSelection}
            onClick={() => scope.clear()}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {t('reset')}
          </Button>
        </div>
      </div>
    </section>
  );
}
