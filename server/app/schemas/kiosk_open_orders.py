"""Wire shapes of "תשלום בקופה" — kiosk orders paid at the till (app/routers/kiosk_open_orders.py)."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

#: The most lines / vouchers one open order may carry.
MAX_LINES = 200
MAX_VOUCHERS = 10


class _In(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class OpenOrderLineIn(_In):
    """One line as the tills list it and the slip prints it."""

    name: str = Field(..., min_length=1, max_length=255)
    quantity: float = Field(..., gt=0, le=10_000)
    total_agorot: int = Field(..., alias="totalAgorot", ge=-10**9, le=10**9)
    notes: Optional[str] = Field(None, max_length=300)


class OpenOrderRedeemedIn(_In):
    product_id: str = Field(..., alias="productId", min_length=1, max_length=64)
    till_product_id: Optional[str] = Field(None, alias="tillProductId", max_length=64)
    name: Optional[str] = Field(None, max_length=255)
    quantity: int = Field(..., ge=1, le=10_000)


class OpenOrderVoucherIn(_In):
    """A prepaid voucher the kiosk redeemed towards the order (pending until it is paid)."""

    redemption_id: str = Field(..., alias="redemptionId", min_length=1, max_length=64)
    serial: int = Field(0, ge=0)
    amount_agorot: int = Field(..., alias="amountAgorot", ge=0, le=10**9)
    event_name: Optional[str] = Field(None, alias="eventName", max_length=200)
    redeemed: List[OpenOrderRedeemedIn] = Field(default_factory=list, max_length=MAX_LINES)


class KioskOpenOrderIn(_In):
    """
    One order the kiosk's customer will pay at the till, as the kiosk posts it (validated one by
    one, never the batch). `state` is `open` — or, for an order a till on the shop's LAN already
    took while the cloud was away, `paid` / `cancelled` with what that till said.
    """

    local_id: str = Field(..., alias="localId", min_length=1, max_length=64)
    pickup_number: int = Field(0, alias="pickupNumber", ge=0, le=99999)
    pickup_label: str = Field("", alias="pickupLabel", max_length=32)
    business_date: date = Field(..., alias="businessDate")
    service_type: Literal["take_away", "eat_in"] = Field(..., alias="serviceType")
    table_ref: Optional[str] = Field(None, alias="tableRef", max_length=64)
    fulfillment_mode: Literal["BON", "KDS"] = Field("BON", alias="fulfillmentMode")
    config_version: Optional[str] = Field(None, alias="configVersion", max_length=32)
    customer_name: Optional[str] = Field(None, alias="customerName", max_length=100)
    customer_phone: Optional[str] = Field(None, alias="customerPhone", max_length=32)
    item_count: int = Field(..., alias="itemCount", ge=0)
    total_agorot: int = Field(..., alias="totalAgorot", ge=0, le=10**9)
    tip_agorot: int = Field(0, alias="tipAgorot", ge=0, le=10**9)
    voucher_agorot: int = Field(0, alias="voucherAgorot", ge=0, le=10**9)
    due_agorot: int = Field(..., alias="dueAgorot", ge=0, le=10**9)
    created_at: datetime = Field(..., alias="createdAt")
    lines: List[OpenOrderLineIn] = Field(..., min_length=1, max_length=MAX_LINES)
    #: The kiosk's basket for the till to rebuild exactly (opaque here).
    cart: Optional[Dict[str, Any]] = None
    vouchers: List[OpenOrderVoucherIn] = Field(default_factory=list, max_length=MAX_VOUCHERS)
    #: "שלח למטבח לפני תשלום": the kiosk printed its bon already.
    kitchen_sent: bool = Field(False, alias="kitchenSent")
    state: Literal["open", "paid", "cancelled"] = "open"
    paid_by_name: Optional[str] = Field(None, alias="paidByName", max_length=200)
    paid_transaction_id: Optional[str] = Field(None, alias="paidTransactionId", max_length=64)
    paid_transaction_number: Optional[str] = Field(None, alias="paidTransactionNumber", max_length=64)
    paid_at: Optional[datetime] = Field(None, alias="paidAt")
    close_reason: Optional[str] = Field(None, alias="closeReason", max_length=300)

    @model_validator(mode="after")
    def _money_adds_up(self):
        # Agorot only: what the till takes is the order and its tip less the vouchers.
        if sum(v.amount_agorot for v in self.vouchers) != self.voucher_agorot:
            raise ValueError("voucherAgorot must be the sum of the vouchers")
        if self.total_agorot + self.tip_agorot - self.voucher_agorot != self.due_agorot:
            raise ValueError("dueAgorot must be totalAgorot + tipAgorot - voucherAgorot")
        if len({v.redemption_id for v in self.vouchers}) != len(self.vouchers):
            raise ValueError("a voucher redemption may be listed once")
        return self


class KioskOpenOrdersIn(_In):
    orders: List[Any] = Field(default_factory=list, max_length=100)


class TillActorIn(_In):
    """Who at the till: for "בטיפול בקופה X" and the audit."""

    pos_user_id: Optional[str] = Field(None, alias="posUserId", max_length=100)
    pos_user_name: Optional[str] = Field(None, alias="posUserName", max_length=100)


class OpenOrderPaidIn(TillActorIn):
    transaction_id: str = Field(..., alias="transactionId", min_length=1, max_length=64)
    transaction_number: Optional[str] = Field(None, alias="transactionNumber", max_length=64)
    #: The bon the till sent for it (KioskBonStatus wire), when it knows.
    bon_status: Optional[Literal["none", "queued", "sent", "printed", "failed"]] = Field(None, alias="bonStatus")
    paid_at: Optional[datetime] = Field(None, alias="paidAt")


class OpenOrderCancelIn(TillActorIn):
    reason: str = Field(..., min_length=1, max_length=300)
