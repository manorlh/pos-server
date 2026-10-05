"""
The menu layer's request bodies (docs/SPEC_MENU_MODIFIERS.md), camelCase as the dashboard
sends them. Structural checks live here; the rules that need the database (whose company,
which products exist) are in app/services/menu.py.
"""
from __future__ import annotations

import re
import uuid
from decimal import Decimal
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.menu import ALLERGENS

NAME_MAX = 100
OPTIONS_MAX = 60
LINKS_MAX = 30
NOTES_MAX = 40
SLOTS_MAX = 8
SLOT_OPTIONS_MAX = 60
SELECT_MAX = 99
MONEY_MAX = Decimal("100000")

_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class MenuValidationError(ValueError):
    """A menu definition that does not hold together."""


def clean_allergens(value) -> List[str]:
    """Known codes only, each once, in the fixed list's order."""
    if not value:
        return []
    wanted = {str(v).strip().lower() for v in value}
    unknown = wanted - set(ALLERGENS)
    if unknown:
        raise ValueError(f"unknown allergen: {sorted(unknown)[0]}")
    return [a for a in ALLERGENS if a in wanted]


def _money(value: Decimal) -> Decimal:
    return Decimal(value).quantize(Decimal("0.01"))


class _Body(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class OptionIn(_Body):
    #: Kept when editing an existing option, so sold lines and links keep naming it.
    id: Optional[uuid.UUID] = None
    name: str = Field(min_length=1, max_length=NAME_MAX)
    kitchen_name: Optional[str] = Field(None, alias="kitchenName", max_length=60)
    price: Decimal = Field(Decimal("0"), ge=Decimal("-1000"), le=MONEY_MAX)
    is_default: bool = Field(False, alias="isDefault")
    allergens: List[str] = Field(default_factory=list)
    linked_product_id: Optional[uuid.UUID] = Field(None, alias="linkedProductId")
    #: The most of this option in one dish; null: only the group's max applies.
    max_qty: Optional[int] = Field(None, alias="maxQty", ge=1, le=SELECT_MAX)
    is_active: bool = Field(True, alias="isActive")

    @field_validator("name", "kitchen_name", mode="before")
    @classmethod
    def _trim(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("kitchen_name")
    @classmethod
    def _empty_kitchen(cls, v):
        return v or None

    @field_validator("allergens", mode="before")
    @classmethod
    def _allergens(cls, v):
        return clean_allergens(v)

    @field_validator("price")
    @classmethod
    def _price(cls, v):
        return _money(v)


class GroupIn(_Body):
    name: str = Field(min_length=1, max_length=NAME_MAX)
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    kind: Literal["choice", "addon", "removal"] = "addon"
    min_select: int = Field(0, alias="minSelect", ge=0, le=SELECT_MAX)
    max_select: Optional[int] = Field(None, alias="maxSelect", ge=1, le=SELECT_MAX)
    free_count: int = Field(0, alias="freeCount", ge=0, le=SELECT_MAX)
    allow_quantity: bool = Field(False, alias="allowQuantity")
    allow_pre: bool = Field(False, alias="allowPre")
    is_active: bool = Field(True, alias="isActive")
    options: List[OptionIn] = Field(default_factory=list, max_length=OPTIONS_MAX)
    #: Categories that get this group (appended to each one's own list); optional.
    category_ids: Optional[List[uuid.UUID]] = Field(None, alias="categoryIds")

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, v):
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _rules(self):
        validate_group_rules(self)
        return self


def validate_group_rules(g) -> None:
    """
    The group's numbers hold together: min ≤ max, the free count within the max, no more
    defaults than may be chosen, a required group with something to choose, and a removal
    group without quantities or pre-modifiers (one does not remove "a lot of" onion).
    """
    active = [o for o in g.options if getattr(o, "is_active", True)]
    if g.max_select is not None and g.min_select > g.max_select:
        raise ValueError("minSelect cannot be more than maxSelect")
    if g.max_select is not None and g.free_count > g.max_select:
        raise ValueError("freeCount cannot be more than maxSelect")
    if g.min_select > 0 and not active:
        raise ValueError("a required group needs at least one active option")
    if not g.allow_quantity and g.min_select > len(active) and active:
        raise ValueError("minSelect is more than there are options to choose")
    defaults = [o for o in active if o.is_default]
    if g.max_select is not None and len(defaults) > g.max_select:
        raise ValueError("more defaults than maxSelect allows")
    if g.kind == "removal" and (g.allow_quantity or g.allow_pre):
        raise ValueError("a removal group takes no quantities or pre-modifiers")
    names = [o.name.strip().lower() for o in g.options]
    if len(names) != len(set(names)):
        raise ValueError("two options with the same name")
    for o in g.options:
        limit = getattr(o, "max_qty", None)
        if limit is None:
            continue
        if limit > 1 and not g.allow_quantity:
            raise ValueError("an option's maxQty above 1 needs allowQuantity")
        if g.max_select is not None and limit > g.max_select:
            raise ValueError("an option's maxQty cannot be more than the group's maxSelect")


class GroupOrderIn(_Body):
    ids: List[uuid.UUID] = Field(default_factory=list, max_length=1000)


class LinksIn(_Body):
    """`inherit` — follow the category; `none` — no modifiers; `groups` — exactly these, in order."""

    mode: Literal["inherit", "none", "groups"]
    group_ids: List[uuid.UUID] = Field(default_factory=list, alias="groupIds", max_length=LINKS_MAX)

    @model_validator(mode="after")
    def _groups(self):
        if self.mode == "groups" and not self.group_ids:
            raise ValueError("choose at least one group, or 'none'")
        if self.mode != "groups":
            self.group_ids = []
        if len(set(self.group_ids)) != len(self.group_ids):
            raise ValueError("a group is listed twice")
        return self


class NoteIn(_Body):
    text: str = Field(min_length=1, max_length=60)
    is_important: bool = Field(False, alias="isImportant")

    @field_validator("text", mode="before")
    @classmethod
    def _trim(cls, v):
        return v.strip() if isinstance(v, str) else v


class NotesIn(_Body):
    """`inherit` — the category's chips; `own` — exactly these (`[]` = none of its own)."""

    mode: Literal["inherit", "own"] = "own"
    notes: List[NoteIn] = Field(default_factory=list, max_length=NOTES_MAX)
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")


class SlotOptionIn(_Body):
    product_id: uuid.UUID = Field(alias="productId")
    upcharge: Decimal = Field(Decimal("0"), ge=Decimal("0"), le=MONEY_MAX)
    is_default: bool = Field(False, alias="isDefault")

    @field_validator("upcharge")
    @classmethod
    def _upcharge(cls, v):
        return _money(v)


class SlotIn(_Body):
    """
    A meal's slot: `quantity` items included per meal, of which between `minSelect` and
    `maxSelect` are chosen when the meal is ordered; with `deferred`, the rest can be taken
    later; with `allowRepeat`, one product may fill several of them; `refillable` with
    `maxRefills` (null: unlimited) gives refills at no charge.
    """

    id: Optional[uuid.UUID] = None
    name: str = Field(min_length=1, max_length=60)
    quantity: Optional[int] = Field(None, ge=1, le=20)
    min_select: int = Field(1, alias="minSelect", ge=0, le=20)
    max_select: int = Field(1, alias="maxSelect", ge=1, le=20)
    allow_repeat: bool = Field(False, alias="allowRepeat")
    deferred: bool = False
    refillable: bool = False
    max_refills: Optional[int] = Field(None, alias="maxRefills", ge=1, le=99)
    options: List[SlotOptionIn] = Field(default_factory=list, max_length=SLOT_OPTIONS_MAX)

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, v):
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _rules(self):
        # Older dashboards send no quantity: a slot then includes as many as may be chosen.
        if self.quantity is None:
            self.quantity = self.max_select
        if self.min_select > self.max_select:
            raise ValueError("minSelect cannot be more than maxSelect")
        if self.max_select > self.quantity:
            raise ValueError("maxSelect cannot be more than the slot's quantity")
        if not self.options:
            raise ValueError("a slot needs at least one product")
        ids = [o.product_id for o in self.options]
        if len(set(ids)) != len(ids):
            raise ValueError("a product is listed twice in one slot")
        if len([o for o in self.options if o.is_default]) > self.max_select:
            raise ValueError("more defaults than the slot takes")
        if not self.allow_repeat and self.min_select > len(self.options):
            raise ValueError("minSelect needs more products than the slot lists (or allowRepeat)")
        if not self.refillable:
            self.max_refills = None
        return self


