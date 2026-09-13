"""
One table of who may do what.

The rules were previously retyped in each router: the identical `_CATALOG_ROLES` tuple
appeared in five files, `_STOCK_WRITE_ROLES` and `_IMAGE_ROLES` in others, each a separate
edit away from disagreeing with the rest. Granting shop managers a new catalog right meant
finding every copy, and missing one is invisible — the check still passes, just for the
wrong set of people.

**Scope of this table is deliberately narrow: it answers "may this role perform this kind
of action at all".** It does *not* decide which rows they may see. That is the harder half
and it stays in `scoping.py` / `company_hierarchy.py`, where it belongs, because the answer
is a SQL filter rather than a boolean. A role check that passes tells you nothing about
whether the record in hand is inside the caller's company — both are needed, and conflating
them would hide the second.

Read it as a grid: the resource down, the roles across. Adding a role means adding it to the
sets it belongs in, in one file, with one test file proving the narrow cases still refuse.
"""
from __future__ import annotations

import enum
from typing import Dict, FrozenSet, Tuple

from app.models.user import UserRole


class Resource(str, enum.Enum):
    """What is being acted on. Coarse on purpose — one entry per thing a role gate guards."""

    #: Products, categories and vouchers. One resource because they have always shared a
    #: rule, and splitting them here would invent a distinction the product does not make.
    CATALOG = "catalog"
    CUSTOMER = "customer"
    STOCK = "stock"
    #: Product images. Narrower than the catalog itself: a shop manager may price a
    #: product but has never been able to replace its photograph, which is chain artwork.
    IMAGE = "image"
    #: Chain-level look and feel — logo, colours, receipt header.
    BRANDING = "branding"
    #: Moving a company under another in the group tree.
    COMPANY_TREE = "company_tree"


class Action(str, enum.Enum):
    WRITE = "write"


#: The grid. Absent pair means nobody — a missing entry denies rather than allows, so a
#: typo in a resource name locks a door instead of opening one.
_MATRIX: Dict[Tuple[Resource, Action], FrozenSet[UserRole]] = {
    (Resource.CATALOG, Action.WRITE): frozenset({
        UserRole.SUPER_ADMIN,
        UserRole.DISTRIBUTOR,
        UserRole.COMPANY_MANAGER,
        UserRole.SHOP_MANAGER,
    }),
    (Resource.CUSTOMER, Action.WRITE): frozenset({
        UserRole.SUPER_ADMIN,
        UserRole.DISTRIBUTOR,
        UserRole.COMPANY_MANAGER,
        UserRole.SHOP_MANAGER,
    }),
    (Resource.STOCK, Action.WRITE): frozenset({
        UserRole.SUPER_ADMIN,
        UserRole.DISTRIBUTOR,
        UserRole.COMPANY_MANAGER,
        UserRole.SHOP_MANAGER,
    }),
    # No shop manager: a photograph is chain artwork, not a branch decision.
    (Resource.IMAGE, Action.WRITE): frozenset({
        UserRole.SUPER_ADMIN,
        UserRole.DISTRIBUTOR,
        UserRole.COMPANY_MANAGER,
    }),
    # Narrower still — branding is the chain's identity.
    (Resource.BRANDING, Action.WRITE): frozenset({
        UserRole.SUPER_ADMIN,
        UserRole.DISTRIBUTOR,
    }),
    # Re-parenting a company rearranges who can see whose takings, so it stays with the
    # roles that own the hierarchy rather than anyone inside it.
    (Resource.COMPANY_TREE, Action.WRITE): frozenset({
        UserRole.SUPER_ADMIN,
        UserRole.DISTRIBUTOR,
    }),
}


def roles_for(resource: Resource, action: Action) -> FrozenSet[UserRole]:
    """The roles permitted, for a caller that wants the set rather than a yes/no."""
    return _MATRIX.get((resource, action), frozenset())


def may(role: UserRole, resource: Resource, action: Action) -> bool:
    """Whether `role` may perform `action` on `resource`. Unknown pairs deny."""
    return role in _MATRIX.get((resource, action), frozenset())
