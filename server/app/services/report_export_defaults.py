"""
"ברירת מחדל לייצוא" — a company's default export columns per report (P:/specs/reports-upgrade.md
§2ב, §4.3).

The dashboard pre-ticks "עמודות לייצוא" from this; the order of precedence (this export's own
choice → the company's default → the user's visible columns → every column) is the dashboard's.

* **Read** — anyone signed in to the dashboard who sees the company (`catalog_company_ids`: their
  company, its subsidiaries and what it sits under; a shop user's shop's company). A company with
  no default for a report reads its nearest parent's (`inherited: true`), so a holding group sets
  it once.
* **Write** — a super admin, a distributor (any company of the tenant), or a company manager whose
  scope covers the company. Everyone else: 403. Every change is audited.
* An empty list removes the company's default (its parent's, if any, applies again).

Keys are the dashboard's: the server validates their shape, never their meaning.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.report_export_default import ReportExportDefault, ReportExportDefaultAudit
from app.models.shop import Shop
from app.models.user import User, UserRole

REPORT_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
COLUMN_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
MAX_COLUMNS = 100
AUDIT_LIMIT = 100

EDITOR_ROLES = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR)


def _bad(detail: str, code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def validate_report_key(key: Any) -> str:
    if not isinstance(key, str) or not REPORT_KEY_RE.match(key):
        raise _bad("reportKey must match ^[a-z0-9][a-z0-9._-]{0,63}$")
    return key


def validate_columns(columns: Any, *, field: str = "columns") -> List[str]:
    """The column keys, in order, each once. Shape only — the keys are the dashboard's."""
    if not isinstance(columns, list):
        raise _bad(f"{field} must be a list of column keys")
    if len(columns) > MAX_COLUMNS:
        raise _bad(f"{field}: at most {MAX_COLUMNS} columns")
    out: List[str] = []
    for c in columns:
        if not isinstance(c, str) or not COLUMN_KEY_RE.match(c):
            raise _bad(f"{field}: each key must match ^[A-Za-z0-9][A-Za-z0-9_.:-]{{0,63}}$")
        if c not in out:
            out.append(c)
    return out


# ── Who ──────────────────────────────────────────────────────────────────────


def resolve_company(db: Session, user: User, tenant_id, company_id: Optional[uuid.UUID]) -> Company:
    """The company asked for, or the caller's own (a shop user's: their shop's)."""
    if company_id is None:
        company_id = getattr(user, "company_id", None)
        if company_id is None and getattr(user, "shop_id", None) is not None:
            row = db.query(Shop.company_id).filter(Shop.id == user.shop_id).first()
            company_id = row[0] if row else None
    if company_id is None:
        raise _bad("companyId is required", status.HTTP_400_BAD_REQUEST)
    company = db.get(Company, company_id)
    if company is None or (tenant_id is not None and company.tenant_id is not None and str(company.tenant_id) != str(tenant_id)):
        raise _bad("Company not found", status.HTTP_404_NOT_FOUND)
    return company


def can_read(db: Session, user: User, company: Company) -> bool:
    from app.services.company_hierarchy import catalog_company_ids

    ids = catalog_company_ids(db, user)
    if ids is None:  # super admin, distributor
        return True
    return str(company.id) in {str(i) for i in ids}


def can_edit(db: Session, user: User, company: Company) -> bool:
    role = getattr(user, "role", None)
    if role in EDITOR_ROLES:
        return True
    if role == UserRole.COMPANY_MANAGER:
        from app.services.company_hierarchy import user_covers_company

        return user_covers_company(db, user, company.id)
    return False


def require_read(db: Session, user: User, company: Company) -> None:
    if not can_read(db, user, company):
        raise _bad("Access denied", status.HTTP_403_FORBIDDEN)


def require_edit(db: Session, user: User, company: Company) -> None:
    if not can_edit(db, user, company):
        raise _bad("Only the company's manager, a distributor or a super admin may set export defaults",
                   status.HTTP_403_FORBIDDEN)


