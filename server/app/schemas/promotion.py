"""
Promotions ("מבצעים"): the dashboard's body, and the validation of each type's `config`.

The config is one JSON object per type (camelCase, as the till reads it):

* groups — `{"all": bool, "productIds": [...], "categoryIds": [...],
  "excludeProductIds": [...], "excludeCategoryIds": [...]}`. A category means it and
  every sub-category under it (expanded when sent to the till).
* `buy_x_get_y` — `target`, `buyQuantity`, `getQuantity`, `getDiscountPercent` (100 = free)
* `bundle_price` — `target`, `quantity`, `price`
* `discount` — `target`, `discountKind` ("percent" | "amount"), `discountValue`
* `threshold_gift` — `threshold`, `counted` (default: the whole basket), `giftProductId`,
  `giftQuantity`
* `threshold_item_price` — `threshold`, `counted`, `reward`, `specialPrice`
* `threshold_basket_discount` — `threshold`, `counted`, `discountKind`, `discountValue`
* `combo` — `components` (2–10 of `{"group", "quantity"}`), `price`

`clean_config` returns it normalized: ids as strings, money rounded to the agora, a
defaulted field filled in, unknown keys dropped.
"""
from __future__ import annotations

import re
import uuid
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.promotion import PROMOTION_SCOPE_LEVELS, PROMOTION_TYPES

NAME_MAX = 120
DESCRIPTION_MAX = 1000
GROUP_IDS_MAX = 500
MONEY_MAX = Decimal("1000000")
QUANTITY_MAX = 99
COMBO_COMPONENTS_MAX = 10
MAX_APPLICATIONS_MAX = 999
PRIORITY_MIN, PRIORITY_MAX = 0, 100

_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

PromotionType = Literal[
    "buy_x_get_y",
    "bundle_price",
    "discount",
    "threshold_gift",
    "threshold_item_price",
    "threshold_basket_discount",
    "combo",
]
assert set(PromotionType.__args__) == set(PROMOTION_TYPES)  # type: ignore[attr-defined]

#: The types whose condition is the basket's total: once per sale unless told otherwise.
THRESHOLD_TYPES = ("threshold_gift", "threshold_item_price", "threshold_basket_discount")


class PromotionConfigError(ValueError):
    """A config that does not fit its type."""


# ── Config pieces ─────────────────────────────────────────────────────────────


def _ids(value: Any, field: str) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise PromotionConfigError(f"{field} must be a list of ids")
    out: List[str] = []
    for raw in value:
        try:
            ident = str(uuid.UUID(str(raw)))
        except (ValueError, AttributeError, TypeError):
            raise PromotionConfigError(f"{field}: {raw!r} is not an id")
        if ident not in out:
            out.append(ident)
    if len(out) > GROUP_IDS_MAX:
        raise PromotionConfigError(f"{field}: at most {GROUP_IDS_MAX} ids")
    return out


def clean_group(value: Any, field: str, *, required: bool, default_all: bool = False) -> Dict[str, Any]:
    """A product group. `required`: it must name something (all, a product or a category)."""
    if value is None:
        if default_all:
            value = {"all": True}
        elif required:
            raise PromotionConfigError(f"{field} is required")
        else:
            value = {}
    if not isinstance(value, dict):
        raise PromotionConfigError(f"{field} must be an object")
    group = {
        "all": bool(value.get("all", False)),
        "productIds": _ids(value.get("productIds"), f"{field}.productIds"),
        "categoryIds": _ids(value.get("categoryIds"), f"{field}.categoryIds"),
        "excludeProductIds": _ids(value.get("excludeProductIds"), f"{field}.excludeProductIds"),
        "excludeCategoryIds": _ids(value.get("excludeCategoryIds"), f"{field}.excludeCategoryIds"),
    }
    if group["all"]:
        # Everything: an explicit list beside it says nothing more.
        group["productIds"], group["categoryIds"] = [], []
    if required and not (group["all"] or group["productIds"] or group["categoryIds"]):
        raise PromotionConfigError(f"{field}: choose products, categories or the whole basket")
    return group


