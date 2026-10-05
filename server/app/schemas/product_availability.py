"""Where a product is available for sale — per company, per shop, per area, per till.

Every node carries its own setting (`value`: true / false / null = not set), what it
would get if it set nothing (`inherited`), and what it actually resolves to
(`effective`, plus the `source` level that decided it). All three come from
`app/services/product_availability.py`; the dashboard only displays them.
"""
import uuid
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

AvailabilityLevel = Literal["product", "company", "shop", "area", "machine"]

#: What a till may set from its manager screen (`PUT /sync/{id}/.../availability`).
TillScope = Literal["machine", "area", "shop"]


class AvailabilitySet(BaseModel):
    """`{"isAvailable": true | false | null}` — null clears the level back to inherit.

    The key is required: an empty body is a mistake, not a request to clear.
    """

    model_config = ConfigDict(populate_by_name=True)

    is_available: Optional[bool] = Field(..., alias="isAvailable")


class _Node(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    value: Optional[bool] = None
    inherited: bool
    effective: bool
    source: AvailabilityLevel
    can_edit: bool = Field(False, alias="canEdit")


class MachineAvailability(_Node):
    machine_id: uuid.UUID = Field(..., alias="machineId")
    name: str
    pos_number: Optional[str] = Field(None, alias="posNumber")
    #: The till's own catalog (app/services/machine_catalog.py): "all" or "selected".
    catalog_mode: Literal["all", "selected"] = Field("all", alias="catalogMode")
    #: Whether the till's own catalog includes the product — always true in "all"
    #: mode. A till whose list leaves it out does not show it at all, locked or not.
    in_catalog: bool = Field(True, alias="inCatalog")
    #: The area the till stands in, whose node in `ShopAvailability.areas` it inherits
    #: from; null = straight from the shop.
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")


class AreaAvailability(_Node):
    area_id: uuid.UUID = Field(..., alias="areaId")
    name: str


class ShopAvailability(_Node):
    shop_id: uuid.UUID = Field(..., alias="shopId")
    shop_name: str = Field(..., alias="shopName")
    #: A delisted product is not on the till at all; its availability is moot there.
    is_listed: bool = Field(..., alias="isListed")
    #: The shop's live areas. Its tills stay in `machines`, each naming its area.
    areas: List[AreaAvailability] = Field(default_factory=list)
    machines: List[MachineAvailability] = Field(default_factory=list)


class CompanyAvailability(_Node):
    company_id: uuid.UUID = Field(..., alias="companyId")
    company_name: Optional[str] = Field(None, alias="companyName")
    shops: List[ShopAvailability] = Field(default_factory=list)


class ProductAvailabilityResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    #: The product's own flag: the floor every level inherits from.
    product_available: bool = Field(..., alias="productAvailable")
    companies: List[CompanyAvailability] = Field(default_factory=list)


class AvailabilityWriteResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    level: AvailabilityLevel
    value: Optional[bool] = None


class TillAvailabilitySet(BaseModel):
    """
    `{"scope": "machine"|"area"|"shop", "active": true|false|null}` from a till — for a
    product or a category. Null — or no `active` key at all, which is how a till's JSON omits a null — clears
    that scope back to inherit.
    """

    model_config = ConfigDict(populate_by_name=True)

    scope: TillScope
    active: Optional[bool] = None


class TillAvailabilityResponse(BaseModel):
    """What the scope now holds, and what this till ends up with after the change."""

    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    scope: TillScope
    active: Optional[bool] = None
    effective_active: bool = Field(..., alias="effectiveActive")


# ── The products list's one-line summary ─────────────────────────────────────


class AvailabilitySummaryRequest(BaseModel):
    """`{"productIds": [...]}` — the products on one page of the list."""

    model_config = ConfigDict(populate_by_name=True)

    product_ids: List[uuid.UUID] = Field(..., alias="productIds", max_length=200)


class AvailabilityException(BaseModel):
    """A level that sets its own value against what it would inherit — "חסום בקופה 4"."""

    model_config = ConfigDict(populate_by_name=True)

    level: Literal["company", "shop", "area", "machine"]
    id: uuid.UUID
    name: Optional[str] = None
    #: The shop an area or till belongs to.
    shop_name: Optional[str] = Field(None, alias="shopName")
    pos_number: Optional[str] = Field(None, alias="posNumber")
    #: Its own setting — true (unlocks) or false (locks).
    value: bool


class ProductAvailabilitySummary(BaseModel):
    """
    Counts over the same tree `GET /products/{id}/availability` shows, for the shops the
    caller can reach. "Active" is listed in the shop and effectively available there —
    for a till also on the till's own catalog.
    """

    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    product_available: bool = Field(..., alias="productAvailable")
    company_count: int = Field(0, alias="companyCount")
    shop_count: int = Field(0, alias="shopCount")
    active_shop_count: int = Field(0, alias="activeShopCount")
    area_count: int = Field(0, alias="areaCount")
    active_area_count: int = Field(0, alias="activeAreaCount")
    machine_count: int = Field(0, alias="machineCount")
    active_machine_count: int = Field(0, alias="activeMachineCount")
    #: The first few levels that override their parent, locks first.
    exceptions: List[AvailabilityException] = Field(default_factory=list)
    exception_count: int = Field(0, alias="exceptionCount")


class AvailabilitySummaryResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    items: List[ProductAvailabilitySummary] = Field(default_factory=list)
