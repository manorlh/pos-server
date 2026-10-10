"""
"כרטיסי ביקור דיגיטליים" — app/services/business_cards.py.

Dashboard (section `business_cards`: GET = view, the rest = edit; plus the card target's org scope):

GET    /business-cards                         ?companyId&shopId&areaId&type&status&template&q&includeArchived
POST   /business-cards                         {type, companyId, shopId?, areaId?, name, template, parentCardId?, ownerUserId?, slug?, languages?}
GET    /business-cards/slug-available          ?slug=
POST   /business-cards/media                   multipart image (png/jpeg/webp) or PDF → {url, kind, bytes}
GET    /business-cards/enquiries               ?cardId&status&q      the inbox
PATCH  /business-cards/enquiries/{id}          {status: new|handled|archived}
GET    /business-cards/{id}                    the card, its draft and the preview's context
PATCH  /business-cards/{id}                    {name?, parentCardId?, ownerUserId?}
PUT    /business-cards/{id}/draft              {draft, expectedVersion}         409 draft_conflict
POST   /business-cards/{id}/save               {expectedVersion, note?}         a saved revision
GET    /business-cards/{id}/publish-review     errors / warnings, changes, inheriting cards
POST   /business-cards/{id}/publish            {expectedVersion, note?}         422 publish_blocked
POST   /business-cards/{id}/pause | resume | archive | restore
POST   /business-cards/{id}/duplicate          {name?}
PUT    /business-cards/{id}/slug               {slug}                           the old path redirects
GET    /business-cards/{id}/revisions
POST   /business-cards/{id}/revisions/{rev}/publish     rollback
POST   /business-cards/{id}/revisions/{rev}/restore     {expectedVersion} → into the draft
GET    /business-cards/{id}/stats              ?days=30
GET    /business-cards/{id}/audit
POST   /business-cards/{id}/preview-vcard      {draft, lang}  the VCF the draft would give (simulation)

Public (no sign-in; `/c/<slug>` on the dashboard renders these):

GET    /public/cards/{slug}                    ?lang=  {kind: card|redirect|paused|missing, …}
GET    /public/cards/{slug}/vcard              ?lang=  text/vcard (public fields only)
POST   /public/cards/{slug}/events             {type: view|action|share|copy_link, action?}   204
POST   /public/cards/{slug}/enquiries          the enquiry form → 201 saved | 200 duplicate
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, File, Query, Request, Response, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.middleware.rate_limit import check_rate_limit_by_key
from app.models.user import User
from app.services import business_card_resolve as R
from app.services import business_cards as svc

router = APIRouter(prefix="/business-cards", tags=["business-cards"])
public_router = APIRouter(tags=["business-cards-public"])

logger = logging.getLogger(__name__)

MEDIA_MAX_BYTES = 10 * 1024 * 1024
PDF_TYPES = ("application/pdf",)

_BOTS = ("bot", "crawler", "spider", "slurp", "facebookexternalhit", "whatsapp", "preview", "headless", "lighthouse")


# ── Dashboard ─────────────────────────────────────────────────────────────────


@router.get("")
def list_cards(
    company_id: Optional[str] = Query(None, alias="companyId"),
    shop_id: Optional[str] = Query(None, alias="shopId"),
    area_id: Optional[str] = Query(None, alias="areaId"),
    card_type: Optional[str] = Query(None, alias="type"),
    status_filter: Optional[str] = Query(None, alias="status"),
    template: Optional[str] = Query(None),
    q: Optional[str] = Query(None, max_length=100),
    include_archived: bool = Query(False, alias="includeArchived"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return svc.list_cards(
        db, current_user, active_tenant_id, company_id=company_id, shop_id=shop_id, area_id=area_id,
        card_type=card_type, status_filter=status_filter, template=template, q=q, include_archived=include_archived,
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_card(
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    card = svc.create_card(db, current_user, active_tenant_id, body)
    db.commit()
    return svc.card_detail(db, card)


@router.get("/slug-available")
def slug_available(
    slug: str = Query(..., max_length=80),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    svc.require_role(current_user)
    valid = R.is_valid_slug(slug)
    return {"slug": slug, "valid": valid, "available": valid and svc._slug_free(db, slug)}


@router.post("/media", status_code=status.HTTP_201_CREATED)
async def upload_card_media(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id: uuid.UUID = Depends(get_active_tenant_id),
):
    """
    A card image (PNG / JPEG / WebP: logo, cover, portrait) or a public file (PDF), up to 10 MB —
    stored the way the kiosk designer's media are (Cloudinary when configured, else the server's
    media store), under the tenant's `cards` folder.
    """
    import cloudinary.uploader

    from app.services import cloudinary_service, local_media
    from app.services.image_validation import ALLOWED_BRANDING_CONTENT_TYPES, read_image_dimensions

    svc.require_role(current_user)
    ctype = (file.content_type or "").lower()
    is_pdf = ctype in PDF_TYPES
    if not is_pdf and ctype not in ALLOWED_BRANDING_CONTENT_TYPES:
        raise svc.error("media_type", status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "אפשר להעלות תמונה (PNG, JPEG, WebP) או קובץ PDF.")
    contents = await file.read()
    if not contents:
        raise svc.error("media_empty", status.HTTP_400_BAD_REQUEST, "הקובץ ריק.")
    if len(contents) > MEDIA_MAX_BYTES:
        raise svc.error("media_too_large", status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "הקובץ גדול מ-10MB.")
    if is_pdf and not contents.startswith(b"%PDF-"):
        raise svc.error("media_type", status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "הקובץ אינו PDF.")
    if not is_pdf and read_image_dimensions(contents) is None:
        raise svc.error("media_type", status.HTTP_400_BAD_REQUEST, "התמונה אינה קריאה.")
    folder = cloudinary_service.upload_folder(active_tenant_id, "cards")
    size = len(contents)
    try:
        if cloudinary_service.cloudinary_configured():
            cloudinary_service.configure_cloudinary()
            result = await run_in_threadpool(
                cloudinary.uploader.upload, contents, folder=folder, resource_type="raw" if is_pdf else "image",
                overwrite=False, unique_filename=True, use_filename=False,
            )
            url = result["secure_url"]
            size = int(result.get("bytes") or size)
        elif is_pdf:
            url = await run_in_threadpool(local_media.store_raw, contents, folder, "pdf")
        else:
            result = await run_in_threadpool(local_media.store, contents, folder, limit=(1920, 1920))
            url, size = result["secure_url"], int(result.get("bytes") or size)
    except Exception as exc:  # noqa: BLE001 - the storage's own errors are not the caller's
        logger.error("Business card media upload failed: %s", exc)
        raise svc.error("media_failed", status.HTTP_502_BAD_GATEWAY, "ההעלאה נכשלה.") from exc
    return {"url": url, "kind": "pdf" if is_pdf else "image", "bytes": size}


@router.get("/enquiries")
def list_enquiries(
    card_id: Optional[str] = Query(None, alias="cardId"),
    status_filter: Optional[str] = Query(None, alias="status"),
    q: Optional[str] = Query(None, max_length=100),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return svc.list_enquiries(db, current_user, active_tenant_id, card_id=card_id, status_filter=status_filter, q=q)


@router.patch("/enquiries/{enquiry_id}")
def update_enquiry(
    enquiry_id: str,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    e = svc.update_enquiry(db, current_user, active_tenant_id, enquiry_id, body)
    db.commit()
    return svc.enquiry_out(e)


@router.get("/{card_id}")
def get_card(
    card_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return svc.card_detail(db, svc.card_checked(db, current_user, active_tenant_id, card_id))


@router.patch("/{card_id}")
def update_card(
    card_id: str,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    card = svc.card_checked(db, current_user, active_tenant_id, card_id)
    svc.update_meta(db, current_user, card, body)
    db.commit()
    return svc.card_detail(db, card)


@router.put("/{card_id}/draft")
def put_draft(
    card_id: str,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    card = svc.card_checked(db, current_user, active_tenant_id, card_id)
    svc.update_draft(db, current_user, card, body)
    db.commit()
    return {"draftVersion": card.draft_version, "draftUpdatedAt": svc._iso(card.draft_updated_at), "draft": card.draft,
            "card": svc.card_out(db, card)}


@router.post("/{card_id}/save")
def save_card(
    card_id: str,
    body: Dict[str, Any] = Body(default={}),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    card = svc.card_checked(db, current_user, active_tenant_id, card_id)
    rev = svc.save_revision(db, current_user, card, body)
    db.commit()
    return {"revision": {"id": str(rev.id), "number": rev.number, "kind": rev.kind}, "card": svc.card_out(db, card)}


@router.get("/{card_id}/publish-review")
def publish_review(
    card_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    card = svc.card_checked(db, current_user, active_tenant_id, card_id)
    return svc.publish_review(db, card)


@router.post("/{card_id}/publish")
def publish_card(
    card_id: str,
    body: Dict[str, Any] = Body(default={}),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    card = svc.card_checked(db, current_user, active_tenant_id, card_id)
    rev = svc.publish(db, current_user, card, body)
    db.commit()
    return {"revision": {"id": str(rev.id), "number": rev.number, "kind": rev.kind}, "card": svc.card_out(db, card)}


def _state(action: str):
    def handler(
        card_id: str,
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        card = svc.card_checked(db, current_user, active_tenant_id, card_id)
        svc.set_state(db, current_user, card, action)
        db.commit()
        return svc.card_out(db, card)

    handler.__name__ = f"{action}_card"
    return handler


for _action in ("pause", "resume", "archive", "restore"):
    router.add_api_route(f"/{{card_id}}/{_action}", _state(_action), methods=["POST"], name=f"{_action}_card")


@router.post("/{card_id}/duplicate", status_code=status.HTTP_201_CREATED)
def duplicate_card(
    card_id: str,
    body: Dict[str, Any] = Body(default={}),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    card = svc.card_checked(db, current_user, active_tenant_id, card_id)
    copy = svc.duplicate(db, current_user, card, body)
    db.commit()
    return svc.card_out(db, copy)


@router.put("/{card_id}/slug")
def rename_slug(
    card_id: str,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    card = svc.card_checked(db, current_user, active_tenant_id, card_id)
    svc.rename_slug(db, current_user, card, body.get("slug"))
    db.commit()
    return {"card": svc.card_out(db, card), "slugs": svc.slugs_of(db, card)}


@router.get("/{card_id}/revisions")
def list_revisions(
    card_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return svc.revisions_out(db, svc.card_checked(db, current_user, active_tenant_id, card_id))


@router.post("/{card_id}/revisions/{revision_id}/publish")
def publish_revision(
    card_id: str,
    revision_id: str,
    body: Dict[str, Any] = Body(default={}),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    card = svc.card_checked(db, current_user, active_tenant_id, card_id)
    rev = svc.publish_revision(db, current_user, card, svc.revision_checked(db, card, revision_id), body.get("note"))
    db.commit()
    return {"revision": {"id": str(rev.id), "number": rev.number, "kind": rev.kind}, "card": svc.card_out(db, card)}


@router.post("/{card_id}/revisions/{revision_id}/restore")
def restore_revision(
    card_id: str,
    revision_id: str,
    body: Dict[str, Any] = Body(default={}),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    card = svc.card_checked(db, current_user, active_tenant_id, card_id)
    svc.restore_revision_to_draft(db, current_user, card, svc.revision_checked(db, card, revision_id), body.get("expectedVersion"))
    db.commit()
    return svc.card_detail(db, card)


@router.get("/{card_id}/stats")
def card_stats(
    card_id: str,
    days: int = Query(30, ge=1, le=366),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return svc.card_stats(db, svc.card_checked(db, current_user, active_tenant_id, card_id), days)


@router.get("/{card_id}/audit")
def card_audit(
    card_id: str,
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    return svc.audit_out(db, svc.card_checked(db, current_user, active_tenant_id, card_id))


@router.post("/{card_id}/preview-vcard")
def preview_vcard(
    card_id: str,
    body: Dict[str, Any] = Body(...),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
):
    """The VCF the (unsaved) draft would produce — shown in the preview's simulation, never downloaded as the real card."""
    card = svc.card_checked(db, current_user, active_tenant_id, card_id)
    doc = svc.normalize_doc(body.get("draft") if body.get("draft") is not None else card.draft, card.card_type)
    lang = body.get("lang") if body.get("lang") in R.CARD_LANGS else R.languages_of(doc)[0]
    model = R.resolve_card(svc.resolve_input(db, card, doc, lang))["model"]
    model["publicUrl"] = f"{svc.public_base_url()}/{card.slug}"
    return {"vcard": svc.build_vcard(model)}


