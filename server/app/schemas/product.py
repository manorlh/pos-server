from pydantic import BaseModel, Field, field_validator, model_validator
from typing import List, Optional, Literal
import uuid
from decimal import Decimal
from datetime import datetime


class ShopScopeIn(BaseModel):
    """
    Where a global product is sold. Two shapes:

    * ``{"mode": "company", "companyId": ..., "includeSubcompanies": bool}`` — a rule:
      every active shop of that company (and its sub-companies, if asked), including
      shops opened later.
    * ``{"mode": "shops", "shopIds": [...]}`` — exactly these shops, nothing added later.
    """

    mode: Literal["company", "shops"]
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    include_subcompanies: bool = Field(False, alias="includeSubcompanies")
    shop_ids: Optional[List[uuid.UUID]] = Field(None, alias="shopIds")

    @model_validator(mode="after")
    def _shape_matches_mode(self):
        if self.mode == "company":
            if self.company_id is None:
                raise ValueError("companyId is required when mode is 'company'")
            if self.shop_ids:
                raise ValueError("shopIds is only allowed when mode is 'shops'")
        else:
            if self.shop_ids is None:
                raise ValueError("shopIds is required when mode is 'shops'")
            if self.company_id is not None or self.include_subcompanies:
                raise ValueError("companyId/includeSubcompanies are only allowed when mode is 'company'")
            # Order-preserving de-duplication; a repeated id is not an error, just noise.
            seen, out = set(), []
            for sid in self.shop_ids:
                if sid not in seen:
                    seen.add(sid)
                    out.append(sid)
            self.shop_ids = out
        return self

    class Config:
        populate_by_name = True


class ShopPriceIn(BaseModel):
    """A per-shop price. ``price: null`` means "the product's base price"."""

    shop_id: uuid.UUID = Field(..., alias="shopId")
    price: Optional[Decimal] = Field(None, ge=0)

    class Config:
        populate_by_name = True


def _no_repeated_shop(prices):
    if prices is None:
        return prices
    ids = [p.shop_id for p in prices]
    if len(ids) != len(set(ids)):
        raise ValueError("shopPrices names the same shop twice")
    return prices


class ShopScopeOut(BaseModel):
    """The stored scope. For ``shops`` mode the list itself is `GET /products/{id}/shops`."""

    mode: Literal["company", "shops"]
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    include_subcompanies: bool = Field(False, alias="includeSubcompanies")

    class Config:
        from_attributes = True
        populate_by_name = True


class ProductBase(BaseModel):
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    price: Decimal = Field(..., ge=0)
    sku: str = Field(..., min_length=1)
    category_id: uuid.UUID = Field(..., alias="categoryId")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    in_stock: bool = Field(True, alias="inStock")
    stock_quantity: int = Field(0, ge=0, alias="stockQuantity")
    barcode: Optional[str] = None
    tax_rate: Optional[Decimal] = Field(None, ge=0, alias="taxRate")
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    track_stock: bool = Field(False, alias="trackStock")
    # "General item": the cashier types the amount at the till, so `price` is only the
    # suggestion the till pre-fills.
    is_open_price: bool = Field(False, alias="isOpenPrice")
    # Sold by weight/volume: the till's cart quantity is a decimal for this product and
    # `price` is per `unitLabel`.
    #
    # `isWeighed` and `isOpenPrice` are both allowed on the same product, and that is a
    # decision rather than an oversight: they describe different halves of a cart line.
    # `isWeighed` governs the *quantity* the cashier enters, `isOpenPrice` governs the
    # *amount*. Loose goods weighed on a scale the till cannot read — the cashier types
    # the money the scale printed — is precisely both at once, and it is an ordinary deli
    # counter, not a corner case. Forbidding the pair would block a real configuration;
    # silently ignoring one of the two flags would leave the till guessing which keypad
    # to open.
    is_weighed: bool = Field(False, alias="isWeighed")
    unit_label: Optional[str] = Field(None, max_length=16, alias="unitLabel")

    @field_validator("name", "sku")
    @classmethod
    def validate_non_empty(cls, v):
        if isinstance(v, str) and not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip() if isinstance(v, str) else v

    class Config:
        populate_by_name = True


class ProductCreate(ProductBase):
    sku: Optional[str] = Field(None, min_length=1)
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    pos_machine_id: Optional[uuid.UUID] = Field(None, alias="posMachineId")
    catalog_level: Literal["global", "local"] = Field("global", alias="catalogLevel")
    global_product_id: Optional[uuid.UUID] = Field(None, alias="globalProductId")
    # Optional: omitted keeps today's behaviour (the product is on no shop until one is
    # added from the assortment page).
    shop_scope: Optional[ShopScopeIn] = Field(None, alias="shopScope")
    shop_prices: Optional[List[ShopPriceIn]] = Field(None, alias="shopPrices")
    # Accepted only so that asking for a general item is refused out loud rather than
    # silently ignored: every company's one general item is built in (see
    # app/services/general_item.py).
    is_general: Optional[bool] = Field(None, alias="isGeneral")

    @field_validator("shop_prices")
    @classmethod
    def _prices_name_each_shop_once(cls, v):
        return _no_repeated_shop(v)


class ProductUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1)
    description: Optional[str] = None
    price: Optional[Decimal] = Field(None, ge=0)
    sku: Optional[str] = Field(None, min_length=1)
    category_id: Optional[uuid.UUID] = Field(None, alias="categoryId")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    in_stock: Optional[bool] = Field(None, alias="inStock")
    stock_quantity: Optional[int] = Field(None, ge=0, alias="stockQuantity")
    barcode: Optional[str] = None
    tax_rate: Optional[Decimal] = Field(None, ge=0, alias="taxRate")
    is_local_override: Optional[bool] = Field(None, alias="isLocalOverride")
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    track_stock: Optional[bool] = Field(None, alias="trackStock")
    is_open_price: Optional[bool] = Field(None, alias="isOpenPrice")
    is_weighed: Optional[bool] = Field(None, alias="isWeighed")
    unit_label: Optional[str] = Field(None, max_length=16, alias="unitLabel")
    # Never changes. Echoing the current value (a form sending the product back) is
    # fine; anything else is refused — see app/services/general_item.py.
    is_general: Optional[bool] = Field(None, alias="isGeneral")
    # Omitted: the scope is left exactly as it is.
    shop_scope: Optional[ShopScopeIn] = Field(None, alias="shopScope")
    shop_prices: Optional[List[ShopPriceIn]] = Field(None, alias="shopPrices")

    @field_validator("shop_prices")
    @classmethod
    def _prices_name_each_shop_once(cls, v):
        return _no_repeated_shop(v)

    @field_validator("name", "sku")
    @classmethod
    def validate_non_empty(cls, v):
        if v is not None and isinstance(v, str) and not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip() if v and isinstance(v, str) else v

    class Config:
        populate_by_name = True


class ProductResponse(BaseModel):
    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    pos_machine_id: Optional[uuid.UUID] = Field(None, alias="posMachineId")
    global_product_id: Optional[uuid.UUID] = Field(None, alias="globalProductId")
    catalog_level: str = Field(..., alias="catalogLevel")
    is_local_override: bool = Field(..., alias="isLocalOverride")
    name: str
    description: Optional[str]
    price: Decimal
    sku: str
    global_sku: Optional[str] = Field(None, alias="globalSku")
    sku_auto_assigned: bool = Field(False, alias="skuAutoAssigned")
    category_id: uuid.UUID = Field(..., alias="categoryId")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    in_stock: bool = Field(..., alias="inStock")
    is_available: bool = Field(..., alias="isAvailable")
    stock_quantity: int = Field(..., alias="stockQuantity")
    barcode: Optional[str]
    tax_rate: Optional[Decimal] = Field(None, alias="taxRate")
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    track_stock: bool = Field(False, alias="trackStock")
    is_open_price: bool = Field(False, alias="isOpenPrice")
    is_weighed: bool = Field(False, alias="isWeighed")
    unit_label: Optional[str] = Field(None, alias="unitLabel")
    # The company's built-in "פריט כללי", which the till's calculator sells through.
    is_general: bool = Field(False, alias="isGeneral")
    shop_scope: Optional[ShopScopeOut] = Field(None, alias="shopScope")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True


class ProductListResponse(BaseModel):
    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    items: List[ProductResponse]

    class Config:
        populate_by_name = True


class ProductShopRow(BaseModel):
    """One shop a product is assigned to, listed or not."""

    shop_id: uuid.UUID = Field(..., alias="shopId")
    shop_name: str = Field(..., alias="shopName")
    company_id: uuid.UUID = Field(..., alias="companyId")
    company_name: Optional[str] = Field(None, alias="companyName")
    # Floats on the wire, like `ShopProductCatalogRow`: a Decimal serialises as a string.
    price: Optional[float] = None
    effective_price: float = Field(..., alias="effectivePrice")
    is_listed: bool = Field(..., alias="isListed")
    assigned_by_rule: bool = Field(..., alias="assignedByRule")

    class Config:
        populate_by_name = True


class ShopScopePreviewRequest(BaseModel):
    shop_scope: ShopScopeIn = Field(..., alias="shopScope")
    # The product being edited, or — for one not created yet — the company it will
    # belong to. Either decides which shops it may be sold in at all.
    product_id: Optional[uuid.UUID] = Field(None, alias="productId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")

    class Config:
        populate_by_name = True


class ShopScopePreviewShop(BaseModel):
    id: uuid.UUID
    name: str
    company_id: uuid.UUID = Field(..., alias="companyId")

    class Config:
        populate_by_name = True


class ShopScopePreviewResponse(BaseModel):
    shop_count: int = Field(..., alias="shopCount")
    machine_count: int = Field(..., alias="machineCount")
    shops: List[ShopScopePreviewShop]

    class Config:
        populate_by_name = True
