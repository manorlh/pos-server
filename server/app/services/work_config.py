"""
"תצורת עבודה למכשיר" — how one device works, in one place (docs/SPEC_DEVICE_WORK_CONFIG.md).

The owner (07.10.2026): "איפה אני מגדיר איך הקופה תעבוד? אני רוצה את כל ההגדרות האלה בתהליך
הקמת מכשיר, שזה ידרוס את הסניף."

Until now a device's way of working was spread over the shop page ("קופות בזד הסניפי",
"רשת מקומית", "קופה ראשית", "מצב דו״ח Z"), the device page ("לא משמש כשרת מקומי", Z mode),
the till parameters page (`tablesMode`), the printers page (`receiptPrinter`) and the workflow
card (`workflowTargets`). This module names the combinations that make sense — **presets** —
and writes a preset's values for one device, at the device's own level (they override the
shop), always through the services that own each value and their refusals:

* who makes its Z and whether it is in the shop's LAN group — `independent_till.apply_shop`
  (the card "קופות בזד הסניפי": participants / independent / main till / remote), and
  `z_mode_policy` + `till_z.set_z_mode` for "Z בקופה, בתוך הסניף" (`own_z`);
* "לא משמש כשרת מקומי" — `lan_server.set_excluded`; "רשת מקומית" — `lan_server.set_local_network`;
* `tablesMode` at the device level — written like `PUT /till-parameters/{id}/values` (validated,
  audited in `till_parameter_changes`, behind the shop Z producer's guard);
* `receiptPrinter` — `printers.set_options` (the printers page's service), audited;
* `workflowTargets` — `kds_workflow.save_values` (the workflow card's service, validated), audited.

Every apply is one transaction: all or nothing. Nothing here decides anything those services
do not already decide: the super admin alone changes the Z, the LAN roles and the tables (the
services refuse anyone else, and so does `check_permission` up front); a Z change only over a
clean break; the main till only with no Z run under way; the shop Z producer only through its
guard. A refusal is answered with the service's own body (`detail`, Hebrew `message`).

At pairing the code may carry a plan (`pairing_codes.work_config`): checked when the code is
generated (`check_pairing_request`), applied right after the new machine lands in its shop
(`apply_on_pairing`) by the user who generated the code — never failing the pairing; the
outcome is kept on the code (`work_config_result`) and shown on the device page.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shop import Shop
from app.models.user import User, UserRole

logger = logging.getLogger(__name__)

# ── The presets ───────────────────────────────────────────────────────────────

SHOP_Z_CLOUD = "shop_z_cloud"
MAIN_TILL = "main_till"
LAN_MEMBER = "lan_member"
REMOTE_SHOP_Z = "remote_shop_z"
INDEPENDENT = "independent"
OWN_Z = "own_z"
KIOSK_SHOP_Z = "kiosk_shop_z"
KIOSK_OWN_Z = "kiosk_own_z"
KDS_SCREEN = "kds_screen"
READY_BOARD = "ready_board"
#: Not a preset: the shop's own default for the device ("לפי הסניף") — its fiscal part.
INHERIT_PRESET = "inherit"

ROLE_TILL, ROLE_KIOSK, ROLE_KDS, ROLE_BOARD = "till", "kiosk", "kds", "order_status_board"

TABLES_OFF = "כבוי"
TABLES_SINGLE = "קופה אחת"
TABLES_SYNCED = "מסונכרן בין הקופות"
TABLES_LAN = "רשת מקומית (קופה ראשית)"
#: A value that removes the device's own level: it inherits again ("חזרה לירושה").
INHERIT = "inherit"

Z_CLOUD, Z_TILL = "cloud", "till"

#: How a preset treats "לא משמש כשרת מקומי": keep it, force it on / off, or let the operator choose.
LAN_KEEP, LAN_ON, LAN_OFF, LAN_OPTION = "keep", "on", "off", "option"
#: How a preset treats "מרוחק (דרך הענן)".
REMOTE_NO, REMOTE_YES, REMOTE_OPTION = "no", "yes", "option"


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    role: str
    #: None for a display device: it makes no Z at all.
    z_mode: Optional[str] = None
    independent: Optional[bool] = None
    remote: str = REMOTE_NO
    #: True: becomes the shop's main till; False: must not be it.
    main_till: Optional[bool] = False
    lan_excluded: str = LAN_KEEP
    #: For `LAN_OPTION`: the default when the operator says nothing (None: as it is).
    lan_excluded_default: Optional[bool] = None
    #: The tables choices at the device level (`INHERIT` first when inheriting is allowed);
    #: empty — the preset does not touch the tables.
    tables: Tuple[str, ...] = ()
    tables_default: Optional[str] = None
    #: True: the shop's "רשת מקומית" must be on; False: it must be off; None: either.
    needs_local_network: Optional[bool] = None
    #: Needs a LAN client — an Android device (a Windows / browser device never hears the LAN).
    lan_client_only: bool = False
    display: bool = False


PRESETS: Dict[str, Preset] = {p.id: p for p in (
    Preset(
        SHOP_Z_CLOUD, "קופה בזד סניפי — ענן", ROLE_TILL, Z_CLOUD, False, REMOTE_NO, False, LAN_KEEP, None,
        (INHERIT, TABLES_SYNCED, TABLES_SINGLE), INHERIT, needs_local_network=False,
    ),
    Preset(
        MAIN_TILL, "קופה ראשית (שרת מקומי)", ROLE_TILL, Z_CLOUD, False, REMOTE_NO, True, LAN_OFF, None,
        (INHERIT,), INHERIT, needs_local_network=True, lan_client_only=True,
    ),
    Preset(
        LAN_MEMBER, "קופה ברשת המקומית", ROLE_TILL, Z_CLOUD, False, REMOTE_NO, False, LAN_OPTION, None,
        (INHERIT, TABLES_LAN, TABLES_SINGLE, TABLES_OFF), INHERIT, needs_local_network=True, lan_client_only=True,
    ),
    Preset(
        REMOTE_SHOP_Z, "קופה מרוחקת בזד הסניפי", ROLE_TILL, Z_CLOUD, False, REMOTE_YES, False, LAN_ON, None,
        (TABLES_OFF, TABLES_SINGLE), TABLES_OFF, needs_local_network=True,
    ),
    Preset(
        INDEPENDENT, "קופה עצמאית", ROLE_TILL, Z_TILL, True, REMOTE_NO, False, LAN_KEEP, None,
        (TABLES_OFF, TABLES_SINGLE), TABLES_OFF,
    ),
    Preset(
        OWN_Z, "Z בקופה, בתוך הסניף", ROLE_TILL, Z_TILL, False, REMOTE_NO, False, LAN_OPTION, None,
        (INHERIT, TABLES_OFF, TABLES_SINGLE, TABLES_SYNCED, TABLES_LAN), INHERIT,
    ),
    Preset(
        KIOSK_SHOP_Z, "קיוסק בזד סניפי", ROLE_KIOSK, Z_CLOUD, False, REMOTE_OPTION, False, LAN_OPTION, True,
    ),
    Preset(KIOSK_OWN_Z, "קיוסק עם Z משלו", ROLE_KIOSK, Z_TILL, True, REMOTE_NO, False, LAN_KEEP, None),
    Preset(KDS_SCREEN, "מסך KDS", ROLE_KDS, main_till=None, display=True),
    Preset(READY_BOARD, "מסך מוכן", ROLE_BOARD, main_till=None, display=True),
)}

PRESET_ORDER = (
    SHOP_Z_CLOUD, MAIN_TILL, LAN_MEMBER, REMOTE_SHOP_Z, INDEPENDENT, OWN_Z,
    KIOSK_SHOP_Z, KIOSK_OWN_Z, KDS_SCREEN, READY_BOARD,
)

ROLE_LABELS = {ROLE_TILL: "קופה", ROLE_KIOSK: "קיוסק", ROLE_KDS: "מסך מטבח (KDS)", ROLE_BOARD: "מסך מוכן / לא מוכן"}

#: The device-level parameters the card shows and writes.
TABLES_KEY = "tablesMode"
RECEIPT_PRINTER_KEY = "receiptPrinter"
WORKFLOW_TARGETS_KEY = "workflowTargets"
KDS_ENABLED_KEY = "kdsEnabled"
PARAM_KEYS = (TABLES_KEY, RECEIPT_PRINTER_KEY, WORKFLOW_TARGETS_KEY, KDS_ENABLED_KEY)

#: The changes only the super admin makes (the services refuse anyone else too).
SUPER_ADMIN_CHANGES = frozenset({
    "zMode", "independent", "remote", "mainTill", "lanServerExcluded", "localNetwork", TABLES_KEY,
})
#: The changes a manager of the shop makes (the printers page's and the workflow card's people).
PRINTING_CHANGES = frozenset({RECEIPT_PRINTER_KEY, WORKFLOW_TARGETS_KEY})

#: The plan's keys (the API body and `pairing_codes.work_config`).
PLAN_KEYS = (
    "preset", "tablesMode", "lanServerExcluded", "link", "enableLocalNetwork", "receiptPrinter", "workflowTargets",
)


class WorkConfigRefused(Exception):
    """A refusal with a body (`detail`, Hebrew `message`, …), answered as is."""

    def __init__(self, status_code: int, body: dict):
        super().__init__(body.get("detail") if isinstance(body.get("detail"), str) else "work_config_refused")
        self.status_code = status_code
        self.body = body


def _refuse(code: str, message: str, status_code: int = status.HTTP_409_CONFLICT, **extra) -> WorkConfigRefused:
    return WorkConfigRefused(status_code, {"detail": code, "message": message, **extra})


def _label(machine: Optional[POSMachine]) -> str:
    if machine is None:
        return "המכשיר"
    number = (machine.pos_number or "").strip()
    return f"קופה {number}" if number else (machine.name or "המכשיר")


def _uuid(value: Any) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


# ── The device as it stands ───────────────────────────────────────────────────


@dataclass
class Context:
    """One device (or a device still to pair: `machine` None) in its shop, as it stands."""

    role: str
    platform: str
    shop: Optional[Shop]
    local_network: bool = False
    main_till: Optional[POSMachine] = None
    machine: Optional[POSMachine] = None
    z_mode: str = Z_CLOUD
    independent: bool = False
    remote: bool = False
    lan_excluded: bool = False
    kds_screen: bool = False
    #: The device's own values of the parameters (`PARAM_KEYS`), None when its level is silent.
    own: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_main_till(self) -> bool:
        return self.machine is not None and self.main_till is not None and self.main_till.id == self.machine.id

    @property
    def link_fixed(self) -> bool:
        """A Windows device is always closed through the cloud (no LAN client): not a choice."""
        from app.services.display_devices import PLATFORM_WINDOWS

        return self.platform == PLATFORM_WINDOWS

    @property
    def lan_client(self) -> bool:
        from app.services.display_devices import PLATFORM_ANDROID

        return self.platform == PLATFORM_ANDROID

    @property
    def display(self) -> bool:
        return self.role in (ROLE_KDS, ROLE_BOARD)


def _own_values(db: Session, machine_id: Any) -> Dict[str, Any]:
    from app.models.till_parameter import TillParameter, TillParameterValue

    rows = (
        db.query(TillParameter.key, TillParameterValue.value)
        .join(TillParameterValue, TillParameterValue.parameter_id == TillParameter.id)
        .filter(
            TillParameter.key.in_(PARAM_KEYS),
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id == _uuid(machine_id),
        )
        .all()
    )
    return {key: value for key, value in rows}


def seated_shop(db: Session, machine: POSMachine) -> Optional[Shop]:
    """The device's shop while it is seated there (active, assigned)."""
    if machine.shop_id is None or not machine.is_active or machine.pairing_status != PairingStatus.ASSIGNED:
        return None
    return db.get(Shop, machine.shop_id)


