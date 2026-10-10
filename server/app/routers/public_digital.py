"""
The public read API of a published profile — the digital menu and the online ordering site
(specs/digital-menu-ordering-cards-plan.md §9; the resolver app/services/digital_effective.py).

* `GET /public/v1/{menu|online}/{slug}` — the published revision, in the place asked
  (`shopId` / `areaId` under a company or shop profile), for a service (`service`) and a language
  (`lang`): the categories in order and the products a customer may see — name, description,
  image, tags, allergens, dietary marks, price, display (show / label), orderable, the public reason.
  Nothing else: no hidden product, no internal reason, no cost, no block note.
* `GET /public/v1/{menu|online}/{slug}/products/{productId}` — one product, or a neutral
  "unavailable" (404) for one not shown here (it never says why).

No sign-in; throttled per address; errors are `{code, userMessage}`. Cached per tenant · point ·
profile · revision · language · service for a few seconds, with an ETag (a match: 304); a
publication drops its profile's entries (app/services/public_digital_cache.py). A draft is never
served here — the dashboard's preview is the editor's.
"""
from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.rate_limit import check_rate_limit
from app.models.presentation_profile import PresentationProfile
from app.services import digital_effective as DE
from app.services import presentation_profiles as PP
from app.services import public_digital_cache as cache

public_router = APIRouter(tags=["public-digital"])

Kind = Literal["menu", "online"]
#: Requests per address per minute (pages poll every few seconds at most).
THROTTLE = 240


def _error(code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"code": code, "userMessage": message})


def _published(db: Session, kind: str, slug: str):
    """`(profile, revision)` or an error response."""
    if not PP.tables_ready(db):
        return None, _error("not_found", "הדף לא נמצא", status.HTTP_404_NOT_FOUND)
    p = db.query(PresentationProfile).filter(PresentationProfile.slug == slug.lower(), PresentationProfile.kind == kind).first()
    if p is None or p.status in ("draft", "saved", "archived") or p.published_revision_id is None:
        return None, _error("not_found", "הדף לא נמצא", status.HTTP_404_NOT_FOUND)
    if p.status == "paused":
        return None, _error("paused", "הדף אינו זמין כרגע", status.HTTP_503_SERVICE_UNAVAILABLE)
    rev = PP.revision(db, p.published_revision_id)
    if rev is None:
        return None, _error("not_found", "הדף לא נמצא", status.HTTP_404_NOT_FOUND)
    return (p, rev), None


def _payload(db: Session, kind: str, slug: str, shop_id: Optional[str], area_id: Optional[str],
             service: Optional[str], lang: Optional[str]):
    found, err = _published(db, kind, slug)
    if err is not None:
        return None, None, err
    profile, rev = found
    if service is not None and service not in ("dine_in", "takeaway"):
        return None, None, _error("invalid_service", "סוג שירות לא מוכר", status.HTTP_422_UNPROCESSABLE_ENTITY)
    key = cache.key_of(tenant_id=profile.tenant_id, shop_id=shop_id, area_id=area_id, profile_id=profile.id,
                       revision_id=rev.id, lang=lang, service=service, kind=kind)
    hit = cache.get(key)
    if hit is not None:
        return hit[1], hit[0], None
    try:
        view = DE.resolve(db, DE.Request(profile=profile, revision=rev, channel=kind, service=service, lang=lang,
                                         mode="public", shop_id=shop_id, area_id=area_id))
    except Exception as exc:  # noqa: BLE001 - a bad place is the customer's 404, never a stack
        detail = getattr(exc, "detail", None)
        code = detail.get("code") if isinstance(detail, dict) else None
        if code in ("place_outside_profile", "invalid_service", "invalid_channel"):
            return None, None, _error("not_found", "המקום לא נמצא", status.HTTP_404_NOT_FOUND)
        raise
    payload: Dict[str, Any] = DE.public_view(view)
    if not view["open"]["access"]:
        # Closed for browsing: the brand and the hours only — no products.
        payload = {"profile": payload["profile"], "context": payload["context"], "open": payload["open"],
                   "closed": True, "texts": payload.get("texts"), "theme": payload.get("theme"),
                   "categories": [], "products": {}}
    etag = cache.put(key, payload)
    return payload, etag, None


@public_router.get("/public/v1/{kind}/{slug}")
def public_profile(
    kind: Kind,
    slug: str,
    request: Request,
    shop_id: Optional[str] = Query(None, alias="shopId"),
    area_id: Optional[str] = Query(None, alias="areaId"),
    service: Optional[str] = None,
    lang: Optional[str] = None,
    db: Session = Depends(get_db),
):
    check_rate_limit(request, f"public-digital:{kind}", THROTTLE)
    payload, etag, err = _payload(db, kind, slug, shop_id, area_id, service, lang)
    if err is not None:
        return err
    headers = {"ETag": etag, "Cache-Control": f"public, max-age={int(cache.TTL_SECONDS)}"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return JSONResponse(content=payload, headers=headers)


@public_router.get("/public/v1/{kind}/{slug}/products/{product_id}")
def public_product(
    kind: Kind,
    slug: str,
    product_id: str,
    request: Request,
    shop_id: Optional[str] = Query(None, alias="shopId"),
    area_id: Optional[str] = Query(None, alias="areaId"),
    service: Optional[str] = None,
    lang: Optional[str] = None,
    db: Session = Depends(get_db),
):
    check_rate_limit(request, f"public-digital:{kind}", THROTTLE)
    payload, etag, err = _payload(db, kind, slug, shop_id, area_id, service, lang)
    if err is not None:
        return err
    product = (payload.get("products") or {}).get(product_id)
    if product is None:
        # Neutral: removed, hidden, blocked away or never here look the same.
        return _error("unavailable", "המנה אינה זמינה כאן", status.HTTP_404_NOT_FOUND)
    return JSONResponse(content={"profile": payload["profile"], "open": payload["open"], "product": product},
                        headers={"Cache-Control": f"public, max-age={int(cache.TTL_SECONDS)}"})
