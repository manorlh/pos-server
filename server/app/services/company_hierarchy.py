"""Company hierarchy: the single place that answers "which companies does this one cover?"

`companies.parent_company_id` turns the company table into a forest, so a holding group
can own several trading companies. Authorization has to follow that tree — a
`company_manager` of the group reaches the group's subsidiaries — and it has to follow it
*everywhere*, because scoping used to be flat equality in a dozen places and a single
missed site is either a leak or a manager locked out of their own shops. Every one of
those sites now calls into this module and nothing re-implements the rule.

What nesting deliberately does **not** change:

* **Fiscal attribution.** A Company is the entity holding the ח.פ. and issuing the
  documents. The Open Format export still selects `Shop.company_id == <that company>`
  and nothing else, so a group's file never absorbs a subsidiary's invoices. Only the
  *permission* to ask for a subsidiary's export widens (see `app/routers/tax_reports.py`).
* **Catalog and settings inheritance.** `Product` / `Category` `company_id` decides what a
  till sells; company `settings` decide how it behaves. Neither now flows down the
  company chain. See the note on `descendant_company_ids` below.

Design notes:

* Descendants are resolved with **one recursive CTE per (session, root)**, memoised on
  `Session.info` for the life of the request. No materialised path and no closure table:
  both need maintenance on every reparent, and a stale path here is a silent
  cross-company data leak, which is a far worse failure mode than one extra 1-row-deep
  index scan per request. Reparenting is a rare admin action; reading is hot, and the
  memo makes reading one query per request rather than one per guard.
* The traversal is **depth-capped and tenant-bounded in SQL**, so even a cycle or a
  cross-tenant edge introduced out-of-band (a manual UPDATE, a restored dump) cannot
  hang a request or widen a scope past the tenant.
* `descendant_company_ids` always contains the root, even when the row is missing. That
  guarantees no call site becomes *more* restrictive than the flat equality it replaced.
"""
from __future__ import annotations

import uuid
from typing import Dict, List, Optional, Tuple

from sqlalchemy import literal, or_, select
from sqlalchemy.orm import Query, Session, aliased

from app.models.company import Company
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services.permission_matrix import SHOP_SCOPED_ROLES

MAX_COMPANY_DEPTH = 4
"""Maximum number of parent edges above a company: a chain of at most 5 companies.

Real groups are two or three tiers (holding → sub-holding → trading company). The cap
exists so the recursive CTE has a hard bound regardless of the data, and so a
misconfigured dashboard cannot build a 200-deep chain that makes every request walk it.
Enforced on write in `app/routers/companies.py` and again as the recursion limit here.
"""

_MEMO_KEY = "company_descendant_ids"


def _as_uuid(value) -> Optional[uuid.UUID]:
    """UUID or None. Anything unparseable resolves to None and therefore to *deny*."""
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (AttributeError, TypeError, ValueError):
        return None


def _memo(db: Session) -> Optional[Dict[uuid.UUID, List[Tuple[uuid.UUID, int]]]]:
    """Per-request memo, or None when the session cannot carry one."""
    info = getattr(db, "info", None)
    if not isinstance(info, dict):
        return None
    memo = info.get(_MEMO_KEY)
    if not isinstance(memo, dict):
        memo = {}
        info[_MEMO_KEY] = memo
    return memo


def invalidate_company_hierarchy_cache(db: Session) -> None:
    """Drop the memo after a write that moves a company in the tree."""
    memo = _memo(db)
    if memo is not None:
        memo.clear()


def _descendant_rows(db: Session, company_id) -> List[Tuple[uuid.UUID, int]]:
    """`[(company_id, depth_below_root), ...]`, root first at depth 0."""
    root = _as_uuid(company_id)
    if root is None:
        return []

    memo = _memo(db)
    if memo is not None and root in memo:
        return list(memo[root])

    root_row = aliased(Company, name="hierarchy_root")
    child = aliased(Company, name="hierarchy_child")

    tree = (
        select(
            root_row.id.label("id"),
            root_row.tenant_id.label("tenant_id"),
            literal(0).label("depth"),
        )
        .where(root_row.id == root)
        .cte("company_tree", recursive=True)
    )
    tree = tree.union_all(
        select(
            child.id,
            child.tenant_id,
            (tree.c.depth + 1).label("depth"),
        ).where(
            child.parent_company_id == tree.c.id,
            # Defensive, not decorative: a self-referencing row or a cross-tenant edge
            # is rejected on write, but bad data must not hang a request or leak.
            child.id != tree.c.id,
            tree.c.depth < MAX_COMPANY_DEPTH,
            child.tenant_id.is_not_distinct_from(tree.c.tenant_id),
        )
    )

    rows: List[Tuple[uuid.UUID, int]] = []
    seen: set = set()
    for row_id, depth in db.execute(select(tree.c.id, tree.c.depth)):
        parsed = _as_uuid(row_id)
        if parsed is None or parsed in seen:
            continue
        seen.add(parsed)
        rows.append((parsed, int(depth)))

    if root not in seen:
        # Missing row (or a caller holding a dangling id): still cover the root, so this
        # can never be narrower than the equality check it replaced.
        rows.insert(0, (root, 0))

    if memo is not None:
        memo[root] = list(rows)
    return rows