def context_for_machine(db: Session, machine: POSMachine) -> Context:
    from app.services import device_profile as DP
    from app.services import display_devices as DD
    from app.services import lan_server as LS
    from app.services import local_shop_z as LZ
    from app.services import main_till as MT

    shop = seated_shop(db, machine)
    return Context(
        role=DP.current_role(db, machine),
        platform=DD.platform_of(machine),
        shop=shop,
        local_network=bool(getattr(shop, "local_network", False)) if shop is not None else False,
        main_till=MT.main_till_of_shop(db, shop.id) if shop is not None else None,
        machine=machine,
        z_mode=Z_TILL if machine.z_mode == Z_TILL else Z_CLOUD,
        independent=bool(getattr(machine, "independent_till", False)),
        remote=shop is not None and str(machine.id) in LZ.remote_till_ids(shop),
        lan_excluded=bool(getattr(machine, "lan_server_excluded", False)),
        kds_screen=machine.id in LS.kds_screen_ids(db, [machine.id]),
        own=_own_values(db, machine.id),
    )


def context_for_new(db: Session, shop: Optional[Shop], role: Optional[str], platform: Optional[str]) -> Context:
    """A device the code will pair into `shop`: everything at its default."""
    from app.services import main_till as MT
    from app.services.display_devices import PLATFORM_ANDROID

    return Context(
        role=role or ROLE_TILL,
        platform=platform or PLATFORM_ANDROID,
        shop=shop,
        local_network=bool(getattr(shop, "local_network", False)) if shop is not None else False,
        main_till=MT.main_till_of_shop(db, shop.id) if shop is not None else None,
    )


