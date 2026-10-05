from pydantic import BaseModel, Field, field_validator
from typing import List, Literal, Optional
import uuid
import re

from app.services.item_ticket import TicketMode
from app.schemas.kitchen_printers import KitchenPrintersPatch
from datetime import datetime


class CategoryBase(BaseModel):
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r"^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    parent_id: Optional[uuid.UUID] = Field(None, alias="parentId")
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    # Item-ticket ("שובר") mode — see app/services/item_ticket.py. Null is "off".
    ticket_mode: Optional[TicketMode] = Field(None, alias="ticketMode")
    is_active: bool = Field(True, alias="isActive")
    sort_order: int = Field(0, alias="sortOrder")

    @field_validator("name")
    @classmethod
    def validate_non_empty(cls, v):
        if isinstance(v, str) and not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip() if isinstance(v, str) else v

    @field_validator("color")
    @classmethod
    def validate_color_format(cls, v):
        if v is not None and not re.match(r"^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$", v):
            raise ValueError("Color must be a valid hex color code (e.g., #RRGGBB or #RGB)")
        return v

    class Config:
        populate_by_name = True


class CategoryCreate(CategoryBase):
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    pos_machine_id: Optional[uuid.UUID] = Field(None, alias="posMachineId")
    catalog_level: Literal["global", "local"] = Field("global", alias="catalogLevel")


class CategoryUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1)
    description: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r"^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    parent_id: Optional[uuid.UUID] = Field(None, alias="parentId")
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    # Item-ticket ("שובר") mode — see app/services/item_ticket.py. Null is "off".
    ticket_mode: Optional[TicketMode] = Field(None, alias="ticketMode")
    is_active: Optional[bool] = Field(None, alias="isActive")
    sort_order: Optional[int] = Field(None, alias="sortOrder")
    # Kitchen / bar printers ("מדפסות בונים") in the writing till's shop — applied by the
    # till's category PUT (app/routers/sync.py); excluded from `model_dump`.
    kitchen_printers: Optional[KitchenPrintersPatch] = Field(None, alias="kitchenPrinters", exclude=True)

    @field_validator("name")
    @classmethod
    def validate_non_empty(cls, v):
        if v is not None and isinstance(v, str) and not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip() if v and isinstance(v, str) else v

    @field_validator("color")
    @classmethod
    def validate_color_format(cls, v):
        if v is not None and not re.match(r"^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$", v):
            raise ValueError("Color must be a valid hex color code (e.g., #RRGGBB or #RGB)")
        return v

    class Config:
        populate_by_name = True


class CategoryReorderItem(BaseModel):
    id: uuid.UUID
    sort_order: int = Field(..., alias="sortOrder")

    class Config:
        populate_by_name = True


class CategoryReorderRequest(BaseModel):
    """One atomic reorder. `order` is the new positions, not a delta."""

    order: List[CategoryReorderItem] = Field(..., min_length=1)

    @field_validator("order")
    @classmethod
    def validate_unique_ids(cls, v):
        seen = set()
        for item in v:
            if item.id in seen:
                # Two positions for one category has no correct answer, and silently
                # applying the last one would make the result depend on list order.
                raise ValueError(f"Duplicate category id: {item.id}")
            seen.add(item.id)
        return v

    class Config:
        populate_by_name = True


class CategoryReorderResponse(BaseModel):
    #: How many categories were repositioned — always `len(order)` on success, since a
    #: reorder is all-or-nothing. Deliberately not a count of rows that happened to
    #: change value: re-sending the current order is a valid no-op, not a failure.
    updated: int


class CategoryInactiveAt(BaseModel):
    """One shop, area or till where the category is switched off (`category_availability`)."""

    level: Literal["shop", "area", "machine"]
    target_id: uuid.UUID = Field(..., alias="targetId")
    name: Optional[str] = None

    class Config:
        populate_by_name = True


class CategoryResponse(BaseModel):
    id: uuid.UUID
    tenant_id: Optional[uuid.UUID] = Field(None, alias="tenantId")
    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    catalog_level: str = Field(..., alias="catalogLevel")
    name: str
    description: Optional[str]
    color: Optional[str]
    image_url: Optional[str] = Field(None, alias="imageUrl")
    parent_id: Optional[uuid.UUID] = Field(None, alias="parentId")
    voucher_id: Optional[uuid.UUID] = Field(None, alias="voucherId")
    ticket_mode: Optional[str] = Field(None, alias="ticketMode")
    is_active: bool = Field(..., alias="isActive")
    sort_order: int = Field(..., alias="sortOrder")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")
    children: Optional[list["CategoryResponse"]] = None
    #: Where it is switched off below the tenant — filled by the list only, for the
    #: dashboard's "not active at" badge. Empty when nowhere.
    inactive_at: List[CategoryInactiveAt] = Field(default_factory=list, alias="inactiveAt")

    class Config:
        from_attributes = True
        populate_by_name = True
