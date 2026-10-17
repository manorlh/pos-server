/**
 * The shapes of the area-management API (pos-server app/routers/area_management.py, P:/specs/chain-areas.md §6,
 * §9, §12) as the price and point-of-sale screens read them.
 */

export interface ProductAreasShop {
  shopId: string;
  shopName: string;
  listed: boolean;
  allAreas: boolean;
  areas: { id: string; name: string; sold: boolean; editable: boolean }[];
}

export interface ProductAreasResponse {
  productId: string;
  shops: ProductAreasShop[];
}

export interface AreaPriceRow {
  areaId: string;
  areaName: string;
  price: number | null;
  effectivePrice: number;
  effectiveLevel: 'area' | 'shop' | 'base' | string;
  editable: boolean;
  reason: string | null;
}

export interface ShopPriceRow {
  shopId: string;
  shopName: string;
  price: number | null;
  effectivePrice: number;
  editable: boolean;
  reason: string | null;
  policy: PolicyOut;
  areas: AreaPriceRow[];
}

export interface ProductPricesResponse {
  productId: string;
  basePrice: number;
  baseEditable: boolean;
  baseReason: string | null;
  actorLevel: 'chain' | 'shop' | 'area' | string;
  locked: boolean;
  shops: ShopPriceRow[];
}

export interface PriceChangeRow {
  id: string;
  level: 'base' | 'shop' | 'area' | string;
  targetId: string | null;
  targetName: string | null;
  oldPrice: number | null;
  newPrice: number | null;
  by: string | null;
  machine: string | null;
  source: 'dashboard' | 'till' | string;
  at: string | null;
}

export type Editors = 'chain' | 'shop' | 'area';

export interface PolicyOut {
  editors: Editors;
  editorsLabel?: string;
  maxDeltaPct: number | null;
  lockedProductIds: string[];
  lockedCategoryIds: string[];
}

export interface PricePolicyResponse {
  companyId: string;
  own: {
    editors: Editors;
    shopEditors: Record<string, Editors>;
    lockedProductIds: string[];
    lockedCategoryIds: string[];
    maxDeltaPct: number | null;
    updatedAt: string | null;
  } | null;
  effective: PolicyOut;
  editorsOptions: { id: Editors; label: string }[];
}

export interface BulkPreviewRow {
  productId: string;
  productName: string;
  level: 'shop' | 'area' | string;
  targetId: string;
  targetName: string | null;
  oldPrice: number;
  newPrice: number;
  areaOverrides: { areaId: string; areaName: string; price: number }[];
  areaOverridesAction: 'keep' | 'replace' | null;
  refused: string | null;
}

export interface BulkPreviewResponse {
  shopId: string;
  rows: BulkPreviewRow[];
  counts: { rows: number; refused: number; changed: number; areaOverrides: number };
}

export interface PriceSchedule {
  id: string;
  shopId: string;
  label: string | null;
  startsAt: string | null;
  endsAt: string | null;
  status: string;
  itemCount: number;
  createdBy: string | null;
  appliedAt?: string | null;
  revertedAt?: string | null;
  error: string | null;
}

export interface OverviewDevice {
  id: string;
  name: string;
  posNumber: string | null;
  status: string | null;
}

export interface AreaOverview {
  id: string;
  name: string;
  status: { worst: string | null; counts: Record<string, number> } | null;
  devices: { till: OverviewDevice[]; kiosk: OverviewDevice[]; kds: OverviewDevice[]; board: OverviewDevice[] };
  deviceCount: number;
  blocks: { own: number; inherited: number };
  menus: { id: string; name: string; level: string; active: boolean }[];
  productsSold: number;
}

export interface AreasOverviewResponse {
  shopId: string;
  shopName: string;
  wholeShop: boolean;
  areas: AreaOverview[];
  unassignedDevices: number | null;
  productsInSomeAreas: number;
}
