"""
"תפריטים" request bodies (docs/SPEC_MENUS.md), camelCase as the dashboard sends them.
Structural checks live here; what needs the database (whose company, which products exist,
who may assign what where) is in app/services/catalog_menus.py.
"""
from __future__ import annotations

import re
import uuid
from datetime import date
from decimal import Decimal
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NAME_MAX = 80
CATEGORIES_MAX = 300
PRODUCTS_MAX = 3000
RANGES_MAX = 8
MENUS_PER_TARGET_MAX = 30
MONEY_MAX = Decimal("1000000")

_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


class _Body(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class TimeRangeIn(_Body):
    #: "HH:MM", local. `end` <= `start` crosses midnight; "00:00"–"00:00" is the whole day.
    start: str
    end: str

    @field_validator("start", "end")
    @classmethod
    def _hhmm(cls, value: str) -> str:
        value = (value or "").strip()
        if not _HHMM.match(value):
            raise ValueError("time must be HH:MM")
        return value


class MenuCategoryIn(_Body):
    category_id: uuid.UUID = Field(alias="categoryId")
    #: Every product of the category (the listed ones first). False: only the listed ones.
    all_products: bool = Field(True, alias="allProducts")


class MenuProductIn(_Body):
    product_id: uuid.UUID = Field(alias="productId")
    #: The price while the menu is active; null: the catalog's.
    price: Optional[Decimal] = Field(None, ge=Decimal("0"), le=MONEY_MAX)

    @field_validator("price")
    @classmethod
    def _cents(cls, value: Optional[Decimal]) -> Optional[Decimal]:
        return None if value is None else Decimal(value).quantize(Decimal("0.01"))


class MenuIn(_Body):
    name: str = Field(min_length=1, max_length=NAME_MAX)
    #: Null: the whole organization (super admin / distributor only).
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    channel: Literal["pos", "kiosk", "both"] = "both"
    is_active: bool = Field(True, alias="isActive")
    always: bool = False
    #: 0 = Sunday … 6 = Saturday; null: every day. Never empty.
    days: Optional[List[int]] = None
    ranges: List[TimeRangeIn] = Field(default_factory=list, max_length=RANGES_MAX)
    valid_from: Optional[date] = Field(None, alias="validFrom")
    valid_to: Optional[date] = Field(None, alias="validTo")
    color: Optional[str] = None
    categories: List[MenuCategoryIn] = Field(default_factory=list, max_length=CATEGORIES_MAX)
    products: List[MenuProductIn] = Field(default_factory=list, max_length=PRODUCTS_MAX)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = (value or "").strip()
        if not value:
            raise ValueError("name is required")
        return value

    @field_validator("days")
    @classmethod
    def _days(cls, value: Optional[List[int]]) -> Optional[List[int]]:
        if value is None:
            return None
        cleaned = sorted({int(d) for d in value})
        if not cleaned:
            raise ValueError("menu_no_days")
        if any(d < 0 or d > 6 for d in cleaned):
            raise ValueError("days are 0 (Sunday) to 6 (Saturday)")
        return cleaned

    @field_validator("color")
    @classmethod
    def _color(cls, value: Optional[str]) -> Optional[str]:
        if value is None or value == "":
            return None
        if not _COLOR.match(value.strip()):
            raise ValueError("color must be #RRGGBB")
        return value.strip().upper()

    @model_validator(mode="after")
    def _whole(self) -> "MenuIn":
        if self.valid_from and self.valid_to and self.valid_from > self.valid_to:
            raise ValueError("menu_dates_reversed")
        seen = set()
        for c in self.categories:
            if c.category_id in seen:
                raise ValueError("menu_duplicate_category")
            seen.add(c.category_id)
        seen = set()
        for p in self.products:
            if p.product_id in seen:
                raise ValueError("menu_duplicate_product")
            seen.add(p.product_id)
        return self


class MenuOrderIn(_Body):
    ids: List[uuid.UUID] = Field(default_factory=list, max_length=500)


class TargetMenuIn(_Body):
    menu_id: uuid.UUID = Field(alias="menuId")
    priority: int = Field(0, ge=-1000, le=1000)


class TargetAssignmentsIn(_Body):
    #: "group": a device group ("קבוצת מכשירים", app/models/machine_group.py).
    level: Literal["company", "shop", "area", "group", "machine"]
    target_id: uuid.UUID = Field(alias="targetId")
    menus: List[TargetMenuIn] = Field(default_factory=list, max_length=MENUS_PER_TARGET_MAX)
    #: "catalog" — "הקטלוג המלא"; "none" — "לא למכור"; null — inherit from the level above.
    fallback: Optional[Literal["catalog", "none"]] = None

    @model_validator(mode="after")
    def _unique(self) -> "TargetAssignmentsIn":
        ids = [m.menu_id for m in self.menus]
        if len(ids) != len(set(ids)):
            raise ValueError("menu_duplicate_assignment")
        return self
