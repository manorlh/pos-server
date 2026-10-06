"""
"סוג אינטגרציית אשראי" for the dashboard: what a settings layer's form needs to show.

The integration type and Z-Credit's own fields are ordinary settings, written through
the layers' PATCH endpoints (app/routers/settings.py), which also take the write-only
secrets. This read says what the form cannot work out from the settings alone:

* whether the layer, or one above it, holds each secret (never the value);
* what the layer inherits, and from where;
* for a till: whether it has a terminal of its own and NFC (which choices it may have),
  what it resolves to and which fields it still lacks.
"""
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import ensure_same_tenant, get_active_tenant_id, get_current_user
from app.models.company import Company
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.user import User
from app.services import payment_integration as PI
from app.services import payment_secrets

router = APIRouter(prefix="/payment-integration", tags=["payment-integration"])

LEVELS = ("tenant", "company", "shop", "area", "machine")


def _layers_for(
    db: Session, level: str, target_id: str, user: User, active_tenant_id
) -> Tuple[List[Tuple[str, Any]], Optional[Any]]:
    """`(level, entity)` from the tenant down to the target, and the till when it is one."""
    from app.routers.companies import _check_company_access
    from app.routers.settings import _area_and_shop, _machine_parents, _tenant_of
    from app.routers.shops import _check_shop_access
    from app.routers.tenants import _can_manage_tenant

    if level == "tenant":
        tenant = db.query(Tenant).filter(Tenant.id == target_id).first()
        if tenant is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found")
        if not _can_manage_tenant(user, tenant.id, db):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
        return [("tenant", tenant)], None
    if level == "company":
        company = db.query(Company).filter(Company.id == target_id).first()
        if company is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Company not found")
        ensure_same_tenant(company.tenant_id, active_tenant_id)
        _check_company_access(user, company, db)
        return [("tenant", _tenant_of(company, db)), ("company", company)], None
    if level in ("shop", "area"):
        if level == "shop":
            shop = db.query(Shop).filter(Shop.id == target_id).first()
            if shop is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shop not found")
            ensure_same_tenant(shop.tenant_id, active_tenant_id)
            area = None
        else:
            area, shop = _area_and_shop(db, target_id, active_tenant_id)
        _check_shop_access(user, shop, db)
        company = db.query(Company).filter(Company.id == shop.company_id).first()
        tenant = _tenant_of(company, db) if company else None
        layers = [("tenant", tenant), ("company", company), ("shop", shop)]
        if area is not None:
            layers.append(("area", area))
        return layers, None
    from app.routers.machines import _machine_for_read

    machine = _machine_for_read(db, target_id, user, active_tenant_id)
    area, shop, company, tenant = _machine_parents(db, machine)
    return (
        [("tenant", tenant), ("company", company), ("shop", shop), ("area", area), ("machine", machine)],
        machine,
    )


def _options(machine: Any) -> List[Dict[str, Any]]:
    """The select's choices, each with whether it may be picked here and why not."""
    builtin = True if machine is None else bool(getattr(machine, "has_builtin_terminal", True))
    nfc = None if machine is None else PI.device_has_nfc(machine)
    # On a SynqPay terminal the built-in terminal is SynqPay's own (docs/SPEC_SYNQPAY.md §1.5).
    from app.models.synqpay_devices import synqpay_device_model

    synqpay_device = machine is not None and synqpay_device_model(getattr(machine, "device_model", None)) is not None
    out = []
    for value in PI.INTEGRATIONS:
        reason = None
        if value in PI.RESERVED:
            reason = "soon" if nfc is not False else "needs_nfc"
        elif value == PI.AGAMENTO and not builtin:
            reason = "needs_builtin_terminal"
        label = PI.BUILTIN_SYNQPAY_LABEL_HE if value == PI.AGAMENTO and synqpay_device else PI.LABELS_HE[value]
        out.append({"value": value, "label": label, "selectable": reason is None, "reason": reason})
    return out


@router.get("/context")
def get_payment_integration_context(
    level: str = Query(...),
    target_id: str = Query(..., alias="targetId"),
    current_user: User = Depends(get_current_user),
    active_tenant_id=Depends(get_active_tenant_id),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    if level not in LEVELS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="level_invalid")
    layers, machine = _layers_for(db, level, target_id, current_user, active_tenant_id)
    present = [(lvl, entity) for lvl, entity in layers if entity is not None]
    id_layers = [(lvl, entity.id) for lvl, entity in present]
    secrets = payment_secrets.secret_status(db, id_layers, level)

    parents = [(lvl, getattr(entity, "settings", None)) for lvl, entity in present if lvl != level]
    inherited_value: Optional[str] = None
    inherited_source: Optional[str] = None
    for lvl, settings in reversed(parents):
        value = PI.clean_integration((settings or {}).get(PI.KEY) if isinstance(settings, dict) else None)
        if value not in (None, PI.AUTO):
            inherited_value, inherited_source = value, lvl
            break

    resolved = None
    if machine is not None:
        res = PI.resolve(
            [(lvl, getattr(entity, "settings", None)) for lvl, entity in present],
            bool(getattr(machine, "has_builtin_terminal", True)),
            secrets_set=[k for k, v in secrets.items() if v["set"]],
            synqpay_device=PI.is_synqpay_device(machine),
        )
        resolved = {
            "integration": res.integration,
            "source": res.source,
            "automatic": res.automatic,
            "missing": res.missing,
        }
    return {
        "level": level,
        "targetId": target_id,
        "hasBuiltinTerminal": None if machine is None else bool(machine.has_builtin_terminal),
        "hasNfc": None if machine is None else PI.device_has_nfc(machine),
        "options": _options(machine),
        "inherited": {"integration": inherited_value, "source": inherited_source},
        "secrets": secrets,
        "resolved": resolved,
        "requiredFields": {k: list(v) for k, v in PI.REQUIRED_FIELDS.items()},
        "fieldLabels": PI.FIELD_LABELS_HE,
    }
