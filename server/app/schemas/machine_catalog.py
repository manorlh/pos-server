"""A till's own catalog: "all shop products", or a whitelist of them.

The rule is in `app/services/machine_catalog.py`; these are only its shapes on the wire.
"""
import uuid
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

CatalogMode = Literal["all", "selected"]

#: Far above any real shop's catalog, low enough that a body cannot be made enormous.
MAX_PRODUCTS = 10_000


class MachineCatalogSet(BaseModel):
    """
    Replace a till's mode and list in one write.

    `productIds` is the whole list, not a delta: what is absent is taken off. It is kept
    in "all" mode too, so a till switched back to "all" and later to "selected" again
    comes back with the list it had.
    """

    model_config = ConfigDict(populate_by_name=True)

    mode: CatalogMode
    product_ids: List[uuid.UUID] = Field(
        default_factory=list, alias="productIds", max_length=MAX_PRODUCTS
    )


class MachineCatalogProduct(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: uuid.UUID = Field(..., alias="productId")
    name: str
    sku: Optional[str] = None
    barcode: Optional[str] = None
    price: float
    category_id: Optional[uuid.UUID] = Field(None, alias="categoryId")
    category_name: Optional[str] = Field(None, alias="categoryName")
    image_url: Optional[str] = Field(None, alias="imageUrl")
    #: On this till's list (meaningful in "selected" mode; kept in "all" mode too).
    included: bool
    #: Delisted from the shop: not on any of its tills, whatever the list says.
    shop_listed: bool = Field(..., alias="shopListed")
    #: The product's availability *at this till* — false means it shows locked.
    available: bool
    #: Whether the till shows it right now, the mode and the shop listing applied.
    on_till: bool = Field(..., alias="onTill")
    #: "היכן הפריט נמכר" (app/services/sales_channel.py): all / kiosk_only / pos_only —
    #: the dashboard's kiosk editor leaves pos_only out, as the kiosk itself does.
    sales_channel: str = Field("all", alias="salesChannel")


class MachineCatalogCategory(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    name: str
    sort_order: int = Field(0, alias="sortOrder")


class MachineCatalogResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: str = Field(..., alias="machineName")
    pos_number: Optional[str] = Field(None, alias="posNumber")
    shop_id: uuid.UUID = Field(..., alias="shopId")
    shop_name: str = Field(..., alias="shopName")
    mode: CatalogMode
    mode_updated_at: Optional[datetime] = Field(None, alias="modeUpdatedAt")
    can_edit: bool = Field(False, alias="canEdit")
    #: Products of the shop on this till's list. The general item is never counted.
    selected_count: int = Field(0, alias="selectedCount")
    #: Products of the shop (the general item excluded) — the "of" in "12 of 40".
    total_count: int = Field(0, alias="totalCount")
    products: List[MachineCatalogProduct] = Field(default_factory=list)
    categories: List[MachineCatalogCategory] = Field(default_factory=list)


class MachineCatalogWriteResponse(BaseModel):
    """What a till is told after it changed its own list. It then pulls the catalog."""

    model_config = ConfigDict(populate_by_name=True)

    mode: CatalogMode
    selected_count: int = Field(0, alias="selectedCount")
    changed: bool = False
