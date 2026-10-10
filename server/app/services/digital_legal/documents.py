"""
The legal pages' life cycle: one draft per (company or shop, kind, language) → "נבדק" → published
(numbered, immutable) → archived when the next version is published.

Inheritance: a shop shows its own published version of a kind, else its company's, else the nearest
ancestor company's. A draft never shows publicly (nor through inheritance).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.digital_legal import (
    COMPANY_SCOPE,
    DRAFT_VERSION,
    LEGAL_KINDS,
    STATUS_ARCHIVED,
    STATUS_DRAFT,
    STATUS_PUBLISHED,
    LegalDocument,
)
from app.models.shop import Shop
from app.services.company_hierarchy import ancestor_company_ids
from app.services.digital_legal import templates as T

STARTS = ("template", "published", "inherited")


class LegalError(Exception):
    """A refusal with a code (the router turns it into the structured API error)."""

    def __init__(self, code: str, status: int = 400, **extra: Any):
        super().__init__(code)
        self.code = code
        self.status = status
        self.extra = extra


def scope_key(shop_id: Any) -> str:
    return str(shop_id) if shop_id else COMPANY_SCOPE


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    value = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _check_kind_lang(kind: str, lang: str) -> None:
    if kind not in LEGAL_KINDS:
        raise LegalError("kind_invalid", 422)
    if lang not in T.LANGS:
        raise LegalError("lang_unsupported", 422)


def _rows(db: Session, company_id: Any, shop_id: Any, kind: str, lang: str):
    return db.query(LegalDocument).filter(
        LegalDocument.company_id == company_id,
        LegalDocument.scope_key == scope_key(shop_id),
        LegalDocument.kind == kind,
        LegalDocument.lang == lang,
    )


def draft_of(db: Session, company_id: Any, shop_id: Any, kind: str, lang: str = "he") -> Optional[LegalDocument]:
    return _rows(db, company_id, shop_id, kind, lang).filter(LegalDocument.status == STATUS_DRAFT).first()


def published_of(db: Session, company_id: Any, shop_id: Any, kind: str, lang: str = "he") -> Optional[LegalDocument]:
    return _rows(db, company_id, shop_id, kind, lang).filter(LegalDocument.status == STATUS_PUBLISHED).first()


def effective(db: Session, *, company_id: Any, shop_id: Any = None, kind: str, lang: str = "he") -> Tuple[Optional[LegalDocument], Optional[str]]:
    """The published version a page shows: the shop's own, its company's, else an ancestor's."""
    if shop_id:
        own = published_of(db, company_id, shop_id, kind, lang)
        if own is not None:
            return own, "shop"
    doc = published_of(db, company_id, None, kind, lang)
    if doc is not None:
        return doc, "company"
    for ancestor in ancestor_company_ids(db, company_id):
        doc = published_of(db, ancestor, None, kind, lang)
        if doc is not None:
            return doc, "parent_company"
    return None, None


def published_kinds(db: Session, *, company_id: Any, shop_id: Any = None, lang: str = "he") -> Dict[str, LegalDocument]:
    out: Dict[str, LegalDocument] = {}
    for kind in LEGAL_KINDS:
        doc, _ = effective(db, company_id=company_id, shop_id=shop_id, kind=kind, lang=lang)
        if doc is not None:
            out[kind] = doc
    return out


def serialize(doc: Optional[LegalDocument], *, with_body: bool = True) -> Optional[Dict[str, Any]]:
    if doc is None:
        return None
    out: Dict[str, Any] = {
        "id": str(doc.id),
        "kind": doc.kind,
        "lang": doc.lang,
        "shopId": str(doc.shop_id) if doc.shop_id else None,
        "companyId": str(doc.company_id),
        "version": doc.version or None,
        "status": doc.status,
        "title": doc.title,
        "editSeq": doc.edit_seq,
        "reviewed": bool(doc.reviewed),
        "reviewedAt": _iso(doc.reviewed_at),
        "reviewNote": doc.review_note,
        "publishedAt": _iso(doc.published_at),
        "templateKey": doc.template_key,
        "templateVersion": doc.template_version,
        "createdAt": _iso(doc.created_at),
        "updatedAt": _iso(doc.updated_at),
    }
    if with_body:
        out["body"] = doc.body
        out["fields"] = dict(doc.fields or {})
    return out


