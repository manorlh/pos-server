"""
"עסקאות שלא הושלמו" (docs/SPEC_FAILED_PAYMENTS.md): the till's failed payment attempts in,
and the dashboard's list out. camelCase on the wire, like the neighbouring schemas.
"""
import re
import uuid
from datetime import date, datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

#: A wire code (`kind`, `outcome`, `channel`, `method`…): lower-case, digits and `_`.
_CODE_RE = re.compile(r"^[a-z0-9_]{1,32}$")
_LAST4_RE = re.compile(r"^\d{4}$")

REASON_MESSAGE_MAX = 300
AMOUNT_AGOROT_MAX = 100_000_000_000  # ₪1 billion: anything above is a bug, not a sale


def _text(value: Any, limit: int) -> Optional[str]:
    """Trimmed text cut to `limit` characters; None when empty. Never refuses the row."""
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def _code(value: Any, default: Optional[str] = None) -> Optional[str]:
    text = (str(value).strip().lower() if value is not None else "") or None
    if text is None:
        return default
    if not _CODE_RE.match(text):
        raise ValueError("must be a lower-case code (letters, digits, _), at most 32 characters")
    return text


class FailedPaymentIn(BaseModel):
    """
    One failed or aborted payment attempt, as the till sends it (`POST /sync/{m}/failed-payments`).

    `id` is the till's, stable: the till re-sends the same id when the row changes (e.g.
    linked later to the paying sale). Of the card only `cardLast4` (exactly 4 digits, else
    dropped) and `cardBrand` are kept. Unknown fields are ignored.
    """

    id: uuid.UUID
    occurred_at: datetime = Field(..., alias="occurredAt")
    resolved_at: Optional[datetime] = Field(None, alias="resolvedAt")
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    business_date: Optional[date] = Field(None, alias="businessDate")
    pos_user_id: Optional[str] = Field(None, alias="posUserId")
    employee_name: Optional[str] = Field(None, alias="employeeName")
    amount_agorot: int = Field(..., alias="amountAgorot", ge=0, le=AMOUNT_AGOROT_MAX)
    method: str = "card"
    kind: str = "sale"
    channel: str = "till"
    terminal_type: Optional[str] = Field(None, alias="terminalType")
    terminal_id: Optional[str] = Field(None, alias="terminalId")
    outcome: str
    reason_code: Optional[str] = Field(None, alias="reasonCode")
    reason_message: Optional[str] = Field(None, alias="reasonMessage")
    card_brand: Optional[str] = Field(None, alias="cardBrand")
    card_last4: Optional[str] = Field(None, alias="cardLast4")
    line_count: Optional[int] = Field(None, alias="lineCount")
    vuid: Optional[str] = None
    transaction_id: Optional[uuid.UUID] = Field(None, alias="transactionId")
    paid_by_transaction_id: Optional[uuid.UUID] = Field(None, alias="paidByTransactionId")
    paid_by_method: Optional[str] = Field(None, alias="paidByMethod")
    paid_at: Optional[datetime] = Field(None, alias="paidAt")
    #: The row's last change on the till. Missing: the attempt's resolve (or start) time.
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")
    #: Optional: an attempt of a till in training mode ("מצב הדרכה") — never stored for real.
    training: bool = False

    class Config:
        populate_by_name = True

    @field_validator("pos_user_id", mode="before")
    @classmethod
    def _pos_user(cls, value):
        return _text(value, 100)

    @field_validator("employee_name", mode="before")
    @classmethod
    def _employee(cls, value):
        return _text(value, 200)

    @field_validator("terminal_id", mode="before")
    @classmethod
    def _terminal_id(cls, value):
        return _text(value, 64)

    @field_validator("reason_code", mode="before")
    @classmethod
    def _reason_code(cls, value):
        return _text(value, 64)

    @field_validator("reason_message", mode="before")
    @classmethod
    def _reason_message(cls, value):
        return _text(value, REASON_MESSAGE_MAX)

    @field_validator("vuid", mode="before")
    @classmethod
    def _vuid(cls, value):
        return _text(value, 100)

    @field_validator("method", mode="before")
    @classmethod
    def _method(cls, value):
        return _code(value, "card")

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, value):
        return _code(value, "sale")

    @field_validator("channel", mode="before")
    @classmethod
    def _channel(cls, value):
        return _code(value, "till")

    @field_validator("outcome", mode="before")
    @classmethod
    def _outcome(cls, value):
        code = _code(value)
        if code is None:
            raise ValueError("outcome is required")
        return code

    @field_validator("terminal_type", mode="before")
    @classmethod
    def _terminal_type(cls, value):
        try:
            return _code(value)
        except ValueError:
            return _text(value, 32)

    @field_validator("paid_by_method", mode="before")
    @classmethod
    def _paid_by_method(cls, value):
        try:
            return _code(value)
        except ValueError:
            return None

    @field_validator("card_brand", mode="before")
    @classmethod
    def _card_brand(cls, value):
        from app.services.card_brands import BRANDS

        text = (str(value).strip().lower() if value is not None else "") or None
        if text is None:
            return None
        return text if text in BRANDS else "other"

    @field_validator("card_last4", mode="before")
    @classmethod
    def _card_last4(cls, value):
        # Privacy: exactly the last four digits, or nothing at all.
        text = str(value).strip() if isinstance(value, (str, int)) and not isinstance(value, bool) else ""
        return text if _LAST4_RE.match(text) else None

    @field_validator("line_count", mode="before")
    @classmethod
    def _line_count(cls, value):
        try:
            count = int(value)
        except (TypeError, ValueError):
            return None
        return count if 0 <= count <= 100_000 else None


