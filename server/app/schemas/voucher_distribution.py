""""הפצה בוואטסאפ": the dashboard's bodies (app/routers/voucher_distribution.py)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.services.voucher_distribution import KINDS, MAX_PER_RECIPIENT, MAX_ROWS, MODES, NAME_MAX, TEMPLATE_MAX

SENDABLE_VIA = ("wa_link", "share", "manual", "download")


class DistributionRowIn(BaseModel):
    """One row of the list: name (optional), phone, and a group number or a count."""

    model_config = ConfigDict(populate_by_name=True)

    #: Cut to NAME_MAX by the plan; a long cell never refuses the whole list.
    name: Optional[str] = None
    #: As typed or as the spreadsheet cell held it (a number too).
    phone: Optional[Any] = None

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value):
        if value is None:
            return None
        return str(value)[: NAME_MAX * 2]
    #: Out-of-range or unreadable values are flagged per row by the plan, not refused (422) here.
    group: Optional[int] = None
    count: Optional[int] = None

    @field_validator("phone", mode="before")
    @classmethod
    def _phone(cls, value):
        if value is None or isinstance(value, (str, int, float)):
            return value if not isinstance(value, str) else value[:64]
        raise ValueError("phone must be text or a number")

    @field_validator("group", "count", mode="before")
    @classmethod
    def _number(cls, value):
        if value is None or value == "":
            return None
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            if text.endswith(".0"):
                text = text[:-2]
            return int(text) if text.isdigit() else -1
        if isinstance(value, float):
            return int(value) if value.is_integer() else -1
        return value


class DistributionImportIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    rows: List[DistributionRowIn] = Field(default_factory=list, max_length=MAX_ROWS)
    #: group — each row its group's vouchers; count — N each (`perRecipient`, or the row's own
    #: count); one — one voucher each.
    mode: str = "count"
    per_recipient: int = Field(1, alias="perRecipient", ge=1, le=MAX_PER_RECIPIENT)
    #: person (a recipient), or group — one message per group to whoever leads it (phone optional).
    kind: str = "person"
    #: Keep a number that appears twice (with a warning) instead of refusing the second row.
    allow_duplicates: bool = Field(False, alias="allowDuplicates")

    @field_validator("mode")
    @classmethod
    def _mode(cls, value):
        if value not in MODES:
            raise ValueError(f"mode: one of {', '.join(MODES)}")
        return value

    @field_validator("kind")
    @classmethod
    def _kind(cls, value):
        if value not in KINDS:
            raise ValueError(f"kind: one of {', '.join(KINDS)}")
        return value


class DistributionSettingsIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    message_template: Optional[str] = Field(None, alias="messageTemplate", max_length=TEMPLATE_MAX)
    group_message_template: Optional[str] = Field(None, alias="groupMessageTemplate", max_length=TEMPLATE_MAX)
    layout: Optional[str] = None
    #: Null: the default (the batch's validity end + 7 days).
    link_expires_at: Optional[datetime] = Field(None, alias="linkExpiresAt")


class DistributionSentIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    via: str = "manual"

    @field_validator("via")
    @classmethod
    def _via(cls, value):
        if value not in SENDABLE_VIA:
            raise ValueError(f"via: one of {', '.join(SENDABLE_VIA)}")
        return value


class DistributionReasonIn(BaseModel):
    reason: Optional[str] = Field(None, max_length=500)


class DistributionUnassignIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The vouchers to take back; none: all of the recipient's.
    voucher_ids: Optional[List[str]] = Field(None, alias="voucherIds", max_length=MAX_PER_RECIPIENT * 10)
    reason: Optional[str] = Field(None, max_length=500)


class DistributionApiSendIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The recipients to send; none: every pending (or failed) one with a phone.
    recipient_ids: Optional[List[str]] = Field(None, alias="recipientIds", max_length=MAX_ROWS)


class WhatsAppConfigIn(BaseModel):
    """A company's Cloud API settings. The token and the app secret are write-only ("••••" = keep)."""

    model_config = ConfigDict(populate_by_name=True)

    enabled: Optional[bool] = None
    phone_number_id: Optional[str] = Field(None, alias="phoneNumberId", max_length=64)
    business_account_id: Optional[str] = Field(None, alias="businessAccountId", max_length=64)
    template_name: Optional[str] = Field(None, alias="templateName", max_length=128)
    template_language: Optional[str] = Field(None, alias="templateLanguage", max_length=16)
    body_params: Optional[List[str]] = Field(None, alias="bodyParams", max_length=10)
    api_version: Optional[str] = Field(None, alias="apiVersion", max_length=16)
    access_token: Optional[str] = Field(None, alias="accessToken", max_length=1000)
    app_secret: Optional[str] = Field(None, alias="appSecret", max_length=1000)
    regenerate_verify_token: bool = Field(False, alias="regenerateVerifyToken")
