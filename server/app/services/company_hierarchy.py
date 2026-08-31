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

from sqlalchemy import literal, select
from sqlalchemy.orm import Query, Session, aliased

from app.models.company import Company
from app.models.shop import Shop
from app.models.user import User, UserRole

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


def company_scope_ids(db: Session, user: User) -> List[uuid.UUID]:
    """Company ids this user's own company-level scope covers (for `IN (...)` filters)."""
    own = getattr(user, "company_id", None)
    if getattr(user, "role", None) == UserRole.COMPANY_MANAGER:
        return descendant_company_ids(db, own)
    parsed = _as_uuid(own)
    return [parsed] if parsed is not None else []


def user_covers_company(db: Session, user: User, company_id) -> bool:
    """Does this user's company scope reach `company_id`?"""
    own = getattr(user, "company_id", None)
    if own is not None and company_id is not None and str(own) == str(company_id):
        return True  # fast path: the common case never touches the database
    if getattr(user, "role", None) != UserRole.COMPANY_MANAGER:
        return False
    target = _as_uuid(company_id)
    if target is None:
        return False
    return target in set(descendant_company_ids(db, own))


def visible_shop_ids(db: Session, user: User) -> Query:
    """`Shop.id` query for every shop under this user's company scope.

    Returned as a query, not a list, so callers keep the existing
    `filter(X.shop_id.in_(shop_ids))` shape and Postgres sees one statement.
    """
    return db.query(Shop.id).filter(Shop.company_id.in_(company_scope_ids(db, user)))
