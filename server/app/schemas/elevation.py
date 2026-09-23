"""Wire shapes for till elevation. camelCase out, either case in, like the rest."""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

_WIRE = ConfigDict(populate_by_name=True, from_attributes=True)


class ElevationRequest(BaseModel):
    model_config = _WIRE

    #: Who is approving: a cloud account's email, or the till username of someone in
    #: this till's own shop. Exactly one. The username is the everyday path — the person
    #: a cashier fetches is standing in the shop with a till login of their own — and
    #: the email stays for approvers who have none, like a distributor.
    email: Optional[EmailStr] = None
    username: Optional[str] = None
    pin: str
    #: What the till wants to do. Names it does not recognise are ignored rather
    #: than rejected, so a newer device asking for a scope this server has not
    #: shipped still gets a session for the rest.
    scopes: List[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _exactly_one_identity(self):
        has_email = self.email is not None
        has_username = bool((self.username or "").strip())
        if has_email == has_username:
            raise ValueError("send exactly one of email or username")
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


class ElevationStatus(BaseModel):
    model_config = _WIRE

    scopes: List[str]
    expires_at: datetime = Field(alias="expiresAt")
    absolute_expires_at: datetime = Field(alias="absoluteExpiresAt")
    user_name: str = Field(alias="userName")
    user_email: Optional[str] = Field(default=None, alias="userEmail")


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