def descendant_company_ids(db: Session, company_id) -> List[uuid.UUID]:
    """The company and everything under it, root first. Empty only for a null/invalid id."""
    return [cid for cid, _ in _descendant_rows(db, company_id)]


def subtree_height(db: Session, company_id) -> int:
    """Edges from this company down to its deepest descendant (0 for a leaf)."""
    rows = _descendant_rows(db, company_id)
    return max((depth for _, depth in rows), default=0)


def ancestor_company_ids(db: Session, company_id) -> List[uuid.UUID]:
    """The company's ancestors, nearest first. Excludes the company itself."""
    start = _as_uuid(company_id)
    if start is None:
        return []

    start_row = aliased(Company, name="ancestor_start")
    parent = aliased(Company, name="ancestor_parent")

    chain = (
        select(
            start_row.id.label("id"),
            start_row.parent_company_id.label("parent_company_id"),
            start_row.tenant_id.label("tenant_id"),
            literal(0).label("depth"),
        )
        .where(start_row.id == start)
        .cte("company_ancestors", recursive=True)
    )
    chain = chain.union_all(
        select(
            parent.id,
            parent.parent_company_id,
            parent.tenant_id,
            (chain.c.depth + 1).label("depth"),
        ).where(
            parent.id == chain.c.parent_company_id,
            parent.id != chain.c.id,
            chain.c.depth < MAX_COMPANY_DEPTH,
            parent.tenant_id.is_not_distinct_from(chain.c.tenant_id),
        )
    )

    out: List[uuid.UUID] = []
    seen: set = {start}
    rows = db.execute(
        select(chain.c.id, chain.c.depth).order_by(chain.c.depth)
    ).all()
    for row_id, _depth in rows:
        parsed = _as_uuid(row_id)
        if parsed is None or parsed in seen:
            continue
        seen.add(parsed)
        out.append(parsed)
    return out


def company_depth(db: Session, company_id) -> int:
    """Edges from this company up to its root (0 for a root company)."""
    return len(ancestor_company_ids(db, company_id))


# ── Role-aware entry points ──────────────────────────────────────────────────
#
# Descendant expansion is COMPANY_MANAGER-only, on purpose. A shop manager and a
# cashier are scoped to one shop; their `company_id` only exists so they can read the
# name and VAT number their receipts are printed with. Handing them a subsidiary's
# company rows would widen their reach for no use case anybody asked for.
#
# "הרשאות דשבורד" (app/services/dashboard_access.py): a company manager's profile may set
# their org scope — every company of their organizations ("מנהל ארגון"), a list of
# companies (each with its subsidiaries), and/or only some shops. It is read here, in the
# helpers every scoped read and every access check already goes through, so the narrowing
# cannot be skipped by one router. No profile scope = the role's own, exactly as before.


def _profile_scope(db: Session, user: User):
    from app.services.dashboard_access import profile_scope

    return profile_scope(db, user)


def company_scope_ids(db: Session, user: User) -> List[uuid.UUID]:
    """Company ids this user's own company-level scope covers (for `IN (...)` filters)."""
    own = getattr(user, "company_id", None)
    if getattr(user, "role", None) == UserRole.COMPANY_MANAGER:
        scope = _profile_scope(db, user)
        if scope is not None and scope.org_wide:
            from app.services.dashboard_access import org_company_ids

            return _dedupe(org_company_ids(db, user))
        if scope is not None and scope.company_ids:
            ids: List[uuid.UUID] = []
            for root in scope.company_ids:
                ids.extend(descendant_company_ids(db, root))
            return _dedupe(ids)
        return descendant_company_ids(db, own)
    parsed = _as_uuid(own)
    return [parsed] if parsed is not None else []


