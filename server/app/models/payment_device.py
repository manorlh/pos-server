"""
"מכשירי תשלום" — the card terminals a till WITHOUT one of its own works with (docs: the
owner's "מכשירי תשלום"; app/services/payment_devices.py).

A tablet (a P18) or any till with no built-in clearing can charge on several devices of its
shop, each with a nickname: a Z-Credit pinpad, a SynqPay terminal, or a Nayax handheld running
Agamento reached over the LAN (TweezerComm over HTTP, port 8080, /SPICy). One row per device,
per shop:

* `kind` — `zcredit_pinpad` | `synqpay` | `agamento_lan`;
* `config` — the kind's non-secret fields, as the till reads them (validated and normalised
  by the service, keys with no value left out);
* `active` — an inactive device is still sent to its tills (a card left unresolved on it
  must be followed up), the till only refuses a new card on it.

A device belongs to its shop; which till uses which device is a setting of the shop / area /
till layers (`paymentDeviceMode`, `fixedPaymentDeviceId`, `paymentDeviceGroup`), not a column
here — the earlier `machine_ids` was moved into those settings and dropped (migration
3b8f6d2a9c41).

Its secret (the SynqPay API key) is never here: it lives encrypted in
`payment_integration_secrets` with level "payment_device" and the device's id.
"""
import uuid

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base

PAYMENT_DEVICE_KINDS = ("zcredit_pinpad", "synqpay", "agamento_lan")

#: Nickname length after trimming.
NICKNAME_MAX = 40


class PaymentDevice(Base):
    __tablename__ = "payment_devices"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('zcredit_pinpad', 'synqpay', 'agamento_lan')", name="ck_payment_devices_kind"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)
    shop_id = Column(
        UUID(as_uuid=True), ForeignKey("shops.id", ondelete="CASCADE"), nullable=False, index=True
    )
    nickname = Column(String(NICKNAME_MAX), nullable=False)
    kind = Column(String(16), nullable=False)
    config = Column(JSONB, nullable=False, default=dict, server_default="{}")
    active = Column(Boolean, nullable=False, default=True, server_default="true")
    sort_order = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


#: One nickname per shop whatever its case (the service answers 409 `nickname_taken` first).
Index(
    "uq_payment_devices_shop_nickname",
    PaymentDevice.shop_id,
    func.lower(PaymentDevice.nickname),
    unique=True,
)
