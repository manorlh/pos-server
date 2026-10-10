"""
The dashboard's "תפריט דיגיטלי" and "הזמנות אונליין" tabs — their profiles
(app/services/presentation_profiles.py, the resolver app/services/digital_effective.py).

The same routes twice, one prefix per kind, so each tab is its own dashboard section
(`digital_menu` / `online_ordering`, app/services/dashboard_sections.py):

* `GET  /{prefix}/profiles` — the list (company / shop / point of sale, status, service, language,
  search), with selected / visible counts, the published revision and the last update;
* `POST /{prefix}/profiles` — start one: `start.mode` "new" / "match_kiosk" / "copy";
* `GET  /{prefix}/profiles/{id}` — the profile, its draft, its published revision, the effective
  fields with their source, the publication history;
* `PATCH /{prefix}/profiles/{id}` — its own fields (`version`: 409 `profile_changed`);
* `PUT  /{prefix}/profiles/{id}/draft` — the draft's content and field states (`version`: 409);
* `POST /{prefix}/profiles/{id}/save` · `/validate` · `/publish` · `/rollback` · `/pause` · `/resume`
  · `/archive` · `/unarchive`;
* `POST /{prefix}/profiles/{id}/preview` — the resolver on the draft (or the published revision) in a
  test context: every product with its display, orderability and reasons;
* `GET  /{prefix}/profiles/{id}/audit` — who did what;
* `GET  /{prefix}/kiosk-sources` — the kiosks and shops a "תואם קיוסק" profile can follow.

The editor with its live preview is the next phase; these are its server half.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_active_tenant_id, get_current_user
from app.models.presentation_profile import PresentationAudit
from app.models.user import User
from app.services import digital_effective as DE
from app.services import presentation_profiles as PP


class DraftIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    content: Dict[str, Any]
    field_states: Optional[Dict[str, str]] = Field(None, alias="fieldStates")
    version: Optional[int] = None


class VersionIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    version: Optional[int] = None
    note: Optional[str] = Field(None, max_length=300)


class RollbackIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    revision_id: str = Field(..., alias="revisionId")
    reason: Optional[str] = Field(None, max_length=300)


class StatusIn(BaseModel):
    reason: Optional[str] = Field(None, max_length=300)


class PreviewIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: "draft" (default) or "published".
    revision: Literal["draft", "published"] = "draft"
    shop_id: Optional[str] = Field(None, alias="shopId")
    area_id: Optional[str] = Field(None, alias="areaId")
    service: Optional[Literal["dine_in", "takeaway"]] = None
    lang: Optional[str] = None
    at: Optional[datetime] = None


def make_router(kind: str, prefix: str) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=[f"digital-{kind}"])

    @router.get("/profiles")
    def list_profiles(
        company_id: Optional[str] = Query(None, alias="companyId"),
        shop_id: Optional[str] = Query(None, alias="shopId"),
        area_id: Optional[str] = Query(None, alias="areaId"),
        status_: Optional[str] = Query(None, alias="status"),
        search: Optional[str] = Query(None),
        service: Optional[str] = Query(None),
        language: Optional[str] = Query(None),
        counts: bool = Query(True),
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        return {
            "kind": kind,
            "profiles": PP.list_profiles(
                db, current_user, active_tenant_id, kind, company_id=company_id, shop_id=shop_id, area_id=area_id,
                status_=status_ or None, search=search, service=service, language=language, with_counts=counts,
            ),
        }

    @router.post("/profiles", status_code=status.HTTP_201_CREATED)
    def create_profile(
        body: Dict[str, Any],
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        profile = PP.create(db, current_user, active_tenant_id, kind, body)
        db.commit()
        return PP.detail(db, profile)

    @router.get("/profiles/{profile_id}")
    def get_profile(
        profile_id: str,
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        return PP.detail(db, PP.get_profile(db, current_user, active_tenant_id, kind, profile_id))

    @router.patch("/profiles/{profile_id}")
    def patch_profile(
        profile_id: str,
        body: Dict[str, Any],
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        p = PP.get_profile(db, current_user, active_tenant_id, kind, profile_id, write=True)
        version = body.get("version")
        PP.update_meta(db, p, body, current_user, version=int(version) if isinstance(version, int) else None)
        db.commit()
        return PP.detail(db, p)

    @router.put("/profiles/{profile_id}/draft")
    def put_draft(
        profile_id: str,
        body: DraftIn,
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        p = PP.get_profile(db, current_user, active_tenant_id, kind, profile_id, write=True)
        d = PP.put_draft(db, p, content=body.content, field_states=body.field_states, version=body.version, user=current_user)
        db.commit()
        return {"draft": PP.revision_out(d), "profile": PP.profile_out(db, p), "effective": PP.effective_fields(db, p, d)}

    @router.post("/profiles/{profile_id}/save")
    def save(
        profile_id: str,
        body: VersionIn,
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        p = PP.get_profile(db, current_user, active_tenant_id, kind, profile_id, write=True)
        PP.save_draft(db, p, current_user, version=body.version)
        db.commit()
        return PP.detail(db, p)

    @router.post("/profiles/{profile_id}/validate")
    def validate(
        profile_id: str,
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        p = PP.get_profile(db, current_user, active_tenant_id, kind, profile_id)
        d = PP.draft_of(db, p, current_user)
        errors, warnings, exposure = PP.validate(db, p, d)
        db.rollback()  # a check: a draft made only to look at it is not kept
        return {
            "ok": not errors, "errors": errors, "warnings": warnings,
            "exposedCount": len(exposure["products"]), "includeFuture": exposure["includeFuture"],
        }

    @router.post("/profiles/{profile_id}/publish")
    def publish(
        profile_id: str,
        body: VersionIn,
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        p = PP.get_profile(db, current_user, active_tenant_id, kind, profile_id, write=True)
        PP.publish(db, p, current_user, note=body.note, version=body.version)
        db.commit()
        from app.services import public_digital_cache

        public_digital_cache.invalidate(p.id)
        return PP.detail(db, p)

    @router.post("/profiles/{profile_id}/rollback")
    def rollback(
        profile_id: str,
        body: RollbackIn,
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        p = PP.get_profile(db, current_user, active_tenant_id, kind, profile_id, write=True)
        PP.rollback(db, p, body.revision_id, current_user, reason=body.reason)
        db.commit()
        from app.services import public_digital_cache

        public_digital_cache.invalidate(p.id)
        return PP.detail(db, p)

    def _status_route(action: str):
        def handler(
            profile_id: str,
            body: StatusIn,
            current_user: User = Depends(get_current_user),
            active_tenant_id=Depends(get_active_tenant_id),
            db: Session = Depends(get_db),
        ):
            p = PP.get_profile(db, current_user, active_tenant_id, kind, profile_id, write=True)
            PP.set_status(db, p, action, current_user, reason=body.reason)
            db.commit()
            from app.services import public_digital_cache

            public_digital_cache.invalidate(p.id)
            return PP.detail(db, p)

        handler.__name__ = f"{kind}_{action}"
        return handler

    for action in ("pause", "resume", "archive", "unarchive"):
        router.add_api_route(f"/profiles/{{profile_id}}/{action}", _status_route(action), methods=["POST"])

    @router.post("/profiles/{profile_id}/preview")
    def preview(
        profile_id: str,
        body: PreviewIn,
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        p = PP.get_profile(db, current_user, active_tenant_id, kind, profile_id)
        if body.revision == "published":
            rev = PP.revision(db, p.published_revision_id)
            if rev is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "not_published", "message": "הפרופיל עוד לא פורסם"})
            mode = "public"
        else:
            rev = PP.draft_of(db, p, current_user)
            mode = "preview"
        view = DE.resolve(db, DE.Request(
            profile=p, revision=rev, channel=kind, service=body.service, lang=body.lang, at=body.at, mode=mode,
            shop_id=body.shop_id, area_id=body.area_id,
        ))
        db.rollback()
        return view

    @router.get("/profiles/{profile_id}/audit")
    def audit_log(
        profile_id: str,
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        p = PP.get_profile(db, current_user, active_tenant_id, kind, profile_id)
        rows = (
            db.query(PresentationAudit)
            .filter(PresentationAudit.profile_id == p.id)
            .order_by(PresentationAudit.created_at.desc())
            .limit(200)
            .all()
        )
        return {
            "entries": [
                {"id": str(r.id), "action": r.action, "actor": r.actor_name, "before": r.before, "after": r.after,
                 "reason": r.reason, "revisionId": str(r.revision_id) if r.revision_id else None,
                 "at": r.created_at.isoformat() if r.created_at else None}
                for r in rows
            ]
        }

    @router.get("/kiosk-sources")
    def kiosk_sources(
        current_user: User = Depends(get_current_user),
        active_tenant_id=Depends(get_active_tenant_id),
        db: Session = Depends(get_db),
    ):
        """Where a "תואם קיוסק" profile can take the kiosk from: each shop with kiosks, and each kiosk."""
        from app.models.kiosk import KioskDevice
        from app.models.pos_machine import POSMachine
        from app.models.shop import Shop

        rows = (
            db.query(KioskDevice, POSMachine, Shop)
            .join(POSMachine, POSMachine.id == KioskDevice.machine_id)
            .join(Shop, Shop.id == KioskDevice.shop_id)
            .filter(KioskDevice.tenant_id == active_tenant_id, KioskDevice.enabled.is_(True))
            .order_by(Shop.name, POSMachine.name)
            .all()
        )
        shops: Dict[str, Dict[str, Any]] = {}
        for device, machine, shop in rows:
            if not PP.covers(db, current_user, shop.company_id, shop.id):
                continue
            entry = shops.setdefault(str(shop.id), {"level": "shop", "targetId": str(shop.id), "name": shop.name, "kiosks": []})
            entry["kiosks"].append({"level": "machine", "targetId": str(machine.id), "name": device.name or machine.name})
        return {"sources": list(shops.values())}

    return router


menu_router = make_router("menu", "/digital-menu")
online_router = make_router("online", "/online-ordering")