# ── Which presets, and what "לפי הסניף" gives ──────────────────────────────────


def presets_for_role(role: str) -> List[Preset]:
    return [PRESETS[i] for i in PRESET_ORDER if PRESETS[i].role == role]


def inherited_preset(ctx: Context) -> str:
    """What the device is with nothing set on it: the shop's default for its role."""
    if ctx.role == ROLE_KDS:
        return KDS_SCREEN
    if ctx.role == ROLE_BOARD:
        return READY_BOARD
    if ctx.role == ROLE_KIOSK:
        return KIOSK_SHOP_Z
    if ctx.local_network:
        # A Windows device in a LAN shop is closed through the cloud whatever is set.
        return LAN_MEMBER if ctx.lan_client else REMOTE_SHOP_Z
    return SHOP_Z_CLOUD


def current_preset(ctx: Context) -> Optional[str]:
    """The preset the device matches now; None — a combination no preset names."""
    if ctx.role == ROLE_KDS:
        return KDS_SCREEN
    if ctx.role == ROLE_BOARD:
        return READY_BOARD
    if ctx.role == ROLE_KIOSK:
        if ctx.independent:
            return KIOSK_OWN_Z
        return None if ctx.z_mode == Z_TILL else KIOSK_SHOP_Z
    if ctx.independent:
        return INDEPENDENT
    if ctx.z_mode == Z_TILL:
        return OWN_Z
    if ctx.is_main_till:
        return MAIN_TILL
    if ctx.local_network:
        return REMOTE_SHOP_Z if (ctx.remote or ctx.link_fixed) else LAN_MEMBER
    return SHOP_Z_CLOUD


def is_inherited(ctx: Context) -> bool:
    """The fiscal part is the shop's default: in the shop Z, not remote, not the main till."""
    if ctx.display:
        return True
    return ctx.z_mode == Z_CLOUD and not ctx.independent and not ctx.remote and not ctx.is_main_till


def unavailable(ctx: Context, preset: Preset) -> Optional[Tuple[str, str]]:
    """Why `preset` cannot be chosen for this device now — `(code, Hebrew message)` — or None."""
    label = f"\"{preset.label}\""
    if ctx.shop is None:
        return "work_config_requires_shop", "המכשיר לא משויך לסניף: תצורת עבודה נקבעת בתוך סניף. שייכו אותו לסניף ונסו שוב."
    if preset.role != ctx.role:
        return (
            "work_config_wrong_role",
            f"התצורה {label} מיועדת ל{ROLE_LABELS.get(preset.role, preset.role)}, והמכשיר הוא "
            f"{ROLE_LABELS.get(ctx.role, ctx.role)}. את סוג המכשיר משנים ב\"שינוי תפקיד / דגם\".",
        )
    if preset.display:
        return None
    if ctx.is_main_till and preset.main_till is False:
        return (
            "work_config_is_main_till",
            f"{_label(ctx.machine)} היא הקופה הראשית (השרת המקומי) של הסניף. כדי לתת לה תצורה אחרת, "
            "בחרו קודם קופה ראשית אחרת (בדף הסניף, או \"קופה ראשית\" במכשיר אחר).",
        )
    if preset.lan_client_only and not ctx.lan_client:
        return (
            "work_config_needs_lan_client",
            f"מכשיר Windows / דפדפן לא מתחבר לרשת המקומית של הסניף ונסגר תמיד דרך הענן, ולכן לא יכול להיות {label}. "
            "בחרו \"קופה מרוחקת בזד הסניפי\".",
        )
    if preset.id == MAIN_TILL and ctx.kds_screen:
        return (
            "work_config_main_till_not_server",
            f"{_label(ctx.machine)} מציגה מסך מטבח, ולכן לא משמשת כשרת מקומי ולא יכולה להיות הקופה הראשית.",
        )
    if preset.needs_local_network is False and ctx.local_network:
        return (
            "work_config_shop_is_lan",
            "הסניף עובד ברשת מקומית: ה-Z הסניפי מופק בקופה הראשית, שסוגרת את הקופות ברשת. "
            "בחרו \"קופה ברשת המקומית\", או \"קופה מרוחקת בזד הסניפי\" למכשיר שמסתנכרן לבד מול הענן.",
        )
    if preset.needs_local_network and not ctx.local_network and preset.id != MAIN_TILL:
        if preset.id == REMOTE_SHOP_Z:
            return (
                "work_config_shop_not_lan",
                "הסניף לא עובד ברשת מקומית, ולכן כל קופה בזד הסניפי כבר מסתנכרנת לבד מול הענן. "
                "בחרו \"קופה בזד סניפי — ענן\".",
            )
        return (
            "work_config_shop_not_lan",
            "הסניף לא עובד ברשת מקומית (אין קופה ראשית שסוגרת את הקופות ברשת). בחרו \"קופה בזד סניפי — ענן\", "
            "או הפעילו \"רשת מקומית\" בדף הסניף.",
        )
    return None


def presets_out(ctx: Context) -> List[Dict[str, Any]]:
    """The device role's presets, each available or why not (Hebrew)."""
    out = []
    for preset in presets_for_role(ctx.role):
        why = unavailable(ctx, preset)
        out.append({
            "id": preset.id,
            "label": preset.label,
            "available": why is None,
            "reason": why[0] if why else None,
            "message": why[1] if why else None,
            # "קופה ראשית" in a shop whose "רשת מקומית" is off: the preset turns it on too.
            "turnsOnLocalNetwork": preset.id == MAIN_TILL and not ctx.local_network,
            # The main till moves from another device to this one.
            "movesMainTillFrom": (
                {"machineId": str(ctx.main_till.id), "posNumber": ctx.main_till.pos_number, "name": ctx.main_till.name}
                if preset.id == MAIN_TILL and ctx.main_till is not None and not ctx.is_main_till else None
            ),
        })
    return out


