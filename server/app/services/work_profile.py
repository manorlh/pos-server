"""
"תצורת עבודה של הסניף" — how a whole shop works, chosen when it is set up and edited later on
its page (P:/specs/shop-work-config.md, approved 12.10.2026; the contract is its §7ב).

The owner: "אם יש הזמנות, ניהול שולחנות, תחנות עבודה — אז כן אפשר להוסיף בהקמת הסניף פרמטרים לכל
הסניף. עדיף בהקמת הסניף."

**Stored** on the shop as `settings.workProfile` (no migration; the fields, their values and the
templates are app/services/work_profile_templates.py). It is never sent to a till: the settings
sync sends only its own keys (`MANAGED_SETTING_KEYS`).

**Applied now** — what needs no till — at the shop's own level, through the services that own
each value, each change in the change log (`till_parameter_changes`):

* `tablesMode` — `menu_broadcast.write_shop_tables` (the card "סוגי עבודה"'s write);
* the kitchen — `kdsEnabled` / `workflowTargets` through `kds_workflow.save_values` (validated
  against the shop's KDS screens);
* "מסך לקוח" — the shop's `customerDisplay.enabled` (`customer_display.clean_layer` / `write_layer`);
* "נוכחות עובדים" (`attendanceEnabled`) and "מי מפיק Z סניפי" (`shopZFrom`) — till parameters at the
  shop's level, written as the parameters page writes them (`till_parameters.write_value`);
* tips (`tipsEnabled`, the options' tips keys when the company's override it, `tipDistribution`) and
  the production vouchers (`voucherStation`, `voucherBalanceCheck`) — the shop's settings layer.

**Applied to the tills** — the Z and the local server. With no till yet they wait ("יופעל כשתצומד
הקופה הראשונה"), and the profile is the default of "הוספת מכשיר" in the shop (`suggest`): the
first Android till becomes the main till (`main_till`, with "רשת מקומית") under `shop_local`, the
next ones `lan_member` (or `remote_shop_z` for Windows / a browser), every till `shop_z_cloud`
under `shop_cloud`, `own_z` under `per_till`, and a kiosk `kiosk_shop_z` / `kiosk_own_z`. A device
a super admin pairs with no plan of its own takes it by itself (`apply_on_pairing`); one anyone
else pairs stays "לפי הסניף", as before — the presets' services are the super admin's, and nothing
here acts as one for anybody else — and the status says the Z waits for a super admin ("ממתין
למנהל-על — יש להחיל את תצורת העבודה מדף הסניף"). A super admin's save switches the tills:
`z_mode_policy.switch_all`, `work_config.apply` (the main till, a kiosk's own Z) and
`lan_server.set_local_network` — with every rule they keep (a till's shift closed, no Z under
way, the shop Z producer's guard).

**All or nothing.** Everything that can be refused is checked before anything is written; a
refusal is a 409 with the Hebrew reason (`{detail: {code, message, field, …}}`) and nothing
changes — the caller rolls back.

**Who** (spec §5): with no till in the shop, whoever may set up shops (the super admin, a
distributor, a manager of the shop's company) sets everything; once there are tills the Z, the
local server and "מי מפיק Z סניפי" are the super admin's alone, the rest stays theirs.

**Status** per field — `applied` / `pending` / `blocked` with a Hebrew reason — is read from the
shop as it stands (its tills' Z mode, the main till, "רשת מקומית", the resolved parameters and
settings), never from a stored flag.
"""
from __future__ import annotations

import copy
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.services import work_profile_templates as T

logger = logging.getLogger(__name__)

FIRST_TILL = "יופעל כשתצומד הקופה הראשונה"
WAIT_MAIN = "ממתין לקופה ראשית"
#: The tills are there but not as the profile says, and no rule stands in the way: a super
#: admin's save applies it (a device paired by anyone else stays "לפי הסניף").
WAIT_SUPER_ADMIN = "ממתין למנהל-על — יש להחיל את תצורת העבודה מדף הסניף"

APPLIED, PENDING, BLOCKED = "applied", "pending", "blocked"

Z_TILL, Z_CLOUD = "till", "cloud"

#: The roles that set up shops (`POST /shops`) — and so may choose a shop's work profile.
MANAGER_ROLES = (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR, UserRole.COMPANY_MANAGER)

#: The profile's values in the services' own words.
SHOP_Z_FROM_OPTION = {
    T.FROM_MAIN: "הקופה הראשית בלבד",
    T.FROM_MAIN_AND_DASHBOARD: "הקופה הראשית והדשבורד",
    T.FROM_ANY: "כל קופה בסניף והדשבורד",
}
KITCHEN_VALUES = {
    T.KITCHEN_PRINTER: {"enabled": False},
    T.KITCHEN_KDS: {"enabled": True, "targets": ["kds"]},
    T.KITCHEN_BOTH: {"enabled": True, "targets": ["printer", "kds"]},
}

#: The refusals of the Z switch that carry no Hebrew of their own (app/services/till_z.py).
_Z_MESSAGES = {
    "till_open": "יש קופה פתוחה: {label} (משמרת פתוחה). סוג ה-Z משתנה רק כשהקופה סגורה — סגרו את המשמרת ונסו שוב.",
    "z_in_progress": "יש Z בתהליך ב{label}. סוג ה-Z לא משתנה באמצע הפקת Z — המתינו לסיומו ונסו שוב.",
    "remote_close_pending": "סגירת המשמרת מרחוק ב{label} עוד לא הסתיימה. המתינו לה, ואז נסו שוב.",
    "unreported_shifts": (
        "ב{label} יש {count} משמרות סגורות שעוד לא נכללו ב-Z. כל אחת נסגרה לפי סוג ה-Z הקודם — "
        "הפיקו להן Z, ואז שנו את סוג ה-Z."
    ),
    "super_admin_only": "רק מנהל-על משנה את סוג ה-Z ואת השרת המקומי בסניף שיש בו קופות.",
    "z_run_in_progress": "יש Z סניפי בתהליך — המתינו לסיומו, ואז שנו את הקופה הראשית.",
}


class WorkProfileRefused(Exception):
    """A refusal: answered as `{detail: body}` with its status (Hebrew `message`)."""

    def __init__(self, status_code: int, body: Dict[str, Any]):
        super().__init__(body.get("code"))
        self.status_code = status_code
        self.body = body

    def http(self) -> HTTPException:
        return HTTPException(status_code=self.status_code, detail=self.body)


def _refused(code: str, message: str, field_: Optional[str], status_code: int = status.HTTP_409_CONFLICT,
             **extra) -> WorkProfileRefused:
    body: Dict[str, Any] = {"code": code, "message": message}
    if field_ is not None:
        body["field"] = field_
    body.update({k: v for k, v in extra.items() if v is not None})
    return WorkProfileRefused(status_code, body)


