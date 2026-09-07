"""Wire shapes for till elevation. camelCase out, either case in, like the rest."""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field

_WIRE = ConfigDict(populate_by_name=True, from_attributes=True)


class ElevationRequest(BaseModel):
    model_config = _WIRE

    email: EmailStr
    pin: str
    #: What the till wants to do. Names it does not recognise are ignored rather
    #: than rejected, so a newer device asking for a scope this server has not
    #: shipped still gets a session for the rest.
    scopes: List[str] = Field(default_factory=list)


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
    user_email: str = Field(alias="userEmail")


class ElevationStatus(BaseModel):
    model_config = _WIRE

    scopes: List[str]
    expires_at: datetime = Field(alias="expiresAt")
    absolute_expires_at: datetime = Field(alias="absoluteExpiresAt")
    user_name: str = Field(alias="userName")
    user_email: str = Field(alias="userEmail")


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
