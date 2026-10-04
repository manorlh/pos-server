"""Kitchen / bar printer payloads ("מדפסות בונים", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §4)."""
from __future__ import annotations

import re
import uuid
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.printers import DEFAULT_LAN_PORT, PRINTER_CONNECTION_TYPES, PRINTER_HOST_CONNECTIONS

PRINTER_NAME_MAX = 100
DEFAULT_PORT = 9100
COPIES_MAX = 5
#: A host name or an IPv4 / IPv6 address — no scheme, no path, no spaces.
HOST_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.\-:\[\]]{0,253}$")
MAC_PATTERN = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")

TICKET_LINES_MAX = 300
TICKET_TEXT_MAX = 200
TICKET_NOTES_MAX = 500


def clean_mac(value: Optional[str]) -> Optional[str]:
    """"aa-bb-cc-dd-ee-ff" → "AA:BB:CC:DD:EE:FF"; empty → None; anything else refused."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("btAddress must be text")
    cleaned = value.strip().upper().replace("-", ":")
    if not cleaned:
        return None
    if not MAC_PATTERN.match(cleaned):
        raise ValueError("btAddress must look like AA:BB:CC:DD:EE:FF")
    return cleaned


def clean_host(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("host must be text")
    cleaned = value.strip()
    if not cleaned:
        return None
    if not HOST_PATTERN.match(cleaned):
        raise ValueError("host must be an IP address or a host name")
    return cleaned


class PrinterIn(BaseModel):
    """A printer as the dashboard writes it (create and full replace)."""

    model_config = ConfigDict(populate_by_name=True)

    name: str
    #: kitchen ("מדפסת בונים") | receipt ("מדפסת חשבוניות").
    purpose: Literal["kitchen", "receipt"] = "kitchen"
    connection_type: Literal["network", "bluetooth", "cloud", "till", "usb"] = Field(alias="connectionType")
    #: A receipt printer with the cash drawer on its port.
    cash_drawer: bool = Field(False, alias="cashDrawer")
    host: Optional[str] = None
    port: Optional[int] = None
    bt_address: Optional[str] = Field(None, alias="btAddress")
    bt_name: Optional[str] = Field(None, alias="btName")
    host_machine_id: Optional[uuid.UUID] = Field(None, alias="hostMachineId")
    host_connection: Optional[Literal["till", "network", "bluetooth"]] = Field(None, alias="hostConnection")
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    paper_width: Literal[58, 80] = Field(80, alias="paperWidth")
    copies: int = Field(1, ge=1, le=COPIES_MAX)
    cut_paper: bool = Field(True, alias="cutPaper")
    beep: bool = False
    is_active: bool = Field(True, alias="isActive")
    sort_order: int = Field(0, alias="sortOrder")

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("name is required")
        cleaned = value.strip()
        if len(cleaned) > PRINTER_NAME_MAX:
            raise ValueError(f"name must be at most {PRINTER_NAME_MAX} characters")
        return cleaned

    @field_validator("host", mode="before")
    @classmethod
    def _host(cls, value):
        return clean_host(value)

    @field_validator("bt_address", mode="before")
    @classmethod
    def _mac(cls, value):
        return clean_mac(value)

    @field_validator("bt_name", mode="before")
    @classmethod
    def _bt_name(cls, value):
        if value is None:
            return None
        cleaned = str(value).strip()
        return cleaned[:100] or None

    @model_validator(mode="after")
    def _by_type(self):
        """Keep only what the connection type uses, and require what it needs."""
        kind = self.connection_type
        if self.purpose == "receipt":
            # Printed by the till that sends it, directly: no relay, no "this till's printer".
            if kind not in ("network", "bluetooth", "usb"):
                raise ValueError("a receipt printer is reached by network, bluetooth or usb")
            if kind == "usb" and self.machine_id is None:
                raise ValueError("a USB printer hangs on one till: machineId is required")
        else:
            if kind == "usb":
                raise ValueError("usb is for receipt printers")
            self.cash_drawer = False
        hosted = kind == "cloud"
        # How the printer itself is reached: directly, or by its host till.
        reach = self.host_connection if hosted else kind
        if hosted:
            if self.host_machine_id is None:
                raise ValueError("a cloud printer needs hostMachineId")
            if reach is None:
                reach = self.host_connection = "till"
        else:
            self.host_machine_id = None
            self.host_connection = None
        if reach == "network":
            if not self.host:
                raise ValueError("a network printer needs host")
            if self.port is None:
                self.port = DEFAULT_PORT
            if not 1 <= self.port <= 65535:
                raise ValueError("port must be 1-65535")
        else:
            self.host = None
            self.port = None
        if reach != "bluetooth":
            self.bt_address = None
            self.bt_name = None
        # Narrowed to one till: its area says nothing more.
        if self.machine_id is not None:
            self.area_id = None
        return self


class TicketLineIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: Optional[str] = Field(None, alias="productId", max_length=100)
    category_id: Optional[str] = Field(None, alias="categoryId", max_length=100)
    name: str = Field(max_length=TICKET_TEXT_MAX)
    quantity: float
    notes: Optional[str] = Field(None, max_length=TICKET_NOTES_MAX)
    # How the dish is made (docs/SPEC_MENU_MODIFIERS.md): kept through the relay so the
    # printing till draws them. All optional — an older till sends none.
    mods: Optional[List[str]] = Field(None, max_length=40)
    removals: Optional[List[str]] = Field(None, max_length=40)
    important: Optional[bool] = None
    allergies: Optional[List[str]] = Field(None, max_length=20)
    seat: Optional[str] = Field(None, max_length=TICKET_TEXT_MAX)
    course: Optional[str] = Field(None, max_length=TICKET_TEXT_MAX)
    meal_name: Optional[str] = Field(None, alias="mealName", max_length=TICKET_TEXT_MAX)
    refill: Optional[str] = Field(None, max_length=TICKET_TEXT_MAX)


class TicketIn(BaseModel):
    """The ticket as the sending till built it; the printing till renders it."""

    model_config = ConfigDict(populate_by_name=True)

    source: Literal["table", "sale", "test"] = "sale"
    table_name: Optional[str] = Field(None, alias="tableName", max_length=TICKET_TEXT_MAX)
    zone_name: Optional[str] = Field(None, alias="zoneName", max_length=TICKET_TEXT_MAX)
    guests: Optional[int] = Field(None, ge=0, le=10_000)
    waiter_name: Optional[str] = Field(None, alias="waiterName", max_length=TICKET_TEXT_MAX)
    created_at: str = Field(alias="createdAt", max_length=64)
    is_addition: bool = Field(False, alias="isAddition")
    lines: List[TicketLineIn] = Field(default_factory=list, max_length=TICKET_LINES_MAX)
    order_ref: Optional[str] = Field(None, alias="orderRef", max_length=100)
    #: The till it came from, printed small ("קופה 3").
    source_name: Optional[str] = Field(None, alias="sourceName", max_length=TICKET_TEXT_MAX)
    #: A course the waiter fired ("הוצא: עיקריות"), printed as a band (docs/SPEC_MENU_MODIFIERS.md §8).
    fire: Optional[str] = Field(None, max_length=TICKET_TEXT_MAX)


class PrintJobIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: Chosen by the till, so a retried upload is the same job.
    id: uuid.UUID
    printer_id: uuid.UUID = Field(alias="printerId")
    ticket: TicketIn


class PrintJobAckIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["done", "failed"]
    error: Optional[str] = Field(None, max_length=500)


class CategoryRoutesIn(BaseModel):
    """The category matrix, whole: category id → its own printers. Absent / [] = inherit."""

    model_config = ConfigDict(populate_by_name=True)

    routes: Dict[uuid.UUID, List[uuid.UUID]] = Field(default_factory=dict)


class ProductRouteIn(BaseModel):
    """`inherit` — follow the category; `none` — never a ticket; `printers` — exactly these."""

    model_config = ConfigDict(populate_by_name=True)

    mode: Literal["inherit", "none", "printers"]
    printer_ids: List[uuid.UUID] = Field(default_factory=list, alias="printerIds")

    @model_validator(mode="after")
    def _printers(self):
        if self.mode == "printers" and not self.printer_ids:
            raise ValueError("mode 'printers' needs at least one printer")
        if self.mode != "printers":
            self.printer_ids = []
        return self


class KitchenPrintersPatch(BaseModel):
    """
    A product's or a category's printers, as part of its own write (the till's product /
    category PUT, as `kitchenPrinters`). In the writing till's shop: `inherit` — follow
    the category (for a category: its parent); `none` — no ticket in this shop; `printers`
    — exactly these. For a product, across every shop (one tap): `no_ticket` — "ללא בון",
    no kitchen ticket anywhere; `ticket` — that switched off, back to the category;
    `reset` — "אפס להגדרת המחלקה", every product-level setting in every shop removed.
    """

    model_config = ConfigDict(populate_by_name=True)

    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    mode: Literal["inherit", "none", "printers", "no_ticket", "ticket", "reset"]
    printer_ids: List[uuid.UUID] = Field(default_factory=list, alias="printerIds")

    @model_validator(mode="after")
    def _printers(self):
        if self.mode == "printers" and not self.printer_ids:
            raise ValueError("mode 'printers' needs at least one printer")
        if self.mode != "printers":
            self.printer_ids = []
        return self


#: The patch modes that act on the product in every shop rather than in one.
PRODUCT_WIDE_MODES = ("no_ticket", "ticket", "reset")


class ProductNoTicketIn(BaseModel):
    """"ללא בון" on the product itself: true — no kitchen ticket in any shop; false — back to the category."""

    model_config = ConfigDict(populate_by_name=True)

    no_ticket: bool = Field(alias="noTicket")


class PrintHostIn(BaseModel):
    """The shop's print server, picked on the dashboard: a till of the shop, or null for none."""

    model_config = ConfigDict(populate_by_name=True)

    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")


