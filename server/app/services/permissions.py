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

from app.models.pos_user import PosUserRole
from app.models.user import UserRole


class Scope(str, enum.Enum):
    """A named capability a till can be elevated to hold, as `resource:action`."""

    CATALOG_WRITE = "catalog:write"
    #: Give money back. The reason `PER_ACTION_SCOPES` exists.
    REFUND = "refund"
    #: Take money off a sale — a basket discount or a line discount.
    DISCOUNT = "discount"
    #: Legacy: end the trading day and print the Z. Kept so a grant naming it still
    #: parses; nothing checks it any more (the Z is built in the cloud).
    DAY_CLOSE = "day:close"
    #: Close a shift and print its X. A cashier may do this alone; the scope exists so
    #: a shop that wants a second person can have one, and the approver is recorded.
    SHIFT_CLOSE = "shift:close"
    #: Transmit the terminal's card batch to Shva now ("שדר עסקאות עכשיו",
    #: docs/SHIFTS_API.md §4). Same people as a remote transmit from the dashboard, plus
    #: the shift supervisor, who may close a shift and so the day's card batch.
    TRANSMIT = "transmit"
    #: Cancel an open table's order ("ביטול שולחן", app/services/tables.py): the goods
    #: were ordered and are written off, with a reason, against the approver's name.
    TABLE_CANCEL = "table:cancel"
    #: Release another till's lock on a table by force (a till that went down inside it).
    TABLE_UNLOCK = "table:unlock"
    #: Release an employee signed in at another till, so they can sign in here
    #: ("עובד מחובר בקופה אחת בלבד", docs/SPEC_EXCLUSIVE_LOGIN.md).
    USER_SESSION_RELEASE = "user-session:release"


#: Scopes that must be re-authorised for every single action rather than held for
#: the life of a session.
#:
#: Catalog editing is deliberately *not* here: a PIN per product would be exactly the
#: friction the sliding window exists to avoid. The three that are here each hand money
#: back or end a day, and a session-length grant would let one PIN cover an afternoon of
#: them — a supervisor walks away and the till keeps their authority. One action, one
#: PIN, one name against it, which is also what retail staff already expect.
PER_ACTION_SCOPES: FrozenSet[Scope] = frozenset({
    Scope.REFUND,
    Scope.DISCOUNT,
    Scope.DAY_CLOSE,
    Scope.SHIFT_CLOSE,
    Scope.TRANSMIT,
    Scope.TABLE_CANCEL,
    Scope.TABLE_UNLOCK,
    Scope.USER_SESSION_RELEASE,
})


#: Which roles may be elevated to which scopes at a till.
#:
#: Mirrors the dashboard's `_CATALOG_ROLES` on purpose — a role that may edit the
#: catalog from a desk may edit it from a till. `CASHIER` is absent rather than
#: mapped to an empty set so that a new role added to `UserRole` gets nothing until
#: someone thinks about it.
_MANAGER_SCOPES = frozenset({
    Scope.CATALOG_WRITE,
    Scope.REFUND,
    Scope.DISCOUNT,
    Scope.DAY_CLOSE,
    Scope.SHIFT_CLOSE,
    Scope.TRANSMIT,
    Scope.TABLE_CANCEL,
    Scope.TABLE_UNLOCK,
    Scope.USER_SESSION_RELEASE,
})

#: What a shift supervisor (אחמ"ש) may authorise: the money decisions and the close of
#: the day, and nothing that reshapes the catalog. That line is the role — a supervisor
#: covers the floor, a manager decides what the shop sells.
_SUPERVISOR_SCOPES = frozenset({
    Scope.REFUND,
    Scope.DISCOUNT,
    Scope.DAY_CLOSE,
    Scope.SHIFT_CLOSE,
    Scope.TRANSMIT,
    Scope.TABLE_CANCEL,
    Scope.TABLE_UNLOCK,
    Scope.USER_SESSION_RELEASE,
})

_TILL_SCOPES_BY_ROLE: dict[UserRole, FrozenSet[Scope]] = {
    UserRole.SUPER_ADMIN: _MANAGER_SCOPES,
    UserRole.DISTRIBUTOR: _MANAGER_SCOPES,
    UserRole.COMPANY_MANAGER: _MANAGER_SCOPES,
    UserRole.SHOP_MANAGER: _MANAGER_SCOPES,
    UserRole.SHIFT_SUPERVISOR: _SUPERVISOR_SCOPES,
}


def till_grantable_scopes(role: UserRole) -> FrozenSet[Scope]:
    """Every scope `role` is permitted to hold at a till. Empty for roles with none."""
    return _TILL_SCOPES_BY_ROLE.get(role, frozenset())


#: What a *till user* may do on their own signature, or authorise for someone else.
#:
#: The till decides the same question locally in `TillAuthority` (Android), which is
#: what lets a shop manager refund with no prompt at all; this is the cloud's copy of
#: that table, consulted when a till user's authority reaches the server — a username
#: typed at the approval prompt, or a catalog write sent with no grant. The two must
#: agree, and they are kept one-to-one on purpose: the bug this replaces was the till
#: recognising `"admin"` and `"manager"`, strings `PosUserRole` has never contained,
#: so every shop manager in the field was treated as a cashier.
#:
#: A shop manager gets the full manager set, catalog included. A till user belongs to
#: exactly one shop and every catalog write from a till is already bounded to that shop
#: by the endpoint itself (the override table for price and listing, a 403 on any
#: master another shop also lists), so the grant was never what contained the damage.
#:
#: `CASHIER` is absent rather than mapped to an empty set, matching
#: `_TILL_SCOPES_BY_ROLE`: a role added to `PosUserRole` gets nothing until somebody
#: decides what it should get.
_POS_USER_SCOPES_BY_ROLE: dict[PosUserRole, FrozenSet[Scope]] = {
    PosUserRole.SHOP_MANAGER: _MANAGER_SCOPES,
}


def pos_user_till_scopes(role) -> FrozenSet[Scope]:
    """
    Every scope a till user with `role` may hold. Empty for roles with none.

    Accepts the enum or its wire string, because the value arrives both ways — from the
    ORM as `PosUserRole` and, in tests and older rows, as a bare string. An unrecognised
    string gets nothing, which is the direction to fail in.
    """
    if not isinstance(role, PosUserRole):
        try:
            role = PosUserRole(str(role).strip().lower())
        except ValueError:
            return frozenset()
    return _POS_USER_SCOPES_BY_ROLE.get(role, frozenset())


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
