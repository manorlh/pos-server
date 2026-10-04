"""
Export batches and the re-export lock (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2.6).

A batch is written in one transaction with the file it produced: the zip is stored on
the row, so "download again" hands back the very bytes the bookkeeper imported, not a
regeneration that might differ after a mapping change.

A Z in any batch is exported. Exporting it again is refused (409) unless the request
says `confirmReexport` — the batch is then flagged `isReexport`, so a double posting is
at least a visible, deliberate one.
"""
from __future__ import annotations

import hashlib
import io
import uuid
import zipfile
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.models.accounting import AccountingExportBatch, AccountingExportItem
from app.models.shop import Shop
from app.models.user import User
from app.models.z_report import ZReport
from app.services.accounting import excel, movein
from app.services.accounting.journal import (
    JournalEntry,
    JournalRefused,
    Problem,
    ZFacts,
    build_entries,
    load_z_facts,
)
from app.services.accounting.settings import effective_for

FORMATS = ("hashavshevet", "priority", "excel")


def exported_refs(db: Session, z_ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, List[AccountingExportBatch]]:
    """Per Z, the batches that carried it, oldest first."""
    if not z_ids:
        return {}
    rows = (
        db.query(AccountingExportItem.z_report_id, AccountingExportBatch)
        .join(AccountingExportBatch, AccountingExportBatch.id == AccountingExportItem.batch_id)
        .filter(AccountingExportItem.z_report_id.in_(list(z_ids)))
        .order_by(AccountingExportBatch.batch_number)
        .all()
    )
    out: Dict[uuid.UUID, List[AccountingExportBatch]] = {}
    for z_id, batch in rows:
        out.setdefault(z_id, []).append(batch)
    return out


def load_zs(db: Session, company_id: uuid.UUID, z_ids: Sequence[uuid.UUID], scoped_query) -> List[ZReport]:
    """
    The requested Zs, all of `company_id`, all visible to the caller (`scoped_query` is
    the caller's role-scoped Z query). Any id that is not is a 404 for the whole request:
    a partial export would be a silent gap in the books.
    """
    wanted = list(dict.fromkeys(z_ids))
    rows = (
        scoped_query.options(joinedload(ZReport.shop))
        .join(Shop, Shop.id == ZReport.shop_id)
        .filter(ZReport.id.in_(wanted), Shop.company_id == company_id)
        .all()
    )
    if len(rows) != len(wanted):
        found = {z.id for z in rows}
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "z_not_found",
                "message": "Some Z reports were not found in this company",
                "zReportIds": [str(i) for i in wanted if i not in found],
            },
        )
    return sorted(rows, key=lambda z: (str(z.shop_id), z.business_date, z.shop_sequence_number or 0))


def prepare(
    db: Session,
    company_id: uuid.UUID,
    zs: Sequence[ZReport],
    *,
    grouping: str,
    method: Optional[str] = None,
    consolidate: bool = False,
    company_name: str = "",
) -> Tuple[List[JournalEntry], List[Problem], Dict]:
    """
    Entries for `zs`, or the problems that stop them. Never raises for a problem.

    Each Z is booked with its own shop's settings (the company's, overridden key by key
    by the shop's); `consolidate` merges the shops into company entries (see
    `build_entries`).
    """
    settings_by_shop: Dict[Optional[uuid.UUID], Dict] = {}
    for shop_id in {z.shop_id for z in zs}:
        settings_by_shop[shop_id] = effective_for(db, company_id, shop_id)
    company_settings = effective_for(db, company_id, None)

    facts: List[ZFacts] = []
    for z in zs:
        s = settings_by_shop[z.shop_id]
        facts.append(
            load_z_facts(
                db, z,
                want_brands=bool(s.get("cardBrands") or s.get("cardAcquirers")),
                want_voucher_sales=bool(s.get("voucherSalesAsLiability")),
            )
        )
    try:
        entries = build_entries(
            facts, settings_by_shop, grouping=grouping, consolidate=consolidate,
            company_settings=company_settings, company_name=company_name,
        )
    except JournalRefused as refused:
        return [], refused.problems, company_settings

    problems: List[Problem] = []
    for account in movein.validate_accounts(entries, method or company_settings.get("method") or "flexible"):
        problems.append(Problem("account_too_long", None, None, "", account))
    return entries, problems, company_settings