def invalid(exc: T.ProfileInvalid) -> HTTPException:
    """A profile that is not one: 422 with the field, the value and what it may be (Hebrew)."""
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.body())


def _label(machine: Optional[POSMachine]) -> str:
    from app.services.independent_till import till_label

    return till_label(machine) if machine is not None else "הקופה"


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


#: Reading a switch's rules for the status reason (`independent_till.check_switch` asks for the
#: super admin before the rules): only ever passed to a check, never to a write.
_RULES_ONLY = SimpleNamespace(role=UserRole.SUPER_ADMIN, id=None, email=None, username=None)


# ── The shop as it stands ─────────────────────────────────────────────────────


@dataclass
class ShopState:
    shop: Shop
    company: Optional[Company]
    tenant: Any
    #: Seated fiscal devices: the tills and the kiosks (never a KDS / the board).
    tills: List[POSMachine] = field(default_factory=list)
    kiosk_ids: Set[Any] = field(default_factory=set)
    main: Optional[POSMachine] = None
    local_network: bool = False
    local_mode: bool = False
    #: The till parameters as they stand for the shop itself.
    params: Dict[str, Any] = field(default_factory=dict)
    #: Tenant → company → shop settings.
    merged: Dict[str, Any] = field(default_factory=dict)
    kitchen_raw: Dict[str, Any] = field(default_factory=dict)
    #: The tills that may become the main till, best first (Android, in the LAN group, not a kiosk).
    main_candidates: List[POSMachine] = field(default_factory=list)

    def is_kiosk(self, machine: POSMachine) -> bool:
        return machine.id in self.kiosk_ids


def _z_mode(machine: POSMachine) -> str:
    return Z_TILL if getattr(machine, "z_mode", None) == Z_TILL else Z_CLOUD


def _independent(machine: POSMachine) -> bool:
    return bool(getattr(machine, "independent_till", False))


def read_state(db: Session, shop: Shop) -> ShopState:
    from app.models.kiosk import KioskDevice
    from app.models.tenant import Tenant
    from app.services import display_devices as DD
    from app.services import kds_workflow as WF
    from app.services import lan_server as LS
    from app.services import local_shop_z as LZ
    from app.services import main_till as MT
    from app.services import z_runs as ZR
    from app.services.settings_merge import merge_all_settings_layers
    from app.services.till_parameters import ensure_builtin_parameters, resolve_for_shop

    ensure_builtin_parameters(db)
    company = db.get(Company, shop.company_id) if shop.company_id is not None else None
    tenant = db.get(Tenant, shop.tenant_id) if shop.tenant_id is not None else None
    tills = sorted(
        [m for m in ZR.shop_tills(db, shop.id) if ZR.is_seated_in(m, shop.id)], key=MT.till_order,
    )
    kiosk_ids: Set[Any] = set()
    if tills:
        kiosk_ids = {
            row[0] for row in db.query(KioskDevice.machine_id)
            .filter(KioskDevice.machine_id.in_([m.id for m in tills]), KioskDevice.home_role.is_(None))
            .all()
        }
    main = MT.main_till_of_shop(db, shop.id)
    candidates = [
        m for m in LS.server_candidates(db, tills)
        if m.id not in kiosk_ids and DD.platform_of(m) == DD.PLATFORM_ANDROID
    ]
    merged = merge_all_settings_layers(company, shop, tenant) if company is not None else dict(shop.settings or {})
    return ShopState(
        shop=shop,
        company=company,
        tenant=tenant,
        tills=tills,
        kiosk_ids=kiosk_ids,
        main=main,
        local_network=bool(getattr(shop, "local_network", False)),
        local_mode=LZ.local_mode_of_shop(db, shop),
        params=resolve_for_shop(db, shop),
        merged=merged,
        kitchen_raw=WF.level_view(db, "shop", shop.id)["raw"],
        main_candidates=sorted(candidates, key=MT.till_order),
    )


# ── Each field as the shop has it now ─────────────────────────────────────────


def _tables_now(state: ShopState) -> str:
    from app.services.tables import TABLES_MODE_KEY, mode_of

    return mode_of(state.params.get(TABLES_MODE_KEY))


def kitchen_of(raw: Dict[str, Any]) -> str:
    from app.services import kds_workflow as WF

    if raw.get("enabled") is not True:
        return T.KITCHEN_PRINTER
    targets = WF._csv(raw.get("targets"))
    kds = any(t in ("kds", "kds_view") for t in targets)
    if kds and "printer" in targets:
        return T.KITCHEN_BOTH
    return T.KITCHEN_KDS if kds else T.KITCHEN_PRINTER


def _customer_display_now(state: ShopState) -> bool:
    from app.services import customer_display as CD

    layers = []
    if state.company is not None:
        layers.append(("company", CD.layer_of(state.company.settings)))
    layers.append(("shop", CD.layer_of(state.shop.settings)))
    effective, _ = CD.resolve(layers)
    return bool(effective.get("enabled"))


def _tips_enabled(merged: Dict[str, Any]) -> bool:
    from app.services.payment_options import legacy_tip_flags, resolve_payment_options

    return bool(legacy_tip_flags(resolve_payment_options(merged))["tipsEnabled"])


def _tips_now(state: ShopState) -> Dict[str, Any]:
    distribution = state.merged.get("tipDistribution")
    return {
        "enabled": _tips_enabled(state.merged),
        "distribution": distribution if distribution in T.TIP_DISTRIBUTIONS else "direct",
    }


def _vouchers_now(state: ShopState) -> Dict[str, Any]:
    from app.services import voucher_balance_check as VB
    from app.services import voucher_station_settings as VS

    return {
        "station": VS.resolve_voucher_station(state.merged)[VS.VOUCHER_STATION_KEY] == VS.ON,
        "balanceCheck": VB.resolve_mode(state.merged),
    }


def _shop_z_from_now(state: ShopState) -> str:
    from app.services import main_till as MT

    value = state.params.get(MT.SHOP_Z_FROM_KEY)
    by_option = {v: k for k, v in SHOP_Z_FROM_OPTION.items()}
    return by_option.get(value, T.FROM_MAIN)


def _shop_z_tills(state: ShopState) -> List[POSMachine]:
    return [m for m in state.tills if not _independent(m)]


