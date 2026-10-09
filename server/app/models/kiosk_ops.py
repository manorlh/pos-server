"""
Running a self-order kiosk among the shop's tills (docs/SPEC_KIOSK.md §16):

* `kiosk_alerts` — what the kiosk needs staff for, routed to the shop's tills ("התראות
  לקופות"): a printer problem (bon / receipt: offline, no paper, USB detached), the card
  terminal (no connection, not ready, a card result left for staff) and the customer's
  "בקשת עזרה". One OPEN row per kiosk and key (de-duplicated); it clears by itself when the
  kiosk stops reporting it (the printer is back), when a till answers a help request
  ("בדרך"), or — a help request — after the kiosk's `alerts.help.clearAfterMin`.
* `kiosk_close_requests` — "סגירה יחד עם ה-Z הסניפי": the shop's Z (the cloud's, or the
  main till's in local mode) asks a kiosk that is set so to close its shift and make its
  own Z; the kiosk does it once idle — never over a payment — and reports back.
"""
import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base
from app.models.kiosk import KioskJSON

KIOSK_ALERT_KINDS = ("printer", "terminal", "help")
KIOSK_CLOSE_SOURCES = ("cloud_shop_z", "local_shop_z")
KIOSK_CLOSE_STATES = ("pending", "delivered", "done", "failed", "expired")


class KioskAlert(Base):
    """One alert of a kiosk to the shop's tills; at most one open per (kiosk, key)."""

    __tablename__ = "kiosk_alerts"
    __table_args__ = (
        Index(
            "uq_kiosk_alerts_open", "kiosk_machine_id", "key", unique=True,
            postgresql_where=text("cleared_at IS NULL"), sqlite_where=text("cleared_at IS NULL"),
        ),
        Index("ix_kiosk_alerts_shop_open", "shop_id", "cleared_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="SET NULL"), nullable=True)
    kiosk_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)
    #: printer | terminal | help
    kind = Column(String(16), nullable=False)
    #: The de-duplication key: "printer:receipt", "printer:bon", "printer:usb", "terminal",
    #: "terminal:card", "help".
    key = Column(String(40), nullable=False)
    #: no_paper, offline, usb_detached, unreachable, not_ready, card_unknown, help, …
    reason = Column(String(40), nullable=False)
    #: The line the tills show: "קיוסק רויאל — מדפסת: אין נייר".
    text = Column(String(300), nullable=False)
    #: What else the kiosk said: printer name, terminal address, screen and step, total.
    detail = Column(KioskJSON, nullable=True)
    #: The kiosk's own id for a help request (the same request re-pinged keeps it).
    request_id = Column(String(64), nullable=True)
    raised_at = Column(DateTime(timezone=True), nullable=False)
    last_reported_at = Column(DateTime(timezone=True), nullable=False)
    #: A help request tapped again ("עוד פעם") re-pings the tills: they show it again.
    ping_count = Column(Integer, nullable=False, default=0, server_default="0")
    pinged_at = Column(DateTime(timezone=True), nullable=True)
    acknowledged_at = Column(DateTime(timezone=True), nullable=True)
    acknowledged_by_machine_id = Column(UUID(as_uuid=True), nullable=True)
    acknowledged_by_name = Column(String(200), nullable=True)
    cleared_at = Column(DateTime(timezone=True), nullable=True)
    #: recovered | acknowledged | expired | reset | kiosk_removed
    clear_reason = Column(String(24), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


class KioskCloseRequest(Base):
    """The shop's Z asking a kiosk to close its shift and make its own Z."""

    __tablename__ = "kiosk_close_requests"
    __table_args__ = (Index("ix_kiosk_close_requests_kiosk_state", "kiosk_machine_id", "state"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id", ondelete="SET NULL"), nullable=True)
    kiosk_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id", ondelete="CASCADE"), nullable=False)
    #: cloud_shop_z | local_shop_z
    source = Column(String(16), nullable=False)
    #: The z run (cloud) or the local shop Z's id.
    source_ref = Column(String(64), nullable=True)
    #: pending → delivered (the kiosk has it) → done | failed; expired after a day unanswered.
    state = Column(String(16), nullable=False, default="pending")
    requested_at = Column(DateTime(timezone=True), nullable=False)
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    #: What the kiosk reported: {shiftId, zNumber, detail}.
    result = Column(KioskJSON, nullable=True)