def build_zip(
    entries: Sequence[JournalEntry], *, fmt: str, method: str, encoding: str
) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if fmt in ("hashavshevet", "priority"):
            zf.writestr("MOVEIN.DAT", movein.write_dat(entries, method=method, encoding=encoding))
            zf.writestr("MOVEIN.PRM", movein.write_prm(method))
        zf.writestr("journal.xlsx", excel.write_xlsx(entries))
    return buf.getvalue()


def _file_name(number: int, level: str, zs: Sequence[ZReport]) -> str:
    """accounting_batch_7.zip; a per-shop batch names its shop's code or number too."""
    if level != "shop" or not zs:
        return f"accounting_batch_{number}.zip"
    shop = zs[0].shop
    code = getattr(shop, "shop_number", None) if shop is not None else None
    tag = str(code) if code not in (None, "") else str(zs[0].shop_id)[:8]
    tag = "".join(ch for ch in tag if ch.isalnum() or ch in "-_") or "shop"
    return f"accounting_batch_{number}_shop_{tag}.zip"


def build_bundle(batches: Sequence[AccountingExportBatch]) -> bytes:
    """Several stored batch zips in one zip, each under its own file name, unchanged."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for b in batches:
            zf.writestr(b.file_name, bytes(b.file_content))
    return buf.getvalue()


def split_by_shop(zs: Sequence[ZReport]) -> List[List[ZReport]]:
    """The Zs of each shop, shops in a stable order."""
    groups: Dict[str, List[ZReport]] = {}
    for z in zs:
        groups.setdefault(str(z.shop_id), []).append(z)
    return [groups[k] for k in sorted(groups)]


def _next_batch_number(db: Session, tenant_id: uuid.UUID) -> int:
    top = (
        db.query(func.max(AccountingExportBatch.batch_number))
        .filter(AccountingExportBatch.tenant_id == tenant_id)
        .scalar()
    )
    return int(top or 0) + 1


def create_batch(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    company_id: uuid.UUID,
    zs: Sequence[ZReport],
    entries: Sequence[JournalEntry],
    fmt: str,
    method: str,
    encoding: str,
    grouping: str,
    is_reexport: bool,
    user: User,
    level: str = "company",
) -> AccountingExportBatch:
    content = build_zip(entries, fmt=fmt, method=method, encoding=encoding)
    shops = {z.shop_id for z in zs}
    lines = [l for e in entries for l in e.lines]
    for attempt in range(3):
        number = _next_batch_number(db, tenant_id)
        batch = AccountingExportBatch(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            company_id=company_id,
            shop_id=next(iter(shops)) if len(shops) == 1 else None,
            batch_number=number,
            format=fmt,
            method=method,
            encoding=encoding,
            grouping=grouping,
            level=level,
            date_from=min(z.business_date for z in zs),
            date_to=max(z.business_date for z in zs),
            z_count=len(zs),
            entry_count=len(entries),
            line_count=len(lines),
            total_debit=sum((l.amount for l in lines if l.side == "D"), Decimal("0")),
            is_reexport=is_reexport,
            file_name=_file_name(number, level, zs),
            file_content=content,
            file_sha256=hashlib.sha256(content).hexdigest(),
            created_by_user_id=user.id,
            created_at=datetime.now(timezone.utc),
        )
        batch.items = [AccountingExportItem(z_report_id=z.id) for z in zs]
        db.add(batch)
        try:
            db.flush()
            return batch
        except IntegrityError:
            # Two exports drew the same number at once; take the next.
            db.rollback()
            if attempt == 2:
                raise
    raise RuntimeError("unreachable")
