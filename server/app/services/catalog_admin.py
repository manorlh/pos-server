"""
"ניהול קטלוג מהקופה" — what the till's catalog screen shows (specs/till-catalog-management.md §6).

The four built-in till parameters (`catalogAdminEnabled`, `catalogAdminScope`,
`catalogCreateFromTill`, `catalogWithoutShift`, app/services/till_parameters.py) resolve like
every other parameter. On top of them the cloud works out, per till, what its catalog screen
shows — `catalogAdminView` — so the till never decides it itself. It travels in the till's
parameters pull (`GET /sync/{m}/parameters`, top-level `catalogAdminView`, next to `parameters`):

    {"scope": "menu" | "shop" | "till", "menuId": "<uuid>" (menu only), "label": "<Hebrew>"}

`catalogAdminScope`:

* `auto` — a catalog menu assigned to the till (or a device group it is in) or to its point of
  sale: that menu's items; else the shop's catalog. There is no product-to-area assignment: a
  point of sale's "catalog" is the menu assigned to it (§6.4).
* `area` — the point of sale's own menu; none (or no area) — the shop's catalog.
* `shop` — always the whole shop, a menu or not.
* `till` — only what the till sells: its own menu (till or device group), else its product list.

Which menu: of the active menus assigned at the levels the scope counts, the one the till's own
rules rank first (`catalog_menu_rules.rank`: till, then group, then point of sale; then
priority) — whatever its schedule, so the screen does not change under the manager's hands as
the clock turns.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.pos_machine import POSMachine
from app.models.till_parameter import TillParameter, TillParameterValue
from app.services import till_parameters as TP

SCOPE_MENU = "menu"
SCOPE_SHOP = "shop"
SCOPE_TILL = "till"

LABEL_SHOP = "קטלוג הסניף"
LABEL_TILL = "מוצרי הקופה"
#: The level a menu came from → how the label names it.
MENU_LABEL_PREFIX = {
    "area": "תפריט נקודה",
    "machine": "תפריט קופה",
    "group": "תפריט קבוצה",
}

#: Which assignment levels each `catalogAdminScope` counts.
_MENU_LEVELS = {
    "auto": ("machine", "group", "area"),
    "area": ("area",),
    "till": ("machine", "group"),
    "shop": (),
}


def shop_view() -> Dict[str, Any]:
    return {"scope": SCOPE_SHOP, "label": LABEL_SHOP}


def till_view() -> Dict[str, Any]:
    return {"scope": SCOPE_TILL, "label": LABEL_TILL}


def menu_view(menu_id: str, menu_name: Optional[str], level: str) -> Dict[str, Any]:
    prefix = MENU_LABEL_PREFIX.get(level, "תפריט")
    name = (menu_name or "").strip()
    return {"scope": SCOPE_MENU, "menuId": str(menu_id), "label": f"{prefix}: {name}" if name else prefix}


def pick_menu(block: Optional[Dict[str, Any]], levels: Sequence[str]) -> Optional[Tuple[str, Optional[str], str]]:
    """
    `(menu id, name, level)` of the first assignment in a till's `catalogMenus`-shaped block
    (already ranked by `block_of`) whose level is in `levels`; None when there is none.
    `block["menus"]` may carry names (`_data`'s menus) or not.
    """
    if not block or not levels:
        return None
    names = {}
    menus = block.get("menus") or []
    if isinstance(menus, dict):
        menus = list(menus.values())
    for m in menus:
        names[str(m.get("id"))] = m.get("name")
    for a in block.get("assignments") or []:
        if a.get("level") in levels and str(a.get("menuId")) in names:
            return str(a["menuId"]), names.get(str(a["menuId"])), a["level"]
    return None


def resolve_view(scope: Any, *, has_area: bool, block: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Pure: the `catalogAdminView` for a till, from its resolved `catalogAdminScope` (anything
    unknown reads as `auto`), whether it stands in a point of sale, and its menus block.
    """
    scope = scope if scope in _MENU_LEVELS else "auto"
    levels = _MENU_LEVELS[scope]
    if scope == "area" and not has_area:
        levels = ()
    picked = pick_menu(block, levels)
    if picked is not None:
        return menu_view(*picked)
    if scope == "till":
        return till_view()
    return shop_view()


def _menus_block(db: Session, machine: POSMachine) -> Optional[Dict[str, Any]]:
    """The till's live menus, ranked (None when menus are not set up)."""
    from app.services import catalog_menus as CM
    from app.services import machine_groups

    if machine.tenant_id is None or not CM.tables_ready(db):
        return None
    groups = machine_groups.groups_of_machine(db, machine)
    chain = CM.chain_for_machine(db, machine, groups)
    # `block_of` keeps each menu's name and ranks the assignments as the till does.
    return CM.block_of(CM._data(db, machine.tenant_id, chain), chain)


def view_for_machine(db: Session, machine: POSMachine, parameters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """`catalogAdminView` for one till; `parameters`: its resolved parameters, if already at hand."""
    if parameters is None:
        parameters = TP.till_parameters_for_machine(db, machine).parameters
    scope = parameters.get(TP.CATALOG_ADMIN_SCOPE_KEY, "auto")
    try:
        block = _menus_block(db, machine)
    except Exception:  # pragma: no cover - the parameters pull never fails on the menus
        block = None
    return resolve_view(scope, has_area=getattr(machine, "area_id", None) is not None, block=block)


# ── The dashboard's "ניהול קטלוג מהקופה" page: one level at a time ───────────


def level_view(db: Session, scope_type: str, scope_id: Any) -> Dict[str, Any]:
    """What a level sets itself, what it inherits from above, and the four definitions."""
    from app.services.kds_workflow import chain_for_scope

    TP.ensure_builtin_parameters(db)
    keys = TP.CATALOG_ADMIN_KEYS
    params = db.query(TillParameter).filter(TillParameter.key.in_(keys)).all()
    by_key = {p.key: p for p in params}
    by_id = {p.id: p for p in params}
    ident = TP.as_uuid(scope_id)
    own_rows = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id.in_(list(by_id)),
            TillParameterValue.scope_type == scope_type,
            TillParameterValue.scope_id == ident,
        )
        .all()
        if params
        else []
    )
    own = {by_id[r.parameter_id].key: r.value for r in own_rows if r.parameter_id in by_id}
    above, _shop = chain_for_scope(db, scope_type, ident, above_only=True)
    scopes = above.scopes()
    values: List[TillParameterValue] = []
    if scopes and params:
        values = (
            db.query(TillParameterValue)
            .filter(
                TillParameterValue.parameter_id.in_(list(by_id)),
                or_(*[and_(TillParameterValue.scope_type == k, TillParameterValue.scope_id == i) for k, i in scopes]),
            )
            .all()
        )
    inherited = TP.resolve_till_parameters(params, values, above).parameters
    return {
        "scopeType": scope_type,
        "scopeId": str(ident),
        "own": own,
        "inherited": inherited,
        "parameters": [
            {
                "key": key,
                "label": by_key[key].label,
                "description": by_key[key].description,
                "valueType": by_key[key].value_type,
                "enumOptions": by_key[key].enum_options,
                "defaultValue": by_key[key].default_value,
            }
            for key in keys
            if key in by_key and by_key[key].is_active
        ],
    }


