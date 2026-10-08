"""Prepaid vouchers ("שוברי הפקה"): the dashboard's batch form and the till's lookup/redeem bodies."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import List, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.services.prepaid_voucher_rules import (
    DISCOUNT_KINDS,
    DISCOUNT_TYPES,
    KINDS,
    PROMOTION_POLICIES,
    STACKING,
)

NAME_MAX = 200
TEXT_MAX = 1000
TYPE_CODE_MAX = 32
#: A batch is printed and handed out by hand; thousands is already a lot of paper.
MAX_VOUCHERS_PER_BATCH = 5000
MAX_ITEMS_PER_VOUCHER = 30
MAX_ITEM_QUANTITY = 100
#: A group ("קבוצה", an envelope of 10 / 20 / any size); at most the whole run.
MAX_GROUP_SIZE = MAX_VOUCHERS_PER_BATCH
BARCODE_TYPES = ("qr", "code128")
REF_MAX = 100
#: Discount vouchers: the most a fixed one, a minimum or a cap may be (₪), and uses.
MONEY_MAX = Decimal("100000")
MAX_USES = 1000
MAX_TARGETS = 200


def _choice(value, allowed, field_name):
    if value is None:
        return None
    value = str(value).strip().lower()
    if value not in allowed:
        raise ValueError(f"{field_name}: one of {', '.join(allowed)}")
    return value


def _shekels(value, field_name):
    """A ₪ amount (or a percent) as typed: positive, at most two decimals' worth."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be a number")
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError(f"{field_name} must be a number")
    if not amount.is_finite() or amount < 0 or amount > MONEY_MAX:
        raise ValueError(f"{field_name} must be between 0 and {MONEY_MAX}")
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def agorot(amount: Optional[Decimal]) -> Optional[int]:
    """₪ → whole agorot (the till's and the rules' unit)."""
    return None if amount is None else int((amount * 100).to_integral_value(rounding=ROUND_HALF_UP))


class PrepaidVoucherTargetsIn(BaseModel):
    """An item discount's products and categories (global ids; a category takes its sub-categories)."""

    model_config = ConfigDict(populate_by_name=True)

    product_ids: List[uuid.UUID] = Field(default_factory=list, alias="productIds")
    category_ids: List[uuid.UUID] = Field(default_factory=list, alias="categoryIds")

    @model_validator(mode="after")
    def _check(self):
        self.product_ids = list(dict.fromkeys(self.product_ids))
        self.category_ids = list(dict.fromkeys(self.category_ids))
        if len(self.product_ids) + len(self.category_ids) > MAX_TARGETS:
            raise ValueError(f"at most {MAX_TARGETS} products and categories")
        return self


def _barcode(value):
    if value is None:
        return None
    value = str(value).strip().lower()
    if value not in BARCODE_TYPES:
        raise ValueError(f"one of {', '.join(BARCODE_TYPES)}")
    return value


def _clean_text(value, limit: int, *, required: bool = False):
    if value is None:
        if required:
            raise ValueError("required")
        return None
    if not isinstance(value, str):
        raise ValueError("must be text")
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f"at most {limit} characters")
    if required and not value:
        raise ValueError("required")
    return value or None


def _quantity(value, *, most) -> Decimal:
    """A goods quantity: above 0, at most [most], at most three decimals (a weight: "0.5" ק״ג).
    Whether a fraction is allowed is the product's (sold by weight) — checked by the service."""
    if isinstance(value, bool) or value is None or value == "":
        raise ValueError("quantity must be a number")
    try:
        q = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError("quantity must be a number")
    if not q.is_finite() or q <= 0 or q > most:
        raise ValueError(f"quantity must be above 0 and at most {most}")
    if q != q.quantize(Decimal("0.001")):
        raise ValueError("quantity: at most three decimals")
    return q.quantize(Decimal("0.001"))


class PrepaidVoucherItemIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    #: Units; for a product sold by weight a decimal of its unit ("0.5" ק״ג).
    quantity: Decimal

    @field_validator("quantity", mode="before")
    @classmethod
    def _qty(cls, value):
        return _quantity(value, most=MAX_ITEM_QUANTITY)