# ── Out ──────────────────────────────────────────────────────────────────────


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    return (moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)).isoformat()


def _user_name(user: Optional[User]) -> Optional[str]:
    if user is None:
        return None
    parts = [getattr(user, "first_name", None) or "", getattr(user, "last_name", None) or ""]
    return " ".join(p for p in parts if p).strip() or getattr(user, "username", None) or getattr(user, "email", None)


def _row_out(db: Session, row: ReportExportDefault, *, inherited: bool) -> Dict[str, Any]:
    by = db.get(User, row.updated_by) if row.updated_by is not None else None
    return {
        "reportKey": row.report_key,
        "columns": list(row.columns or []),
        "companyId": str(row.company_id),
        "inherited": inherited,
        "updatedAt": _iso(row.updated_at),
        "updatedBy": {"id": str(by.id), "name": _user_name(by)} if by is not None else None,
    }


def list_defaults(db: Session, user: User, company: Company) -> Dict[str, Any]:
    """The company's own defaults, and its nearest parent's for every report it has none of."""
    from app.services.company_hierarchy import ancestor_company_ids

    chain = [company.id] + ancestor_company_ids(db, company.id)
    rows = db.query(ReportExportDefault).filter(ReportExportDefault.company_id.in_(chain)).all()
    rank = {str(cid): n for n, cid in enumerate(chain)}
    best: Dict[str, ReportExportDefault] = {}
    for r in rows:
        current = best.get(r.report_key)
        if current is None or rank[str(r.company_id)] < rank[str(current.company_id)]:
            best[r.report_key] = r
    return {
        "companyId": str(company.id),
        "canEdit": can_edit(db, user, company),
        "defaults": [
            _row_out(db, r, inherited=str(r.company_id) != str(company.id))
            for _, r in sorted(best.items())
        ],
    }


def set_default(db: Session, user: User, company: Company, report_key: str, columns: List[str]) -> Dict[str, Any]:
    report_key = validate_report_key(report_key)
    columns = validate_columns(columns)
    row = (
        db.query(ReportExportDefault)
        .filter(ReportExportDefault.company_id == company.id, ReportExportDefault.report_key == report_key)
        .first()
    )
    before = list(row.columns or []) if row is not None else None
    now = datetime.now(timezone.utc)
    if not columns:
        if row is not None:
            db.delete(row)
            _audit(db, user, company, report_key, "clear", before, None)
        db.commit()
        return {
            "reportKey": report_key, "companyId": str(company.id), "columns": [], "inherited": False,
            "updatedAt": None, "updatedBy": None,
        }
    if row is None:
        row = ReportExportDefault(id=uuid.uuid4(), company_id=company.id, report_key=report_key)
        db.add(row)
    if before != columns:
        _audit(db, user, company, report_key, "set", before, columns)
    row.columns = columns
    row.updated_by = getattr(user, "id", None)
    row.updated_at = now
    db.commit()
    db.refresh(row)
    return _row_out(db, row, inherited=False)


def _audit(db: Session, user: User, company: Company, report_key: str, action: str, before, after) -> None:
    db.add(ReportExportDefaultAudit(
        id=uuid.uuid4(), company_id=company.id, report_key=report_key, action=action,
        before=before, after=after, actor_user_id=getattr(user, "id", None), actor_name=_user_name(user),
        created_at=datetime.now(timezone.utc),
    ))


def audit_log(db: Session, company: Company, report_key: Optional[str] = None) -> List[Dict[str, Any]]:
    q = db.query(ReportExportDefaultAudit).filter(ReportExportDefaultAudit.company_id == company.id)
    if report_key:
        q = q.filter(ReportExportDefaultAudit.report_key == report_key)
    rows = q.order_by(ReportExportDefaultAudit.created_at.desc()).limit(AUDIT_LIMIT).all()
    return [
        {
            "reportKey": r.report_key, "action": r.action, "before": r.before, "after": r.after,
            "actorName": r.actor_name, "createdAt": _iso(r.created_at),
        }
        for r in rows
    ]