def static_table() -> List[Dict[str, Any]]:
    """The presets' fixed rules — pinned against the dashboard's copy by a shared golden file."""
    return [
        {
            "id": p.id,
            "role": p.role,
            "zMode": p.z_mode,
            "independent": p.independent,
            "remote": p.remote,
            "mainTill": p.main_till,
            "lanServerExcluded": p.lan_excluded,
            "lanServerExcludedDefault": p.lan_excluded_default,
            "tables": list(p.tables),
            "tablesDefault": p.tables_default,
            "needsLocalNetwork": p.needs_local_network,
            "lanClientOnly": p.lan_client_only,
            "display": p.display,
        }
        for p in (PRESETS[i] for i in PRESET_ORDER)
    ]


# ── The plan → the values to write ────────────────────────────────────────────

_UNSET = object()


@dataclass
class Target:
    preset: Optional[str] = None
    z_mode: Optional[str] = None
    independent: Optional[bool] = None
    remote: Optional[bool] = None
    #: True: becomes the shop's main till; False: must not be it.
    main_till: Optional[bool] = None
    lan_excluded: Optional[bool] = None
    enable_local_network: bool = False
    #: `INHERIT` (remove the device's own value) or the value; `_UNSET`: not touched.
    params: Dict[str, Any] = field(default_factory=dict)


