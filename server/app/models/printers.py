"""
Kitchen / bar ticket printers ("מדפסות בונים", docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §4).

Three tables:

* `kitchen_printers` — a printer of a shop, optionally narrowed to one point of sale
  (`area_id`) or one till (`machine_id`): how it is reached (`connection_type`) and how
  it prints (paper width, copies, cut, beep).

  - `network`: raw ESC/POS over TCP to `host`:`port` (9100 by default).
  - `bluetooth`: SPP to `bt_address` (a MAC; may be left empty and picked on the till
    from its paired devices), `bt_name` for display.
  - `cloud`: relayed. Other tills send the job through the cloud to `host_machine_id`,
    which prints it — on its own printer (`host_connection='till'`) or on a network /
    Bluetooth printer only it reaches (`host_connection` + the same host/port/MAC fields).
  - `till`: the built-in printer of whichever till the ticket comes from.
  - `usb`: a receipt printer on one till's USB port (`machine_id` names the till).

  `purpose`: a kitchen printer ("מדפסת בונים": tickets, by the routing) or a receipt
  printer ("מדפסת חשבוניות": bills and receipts the tills send it, never a ticket). A
  receipt printer is reached directly (network, Bluetooth, USB) and may have the cash
  drawer on its port (`cash_drawer`).

* `kitchen_printer_routes` — what prints where, per shop. A row routes a category or a
  product (`target_type`, `target_id`) to a printer. Several rows for one target print
  it on several printers. A row with `printer_id` NULL is an explicit "no ticket" for
  that target. A product with rows of its own ignores its category's.

* `kitchen_print_jobs` — the cloud relay: one ticket for one printer, from the till that
  sold it (`source_machine_id`) or from the dashboard (a test print), waiting for the till
  that prints it (`target_machine_id`: a `cloud` printer's host, or the shop's print
  server). pending → printing → done | failed, or expired when nobody printed it in time.
  The ticket is sent structured (`payload`), the printing till renders it.

* `kitchen_no_ticket_products` — "ללא בון" on the product itself: no kitchen ticket for it
  in any shop, whatever its category or its shops' rows say.

* `kitchen_print_hosts` — where the shop's print server ("שרת הדפסות", the till whose
  till parameter `printHostTill` is on) listens on the shop's LAN, as it last reported:
  the other tills send it their tickets there, and through the cloud relay when it does
  not answer.

See app/services/printers.py for the rules.
"""
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base

PRINTER_CONNECTION_TYPES = ("network", "bluetooth", "cloud", "till", "usb")
PRINTER_PURPOSES = ("kitchen", "receipt")
#: The port the shop's print server till listens on for the other tills' jobs.
DEFAULT_LAN_PORT = 8399
#: How the host till of a `cloud` printer reaches it.
PRINTER_HOST_CONNECTIONS = ("till", "network", "bluetooth")
PRINTER_PAPER_WIDTHS = (58, 80)
ROUTE_TARGET_TYPES = ("category", "product")
PRINT_JOB_STATUSES = ("pending", "printing", "done", "failed", "expired")
PRINT_JOB_KINDS = ("ticket", "test")


