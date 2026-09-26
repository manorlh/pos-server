"""Where a product is available for sale — per company, per shop, per till.

Every node carries its own setting (`value`: true / false / null = not set), what it
would get if it set nothing (`inherited`), and what it actually resolves to
(`effective`, plus the `source` level that decided it). All three come from
`app/services/product_availability.py`; the dashboard only displays them.
"""
import uuid
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

AvailabilityLevel = Literal["product", "company", "shop", "machine"]


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


class ShopAvailability(_Node):
    shop_id: uuid.UUID = Field(..., alias="shopId")
    shop_name: str = Field(..., alias="shopName")
    #: A delisted product is not on the till at all; its availability is moot there.
    is_listed: bool = Field(..., alias="isListed")
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