def _check_terms(m) -> None:
    """
    What a voucher gives, checked and tidied — the same for a batch made without a type and
    for a type: goods need items (each product once), a discount needs its terms.
    """
    if m.kind not in DISCOUNT_KINDS:
        if not m.items:
            raise ValueError("at least one item")
        if len(m.items) > MAX_ITEMS_PER_VOUCHER:
            raise ValueError(f"at most {MAX_ITEMS_PER_VOUCHER} items")
        if len({i.product_id for i in m.items}) != len(m.items):
            raise ValueError("each product at most once")
        # A goods voucher has no discount terms: whatever came is dropped.
        m.discount_type = m.discount_value = m.min_purchase = m.max_discount = None
        m.targets = None
        m.max_units = None
        return
    # A discount voucher: no goods, no "in parts" (its uses say how often), no extras.
    if m.items:
        raise ValueError("a discount voucher has no items")
    m.split_allowed = False
    m.include_extras = False
    if m.discount_type is None or m.discount_value is None or m.discount_value <= 0:
        raise ValueError("discountType and a discountValue above 0 are required")
    if m.discount_type == "percent" and m.discount_value > 100:
        raise ValueError("a percent is at most 100")
    if m.discount_type == "fixed" or m.kind == "item_discount":
        m.max_discount = None  # a cap is for a percent off the whole sale
    if m.max_discount is not None and m.max_discount <= 0:
        m.max_discount = None
    if m.kind == "order_discount":
        m.targets = None
        m.max_units = None
    else:
        m.min_purchase = None
        if m.targets is None or not (m.targets.product_ids or m.targets.category_ids):
            raise ValueError("an item discount names at least one product or category")
        m.max_units = m.max_units or 1
    if m.min_purchase is not None and m.min_purchase <= 0:
        m.min_purchase = None
    if m.max_uses_per_sale > m.uses_per_voucher:
        m.max_uses_per_sale = m.uses_per_voucher


def _check_prices(m, *, one_off: bool) -> None:
    """
    The two prices and how a redemption is priced and recorded (the spec's §5):

    * a discount voucher has none of them — it is a discount on the document;
    * `fixed` needs a till value (the redeemed goods come to it exactly, no top-up);
    * `cover` with a value pays the goods up to it (the rest a top-up when allowed); `cover`
      without one pays the goods whatever they cost — what every till did before types: the
      covered lines paid by the "שובר הפקה" tender (`payment`);
    * `redemption_accounting` — how the till books it: `discount` (a document deduction, the
      default), `payment` (the `production_voucher` tender), `zero` (₪0 lines, the value shown);
    * a batch made without a type ([one_off]) that says nothing: `discount`, `cover`, and `fixed`
      when it names a value.
    """
    if m.kind in DISCOUNT_KINDS:
        m.till_value = None
        m.pricing, m.allow_top_up, m.print_till_value = "cover", False, False
        m.redemption_accounting = "discount"  # a discount voucher is a discount on the document
        return
    if m.till_value is not None and m.till_value <= 0:
        raise ValueError("tillValue must be above 0")
    if one_off:
        if m.redemption_accounting is None:
            m.redemption_accounting = "discount"
        if m.pricing is None:
            m.pricing = "fixed" if m.till_value is not None else "cover"
        if m.allow_top_up is None:
            m.allow_top_up = True
        if m.print_till_value is None:
            m.print_till_value = False
    if m.pricing == "fixed" and m.till_value is None:
        raise ValueError("tillValue is required for a fixed value")
    if m.pricing == "fixed":
        m.allow_top_up = False  # a fixed value has no top-up (the spec's §5)
    if m.till_value is None:
        m.print_till_value = False


PRICINGS = ("fixed", "cover")
#: "קיזוז מהחשבונית (כמו הנחה)" / "אמצעי תשלום (חייב במע״מ)" / "₪0 עם הצגת שווי".
REDEMPTION_ACCOUNTING = ("discount", "payment", "zero")
#: Products that take no discounts ("לא מקבל הנחות", the spec's §7): honour the block, force
#: the type's price automatically (within caps), or force it with a manager's approval.
DISCOUNT_BLOCK_POLICIES = ("honour", "auto", "manager")


