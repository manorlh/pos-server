"""Request bodies of "הרשאות דשבורד" (app/routers/dashboard_access.py, `POST /users`'s `access`)."""
from __future__ import annotations

import uuid
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

_WIRE = ConfigDict(populate_by_name=True)


class AccessScopeIn(BaseModel):
    """The org scope and sections of one user (also what `POST /users` takes as `access`)."""

    model_config = _WIRE

    #: "org_manager" | "full" | a template's id. With `sections` absent, its sections are used.
    template: Optional[str] = None
    full_access: Optional[bool] = Field(None, alias="fullAccess")
    sections: Optional[Dict[str, str]] = None
    org_wide: bool = Field(False, alias="orgWide")
    company_ids: List[uuid.UUID] = Field(default_factory=list, alias="companyIds")
    shop_ids: List[uuid.UUID] = Field(default_factory=list, alias="shopIds")
    #: "מנהל נקודת מכירה": only these points of sale (and their devices) — the stock and block
    #: screens (app/services/stock_scope.py). Empty = whole shops.
    area_ids: List[uuid.UUID] = Field(default_factory=list, alias="areaIds")
    #: Only these tills / kiosks (the narrowest). Empty = no narrowing.
    machine_ids: List[uuid.UUID] = Field(default_factory=list, alias="machineIds")


class ProfileIn(AccessScopeIn):
    #: The organizations (tenants) the user belongs to. Absent = leave the memberships alone.
    #: The user's home organization is always kept.
    tenant_ids: Optional[List[uuid.UUID]] = Field(None, alias="tenantIds")


class TemplateIn(BaseModel):
    model_config = _WIRE

    name: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = Field(None, max_length=500)
    sections: Dict[str, str] = Field(default_factory=dict)
