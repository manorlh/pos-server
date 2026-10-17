"""Kitchen / bar printer payloads ("מדפסות בונים", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §4)."""
from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.printers import (
    DEFAULT_LAN_PORT,
    PRINTER_CONNECTION_TYPES,
    PRINTER_HOST_CONNECTIONS,
    TICKET_FONT_SCALE_RANGE,
)

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
    #: cloud: how the host till reaches it — its own head (`till`), its own USB port (`usb`),
    #: or a network / Bluetooth printer only it reaches.
    host_connection: Optional[Literal["till", "network", "bluetooth", "usb"]] = Field(None, alias="hostConnection")
    area_id: Optional[uuid.UUID] = Field(None, alias="areaId")
    machine_id: Optional[uuid.UUID] = Field(None, alias="machineId")
    paper_width: Literal[58, 80] = Field(80, alias="paperWidth")
    #: "רוחב הדפסה" in dots; null — by the paper (58 mm → 384, 80 mm → 576).
    print_width_dots: Optional[Literal[576, 512, 432, 384]] = Field(None, alias="printWidthDots")
    copies: int = Field(1, ge=1, le=COPIES_MAX)
    cut_paper: bool = Field(True, alias="cutPaper")
    beep: bool = False
    is_active: bool = Field(True, alias="isActive")
    sort_order: int = Field(0, alias="sortOrder")
    # "עיצוב בון" (P:/specs/kitchen-ticket-designs.md §3, §6ג): left out of the body — unchanged (an
    # older dashboard's replace keeps them); null — inherit (the till parameters).
    #: A bare template, or a named design (`ticketDesignId`) — not both.
    ticket_design: Optional[Literal["classic", "classic_legacy", "large", "compact", "courses", "modern"]] = Field(
        None, alias="ticketDesign"
    )
    ticket_design_id: Optional[uuid.UUID] = Field(None, alias="ticketDesignId")
    ticket_font_scale: Optional[int] = Field(
        None, alias="ticketFontScale", ge=TICKET_FONT_SCALE_RANGE[0], le=TICKET_FONT_SCALE_RANGE[1]
    )
    #: The info fields that print: table / guests / waiter / time / till / order / customer (a list,
    #: or comma text); the table always does.
    ticket_header: Optional[List[str]] = Field(None, alias="ticketHeader")
    ticket_checkboxes: Optional[bool] = Field(None, alias="ticketCheckboxes")
    ticket_elapsed: Optional[bool] = Field(None, alias="ticketElapsed")
    ticket_fit: Optional[Literal["fit", "wrap"]] = Field(None, alias="ticketFit")
    ticket_min_text_size: Optional[Literal["xs", "s", "m"]] = Field(None, alias="ticketMinTextSize")
    ticket_max_text_size: Optional[Literal["s", "m", "l"]] = Field(None, alias="ticketMaxTextSize")
    ticket_header_size: Optional[Literal["s", "m", "l"]] = Field(None, alias="ticketHeaderSize")
    ticket_inline_mods: Optional[bool] = Field(None, alias="ticketInlineMods")
    ticket_order: Optional[Literal["added", "course", "category", "custom"]] = Field(None, alias="ticketOrder")
    #: `custom`'s order: `[{kind: course | category, id}]` (or "course:<id>,category:<id>").
    ticket_order_list: Optional[List[Dict[str, str]]] = Field(None, alias="ticketOrderList")
    ticket_group_headers: Optional[Literal["auto", "on", "off"]] = Field(None, alias="ticketGroupHeaders")
    ticket_no_course: Optional[Literal["first", "last"]] = Field(None, alias="ticketNoCourse")

    @field_validator("ticket_order_list", mode="before")
    @classmethod
    def _ticket_order_list(cls, value):
        if value is None:
            return None
        from app.services.kitchen_ticket_style import StyleError, clean_order_list

        try:
            return clean_order_list(value, "ticketOrderList")
        except StyleError as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("ticket_header", mode="before")
    @classmethod
    def _ticket_header(cls, value):
        if value is None:
            return None
        from app.services.kitchen_ticket_style import StyleError, printer_header

        try:
            return printer_header(value)
        except StyleError as exc:
            raise ValueError(str(exc)) from exc

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
            # Printed by the till that sends it, directly — or by another till ("המדפסת של <קופה>",
            # P:/specs/bill-print-other-till.md): `cloud`, its host and how the host reaches it.
            # Never "this till's printer" (that is the till's own receipt setting).
            if kind not in ("network", "bluetooth", "usb", "cloud"):
                raise ValueError("a receipt printer is reached by network, bluetooth, usb or through another till (cloud)")
            if kind == "usb" and self.machine_id is None:
                raise ValueError("a USB printer hangs on one till: machineId is required")
            # A receipt printer of another till may have the drawer on its port (`cash_drawer`: the
            # host's printer has it). It opens there only as §9 of bill-print-other-till lets it — a
            # `drawer` job, by `remotePrintDrawer` and CASH_DRAWER.OPEN_REMOTE; never with a document.
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
        # The till's own head prints its own width.
        if reach == "till":
            self.print_width_dots = None
        # Narrowed to one till: its area says nothing more.
        if self.machine_id is not None:
            self.area_id = None
        if self.ticket_design is not None and self.ticket_design_id is not None:
            raise ValueError("ticketDesign or ticketDesignId, not both")
        return self


