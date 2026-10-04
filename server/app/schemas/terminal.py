"""The till's card terminal (Agamento) state, inside the heartbeat."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.pos_settings import TERMINAL_NUMBER_PATTERN
from app.schemas.transmission import _lenient, cut

#: Widths of the `pos_machines.terminal_*` columns; a longer value is cut, never refused.
TERMINAL_NUMBER_LIMIT = 20
CLEARING_SERVER_LIMIT = 16
#: Inside `terminal_last_write` (JSONB): kept short, it is shown on the dashboard.
WRITE_FIELD_LIMIT = 32
WRITE_VALUE_LIMIT = 32
WRITE_ERROR_LIMIT = 500


def _text(value, limit: int) -> Optional[str]:
    """A trimmed string cut to `limit`; blank, or not a scalar, is None."""
    if isinstance(value, (dict, list, bool)):
        return None
    return (cut(value, limit) or "").strip() or None


def _flag(value) -> Optional[bool]:
    """A real JSON bool, or None. "yes", 1 and friends are not a reading."""
    return value if isinstance(value, bool) else None


class HeartbeatTerminalWrite(BaseModel):
    """The till's last write into Agamento and how it went."""

    model_config = ConfigDict(populate_by_name=True)

    #: "terminalNumber" or "clearingServer".
    field: Optional[str] = None
    value: Optional[str] = None
    ok: Optional[bool] = None
    error: Optional[str] = None
    at: Optional[datetime] = None

    @field_validator("field", "value", "error", mode="wrap")
    @classmethod
    def _texts(cls, value, handler, info):
        limit = {"field": WRITE_FIELD_LIMIT, "value": WRITE_VALUE_LIMIT}.get(
            info.field_name, WRITE_ERROR_LIMIT
        )
        return _text(value, limit)

    @field_validator("ok", mode="wrap")
    @classmethod
    def _ok(cls, value, handler):
        return _flag(value)

    @field_validator("at", mode="wrap")
    @classmethod
    def _moment(cls, value, handler):
        return _lenient(handler, value)

    def as_json(self) -> dict:
        """What `pos_machines.terminal_last_write` stores (and the dashboard reads)."""
        return {
            "field": self.field,
            "value": self.value,
            "ok": self.ok,
            "error": self.error,
            "at": self.at.isoformat() if self.at is not None else None,
        }


class HeartbeatTerminal(BaseModel):
    """
    The card terminal as the till last read it from Agamento.

    Nothing in here may fail the heartbeat: any field that cannot be read is None, and
    a `lastWrite` that is not an object is dropped.
    """

    model_config = ConfigDict(populate_by_name=True)

    terminal_number: Optional[str] = Field(None, alias="terminalNumber")
    clearing_server: Optional[str] = Field(None, alias="clearingServer")
    offline_mode: Optional[bool] = Field(None, alias="offlineMode")
    last_write: Optional[HeartbeatTerminalWrite] = Field(None, alias="lastWrite")
    merchant_name: Optional[str] = Field(None, alias="merchantName")
    supplier_number: Optional[str] = Field(None, alias="supplierNumber")

    @field_validator("merchant_name", mode="wrap")
    @classmethod
    def _merchant(cls, value, handler):
        return _text(value, 120)

    @field_validator("supplier_number", mode="wrap")
    @classmethod
    def _supplier(cls, value, handler):
        return _text(value, 30)

    @field_validator("terminal_number", mode="wrap")
    @classmethod
    def _number(cls, value, handler):
        return _text(value, TERMINAL_NUMBER_LIMIT)

    @field_validator("clearing_server", mode="wrap")
    @classmethod
    def _server(cls, value, handler):
        text = _text(value, CLEARING_SERVER_LIMIT)
        return text.upper() if text else None

    @field_validator("offline_mode", mode="wrap")
    @classmethod
    def _offline(cls, value, handler):
        return _flag(value)

    @field_validator("last_write", mode="wrap")
    @classmethod
    def _write(cls, value, handler):
        return _lenient(handler, value) if isinstance(value, dict) else None


class TerminalNumberForceRequest(BaseModel):
    """`POST /machines/terminal-number/force`: force (or stop forcing) a level's tills."""

    model_config = ConfigDict(populate_by_name=True)

    level: Literal["company", "shop", "area", "machine"]
    target_id: uuid.UUID = Field(..., alias="targetId")
    #: Also set `expectedTerminalNumber` at that level. Omitted = leave it as it is.
    terminal_number: Optional[str] = Field(None, alias="terminalNumber")
    force: bool

    @field_validator("terminal_number")
    @classmethod
    def _check_terminal_number(cls, v: Optional[str]) -> Optional[str]:
        """Digits only, as `expectedTerminalNumber`; blank is the same as omitted."""
        if v is None or not v.strip():
            return None
        v = v.strip()
        if not TERMINAL_NUMBER_PATTERN.fullmatch(v):
            raise ValueError("Terminal number must be 1–20 digits")
        return v