class MealIn(_Body):
    """The whole meal, replacing what was there. No slots: the product is not a meal."""

    slots: List[SlotIn] = Field(default_factory=list, max_length=SLOTS_MAX)


class ProductMenuIn(_Body):
    """The product form's "תוספות, הערות ואלרגנים" and "ארוחה" sections, saved together."""

    allergens: Optional[List[str]] = None
    course_id: Optional[uuid.UUID] = Field(None, alias="courseId")
    #: True: `courseId` is meant (null clears it); absent / false: the course is left alone.
    set_course: bool = Field(False, alias="setCourse")
    links: Optional[LinksIn] = None
    notes: Optional[NotesIn] = None
    meal: Optional[MealIn] = None
    #: Order limits (docs/SPEC_MENU_MODIFIERS.md §3.9), applied when `setLimits` is true.
    set_limits: bool = Field(False, alias="setLimits")
    max_per_order: Optional[int] = Field(None, alias="maxPerOrder", ge=1, le=999)
    refillable: bool = False
    max_refills: Optional[int] = Field(None, alias="maxRefills", ge=1, le=99)

    @field_validator("allergens", mode="before")
    @classmethod
    def _allergens(cls, v):
        return None if v is None else clean_allergens(v)


class CategoryMenuIn(_Body):
    course_id: Optional[uuid.UUID] = Field(None, alias="courseId")
    set_course: bool = Field(False, alias="setCourse")
    links: Optional[LinksIn] = None
    notes: Optional[NotesIn] = None