def clean_plan(plan: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The plan's known keys only, a null one left out (the body as sent, or a code's stored plan)."""
    if not isinstance(plan, dict):
        return {}
    return {k: plan[k] for k in PLAN_KEYS if plan.get(k) is not None}


def _choice_error(name: str, value: Any, choices: Sequence[str]) -> WorkConfigRefused:
    shown = ", ".join("לפי הסניף" if c == INHERIT else c for c in choices)
    return _refuse(
        "work_config_value_not_allowed",
        f"הערך \"{value}\" לא מתאים לתצורה הזו ({name}). אפשר: {shown}.",
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        field=name,
    )


def resolve_target(db: Session, ctx: Context, plan: Dict[str, Any]) -> Target:
    """
    What the plan writes for this device: the preset's values, the operator's choices inside
    it, and the advanced overrides. Refused (nothing written) when the preset is not
    available, a choice is not one of the preset's, or a value is not valid.
    """
    plan = clean_plan(plan)
    name = plan.get("preset")
    preset: Optional[Preset] = None
    # "לפי הסניף" on a device: its fiscal part back to the shop's default — the tables and
    # "לא משמש כשרת מקומי" only when sent with it.
    inherit_mode = name == INHERIT_PRESET
    if inherit_mode:
        preset = PRESETS[inherited_preset(ctx)]
    elif name:
        preset = PRESETS.get(str(name))
        if preset is None:
            raise _refuse("work_config_unknown_preset", "תצורת העבודה לא מוכרת.", status.HTTP_422_UNPROCESSABLE_ENTITY)
    if ctx.shop is None:
        raise _refuse(*unavailable(ctx, preset or PRESETS[SHOP_Z_CLOUD]))
    if ctx.display:
        # A KDS / the board makes no Z and keeps no tables: only its own preset, which writes nothing.
        from app.services.display_devices import NOT_FISCAL, NOT_FISCAL_MESSAGE

        extra = [k for k in plan if k != "preset" and plan.get(k) not in (None, False)]
        if (preset is not None and preset.role != ctx.role) or extra:
            raise _refuse(NOT_FISCAL, NOT_FISCAL_MESSAGE)
        return Target(preset=preset.id if preset else None)
    if preset is not None:
        why = unavailable(ctx, preset)
        if why is not None:
            raise _refuse(why[0], why[1], preset=preset.id)

    target = Target(preset=preset.id if preset else None)
    # The constraints the values below must respect: the preset chosen, else the one the
    # device is now (a combination no preset names — the loosest).
    rules = preset or PRESETS.get(current_preset(ctx) or "")
    if preset is not None:
        target.z_mode = preset.z_mode
        target.independent = preset.independent
        target.main_till = preset.main_till
        if inherit_mode:
            # The shop's default: not on the "מרוחק" list (a Windows device is closed through
            # the cloud by its platform anyway).
            target.remote = False
        elif preset.remote == REMOTE_YES:
            target.remote = True
        elif preset.remote == REMOTE_NO:
            target.remote = False
        else:  # the kiosk's "מחובר ברשת המקומית / מרוחק (דרך הענן)" — only in a LAN shop
            link = plan.get("link")
            if link not in (None, "lan", "remote"):
                raise _choice_error("link", link, ("lan", "remote"))
            target.remote = bool(link == "remote" and ctx.local_network and not ctx.link_fixed)
        if inherit_mode:
            if plan.get("lanServerExcluded") is not None and preset.lan_excluded == LAN_OPTION:
                target.lan_excluded = bool(plan["lanServerExcluded"])
        elif preset.lan_excluded == LAN_ON:
            target.lan_excluded = True
        elif preset.lan_excluded == LAN_OFF:
            target.lan_excluded = False
        elif preset.lan_excluded == LAN_OPTION:
            if plan.get("lanServerExcluded") is not None:
                target.lan_excluded = bool(plan["lanServerExcluded"])
            elif preset.lan_excluded_default is not None:
                target.lan_excluded = preset.lan_excluded_default
        if preset.tables and not (inherit_mode and "tablesMode" not in plan):
            tables = plan.get("tablesMode", preset.tables_default)
            if tables not in preset.tables:
                raise _choice_error("ניהול שולחנות", tables, preset.tables)
            target.params[TABLES_KEY] = tables
        if preset.id == MAIN_TILL and not ctx.local_network:
            if not plan.get("enableLocalNetwork"):
                raise _refuse(
                    "work_config_local_network_off",
                    "\"קופה ראשית (שרת מקומי)\" מפעילה את \"רשת מקומית\" בסניף, והסניף עוד לא עובד כך. "
                    "סמנו \"הפעלת רשת מקומית בסניף\" (ה-Z הסניפי יופק בקופה הזו), או הפעילו אותה בדף הסניף.",
                    preset=preset.id,
                )
            target.enable_local_network = True
    else:
        # Overrides only: the device's preset stays; each value is checked against it.
        if plan.get("lanServerExcluded") is not None:
            wanted = bool(plan["lanServerExcluded"])
            if ctx.independent:
                raise _refuse(
                    "work_config_value_not_allowed",
                    "קופה עצמאית נמצאת מחוץ לרשת המקומית של הסניף — \"לא משמש כשרת מקומי\" לא חל עליה.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY, field="lanServerExcluded",
                )
            if rules is not None and rules.lan_excluded == LAN_ON and not wanted:
                raise _refuse(
                    "work_config_value_not_allowed",
                    "מכשיר מרוחק לא נמצא ברשת המקומית של הסניף, ולכן לא יכול לשמש כשרת מקומי.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY, field="lanServerExcluded",
                )
            # On for the main till: `lan_server.set_excluded` refuses it, with its own words.
            target.lan_excluded = wanted
        if "tablesMode" in plan:
            tables = plan["tablesMode"]
            if tables != INHERIT and rules is not None and rules.tables and tables not in rules.tables:
                raise _choice_error("ניהול שולחנות", tables, (INHERIT,) + tuple(c for c in rules.tables if c != INHERIT))
            if rules is not None and not rules.tables and tables != INHERIT:
                raise _refuse(
                    "work_config_value_not_allowed", "לקיוסק אין ניהול שולחנות.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY, field=TABLES_KEY,
                )
            target.params[TABLES_KEY] = tables
    # Printing — any preset, or none.
    if "receiptPrinter" in plan and plan["receiptPrinter"] is not None:
        target.params[RECEIPT_PRINTER_KEY] = plan["receiptPrinter"]
    if "workflowTargets" in plan and plan["workflowTargets"] is not None:
        value = plan["workflowTargets"]
        if value != INHERIT:
            from app.services import kds_workflow as WF

            items = WF._csv(value)
            if not items or any(t not in WF.TARGETS for t in items):
                raise _refuse(
                    "work_config_value_not_allowed",
                    "יעדי ה-KDS לא תקינים: בחרו לפחות יעד אחד מבין מדפסת, KDS, KDS לצפייה, Expo ומסך איסוף.",
                    status.HTTP_422_UNPROCESSABLE_ENTITY, field=WORKFLOW_TARGETS_KEY,
                )
            value = [t for t in WF.TARGETS if t in items]
        target.params[WORKFLOW_TARGETS_KEY] = value
    _validate_params(db, target)
    return target


def _parameter(db: Session, key: str):
    from app.models.till_parameter import TillParameter
    from app.services.till_parameters import ensure_builtin_parameters

    ensure_builtin_parameters(db)
    return db.query(TillParameter).filter(TillParameter.key == key).first()


def _validate_params(db: Session, target: Target) -> None:
    """Each value as its parameter takes it (the enum as the super admin may have re-worded it)."""
    from app.services.till_parameters import TillParameterValueError, validate_value

    for key in (TABLES_KEY, RECEIPT_PRINTER_KEY):
        value = target.params.get(key, _UNSET)
        if value is _UNSET or value == INHERIT:
            continue
        parameter = _parameter(db, key)
        if parameter is None:  # pragma: no cover - built in
            continue
        try:
            target.params[key] = validate_value(parameter.value_type, value, parameter.enum_options)
        except TillParameterValueError as exc:
            raise _refuse(
                "work_config_value_not_allowed",
                f"הערך \"{value}\" לא קיים בפרמטר \"{parameter.label}\".",
                status.HTTP_422_UNPROCESSABLE_ENTITY, field=key, reason=str(exc),
            ) from exc


def _same_param(key: str, own: Any, wanted: Any) -> bool:
    if wanted == INHERIT:
        return own is None
    if key == WORKFLOW_TARGETS_KEY:
        from app.services import kds_workflow as WF

        return own is not None and WF._csv(own) == WF._csv(wanted)
    return own is not None and own == wanted and type(own) is type(wanted)


def changes(ctx: Context, target: Target) -> List[str]:
    """What the target changes on this device (empty: nothing to write)."""
    out = []
    if target.z_mode is not None and target.z_mode != ctx.z_mode:
        out.append("zMode")
    if target.independent is not None and target.independent != ctx.independent:
        out.append("independent")
    if target.remote is not None and target.remote != ctx.remote:
        out.append("remote")
    if target.main_till is True and not ctx.is_main_till:
        out.append("mainTill")
    if target.lan_excluded is not None and target.lan_excluded != ctx.lan_excluded:
        out.append("lanServerExcluded")
    if target.enable_local_network and not ctx.local_network:
        out.append("localNetwork")
    for key, wanted in target.params.items():
        if not _same_param(key, ctx.own.get(key), wanted):
            out.append(key)
    return out


def check_permission(db: Session, user: User, ctx: Context, changed: Sequence[str]) -> None:
    """
    The super admin alone changes the Z, the LAN roles and the tables (the services say so
    too — this says it before anything is written); a manager of the shop the printing.
    """
    from app.services import printers as K

    fiscal = [c for c in changed if c in SUPER_ADMIN_CHANGES]
    if fiscal and getattr(user, "role", None) != UserRole.SUPER_ADMIN:
        raise _refuse(
            "super_admin_only",
            "רק מנהל-על קובע את תצורת העבודה של מכשיר: ה-Z, הרשת המקומית, הקופה הראשית והשולחנות. "
            "אפשר להשאיר \"לפי הסניף\", ולשנות כאן רק את מדפסת החשבוניות ויעדי ה-KDS.",
            status.HTTP_403_FORBIDDEN,
            changes=fiscal,
        )
    printing = [c for c in changed if c in PRINTING_CHANGES]
    if printing and ctx.shop is not None and not K.can_edit(db, user, ctx.shop):
        raise _refuse(
            "insufficient_permissions",
            "מדפסת החשבוניות ויעדי ה-KDS נקבעים על ידי מנהלי הסניף.",
            status.HTTP_403_FORBIDDEN,
            changes=printing,
        )


# ── Applying ──────────────────────────────────────────────────────────────────


def _as_refusal(exc: Exception, step: str) -> WorkConfigRefused:
    """A service's refusal, its body as that service answers it, with the step that refused."""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        return WorkConfigRefused(getattr(exc, "status_code", status.HTTP_409_CONFLICT), {**body, "step": step})
    if isinstance(exc, HTTPException):
        detail = exc.detail
        out: Dict[str, Any] = {"detail": detail, "step": step}
        if isinstance(detail, dict) and isinstance(detail.get("message"), str):
            out["message"] = detail["message"]
        return WorkConfigRefused(exc.status_code, out)
    raise exc  # pragma: no cover - not a refusal


def _remote_list(db: Session, shop: Shop, machine: POSMachine, remote: bool, main_after: Any) -> List[uuid.UUID]:
    """
    The shop's "מרוחק (דרך הענן)" list with this device in or out — of the shop's seated,
    participating tills only, never the main till after the save, so a stale entry (a till
    retired, made independent or made the main till since) never makes the card's save refuse.
    """
    from app.services import independent_till as IT
    from app.services import local_shop_z as LZ
    from app.services import z_runs as ZR

    seated = {str(m.id): m for m in ZR.shop_tills(db, shop.id) if ZR.is_seated_in(m, shop.id)}
    ids = {
        i for i in LZ.remote_till_ids(shop)
        if i in seated and not IT.is_independent(seated[i]) and i != str(main_after)
    }
    if remote:
        ids.add(str(machine.id))
    else:
        ids.discard(str(machine.id))
    return [uuid.UUID(i) for i in sorted(ids)]