def overview(db: Session, *, company: Company, shop: Optional[Shop], lang: str = "he") -> Dict[str, Any]:
    """The dashboard's page: per kind the draft, the published version, its history and what applies."""
    shop_id = shop.id if shop is not None else None
    kinds: Dict[str, Any] = {}
    for kind in LEGAL_KINDS:
        rows = (
            _rows(db, company.id, shop_id, kind, lang)
            .filter(LegalDocument.status != STATUS_DRAFT)
            .order_by(LegalDocument.version.desc())
            .all()
        )
        draft = draft_of(db, company.id, shop_id, kind, lang)
        eff, source = effective(db, company_id=company.id, shop_id=shop_id, kind=kind, lang=lang)
        draft_out = serialize(draft)
        if draft is not None:
            draft_out["problems"] = T.problems(kind, draft.title, draft.body, draft.fields)
            draft_out["preview"] = T.render(kind, draft.body, draft.fields, preview=True)
        kinds[kind] = {
            "draft": draft_out,
            "published": serialize(next((r for r in rows if r.status == STATUS_PUBLISHED), None)),
            "history": [serialize(r, with_body=False) for r in rows],
            "effective": serialize(eff, with_body=False),
            "effectiveSource": source,
        }
    return {
        "companyId": str(company.id),
        "companyName": company.name,
        "shopId": str(shop_id) if shop_id else None,
        "shopName": shop.name if shop is not None else None,
        "lang": lang,
        "kinds": kinds,
        "draftBanner": T.DRAFT_BANNER,
        "disclaimer": T.DISCLAIMER,
    }