class FailedPaymentUpsertOut(BaseModel):
    id: uuid.UUID
    #: accepted (201, new) · updated (200, newer content applied) · duplicate (200, nothing to apply).
    status: str


class FailedPaymentOut(BaseModel):
    id: uuid.UUID
    occurred_at: datetime = Field(..., alias="occurredAt")
    resolved_at: Optional[datetime] = Field(None, alias="resolvedAt")
    received_at: Optional[datetime] = Field(None, alias="receivedAt")
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    shop_name: Optional[str] = Field(None, alias="shopName")
    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    pos_number: Optional[str] = Field(None, alias="posNumber")
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    shift_number: Optional[int] = Field(None, alias="shiftNumber")
    business_date: Optional[date] = Field(None, alias="businessDate")
    pos_user_id: Optional[str] = Field(None, alias="posUserId")
    employee_name: Optional[str] = Field(None, alias="employeeName")
    amount_agorot: int = Field(..., alias="amountAgorot")
    method: str
    kind: str
    channel: str
    terminal_type: Optional[str] = Field(None, alias="terminalType")
    terminal_id: Optional[str] = Field(None, alias="terminalId")
    outcome: str
    reason_code: Optional[str] = Field(None, alias="reasonCode")
    reason_message: Optional[str] = Field(None, alias="reasonMessage")
    card_brand: Optional[str] = Field(None, alias="cardBrand")
    card_last4: Optional[str] = Field(None, alias="cardLast4")
    line_count: Optional[int] = Field(None, alias="lineCount")
    vuid: Optional[str] = None
    transaction_id: Optional[uuid.UUID] = Field(None, alias="transactionId")
    #: The voided document as printed (`20000057`), when the cloud has it.
    transaction_number: Optional[str] = Field(None, alias="transactionNumber")
    paid_by_transaction_id: Optional[uuid.UUID] = Field(None, alias="paidByTransactionId")
    paid_by_transaction_number: Optional[str] = Field(None, alias="paidByTransactionNumber")
    paid_by_method: Optional[str] = Field(None, alias="paidByMethod")
    paid_at: Optional[datetime] = Field(None, alias="paidAt")
    #: An `unresolved` attempt's latest manager command to its till (app/services/card_attempt_commands.py
    #: `command_out`): `{id, action, status, statusLabel, requestedByName, requestedAt, deliveredAt,
    #: answeredAt, resultOutcome, resultMessage…}`; null when none.
    card_command: Optional[Dict[str, Any]] = Field(None, alias="cardCommand")
    #: Its latest check the till answered (what the terminal said: `details.verdict`…); null when none.
    card_check: Optional[Dict[str, Any]] = Field(None, alias="cardCheck")

    class Config:
        populate_by_name = True


class FailedPaymentSummary(BaseModel):
    """
    Sales (kind sale + keyed) and payouts apart; `paidLaterCount` of the sales. `approved_late`
    ("אושר בבדיקה") is in none of them (`approvedLateCount` apart); `unresolved` ("לא הוכרע") is
    in them and also counted apart.
    """

    count: int = 0
    total_agorot: int = Field(0, alias="totalAgorot")
    payout_count: int = Field(0, alias="payoutCount")
    payout_total_agorot: int = Field(0, alias="payoutTotalAgorot")
    paid_later_count: int = Field(0, alias="paidLaterCount")
    unresolved_count: int = Field(0, alias="unresolvedCount")
    unresolved_total_agorot: int = Field(0, alias="unresolvedTotalAgorot")
    approved_late_count: int = Field(0, alias="approvedLateCount")

    class Config:
        populate_by_name = True


