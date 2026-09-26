'use client';

/**
 * "Available for sale" for a catalog product: per company, per shop, per till.
 *
 * Locked means the till still shows the product and will not sell it (hiding is the
 * shop's "listed" flag, elsewhere). Nearest level wins — till, then shop, then the
 * shop's own company, then the product itself — and a parent company's setting never
 * reaches a sub-company's shops.
 *
 * The rule lives on the server (app/services/product_availability.py). Everything shown
 * here — what each level inherits, what it resolves to, which level decided — comes from
 * `GET /products/{id}/availability`; this file only displays it and sends the three-way
 * choice back. It never works out an effective value itself.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerDownLeft, EyeOff, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import type {
  AvailabilityLevel,
  AvailabilityNode,
  CompanyAvailability,
  MachineAvailability,
  ProductAvailability,
  ShopAvailability,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';

type Translate = ReturnType<typeof useTranslations>;

/** Inherit / available / locked. `inherited` is what "inherit" currently means. */
export function AvailabilityControl({
  value,
  inherited,
  onChange,
  disabled,
  label,
}: {
  value: boolean | null;
  inherited: boolean;
  onChange: (next: boolean | null) => void;
  disabled?: boolean;
  label: string;
}) {
  const t = useTranslations('availability');
  const options: { key: string; value: boolean | null; text: string }[] = [
    {
      key: 'inherit',
      value: null,
      text: t('inheritWithValue', { state: inherited ? t('available') : t('locked') }),
    },
    { key: 'available', value: true, text: t('available') },
    { key: 'locked', value: false, text: t('locked') },
  ];
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 gap-0.5 rounded-lg border p-0.5">
      {options.map((o) => {
        const checked = value === o.value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => {
              if (!checked) onChange(o.value);
            }}
            className={cn(
              'rounded-md px-2 py-0.5 text-xs whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              checked
                ? o.value === false
                  ? 'bg-destructive/15 font-medium text-destructive'
                  : o.value === true
                    ? 'bg-primary font-medium text-primary-foreground'
                    : 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {o.text}
          </button>
        );
      })}
    </div>
  );
}

export function EffectiveBadge({ available, t }: { available: boolean; t: Translate }) {
  return available ? (
    <Badge variant="outline">{t('available')}</Badge>
  ) : (
    <Badge variant="destructive">
      <Lock aria-hidden />
      {t('locked')}
    </Badge>
  );
}

const SOURCE_KEY: Record<AvailabilityLevel, string> = {
  product: 'sourceProduct',
  company: 'sourceCompany',
  shop: 'sourceShop',
  machine: 'sourceMachine',
};

/** Set here, and different from what this level would have inherited. */
function overrides(node: AvailabilityNode): boolean {
  return node.value !== null && node.value !== node.inherited;
}

function NodeRow({
  title,
  subtitle,
  node,
  overrideLabel,
  onChange,
  pending,
  extra,
  t,
}: {
  title: string;
  subtitle?: string;
  node: AvailabilityNode;
  overrideLabel: string;
  onChange: (next: boolean | null) => void;
  pending: boolean;
  extra?: ReactNode;
  t: Translate;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {subtitle ? <div className="text-xs text-muted-foreground">{subtitle}</div> : null}
      </div>
      <AvailabilityControl
        value={node.value}
        inherited={node.inherited}
        onChange={onChange}
        disabled={!node.canEdit || pending}
        label={t('controlLabel', { name: title })}
      />
      <div className="flex min-w-40 flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground">{t('effective')}:</span>
        <EffectiveBadge available={node.effective} t={t} />
        {overrides(node) ? (
          <Badge variant="secondary">
            <CornerDownLeft aria-hidden />
            {overrideLabel}
          </Badge>
        ) : null}
        {extra}
      </div>
      <div className="basis-full text-xs text-muted-foreground">
        {t(SOURCE_KEY[node.source])}
        {!node.canEdit ? <span className="ms-2">· {t('readOnly')}</span> : null}
      </div>
    </div>
  );
}