def save_values(db: Session, scope_type: str, scope_id: Any, values: Dict[str, Any], *, user: Any, now) -> bool:
    """
    Write `values` (key → value; None clears the level's own value) at one level, each change
    with its row in `till_parameter_changes`. Raises `TillParameterValueError` on a key that is
    not one of the four or a value its definition refuses. True when anything changed.
    """
    unknown = [k for k in values if k not in TP.CATALOG_ADMIN_KEYS]
    if unknown:
        raise TP.TillParameterValueError(f"unknown parameter {unknown[0]}")
    TP.ensure_builtin_parameters(db)
    params = {p.key: p for p in db.query(TillParameter).filter(TillParameter.key.in_(list(values))).all()}
    changed = False
    for key, value in values.items():
        parameter = params.get(key)
        if parameter is None:
            continue
        stored = None if value is None else TP.validate_value(parameter.value_type, value, parameter.enum_options)
        changed = TP.write_value(db, parameter, scope_type, scope_id, stored, user=user, now=now) or changed
    return changed


def scope_exists(db: Session, scope_type: str, scope_id: Any) -> bool:
    if scope_type not in ("company", "shop", "area", "machine"):
        return False
    try:
        ident = scope_id if isinstance(scope_id, uuid.UUID) else uuid.UUID(str(scope_id))
    except (TypeError, ValueError):
        return False
    return TP.scope_entity(db, scope_type, ident) is not None
