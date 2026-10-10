import uuid

from sqlalchemy import JSON, Column, String, Boolean, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class PairingCode(Base):
    __tablename__ = "pairing_codes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code = Column(String(50), unique=True, nullable=False, index=True)
    distributor_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    company_id = Column(UUID(as_uuid=True), ForeignKey("companies.id"), nullable=True)
    shop_id = Column(UUID(as_uuid=True), ForeignKey("shops.id"), nullable=True)
    pos_machine_id = Column(UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True)

    #: A terminal this code *replaces*.
    #:
    #: Normally validating a pairing code creates a new machine row. When this is set the
    #: new device adopts the named row instead — same id, same machine_code, same shop,
    #: same register number — so a terminal swapped out on the counter keeps the identity
    #: its documents and its shop's reporting already refer to. Pairing bumps
    #: `token_version` on adoption, which kills every token the dead unit held.
    target_machine_id = Column(
        UUID(as_uuid=True), ForeignKey("pos_machines.id"), nullable=True
    )
    #: A replacement code created although the till still held untransmitted card sales
    #: (docs/SHIFTS_API.md §4.9): who accepted that they will not be transmitted by the
    #: new device, and when. Its adoption is then not refused for them.
    untransmitted_acknowledged_by_user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    untransmitted_acknowledged_at = Column(DateTime(timezone=True), nullable=True)
    #: Why the till is being replaced, given with a replacement code — kept in the record
    #: "הוחלפה קופה" when a device redeems it (docs/SPEC_OFFLINE_TILL_Z.md §4.6).
    replacement_reason = Column(String(500), nullable=True)
    #: The hardware the code was generated for ("N55F" | "MODO" | "P18"), copied onto the machine
    #: when a device redeems it. Null leaves the machine's model as it is.
    device_model = Column(String(16), nullable=True)
    #: "סוג מכשיר (תפקיד)" (docs/SPEC_DEVICE_ROLE_MODEL.md): "till" | "kiosk" | "kds" |
    #: "order_status_board", null = till (a code from an older dashboard). A kiosk, KDS or
    #: board code is pre-assigned to a shop; the device that redeems it is made one at once
    #: (`app.services.device_profile`, `app.services.display_devices`).
    device_role = Column(String(32), nullable=True)
    #: The kiosk's options for a kiosk code: `{"name", "controllerMachineIds", "lockDevice"}`.
    kiosk_options = Column(JSON, nullable=True)
    #: "android" | "windows": the platform the code is for. A device of the other platform
    #: is refused (422 `platform_mismatch`) before anything is created. Null: no check (a
    #: code from an older dashboard, a replacement code).
    platform = Column(String(16), nullable=True)
    #: A KDS / board code's screen: `{"name", "screenRole", "stationIds"}` (`kds.save_device`).
    kds_options = Column(JSON, nullable=True)
    #: "תצורת עבודה" chosen in the dialog (app/services/work_config.py, the plan: `{preset,
    #: tablesMode, lanServerExcluded, link, enableLocalNetwork, receiptPrinter, workflowTargets}`),
    #: applied to the machine right after it pairs. Null: "לפי הסניף" — nothing to apply.
    work_config = Column(JSON, nullable=True)
    #: The optional name typed in the add-device form (docs/SPEC_PAIRING_QR.md §4), for a till; the
    #: machine gets it when the code is redeemed and it wins over a name the device itself sends.
    #: Null: the server's default ("קופה N" once the machine has a number).
    machine_name = Column(String(100), nullable=True)
    #: How that went: `{applied, changes, detail, message, at}` — shown on the device page.
    work_config_result = Column(JSON, nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    is_used = Column(Boolean, default=False, nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    # Relationships
    distributor = relationship("User", foreign_keys=[distributor_id])
    pos_machine = relationship("POSMachine", foreign_keys=[pos_machine_id])
