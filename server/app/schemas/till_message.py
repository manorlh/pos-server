"""Messages to tills ("הודעות לקופות"): the dashboard's compose body and the till's ack."""
from __future__ import annotations

from datetime import date, datetime
import re
from typing import List, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.till_message import TILL_MESSAGE_LEVELS, TILL_MESSAGE_SCHEDULES

TITLE_MAX = 200
BODY_MAX = 2000
#: A recurring occurrence is shown for at most a week.
TTL_MAX_MINUTES = 7 * 24 * 60

_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _clean_title(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("title must be text")
    value = value.strip()
    if len(value) > TITLE_MAX:
        raise ValueError(f"title is at most {TITLE_MAX} characters")
    return value or None


def _clean_body(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("body must be non-empty text")
    value = value.strip()
    if len(value) > BODY_MAX:
        raise ValueError(f"body is at most {BODY_MAX} characters")
    return value


def _clean_days(value):
    if value is None:
        return None
    days = sorted({int(d) for d in value})
    if not days or any(d < 0 or d > 6 for d in days):
        raise ValueError("recurDays: one or more of 0 (Sunday) … 6 (Saturday)")
    return days


def _clean_time(value):
    if value is None:
        return None
    if not isinstance(value, str) or not _HHMM.match(value.strip()[:5]):
        raise ValueError("recurTime must be HH:MM")
    return value.strip()[:5]


class _ScheduleFields(BaseModel):
    """
    When a message goes out. `sendAt` / `expiresAt` without an offset are read in the
    tenant's timezone. Recurring: `recurDays` (0 = Sunday … 6 = Saturday) at `recurTime`
    ("HH:MM", tenant-local), optionally from `recurStartDate` to `recurEndDate`
    (inclusive); each occurrence is shown for `occurrenceTtlMinutes`, else to the end of
    its day, and never past the next one.
    """

    model_config = ConfigDict(populate_by_name=True)

    send_at: Optional[datetime] = Field(None, alias="sendAt")
    recur_days: Optional[List[int]] = Field(None, alias="recurDays")
    recur_time: Optional[str] = Field(None, alias="recurTime")
    recur_start_date: Optional[date] = Field(None, alias="recurStartDate")
    recur_end_date: Optional[date] = Field(None, alias="recurEndDate")
    occurrence_ttl_minutes: Optional[int] = Field(
        None, alias="occurrenceTtlMinutes", ge=1, le=TTL_MAX_MINUTES
    )

    @field_validator("recur_days", mode="before")
    @classmethod
    def _days(cls, value):
        return _clean_days(value)

    @field_validator("recur_time", mode="before")
    @classmethod
    def _time(cls, value):
        return _clean_time(value)


class TillMessageCreate(_ScheduleFields):
    model_config = ConfigDict(populate_by_name=True)

    title: Optional[str] = None
    body: str
    target_level: str = Field(..., alias="targetLevel")
    target_id: uuid.UUID = Field(..., alias="targetId")
    #: When it stops being shown; null = until every till has acknowledged it.
    #: Not for recurring messages (see `occurrenceTtlMinutes`).
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    schedule_kind: str = Field("now", alias="scheduleKind")

    @field_validator("title", mode="before")
    @classmethod
    def _title(cls, value):
        return _clean_title(value)

    @field_validator("body", mode="before")
    @classmethod
    def _body(cls, value):
        return _clean_body(value)

    @field_validator("target_level", mode="before")
    @classmethod
    def _level(cls, value):
        if value not in TILL_MESSAGE_LEVELS:
            raise ValueError(f"targetLevel must be one of {', '.join(TILL_MESSAGE_LEVELS)}")
        return value

    @field_validator("schedule_kind", mode="before")
    @classmethod
    def _kind(cls, value):
        value = value or "now"
        if value not in TILL_MESSAGE_SCHEDULES:
            raise ValueError(f"scheduleKind must be one of {', '.join(TILL_MESSAGE_SCHEDULES)}")
        return value

    @model_validator(mode="after")
    def _schedule(self):
        if self.schedule_kind == "scheduled" and self.send_at is None:
            raise ValueError("a scheduled message needs sendAt")
        if self.schedule_kind == "recurring":
            if not self.recur_days or not self.recur_time:
                raise ValueError("a recurring message needs recurDays and recurTime")
            if self.expires_at is not None:
                raise ValueError("a recurring message expires per occurrence (occurrenceTtlMinutes)")
        if (
            self.recur_start_date and self.recur_end_date
            and self.recur_end_date < self.recur_start_date
        ):
            raise ValueError("recurEndDate is before recurStartDate")
        return self


class TillMessageUpdate(_ScheduleFields):
    """
    Edit a scheduled message that has not gone out yet, or a recurring one. Only the
    fields sent change; `null` clears an optional one (an end date, the expiry).
    """

    title: Optional[str] = None
    body: Optional[str] = None
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")

    @field_validator("title", mode="before")
    @classmethod
    def _title(cls, value):
        return _clean_title(value)

    @field_validator("body", mode="before")
    @classmethod
    def _body(cls, value):
        return None if value is None else _clean_body(value)


class TillMessageAckIn(BaseModel):
    """The till's "קראתי": who was signed in. Both optional, so an ack is never lost."""

    model_config = ConfigDict(populate_by_name=True)

    pos_user_id: Optional[str] = Field(None, alias="posUserId")
    pos_user_name: Optional[str] = Field(None, alias="posUserName")

    @field_validator("pos_user_id", "pos_user_name", mode="before")
    @classmethod
    def _text(cls, value):
        # A till may send its user id as a number; it is stored as text either way and
        # trimmed to the column by the service.
        if value is None or isinstance(value, str):
            return value
        if isinstance(value, (int, float)):
            return str(value)
        raise ValueError("must be text")