def _write_parameter(db: Session, user: User, key: str, machine: POSMachine, wanted: Any, now: datetime) -> None:
    """`tablesMode` at the device's level, as `PUT /till-parameters/{id}/values` writes it."""
    from app.models.till_parameter import TillParameterValue
    from app.services import till_parameter_audit as AUDIT

    parameter = _parameter(db, key)
    row = (
        db.query(TillParameterValue)
        .filter(
            TillParameterValue.parameter_id == parameter.id,
            TillParameterValue.scope_type == "machine",
            TillParameterValue.scope_id == machine.id,
        )
        .first()
    )
    if wanted == INHERIT:
        if row is None:
            return
        AUDIT.record_change(
            db, parameter=parameter, scope_type="machine", scope_id=machine.id,
            action=AUDIT.CLEAR, old_value=row.value, new_value=None, user=user, now=now,
        )
        db.delete(row)
        parameter.updated_at = now
        return
    previous = None if row is None else row.value
    if row is not None and previous == wanted and type(previous) is type(wanted):
        return
    AUDIT.record_change(
        db, parameter=parameter, scope_type="machine", scope_id=machine.id,
        action=AUDIT.SET, old_value=previous, new_value=wanted, user=user, now=now,
    )
    if row is None:
        db.add(TillParameterValue(
            id=uuid.uuid4(), parameter_id=parameter.id, scope_type="machine", scope_id=machine.id,
            value=wanted, created_at=now, updated_at=now,
        ))
    else:
        row.value = wanted
        row.updated_at = now


def _audit_only(db: Session, user: User, key: str, machine: POSMachine, old: Any, new: Any, now: datetime) -> None:
    """The change log for a value another service writes (the printers page's, the workflow card's)."""
    from app.services import till_parameter_audit as AUDIT

    parameter = _parameter(db, key)
    AUDIT.record_change(
        db, parameter=parameter, scope_type="machine", scope_id=machine.id,
        action=AUDIT.CLEAR if new is None else AUDIT.SET, old_value=old, new_value=new, user=user, now=now,
    )


def apply(
    db: Session,
    user: User,
    machine: POSMachine,
    plan: Dict[str, Any],
    *,
    force_producer_switch: bool = False,
    now: Optional[datetime] = None,
) -> List[str]:
    """
    Write the plan for `machine` — every part through its own service, in one transaction
    (flushed, not committed: the caller commits, or rolls back on `WorkConfigRefused`).
    The changes made (empty: the device already was so).
    """
    from app.services import independent_till as IT
    from app.services import lan_server as LS
    from app.services import local_shop_z as LZ
    from app.services import till_z
    from app.services import z_mode_policy

    now = now or datetime.now(timezone.utc)
    ctx = context_for_machine(db, machine)
    target = resolve_target(db, ctx, plan)
    changed = changes(ctx, target)
    check_permission(db, user, ctx, changed)
    if not changed:
        return []
    shop = ctx.shop
    step = "start"
    try:
        # 1. "לא משמש כשרת מקומי" off first: a device becoming the main till must be a server.
        if "lanServerExcluded" in changed and target.lan_excluded is False:
            step = "lan_server"
            LS.set_excluded(db, user, machine, False, force_producer_switch=force_producer_switch, now=now)
        # 2. The card "קופות בזד הסניפי": in the shop Z or independent, the main till, remote.
        participants: List[uuid.UUID] = []
        independent: List[uuid.UUID] = []
        if target.independent is True and not ctx.independent:
            independent = [machine.id]
        elif target.independent is False and (ctx.independent or (target.z_mode == Z_CLOUD and ctx.z_mode == Z_TILL)):
            participants = [machine.id]
        kwargs: Dict[str, Any] = {}
        if "mainTill" in changed:
            kwargs["main_till_id"] = machine.id
        if "remote" in changed:
            main_after = machine.id if "mainTill" in changed else (ctx.main_till.id if ctx.main_till else None)
            kwargs["remote"] = _remote_list(db, shop, machine, bool(target.remote), main_after)
        if participants or independent or kwargs:
            step = "z_participation"
            IT.apply_shop(
                db, user, shop, participants=participants, independent=independent,
                force_producer_switch=force_producer_switch, now=now, **kwargs,
            )
        # 3. "Z בקופה, בתוך הסניף": its own Z, still in the LAN group (`PUT /machines/{id}` zMode's rules).
        if target.z_mode == Z_TILL and target.independent is False and machine.z_mode != Z_TILL:
            step = "z_mode"
            z_mode_policy.check_switch(db, user, machine, Z_TILL)
            till_z.set_z_mode(db, machine, Z_TILL, now=now)
        # 4. "לא משמש כשרת מקומי" on — after the main till moved away, if it did.
        if "lanServerExcluded" in changed and target.lan_excluded is True:
            step = "lan_server"
            LS.set_excluded(db, user, machine, True, force_producer_switch=force_producer_switch, now=now)
        # 5. "רשת מקומית" for the shop — after its main till is in place.
        if "localNetwork" in changed:
            step = "local_network"
            LS.set_local_network(db, user, shop, True, force_producer_switch=force_producer_switch, now=now)
        # 6. The device-level values.
        param_changes = [c for c in changed if c in target.params]
        if param_changes:
            step = "parameters"
            guard = LZ.ProducerGuard(db, [shop], now=now)
            for key in param_changes:
                _apply_parameter(db, user, shop, machine, key, target.params[key], ctx.own.get(key), now)
            db.flush()
            guard.check(force=force_producer_switch, user=user)
        db.flush()
    except WorkConfigRefused:
        raise
    except (IT.IndependentSwitchRefused, LZ.LocalShopZRefused, till_z.TillZRefused, HTTPException) as exc:
        raise _as_refusal(exc, step) from exc
    logger.info(
        "work config: machine %s (shop %s) preset %s by %s — %s",
        machine.id, shop.id, target.preset, getattr(user, "email", None) or getattr(user, "id", None), ", ".join(changed),
    )
    return changed