def create_draft(
    db: Session,
    *,
    company: Company,
    shop: Optional[Shop],
    kind: str,
    lang: str = "he",
    start: str = "template",
    user_id: Any = None,
    today: Optional[date] = None,
) -> Tuple[LegalDocument, bool]:
    """
    The draft of this scope and kind — the existing one, or a new one started from the template, from
    this scope's published version, or (a shop) from the version it inherits now. Returns (draft, created).
    """
    _check_kind_lang(kind, lang)
    if start not in STARTS:
        raise LegalError("start_invalid", 422)
    shop_id = shop.id if shop is not None else None
    existing = draft_of(db, company.id, shop_id, kind, lang)
    if existing is not None:
        return existing, False
    spec = T.kind_def(kind)
    source: Optional[LegalDocument] = None
    if start == "published":
        source = published_of(db, company.id, shop_id, kind, lang)
    elif start == "inherited":
        source, _ = effective(db, company_id=company.id, shop_id=shop_id, kind=kind, lang=lang)
    if start != "template" and source is None:
        raise LegalError("nothing_to_copy", 409)
    if source is not None:
        title, body, fields = source.title, source.body, dict(source.fields or {})
        template_key, template_version = source.template_key, source.template_version
        if shop is not None and source.shop_id is None:
            # A shop's copy of the company's text keeps the shop's own address where the company has none.
            fields.setdefault("business.address", T.prefill(kind, company=company, shop=shop).get("business.address", ""))
    else:
        title, body = spec.title, spec.body
        fields = T.prefill(kind, company=company, shop=shop, today=today)
        template_key, template_version = kind, T.TEMPLATE_VERSION
    doc = LegalDocument(
        id=uuid.uuid4(),
        tenant_id=company.tenant_id,
        company_id=company.id,
        shop_id=shop_id,
        scope_key=scope_key(shop_id),
        kind=kind,
        lang=lang,
        version=DRAFT_VERSION,
        status=STATUS_DRAFT,
        title=title,
        body=body,
        fields={k: v for k, v in fields.items() if v is not None},
        template_key=template_key,
        template_version=template_version,
        edit_seq=0,
        reviewed=False,
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(doc)
    db.flush()
    return doc, True


def _require_draft(doc: Optional[LegalDocument]) -> LegalDocument:
    if doc is None:
        raise LegalError("not_found", 404)
    if doc.status != STATUS_DRAFT:
        raise LegalError("not_a_draft", 409)
    return doc


def _check_seq(doc: LegalDocument, edit_seq: Any) -> None:
    if edit_seq is None or int(edit_seq) != int(doc.edit_seq or 0):
        raise LegalError("edit_conflict", 409, currentEditSeq=doc.edit_seq)


def update_draft(
    db: Session,
    doc: Optional[LegalDocument],
    *,
    title: Optional[str] = None,
    body: Optional[str] = None,
    fields: Any = None,
    edit_seq: Any,
    user_id: Any = None,
) -> LegalDocument:
    """Save the draft. Any change clears "נבדק" — what was reviewed is no longer what would be published."""
    doc = _require_draft(doc)
    _check_seq(doc, edit_seq)
    if title is not None:
        title = title.strip()
        if len(title) > T.MAX_TITLE:
            raise LegalError("title_too_long", 422)
        doc.title = title
    if body is not None:
        if len(body) > T.MAX_BODY:
            raise LegalError("body_too_long", 422)
        doc.body = body.replace("\r\n", "\n")
    if fields is not None:
        if not isinstance(fields, dict):
            raise LegalError("fields_invalid", 422)
        doc.fields = T.clean_fields(doc.kind, fields)
    doc.reviewed = False
    doc.reviewed_by = None
    doc.reviewed_at = None
    doc.edit_seq = int(doc.edit_seq or 0) + 1
    doc.updated_by = user_id
    doc.updated_at = _now()
    db.flush()
    return doc


def publish(
    db: Session,
    doc: Optional[LegalDocument],
    *,
    confirm_reviewed: bool,
    edit_seq: Any,
    review_note: Optional[str] = None,
    user_id: Any = None,
    now: Optional[datetime] = None,
) -> LegalDocument:
    """
    Publish the draft: it must pass every check and the business must confirm "נבדק" (reviewed, by
    its lawyer). It gets the next number; the previously published version is archived.
    """
    doc = _require_draft(doc)
    _check_seq(doc, edit_seq)
    found = T.problems(doc.kind, doc.title, doc.body, doc.fields)
    if found:
        raise LegalError("publish_invalid", 422, problems=found)
    if confirm_reviewed is not True:
        raise LegalError("review_required", 422)
    now = now or _now()
    current = published_of(db, doc.company_id, doc.shop_id, doc.kind, doc.lang)
    if current is not None:
        current.status = STATUS_ARCHIVED
    top = (
        db.query(func.max(LegalDocument.version))
        .filter(
            LegalDocument.company_id == doc.company_id,
            LegalDocument.scope_key == doc.scope_key,
            LegalDocument.kind == doc.kind,
            LegalDocument.lang == doc.lang,
        )
        .scalar()
    )
    db.flush()
    doc.version = int(top or 0) + 1
    doc.status = STATUS_PUBLISHED
    doc.reviewed = True
    doc.reviewed_by = user_id
    doc.reviewed_at = now
    doc.review_note = (review_note or "").strip()[:300] or None
    doc.published_by = user_id
    doc.published_at = now
    doc.fields = T.clean_fields(doc.kind, doc.fields)
    db.flush()
    return doc


def discard_draft(db: Session, doc: Optional[LegalDocument]) -> None:
    """Throw a draft away (a published version is never deleted)."""
    doc = _require_draft(doc)
    db.delete(doc)
    db.flush()


def public_page(db: Session, *, company: Company, shop_id: Any, kind: str, lang: str = "he") -> Optional[Dict[str, Any]]:
    """What the public page shows: the effective published version, rendered. None = not published."""
    doc, source = effective(db, company_id=company.id, shop_id=shop_id, kind=kind, lang=lang)
    if doc is None:
        return None
    return {
        "kind": kind,
        "slug": T.kind_def(kind).slug,
        "lang": doc.lang,
        "title": doc.title,
        "body": T.render(kind, doc.body, doc.fields),
        "version": doc.version,
        "publishedAt": _iso(doc.published_at),
        "source": source,
        "businessName": company.name,
    }