class PrepaidOverridePolicyIn(BaseModel):
    """The discount-block policy: its mode, optional caps (₪ / % per unit, ₪ per voucher) and scope."""

    model_config = ConfigDict(populate_by_name=True)

    mode: str = "honour"
    max_amount: Optional[Decimal] = Field(None, alias="maxAmount")
    max_percent: Optional[Decimal] = Field(None, alias="maxPercent")
    max_total: Optional[Decimal] = Field(None, alias="maxTotal")
    #: The products / categories it may force on (a category takes its sub-categories); null: all.
    scope: Optional[PrepaidVoucherTargetsIn] = None

    @field_validator("mode", mode="before")
    @classmethod
    def _mode(cls, value):
        return _choice(value, DISCOUNT_BLOCK_POLICIES, "discountBlockPolicy.mode") or "honour"

    @field_validator("max_amount", "max_percent", "max_total", mode="before")
    @classmethod
    def _caps(cls, value, info):
        return _shekels(value, info.field_name)

    @model_validator(mode="after")
    def _check(self):
        if self.max_percent is not None and self.max_percent > 100:
            raise ValueError("maxPercent is at most 100")
        if self.mode == "honour":
            self.max_amount = self.max_percent = self.max_total = None
            self.scope = None
        return self



class PrepaidVoucherTypeCreate(BaseModel):
    """"סוג שובר" — the template batches are issued from (the spec's §2–3)."""

    model_config = ConfigDict(populate_by_name=True)

    company_id: uuid.UUID = Field(..., alias="companyId")
    name: str
    code: Optional[str] = None
    description: Optional[str] = None
    active: bool = True
    kind: str = "items"
    items: List[PrepaidVoucherItemIn] = Field(default_factory=list)
    #: ₪ — the whole voucher's value at the till, and its price to the production.
    till_value: Optional[Decimal] = Field(None, alias="tillValue")
    production_price: Optional[Decimal] = Field(None, alias="productionPrice")
    #: "fixed" (default) or "cover".
    pricing: str = "fixed"
    allow_top_up: bool = Field(True, alias="allowTopUp")
    #: How the till books a redemption: "discount" (default) / "payment" / "zero".
    redemption_accounting: str = Field("discount", alias="redemptionAccounting")
    #: "הצג תוקף על השובר".
    show_validity: bool = Field(True, alias="showValidity")
    discount_block_policy: Optional[PrepaidOverridePolicyIn] = Field(None, alias="discountBlockPolicy")
    #: "מימוש ללא אינטרנט": the batches may be assigned to a till / the shop's LAN host.
    offline_allowed: bool = Field(False, alias="offlineAllowed")
    split_allowed: bool = Field(False, alias="splitAllowed")
    include_extras: bool = Field(False, alias="includeExtras")
    print_till_value: bool = Field(False, alias="printTillValue")
    discount_type: Optional[str] = Field(None, alias="discountType")
    discount_value: Optional[Decimal] = Field(None, alias="discountValue")
    min_purchase: Optional[Decimal] = Field(None, alias="minPurchase")
    max_discount: Optional[Decimal] = Field(None, alias="maxDiscount")
    targets: Optional[PrepaidVoucherTargetsIn] = None
    max_units: Optional[int] = Field(None, alias="maxUnits", ge=1, le=MAX_ITEM_QUANTITY)
    stacking: str = "single"
    promotion_policy: str = Field("exclude", alias="promotionPolicy")
    uses_per_voucher: int = Field(1, alias="usesPerVoucher", ge=1, le=MAX_USES)
    max_uses_per_sale: int = Field(1, alias="maxUsesPerSale", ge=1, le=MAX_USES)
    max_uses_per_day: Optional[int] = Field(None, alias="maxUsesPerDay", ge=1, le=MAX_USES)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, NAME_MAX, required=True)

    @field_validator("code", mode="before")
    @classmethod
    def _code(cls, value):
        value = _clean_text(value, TYPE_CODE_MAX)
        return value.upper() if value else None

    @field_validator("description", mode="before")
    @classmethod
    def _description(cls, value):
        return _clean_text(value, TEXT_MAX)

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, value):
        return _choice(value, KINDS, "kind") or "items"

    @field_validator("pricing", mode="before")
    @classmethod
    def _pricing(cls, value):
        return _choice(value, PRICINGS, "pricing") or "fixed"

    @field_validator("redemption_accounting", mode="before")
    @classmethod
    def _accounting(cls, value):
        return _choice(value, REDEMPTION_ACCOUNTING, "redemptionAccounting") or "discount"


    @field_validator("discount_type", mode="before")
    @classmethod
    def _discount_type(cls, value):
        return _choice(value, DISCOUNT_TYPES, "discountType")

    @field_validator("stacking", mode="before")
    @classmethod
    def _stacking(cls, value):
        return _choice(value, STACKING, "stacking") or "single"

    @field_validator("promotion_policy", mode="before")
    @classmethod
    def _policy(cls, value):
        return _choice(value, PROMOTION_POLICIES, "promotionPolicy") or "exclude"

    @field_validator("discount_value", "min_purchase", "max_discount", "till_value", "production_price", mode="before")
    @classmethod
    def _money(cls, value, info):
        return _shekels(value, info.field_name)

    @model_validator(mode="after")
    def _check(self):
        _check_terms(self)
        _check_prices(self, one_off=False)
        return self