def _apply_parameter(db: Session, user: User, shop: Shop, machine: POSMachine, key: str, wanted: Any,
                     own: Any, now: datetime) -> None:
    if key == TABLES_KEY:
        _write_parameter(db, user, key, machine, wanted, now)
        return
    if key == RECEIPT_PRINTER_KEY:
        from app.schemas.kitchen_printers import KitchenOptionsIn
        from app.services import printers as K

        new = None if wanted == INHERIT else wanted
        K.set_options(db, shop, KitchenOptionsIn(scopeType="machine", scopeId=machine.id, values={key: new}))
        _audit_only(db, user, key, machine, own, new, now)
        return
    if key == WORKFLOW_TARGETS_KEY:
        from app.services import kds_workflow as WF

        new = None if wanted == INHERIT else list(wanted)
        WF.save_values(db, "machine", machine.id, {"targets": new})
        _audit_only(db, user, key, machine, own, WF.to_parameter_value("targets", new), now)
        return
    raise _refuse("work_config_unknown_value", f"unknown value {key}", status.HTTP_422_UNPROCESSABLE_ENTITY)  # pragma: no cover


def notify_targets(db: Session, machine: POSMachine):
    """The shop's tills: parameters, host flags and modes may all have moved."""
    from app.services import till_parameters as TP

    if machine.shop_id is None:
        return TP.notify_targets_for_scope(db, "machine", machine.id)
    return TP.notify_targets_for_scope(db, "shop", machine.shop_id)


# ── Reading: the effective configuration, each value with where it comes from ──


def _param_sources(db: Session, chain) -> Dict[str, Dict[str, Any]]:
    """
    Per parameter of `PARAM_KEYS`: the value on `chain` and the level it comes from
    (`machine` / `area` / `shop` / `company` / `default` / `none`), and what the device would
    inherit without its own level (`inherited`, `inheritedSource`).
    """
    from sqlalchemy import and_, or_

    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services.till_parameters import ensure_builtin_parameters, validate_value

    ensure_builtin_parameters(db)
    parameters = {p.key: p for p in db.query(TillParameter).filter(TillParameter.key.in_(PARAM_KEYS)).all()}
    scopes = chain.scopes()
    on_chain = [and_(TillParameterValue.scope_type == k, TillParameterValue.scope_id == i) for k, i in scopes]
    rows = (
        db.query(TillParameterValue)
        .filter(TillParameterValue.parameter_id.in_([p.id for p in parameters.values()]), or_(*on_chain))
        .all()
        if on_chain and parameters else []
    )
    by = {(str(r.parameter_id), r.scope_type): r for r in rows}

    def valid(parameter, value):
        try:
            return True, validate_value(parameter.value_type, value, parameter.enum_options)
        except Exception:  # noqa: BLE001 - a stored value the type no longer takes is passed over
            return False, None

    out: Dict[str, Dict[str, Any]] = {}
    for key in PARAM_KEYS:
        parameter = parameters.get(key)
        if parameter is None:  # pragma: no cover - built in
            continue
        found: List[Tuple[str, Any]] = []
        for scope_type, _ in scopes:
            row = by.get((str(parameter.id), scope_type))
            if row is None:
                continue
            ok, value = valid(parameter, row.value)
            if ok:
                found.append((scope_type, value))
        default_ok, default = valid(parameter, parameter.default_value) if parameter.default_value is not None else (False, None)
        fallback = ("default", default) if default_ok else ("none", None)
        own = next((v for s, v in found if s == "machine"), None)
        first = found[0] if found else fallback
        above = next(((s, v) for s, v in found if s != "machine"), fallback)
        out[key] = {
            "value": first[1],
            "source": first[0] if parameter.is_active else "inactive",
            "own": own,
            "inherited": above[1],
            "inheritedSource": above[0],
            "options": list(parameter.enum_options) if parameter.enum_options else None,
            "label": parameter.label,
        }
    return out


def _targets_view(entry: Dict[str, Any]) -> Dict[str, Any]:
    from app.services import kds_workflow as WF

    return {
        **entry,
        "value": WF._csv(entry.get("value")),
        "own": WF._csv(entry["own"]) if entry.get("own") is not None else None,
        "inherited": WF._csv(entry.get("inherited")),
        "options": list(WF.TARGETS),
    }


def _ref(machine: Optional[POSMachine]) -> Optional[Dict[str, Any]]:
    if machine is None:
        return None
    return {"machineId": str(machine.id), "posNumber": machine.pos_number, "name": machine.name}


def view(db: Session, user: User, ctx: Context) -> Dict[str, Any]:
    """The card's data for a device (or a device still to pair, `ctx.machine` None)."""
    from app.services import lan_server as LS
    from app.services import local_shop_z as LZ
    from app.services import printers as K
    from app.services.till_parameters import TillScopeChain, scope_chain_for_machine, till_parameters_for_machine

    machine, shop = ctx.machine, ctx.shop
    if machine is not None:
        chain = scope_chain_for_machine(db, machine)
    else:
        chain = TillScopeChain(
            machine_id=None, shop_id=shop.id if shop else None, company_id=shop.company_id if shop else None,
        )
    params = _param_sources(db, chain) if (shop is not None or machine is not None) else {}
    tables = dict(params.get(TABLES_KEY) or {})
    if machine is not None and ctx.independent and tables:
        # "קופה עצמאית": its tables come from its own level only — off when it is silent.
        effective = till_parameters_for_machine(db, machine).parameters.get(TABLES_KEY)
        if tables.get("own") is None:
            tables.update(value=effective, source="independent")
        else:
            tables["value"] = effective
    main_source = "device" if ctx.is_main_till else "inherited"
    suggested = False
    if machine is not None:
        suggested = LS.suggested(machine)
    elif ctx.role == ROLE_KIOSK:
        suggested = True
    values = {
        "zMode": {"value": ctx.z_mode, "source": "device" if ctx.z_mode == Z_TILL else "inherited"},
        "independent": {"value": ctx.independent, "source": "device" if ctx.independent else "inherited"},
        "link": {
            "value": "remote" if (ctx.remote or ctx.link_fixed) else "lan",
            "source": "fixed" if ctx.link_fixed else ("device" if ctx.remote else "inherited"),
            # Only a participant of a shop in local mode is closed over the LAN or through the cloud.
            "applies": ctx.local_network and not ctx.independent and ctx.z_mode == Z_CLOUD,
        },
        "mainTill": {"value": ctx.is_main_till, "source": main_source},
        "lanServerExcluded": {
            "value": ctx.lan_excluded or ctx.kds_screen,
            "source": "auto" if (ctx.kds_screen and not ctx.lan_excluded) else ("device" if ctx.lan_excluded else "inherited"),
            "suggested": suggested,
            "applies": not ctx.independent,
        },
        TABLES_KEY: tables,
        RECEIPT_PRINTER_KEY: params.get(RECEIPT_PRINTER_KEY),
        WORKFLOW_TARGETS_KEY: _targets_view(params[WORKFLOW_TARGETS_KEY]) if WORKFLOW_TARGETS_KEY in params else None,
        # "תצורת עבודה ו-KDS — הפעלה": off, the targets do not apply (the legacy printing).
        "workflowEnabled": bool((params.get(KDS_ENABLED_KEY) or {}).get("value")),
    }
    is_super = getattr(user, "role", None) == UserRole.SUPER_ADMIN
    return {
        "machineId": str(machine.id) if machine is not None else None,
        "shopId": str(shop.id) if shop is not None else None,
        "role": ctx.role,
        "platform": ctx.platform,
        "fiscal": not ctx.display,
        "canEdit": is_super and shop is not None,
        "canEditPrinting": shop is not None and K.can_edit(db, user, shop),
        "shop": None if shop is None else {
            "name": shop.name,
            "localNetwork": ctx.local_network,
            "localMode": LZ.local_mode_of_shop(db, shop),
            "mainTill": _ref(ctx.main_till),
        },
        "currentPreset": current_preset(ctx) if machine is not None else None,
        "inheritedPreset": inherited_preset(ctx),
        "isInherited": is_inherited(ctx),
        "values": values,
        "presets": presets_out(ctx) if shop is not None else [],
        "staticPresets": static_table(),
    }


