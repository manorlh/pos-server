"""What a till sends about its cash drawer (docs/SPEC_ROLES_PERMISSIONS.md, the drawer spec §14)."""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from app.schemas.transaction import meta_as_dict

EventType = Literal[
    "CASH_SALE", "MANUAL", "CHANGE", "CASH_IN", "CASH_OUT", "DEPOSIT", "COUNT", "TEST", "REFUND",
    "AFTER_CLOSE", "PERMISSION",
]


class DrawerEventIn(BaseModel):
    """One attempt to open a drawer, or one permission override / refusal. Client id; idempotent."""

    id: uuid.UUID
    category: Literal["drawer", "permission"] = "drawer"
    event_type: EventType = Field(..., alias="eventType")
    permission: Optional[str] = Field(None, max_length=64)
    decision: Optional[Literal["allow", "approval", "deny"]] = None
    result: Literal["approved", "denied", "failed"]
    result_reason: Optional[str] = Field(None, alias="resultReason", max_length=1000)
    drawer_id: Optional[str] = Field(None, alias="drawerId", max_length=100)
    drawer_name: Optional[str] = Field(None, alias="drawerName", max_length=200)
    device_id: Optional[str] = Field(None, alias="deviceId", max_length=100)
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    employee_id: Optional[str] = Field(None, alias="employeeId", max_length=100)
    employee_name: Optional[str] = Field(None, alias="employeeName", max_length=200)
    employee_role: Optional[str] = Field(None, alias="employeeRole", max_length=100)
    approver_id: Optional[str] = Field(None, alias="approverId", max_length=100)
    approver_name: Optional[str] = Field(None, alias="approverName", max_length=200)
    approver_method: Optional[str] = Field(None, alias="approverMethod", max_length=16)
    table_id: Optional[str] = Field(None, alias="tableId", max_length=100)
    sale_id: Optional[uuid.UUID] = Field(None, alias="saleId")
    payment_id: Optional[str] = Field(None, alias="paymentId", max_length=100)
    original_sale_id: Optional[uuid.UUID] = Field(None, alias="originalSaleId")
    reason: Optional[str] = Field(None, max_length=32)
    reason_note: Optional[str] = Field(None, alias="reasonNote", max_length=2000)
    movement_id: Optional[uuid.UUID] = Field(None, alias="movementId")
    cash_movement_type: Optional[str] = Field(None, alias="cashMovementType", max_length=16)
    amount: Optional[Decimal] = Field(None, ge=-10_000_000, le=10_000_000)
    expected_balance: Optional[Decimal] = Field(None, alias="expectedBalance", ge=-10_000_000, le=10_000_000)
    offline: bool = False
    training: bool = False
    occurred_at: datetime = Field(..., alias="occurredAt")
    details: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True

    @field_validator("details", mode="before")
    @classmethod
    def _details(cls, value):
        return meta_as_dict(value)


class CashMovementIn(BaseModel):
    """Cash In / Cash Out / Deposit / a count. Client id; idempotent."""

    id: uuid.UUID
    type: Literal["cash_in", "cash_out", "deposit", "count"]
    amount: Decimal = Field(..., ge=0, le=10_000_000)
    expected_before: Optional[Decimal] = Field(None, alias="expectedBefore", ge=-10_000_000, le=10_000_000)
    expected_after: Optional[Decimal] = Field(None, alias="expectedAfter", ge=-10_000_000, le=10_000_000)
    variance: Optional[Decimal] = Field(None, ge=-10_000_000, le=10_000_000)
    blind: bool = False
    reason: Optional[str] = Field(None, max_length=100)
    note: Optional[str] = Field(None, max_length=2000)
    source: Optional[str] = Field(None, max_length=200)
    shift_id: Optional[uuid.UUID] = Field(None, alias="shiftId")
    employee_id: Optional[str] = Field(None, alias="employeeId", max_length=100)
    employee_name: Optional[str] = Field(None, alias="employeeName", max_length=200)
    approver_id: Optional[str] = Field(None, alias="approverId", max_length=100)
    approver_name: Optional[str] = Field(None, alias="approverName", max_length=200)
    drawer_event_id: Optional[uuid.UUID] = Field(None, alias="drawerEventId")
    offline: bool = False
    training: bool = False
    occurred_at: datetime = Field(..., alias="occurredAt")

    class Config:
        populate_by_name = True


class IngestOut(BaseModel):
    id: uuid.UUID
    status: Literal["accepted", "duplicate"]