class PrintHostReportIn(BaseModel):
    """The print server till's whereabouts on the shop's LAN (its heartbeat cadence)."""

    model_config = ConfigDict(populate_by_name=True)

    #: Null when the till is not on Wi-Fi / Ethernet just now.
    lan_address: Optional[str] = Field(None, alias="lanAddress", max_length=64)
    port: int = Field(DEFAULT_LAN_PORT, ge=1, le=65535)

    @field_validator("lan_address", mode="before")
    @classmethod
    def _address(cls, value):
        return clean_host(value)


class KitchenOptionsIn(BaseModel):
    """
    The two till parameters at one level of the shop. A key left out is unchanged; an
    explicit null removes the value there (the level inherits again).
    """

    model_config = ConfigDict(populate_by_name=True)

    scope_type: Literal["shop", "area", "machine"] = Field(alias="scopeType")
    scope_id: uuid.UUID = Field(alias="scopeId")
    kitchen_tickets_on_sale: Optional[bool] = Field(None, alias="kitchenTicketsOnSale")
    kitchen_tickets_on_till: Optional[bool] = Field(None, alias="kitchenTicketsOnTill")


__all__ = [
    "PRINTER_CONNECTION_TYPES",
    "PRINTER_HOST_CONNECTIONS",
    "PrinterIn",
    "TicketIn",
    "TicketLineIn",
    "PrintJobIn",
    "PrintJobAckIn",
    "CategoryRoutesIn",
    "ProductRouteIn",
    "KitchenPrintersPatch",
    "KitchenOptionsIn",
]