#: `PrinterIn`'s "עיצוב בון" fields, by their attribute names.
PRINTER_TICKET_FIELDS = (
    "ticket_design", "ticket_design_id", "ticket_font_scale", "ticket_header", "ticket_checkboxes", "ticket_elapsed",
    "ticket_fit", "ticket_min_text_size", "ticket_max_text_size", "ticket_header_size", "ticket_inline_mods",
    "ticket_order", "ticket_order_list", "ticket_group_headers", "ticket_no_course",
)


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
    #: Its course waits for FIRE ("ממתין ל-FIRE"): drawn apart, greyed (the `courses` design).
    held: Optional[bool] = None


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
    #: A counter sale's name ("שם להזמנה", till parameter `askOrderName`): the ticket's
    #: headline, the name the kitchen calls out.
    customer_name: Optional[str] = Field(None, alias="customerName", max_length=TICKET_TEXT_MAX)
    #: A counter sale's "לקחת / לשבת" (till parameter `askEatInTakeAway`), printed as a band.
    dining: Optional[Literal["eat_in", "take_away"]] = None
    #: A band at the head: "הדפסה חוזרת" (a reprint, approved by a manager) or "זרז" (a rush).
    notice: Optional[str] = Field(None, max_length=TICKET_TEXT_MAX)
    #: "מצב הדרכה": a ticket of a till in training, printed "הדרכה" by whichever till prints it —
    #: kept through the relay (the kitchen must never cook a training order as a real one).
    training: Optional[bool] = None
    #: When the table was opened (ISO-8601): "פתוח 25 דק'" at the head (`kitchenTicketElapsed`).
    opened_at: Optional[str] = Field(None, alias="openedAt", max_length=64)
    #: The courses still held (P:/specs/fire-restaurant-flow.md §1, §6): their lines, printed apart at the foot
    #: under "ממתין ל-FIRE" — never cooked. Apart from `lines`, so a printing till that does not know it prints
    #: nothing of them. Kept through the relay as the sending till wrote it.
    waiting: Optional[List[TicketLineIn]] = Field(None, max_length=TICKET_LINES_MAX)
    #: "תא 3B" (P:/specs/table-scope.md §6.4): the word the printing till puts before a table's title (`tableTerm`);
    #: absent — its own rule (the word before a number alone). Kept through the relay.
    table_term: Optional[str] = Field(None, alias="tableTerm", max_length=10)


DOCUMENT_TEXT_MAX = 120