function MachineRows({
  shop,
  onSet,
  pending,
  t,
}: {
  shop: ShopAvailability;
  onSet: (path: string, value: boolean | null) => void;
  pending: boolean;
  t: Translate;
}) {
  if (shop.machines.length === 0) {
    return <p className="py-1 text-xs text-muted-foreground">{t('noMachines')}</p>;
  }
  return (
    <>
      {shop.machines.map((m: MachineAvailability) => (
        <NodeRow
          key={m.machineId}
          title={m.name}
          subtitle={m.posNumber ? t('machineNumber', { number: m.posNumber }) : undefined}
          node={m}
          overrideLabel={t('overridesShop')}
          onChange={(v) => onSet(`machines/${m.machineId}`, v)}
          pending={pending}
          extra={
            m.inCatalog === false ? (
              <Badge variant="secondary" title={t('notInMachineCatalogHint')}>
                <EyeOff aria-hidden />
                {t('notInMachineCatalog')}
              </Badge>
            ) : null
          }
          t={t}
        />
      ))}
    </>
  );
}

function CompanyBlock({
  company,
  onSet,
  pending,
  t,
}: {
  company: CompanyAvailability;
  onSet: (path: string, value: boolean | null) => void;
  pending: boolean;
  t: Translate;
}) {
  return (
    <div className="rounded-md border p-2">
      <NodeRow
        title={company.companyName ?? t('unnamedCompany')}
        subtitle={t('companyLevel')}
        node={company}
        overrideLabel={t('overridesProduct')}
        onChange={(v) => onSet(`companies/${company.companyId}`, v)}
        pending={pending}
        t={t}
      />
      <div className="ms-2 border-s ps-3">
        {company.shops.map((shop) => (
          <div key={shop.shopId} className="py-0.5">
            <NodeRow
              title={shop.shopName}
              subtitle={t('shopLevel')}
              node={shop}
              overrideLabel={t('overridesCompany')}
              onChange={(v) => onSet(`shops/${shop.shopId}`, v)}
              pending={pending}
              extra={!shop.isListed ? <Badge variant="secondary">{t('notListed')}</Badge> : null}
              t={t}
            />
            <div className="ms-2 border-s ps-3">
              <MachineRows shop={shop} onSet={onSet} pending={pending} t={t} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The availability section of a saved global product's edit dialog. */
export function ProductAvailabilitySection({ productId }: { productId: string }) {
  const t = useTranslations('availability');
  const qc = useQueryClient();
  const query = useQuery<ProductAvailability>({
    queryKey: ['product-availability', productId],
    queryFn: () => api.get(`/products/${productId}/availability`).then((r) => r.data),
  });

  const put = useMutation({
    mutationFn: ({ path, value }: { path: string; value: boolean | null }) =>
      api.put(`/products/${productId}/availability/${path}`, { isAvailable: value }),
    onSuccess: (_data, vars) => {
      toast.success(vars.value === null ? t('cleared') : t('saved'));
      qc.invalidateQueries({ queryKey: ['product-availability', productId] });
      qc.invalidateQueries({ queryKey: ['shop-product-overrides'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });
  const onSet = (path: string, value: boolean | null) => put.mutate({ path, value });

  const data = query.data;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Label className="text-sm font-semibold">{t('title')}</Label>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <p className="text-xs text-muted-foreground">{t('noCrossCompany')}</p>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : query.isError || !data ? (
        <p className="text-sm text-destructive">{t('loadError')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t('productDefault')}:</span>
            <EffectiveBadge available={data.productAvailable} t={t} />
          </div>
          {data.companies.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <div className="max-h-96 space-y-2 overflow-y-auto">
              {data.companies.map((c) => (
                <CompanyBlock key={c.companyId} company={c} onSet={onSet} pending={put.isPending} t={t} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
