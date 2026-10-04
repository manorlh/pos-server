'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, fetchCompanies, fetchShops } from '@/lib/api';
import { entitySelectItems } from '@/lib/selectItems';
import { usePageScope } from '@/lib/scope';
import { ScopeIgnoredNote } from '@/components/dashboard/scope-gate';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  Product,
  Category,
  Company,
  ProductListResponse,
  ProductShopRow,
  Shop,
  ShopPriceInput,
  ShopScopeInput,
  Voucher,
  PaginatedResponse,
  TicketMode,
} from '@/lib/types';
import { buildCompanyTree } from '@/lib/companyTree';
import {
  ProductShopPricesTable,
  ShopPriceOverridesEditor,
  ShopScopeSection,
  draftFromProduct,
  scopeInputFromDraft,
  shopPricesFromDraft,
  useShopScopePreview,
  type ScopeDraft,
} from '@/components/dashboard/product-shop-scope';
import { ProductAvailabilitySection } from '@/components/dashboard/product-availability';
import { ProductFilters } from '@/components/dashboard/products/product-filters';
import { ProductBulkActions } from '@/components/dashboard/products/product-bulk-actions';
import {
  AvailabilitySummaryCell,
  useAvailabilitySummaries,
} from '@/components/dashboard/products/product-availability-summary';
import {
  PAGE_SIZES,
  productListQuery,
  useProductListParams,
  type PageSize,
} from '@/components/dashboard/products/product-list-params';
import { ProductImageUpload } from '@/components/product-image-upload';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Package, ChevronLeft, ChevronRight, Lock, FileSpreadsheet } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { ProductPrintersSection } from '@/components/dashboard/kitchen-printers/product-printers-section';
import { ProductMenuSection } from '@/components/dashboard/menu/menu-sections';

type SkuMode = 'auto' | 'manual';

/** The product's item-ticket choice; 'inherit' is stored as null. */
type ProductTicketChoice = TicketMode | 'inherit';
const TICKET_CHOICES: ProductTicketChoice[] = ['inherit', 'off', 'per_unit', 'per_line', 'per_sale'];

const EMPTY: Partial<Product> = {
  name: '', price: 0, description: '', inStock: true, stockQuantity: 0, catalogLevel: 'global',
};

function ProductThumbnail({ imageUrl, name }: { imageUrl?: string; name: string }) {
  if (!imageUrl) {
    return (
      <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center shrink-0">
        <Package className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }
  return (
    <div className="relative h-10 w-10 rounded-md overflow-hidden bg-muted shrink-0">
      <Image src={imageUrl} alt={name} fill className="object-cover" sizes="40px" />
    </div>
  );
}

/** A native checkbox that can show "some" — the header's select-all-on-page. */
function RowCheckbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      className="h-4 w-4 cursor-pointer accent-primary"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={label}
    />
  );
}

function buildSavePayload(
  p: Partial<Product>,
  companyId: string | undefined,
  skuMode: SkuMode,
  isNew: boolean,
  shopScope: ShopScopeInput | undefined,
  shopPrices: ShopPriceInput[] | undefined,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...p,
    companyId: p.companyId ?? companyId,
    // Always sent, so "inherit" (null) clears an earlier choice.
    ticketMode: p.ticketMode ?? 'inherit',
  };
  if (isNew && skuMode === 'auto') {
    delete payload.sku;
  }
  // The product as loaded carries the stored scope (without its shop list); echoing it
  // back is not a scope change. Only a scope the form actually set is sent.
  delete payload.shopScope;
  if (shopScope) payload.shopScope = shopScope;
  if (shopPrices && shopPrices.length > 0) payload.shopPrices = shopPrices;
  return payload;
}