class KitchenPrinter(Base):
    __tablename__ = "kitchen_printers"
    __table_args__ = (
        CheckConstraint(
            "connection_type IN ('network', 'bluetooth', 'cloud', 'till', 'usb')",
            name="ck_kitchen_printers_connection_type",
        ),
        CheckConstraint("purpose IN ('kitchen', 'receipt')", name="ck_kitchen_printers_purpose"),
        CheckConstraint(
            "host_connection IS NULL OR host_connection IN ('till', 'network', 'bluetooth')",
            name="ck_kitchen_printers_host_connection",
        ),
        CheckConstraint("paper_width IN (58, 80)", name="ck_kitchen_printers_paper_width"),
        Index("ix_kitchen_printers_shop", "shop_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: Only the tills of this point of sale use it; null = every till of the shop.
    area_id = Column(UUID(as_uuid=True), ForeignKey("shop_areas.id", ondelete="SET NULL"), nullable=True)
    #: Only this till uses it (wins over `area_id`); null = not narrowed to a till.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    name = Column(String(100), nullable=False)
    #: kitchen ("מדפסת בונים") | receipt ("מדפסת חשבוניות").
    purpose = Column(String(8), nullable=False, default="kitchen", server_default="kitchen")
    #: A receipt printer with the cash drawer on its port ("מגירה").
    cash_drawer = Column(Boolean, nullable=False, default=False, server_default="false")
    connection_type = Column(String(16), nullable=False)
    #: network (and a cloud printer whose host reaches it over the network).
    host = Column(String(255), nullable=True)
    port = Column(Integer, nullable=True)
    #: bluetooth (and a cloud printer behind its host's Bluetooth): "AA:BB:CC:DD:EE:FF".
    bt_address = Column(String(17), nullable=True)
    bt_name = Column(String(100), nullable=True)
    #: cloud: the till that prints the relayed jobs, and how it reaches the printer.
    host_machine_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True
    )
    host_connection = Column(String(16), nullable=True)
    paper_width = Column(Integer, nullable=False, default=80, server_default="80")
    #: "רוחב הדפסה": the dots the head prints across (576 / 512 / 432 / 384); null — by the
    #: paper (58 → 384, 80 → 576). A head narrower than the raster skews the ticket.
    print_width_dots = Column(Integer, nullable=True)
    copies = Column(Integer, nullable=False, default=1, server_default="1")
    cut_paper = Column(Boolean, nullable=False, default=True, server_default="true")
    beep = Column(Boolean, nullable=False, default=False, server_default="false")
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class KitchenPrinterRoute(Base):
    __tablename__ = "kitchen_printer_routes"
    __table_args__ = (
        CheckConstraint(
            "target_type IN ('category', 'product')", name="ck_kitchen_printer_routes_target_type"
        ),
        # One row per (target, printer); and at most one "no ticket" row per target.
        Index(
            "uq_kitchen_printer_routes_printer",
            "shop_id",
            "target_type",
            "target_id",
            "printer_id",
            unique=True,
            postgresql_where=text("printer_id IS NOT NULL"),
            sqlite_where=text("printer_id IS NOT NULL"),
        ),
        Index(
            "uq_kitchen_printer_routes_none",
            "shop_id",
            "target_type",
            "target_id",
            unique=True,
            postgresql_where=text("printer_id IS NULL"),
            sqlite_where=text("printer_id IS NULL"),
        ),
        Index("ix_kitchen_printer_routes_shop", "shop_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    target_type = Column(String(16), nullable=False)
    #: A category or product id. No foreign key: a deleted product's rows are simply
    #: never reached (and are dropped by the next save of the routing).
    target_id = Column(UUID(as_uuid=True), nullable=False)
    #: Null = "no ticket" for this target (overrides its category / parent).
    printer_id = Column(
        UUID(as_uuid=True), ForeignKey("kitchen_printers.id", ondelete="CASCADE"), nullable=True
    )
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class KitchenPrintJob(Base):
    __tablename__ = "kitchen_print_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'printing', 'done', 'failed', 'expired')",
            name="ck_kitchen_print_jobs_status",
        ),
        CheckConstraint("kind IN ('ticket', 'test')", name="ck_kitchen_print_jobs_kind"),
        Index("ix_kitchen_print_jobs_target_status", "target_machine_id", "status"),
        Index("ix_kitchen_print_jobs_source", "source_machine_id", "created_at"),
        Index("ix_kitchen_print_jobs_printer", "printer_id", "created_at"),
    )

    #: Chosen by the sending till, so a retried upload is the same job.
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    printer_id = Column(
        UUID(as_uuid=True), ForeignKey("kitchen_printers.id", ondelete="SET NULL"), nullable=True
    )
    #: As it was when the job was made, for the sender's messages.
    printer_name = Column(String(100), nullable=True)
    kind = Column(String(8), nullable=False, default="ticket", server_default="ticket")
    #: The till that prints it.
    target_machine_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=True
    )
    #: The till that sent it; null for a test print from the dashboard.
    source_machine_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True
    )
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(16), nullable=False, default="pending", server_default="pending")
    #: The ticket, structured (see `app.schemas.printers.KitchenTicketPayload`).
    payload = Column(JSON, nullable=False)
    #: How many times it was handed to the printing till.
    deliveries = Column(Integer, nullable=False, default=0, server_default="0")
    error = Column(String(500), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=False)
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)