def _z_type_now(state: ShopState) -> str:
    if state.tills:
        in_shop_z = _shop_z_tills(state)
        if all(_z_mode(m) == Z_TILL for m in in_shop_z):
            return T.Z_PER_TILL
        return T.Z_SHOP_LOCAL if state.local_mode else T.Z_SHOP_CLOUD
    return T.Z_SHOP_LOCAL if state.local_network else T.Z_SHOP_CLOUD


def current_values(state: ShopState) -> Dict[str, Any]:
    """The shop's configuration now, as a profile (no template)."""
    z_type = _z_type_now(state)
    return {
        "templateId": None,
        "zType": z_type,
        "shopZFrom": _shop_z_from_now(state),
        "localServer": z_type == T.Z_SHOP_LOCAL,
        "tablesMode": _tables_now(state),
        "kitchen": kitchen_of(state.kitchen_raw),
        "customerDisplay": _customer_display_now(state),
        "attendance": state.params.get("attendanceEnabled") is True,
        "tips": _tips_now(state),
        "vouchers": _vouchers_now(state),
    }


def stored_profile(shop: Optional[Shop]) -> Optional[Dict[str, Any]]:
    return T.stored(shop.settings) if shop is not None else None


def profile_of(db: Session, shop: Shop, state: Optional[ShopState] = None) -> Dict[str, Any]:
    """The shop's profile: as stored, else its configuration as it stands."""
    saved = stored_profile(shop)
    if saved is not None:
        return saved
    return current_values(state or read_state(db, shop))


# ── Who may ───────────────────────────────────────────────────────────────────


def may_manage(db: Session, user: Any, shop: Shop) -> bool:
    """Whoever may set up shops, for this shop: the super admin, a distributor, its company's manager."""
    from app.services.company_hierarchy import user_covers_shop

    role = getattr(user, "role", None)
    if role in (UserRole.SUPER_ADMIN, UserRole.DISTRIBUTOR):
        return True
    if role == UserRole.COMPANY_MANAGER:
        return bool(user_covers_shop(db, user, shop))
    return False


def can_edit(db: Session, user: Any, shop: Shop, state: ShopState) -> Dict[str, bool]:
    """Per field: may this user change it now (spec §5)."""
    manage = may_manage(db, user, shop)
    super_admin = getattr(user, "role", None) == UserRole.SUPER_ADMIN
    out: Dict[str, bool] = {}
    for name in T.FIELDS:
        if not manage:
            out[name] = False
        elif name in T.Z_FIELDS and state.tills and not super_admin:
            out[name] = False
        else:
            out[name] = True
    return out


# ── The rules of the Z switch, as reasons ─────────────────────────────────────


def _switch_refusal(db: Session, machine: POSMachine, mode: str, now: datetime) -> Optional[Dict[str, Any]]:
    """
    Why `machine` cannot switch to Z `mode` now — `{code, message, …}` — by the rules of
    `z_mode_policy.check_switch` and `till_z.set_z_mode` (the super admin's alone aside), or None.
    """
    from app.models.shift import Shift, ShiftStatus
    from app.models.till_z_request import TillZRequest
    from app.services import independent_till as IT
    from app.services import shift_close_requests as close_requests
    from app.services import till_z

    if _z_mode(machine) == mode:
        return None
    label = _label(machine)
    ref = {"machineId": str(machine.id), "posNumber": machine.pos_number}
    try:
        till_z.refuse_while_producing_offline(db, machine, now=now)
    except till_z.TillZRefused as refused:
        return {"code": refused.body.get("detail"), "message": refused.body.get("message"), **ref}
    if IT.is_independent(machine) and mode == Z_CLOUD:
        return {
            "code": "independent_till", **ref,
            "message": f"{label} מוגדרת כקופה עצמאית — מצרפים אותה ל-Z הסניפי בכרטיס \"קופות בזד הסניפי\" בדף הסניף.",
        }
    open_shift = (
        db.query(Shift.id).filter(Shift.machine_id == machine.id, Shift.status == ShiftStatus.OPEN).first()
    )
    if open_shift is not None:
        return {"code": "till_open", "message": _Z_MESSAGES["till_open"].format(label=label), **ref}
    pending = (
        till_z._pending_query(db, machine.id).filter(TillZRequest.expires_at >= now).first()
    )
    if till_z.live_z_run_item(db, machine.id) is not None or pending is not None:
        return {"code": "z_in_progress", "message": _Z_MESSAGES["z_in_progress"].format(label=label), **ref}
    if close_requests._pending_query(db, machine.id).filter_by(wait_for_rest=True).first() is not None:
        return {"code": "remote_close_pending", "message": _Z_MESSAGES["remote_close_pending"].format(label=label), **ref}
    count = till_z.unreported_closed_count(db, machine.id)
    if count and not (mode == Z_CLOUD and till_z._has_reconstructed_unreported(db, machine.id)):
        if till_z.waiting_shifts_all_empty(db, machine) is None:
            return {
                "code": "unreported_shifts", "count": count, **ref,
                "message": _Z_MESSAGES["unreported_shifts"].format(label=label, count=count),
            }
    return None


def _independence_refusal(db: Session, machine: POSMachine) -> Optional[Dict[str, Any]]:
    """Why a kiosk cannot get its own Z ("קיוסק עם Z משלו": independent) now, or None."""
    from app.services import independent_till as IT
    from app.services import till_z

    try:
        IT.check_switch(db, _RULES_ONLY, machine, True)
    except (IT.IndependentSwitchRefused, till_z.TillZRefused) as refused:
        body = refused.body
        return {"code": body.get("detail"), "message": body.get("message"), "machineId": str(machine.id)}
    return None


def _producer_refusal(db: Session, shop: Shop, local_after: bool, main_after: Optional[POSMachine],
                      now: datetime) -> Optional[Dict[str, Any]]:
    """
    Why the shop's Z production cannot move where this save takes it (the producer's guard,
    docs/SPEC_INDEPENDENT_TILL.md §8.10), or None — read, nothing pinned.
    """
    from app.services import local_shop_z as LZ

    target = (
        {"kind": LZ.LOCAL, "machineId": str(main_after.id)} if local_after and main_after is not None
        else {"kind": LZ.CLOUD, "machineId": None}
    )
    pin = LZ._pin(shop) or LZ.configured_producer(db, shop)
    if LZ._same(pin, target):
        return None
    busy = LZ.producer_busy(db, shop, pin, now=now)
    if busy is None:
        return None
    return {
        "code": LZ.BUSY,
        "reason": busy.get("reason"),
        "message": "לא ניתן להעביר עכשיו את הפקת ה-Z הסניפי: " + busy["message"],
    }


def _live_z_run(db: Session, shop: Shop) -> bool:
    from app.models.z_run import ZRun, ZRunStatus

    return (
        db.query(ZRun.id)
        .filter(ZRun.shop_id == shop.id, ZRun.status.in_([ZRunStatus.WAITING, ZRunStatus.BUILDING]))
        .first()
        is not None
    )


