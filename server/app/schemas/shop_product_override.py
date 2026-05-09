import uuid
from typing import Optional

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
    is_available: bool = Field(serialization_alias="isAvailable")


class ShopProductOverrideUpsert(BaseModel):
    """Body uses camelCase (`isListed`, `isAvailable`). Omitted fields are left unchanged on upsert."""

    model_config = ConfigDict(populate_by_name=True)

    price: Optional[float] = Field(default=None, description="Set null to inherit global price")
    is_listed: Optional[bool] = Field(default=None, alias="isListed")
    is_available: Optional[bool] = Field(default=None, alias="isAvailable")


class ShopProductOverrideWriteResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    global_product_id: uuid.UUID = Field(serialization_alias="globalProductId")
    override_price: Optional[float] = Field(default=None, serialization_alias="overridePrice")
    is_listed: bool = Field(serialization_alias="isListed")
    is_available: bool = Field(serialization_alias="isAvailable")