class CancelledSaleOut(BaseModel):
    id: uuid.UUID
    document_number: Optional[str] = Field(None, alias="documentNumber")
    transaction_number: str = Field(..., alias="transactionNumber")
    document_type: Optional[int] = Field(None, alias="documentType")
    total_amount: float = Field(..., alias="totalAmount")
    total_agorot: int = Field(..., alias="totalAgorot")
    payment_method: Optional[str] = Field(None, alias="paymentMethod")
    created_at: datetime = Field(..., alias="createdAt")
    shop_id: Optional[uuid.UUID] = Field(None, alias="shopId")
    machine_id: uuid.UUID = Field(..., alias="machineId")
    machine_name: Optional[str] = Field(None, alias="machineName")
    pos_number: Optional[str] = Field(None, alias="posNumber")
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    cashier_id: Optional[str] = Field(None, alias="cashierId")
    cashier_name: Optional[str] = Field(None, alias="cashierName")

    class Config:
        populate_by_name = True


class CancelledSales(BaseModel):
    count: int = 0
    total_agorot: int = Field(0, alias="totalAgorot")
    items: List[CancelledSaleOut] = []

    class Config:
        populate_by_name = True


class FailedPaymentListResponse(BaseModel):
    page: int
    page_size: int = Field(..., alias="pageSize")
    total: int
    summary: FailedPaymentSummary
    items: List[FailedPaymentOut]
    cancelled_sales: CancelledSales = Field(..., alias="cancelledSales")

    class Config:
        populate_by_name = True


# ── "תשלום לא מוכרע": the manager's commands (app/services/card_attempt_commands.py) ──


class CardCommandIn(BaseModel):
    """
    `POST /failed-payments/{attemptId}/card-commands`: check on the terminal, or decide
    ("אשר והכנס את העסקה" = `mark_approved`, "בטל" = `mark_not_approved`). `confirmMismatch`: the
    manager confirmed a decision against the terminal's answer, or with none (else 409
    `card_decision_mismatch`).
    """

    action: Literal["check", "mark_approved", "mark_not_approved"]
    confirm_mismatch: bool = Field(False, alias="confirmMismatch")

    class Config:
        populate_by_name = True


class CardCheckDetailsIn(BaseModel):
    """
    What the terminal said on a check (the till's lookup by vuid, read-only). Cleaned, never
    refused for a field it cannot read: of the card only the last four digits are kept.
    """

    verdict: Literal["approved", "cancelled", "not_found", "unknown"]
    terminal_uid: Optional[str] = Field(None, alias="terminalUid")
    at: Optional[datetime] = None
    amount_agorot: Optional[int] = Field(None, alias="amountAgorot", ge=0, le=AMOUNT_AGOROT_MAX)
    last4: Optional[str] = None
    auth_number: Optional[str] = Field(None, alias="authNumber")
    brand: Optional[str] = None
    checked_at: Optional[datetime] = Field(None, alias="checkedAt")

    class Config:
        populate_by_name = True
        extra = "ignore"

    @field_validator("terminal_uid", mode="before")
    @classmethod
    def _uid(cls, value):
        return _text(value, 100)

    @field_validator("auth_number", mode="before")
    @classmethod
    def _auth(cls, value):
        return _text(value, 32)

    @field_validator("brand", mode="before")
    @classmethod
    def _brand(cls, value):
        return _text(value, 32)

    @field_validator("last4", mode="before")
    @classmethod
    def _last4(cls, value):
        text = str(value).strip() if isinstance(value, (str, int)) and not isinstance(value, bool) else ""
        return text if _LAST4_RE.match(text) else None

    def stored(self) -> Dict[str, Any]:
        """As kept on the command: camelCase, ISO times, nothing empty."""
        return self.model_dump(mode="json", by_alias=True, exclude_none=True)


class CardCommandResultIn(BaseModel):
    """`POST /sync/{m}/card-commands/{commandId}/result`: what the till did and found."""

    status: Literal["done", "failed", "not_found", "busy"]
    outcome: Optional[Literal["approved", "not_charged", "unknown"]] = None
    message: Optional[str] = Field(None, max_length=2000)
    #: A check: what the terminal said (`{verdict, terminalUid?, at?, amountAgorot?, last4?,
    #: authNumber?, brand?, checkedAt}`).
    details: Optional[CardCheckDetailsIn] = None