# ── Status ────────────────────────────────────────────────────────────────────


def _applied() -> Dict[str, Any]:
    return {"state": APPLIED}


def _pending(reason: str) -> Dict[str, Any]:
    return {"state": PENDING, "reason": reason}


def _blocked(reason: str) -> Dict[str, Any]:
    return {"state": BLOCKED, "reason": reason}


def _local_status(db: Session, state: ShopState, want: bool, now: datetime) -> Dict[str, Any]:
    """"שרת מקומי": the shop's main till with "רשת מקומית" on (local mode) — or not."""
    if want:
        if state.local_mode:
            return _applied()
        if not state.tills:
            return _pending(FIRST_TILL)
        if state.main is None:
            if not state.main_candidates:
                return _pending(WAIT_MAIN)
            candidate = state.main_candidates[0]
            if _live_z_run(db, state.shop):
                return _blocked(_Z_MESSAGES["z_run_in_progress"])
            busy = _producer_refusal(db, state.shop, True, candidate, now)
            if busy:
                return _blocked(busy["message"])
            # A main till is there to be had: a super admin's save makes it one.
            return _pending(WAIT_SUPER_ADMIN)
        busy = _producer_refusal(db, state.shop, True, state.main, now)
        if busy:
            return _blocked(busy["message"])
        # "רשת מקומית" is off: a super admin's save turns it on.
        return _pending(WAIT_SUPER_ADMIN)
    if not state.local_network:
        return _applied()
    busy = _producer_refusal(db, state.shop, False, None, now)
    if busy:
        return _blocked(busy["message"])
    # "רשת מקומית" is on: a super admin's save turns it off.
    return _pending(WAIT_SUPER_ADMIN)


def _z_status(db: Session, state: ShopState, profile: Dict[str, Any], now: datetime) -> Dict[str, Any]:
    if not state.tills:
        return _pending(FIRST_TILL)
    want = profile["zType"]
    mode = Z_TILL if want == T.Z_PER_TILL else Z_CLOUD
    for machine in state.tills:
        if want != T.Z_PER_TILL and _independent(machine):
            continue  # "קופה עצמאית": the device's own choice, outside the shop Z
        if _z_mode(machine) == mode:
            continue
        if mode == Z_TILL and state.is_kiosk(machine):
            why = _independence_refusal(db, machine)
        else:
            why = _switch_refusal(db, machine, mode, now)
        if why is not None:
            return _blocked(why["message"])
        # Paired by someone other than a super admin (it stays "לפי הסניף"), or changed on its own
        # page: a super admin's save switches it.
        return _pending(WAIT_SUPER_ADMIN)
    if want == T.Z_SHOP_LOCAL and not state.local_mode:
        return _local_status(db, state, True, now)
    if want == T.Z_SHOP_CLOUD and state.local_mode:
        return _local_status(db, state, False, now)
    return _applied()


def _differs(name: str, now_value: Any) -> Dict[str, Any]:
    return _blocked(f"בסניף מוגדר כרגע \"{T.value_label(name, now_value)}\". שמירת התצורה תחיל את הערך שבחרתם.")