class DocumentIn(BaseModel):
    """
    A bill / receipt printed on another till (P:/specs/bill-print-other-till.md §4): rendered by the
    sending till at the host's paper width, one colour, compressed; the host prints the image as it is
    and never reads the document. The reference (`category`, `type`, `number`, `copy`, `title`) is for
    the messages and "בעיות" only — the document is the sending till's, its number its own (§5).
    The image's size is checked by app/services/remote_print.py (`413 document_too_large`).
    """

    model_config = ConfigDict(populate_by_name=True)

    #: The `remotePrintDocuments` class it falls in: `bill` (a table's bill, an interim bill),
    #: `receipt` (receipts and invoices), `other` (copies, credit notes, X / Z).
    category: Literal["bill", "receipt", "other"] = "bill"
    #: The till's own code for the document ("bill", "320", "330", "400", "x", "z"…).
    doc_type: str = Field(alias="type", min_length=1, max_length=16)
    number: Optional[str] = Field(None, max_length=40)
    #: Printed "העתק" (a reprint), as at the till.
    is_copy: bool = Field(False, alias="copy")
    #: "חשבון — שולחן 12", for the messages.
    title: Optional[str] = Field(None, max_length=DOCUMENT_TEXT_MAX)
    paper_width: Literal[58, 80] = Field(alias="paperWidth")
    width_dots: int = Field(alias="widthDots", ge=8, le=1024)
    height_dots: int = Field(alias="heightDots", ge=1, le=30_000)
    #: `png` — a PNG (one bit or grey; dark = print); `raster_gzip` — rows of `ceil(widthDots / 8)`
    #: bytes, the leftmost dot in the high bit, 1 = print, gzip.
    encoding: Literal["png", "raster_gzip"] = "png"
    #: The image, base64.
    image: str

    @field_validator("number", "title", mode="before")
    @classmethod
    def _text(cls, value):
        if value is None:
            return None
        cleaned = " ".join(str(value).split())
        return cleaned or None


class DrawerPersonIn(BaseModel):
    """Who asked, or who approved (a till user's id and name; how they approved)."""

    model_config = ConfigDict(populate_by_name=True)

    id: Optional[str] = Field(None, max_length=100)
    name: Optional[str] = Field(None, max_length=DOCUMENT_TEXT_MAX)
    #: approvedBy: `pin` (a manager's code at the till) | `remote` (an approval from the phone).
    method: Optional[Literal["pin", "remote"]] = None


class DrawerIn(BaseModel):
    """
    "פתיחת מגירה ב<קופה>" (P:/specs/bill-print-other-till.md §9ב–§9ג): open the drawer on another till's
    printer. `payment` — with a cash payment whose document went there (`remotePrintDrawer` ask / auto);
    `manual` — the menu's "פתיחת מגירה ב<קופה>" (CASH_DRAWER.OPEN_REMOTE, with the manual opening's rules).
    Who asked and who approved are kept with the job and on the drawer's log.
    """

    model_config = ConfigDict(populate_by_name=True)

    reason: Literal["payment", "manual"]
    #: payment: the document it goes with.
    document_type: Optional[str] = Field(None, alias="documentType", max_length=16)
    document_number: Optional[str] = Field(None, alias="documentNumber", max_length=40)
    #: The cash of the payment (payment), or what is taken / given (manual); for the log only.
    amount: Optional[float] = Field(None, ge=-10_000_000, le=10_000_000)
    #: manual: the drawer's reason code ("CHANGE", "TEST"…) and its note, as at a till.
    reason_code: Optional[str] = Field(None, alias="reasonCode", max_length=32)
    reason_note: Optional[str] = Field(None, alias="reasonNote", max_length=500)
    requested_by: DrawerPersonIn = Field(alias="requestedBy")
    approved_by: Optional[DrawerPersonIn] = Field(None, alias="approvedBy")
    #: A phone approval's request (app/services/remote_approvals), when that is how it was approved.
    approval_request_id: Optional[uuid.UUID] = Field(None, alias="approvalRequestId")
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")