class PrepaidVoucherTypeUpdate(BaseModel):
    """
    A type's change. Its name, code, description and whether it is active change in place; a
    change of what it gives or its prices makes a new version — batches already issued keep
    theirs. Absent fields stay; the goods are replaced as a whole when `items` is sent.
    """

    model_config = ConfigDict(populate_by_name=True)

    name: Optional[str] = None
    code: Optional[str] = None
    description: Optional[str] = None
    active: Optional[bool] = None
    items: Optional[List[PrepaidVoucherItemIn]] = None
    till_value: Optional[Decimal] = Field(None, alias="tillValue")
    production_price: Optional[Decimal] = Field(None, alias="productionPrice")
    pricing: Optional[str] = None
    allow_top_up: Optional[bool] = Field(None, alias="allowTopUp")
    redemption_accounting: Optional[str] = Field(None, alias="redemptionAccounting")
    show_validity: Optional[bool] = Field(None, alias="showValidity")
    discount_block_policy: Optional[PrepaidOverridePolicyIn] = Field(None, alias="discountBlockPolicy")
    offline_allowed: Optional[bool] = Field(None, alias="offlineAllowed")
    split_allowed: Optional[bool] = Field(None, alias="splitAllowed")
    include_extras: Optional[bool] = Field(None, alias="includeExtras")
    print_till_value: Optional[bool] = Field(None, alias="printTillValue")
    discount_type: Optional[str] = Field(None, alias="discountType")
    discount_value: Optional[Decimal] = Field(None, alias="discountValue")
    min_purchase: Optional[Decimal] = Field(None, alias="minPurchase")
    max_discount: Optional[Decimal] = Field(None, alias="maxDiscount")
    targets: Optional[PrepaidVoucherTargetsIn] = None
    max_units: Optional[int] = Field(None, alias="maxUnits", ge=1, le=MAX_ITEM_QUANTITY)
    stacking: Optional[str] = None
    promotion_policy: Optional[str] = Field(None, alias="promotionPolicy")
    uses_per_voucher: Optional[int] = Field(None, alias="usesPerVoucher", ge=1, le=MAX_USES)
    max_uses_per_sale: Optional[int] = Field(None, alias="maxUsesPerSale", ge=1, le=MAX_USES)
    max_uses_per_day: Optional[int] = Field(None, alias="maxUsesPerDay", ge=1, le=MAX_USES)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, NAME_MAX)

    @field_validator("code", mode="before")
    @classmethod
    def _code(cls, value):
        value = _clean_text(value, TYPE_CODE_MAX)
        return value.upper() if value else value

    @field_validator("description", mode="before")
    @classmethod
    def _description(cls, value):
        return _clean_text(value, TEXT_MAX)

    @field_validator("pricing", mode="before")
    @classmethod
    def _pricing(cls, value):
        return _choice(value, PRICINGS, "pricing")

    @field_validator("redemption_accounting", mode="before")
    @classmethod
    def _accounting(cls, value):
        return _choice(value, REDEMPTION_ACCOUNTING, "redemptionAccounting")

    @field_validator("discount_type", mode="before")
    @classmethod
    def _discount_type(cls, value):
        return _choice(value, DISCOUNT_TYPES, "discountType")

    @field_validator("stacking", mode="before")
    @classmethod
    def _stacking(cls, value):
        return _choice(value, STACKING, "stacking")

    @field_validator("promotion_policy", mode="before")
    @classmethod
    def _policy(cls, value):
        return _choice(value, PROMOTION_POLICIES, "promotionPolicy")

    @field_validator("discount_value", "min_purchase", "max_discount", "till_value", "production_price", mode="before")
    @classmethod
    def _money(cls, value, info):
        return _shekels(value, info.field_name)


class PrepaidVoucherBatchCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    company_id: uuid.UUID = Field(..., alias="companyId")
    #: The type it is issued from (the spec's §2): what it gives, its terms and prices are the
    #: type's. Absent: the batch says them itself and gets a type of its own (`origin` batch).
    type_id: Optional[uuid.UUID] = Field(None, alias="typeId")
    #: A batch without a type: its prices (₪) and how it is priced / recorded — see `_check_prices`.
    till_value: Optional[Decimal] = Field(None, alias="tillValue")
    production_price: Optional[Decimal] = Field(None, alias="productionPrice")
    pricing: Optional[str] = None
    allow_top_up: Optional[bool] = Field(None, alias="allowTopUp")
    redemption_accounting: Optional[str] = Field(None, alias="redemptionAccounting")
    show_validity: Optional[bool] = Field(None, alias="showValidity")
    discount_block_policy: Optional[PrepaidOverridePolicyIn] = Field(None, alias="discountBlockPolicy")
    offline_allowed: Optional[bool] = Field(None, alias="offlineAllowed")
    print_till_value: Optional[bool] = Field(None, alias="printTillValue")
    #: Null or empty: every shop of the company.
    shop_ids: Optional[List[uuid.UUID]] = Field(None, alias="shopIds")
    event_name: Optional[str] = Field(None, alias="eventName")
    logo_url: Optional[str] = Field(None, alias="logoUrl")
    free_text: Optional[str] = Field(None, alias="freeText")
    valid_from: Optional[datetime] = Field(None, alias="validFrom")
    valid_until: Optional[datetime] = Field(None, alias="validUntil")
    split_allowed: bool = Field(False, alias="splitAllowed")
    #: Goods (`items`); empty for a discount kind.
    items: List[PrepaidVoucherItemIn] = Field(default_factory=list)
    count: int = Field(..., ge=1, le=MAX_VOUCHERS_PER_BATCH)
    #: Goods: "כולל תוספות" — the voucher covers a dish's paid options and a meal's upcharges
    #: too. Off (the default): its base price as listed; what the extras cost is paid.
    include_extras: bool = Field(False, alias="includeExtras")
    # ── Kind and terms (docs/SPEC_VOUCHER_PRODUCTION.md §7) ──────────────────────
    #: "items" (goods, a tender — the default), "order_discount", "item_discount".
    kind: str = "items"
    #: Discount kinds: "fixed" (₪) or "percent".
    discount_type: Optional[str] = Field(None, alias="discountType")
    #: ₪ for fixed, the percent for percent (20 = 20%).
    discount_value: Optional[Decimal] = Field(None, alias="discountValue")
    #: order_discount: the least the discounted base must come to (₪), and a percent's cap (₪).
    min_purchase: Optional[Decimal] = Field(None, alias="minPurchase")
    max_discount: Optional[Decimal] = Field(None, alias="maxDiscount")
    #: item_discount: what is discounted, and how many units per use (default 1).
    targets: Optional[PrepaidVoucherTargetsIn] = None
    max_units: Optional[int] = Field(None, alias="maxUnits", ge=1, le=MAX_ITEM_QUANTITY)
    #: "single" (default), "distinct_batches", "unlimited".
    stacking: str = "single"
    #: Discount kinds: "exclude" (default), "best", "combine".
    promotion_policy: str = Field("exclude", alias="promotionPolicy")
    #: Discount kinds: uses per voucher, per sale, and (optional) per day.
    uses_per_voucher: int = Field(1, alias="usesPerVoucher", ge=1, le=MAX_USES)
    max_uses_per_sale: int = Field(1, alias="maxUsesPerSale", ge=1, le=MAX_USES)
    max_uses_per_day: Optional[int] = Field(None, alias="maxUsesPerDay", ge=1, le=MAX_USES)

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, value):
        return _choice(value, KINDS, "kind") or "items"

    @field_validator("pricing", mode="before")
    @classmethod
    def _pricing(cls, value):
        return _choice(value, PRICINGS, "pricing")

    @field_validator("redemption_accounting", mode="before")
    @classmethod
    def _accounting(cls, value):
        return _choice(value, REDEMPTION_ACCOUNTING, "redemptionAccounting")

    @field_validator("till_value", "production_price", mode="before")
    @classmethod
    def _prices(cls, value, info):
        return _shekels(value, info.field_name)

    @field_validator("discount_type", mode="before")
    @classmethod
    def _discount_type(cls, value):
        return _choice(value, DISCOUNT_TYPES, "discountType")

    @field_validator("stacking", mode="before")
    @classmethod
    def _stacking(cls, value):
        return _choice(value, STACKING, "stacking") or "single"

    @field_validator("promotion_policy", mode="before")
    @classmethod
    def _policy(cls, value):
        return _choice(value, PROMOTION_POLICIES, "promotionPolicy") or "exclude"

    @field_validator("discount_value", mode="before")
    @classmethod
    def _value(cls, value):
        return _shekels(value, "discountValue")

    @field_validator("min_purchase", mode="before")
    @classmethod
    def _min(cls, value):
        return _shekels(value, "minPurchase")

    @field_validator("max_discount", mode="before")
    @classmethod
    def _max(cls, value):
        return _shekels(value, "maxDiscount")
    #: Production in groups of this size (10, 20 or any); null: one run, no groups.
    group_size: Optional[int] = Field(None, alias="groupSize", ge=1, le=MAX_GROUP_SIZE)
    #: Print the voucher's code under its barcode.
    show_code: bool = Field(False, alias="showCode")
    #: "הצגת הפריטים על השובר": print the goods (a discount: what it gives). On by default.
    show_items: bool = Field(True, alias="showItems")
    #: "נוצר על ידי Runner Systems" at the bottom of the voucher. On by default.
    show_credit: bool = Field(True, alias="showCredit")
    #: "qr" (default) or "code128".
    barcode_type: str = Field("qr", alias="barcodeType")
    customer_name: Optional[str] = Field(None, alias="customerName")
    order_ref: Optional[str] = Field(None, alias="orderRef")

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        return _clean_text(value, NAME_MAX, required=True)

    @field_validator("barcode_type", mode="before")
    @classmethod
    def _barcode_type(cls, value):
        return _barcode(value) or "qr"

    @field_validator("customer_name", mode="before")
    @classmethod
    def _customer(cls, value):
        return _clean_text(value, NAME_MAX)

    @field_validator("order_ref", mode="before")
    @classmethod
    def _order(cls, value):
        return _clean_text(value, REF_MAX)

    @field_validator("event_name", mode="before")
    @classmethod
    def _event(cls, value):
        return _clean_text(value, NAME_MAX)

    @field_validator("free_text", mode="before")
    @classmethod
    def _free(cls, value):
        return _clean_text(value, TEXT_MAX)

    @field_validator("logo_url", mode="before")
    @classmethod
    def _logo(cls, value):
        return _clean_text(value, 500)

    @model_validator(mode="after")
    def _check(self):
        if self.valid_from and self.valid_until and self.valid_until <= self.valid_from:
            raise ValueError("validUntil must be after validFrom")
        if self.type_id is not None:
            # Issued from a type: what it gives, its terms and prices are the type's (copied
            # by the service) — whatever else came is not this batch's to say.
            return self
        _check_terms(self)
        _check_prices(self, one_off=True)
        return self

    # ── In the units the rules count in ──────────────────────────────────────

    @property
    def discount_value_units(self) -> Optional[int]:
        """Agorot for a fixed discount, basis points (2000 = 20%) for a percent."""
        if self.discount_value is None:
            return None
        return agorot(self.discount_value)


