"""Card transmission payloads (docs/SHIFTS_API.md §4)."""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: Columns the counts land in are INTEGER; beyond that a reading is not a reading.
INT32_MAX = 2**31 - 1
#: Numeric(12, 2): anything at or beyond 10¹⁰ does not fit.
MONEY_LIMIT = Decimal(10) ** 10
CENT = Decimal("0.01")

#: The most terminal ids one report may carry; a batch is a day of one till.
MAX_TERMINAL_IDS = 5000
TERMINAL_ID_LENGTH = 64
REPORT_TEXT_LIMIT = 65536

#: Where the till's pending count came from (docs/SHIFTS_API.md §4.2).
HEARTBEAT_SOURCES = ("terminal", "local")


def cut(value: Any, limit: int) -> Optional[str]:
    """A string cut to its column; any other scalar as its text. Never a 422."""
    if value is None:
        return None
    text = value if isinstance(value, str) else str(value)
    return text[:limit]


def money_or_none(value: Any) -> Optional[Decimal]:
    """A money reading rounded to the cent, or None if it is not one that fits."""
    if value is None or isinstance(value, bool):
        return None
    try:
        amount = Decimal(str(value).strip()) if not isinstance(value, Decimal) else value
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite() or abs(amount) >= MONEY_LIMIT:
        return None
    return amount.quantize(CENT, rounding=ROUND_HALF_UP)