export default function ProductsPage() {
  const t = useTranslations('products');
  const tl = useTranslations('productsList');
  const tc = useTranslations('common');
  const tt = useTranslations('itemTicket');
  const { user } = useAuth();
  /**
   * This is the tenant's *global* catalogue — one list of master products, not a
   * per-shop one. A shop or device in scope cannot narrow it, so rather than
   * pretend otherwise the page says the scope is not filtering here; per-shop
   * price, listing and availability live on the assortment page.
   */
  const { resolution } = usePageScope({ maxLevel: 'tenant' });
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Product>>(EMPTY);
  const [skuMode, setSkuMode] = useState<SkuMode>('auto');
  const { filters, setFilters, clearFilters } = useProductListParams();
  const { page, pageSize } = filters;
  /** Selected products by id — kept across pages, so a selection can span them. */
  const [selected, setSelected] = useState<Map<string, Product>>(() => new Map());
  /** null = the section has not been touched: a saved scope is left exactly as it is. */
  const [scopeDraft, setScopeDraft] = useState<ScopeDraft | null>(null);
  const [newShopPrices, setNewShopPrices] = useState<Record<string, string>>({});
  const isNew = !editing.id;
  const skuReadOnly = !isNew && editing.skuAutoAssigned === true;
  const isGlobal = (editing.catalogLevel ?? 'global') === 'global';
  /** The company's built-in general item: where it is sold is fixed on the server. */
  const isGeneral = editing.isGeneral === true;

  const { data, isLoading } = useQuery<ProductListResponse>({
    queryKey: ['products', productListQuery(filters)],
    queryFn: () =>
      api
        // Repeated keys (`categoryIds=a&categoryIds=b`), which is what FastAPI reads.
        .get('/products', { params: productListQuery(filters), paramsSerializer: { indexes: null } })
        .then((r) => r.data),
    placeholderData: (prev) => prev,
  });

  const products = useMemo(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const setPage = (next: number) => setFilters({ page: Math.min(Math.max(1, next), totalPages) });

  const pageIds = useMemo(() => products.map((p) => p.id), [products]);
  const summaries = useAvailabilitySummaries(
    useMemo(() => products.filter((p) => p.catalogLevel === 'global').map((p) => p.id), [products]),
  );
  const selectedOnPage = pageIds.filter((id) => selected.has(id)).length;
  const allOnPage = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const toggleOne = (p: Product, on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (on) next.set(p.id, p);
      else next.delete(p.id);
      return next;
    });
  const togglePage = (on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      for (const p of products) {
        if (on) next.set(p.id, p);
        else next.delete(p.id);
      }
      return next;
    });
  // A new search or filter is a new result set; a selection made in the old one would
  // act on rows the user can no longer see.
  const filterKey = JSON.stringify({ ...productListQuery(filters), page: undefined, pageSize: undefined });
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setSelected(new Map());
  }
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name;
  const categoryTicketMode = (id?: string): TicketMode =>
    categories.find((c) => c.id === id)?.ticketMode ?? 'off';
  /** What the till prints for this product: its own mode, else its category's. */
  const effectiveTicketMode = (p: Partial<Product>): TicketMode =>
    p.ticketMode ?? categoryTicketMode(p.categoryId);
  const ticketChoiceLabel = (m: ProductTicketChoice) =>
    m === 'inherit'
      ? tt('inheritWith', { mode: tt(categoryTicketMode(editing.categoryId)) })
      : tt(m);
  const ticketBadge = (p: Product) => {
    const mode = effectiveTicketMode(p);
    if (mode === 'off') return null;
    return (
      <Badge variant="outline" title={p.ticketMode ? tt('label') : tt('inheritWith', { mode: tt(mode) })}>
        {tt(mode)}
      </Badge>
    );
  };

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data),
  });

  const { data: vouchersData } = useQuery<PaginatedResponse<Voucher>>({
    queryKey: ['vouchers'],
    queryFn: () => api.get('/vouchers', { params: { page: 1, pageSize: 200 } }).then((r) => r.data),
  });
  const vouchers = vouchersData?.items ?? [];

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: fetchCompanies,
  });
  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => fetchShops(),
  });
  const tree = useMemo(() => buildCompanyTree(companies), [companies]);

  const productShops = useQuery<ProductShopRow[]>({
    queryKey: ['product-shops', editing.id],
    enabled: open && !!editing.id && isGlobal,
    queryFn: () => api.get(`/products/${editing.id}/shops`).then((r) => r.data),
  });

  // The company the product belongs to (or will, on create — see buildSavePayload).
  const productCompanyId = editing.companyId ?? user?.companyId ?? null;
  const defaultScopeCompanyId = productCompanyId ?? tree.roots[0]?.company.id ?? '';
  // New products default to "all shops of the product's company". A shop-level user
  // may only write their own shop's assortment, so for them that default would be
  // refused whenever the company has another shop; they start on their own shop.
  const shopLevelUser = !!user?.shopId && (user.role === 'shop_manager' || user.role === 'shift_supervisor');
  const newProductDraft: ScopeDraft = shopLevelUser
    ? { mode: 'shops', companyId: defaultScopeCompanyId, includeSubcompanies: false, shopIds: [user!.shopId!] }
    : { mode: 'company', companyId: defaultScopeCompanyId, includeSubcompanies: false, shopIds: [] };
  const draft: ScopeDraft =
    scopeDraft ??
    (isNew
      ? newProductDraft
      : draftFromProduct(editing.shopScope, productShops.data, defaultScopeCompanyId));
  const scopeInput = scopeInputFromDraft(draft, tree);
  const preview = useShopScopePreview(
    open && isGlobal ? scopeInput : undefined,
    editing.id,
    productCompanyId,
  );
  // A saved "only these shops" list is read from the product's rows; wait for them.
  const scopeLoading =
    !isNew && editing.shopScope?.mode === 'shops' && productShops.isLoading;

  const save = useMutation({
    mutationFn: (args: {
      product: Partial<Product>;
      mode: SkuMode;
      shopScope?: ShopScopeInput;
      shopPrices?: ShopPriceInput[];
    }) => {
      const payload = buildSavePayload(
        args.product, user?.companyId, args.mode, !args.product.id, args.shopScope, args.shopPrices,
      );
      return args.product.id
        ? api.put(`/products/${args.product.id}`, payload)
        : api.post('/products', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['product-shops'] });
      toast.success(isNew ? t('created') : t('updated'));
      setOpen(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/products/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] });
      toast.success(t('deleted'));
    },
  });

  const openNew = () => {
    setEditing(EMPTY);
    setSkuMode('auto');
    setScopeDraft(null);
    setNewShopPrices({});
    setOpen(true);
  };
  const openEdit = (p: Product) => {
    setEditing(p);
    setScopeDraft(null);
    setNewShopPrices({});
    setOpen(true);
  };

  const submit = () => {
    const sendScope = isGlobal && (isNew || scopeDraft !== null);
    const shopScope = sendScope ? scopeInput : undefined;
    const shopPrices =
      isNew && shopScope
        ? shopPricesFromDraft(newShopPrices, (preview.data?.shops ?? []).map((s) => s.id))
        : undefined;
    save.mutate({ product: editing, mode: skuMode, shopScope, shopPrices });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The menu as a spreadsheet: template, export, import — the company catalog's managers. */}
          {user?.role === 'super_admin' || user?.role === 'distributor' || user?.role === 'company_manager' ? (
            <Link href="/dashboard/products/import" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <FileSpreadsheet className="h-4 w-4 ms-1" /> {t('importExport')}
            </Link>
          ) : null}
          <Button onClick={openNew} size="sm">
            <Plus className="h-4 w-4 ms-1" /> {t('add')}
          </Button>
        </div>
      </div>

      {resolution.status === 'ok' && resolution.ignoredDeeper ? (
        <ScopeIgnoredNote maxLevel={resolution.maxLevel} />
      ) : null}

      <ProductFilters
        filters={filters}
        setFilters={setFilters}
        clearFilters={clearFilters}
        categories={categories}
      />

      {/* md and up: the table. */}
      <div className="hidden md:block rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <RowCheckbox
                  checked={allOnPage}
                  indeterminate={selectedOnPage > 0 && !allOnPage}
                  onChange={togglePage}
                  label={tl('selectPage')}
                />
              </TableHead>
              <TableHead className="w-14" />
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('globalSku')}</TableHead>
              <TableHead>{t('sku')}</TableHead>
              <TableHead>{t('price')}</TableHead>
              <TableHead>{t('category')}</TableHead>
              <TableHead>{tl('availabilityColumn')}</TableHead>
              <TableHead>{t('stock')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 10 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : products.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                        {tc('noResults')}
                      </TableCell>
                    </TableRow>
                  )
                : products.map((p) => (
                  <TableRow key={p.id} data-state={selected.has(p.id) ? 'selected' : undefined}>
                    <TableCell>
                      <RowCheckbox
                        checked={selected.has(p.id)}
                        onChange={(on) => toggleOne(p, on)}
                        label={tl('selectRow', { name: p.name })}
                      />
                    </TableCell>
                    <TableCell>
                      <ProductThumbnail imageUrl={p.imageUrl} name={p.name} />
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span>{p.name}</span>
                        {p.isGeneral ? (
                          <Badge variant="secondary" className="gap-1" title={t('systemItemTitle')}>
                            <Lock className="h-3 w-3" />
                            {t('systemItemBadge')}
                          </Badge>
                        ) : null}
                        {p.catalogLevel !== 'global' ? (
                          <Badge variant="outline">{tl('localBadge')}</Badge>
                        ) : null}
                        {ticketBadge(p)}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-sm">{p.globalSku ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{p.sku}</TableCell>
                    <TableCell>₪{Number(p.price).toFixed(2)}</TableCell>
                    <TableCell>{categoryName(p.categoryId) ?? '—'}</TableCell>
                    <TableCell>
                      <AvailabilitySummaryCell
                        productId={p.id}
                        productName={p.name}
                        summary={summaries.data?.[p.id]}
                        isLoading={summaries.isLoading}
                        applicable={p.catalogLevel === 'global'}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.inStock ? 'outline' : 'destructive'}>
                        {p.inStock ? `${p.stockQuantity} ${t('inStock')}` : t('outOfStock')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(p)} aria-label={tc('edit')}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {/* The general item cannot be deleted: the till's calculator sells through it. */}
                        {p.isGeneral ? null : (
                          <Button variant="ghost" size="icon" onClick={() => remove.mutate(p.id)}
                            aria-label={tc('delete')}
                            className="text-destructive hover:text-destructive">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      {/* Below md: one card per product. */}
      <div className="space-y-2 md:hidden">
        {products.length > 0 ? (
          <label className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <RowCheckbox
              checked={allOnPage}
              indeterminate={selectedOnPage > 0 && !allOnPage}
              onChange={togglePage}
              label={tl('selectPage')}
            />
            {tl('selectPage')}
          </label>
        ) : null}
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)
          : products.length === 0
            ? <p className="rounded-lg border bg-card py-8 text-center text-muted-foreground">{tc('noResults')}</p>
            : products.map((p) => (
              <div
                key={p.id}
                className={`rounded-lg border bg-card p-3 ${selected.has(p.id) ? 'ring-2 ring-primary/40' : ''}`}
              >
                <div className="flex items-start gap-3">
                  <div className="pt-1">
                    <RowCheckbox
                      checked={selected.has(p.id)}
                      onChange={(on) => toggleOne(p, on)}
                      label={tl('selectRow', { name: p.name })}
                    />
                  </div>
                  <ProductThumbnail imageUrl={p.imageUrl} name={p.name} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5 font-medium">
                      <span className="truncate">{p.name}</span>
                      {p.isGeneral ? (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="h-3 w-3" />
                          {t('systemItemBadge')}
                        </Badge>
                      ) : null}
                      {ticketBadge(p)}
                    </div>
                    <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span>₪{Number(p.price).toFixed(2)}</span>
                      <span>{categoryName(p.categoryId) ?? '—'}</span>
                      <span className="font-mono">{p.globalSku ?? p.sku}</span>
                    </div>
                    <AvailabilitySummaryCell
                      productId={p.id}
                      productName={p.name}
                      summary={summaries.data?.[p.id]}
                      isLoading={summaries.isLoading}
                      applicable={p.catalogLevel === 'global'}
                    />
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => openEdit(p)} aria-label={tc('edit')}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
      </div>

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            {tl('pageInfo', { page: String(page), pages: String(totalPages), total })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{tl('pageSize')}</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => setFilters({ pageSize: Number(v) as PageSize })}
              items={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
            >
              <SelectTrigger className="w-20" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)} label={String(n)}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm" variant="outline"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage(page - 1)}
            >
              <ChevronRight className="h-4 w-4" />
              {t('previousPage')}
            </Button>
            <Button
              size="sm" variant="outline"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage(page + 1)}
            >
              {t('nextPage')}
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <ProductBulkActions
        selected={[...selected.values()]}
        categories={categories}
        onClear={() => setSelected(new Map())}
        onDeleted={(ids) =>
          setSelected((prev) => {
            const next = new Map(prev);
            ids.forEach((id) => next.delete(id));
            return next;
          })
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isNew ? t('addTitle') : t('editTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {isGeneral ? (
              <div className="rounded-md border bg-muted/40 p-3 space-y-1">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Lock className="h-3.5 w-3.5" />
                  {t('systemItemTitle')}
                </p>
                <p className="text-xs text-muted-foreground">{t('systemItemHint')}</p>
              </div>
            ) : null}
            <ProductImageUpload
              value={editing.imageUrl}
              onChange={(url) => setEditing((p) => ({ ...p, imageUrl: url }))}
            />
            <div className="space-y-1">
              <Label>{t('name')}</Label>
              <Input value={editing.name ?? ''} onChange={(e) => setEditing((p) => ({ ...p, name: e.target.value }))} />
            </div>
            {isNew ? (
              <div className="space-y-2">
                <Label>{t('skuMode')}</Label>
                <Select
                  value={skuMode}
                  onValueChange={(v) => setSkuMode(v as SkuMode)}
                  items={[
                    { value: 'auto', label: t('skuModeAuto') },
                    { value: 'manual', label: t('skuModeManual') },
                  ]}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" label={t('skuModeAuto')}>{t('skuModeAuto')}</SelectItem>
                    <SelectItem value="manual" label={t('skuModeManual')}>{t('skuModeManual')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('globalSku')}</Label>
                {isNew ? (
                  <>
                    <Input disabled placeholder={t('skuAssignedOnSave')} />
                    <p className="text-xs text-muted-foreground">{t('globalSkuHint')}</p>
                  </>
                ) : (
                  <Input value={editing.globalSku ?? ''} disabled />
                )}
              </div>
              <div className="space-y-1">
                <Label>{t('sku')}</Label>
                {isNew && skuMode === 'auto' ? (
                  <>
                    <Input disabled placeholder={t('skuAssignedOnSave')} />
                    <p className="text-xs text-muted-foreground">{t('skuAutoHint')}</p>
                  </>
                ) : (
                  <>
                    <Input
                      value={editing.sku ?? ''}
                      disabled={skuReadOnly}
                      onChange={(e) => setEditing((p) => ({ ...p, sku: e.target.value }))}
                    />
                    {skuReadOnly ? (
                      <p className="text-xs text-muted-foreground">{t('skuAutoReadOnly')}</p>
                    ) : null}
                  </>
                )}
              </div>
              <div className="space-y-1">
                <Label>{t('price')}</Label>
                <Input type="number" step="0.01" value={editing.price ?? 0}
                  onChange={(e) => setEditing((p) => ({ ...p, price: parseFloat(e.target.value) }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('category')}</Label>
              <Select
                value={editing.categoryId ?? ''}
                onValueChange={(v) => setEditing((p) => ({ ...p, categoryId: v ?? undefined }))}
                items={entitySelectItems(categories)}
              >
                <SelectTrigger><SelectValue placeholder={t('selectCategory')} /></SelectTrigger>
                <SelectContent>
                  {categories.length === 0 ? (
                    <div className="py-3 px-2 text-sm text-muted-foreground text-center">{t('noCategories')}</div>
                  ) : (
                    categories.map((c) => <SelectItem key={c.id} value={c.id} label={c.name}>{c.name}</SelectItem>)
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('voucher')}</Label>
              <Select
                disabled={isGeneral}
                value={editing.voucherId ?? '__none__'}
                onValueChange={(v) =>
                  setEditing((p) => ({
                    ...p,
                    voucherId: !v || v === '__none__' ? undefined : v,
                  }))
                }
              >
                <SelectTrigger><SelectValue placeholder={t('noVoucher')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('noVoucher')}</SelectItem>
                  {vouchers.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{tt('label')}</Label>
              <Select
                value={editing.ticketMode ?? 'inherit'}
                onValueChange={(v) =>
                  setEditing((p) => ({
                    ...p,
                    ticketMode: !v || v === 'inherit' ? null : (v as TicketMode),
                  }))
                }
                items={TICKET_CHOICES.map((m) => ({ value: m, label: ticketChoiceLabel(m) }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TICKET_CHOICES.map((m) => (
                    <SelectItem key={m} value={m} label={ticketChoiceLabel(m)}>
                      {ticketChoiceLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{tt('productHint')}</p>
            </div>
            {/* An entry ticket: N entries per unit, each its own printed ticket. */}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label>{tt('entryTicket')}</Label>
                  <p className="text-xs text-muted-foreground">{tt('entryTicketHint')}</p>
                </div>
                <Switch
                  checked={(editing.ticketEntries ?? 0) >= 1}
                  onCheckedChange={(on) =>
                    setEditing((p) => ({ ...p, ticketEntries: on ? Math.max(p.ticketEntries ?? 1, 1) : null }))
                  }
                />
              </div>
              {(editing.ticketEntries ?? 0) >= 1 ? (
                <div className="flex items-center gap-2">
                  <Label className="shrink-0">{tt('entries')}</Label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={50}
                    className="w-24"
                    dir="ltr"
                    value={editing.ticketEntries ?? 1}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      setEditing((p) => ({ ...p, ticketEntries: Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 1 }));
                    }}
                  />
                  <span className="text-xs text-muted-foreground">
                    {tt('entriesHint', { n: editing.ticketEntries ?? 1 })}
                  </span>
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <Label>{t('trackStock')}</Label>
                <p className="text-xs text-muted-foreground">{t('trackStockHint')}</p>
              </div>
              <Switch
                disabled={isGeneral}
                checked={editing.trackStock ?? false}
                onCheckedChange={(c) => setEditing((p) => ({ ...p, trackStock: c }))}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <Label>{t('noDiscount')}</Label>
                <p className="text-xs text-muted-foreground">{t('noDiscountHint')}</p>
              </div>
              <Switch
                checked={editing.noDiscount ?? false}
                onCheckedChange={(c) => setEditing((p) => ({ ...p, noDiscount: c }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('barcode')}</Label>
                <Input value={editing.barcode ?? ''} onChange={(e) => setEditing((p) => ({ ...p, barcode: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('stockQty')}</Label>
                <Input type="number" value={editing.stockQuantity ?? 0}
                  onChange={(e) => setEditing((p) => ({ ...p, stockQuantity: parseInt(e.target.value) }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('description')}</Label>
              <Input value={editing.description ?? ''} onChange={(e) => setEditing((p) => ({ ...p, description: e.target.value }))} />
            </div>
            {isGlobal ? (
              <ShopScopeSection
                draft={draft}
                onChange={setScopeDraft}
                tree={tree}
                companies={companies}
                shops={shops}
                productCompanyId={productCompanyId}
                showManual={!isNew && !editing.shopScope}
                disabled={scopeLoading || isGeneral}
                preview={preview}
              />
            ) : null}
            {isGlobal && isNew && scopeInput ? (
              <ShopPriceOverridesEditor
                shops={preview.data?.shops ?? []}
                basePrice={Number(editing.price ?? 0)}
                prices={newShopPrices}
                onChange={setNewShopPrices}
              />
            ) : null}
            {isGlobal && !isNew && editing.id ? (
              <ProductShopPricesTable
                productId={editing.id}
                basePrice={Number(editing.price ?? 0)}
                rows={productShops.data}
                isLoading={productShops.isLoading}
              />
            ) : null}
            {isGlobal && !isNew && editing.id ? (
              <ProductAvailabilitySection productId={editing.id} />
            ) : null}
            {/* Kitchen / bar printers ("מדפסות בונים"): by the category, chosen printers, or none. */}
            {!isNew && editing.id ? <ProductPrintersSection productId={editing.id} /> : null}
            {/* "תוספות, הערות ואלרגנים" and "ארוחה" (docs/SPEC_MENU_MODIFIERS.md §12). */}
            {!isNew && editing.id ? <ProductMenuSection productId={editing.id} /> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{tc('cancel')}</Button>
            <Button
              onClick={submit}
              disabled={
                save.isPending ||
                scopeLoading ||
                // Per-shop prices are matched to the preview's shops; wait for it.
                (isNew && Object.values(newShopPrices).some((v) => v.trim() !== '') && preview.isFetching) ||
                (isNew && skuMode === 'manual' && !editing.sku?.trim())
              }
            >
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
