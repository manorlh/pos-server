"""Wire shapes for till elevation. camelCase out, either case in, like the rest."""

import uuid
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

_WIRE = ConfigDict(populate_by_name=True, from_attributes=True)


class ElevationRequest(BaseModel):
    model_config = _WIRE

    #: Who is approving — exactly one of these:
    #:
    #: * `pos_user_id` — a till user picked from the roster the till already holds. The
    #:   everyday path: the person a cashier fetches is standing in the shop, their name
    #:   is already on the device, and one tap on it replaces typing anything at all.
    #: * `username` — the same person, typed, for a till whose roster is stale.
    #: * `email` — a cloud account, for approvers with no till login, like a distributor.
    email: Optional[EmailStr] = None
    username: Optional[str] = None
    pos_user_id: Optional[uuid.UUID] = Field(default=None, alias="posUserId")
    pin: str
    #: What the till wants to do. Names it does not recognise are ignored rather
    #: than rejected, so a newer device asking for a scope this server has not
    #: shipped still gets a session for the rest.
    scopes: List[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _exactly_one_identity(self):
        given = [
            self.email is not None,
            bool((self.username or "").strip()),
            self.pos_user_id is not None,
        ]
        if sum(given) != 1:
            raise ValueError("send exactly one of email, username or posUserId")
        return self


class ElevationResponse(BaseModel):
    model_config = _WIRE

    #: Shown once and never stored server-side in the clear. The till holds it in
    #: memory only — never on disk, because disk survives the manager walking away.
    token: str
    scopes: List[str]
    expires_at: datetime = Field(alias="expiresAt")
    absolute_expires_at: datetime = Field(alias="absoluteExpiresAt")
    #: Who the audit trail will name. Sent back so the till can show "elevated as
    #: Yossi" rather than echoing the typed email, which may differ in case.
    user_name: str = Field(alias="userName")
    #: Null when a till user approved — they have no email.
    user_email: Optional[str] = Field(default=None, alias="userEmail")
    #: What the till should offer next time, exactly as the server matched it: the
    #: username for a till user, the email for a cloud account.
    user_login: str = Field(alias="userLogin")
    #: Who approved, as ids the till puts on the documents this grant authorised —
    #: exactly one is set. `approverUserId` (a cloud `users` id) → the document's
    #: `approvedByUserId`; `approverPosUserId` (a till user, `pos_users`) → its
    #: `approvedByPosUserId`.
    approver_user_id: Optional[uuid.UUID] = Field(default=None, alias="approverUserId")
    approver_pos_user_id: Optional[uuid.UUID] = Field(default=None, alias="approverPosUserId")


class ElevationStatus(BaseModel):
    model_config = _WIRE

    scopes: List[str]
    expires_at: datetime = Field(alias="expiresAt")
    absolute_expires_at: datetime = Field(alias="absoluteExpiresAt")
    user_name: str = Field(alias="userName")
    user_email: Optional[str] = Field(default=None, alias="userEmail")
    #: As on `ElevationResponse`: exactly one is set.
    approver_user_id: Optional[uuid.UUID] = Field(default=None, alias="approverUserId")
    approver_pos_user_id: Optional[uuid.UUID] = Field(default=None, alias="approverPosUserId")


class TillPinSet(BaseModel):
    """Setting your own till PIN from the dashboard."""

    model_config = _WIRE

    pin: str


class TillPinAssign(BaseModel):
    """An administrator setting somebody else's PIN. What is set here is what they type."""

    model_config = _WIRE

    pin: str


class TillPinState(BaseModel):
    model_config = _WIRE

    has_pin: bool = Field(alias="hasPin")
    set_at: Optional[datetime] = Field(default=None, alias="setAt")
