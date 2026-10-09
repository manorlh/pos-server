"""
The configuration matrix (the owner: "שיהיו את כל האופציות לפי מה שהוגדר במערכת") — remote close
offered and allowed exactly as configured, in every configuration and hierarchy. One row per case;
docs/LIVE_CONTROL_PROGRESS.md has the same table for the owner.

Axes: parameter levels (company / shop over company / area over shop) for `zRequireAllShiftsClosed`,
`allowCloseWithHeldSales` and `remoteCancelHeldSales`; till configuration (`zMode`, where the shop Z
is produced, `zScope`, kiosks); mixed shops; and each till's state (at rest, open sale, held sales,
offline last closed, offline open / unknown, an old app without the capability).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.kiosk import KioskDevice
from app.models.shop_area import ShopArea
from app.services import held_sales_close as H
from app.services import remote_close
from app.services import remote_till_z as svc
from app.services import z_shift_guard as G
from shift_world import NOW
from test_main_till import make_main, outside_local_mode, set_param
from test_main_till import w  # noqa: F401
from test_remote_shop_close import _ctx, item_of, preview, selling, start, z  # noqa: F401

NOT_YET = "לא זמין עדיין"


def area_of(z, *tills):
    area = ShopArea(id=uuid.uuid4(), tenant_id=z.tenant.id, shop_id=z.shop.id, name=f"A{uuid.uuid4().hex[:4]}")
    z.db.add(area)
    z.db.flush()
    for t in tills:
        t.area_id = area.id
    z.db.flush()
    return area


def manager(z):
    from app.models.user import User, UserRole

    u = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=z.tenant.id, email=f"{uuid.uuid4().hex[:6]}@x",
             username="mgr", shop_id=z.shop.id)
    z.db.add(u)
    z.db.flush()
    return u


# ── 1. Parameter levels: company only / shop over company / area over shop ──────

LEVELS = [
    # (key, company, shop, area, expected for a till in the area, expected for a till outside it)
    ("company only on", True, None, None, True, True),
    ("company only off", False, None, None, False, False),
    ("shop over company", False, True, None, True, True),
    ("area over shop", True, True, False, False, True),
]


@pytest.mark.parametrize("label, company, shop, area, in_area, outside", LEVELS, ids=[r[0] for r in LEVELS])
@pytest.mark.parametrize("key", [G.KEY, H.KEY, H.REMOTE_CANCEL_KEY, H.PARK_KEY])
def test_parameter_levels(z, key, label, company, shop, area, in_area, outside):
    a = area_of(z, z.t1)
    if company is not None:
        set_param(z, key, "company", z.shop.company_id, company)
    if shop is not None:
        set_param(z, key, "shop", z.shop.id, shop)
    if area is not None:
        set_param(z, key, "area", a.id, area)
    if key == G.KEY:
        # The shop Z reads the shop's own value; an area Z its area's.
        assert G.required(z.db, z.shop, area_id=a.id) is in_area
        assert G.required(z.db, z.shop) is outside
    elif key == H.KEY:
        mgr = manager(z)
        assert H.keep_offer(z.db, z.t1, mgr)["allowed"] is in_area
        assert H.keep_offer(z.db, z.t2, mgr)["allowed"] is outside
    elif key == H.PARK_KEY:
        assert H.park_open_basket_on(z.db, z.t1) is in_area
        assert H.park_open_basket_on(z.db, z.t2) is outside
    else:
        assert H.cancel_offer(z.db, z.t1)["allowed"] is in_area
        assert H.cancel_offer(z.db, z.t2)["allowed"] is outside


def test_parameter_defaults(z):
    assert G.required(z.db, z.shop) is True               # zRequireAllShiftsClosed: on
    assert H.allowed(z.db, z.t1) is False                 # allowCloseWithHeldSales: off
    assert H.remote_cancel_on(z.db, z.t1) is True         # remoteCancelHeldSales: on
    assert H.park_open_basket_on(z.db, z.t1) is False     # remoteCloseParkOpenBasket: off
    assert H.keep_offer(z.db, z.t1, z.admin) == {"allowed": True, "needsReason": True}  # support, with a reason


# ── 2. Till configuration and mixed shops ────────────────────────────────────────


def cfg_cloud(z):
    selling(z, z.t1, 1, "10.00")


def cfg_all_own_z(z):
    for t in z.tills:
        t.z_mode = "till"
    selling(z, z.t1, 1, "10.00")


def cfg_mixed(z):
    z.t2.z_mode = "till"
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")


def cfg_main_till_online(z):
    selling(z, z.t1, 1, "10.00")
    make_main(z, z.t1)
    outside_local_mode(z, z.t2)
    z.t1.last_heartbeat_at = datetime.now(timezone.utc)


def cfg_main_till_offline(z):
    selling(z, z.t1, 1, "10.00")
    make_main(z, z.t2)
    outside_local_mode(z, z.t1)
    z.t2.last_heartbeat_at = datetime.now(timezone.utc) - timedelta(hours=3)


def cfg_local_mode(z):
    selling(z, z.t1, 1, "10.00")
    make_main(z, z.t1)
    z.shop.local_network = True


def cfg_zscope_machine(z):
    z.tenant.settings = {**(z.tenant.settings or {}), "zScope": "machine"}
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")


def cfg_kiosk_in_shop_z(z):
    selling(z, z.t1, 1, "10.00")
    z.t2.capabilities = None  # a Windows kiosk: exempt
    z.db.add(KioskDevice(machine_id=z.t2.id, tenant_id=z.tenant.id, shop_id=z.shop.id, name="K", enabled=True))


def cfg_kiosk_own_z(z):
    selling(z, z.t1, 1, "10.00")
    z.t2.z_mode = "till"
    z.db.add(KioskDevice(machine_id=z.t2.id, tenant_id=z.tenant.id, shop_id=z.shop.id, name="K", enabled=True))


CONFIGS = [
    # (case, setup, shop close available, why-not starts with, source label starts with, t1 in the shop Z)
    ("every till in the shop Z, cloud", cfg_cloud, True, None, "יופק בענן", True),
    ("every till its own Z", cfg_all_own_z, False, "אין בסניף קופות ב-Z הסניפי", "יופק בענן", False),
    ("mixed", cfg_mixed, True, None, "יופק בענן", True),
    ("shopZFrom main till, online", cfg_main_till_online, False, NOT_YET, "יופק בקופה הראשית", True),
    ("shopZFrom main till, offline", cfg_main_till_offline, True, None, "יופק בענן", True),
    ("local mode", cfg_local_mode, False, NOT_YET, "יופק בקופה הראשית", True),
    ("zScope = machine", cfg_zscope_machine, False, NOT_YET, "יופק בענן", True),
    ("kiosk in the shop Z", cfg_kiosk_in_shop_z, True, None, "יופק בענן", True),
    ("kiosk with its own Z", cfg_kiosk_own_z, True, None, "יופק בענן", True),
]


@pytest.mark.parametrize("case, setup, available, why, source, t1_in_shop_z", CONFIGS, ids=[c[0] for c in CONFIGS])
def test_configurations(z, case, setup, available, why, source, t1_in_shop_z):
    setup(z)
    z.db.flush()
    p = preview(z)
    assert p["shopClose"]["available"] is available, p["shopClose"]
    if why:
        assert p["shopClose"]["whyNot"].startswith(why), p["shopClose"]["whyNot"]
    assert p["source"]["label"].startswith(source)
    assert (str(z.t1.id) in [r["machineId"] for r in p["inShopZ"]]) is t1_in_shop_z
    if case == "mixed":
        assert [r["machineId"] for r in p["ownZ"]] == [str(z.t2.id)]
    if case == "every till its own Z":
        assert svc.preview(z.db, z.t1, now=NOW)["kind"] == "till_z"
    if case == "local mode":
        assert svc.preview(z.db, z.t1, now=NOW)["whyNot"] == svc.LOCAL_MODE_SHIFT_TEXT
    if case == "kiosk in the shop Z":
        kiosk = next(r for r in p["inShopZ"] if r["machineId"] == str(z.t2.id))
        assert kiosk["action"]["whyNot"] == "קיוסק — מלשונית הקיוסקים" and "needsUpdate" not in kiosk


# ── 3. Each till's state (an all-cloud shop, the open-shifts rule on) ─────────────


def st_at_rest(z):
    pass


def st_offline_last_closed(z):
    z.t2.reported_open_shift_id = None
    z.t2.pending_documents = 0
    z.t2.reported_open_shift_claimed_at = NOW - timedelta(hours=6)
    z.t2.last_heartbeat_at = NOW - timedelta(hours=6)


def st_offline_open(z):
    z.t2.reported_open_shift_id = uuid.uuid4()
    z.t2.reported_open_shift_claimed_at = NOW - timedelta(hours=6)
    z.t2.last_heartbeat_at = NOW - timedelta(hours=6)


def st_offline_unknown(z):
    z.t2.reported_open_shift_id = None
    z.t2.last_heartbeat_at = None


def st_old_app(z):
    z.t2.capabilities = None


STATES = [
    # (case, setup, shop close available, why-not starts with, t2 shown as)
    ("at rest", st_at_rest, True, None, None),
    ("offline, last shift closed", st_offline_last_closed, True, None, "לא מחובר — המשמרת האחרונה סגורה"),
    ("offline with an open shift", st_offline_open, True, None, "מנותקת · משמרת פתוחה"),
    ("offline, state unknown", st_offline_unknown, False, "ממתין לקופות במצב לא ידוע", "מצב לא ידוע — ייתכן שיש משמרת פתוחה"),
    ("old app without the capability", st_old_app, False, "הקופה צריכה עדכון גרסה לפני סגירה מרחוק", None),
]


@pytest.mark.parametrize("case, setup, available, why, shown", STATES, ids=[s[0] for s in STATES])
def test_till_states(z, case, setup, available, why, shown):
    selling(z, z.t1, 1, "10.00")
    setup(z)
    z.db.flush()
    p = svc.shop_preview(z.db, z.shop, now=NOW, user=z.admin)
    assert p["shopClose"]["available"] is available, p["shopClose"]
    if why:
        assert p["shopClose"]["whyNot"].startswith(why)
    guard = p["shiftGuard"]
    words = {b["machineId"]: b["words"] for b in guard["blockers"] + guard["offlineClosed"]}
    if shown:
        assert words[str(z.t2.id)] == shown
    if case == "offline, state unknown":
        assert p["shopClose"]["forceStartAllowed"] is True  # support only, with a reason


@pytest.mark.parametrize("code, message, words", [
    ("sale_open", None, "ממתין למכירה פתוחה"),
    ("held_sales", "2", "ממתין — מכירות מושהות (2)"),
], ids=["open sale", "held sales"])
def test_a_till_busy_at_the_close_defers_and_says_why(z, code, message, words):
    selling(z, z.t1, 1, "10.00")
    run = start(z)
    remote_close.apply_close_shift_ack(z.db, z.t1, request_id=item_of(run, z.t1).id, phase="deferred",
                                       error_code=code, error_message=message)
    (item,) = [i for i in svc.run_progress(z.db, run, now=NOW, user=z.admin)["items"] if str(i["machineId"]) == str(z.t1.id)]
    assert item["words"] == words
    if code == "held_sales":
        assert item["cancelHeldSales"]["allowed"] is True       # remoteCancelHeldSales on by default
        assert item["keepHeldSales"] == {"allowed": True, "needsReason": True}  # support (allowCloseWithHeldSales off)


# ── 4. The four parameters at the till's own level too (till › area › shop › company) ─────────


@pytest.mark.parametrize("key", [G.KEY, H.KEY, H.REMOTE_CANCEL_KEY, H.PARK_KEY])
def test_a_tills_own_value_overrides_its_area_shop_and_company(z, key):
    a = area_of(z, z.t1, z.t2)
    set_param(z, key, "company", z.shop.company_id, True)
    set_param(z, key, "shop", z.shop.id, True)
    set_param(z, key, "area", a.id, True)
    set_param(z, key, "machine", z.t1.id, False)
    read = {
        G.KEY: lambda t: G.till_required(z.db, t),
        H.KEY: lambda t: H.allowed(z.db, t),
        H.REMOTE_CANCEL_KEY: lambda t: H.remote_cancel_on(z.db, t),
        H.PARK_KEY: lambda t: H.park_open_basket_on(z.db, t),
    }[key]
    assert read(z.t1) is False and read(z.t2) is True
    set_param(z, key, "machine", z.t1.id, True)
    set_param(z, key, "area", a.id, False)
    assert read(z.t1) is True and read(z.t2) is False


def test_mixed_areas_the_bar_holds_the_shop_z_the_kitchen_goes_to_the_next(z):
    """The rule on for the bar's area, off for the kitchen's: an open bar till holds; an open kitchen till is left."""
    bar = area_of(z, z.t1)
    kitchen = area_of(z, z.t2)
    set_param(z, G.KEY, "area", bar.id, True)
    set_param(z, G.KEY, "area", kitchen.id, False)
    s1 = selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    p = preview(z)
    assert [b["machineId"] for b in p["shiftGuard"]["blockers"]] == [str(z.t1.id)]  # only the bar till
    run = start(z)
    progress = svc.run_progress(z.db, run, now=NOW, user=z.admin)
    may = {str(i["machineId"]): i["mayLeaveOut"] for i in progress["items"]}
    assert may == {str(z.t1.id): False, str(z.t2.id): True}
    # The bar till can't be left out …
    from fastapi import HTTPException

    from app.routers import device_commands as R

    with pytest.raises(HTTPException) as e:
        R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t1.id]), **_ctx(z))
    assert e.value.detail["code"] == G.REFUSED_CODE
    # … the kitchen till can — it goes to the next Z, as with proceed.
    from test_remote_shop_close import till_closes

    till_closes(z, z.t1, s1)
    out = R.post_shop_close_proceed(run.id, R.ShopCloseProceedIn(excludeMachineIds=[z.t2.id]), **_ctx(z))
    assert out["status"] == "completed"


def test_the_main_tills_answer_lists_only_tills_with_the_rule_on(z):
    from app.routers import till_shop_z_local as LR

    bar = area_of(z, z.t1)
    kitchen = area_of(z, z.t2)
    set_param(z, G.KEY, "area", bar.id, True)
    set_param(z, G.KEY, "area", kitchen.id, False)
    selling(z, z.t1, 1, "10.00")
    selling(z, z.t2, 1, "20.00")
    # Asked by the kitchen till (as a main till would): only the bar till holds it.
    out = LR.till_shop_z_shift_guard(str(z.t2.id), machine=z.t2, db=z.db)
    assert out["required"] is True and [b["machineId"] for b in out["blockers"]] == [str(z.t1.id)]


# ── 5. "סגירה מרחוק גם עם עגלה פתוחה" ─────────────────────────────────────────────────────


def test_park_open_basket_is_off_by_default_and_shown_per_till(z):
    from app.services import till_parameters as TP

    (spec,) = [p for p in TP.BUILTIN_PARAMETERS if p.key == H.PARK_KEY]
    assert spec.default_value is False and spec.label == "סגירה מרחוק גם עם עגלה פתוחה (העגלה נשמרת כמכירה מושהית)"
    selling(z, z.t1, 1, "10.00")
    rows = {r["machineId"]: r for r in preview(z)["inShopZ"]}
    assert rows[str(z.t1.id)]["openBasket"] == "עגלה פתוחה — ממתין לסיום המכירה"
    set_param(z, H.PARK_KEY, "shop", z.shop.id, True)
    rows = {r["machineId"]: r for r in preview(z)["inShopZ"]}
    assert rows[str(z.t1.id)]["openBasket"] == "עגלה פתוחה — תישמר כמכירה מושהית"
    assert svc.preview(z.db, z.t1, now=NOW)["openBasket"] == "עגלה פתוחה — תישמר כמכירה מושהית"
    # Never at a kiosk.
    z.db.add(KioskDevice(machine_id=z.t2.id, tenant_id=z.tenant.id, shop_id=z.shop.id, name="K", enabled=True))
    z.db.flush()
    rows = {r["machineId"]: r for r in preview(z)["inShopZ"]}
    assert rows[str(z.t2.id)]["openBasket"] == "עגלה פתוחה — ממתין לסיום המכירה"


def test_a_parked_basket_is_kept_for_the_audit(z):
    from app.models.audit_exception import TillEvent
    from app.schemas.audit_exception import TillEventIn
    from app.services.exceptions import record_till_event

    body = TillEventIn.model_validate({
        "id": str(uuid.uuid4()), "type": "held_sale_parked", "occurredAt": NOW.isoformat(), "amount": "31.00",
        "details": {"heldSaleId": "h-9", "source": "remote_close", "requestId": str(uuid.uuid4()), "requestedBy": "mgr",
                    "items": [{"name": "סלט", "quantity": 1}], "total": "31.00"},
    })
    event, created = record_till_event(z.db, z.t1, body)
    z.db.flush()
    assert created and z.db.get(TillEvent, event.id).event_type == "held_sale_parked"


def test_the_runs_log_reads_only_its_own_tills_and_requests(z):
    from app.models.audit_exception import TillEvent
    from app.schemas.audit_exception import TillEventIn
    from app.services.exceptions import record_till_event

    rid = str(uuid.uuid4())
    for till, request in ((z.t1, rid), (z.t2, rid), (z.t1, str(uuid.uuid4()))):
        record_till_event(z.db, till, TillEventIn.model_validate({
            "id": str(uuid.uuid4()), "type": "held_sale_cancelled", "occurredAt": NOW.isoformat(),
            "details": {"heldSaleId": "h", "requestId": request, "reason": "r", "by": "m", "total": "1.00"},
        }))
    z.db.flush()
    out = H.cancelled_events(z.db, [rid], [z.t1.id])
    assert list(out) == [rid] and len(out[rid]) == 1  # t1's, for this request only
    assert z.db.query(TillEvent).count() == 3