class PrintJobIn(BaseModel):
    """
    `ticket` (the default): a kitchen ticket for `printerId`. `document`: a rendered bill / receipt for
    another till — a receipt printer of type cloud (`printerId`, its host prints it) or a till of the
    shop by itself (`targetMachineId`, on its own receipt printer). `drawer`: open the drawer there.
    """

    model_config = ConfigDict(populate_by_name=True)

    #: Chosen by the till, so a retried upload is the same job.
    id: uuid.UUID
    kind: Optional[Literal["ticket", "document", "drawer"]] = None
    printer_id: Optional[uuid.UUID] = Field(None, alias="printerId")
    target_machine_id: Optional[uuid.UUID] = Field(None, alias="targetMachineId")
    ticket: Optional[TicketIn] = None
    document: Optional[DocumentIn] = None
    drawer: Optional[DrawerIn] = None

    @model_validator(mode="after")
    def _kind(self):
        if self.kind is None:
            if self.ticket is not None:
                self.kind = "ticket"
            elif self.document is not None:
                self.kind = "document"
            elif self.drawer is not None:
                self.kind = "drawer"
            else:
                self.kind = "ticket"
        if self.kind == "ticket":
            if self.ticket is None or self.printer_id is None:
                raise ValueError("a ticket needs printerId and ticket")
            self.document = None
            self.drawer = None
            self.target_machine_id = None
            return self
        if self.printer_id is None and self.target_machine_id is None:
            raise ValueError(f"a {self.kind} job needs printerId or targetMachineId")
        self.ticket = None
        if self.kind == "document":
            if self.document is None:
                raise ValueError("a document job needs document")
            self.drawer = None
        else:
            if self.drawer is None:
                raise ValueError("a drawer job needs drawer")
            self.document = None
        return self


class TestPrintIn(BaseModel):
    """
    `POST /printers/{id}/test` with a body: "הדפסת ניסיון בעיצוב הזה" (P:/specs/kitchen-ticket-designs.md
    §4) — the shared sample ticket in the look the dashboard shows now. The printer's "עיצוב בון"
    fields as the dialog has them (unsaved; left out — the printer's own), or a design being edited:
    `template` + `overrides` (with `ticketDesignId` for its name). No body: the plain test page.
    """

    model_config = ConfigDict(populate_by_name=True)

    ticket_design: Optional[Literal["classic", "classic_legacy", "large", "compact", "courses", "modern"]] = Field(
        None, alias="ticketDesign"
    )
    ticket_design_id: Optional[uuid.UUID] = Field(None, alias="ticketDesignId")
    ticket_font_scale: Optional[int] = Field(
        None, alias="ticketFontScale", ge=TICKET_FONT_SCALE_RANGE[0], le=TICKET_FONT_SCALE_RANGE[1]
    )
    ticket_header: Optional[List[str]] = Field(None, alias="ticketHeader")
    ticket_checkboxes: Optional[bool] = Field(None, alias="ticketCheckboxes")
    ticket_elapsed: Optional[bool] = Field(None, alias="ticketElapsed")
    ticket_fit: Optional[Literal["fit", "wrap"]] = Field(None, alias="ticketFit")
    ticket_min_text_size: Optional[Literal["xs", "s", "m"]] = Field(None, alias="ticketMinTextSize")
    ticket_max_text_size: Optional[Literal["s", "m", "l"]] = Field(None, alias="ticketMaxTextSize")
    ticket_header_size: Optional[Literal["s", "m", "l"]] = Field(None, alias="ticketHeaderSize")
    ticket_inline_mods: Optional[bool] = Field(None, alias="ticketInlineMods")
    ticket_order: Optional[Literal["added", "course", "category", "custom"]] = Field(None, alias="ticketOrder")
    #: `custom`'s order: `[{kind: course | category, id}]` (or "course:<id>,category:<id>").
    ticket_order_list: Optional[List[Dict[str, str]]] = Field(None, alias="ticketOrderList")
    ticket_group_headers: Optional[Literal["auto", "on", "off"]] = Field(None, alias="ticketGroupHeaders")
    ticket_no_course: Optional[Literal["first", "last"]] = Field(None, alias="ticketNoCourse")

    @field_validator("ticket_order_list", mode="before")
    @classmethod
    def _ticket_order_list(cls, value):
        if value is None:
            return None
        from app.services.kitchen_ticket_style import StyleError, clean_order_list

        try:
            return clean_order_list(value, "ticketOrderList")
        except StyleError as exc:
            raise ValueError(str(exc)) from exc
    template: Optional[Literal["classic", "classic_legacy", "large", "compact", "courses", "modern"]] = None
    overrides: Optional[Dict[str, Any]] = None

    @field_validator("ticket_header", mode="before")
    @classmethod
    def _ticket_header(cls, value):
        if value is None:
            return None
        from app.services.kitchen_ticket_style import StyleError, printer_header

        try:
            return printer_header(value)
        except StyleError as exc:
            raise ValueError(str(exc)) from exc