def catalog_company_ids(db: Session, user: User) -> Optional[List[uuid.UUID]]:
    """
    Which companies' catalog rows this user may see. `None` means "no company filter".

    Separate from `company_scope_ids` because the catalog flows in the opposite direction
    to management. A manager manages *downwards* — their company and its subsidiaries —
    but a catalog is inherited *downwards*, which means a shop reads it *upwards*: a
    product defined on the holding company is sold by every branch beneath it, so those
    branches must be able to see it.

    So a company-level user gets their subtree (what they manage) **and** their ancestors
    (what they inherit), and a shop-level user gets their own company and its ancestors.
    A sibling company's products are in neither, which is the isolation that matters.

    Callers must pair this with "or the row has no company at all": a tenant-wide global
    product belongs to everyone and is stored with a null `company_id`, so filtering on
    membership alone hides it from every merchant-side role — which is exactly the bug
    this function exists to end.
    """
    role = getattr(user, "role", None)
    if role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return None

    if role == UserRole.COMPANY_MANAGER:
        scope = _profile_scope(db, user)
        if scope is not None and (scope.org_wide or scope.company_ids):
            # Each company of the scope, its subsidiaries and what it inherits from above.
            out: List[uuid.UUID] = []
            for cid in company_scope_ids(db, user):
                out.append(cid)
                out.extend(ancestor_company_ids(db, cid))
            return _dedupe(out)
        own = getattr(user, "company_id", None)
        return _dedupe(descendant_company_ids(db, own) + ancestor_company_ids(db, own))

    if role in SHOP_SCOPED_ROLES:
        # A shop user has no company of their own; theirs is the one their shop sits in.
        shop_id = getattr(user, "shop_id", None)
        if shop_id is None:
            return []
        row = db.query(Shop.company_id).filter(Shop.id == shop_id).first()
        company_id = row[0] if row else None
        if company_id is None:
            return []
        return _dedupe([company_id] + ancestor_company_ids(db, company_id))

    return []


def _dedupe(ids: List[uuid.UUID]) -> List[uuid.UUID]:
    """Order-preserving, so a caller's `IN (...)` is stable between requests."""
    seen, out = set(), []
    for i in ids:
        if i is not None and str(i) not in seen:
            seen.add(str(i))
            out.append(i)
    return out


def catalog_visibility_filter(db: Session, user: User, model):
    """
    The SQL predicate for "catalog rows this user may see", or None for no restriction.

    Lives here rather than in each router because the `NULL company` half is the whole
    bug: filtering on membership alone hides every tenant-wide global row, and that half
    was invisible to tests while the routers each wrote their own `or_`. One function,
    one place to test, and products and categories cannot drift — a product visible under
    a category that is not would render grouped beneath nothing.

    `model` is `Product` or `Category`; both carry `company_id` with the same meaning.
    """
    ids = catalog_company_ids(db, user)
    if ids is None:
        return None
    if not ids:
        # Nothing of their own, so globals only. Not "everything" — that distinction is
        # the difference between an empty catalog and a tenant-wide leak.
        return model.company_id.is_(None)
    return or_(model.company_id.is_(None), model.company_id.in_(ids))


def user_covers_company(db: Session, user: User, company_id) -> bool:
    """Does this user's company scope reach `company_id`?"""
    own = getattr(user, "company_id", None)
    scope = _profile_scope(db, user)
    if scope is None and own is not None and company_id is not None and str(own) == str(company_id):
        return True  # fast path: the common case never touches the database
    if getattr(user, "role", None) != UserRole.COMPANY_MANAGER:
        return False
    target = _as_uuid(company_id)
    if target is None:
        return False
    if scope is not None:
        return target in set(company_scope_ids(db, user))
    return target in set(descendant_company_ids(db, own))


def user_covers_shop(db: Session, user: User, shop) -> bool:
    """
    Does a company-level manager's scope reach this shop (a `Shop`, or anything with
    `id` and `company_id`)? Their company scope must cover its company and, when their
    profile lists shops, it must be one of them. The shop-level roles' own rule
    (`shop.id == user.shop_id`) stays at the call sites.
    """
    if shop is None:
        return False
    if not user_covers_company(db, user, getattr(shop, "company_id", None)):
        return False
    from app.services.dashboard_access import shop_allowed

    return shop_allowed(db, user, getattr(shop, "id", None))


def user_may_use_machine(db: Session, user: User, machine) -> bool:
    """
    Is this user in charge of the shop `machine` stands in?

    One definition, two callers: the dashboard's machine RBAC check and the till's
    elevation grant. They must never diverge — a person who cannot touch a machine
    from a desk must not be able to elevate at it by walking up to it.
    """
    role = getattr(user, "role", None)
    if role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    shop = getattr(machine, "shop", None)
    if role == UserRole.COMPANY_MANAGER and shop is not None:
        return user_covers_shop(db, user, shop)
    if role in SHOP_SCOPED_ROLES:
        own_shop = getattr(user, "shop_id", None)
        machine_shop = getattr(machine, "shop_id", None)
        return (
            own_shop is not None
            and machine_shop is not None
            and str(own_shop) == str(machine_shop)
        )
    return False


def visible_shop_ids(db: Session, user: User) -> Query:
    """`Shop.id` query for every shop under this user's company scope.

    Returned as a query, not a list, so callers keep the existing
    `filter(X.shop_id.in_(shop_ids))` shape and Postgres sees one statement.
    """
    query = db.query(Shop.id).filter(Shop.company_id.in_(company_scope_ids(db, user)))
    scope = _profile_scope(db, user)
    if scope is not None and scope.shop_ids:
        query = query.filter(Shop.id.in_(list(scope.shop_ids)))
    return query
