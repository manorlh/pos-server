"""The till's printer state, inside the heartbeat (docs/SHIFTS_API.md §1.6a)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.pos_machine import PRINTER_STATUSES
from app.schemas.transmission import INT32_MAX, _lenient, cut

#: The width of `pos_machines.printer_message`; a longer message is cut, never refused.
PRINTER_MESSAGE_LIMIT = 200


class HeartbeatPrinter(BaseModel):
    """
    The printer as the till last observed it.

    Nothing in here may fail the heartbeat: a status the cloud does not know is
    "unknown", and any other field that cannot be read is None.
    """

    model_config = ConfigDict(populate_by_name=True)

    status: str = "unknown"
    code: Optional[int] = None
    message: Optional[str] = None
    at: Optional[datetime] = None
    last_print_ok_at: Optional[datetime] = Field(None, alias="lastPrintOkAt")

    @field_validator("status", mode="wrap")
    @classmethod
    def _status(cls, value, handler):
        """One of PRINTER_STATUSES; case and spaces are forgiven, anything else is unknown."""
        if not isinstance(value, str):
            return "unknown"
        text = value.strip().lower().replace("-", "_").replace(" ", "_")
        return text if text in PRINTER_STATUSES else "unknown"

    @field_validator("code", mode="wrap")
    @classmethod
    def _code(cls, value, handler):
        """An integer vendor code that fits INTEGER, or None."""
        if value is None or isinstance(value, bool):
            return None
        if isinstance(value, float):
            if not value.is_integer():
                return None
            value = int(value)
        try:
            code = int(value)
        except (TypeError, ValueError):
            return None
        return code if abs(code) <= INT32_MAX else None

    @field_validator("message", mode="wrap")
    @classmethod
    def _message(cls, value, handler):
        if isinstance(value, (dict, list)):
            return None
        return cut(value, PRINTER_MESSAGE_LIMIT) or None

    @field_validator("at", "last_print_ok_at", mode="wrap")
    @classmethod
    def _moment(cls, value, handler):
        return _lenient(handler, value)