def status_of(db: Session, state: ShopState, profile: Dict[str, Any], *, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = _now(now)
    current = current_values(state)
    out: Dict[str, Any] = {
        "zType": _z_status(db, state, profile, now),
        "localServer": _local_status(db, state, profile["localServer"], now),
    }
    for name in ("shopZFrom", "tablesMode", "kitchen", "customerDisplay", "attendance", "tips", "vouchers"):
        out[name] = _applied() if current[name] == profile[name] else _differs(name, current[name])
    return out


def view(db: Session, user: Any, shop: Shop, *, state: Optional[ShopState] = None) -> Dict[str, Any]:
    """`GET /shops/{id}/work-profile`: `{profile, status, canEdit}` (and `stored`, `hasTills`)."""
    state = state or read_state(db, shop)
    saved = stored_profile(shop)
    profile = saved if saved is not None else current_values(state)
    return {
        "shopId": str(shop.id),
        "profile": profile,
        "stored": saved is not None,
        "hasTills": bool(state.tills),
        "status": status_of(db, state, profile),
        "canEdit": can_edit(db, user, shop, state),
    }


# ── Applying ──────────────────────────────────────────────────────────────────


@dataclass
class Applied:
    """What a save wrote, for the notifications after the commit."""

    changes: List[str] = field(default_factory=list)
    parameters: bool = False
    settings: bool = False
    review_before: Any = None


def _audit(db: Session, user: Any, key: str, scope_type: str, scope_id: Any, old: Any, new: Any, now: datetime) -> None:
    from app.services import till_parameter_audit as AUDIT

    AUDIT.record_change(
        db, parameter=SimpleNamespace(id=None, key=key), scope_type=scope_type, scope_id=scope_id,
        action=AUDIT.CLEAR if new is None else AUDIT.SET, old_value=old, new_value=new, user=user, now=now,
    )


def _parameter(db: Session, key: str):
    from app.models.till_parameter import TillParameter
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(db)
    return db.query(TillParameter).filter(TillParameter.key == key).first()


def _checked_param_value(db: Session, key: str, value: Any, field_: str):
    """The parameter and `value` as it takes it — or a refusal naming the field."""
    from app.services.till_parameters import TillParameterValueError, validate_value

    parameter = _parameter(db, key)
    if parameter is None:  # pragma: no cover - built in
        raise _refused("work_profile_parameter_missing", f"הפרמטר {key} לא קיים.", field_)
    try:
        return parameter, validate_value(parameter.value_type, value, parameter.enum_options)
    except TillParameterValueError as exc:
        raise _refused(
            "work_profile_value_not_in_parameter",
            f"הערך \"{value}\" לא קיים בפרמטר \"{parameter.label}\" — האפשרויות שלו שונו בדף הפרמטרים.",
            field_, status.HTTP_422_UNPROCESSABLE_ENTITY, value=value,
            allowed=list(parameter.enum_options or []) or None,
        ) from exc


def _tables_option(db: Session, mode: str) -> Optional[str]:
    """The `tablesMode` option (Hebrew, as the super admin worded it) for a mode."""
    from app.services.tables import TABLES_MODE_KEY, mode_of

    parameter = _parameter(db, TABLES_MODE_KEY)
    options = list(parameter.enum_options or []) if parameter is not None else []
    return next((o for o in options if mode_of(o) == mode), None)


_KITCHEN_ISSUES = {
    "kds_target_without_device": (
        "אין בסניף מסך מטבח (KDS) פעיל של תחנה, ותצורת המטבח שהסניף יורש היא \"תהליך הזמנה\" — שם ההזמנות "
        "חייבות תחנת KDS. הוסיפו מסך מטבח בדף \"מסכי מטבח\" ושמרו שוב, או בחרו \"בונים במדפסת\"."
    ),
}


def _settings_patch(state: ShopState, profile: Dict[str, Any]) -> Dict[str, Any]:
    """The shop's settings keys the tips and the vouchers need written (empty: as they are)."""
    from app.services import voucher_balance_check as VB
    from app.services import voucher_station_settings as VS
    from app.services.payment_options import PAYMENT_OPTIONS, asks_for_tip, is_allowed

    patch: Dict[str, Any] = {}
    tips_now = _tips_now(state)
    want = profile["tips"]
    if tips_now["enabled"] != want["enabled"]:
        patch["tipsEnabled"] = want["enabled"]
        if not want["enabled"]:
            # Off everywhere: an option the company asks a tip on is turned off here.
            merged = {**state.merged, **patch}
            for option in PAYMENT_OPTIONS:
                if asks_for_tip(merged, option):
                    patch[option.tips_key] = False
        else:
            merged = {**state.merged, **patch}
            if not _tips_enabled(merged):
                # The company turned the tips off option by option: on here for the card options.
                for option in PAYMENT_OPTIONS:
                    if option.tender == "card" and is_allowed(merged, option):
                        patch[option.tips_key] = True
                if not _tips_enabled({**state.merged, **patch}):
                    for option in PAYMENT_OPTIONS:
                        if is_allowed(merged, option):
                            patch[option.tips_key] = True
    if tips_now["distribution"] != want["distribution"]:
        patch["tipDistribution"] = want["distribution"]
    vouchers_now = _vouchers_now(state)
    if vouchers_now["station"] != profile["vouchers"]["station"]:
        patch[VS.VOUCHER_STATION_KEY] = VS.ON if profile["vouchers"]["station"] else VS.OFF
    if vouchers_now["balanceCheck"] != profile["vouchers"]["balanceCheck"]:
        patch[VB.VOUCHER_BALANCE_CHECK_KEY] = profile["vouchers"]["balanceCheck"]
    return patch


def _from_service(db: Session, exc: Exception, field_: str) -> WorkProfileRefused:
    """A service's refusal as the profile's: its code, its Hebrew (ours when it has none), the field."""
    status_code = getattr(exc, "status_code", status.HTTP_409_CONFLICT)
    body = getattr(exc, "body", None)
    if isinstance(exc, HTTPException):
        detail = exc.detail
        body = detail if isinstance(detail, dict) else {"detail": detail}
    body = dict(body or {})
    code = body.pop("detail", None) or body.pop("code", None) or "work_profile_refused"
    if isinstance(code, dict):  # a work-config refusal carrying a service's `{code, message}`
        body.setdefault("message", code.get("message"))
        code = code.get("code") or "work_profile_refused"
    message = body.pop("message", None)
    if not message:
        machine = None
        try:
            machine = db.get(POSMachine, uuid.UUID(str(body["machineId"]))) if body.get("machineId") else None
        except (ValueError, TypeError):
            machine = None
        message = _Z_MESSAGES.get(str(code), "השינוי נחסם ({code}).").format(
            label=_label(machine), count=body.get("count", ""), code=code,
        )
    body.pop("step", None)
    return _refused(str(code), message, field_, status_code, **body)


@dataclass
class TillPlan:
    """What the Z and the local server write on the shop's tills — checked, nothing written yet."""

    mode: str = Z_CLOUD
    z_switch: List[POSMachine] = field(default_factory=list)
    kiosks_own: List[POSMachine] = field(default_factory=list)
    new_main: Optional[POSMachine] = None
    local_on: bool = False
    local_off: bool = False


def _plan_tills(db: Session, state: ShopState, profile: Dict[str, Any], now: datetime) -> TillPlan:
    """
    The tills' part of a save, every rule checked up front (`WorkProfileRefused` naming the till):
    each till of the shop Z to the profile's Z mode (a kiosk to "קיוסק עם Z משלו" under "Z לכל
    קופה"; an independent till stays its own), and "רשת מקומית" on — with the first Android till as
    the main till when there is none (none yet: it waits) — or off.
    """
    from app.services import work_config as WC

    shop = state.shop
    plan = TillPlan(mode=Z_TILL if profile["zType"] == T.Z_PER_TILL else Z_CLOUD)
    for machine in state.tills:
        if _z_mode(machine) == plan.mode or (plan.mode == Z_CLOUD and _independent(machine)):
            continue
        if plan.mode == Z_TILL and state.is_kiosk(machine):
            why = _independence_refusal(db, machine)
            if why:
                raise _refused(why.pop("code") or "independent_switch_refused", why.pop("message"), "zType", **why)
            plan.kiosks_own.append(machine)
            continue
        why = _switch_refusal(db, machine, plan.mode, now)
        if why:
            raise _refused(why.pop("code"), why.pop("message"), "zType", **why)
        plan.z_switch.append(machine)
    if profile["localServer"]:
        if state.main is None and state.main_candidates:
            candidate = state.main_candidates[0]
            if _live_z_run(db, shop):
                raise _refused("z_run_in_progress", _Z_MESSAGES["z_run_in_progress"], "localServer")
            # The preset's own refusals (a device that cannot serve), before anything is written.
            why = WC.unavailable(WC.context_for_machine(db, candidate), WC.PRESETS[WC.MAIN_TILL])
            if why is not None:
                raise _refused(why[0], why[1], "localServer", machineId=str(candidate.id))
            busy = _producer_refusal(db, shop, True, candidate, now)
            if busy:
                raise _refused(busy.pop("code"), busy.pop("message"), "localServer", **busy)
            plan.new_main = candidate
        elif state.main is not None and not state.local_network:
            busy = _producer_refusal(db, shop, True, state.main, now)
            if busy:
                raise _refused(busy.pop("code"), busy.pop("message"), "localServer", **busy)
            plan.local_on = True
    elif state.local_network:
        busy = _producer_refusal(db, shop, False, None, now)
        if busy:
            raise _refused(busy.pop("code"), busy.pop("message"), "localServer", **busy)
        plan.local_off = True
    return plan


def apply_profile(
    db: Session, user: Any, shop: Shop, raw_profile: Any, *, now: Optional[datetime] = None,
) -> Applied:
    """
    Save the shop's work profile: checked (422 `ProfileInvalid`), allowed per field (403), every
    refusal found before anything is written (409), then written through each value's own
    service — flushed, not committed: the caller commits, or rolls back on `WorkProfileRefused`.
    """
    from app.services import customer_display as CD
    from app.services import kds_workflow as WF
    from app.services import menu_broadcast as MB
    from app.services import work_config as WC

    profile = T.validate(raw_profile)
    now = _now(now)
    state = read_state(db, shop)
    current = profile_of(db, shop, state)
    allowed = can_edit(db, user, shop, state)
    denied = [name for name in T.FIELDS if profile[name] != current[name] and not allowed[name]]
    if denied:
        names = ", ".join(T.LABELS[n] for n in denied)
        if not may_manage(db, user, shop):
            message = "תצורת העבודה של הסניף נקבעת על ידי מנהל-על, מפיץ או מנהל החברה."
        else:
            message = (
                f"בסניף יש כבר קופות: רק מנהל-על משנה את {names}. אפשר לשנות כאן את שאר השדות "
                "(שולחנות, מטבח, מסך לקוח, נוכחות, טיפים ושוברים)."
            )
        raise _refused("work_profile_forbidden", message, denied[0], status.HTTP_403_FORBIDDEN, fields=denied)
    values_now = current_values(state)

    def wanted(name: str) -> bool:
        return allowed[name] and profile[name] != values_now[name]

    # ── 1. What to write, each refusal found first ──
    shop_z_from = None
    if wanted("shopZFrom"):
        shop_z_from = _checked_param_value(db, "shopZFrom", SHOP_Z_FROM_OPTION[profile["shopZFrom"]], "shopZFrom")
    attendance = None
    if wanted("attendance"):
        attendance = _checked_param_value(db, "attendanceEnabled", profile["attendance"], "attendance")
    tables_option = None
    if wanted("tablesMode") and profile["tablesMode"] != T.TABLES_OFF:
        tables_option = _tables_option(db, profile["tablesMode"])
        if tables_option is None:
            raise _refused(
                "work_profile_value_not_in_parameter",
                f"האפשרות \"{T.value_label('tablesMode', profile['tablesMode'])}\" לא קיימת בפרמטר \"ניהול שולחנות\" "
                "— האפשרויות שלו שונו בדף הפרמטרים.",
                "tablesMode", status.HTTP_422_UNPROCESSABLE_ENTITY, value=profile["tablesMode"],
            )
    kitchen = None
    if wanted("kitchen"):
        kitchen = dict(KITCHEN_VALUES[profile["kitchen"]])
        check = WF.level_view(db, "shop", shop.id, pending=kitchen)
        if check["errors"]:
            codes = [e["code"] for e in check["errors"]]
            message = next(
                (_KITCHEN_ISSUES[c] for c in codes if c in _KITCHEN_ISSUES),
                f"הגדרות המטבח (KDS) של הסניף לא מתאימות ל\"{T.value_label('kitchen', profile['kitchen'])}\" "
                f"({', '.join(codes)}). בדקו את \"תצורת מטבח\" בדף הסניף.",
            )
            raise _refused("work_profile_kitchen_invalid", message, "kitchen", errors=check["errors"])
    display_layer = None
    if wanted("customerDisplay"):
        try:
            display_layer = CD.clean_layer(
                {**CD.layer_of(shop.settings), "enabled": profile["customerDisplay"]}, level="shop",
            )
        except CD.CustomerDisplayError as exc:
            raise _refused(
                "work_profile_customer_display_invalid",
                f"הגדרות מסך הלקוח של הסניף לא תקינות: {getattr(exc, 'message', exc)}",
                "customerDisplay",
            ) from exc
    patch: Dict[str, Any] = {}
    if allowed["tips"] or allowed["vouchers"]:
        full = _settings_patch(state, profile)
        tip_keys = {k for k in full if k.startswith("tip") or k.startswith("pay")}
        patch = {k: v for k, v in full.items() if (k in tip_keys and allowed["tips"]) or (k not in tip_keys and allowed["vouchers"])}

    # The tills: the Z and the local server (a super admin's, once there are tills). Changed in
    # this save — a refusal refuses the save; as saved before but not applied yet (a till that
    # was open) — tried again, and left waiting with its reason if it still cannot be.
    till_plan = TillPlan()
    if state.tills and allowed["zType"] and allowed["localServer"]:
        changing = profile["zType"] != current["zType"] or profile["localServer"] != current["localServer"]
        try:
            till_plan = _plan_tills(db, state, profile, now)
        except WorkProfileRefused:
            if changing:
                raise
            till_plan = TillPlan()
    z_switch, kiosks_own, new_main = till_plan.z_switch, till_plan.kiosks_own, till_plan.new_main
    local_on, local_off, mode = till_plan.local_on, till_plan.local_off, till_plan.mode

    # ── 2. Writing ──
    from app.services import lan_server as LS
    from app.services import local_shop_z as LZ
    from app.services import till_parameter_audit as AUDIT
    from app.services import till_z
    from app.services import voucher_redeem_settings as voucher_flow
    from app.services import z_mode_policy
    from app.services.independent_till import IndependentSwitchRefused
    from app.services.settings_merge import patch_settings_json, utc_now
    from app.services.till_parameters import write_value

    applied = Applied(review_before=MB.review_state(db, shop))
    guard = LZ.ProducerGuard(db, [shop], now=now)
    step = "zType"
    try:
        if local_off:
            step = "localServer"
            LS.set_local_network(db, user, shop, False, now=now)
            _audit(db, user, "localNetwork", "shop", shop.id, True, False, now)
            applied.changes.append("localNetwork")
        if z_switch:
            step = "zType"
            before = {m.id: _z_mode(m) for m in z_switch}
            for machine in z_mode_policy.switch_all(db, user, z_switch, mode):
                _audit(db, user, "zMode", "machine", machine.id, before[machine.id], mode, now)
            applied.changes.append("zMode")
        for kiosk in kiosks_own:
            step = "zType"
            WC.apply(db, user, kiosk, {"preset": WC.KIOSK_OWN_Z}, now=now)
            _audit(db, user, "zMode", "machine", kiosk.id, Z_CLOUD, Z_TILL, now)
            applied.changes.append("zMode")
        if new_main is not None:
            step = "localServer"
            WC.apply(db, user, new_main, {"preset": WC.MAIN_TILL, "enableLocalNetwork": True}, now=now)
            _audit(db, user, "mainTill", "machine", new_main.id, None, True, now)
            if not state.local_network:
                _audit(db, user, "localNetwork", "shop", shop.id, False, True, now)
            applied.changes.extend(["mainTill", "localNetwork"])
        if local_on:
            step = "localServer"
            LS.set_local_network(db, user, shop, True, now=now)
            _audit(db, user, "localNetwork", "shop", shop.id, False, True, now)
            applied.changes.append("localNetwork")
        if shop_z_from is not None:
            step = "shopZFrom"
            parameter, value = shop_z_from
            if write_value(db, parameter, "shop", shop.id, value, user=user, now=now):
                applied.changes.append("shopZFrom")
        if wanted("tablesMode"):
            step = "tablesMode"
            off = profile["tablesMode"] == T.TABLES_OFF
            if MB.write_shop_tables(db, shop, user, tables=not off, tables_mode=tables_option, now=now):
                applied.changes.append("tablesMode")
        if kitchen is not None:
            step = "kitchen"
            own_before = WF.values_at_scope(db, "shop", shop.id)
            WF.save_values(db, "shop", shop.id, kitchen)
            for name, value in kitchen.items():
                old = WF.to_parameter_value(name, own_before.get(name))
                new = WF.to_parameter_value(name, value)
                if old == new and type(old) is type(new):
                    continue
                # The workflow card's service writes no log of its own: written here, as
                # `work_config` does for a device's targets.
                AUDIT.record_change(
                    db, parameter=_parameter(db, WF.PARAM_KEYS[name]), scope_type="shop", scope_id=shop.id,
                    action=AUDIT.SET, old_value=old, new_value=new, user=user, now=now,
                )
            applied.changes.append("kitchen")
        if attendance is not None:
            step = "attendance"
            parameter, value = attendance
            if write_value(db, parameter, "shop", shop.id, value, user=user, now=now):
                applied.changes.append("attendance")
        if display_layer is not None:
            step = "customerDisplay"
            old = CD.layer_of(shop.settings).get("enabled")
            CD.write_layer(shop, "shop", display_layer)
            _audit(db, user, "customerDisplay.enabled", "shop", shop.id, old, profile["customerDisplay"], now)
            applied.changes.append("customerDisplay")
            applied.settings = True
        if patch:
            step = "tips" if any(k.startswith(("tip", "pay")) for k in patch) else "vouchers"
            stored_before = dict(shop.settings or {})
            voucher_flow.audit_patch(db, "shop", shop, patch, user)
            audited = set(voucher_flow._audited_keys())
            for key, value in patch.items():
                if key not in audited:
                    _audit(db, user, key, "shop", shop.id, stored_before.get(key), value, now)
            shop.settings = patch_settings_json(shop.settings, patch)
            shop.settings_updated_at = utc_now()
            applied.changes.extend(sorted({"tips" if k.startswith(("tip", "pay")) else "vouchers" for k in patch}))
            applied.settings = True
        # ── 3. The profile itself ──
        step = "profile"
        before_profile = stored_profile(shop)
        if before_profile != profile:
            settings = dict(shop.settings or {})
            settings[T.SETTINGS_KEY] = copy.deepcopy(profile)
            shop.settings = settings  # a new dict: the JSONB change is seen
            _audit(db, user, T.SETTINGS_KEY, "shop", shop.id, before_profile, profile, now)
            applied.changes.append(T.SETTINGS_KEY)
        db.flush()
        guard.check(user=user)
    except WorkProfileRefused:
        raise
    except (WC.WorkConfigRefused, IndependentSwitchRefused, LZ.LocalShopZRefused, till_z.TillZRefused,
            HTTPException) as exc:
        raise _from_service(db, exc, step) from exc
    applied.parameters = any(c not in ("customerDisplay", "tips", "vouchers", T.SETTINGS_KEY) for c in applied.changes)
    logger.info(
        "work profile: shop %s by %s — %s", shop.id,
        getattr(user, "email", None) or getattr(user, "id", None), ", ".join(applied.changes) or "nothing",
    )
    return applied


def after_commit(db: Session, shop: Shop, applied: Applied) -> List[Any]:
    """
    After the commit: the menu's review mode follows the tables (its first publication, or the
    open one closed — commits), the shop's tills pull their settings. The parameter notify
    targets, for the caller to publish (in the background).
    """
    from app.services import menu_broadcast as MB
    from app.services import till_parameters as TP
    from app.services.settings_notify import notify_machines_for_shop_settings

    if applied.review_before is not None:
        try:
            MB.settle_review(db, shop, applied.review_before, MB.review_state(db, shop))
        except Exception:  # noqa: BLE001 - the profile stands; the publication is made on the next pull
            db.rollback()
            logger.exception("work profile: menu review publication for shop %s failed", shop.id)
    if applied.settings:
        try:
            notify_machines_for_shop_settings(db, str(shop.id), reason="work_profile_updated")
        except Exception:  # noqa: BLE001 - the tills poll anyway
            logger.warning("work profile: settings notify for shop %s failed", shop.id)
    if applied.parameters:
        return TP.notify_targets_for_scope(db, "shop", shop.id)
    return []


def apply_on_create(db: Session, user: Any, shop: Shop, profile: Dict[str, Any]) -> Dict[str, Any]:
    """
    A new shop's profile (`POST /shops`), applied as a save is — after the shop itself was
    committed. A refusal never fails the creation: nothing of the profile is written, and the
    answer says why (`applied: false`, `refused`).
    """
    from app.services import till_parameters as TP

    try:
        applied = apply_profile(db, user, shop, profile)
    except WorkProfileRefused as refused:
        db.rollback()
        out = view(db, user, shop)
        out.update(applied=False, refused={"status": refused.status_code, **refused.body})
        db.commit()
        return out
    except T.ProfileInvalid as exc:
        db.rollback()
        out = view(db, user, shop)
        out.update(applied=False, refused={"status": status.HTTP_422_UNPROCESSABLE_ENTITY, **exc.body()})
        db.commit()
        return out
    db.commit()
    targets = after_commit(db, shop, applied)
    if targets:
        TP.publish_parameters_notify(targets)
    out = view(db, user, shop)
    out["applied"] = True
    db.commit()
    return out


# ── "הוספת מכשיר": what the profile suggests for a device ─────────────────────

_REASONS = {
    "main_first": (
        "הקופה הראשונה בסניף: לפי תצורת העבודה של הסניף (Z סניפי בשרת מקומי) היא תהיה הקופה הראשית, "
        "והרשת המקומית תופעל איתה."
    ),
    "main_is": "זו הקופה הראשית של הסניף (שרת מקומי).",
    "lan_member": (
        "לפי תצורת העבודה של הסניף (Z סניפי בשרת מקומי): קופה ברשת המקומית, שנסגרת דרך הקופה הראשית."
    ),
    "remote": (
        "מכשיר Windows / דפדפן לא מתחבר לרשת המקומית: לפי תצורת העבודה של הסניף הוא בזד הסניפי ונסגר דרך הענן."
    ),
    "cloud": "לפי תצורת העבודה של הסניף (Z סניפי מהענן): הקופה בזד הסניפי.",
    "cloud_until_main": (
        "לפי תצורת העבודה של הסניף (Z סניפי בשרת מקומי) — אבל רק קופת אנדרואיד יכולה להיות הקופה הראשית. "
        "עד שתצומד אחת, המכשיר בזד הסניפי מהענן."
    ),
    "own_z": "לפי תצורת העבודה של הסניף (Z לכל קופה): הקופה מפיקה Z משלה.",
    "kiosk_own_z": "לפי תצורת העבודה של הסניף (Z לכל קופה): הקיוסק מפיק Z משלו.",
    "kiosk_shop_z": "לפי תצורת העבודה של הסניף (Z סניפי): הקיוסק בזד הסניפי.",
}


def _offer(ctx, preset_id: str, reason: str, **plan) -> Optional[Dict[str, Any]]:
    from app.services import work_config as WC

    if WC.unavailable(ctx, WC.PRESETS[preset_id]) is not None:
        return None
    return {"preset": preset_id, "plan": {"preset": preset_id, **plan}, "reason": _REASONS[reason]}


def suggest(db: Session, shop: Optional[Shop], ctx) -> Optional[Dict[str, Any]]:
    """
    The preset the shop's profile gives a device (`ctx`, `work_config.Context`) — `{preset, plan,
    reason}` — or None: no profile, a display device, or no preset of the profile fits it.
    Only the existing presets, and only when available for the device (`work_config.unavailable`).
    """
    from app.services import work_config as WC

    profile = stored_profile(shop)
    if profile is None or ctx.shop is None or ctx.display:
        return None
    z_type = profile["zType"]
    if ctx.role == WC.ROLE_KIOSK:
        if z_type == T.Z_PER_TILL:
            return _offer(ctx, WC.KIOSK_OWN_Z, "kiosk_own_z")
        return _offer(ctx, WC.KIOSK_SHOP_Z, "kiosk_shop_z")
    if ctx.role != WC.ROLE_TILL:
        return None
    if z_type == T.Z_PER_TILL:
        return _offer(ctx, WC.OWN_Z, "own_z")
    if z_type == T.Z_SHOP_CLOUD:
        return _offer(ctx, WC.SHOP_Z_CLOUD, "cloud")
    # Z סניפי בשרת מקומי.
    if ctx.is_main_till:
        return _offer(ctx, WC.MAIN_TILL, "main_is")
    if ctx.main_till is None:
        if ctx.lan_client and not ctx.kds_screen:
            plan = {} if ctx.local_network else {"enableLocalNetwork": True}
            offer = _offer(ctx, WC.MAIN_TILL, "main_first", **plan)
            if offer is not None:
                return offer
        return _offer(ctx, WC.SHOP_Z_CLOUD, "cloud_until_main")
    return _offer(ctx, WC.LAN_MEMBER, "lan_member") or _offer(ctx, WC.REMOTE_SHOP_Z, "remote")


def suggestion_fields(db: Session, shop: Optional[Shop], ctx) -> Dict[str, Any]:
    """`GET /shops/{id}/work-config`'s additions: the preset id, the plan to send, and why."""
    offer = suggest(db, shop, ctx)
    return {
        "suggestedPreset": offer["preset"] if offer else None,
        "suggestedPlan": offer["plan"] if offer else None,
        "suggestedReason": offer["reason"] if offer else None,
    }


def apply_on_pairing(db: Session, machine: POSMachine, *, user_id: Any, pairing_code: Any = None) -> Optional[bool]:
    """
    A device that just paired into a shop with a work profile, and no plan of its own: the
    profile's suggestion for it, applied — when the user who paired it is a super admin, whose the
    presets' services are. Anyone else's device stays "לפי הסניף", exactly as before: the shop's
    status then says the Z waits for a super admin (`WAIT_SUPER_ADMIN`), whose save on the shop's
    page applies it. Never raises — a refusal leaves the device as the shop's default, and is kept
    on the code for the device page. None: nothing applied or tried; else whether it was applied.
    Commits when it applies.
    """
    from app.services import work_config as WC

    user = db.get(User, user_id) if user_id is not None else None
    if getattr(user, "role", None) != UserRole.SUPER_ADMIN:
        return None
    try:
        shop = WC.seated_shop(db, machine)
        if stored_profile(shop) is None:
            return None
        offer = suggest(db, shop, WC.context_for_machine(db, machine))
    except Exception:  # noqa: BLE001 - the pairing stands whatever happens here
        logger.exception("work profile: no suggestion for machine %s", machine.id)
        return None
    if offer is None:
        return None
    now = _now()
    plan = offer["plan"]
    code_id = getattr(pairing_code, "id", None)
    db.commit()
    try:
        changed = WC.apply(db, user, machine, plan, now=now)
        result = {"applied": True, "changes": changed, "at": now.isoformat(), "source": "workProfile"}
    except WC.WorkConfigRefused as refused:
        db.rollback()
        detail = refused.body.get("detail")
        message = refused.body.get("message")
        if not message and isinstance(detail, dict):
            message = detail.get("message")
        result = {
            "applied": False,
            "detail": detail if isinstance(detail, str) else (detail or {}).get("code"),
            "message": message or "תצורת העבודה של הסניף לא הוחלה על המכשיר.",
            "at": now.isoformat(),
            "source": "workProfile",
        }
        logger.warning("work profile: not applied to machine %s (%s)", machine.id, result["detail"])
    except Exception:  # noqa: BLE001 - the pairing stands whatever happens here
        db.rollback()
        logger.exception("work profile: apply failed for machine %s", machine.id)
        result = {
            "applied": False, "detail": "work_profile_failed", "message": "תצורת העבודה של הסניף לא הוחלה על המכשיר.",
            "at": now.isoformat(), "source": "workProfile",
        }
    if code_id is not None:
        from app.models.pairing_code import PairingCode

        code = db.get(PairingCode, code_id)
        if code is not None:
            # On the device page ("איך הוגדר בהוספה"): the profile's plan, marked as the profile's.
            code.work_config = {**plan, "fromWorkProfile": True}
            code.work_config_result = result
    db.commit()
    if result.get("applied") and result.get("changes"):
        try:
            from app.services import till_parameters as TP

            TP.publish_parameters_notify(WC.notify_targets(db, machine))
        except Exception:  # noqa: BLE001 - the tills' next sync pulls it anyway
            logger.warning("work profile notify for machine %s failed", machine.id)
    return bool(result.get("applied"))