def _money(value: Any, field: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or value is None:
        raise PromotionConfigError(f"{field} must be an amount")
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise PromotionConfigError(f"{field} must be an amount")
    if not amount.is_finite() or amount < 0 or amount > MONEY_MAX:
        raise PromotionConfigError(f"{field} must be between 0 and {MONEY_MAX}")
    if positive and amount <= 0:
        raise PromotionConfigError(f"{field} must be more than 0")
    return float(amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _int(value: Any, field: str, low: int, high: int, default: Optional[int] = None) -> int:
    if value is None and default is not None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise PromotionConfigError(f"{field} must be a whole number")
    value = int(value)
    if not low <= value <= high:
        raise PromotionConfigError(f"{field} must be between {low} and {high}")
    return value


def _percent(value: Any, field: str, default: Optional[float] = None) -> float:
    if value is None and default is not None:
        return default
    amount = _money(value, field, positive=True)
    if amount > 100:
        raise PromotionConfigError(f"{field} must be at most 100")
    return amount


def _discount(config: Dict[str, Any]) -> Dict[str, Any]:
    kind = config.get("discountKind")
    if kind not in ("percent", "amount"):
        raise PromotionConfigError("discountKind must be percent or amount")
    value = (
        _percent(config.get("discountValue"), "discountValue")
        if kind == "percent"
        else _money(config.get("discountValue"), "discountValue", positive=True)
    )
    return {"discountKind": kind, "discountValue": value}


def _product_id(value: Any, field: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError):
        raise PromotionConfigError(f"{field} is required")


def clean_config(promo_type: str, config: Any) -> Dict[str, Any]:
    """The config of `promo_type`, normalized, or `PromotionConfigError`."""
    if not isinstance(config, dict):
        raise PromotionConfigError("config must be an object")
    if promo_type == "buy_x_get_y":
        return {
            "target": clean_group(config.get("target"), "target", required=True),
            "buyQuantity": _int(config.get("buyQuantity"), "buyQuantity", 1, QUANTITY_MAX),
            "getQuantity": _int(config.get("getQuantity"), "getQuantity", 1, QUANTITY_MAX),
            "getDiscountPercent": _percent(config.get("getDiscountPercent"), "getDiscountPercent", 100.0),
        }
    if promo_type == "bundle_price":
        return {
            "target": clean_group(config.get("target"), "target", required=True),
            "quantity": _int(config.get("quantity"), "quantity", 2, QUANTITY_MAX),
            "price": _money(config.get("price"), "price"),
        }
    if promo_type == "discount":
        return {"target": clean_group(config.get("target"), "target", required=True), **_discount(config)}
    if promo_type == "threshold_gift":
        return {
            "threshold": _money(config.get("threshold"), "threshold", positive=True),
            "counted": clean_group(config.get("counted"), "counted", required=True, default_all=True),
            "giftProductId": _product_id(config.get("giftProductId"), "giftProductId"),
            "giftQuantity": _int(config.get("giftQuantity"), "giftQuantity", 1, QUANTITY_MAX, default=1),
        }
    if promo_type == "threshold_item_price":
        return {
            "threshold": _money(config.get("threshold"), "threshold", positive=True),
            "counted": clean_group(config.get("counted"), "counted", required=True, default_all=True),
            "reward": clean_group(config.get("reward"), "reward", required=True),
            "specialPrice": _money(config.get("specialPrice"), "specialPrice"),
        }
    if promo_type == "threshold_basket_discount":
        return {
            "threshold": _money(config.get("threshold"), "threshold", positive=True),
            "counted": clean_group(config.get("counted"), "counted", required=True, default_all=True),
            **_discount(config),
        }
    if promo_type == "combo":
        components = config.get("components")
        if not isinstance(components, list) or not 2 <= len(components) <= COMBO_COMPONENTS_MAX:
            raise PromotionConfigError(f"components: 2 to {COMBO_COMPONENTS_MAX} parts")
        cleaned = []
        for i, part in enumerate(components):
            if not isinstance(part, dict):
                raise PromotionConfigError(f"components[{i}] must be an object")
            cleaned.append({
                "group": clean_group(part.get("group"), f"components[{i}].group", required=True),
                "quantity": _int(part.get("quantity"), f"components[{i}].quantity", 1, QUANTITY_MAX, default=1),
            })
        return {"components": cleaned, "price": _money(config.get("price"), "price")}
    raise PromotionConfigError(f"unknown promotion type {promo_type!r}")


def config_product_ids(config: Dict[str, Any]) -> List[str]:
    """Every product id a config names, for checking they are the tenant's."""
    out: List[str] = []
    for group in config_groups(config):
        out += group.get("productIds", []) + group.get("excludeProductIds", [])
    if config.get("giftProductId"):
        out.append(config["giftProductId"])
    return list(dict.fromkeys(out))


def config_category_ids(config: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    for group in config_groups(config):
        out += group.get("categoryIds", []) + group.get("excludeCategoryIds", [])
    return list(dict.fromkeys(out))


def config_groups(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    groups = [config[k] for k in ("target", "counted", "reward") if isinstance(config.get(k), dict)]
    groups += [c["group"] for c in config.get("components", []) if isinstance(c, dict) and isinstance(c.get("group"), dict)]
    return groups


# ── Bodies ────────────────────────────────────────────────────────────────────


class PromotionScopeIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: Literal["company", "shop", "area", "machine"]
    id: uuid.UUID


assert set(PromotionScopeIn.model_fields["type"].annotation.__args__) == set(PROMOTION_SCOPE_LEVELS)  # type: ignore[union-attr]


class PromotionIn(BaseModel):
    """A whole promotion, as created and as replaced by PUT."""

    model_config = ConfigDict(populate_by_name=True)

    name: str
    description: Optional[str] = None
    type: PromotionType
    config: Dict[str, Any]
    #: Empty: every till of the organization.
    scopes: List[PromotionScopeIn] = Field(default_factory=list)
    valid_from: Optional[date] = Field(None, alias="validFrom")
    valid_to: Optional[date] = Field(None, alias="validTo")
    #: 0 = Sunday … 6 = Saturday. Null or every day: no weekday condition.
    weekdays: Optional[List[int]] = None
    start_time: Optional[str] = Field(None, alias="startTime")
    end_time: Optional[str] = Field(None, alias="endTime")
    max_applications: Optional[int] = Field(None, alias="maxApplications", ge=1, le=MAX_APPLICATIONS_MAX)
    priority: int = Field(0, ge=PRIORITY_MIN, le=PRIORITY_MAX)
    is_paused: bool = Field(False, alias="isPaused")

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("name is required")
        value = value.strip()
        if len(value) > NAME_MAX:
            raise ValueError(f"name is at most {NAME_MAX} characters")
        return value

    @field_validator("description", mode="before")
    @classmethod
    def _description(cls, value):
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("description must be text")
        value = value.strip()
        if len(value) > DESCRIPTION_MAX:
            raise ValueError(f"description is at most {DESCRIPTION_MAX} characters")
        return value or None

    @field_validator("weekdays", mode="before")
    @classmethod
    def _weekdays(cls, value):
        if value is None:
            return None
        if not isinstance(value, list):
            raise ValueError("weekdays must be a list")
        try:
            days = sorted({int(d) for d in value})
        except (TypeError, ValueError):
            raise ValueError("weekdays: 0 (Sunday) … 6 (Saturday)")
        if not days or any(d < 0 or d > 6 for d in days):
            raise ValueError("weekdays: one or more of 0 (Sunday) … 6 (Saturday)")
        # Every day is no condition at all.
        return None if len(days) == 7 else days

    @field_validator("start_time", "end_time", mode="before")
    @classmethod
    def _time(cls, value):
        if value is None or (isinstance(value, str) and not value.strip()):
            return None
        if not isinstance(value, str) or not _HHMM.match(value.strip()[:5]):
            raise ValueError("time must be HH:MM")
        return value.strip()[:5]

    @model_validator(mode="after")
    def _whole(self):
        if (self.start_time is None) != (self.end_time is None):
            raise ValueError("startTime and endTime go together")
        if self.start_time is not None and self.start_time == self.end_time:
            raise ValueError("startTime and endTime must differ")
        if self.valid_from and self.valid_to and self.valid_to < self.valid_from:
            raise ValueError("validTo is before validFrom")
        try:
            self.config = clean_config(self.type, self.config)
        except PromotionConfigError as bad:
            raise ValueError(f"config: {bad}")
        seen = set()
        unique = []
        for scope in self.scopes:
            key = (scope.type, scope.id)
            if key not in seen:
                seen.add(key)
                unique.append(scope)
        self.scopes = unique
        return self


class PromotionPauseIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    paused: bool