def count_or_none(value: Any) -> Optional[int]:
    """A non-negative count that fits INTEGER, or None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, float):
        if not value.is_integer():
            return None
        value = int(value)
    try:
        count = int(value)
    except (TypeError, ValueError):
        return None
    if count < 0 or count > INT32_MAX:
        return None
    return count


def _lenient(handler, value):
    try:
        return handler(value)
    except (ValueError, TypeError):
        return None


class HeartbeatTransmission(BaseModel):
    """
    The till's pending transmission state, inside the heartbeat (§4.2).

    Nothing in here may fail the heartbeat: every field that cannot be read is None.
    """

    model_config = ConfigDict(populate_by_name=True)

    pending_count: Optional[int] = Field(None, alias="pendingCount")
    pending_amount: Optional[Decimal] = Field(None, alias="pendingAmount")
    #: Card sales in a successful batch the terminal did not name by uid — assumed, not
    #: verified.
    assumed_count: Optional[int] = Field(None, alias="assumedCount")
    oldest_pending_at: Optional[datetime] = Field(None, alias="oldestPendingAt")
    last_success_at: Optional[datetime] = Field(None, alias="lastSuccessAt")
    last_attempt_at: Optional[datetime] = Field(None, alias="lastAttemptAt")
    last_error: Optional[str] = Field(None, alias="lastError")
    source: Optional[str] = None

    @field_validator("pending_count", "assumed_count", mode="wrap")
    @classmethod
    def _count(cls, value, handler):
        return count_or_none(value)

    @field_validator("pending_amount", mode="wrap")
    @classmethod
    def _amount(cls, value, handler):
        return money_or_none(value)

    @field_validator("oldest_pending_at", "last_success_at", "last_attempt_at", mode="wrap")
    @classmethod
    def _moment(cls, value, handler):
        return _lenient(handler, value)

    @field_validator("last_error", mode="wrap")
    @classmethod
    def _error(cls, value, handler):
        return cut(value, 500) if not isinstance(value, (dict, list)) else None

    @field_validator("source", mode="wrap")
    @classmethod
    def _source(cls, value, handler):
        """
        `terminal` (Agamento's own count) or `local` (the till's count since its last
        success), as the till sends them; case and spaces are forgiven. Any other string
        is kept as sent (cut to 32) rather than refused — the beat must not fail.
        """
        if value is None or isinstance(value, (dict, list, bool)):
            return None
        text = str(value).strip()
        if text.lower() in HEARTBEAT_SOURCES:
            return text.lower()
        return text[:32] or None


class TransmissionReportIn(BaseModel):
    """One `doPeriodic` attempt, reported by the till (§4.1)."""

    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    trigger: Literal["shift_close", "daily", "manual", "remote", "z_close"]
    request_id: Optional[uuid.UUID] = Field(None, alias="requestId")
    started_at: datetime = Field(..., alias="startedAt")
    finished_at: Optional[datetime] = Field(None, alias="finishedAt")
    status: Literal["success", "failed", "unknown"]
    status_code: Optional[int] = Field(None, alias="statusCode")
    status_message: Optional[str] = Field(None, alias="statusMessage")
    batch_number: Optional[str] = Field(None, alias="batchNumber")
    transaction_count: Optional[int] = Field(None, alias="transactionCount")
    amount: Optional[Decimal] = None
    terminal_transaction_ids: List[str] = Field(default_factory=list, alias="terminalTransactionIds")
    #: The uids of the till's card sales it assumed went in this batch because the terminal
    #: confirmed it without naming its sales (docs/SPEC_REPORTS.md §7). None: a till from
    #: before the field — the cloud then reads the batch as the till did
    #: (`transmissions.assume_unnamed`); a list, even empty, is the till's own word.
    assumed_terminal_transaction_ids: Optional[List[str]] = Field(None, alias="assumedTerminalTransactionIds")
    report_text: Optional[str] = Field(None, alias="reportText")
    error: Optional[str] = None

    @field_validator("request_id", "finished_at", mode="wrap")
    @classmethod
    def _optional_lenient(cls, value, handler):
        return _lenient(handler, value)

    @field_validator("status_code", mode="wrap")
    @classmethod
    def _status_code(cls, value, handler):
        parsed = _lenient(handler, value)
        if parsed is None or abs(parsed) > INT32_MAX:
            return None
        return parsed

    @field_validator("transaction_count", mode="wrap")
    @classmethod
    def _count(cls, value, handler):
        return count_or_none(value)

    @field_validator("amount", mode="wrap")
    @classmethod
    def _amount(cls, value, handler):
        return money_or_none(value)

    @field_validator("status_message", mode="wrap")
    @classmethod
    def _message(cls, value, handler):
        return cut(value, 500)

    @field_validator("batch_number", mode="wrap")
    @classmethod
    def _batch(cls, value, handler):
        return cut(value, 64) if not isinstance(value, (dict, list)) else None

    @field_validator("error", mode="wrap")
    @classmethod
    def _err(cls, value, handler):
        return cut(value, 2000)

    @field_validator("report_text", mode="wrap")
    @classmethod
    def _report(cls, value, handler):
        return cut(value, REPORT_TEXT_LIMIT)

    @field_validator("terminal_transaction_ids", mode="wrap")
    @classmethod
    def _ids(cls, value, handler):
        """Blanks dropped, duplicates collapsed (first order kept), each cut to 64."""
        if not isinstance(value, (list, tuple)):
            return []
        return _clean_ids(value)

    @field_validator("assumed_terminal_transaction_ids", mode="wrap")
    @classmethod
    def _assumed_ids(cls, value, handler):
        """None when absent (an older till); otherwise cleaned like the named ids."""
        if value is None:
            return None
        if not isinstance(value, (list, tuple)):
            return []
        return _clean_ids(value)


def _clean_ids(value) -> List[str]:
    """Blanks dropped, duplicates collapsed (first order kept), each cut to 64."""
    out: List[str] = []
    seen = set()
    for raw in value:
        if raw is None or isinstance(raw, (dict, list, bool)):
            continue
        text = str(raw).strip()[:TERMINAL_ID_LENGTH]
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
        if len(out) >= MAX_TERMINAL_IDS:
            break
    return out


class TransmitAckIn(BaseModel):
    """The till acknowledges a transmit instruction (§4.5)."""

    model_config = ConfigDict(populate_by_name=True)

    request_id: uuid.UUID = Field(..., alias="requestId")
    phase: Literal["received", "deferred", "completed", "failed"]
    transmission_id: Optional[uuid.UUID] = Field(None, alias="transmissionId")
    error_code: Optional[str] = Field(None, alias="errorCode")
    error_message: Optional[str] = Field(None, alias="errorMessage")

    @field_validator("transmission_id", mode="wrap")
    @classmethod
    def _tid(cls, value, handler):
        return _lenient(handler, value)

    @field_validator("error_code", mode="wrap")
    @classmethod
    def _code(cls, value, handler):
        return cut(value, 64)

    @field_validator("error_message", mode="wrap")
    @classmethod
    def _msg(cls, value, handler):
        return cut(value, 2000)


class ReplacementCodeBody(BaseModel):
    """Options for `POST /machines/{id}/replacement-code` (§4.9)."""

    model_config = ConfigDict(populate_by_name=True)

    #: The till holds card sales it never transmitted and cannot any more (it is dead);
    #: the operator has the recovery list and accepts that the new device will not
    #: transmit them.
    acknowledge_untransmitted: bool = Field(False, alias="acknowledgeUntransmitted")
    #: The replacement unit's hardware (`app.schemas.pos_machine.DeviceModel`, spelled out:
    #: that module imports this one), set on the till when it pairs. Omitted keeps the
    #: model the till already has.
    device_model: Optional[
        Literal[
            "N55F", "MODO", "P18", "LANDI", "FEITIAN_TABLET", "GENERIC_ANDROID",
            "SUNMI_V1", "SUNMI_V2", "SUNMI_V2_PRO", "SUNMI_V2S", "SUNMI_V2S_PLUS", "SUNMI_V3",
            "SUNMI_P1", "SUNMI_P2", "SUNMI_P3", "SUNMI_L2", "SUNMI_M2",
            "SUNMI_T1", "SUNMI_T2", "SUNMI_T2_MINI", "SUNMI_T2S", "SUNMI_T3",
            "SUNMI_D2_MINI", "SUNMI_D2S", "SUNMI_D2S_PLUS", "SUNMI_D3", "SUNMI_D3_MINI",
            "SUNMI_K2", "SUNMI",
            "SYNQPAY_DX8000", "SYNQPAY_DX6000", "SYNQPAY_EX8000", "SYNQPAY_RX5000",
            "SYNQPAY_S1P2", "SYNQPAY_S1U2_M4", "SYNQPAY_VERIFONE", "SYNQPAY",
            "PAX_A77", "UROVO_I9100",
        ]
    ] = Field(None, alias="deviceModel")
    #: Why the till is replaced — kept in "הוחלפה קופה" when a device redeems the code
    #: (docs/SPEC_OFFLINE_TILL_Z.md §4.6.2).
    reason: Optional[str] = Field(None, max_length=500)