# ── Public ────────────────────────────────────────────────────────────────────


def _client_ip(request: Request) -> Optional[str]:
    # Fly's edge sets Fly-Client-IP; elsewhere the socket peer (X-Forwarded-For is spoofable).
    return request.headers.get("fly-client-ip") or (request.client.host if request.client else None)


def _limit(request: Request, key: str, per_minute: int) -> None:
    try:
        check_rate_limit_by_key(f"{key}:{_client_ip(request) or 'unknown'}", per_minute, 60)
    except Exception:
        raise svc.error("rate_limited", status.HTTP_429_TOO_MANY_REQUESTS, "יותר מדי בקשות. נסו שוב בעוד דקה.", retryAfter=60) from None


def _lang(lang: Optional[str]) -> str:
    return lang if lang in R.CARD_LANGS else ""


_PUBLIC_HEADERS = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin"}


@public_router.get("/public/cards/{slug}")
def public_card(slug: str, request: Request, lang: Optional[str] = Query(None, max_length=8), db: Session = Depends(get_db)):
    """
    The published card for visitors. Cacheable per card, revision and language (the URL carries
    the slug — one card of one tenant — and the language; the ETag covers the revisions read).
    """
    # The page renders on the dashboard's server (cached 30 s per card and language), so one IP
    # is often that server: a per-card budget, and a wide per-IP one against slug enumeration.
    _limit(request, f"bc_page:{slug[:64]}", 120)
    _limit(request, "bc_pages", 1500)
    kind, card = svc.public_lookup(db, slug)
    no_store = {**_PUBLIC_HEADERS, "Cache-Control": "no-store"}
    if kind == "missing":
        return JSONResponse({"kind": "missing"}, status_code=404, headers=no_store)
    if kind == "redirect":
        return JSONResponse({"kind": "redirect", "slug": card.slug}, headers={**_PUBLIC_HEADERS, "Cache-Control": "public, max-age=60"})
    if kind == "paused":
        langs = R.languages_of(svc.published_doc(db, card) or {})
        chosen = _lang(lang) if _lang(lang) in langs else langs[0]
        return JSONResponse({"kind": "paused", "lang": chosen, "dir": "rtl" if chosen == "he" else "ltr"}, headers=no_store)
    model, etag = svc.public_model(db, card, _lang(lang) or "")
    headers = {**_PUBLIC_HEADERS, "ETag": f'"{etag}"', "Cache-Control": "public, max-age=30, stale-while-revalidate=60"}
    if request.headers.get("if-none-match") == f'"{etag}"':
        return Response(status_code=304, headers=headers)
    return JSONResponse({"kind": "card", "card": model}, headers=headers)


