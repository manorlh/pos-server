"""
"עריכת תפריט הקיוסק" — the kiosk admin's menu editor (docs/SPEC_KIOSK.md §22).

The kiosk's menu is the existing catalog keys of the kiosk config (`catalog.categoryOrder`,
`productOrder`, `hiddenCategories`, `hiddenProducts`, `featuredProductIds`). The kiosk saves
them at SHOP level — one menu for every kiosk of the shop ("יחול על כל הקיוסקים בסניף") — with:

* a manager's approval: the PIN entered on the kiosk names a till user who must be an active
  shop manager of the shop, by the cloud's roster (`require_till_manager`);
* a version check: `menu_version` is a hash of the shop layer's menu keys; a save from an
  older version is refused 409 `kiosk_menu_changed` ("התפריט השתנה — טען מחדש") — the
  dashboard's save of the shop layer passes the same check;
* the audit: a `kiosk_commands` row, action `menu`, by the manager's name;
* the push: every kiosk of the shop is woken to sync.

So it holds for every kiosk, a kiosk's own (machine) layer loses these keys when the shop's
menu is saved from a kiosk. "אזל היום" is not here: the kiosk sets it through the
availability lock every till uses (`PUT /sync/{m}/products/{id}/availability`, temporary,
opened again after the Z).
"""
from __future__ import annotations

import hashlib
import json
import types
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import status
from sqlalchemy.orm import Session

from app.models.kiosk import KioskCommand, KioskDevice, KioskSettings
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.services import kiosk_config as cfgsvc

#: The catalog keys the menu editor owns.
MENU_KEYS = ("categoryOrder", "productOrder", "hiddenCategories", "hiddenProducts", "featuredProductIds")


def menu_of(layer: Any) -> Dict[str, Any]:
    """The menu keys a layer sets (absent keys left out)."""
    catalog = (layer or {}).get("catalog") if isinstance(layer, dict) else None
    if not isinstance(catalog, dict):
        return {}
    return {k: catalog[k] for k in MENU_KEYS if k in catalog}


def version_of(menu: Dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(menu, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def shop_layer(db: Session, shop_id) -> Dict[str, Any]:
    row = cfgsvc.layer_row(db, "shop", shop_id) if shop_id is not None else None
    return cfgsvc.sanitize_stored_layer(row.overrides if row is not None else {})


def menu_version(db: Session, shop_id) -> str:
    """The shop's kiosk menu version (a hash of its menu keys)."""
    return version_of(menu_of(shop_layer(db, shop_id)))


class MenuRefused(Exception):
    """`{"detail": code, "message": Hebrew}` with its status."""

    def __init__(self, status_code: int, code: str, message: str, **extra: Any):
        super().__init__(code)
        self.status_code = status_code
        self.body = {"detail": code, "message": message, **extra}


def check_version(db: Session, shop_id, base_version: Optional[str]) -> None:
    current = menu_version(db, shop_id)
    if base_version != current:
        raise MenuRefused(
            status.HTTP_409_CONFLICT, "kiosk_menu_changed", "התפריט השתנה — טען מחדש", menuVersion=current,
        )


def save_from_kiosk(
    db: Session,
    machine: POSMachine,
    device: KioskDevice,
    *,
    approver_id: Optional[str],
    base_version: Optional[str],
    menu: Any,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """The kiosk's save. Raises `MenuRefused` (403 / 409 / 422); the caller commits."""
    from app.services import kiosk_control as S

    now = now or datetime.now(timezone.utc)
    if machine.shop_id is None:
        raise MenuRefused(status.HTTP_409_CONFLICT, "machine_not_assigned", "הקיוסק אינו משויך לסניף.")
    try:
        manager = S.require_till_manager(db, machine, approver_id)
    except S.KioskCommandRefused as refused:
        raise MenuRefused(refused.status_code, refused.body["detail"], refused.body["message"])
    check_version(db, machine.shop_id, base_version)
    if not isinstance(menu, dict) or set(menu) - set(MENU_KEYS):
        raise MenuRefused(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_kiosk_menu", "התפריט שנשלח אינו תקין.")
    cleaned, errors = cfgsvc.validate_layer({"catalog": menu})
    if errors:
        raise MenuRefused(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_kiosk_menu", "התפריט שנשלח אינו תקין.",
            errors=[{"path": e.path, "code": e.code} for e in errors][:20],
        )
    new_menu = menu_of(cleaned)

    # The shop's layer: its menu keys replaced, everything else as it was.
    shop = db.get(Shop, machine.shop_id)
    layer = shop_layer(db, machine.shop_id)
    catalog = {k: v for k, v in (layer.get("catalog") or {}).items() if k not in MENU_KEYS}
    catalog.update(new_menu)
    layer = {**layer, "catalog": catalog} if catalog else {k: v for k, v in layer.items() if k != "catalog"}
    scope = S.SettingsScope("shop", shop, shop.tenant_id, company_id=shop.company_id, shop_id=shop.id)
    try:
        S.save_settings(db, types.SimpleNamespace(id=None), scope, layer, now=now)
    except cfgsvc.KioskConfigInvalid as invalid:
        raise MenuRefused(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid_kiosk_menu", "התפריט שנשלח אינו תקין.", errors=invalid.detail().get("errors"))

    # Every kiosk of the shop follows the shop's menu: their own layers lose the menu keys.
    kiosks = db.query(KioskDevice).filter(KioskDevice.shop_id == machine.shop_id).all()
    cleared = 0
    for k in kiosks:
        row = cfgsvc.layer_row(db, "machine", k.machine_id)
        if row is None or not menu_of(row.overrides):
            continue
        overrides = dict(row.overrides or {})
        rest = {key: v for key, v in (overrides.get("catalog") or {}).items() if key not in MENU_KEYS}
        if rest:
            overrides["catalog"] = rest
        else:
            overrides.pop("catalog", None)
        row.overrides = overrides
        row.updated_at = now
        cleared += 1

    name = (
        " ".join(p for p in (manager.first_name or "", manager.last_name or "") if p).strip() or manager.username or "מנהל"
    )
    detail = (
        f"categories={len(new_menu.get('categoryOrder') or [])} "
        f"hiddenCategories={len(new_menu.get('hiddenCategories') or [])} "
        f"hiddenProducts={len(new_menu.get('hiddenProducts') or [])} "
        f"featured={len(new_menu.get('featuredProductIds') or [])} kioskLayersCleared={cleared}"
    )
    db.add(KioskCommand(
        id=uuid.uuid4(), tenant_id=machine.tenant_id, kiosk_machine_id=machine.id, action="menu",
        message=None, force=False, source="till", requested_by_machine_id=machine.id,
        requested_by_name=f"{name} (בקיוסק)"[:200], status="applied", detail=detail, created_at=now,
    ))
    db.flush()
    version = menu_version(db, machine.shop_id)
    return {
        "menuVersion": version,
        "savedAt": now.isoformat(),
        "savedBy": name,
        "kiosks": [str(k.machine_id) for k in kiosks],
    }


def wake_kiosks(tenant_id, machine_ids) -> None:
    """After the commit: every kiosk of the shop syncs now (else on its next ~15 s poll)."""
    from app.services import ably_notify

    for machine_id in machine_ids:
        try:
            ably_notify.publish_settings_notify(str(tenant_id), str(machine_id), reason="kiosk_menu")
        except Exception:  # noqa: BLE001 - a push never fails the save
            pass