class UpsellIn(_Body):
    name: str = Field(min_length=1, max_length=120)
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    trigger_type: Literal["product", "category"] = Field(alias="triggerType")
    trigger_ids: List[uuid.UUID] = Field(alias="triggerIds", min_length=1, max_length=200)
    action: Literal["add", "upgrade"] = "add"
    product_id: uuid.UUID = Field(alias="productId")
    message: Optional[str] = Field(None, max_length=200)
    show_price: bool = Field(True, alias="showPrice")
    start_time: Optional[str] = Field(None, alias="startTime")
    end_time: Optional[str] = Field(None, alias="endTime")
    weekdays: Optional[List[int]] = None
    priority: int = Field(0, ge=0, le=100)
    is_active: bool = Field(True, alias="isActive")

    @field_validator("name", "message", mode="before")
    @classmethod
    def _trim(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("message")
    @classmethod
    def _empty_message(cls, v):
        return v or None

    @field_validator("weekdays")
    @classmethod
    def _weekdays(cls, v):
        if v is None:
            return None
        days = sorted({int(d) for d in v})
        if any(d < 0 or d > 6 for d in days):
            raise ValueError("weekdays are 0 (Sunday) to 6")
        return days or None

    @model_validator(mode="after")
    def _times(self):
        if (self.start_time is None) != (self.end_time is None):
            raise ValueError("startTime and endTime go together")
        for t in (self.start_time, self.end_time):
            if t is not None and not _HHMM.match(t):
                raise ValueError("times are HH:MM")
        if self.trigger_type == "product" and self.product_id in self.trigger_ids and self.action == "add":
            raise ValueError("a product cannot suggest itself")
        if len(set(self.trigger_ids)) != len(self.trigger_ids):
            raise ValueError("a trigger is listed twice")
        return self


class CourseIn(_Body):
    id: Optional[uuid.UUID] = None
    name: str = Field(min_length=1, max_length=60)
    is_active: bool = Field(True, alias="isActive")

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, v):
        return v.strip() if isinstance(v, str) else v


class CoursesIn(_Body):
    """The company's (or the organization's) whole course list, in order."""

    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    courses: List[CourseIn] = Field(default_factory=list, max_length=20)


class UpsellStatIn(_Body):
    rule_id: uuid.UUID = Field(alias="ruleId")
    day: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    shown: int = Field(0, ge=0, le=1_000_000)
    accepted: int = Field(0, ge=0, le=1_000_000)
    dismissed: int = Field(0, ge=0, le=1_000_000)


class UpsellStatsIn(_Body):
    stats: List[UpsellStatIn] = Field(default_factory=list, max_length=2000)