@public_router.get("/public/cards/{slug}/vcard")
def public_vcard(slug: str, request: Request, lang: Optional[str] = Query(None, max_length=8), db: Session = Depends(get_db)):
    _limit(request, "bc_vcard", 30)
    kind, card = svc.public_lookup(db, slug)
    if kind == "redirect":
        kind, card = svc.public_lookup(db, card.slug)
    if kind != "card":
        return JSONResponse({"kind": "missing"}, status_code=404, headers={"Cache-Control": "no-store"})
    model, _ = svc.public_model(db, card, _lang(lang) or "")
    text = svc.build_vcard(model)
    ascii_name, utf8_name = svc.vcard_filename(model)
    if request.method != "HEAD":
        svc.record_stat(db, card, "vcf")
        db.commit()
    return Response(
        content=text.encode("utf-8"),
        media_type="text/vcard; charset=utf-8",
        headers={
            **_PUBLIC_HEADERS,
            "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}",
            "Cache-Control": "no-store",
        },
    )


@public_router.post("/public/cards/{slug}/events", status_code=status.HTTP_204_NO_CONTENT)
def public_event(slug: str, request: Request, body: Dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    """
    First-party, cookie-free counting: no identifiers are sent or stored, only +1 on a daily
    counter. Known bots are ignored. A click is recorded as a click — not as a completed call.
    """
    _limit(request, "bc_event", 60)
    ua = (request.headers.get("user-agent") or "").lower()
    if not ua or any(b in ua for b in _BOTS):
        return Response(status_code=204)
    kind, card = svc.public_lookup(db, slug)
    if kind != "card":
        return Response(status_code=204)
    metric = body.get("type")
    if metric not in svc.CLIENT_METRICS:
        raise svc.error("invalid", 422, "סוג אירוע לא מוכר.")
    dimension = ""
    if metric == "action":
        dimension = body.get("action") if body.get("action") in R.ACTION_TYPES else ""
        if not dimension:
            raise svc.error("invalid", 422, "פעולה לא מוכרת.")
    svc.record_stat(db, card, metric, dimension)
    db.commit()
    return Response(status_code=204)


@public_router.post("/public/cards/{slug}/enquiries")
def public_enquiry(slug: str, request: Request, body: Dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    """The enquiry form. 201 {status: "saved"} only after the row is committed; 200 for the same
    submission again (or the same enquiry within a day); 422 with field errors; 429 when limited."""
    _limit(request, "bc_enquiry", 10)
    kind, card = svc.public_lookup(db, slug)
    if kind == "redirect":
        kind, card = svc.public_lookup(db, card.slug)
    if kind != "card":
        return JSONResponse({"detail": {"code": "card_not_found", "message": svc.MESSAGES["card_not_found"]}}, status_code=404)
    model, _ = svc.public_model(db, card, _lang(body.get("lang")) or "")
    answer, code = svc.submit_enquiry(db, card, model, body, ip=_client_ip(request))
    db.commit()
    return JSONResponse(answer, status_code=code, headers={"Cache-Control": "no-store"})