def pairing_outcome(db: Session, machine: POSMachine) -> Optional[Dict[str, Any]]:
    """The plan the device was added with, and whether it was applied (the latest code)."""
    from app.models.pairing_code import PairingCode

    code = (
        db.query(PairingCode)
        .filter(PairingCode.pos_machine_id == machine.id, PairingCode.work_config.isnot(None))
        .order_by(PairingCode.used_at.desc())
        .first()
    )
    if code is None:
        return None
    result = code.work_config_result if isinstance(code.work_config_result, dict) else {}
    return {
        "plan": code.work_config,
        "preset": (code.work_config or {}).get("preset"),
        "applied": result.get("applied"),
        "changes": result.get("changes") or [],
        "detail": result.get("detail"),
        "message": result.get("message"),
        "at": result.get("at"),
    }


# ── Pairing ───────────────────────────────────────────────────────────────────


def check_pairing_request(
    db: Session, user: User, *, shop_id: Optional[uuid.UUID], role: Optional[str], platform: Optional[str],
    plan: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """
    The plan a pairing code stores, checked now — as for a new device in that shop — so the
    operator hears of a refusal while the dialog is open. None: "לפי הסניף" (nothing to store).
    """
    plan = clean_plan(plan)
    if not plan or not any(v is not None and v is not False for v in plan.values()):
        return None
    if shop_id is None:
        raise _refuse(
            "work_config_requires_shop",
            "תצורת עבודה נקבעת בתוך סניף: בחרו חברה וסניף לפני יצירת הקוד, או השאירו \"לפי הסניף\".",
            status.HTTP_400_BAD_REQUEST,
        )
    shop = db.get(Shop, shop_id)
    ctx = context_for_new(db, shop, role, platform)
    target = resolve_target(db, ctx, plan)
    changed = changes(ctx, target)
    check_permission(db, user, ctx, changed)
    if WORKFLOW_TARGETS_KEY in changed and target.params[WORKFLOW_TARGETS_KEY] != INHERIT and shop is not None:
        # The device's configuration would be the shop's with these targets: checked as such now,
        # and again for the device itself when it pairs.
        from app.services import kds_workflow as WF

        view_ = WF.level_view(db, "shop", shop.id, pending={"targets": target.params[WORKFLOW_TARGETS_KEY]})
        if view_["errors"]:
            raise WorkConfigRefused(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"detail": {"code": "workflow_invalid", "errors": view_["errors"], "warnings": view_["warnings"]},
                 "message": "יעדי ה-KDS שנבחרו לא מתאימים לתצורת העבודה של הסניף (ראו את כרטיס \"תצורת עבודה\").",
                 "step": "parameters"},
            )
    return plan if changed else None


def apply_on_pairing(db: Session, pairing_code, machine: POSMachine) -> Optional[bool]:
    """
    The plan a code carried, applied to the machine it just paired — by the user who made
    the code, after the machine landed in its shop (and became a kiosk / a screen). Never
    raises: a refusal leaves the device "לפי הסניף", and is kept on the code for the device
    page. None: nothing to apply; else whether it was applied. Commits.
    """
    plan = getattr(pairing_code, "work_config", None)
    if not isinstance(plan, dict) or not plan:
        return None
    if getattr(pairing_code, "target_machine_id", None) is not None:
        return None  # a replacement keeps the configuration of the till it replaces
    code_id = pairing_code.id
    user = db.get(User, pairing_code.distributor_id)
    now = datetime.now(timezone.utc)
    # What the pairing did so far stands whatever happens below: a refusal rolls back this alone.
    db.commit()
    try:
        if user is None:
            raise _refuse("work_config_no_user", "המשתמש שיצר את הקוד לא נמצא.")
        changed = apply(db, user, machine, plan, now=now)
        result = {"applied": True, "changes": changed, "at": now.isoformat()}
    except WorkConfigRefused as refused:
        db.rollback()
        detail = refused.body.get("detail")
        message = refused.body.get("message")
        if not message and isinstance(detail, dict):
            message = detail.get("message")
        result = {
            "applied": False,
            "detail": detail if isinstance(detail, str) else (detail or {}).get("code"),
            "message": message or "תצורת העבודה לא הוחלה.",
            "at": now.isoformat(),
        }
        logger.warning("pairing code %s: work config not applied to machine %s (%s)", code_id, machine.id, result["detail"])
    except Exception:  # noqa: BLE001 - the pairing stands whatever happens here
        db.rollback()
        logger.exception("pairing code %s: work config failed for machine %s", code_id, machine.id)
        result = {"applied": False, "detail": "work_config_failed", "message": "תצורת העבודה לא הוחלה.", "at": now.isoformat()}
    from app.models.pairing_code import PairingCode

    code = db.get(PairingCode, code_id)
    if code is not None:
        code.work_config_result = result
    db.commit()
    if result.get("applied") and result.get("changes"):
        try:
            from app.services import till_parameters as TP

            TP.publish_parameters_notify(notify_targets(db, machine))
        except Exception:  # noqa: BLE001 - the tills' next sync pulls it anyway
            logger.warning("work config notify for machine %s failed", machine.id)
    return bool(result.get("applied"))