class TicketDesignIn(BaseModel):
    """A named "עיצוב בון" (create: all but `overrides` required; update: what is sent changes)."""

    model_config = ConfigDict(populate_by_name=True)

    company_id: Optional[uuid.UUID] = Field(None, alias="companyId")
    name: Optional[str] = Field(None, max_length=200)
    template: Optional[str] = Field(None, max_length=40)
    overrides: Optional[Dict[str, Any]] = None


class PrintJobAckIn(BaseModel):
    """`done` / `failed` end the job; `printing` (with `error`) says why the host still retries it."""

    model_config = ConfigDict(populate_by_name=True)

    status: Literal["done", "failed", "printing"]
    error: Optional[str] = Field(None, max_length=500)


class BonAlertIn(BaseModel):
    """
    One ticket of a till's print queue that needs a person (app/services/bon_alerts.py). Every
    field but `id` / `state` optional; long text is clamped by the service, never refused.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: str = Field(..., min_length=1, max_length=200)
    #: failed | retrying | uncertain | unconfirmed | waiting_host | kds_not_taken | handled
    state: str = Field(..., min_length=1, max_length=40)
    reason: Optional[str] = Field(None, max_length=80)
    printer_id: Optional[str] = Field(None, alias="printerId", max_length=100)
    printer_name: Optional[str] = Field(None, alias="printerName", max_length=300)
    title: Optional[str] = Field(None, max_length=300)
    items: Optional[int] = Field(None, ge=0, le=100_000)
    attempts: Optional[int] = Field(None, ge=0, le=1_000_000)
    since: Optional[str] = Field(None, max_length=60)
    error: Optional[str] = Field(None, max_length=2000)
    handled_by: Optional[str] = Field(None, alias="handledBy", max_length=300)
    handled_note: Optional[str] = Field(None, alias="handledNote", max_length=2000)


class BonAlertsIn(BaseModel):
    """A till's whole list ([complete]): an open alert of that till it leaves out is resolved."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    bons: List[BonAlertIn] = Field(default_factory=list, max_length=500)
    complete: bool = True


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


class TillLocalPrinterIn(BaseModel):
    """
    "המדפסת המקומית של קופה" (docs/SPEC_KIOSK.md §16.9): a till's own printer picked by name in
    the kiosk's printing settings — its built-in head (`till`), or the USB / Bluetooth printer
    attached to it. The cloud makes (or reuses) the hosted printer entry behind it.
    """

    model_config = ConfigDict(populate_by_name=True)

    machine_id: uuid.UUID = Field(alias="machineId")
    connection: Literal["till", "usb", "bluetooth"] = "till"


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
    The printers page's till parameters at one level of the shop. A key left out is
    unchanged; an explicit null removes the value there (the level inherits again).

    `values` takes any of `printers.SETTING_KEYS` (receipt printer, drawer, ask before
    print, kitchen tickets); the two named fields are its older spelling.
    """

    model_config = ConfigDict(populate_by_name=True)

    scope_type: Literal["shop", "area", "machine"] = Field(alias="scopeType")
    scope_id: uuid.UUID = Field(alias="scopeId")
    kitchen_tickets_on_sale: Optional[bool] = Field(None, alias="kitchenTicketsOnSale")
    kitchen_tickets_on_till: Optional[bool] = Field(None, alias="kitchenTicketsOnTill")
    values: Optional[Dict[str, Any]] = None


__all__ = [
    "PRINTER_CONNECTION_TYPES",
    "PRINTER_HOST_CONNECTIONS",
    "PrinterIn",
    "TicketIn",
    "TicketLineIn",
    "DocumentIn",
    "DrawerIn",
    "PrintJobIn",
    "PrintJobAckIn",
    "TillLocalPrinterIn",
    "CategoryRoutesIn",
    "ProductRouteIn",
    "KitchenPrintersPatch",
    "KitchenOptionsIn",
    "TestPrintIn",
    "TicketDesignIn",
]