class PrepaidVoucherBatchUpdate(BaseModel):
    """What may change after printing: the texts that are not on paper yet, and validity."""

    model_config = ConfigDict(populate_by_name=True)

    name: Optional[str] = None
    event_name: Optional[str] = Field(None, alias="eventName")
    logo_url: Optional[str] = Field(None, alias="logoUrl")
    free_text: Optional[str] = Field(None, alias="freeText")
    valid_from: Optional[datetime] = Field(None, alias="validFrom")
    valid_until: Optional[datetime] = Field(None, alias="validUntil")
    # Print settings: they only change what the next print looks like.
    show_code: Optional[bool] = Field(None, alias="showCode")
    show_items: Optional[bool] = Field(None, alias="showItems")
    show_credit: Optional[bool] = Field(None, alias="showCredit")
    #: Print the till value on the voucher (the type's setting, per batch).
    print_till_value: Optional[bool] = Field(None, alias="printTillValue")
    # Editable after issue: every redemption records the mode it used.
    redemption_accounting: Optional[str] = Field(None, alias="redemptionAccounting")

    @field_validator("redemption_accounting", mode="before")
    @classmethod
    def _accounting(cls, value):
        return _choice(value, REDEMPTION_ACCOUNTING, "redemptionAccounting")
    show_validity: Optional[bool] = Field(None, alias="showValidity")
    discount_block_policy: Optional[PrepaidOverridePolicyIn] = Field(None, alias="discountBlockPolicy")
    offline_allowed: Optional[bool] = Field(None, alias="offlineAllowed")
    barcode_type: Optional[str] = Field(None, alias="barcodeType")
    customer_name: Optional[str] = Field(None, alias="customerName")
    order_ref: Optional[str] = Field(None, alias="orderRef")
    # The rules of use — not on the paper, so they may change (the next sale reads them).
    # What the voucher gives and its uses are printed / issued and never change.
    stacking: Optional[str] = None
    promotion_policy: Optional[str] = Field(None, alias="promotionPolicy")
    max_uses_per_sale: Optional[int] = Field(None, alias="maxUsesPerSale", ge=1, le=MAX_USES)
    #: Null clears the daily limit.
    max_uses_per_day: Optional[int] = Field(None, alias="maxUsesPerDay", ge=1, le=MAX_USES)

    @field_validator("stacking", mode="before")
    @classmethod
    def _stacking(cls, value):
        return _choice(value, STACKING, "stacking")

    @field_validator("promotion_policy", mode="before")
    @classmethod
    def _policy(cls, value):
        return _choice(value, PROMOTION_POLICIES, "promotionPolicy")

    @field_validator("name", "event_name", "customer_name", mode="before")
    @classmethod
    def _names(cls, value):
        return _clean_text(value, NAME_MAX)

    @field_validator("order_ref", mode="before")
    @classmethod
    def _order(cls, value):
        return _clean_text(value, REF_MAX)

    @field_validator("barcode_type", mode="before")
    @classmethod
    def _barcode_type(cls, value):
        return _barcode(value)

    @field_validator("free_text", mode="before")
    @classmethod
    def _free(cls, value):
        return _clean_text(value, TEXT_MAX)

    @field_validator("logo_url", mode="before")
    @classmethod
    def _logo(cls, value):
        return _clean_text(value, 500)


class PrepaidVoucherAddIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    count: int = Field(..., ge=1, le=MAX_VOUCHERS_PER_BATCH)
    #: In groups of this size (a new group first); null: the batch's own size, if any.
    group_size: Optional[int] = Field(None, alias="groupSize", ge=1, le=MAX_GROUP_SIZE)


class PrepaidVoucherGroupsIn(BaseModel):
    """Split the vouchers that have no group yet into groups of this size."""

    model_config = ConfigDict(populate_by_name=True)

    group_size: int = Field(..., alias="groupSize", ge=1, le=MAX_GROUP_SIZE)


class PrepaidVoucherCancelIn(BaseModel):
    """Why a voucher / a group / the batch is cancelled ("המעטפה אבדה"); kept in the audit trail."""

    reason: Optional[str] = None

    @field_validator("reason", mode="before")
    @classmethod
    def _reason(cls, value):
        return _clean_text(value, TEXT_MAX)


class PrepaidVoucherNoteIn(BaseModel):
    """A voucher's free-text note; blank or null clears it."""

    note: Optional[str] = None

    @field_validator("note", mode="before")
    @classmethod
    def _note(cls, value):
        return _clean_text(value, TEXT_MAX)


# ── Till ──────────────────────────────────────────────────────────────────────


def _kinds(value):
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError("supportedKinds must be a list")
    return [str(v).strip().lower() for v in value if str(v).strip()][:10]


class PrepaidVoucherLookupIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The code as scanned or typed: "PV:" prefix, dashes, spaces and case are ignored.
    code: str = Field(..., min_length=1, max_length=100)
    #: The voucher kinds this client can apply. Absent (every client before kinds — the
    #: web and Windows kiosks today): goods only, so a discount voucher reads as not
    #: redeemable here (`prepaid_voucher_kind_unsupported`, with a Hebrew `message`).
    supported_kinds: Optional[List[str]] = Field(None, alias="supportedKinds")

    @field_validator("supported_kinds", mode="before")
    @classmethod
    def _supported(cls, value):
        return _kinds(value)


class PrepaidVoucherRedeemItemIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The till's product id or the global product id — either is understood.
    product_id: str = Field(..., alias="productId", min_length=1, max_length=100)
    #: Units; a weighed item's in its unit ("0.5" ק״ג) — a fraction only for such an item.
    quantity: Decimal

    @field_validator("quantity", mode="before")
    @classmethod
    def _qty(cls, value):
        return _quantity(value, most=10_000)


class PrepaidVoucherRedeemIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    code: str = Field(..., min_length=1, max_length=100)
    items: List[PrepaidVoucherRedeemItemIn]
    #: Makes a retry safe: the same id from the same till returns the first answer.
    client_request_id: str = Field(..., alias="clientRequestId", min_length=1, max_length=100)
    #: One-time ("חד-פעמי") voucher, part of it taken: the cashier confirmed the rest is
    #: given up. Ignored for a voucher that may be redeemed in parts.
    forfeit_rest: bool = Field(False, alias="forfeitRest")
    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=100)
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=200)
    #: The till's sale document for these goods (client-generated id), if it made one.
    transaction_id: Optional[str] = Field(None, alias="transactionId", max_length=100)
    #: The till's open sale (basket) the voucher pays towards — how the cloud sees the
    #: other vouchers of the same sale (stacking). Absent from older clients.
    sale_ref: Optional[str] = Field(None, alias="saleRef", max_length=100)

    @field_validator("pos_user_id", mode="before")
    @classmethod
    def _uid(cls, value):
        if isinstance(value, (int, float)):
            return str(value)
        return value

    @model_validator(mode="after")
    def _check(self):
        if not self.items:
            raise ValueError("at least one item")
        return self


# ── Till: discount vouchers (reserve → confirm / release) ────────────────────


class PrepaidBasketLineIn(BaseModel):
    """One sale line of the open basket, money in agorot (the rules' unit)."""

    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(..., min_length=1, max_length=100)
    #: Every id the line's product goes by (the till's own and the cloud's).
    product_ids: List[str] = Field(default_factory=list, alias="productIds", max_length=5)
    category_ids: List[str] = Field(default_factory=list, alias="categoryIds", max_length=5)
    quantity: float = Field(1.0, gt=0, le=100_000)
    gross_agorot: int = Field(0, alias="grossAgorot", ge=0)
    line_discount_agorot: int = Field(0, alias="lineDiscountAgorot", ge=0)
    promotion_agorot: int = Field(0, alias="promotionAgorot", ge=0)
    #: What vouchers applied before this one already took off the line.
    voucher_agorot: int = Field(0, alias="voucherAgorot", ge=0)
    discountable: bool = True
    #: Sold by weight: an item discount takes it per kg, pro rata (§7.14). Absent from older tills.
    weighed: bool = False
    #: The general item ("פריט כללי"): never an item discount's.
    general: bool = False


class PrepaidVoucherInSaleIn(BaseModel):
    """Another voucher already in the sale, as the till holds it."""

    model_config = ConfigDict(populate_by_name=True)

    voucher_id: str = Field(..., alias="voucherId", min_length=1, max_length=100)
    batch_id: str = Field(..., alias="batchId", min_length=1, max_length=100)
    kind: str = "items"
    stacking: str = "single"


class PrepaidVoucherReserveIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    code: str = Field(..., min_length=1, max_length=100)
    #: Makes a retry safe, and a renewal: the same id from the same till answers the
    #: same reservation (held again for the full time while it can be).
    client_request_id: str = Field(..., alias="clientRequestId", min_length=1, max_length=100)
    #: The till's open sale (basket) the voucher is applied to.
    sale_ref: str = Field(..., alias="saleRef", min_length=1, max_length=100)
    #: Uses the till asks to take in this sale (the cloud may grant fewer).
    uses: int = Field(1, ge=1, le=MAX_USES)
    supported_kinds: Optional[List[str]] = Field(None, alias="supportedKinds")
    lines: List[PrepaidBasketLineIn] = Field(default_factory=list, max_length=500)
    other_vouchers: List[PrepaidVoucherInSaleIn] = Field(default_factory=list, alias="otherVouchers", max_length=50)
    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=100)
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=200)

    @field_validator("supported_kinds", mode="before")
    @classmethod
    def _supported(cls, value):
        return _kinds(value)

    @field_validator("pos_user_id", mode="before")
    @classmethod
    def _uid(cls, value):
        if isinstance(value, (int, float)):
            return str(value)
        return value


class PrepaidVoucherConfirmIn(BaseModel):
    """The sale was written: its document, and what the voucher took off on it."""

    model_config = ConfigDict(populate_by_name=True)

    transaction_id: str = Field(..., alias="transactionId", min_length=1, max_length=100)
    amount_agorot: int = Field(..., alias="amountAgorot", ge=0)
    uses: Optional[int] = Field(None, ge=1, le=MAX_USES)