class KitchenPrintHost(Base):
    """
    Where a shop's print server till listens on the shop's LAN, as it last reported (on its
    heartbeat cadence). One row per till; only the till whose `printHostTill` parameter is
    on is used. The other tills read it from `GET /sync/{m}/printers`.
    """

    __tablename__ = "kitchen_print_hosts"

    machine_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), primary_key=True
    )
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=True, index=True)
    #: IPv4 / IPv6 on the shop's network; null when the till is not on Wi-Fi / Ethernet.
    lan_address = Column(String(64), nullable=True)
    port = Column(Integer, nullable=True)
    reported_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class KitchenNoTicketProduct(Base):
    """
    "ללא בון" on the product itself: it prints on no kitchen / bar printer in any shop — not
    the shop's printers, not the till's own (the counter-sale fallback) — whatever its
    category says. A row is the setting; deleting it sends the product back to its
    category. Kept on the tenant-wide product (a till's machine-local copy names it), so one
    tap reaches every shop.
    """

    __tablename__ = "kitchen_no_ticket_products"

    product_id = Column(
        UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), primary_key=True
    )
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: Who set it: a dashboard user, or a till (its catalog screen).
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_machine_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True
    )


class KitchenStation(Base):
    """
    A kitchen station ("תחנה": גריל, טיגון, סלטים, בר…) — a named routing target, one list
    for the whole network. Categories and products are assigned to a station once
    (`kitchen_station_targets`); each shop says which of its printers a station prints on
    (`kitchen_station_printers`). A shop's own printer rows for a category or product still
    win over its station (app/services/printers.py).
    """

    __tablename__ = "kitchen_stations"
    __table_args__ = (
        Index("uq_kitchen_stations_tenant_name", "tenant_id", "name", unique=True),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String(60), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class KitchenStationPrinter(Base):
    """A station prints on this printer — of the printer's shop."""

    __tablename__ = "kitchen_station_printers"

    station_id = Column(
        UUID(as_uuid=True), ForeignKey("kitchen_stations.id", ondelete="CASCADE"), primary_key=True
    )
    printer_id = Column(
        UUID(as_uuid=True), ForeignKey("kitchen_printers.id", ondelete="CASCADE"), primary_key=True
    )


class KitchenStationTarget(Base):
    """A category (and, through it, its sub-categories) or a product goes to a station."""

    __tablename__ = "kitchen_station_targets"
    __table_args__ = (
        CheckConstraint("target_type IN ('category', 'product')", name="ck_kitchen_station_targets_type"),
    )

    target_type = Column(String(16), primary_key=True)
    target_id = Column(UUID(as_uuid=True), primary_key=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    station_id = Column(
        UUID(as_uuid=True), ForeignKey("kitchen_stations.id", ondelete="CASCADE"), nullable=False, index=True
    )


PRINTER_SCAN_STATUSES = ("pending", "scanning", "done", "failed", "expired")
PRINTER_SCAN_SOURCES = ("dashboard", "till")


class PrinterScan(Base):
    """
    "חיפוש מדפסות ברשת": one scan of the shop's LAN by one of its tills
    (app/services/printer_discovery.py). Asked for from the dashboard — pending until the
    till picks it up with its print-jobs poll, scanning until it reports, done / failed —
    or expired when the till never did. A scan run at the till itself is stored done. The
    results are the till's report as JSON (IP, port, name, kind, response time, paper).
    """

    __tablename__ = "printer_scans"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'scanning', 'done', 'failed', 'expired')", name="ck_printer_scans_status"
        ),
        CheckConstraint("source IN ('dashboard', 'till')", name="ck_printer_scans_source"),
        Index("ix_printer_scans_shop", "shop_id", "created_at"),
        Index("ix_printer_scans_machine_status", "machine_id", "status"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    #: The till that runs (ran) it.
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    #: The dashboard user who asked; null for a scan run at the till.
    requested_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    source = Column(String(16), nullable=False, default="dashboard", server_default="dashboard")
    status = Column(String(16), nullable=False, default="pending", server_default="pending")
    #: What was scanned ("192.168.1.0/24") and the till's own address there.
    subnet = Column(String(64), nullable=True)
    lan_address = Column(String(64), nullable=True)
    #: `[{host, port, name, model, kind, responseMs, paper, offline, otherPorts, services}]`.
    results = Column(JSON, nullable=True)
    error = Column(String(500), nullable=True)
    duration_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: Pending: picked up by then; scanning: reported by then — else expired.
    expires_at = Column(DateTime(timezone=True), nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)


class KitchenZoneRedirect(Base):
    """
    "הפניית מדפסות לפי אזור שולחנות" (docs/SPEC_PRINT_BY_ZONE.md): a line of a table in
    `zone_id` that routes to `from_printer_id` prints on `to_printer_id` instead. Both are
    kitchen printers of the zone's shop. The routing itself is untouched; the till applies
    the redirect after it (KitchenRouting.kt). A printer or zone deleted takes its rows.
    """

    __tablename__ = "kitchen_zone_redirects"
    __table_args__ = (Index("ix_kitchen_zone_redirects_shop", "shop_id"),)

    zone_id = Column(
        UUID(as_uuid=True), ForeignKey("table_zones.id", ondelete="CASCADE"), primary_key=True
    )
    from_printer_id = Column(
        UUID(as_uuid=True), ForeignKey("kitchen_printers.id", ondelete="CASCADE"), primary_key=True
    )
    to_printer_id = Column(
        UUID(as_uuid=True), ForeignKey("kitchen_printers.id", ondelete="CASCADE"), nullable=False
    )
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class KitchenPrintRedirect(Base):
    """
    "מדפסת חלופית": a ticket or a receipt the till could not print on its printer, sent to
    another one by the employee (till parameter `printerFailoverPrompt`,
    app/services/print_redirects.py). Logged by the till, idempotent by `id`; the printers
    page lists the last ones. `temporary_until`: "the next ones too" — this till sent
    that printer's tickets to the other one until then (or until it answered again).
    """

    __tablename__ = "kitchen_print_redirects"
    __table_args__ = (
        CheckConstraint("kind IN ('kitchen', 'receipt')", name="ck_kitchen_print_redirects_kind"),
        Index("ix_kitchen_print_redirects_shop", "shop_id", "created_at"),
    )

    #: Chosen by the till, so a retried upload is the same row.
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False)
    machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="SET NULL"), nullable=True)
    kind = Column(String(8), nullable=False, default="kitchen", server_default="kitchen")
    from_printer_id = Column(
        UUID(as_uuid=True), ForeignKey("kitchen_printers.id", ondelete="SET NULL"), nullable=True
    )
    from_name = Column(String(100), nullable=True)
    #: Null with `to_name`: the till's own printer.
    to_printer_id = Column(UUID(as_uuid=True), ForeignKey("kitchen_printers.id", ondelete="SET NULL"), nullable=True)
    to_name = Column(String(100), nullable=True)
    #: What was sent ("שולחן 12", "מכירה 1043", "קבלה").
    ticket = Column(String(200), nullable=True)
    #: Why the printer was not available, as the till saw it.
    error = Column(String(500), nullable=True)
    temporary_until = Column(DateTime(timezone=True), nullable=True)
    pos_user_id = Column(UUID(as_uuid=True), nullable=True)
    pos_user_name = Column(String(100), nullable=True)
    occurred_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
