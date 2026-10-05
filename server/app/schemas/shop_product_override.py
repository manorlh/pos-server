import uuid
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class ShopProductCatalogCandidate(BaseModel):
    """Global product not yet assigned to the shop (library / add flow)."""

    model_config = ConfigDict(populate_by_name=True)

    global_product_id: uuid.UUID = Field(serialization_alias="globalProductId")
    name: str
    sku: str
    category_id: uuid.UUID = Field(serialization_alias="categoryId")
    global_price: float = Field(serialization_alias="globalPrice")


class ShopProductCatalogRow(BaseModel):
    """Global product row with optional shop override (for dashboard assortment)."""

    model_config = ConfigDict(populate_by_name=True)

    global_product_id: uuid.UUID = Field(serialization_alias="globalProductId")
    name: str
    sku: str
    category_id: uuid.UUID = Field(serialization_alias="categoryId")
    global_price: float = Field(serialization_alias="globalPrice")
    override_price: Optional[float] = Field(default=None, serialization_alias="overridePrice")
    is_listed: bool = Field(serialization_alias="isListed")
    # This shop's own setting: null = not set (inherit the company, then the product).
    is_available: Optional[bool] = Field(default=None, serialization_alias="isAvailable")
    # What this shop's tills get when the till itself sets nothing — resolved on the
    # server (app/services/product_availability.py), never by the page.
    effective_available: bool = Field(serialization_alias="effectiveAvailable")
    # What this shop would get if it set nothing: the shop's company, else the product.
    inherited_available: bool = Field(serialization_alias="inheritedAvailable")
    # The company's built-in general item: it cannot be unlisted or removed here.
    is_general: bool = Field(default=False, serialization_alias="isGeneral")
    # Its place on the shop's tills ("סידור פריטים", 1 = first); null — not placed (by name).
    till_position: Optional[int] = Field(default=None, serialization_alias="tillPosition")


class ShopProductOverrideUpsert(BaseModel):
    """Body uses camelCase (`isListed`, `isAvailable`). Omitted fields are left unchanged on upsert.

    `isAvailable` is the shop's own availability level: true = available here, false =
    locked here, null = not set (inherit the shop's company, then the product).
    """

    model_config = ConfigDict(populate_by_name=True)

    price: Optional[float] = Field(default=None, description="Set null to inherit global price")
    is_listed: Optional[bool] = Field(default=None, alias="isListed")
    is_available: Optional[bool] = Field(
        default=None, alias="isAvailable", description="Set null to inherit"
    )


class ShopProductOverrideWriteResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    global_product_id: uuid.UUID = Field(serialization_alias="globalProductId")
    override_price: Optional[float] = Field(default=None, serialization_alias="overridePrice")
    is_listed: bool = Field(serialization_alias="isListed")
    is_available: Optional[bool] = Field(default=None, serialization_alias="isAvailable")


class ShopProductCatalogCandidateListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page: int
    page_size: int = Field(serialization_alias="pageSize")
    total: int
    items: List[ShopProductCatalogCandidate]


class ShopProductCatalogRowListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page: int
    page_size: int = Field(serialization_alias="pageSize")
    total: int
    items: List[ShopProductCatalogRow]
