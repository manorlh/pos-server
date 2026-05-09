from datetime import datetime
from typing import List, Optional
import uuid

from pydantic import BaseModel, Field, field_validator

from app.models.pos_user import PosUserRole


PIN_MIN_LEN = 4
PIN_MAX_LEN = 6


def _validate_pin(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("pin must be a string")
    v = value.strip()
    if not v.isdigit():
        raise ValueError("pin must contain only digits")
    if not (PIN_MIN_LEN <= len(v) <= PIN_MAX_LEN):
        raise ValueError(f"pin must be {PIN_MIN_LEN}-{PIN_MAX_LEN} digits")
    return v


# ── Dashboard write schemas ──────────────────────────────────────────────────

class PosUserCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    first_name: Optional[str] = Field(None, alias="firstName", max_length=100)
    last_name: Optional[str] = Field(None, alias="lastName", max_length=100)
    worker_number: Optional[str] = Field(None, alias="workerNumber", max_length=32)
    role: PosUserRole = PosUserRole.CASHIER
    pin: str

    @field_validator("pin")
    @classmethod
    def _v_pin(cls, v: str) -> str:
        return _validate_pin(v)

    @field_validator("worker_number")
    @classmethod
    def _v_worker(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        s = v.strip()
        return s or None

    class Config:
        populate_by_name = True


class PosUserUpdate(BaseModel):
    first_name: Optional[str] = Field(None, alias="firstName", max_length=100)
    last_name: Optional[str] = Field(None, alias="lastName", max_length=100)
    worker_number: Optional[str] = Field(None, alias="workerNumber", max_length=32)
    role: Optional[PosUserRole] = None
    is_active: Optional[bool] = Field(None, alias="isActive")
    # Optional PIN reset in-line with update; explicit reset endpoint also exists.
    pin: Optional[str] = None

    @field_validator("pin")
    @classmethod
    def _v_pin(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return _validate_pin(v)

    class Config:
        populate_by_name = True


class PosUserResetPin(BaseModel):
    pin: str

    @field_validator("pin")
    @classmethod
    def _v_pin(cls, v: str) -> str:
        return _validate_pin(v)


# ── Dashboard response (no hash) ─────────────────────────────────────────────

class PosUserResponse(BaseModel):
    id: uuid.UUID
    merchant_id: uuid.UUID = Field(..., alias="merchantId")
    shop_id: uuid.UUID = Field(..., alias="shopId")
    username: str
    first_name: Optional[str] = Field(None, alias="firstName")
    last_name: Optional[str] = Field(None, alias="lastName")
    worker_number: Optional[str] = Field(None, alias="workerNumber")
    role: PosUserRole
    is_active: bool = Field(..., alias="isActive")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True


# ── POS sync row (DOES include pinHash) ──────────────────────────────────────

class PosUserSyncRow(BaseModel):
    """Row served only over the machine-JWT sync endpoint. Carries the bcrypt hash."""

    id: uuid.UUID
    shop_id: uuid.UUID = Field(..., alias="shopId")
    username: str
    first_name: Optional[str] = Field(None, alias="firstName")
    last_name: Optional[str] = Field(None, alias="lastName")
    worker_number: Optional[str] = Field(None, alias="workerNumber")
    pin_hash: str = Field(..., alias="pinHash")
    role: PosUserRole
    is_active: bool = Field(..., alias="isActive")
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True


class PosUsersSyncResponse(BaseModel):
    sync_type: str = Field("delta", alias="syncType")
    server_time: datetime = Field(..., alias="serverTime")
    users: List[PosUserSyncRow]

    class Config:
        populate_by_name = True
