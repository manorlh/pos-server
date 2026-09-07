"""
The one place that names what a till can be elevated to do, and which roles may
do it.

Authorisation for the dashboard still lives in the routers (see the `_CATALOG_ROLES`
constants and the per-router `_check_*` helpers). This module is deliberately
narrower: it covers only the capabilities a *till* can hold, because those are new
and because the device has to be told about them. Growing it into the single matrix
for the whole system is a separate, larger job; starting it here keeps the till and
the cloud speaking one vocabulary from day one rather than two that drift.

Two things worth knowing:

**Scope strings are wire contract.** The device asks for scopes by name and the
grant response echoes them back, so a paired till that has not been updated keeps
sending the old string. Rename one and elevation silently stops working on every
till in the field. Add new names; never repurpose an old one.

**A role's scopes are a ceiling, not a grant.** `till_grantable_scopes` says what
this role *could* hold at a till. What it actually gets is intersected with what
the device asked for, and then bounded again by the machine's own shop — see
`app.services.elevation`. Three independent limits, so widening one cannot widen
the others by accident.
"""

from __future__ import annotations

import enum
from typing import FrozenSet, Iterable, List

from app.models.user import UserRole


class Scope(str, enum.Enum):
    """A named capability a till can be elevated to hold, as `resource:action`."""

    CATALOG_WRITE = "catalog:write"


#: Scopes that must be re-authorised for every single action rather than held for
#: the life of a session. Empty today: the only scope is catalog editing, where a
#: PIN per product would be exactly the friction the sliding window exists to
#: avoid. Approving a refund is the case this exists for — one action, so one PIN
#: is cheap and is what retail staff expect.
PER_ACTION_SCOPES: FrozenSet[Scope] = frozenset()


#: Which roles may be elevated to which scopes at a till.
#:
#: Mirrors the dashboard's `_CATALOG_ROLES` on purpose — a role that may edit the
#: catalog from a desk may edit it from a till. `CASHIER` is absent rather than
#: mapped to an empty set so that a new role added to `UserRole` gets nothing until
#: someone thinks about it.
_TILL_SCOPES_BY_ROLE: dict[UserRole, FrozenSet[Scope]] = {
    UserRole.SUPER_ADMIN: frozenset({Scope.CATALOG_WRITE}),
    UserRole.DISTRIBUTOR: frozenset({Scope.CATALOG_WRITE}),
    UserRole.COMPANY_MANAGER: frozenset({Scope.CATALOG_WRITE}),
    UserRole.SHOP_MANAGER: frozenset({Scope.CATALOG_WRITE}),
}


def till_grantable_scopes(role: UserRole) -> FrozenSet[Scope]:
    """Every scope `role` is permitted to hold at a till. Empty for roles with none."""
    return _TILL_SCOPES_BY_ROLE.get(role, frozenset())


def parse_scopes(raw: Iterable[str]) -> List[Scope]:
    """
    Turn requested scope strings into `Scope` values, dropping ones we do not know.

    Unknown names are ignored rather than rejected so that a *newer* till asking
    for a scope this server has not shipped yet still gets a working session for
    the scopes it does understand, instead of a hard failure during a staged
    rollout. An empty result is the caller's problem to report.
    """
    known = {scope.value: scope for scope in Scope}
    out: List[Scope] = []
    for name in raw:
        scope = known.get(str(name).strip())
        if scope is not None and scope not in out:
            out.append(scope)
    return out


def requires_per_action_reauth(scope: Scope) -> bool:
    """True when holding `scope` is not enough — each action needs its own PIN."""
    return scope in PER_ACTION_SCOPES
