"""
"בעיות" — `GET /problems` and `GET/PUT /problems/preferences` (app/services/problems.py,
app/routers/problems.py; P:/specs/manager-problems.md §3, §6).

* scoping is the exceptions log's `scoped()`: the super admin everything, a company manager their
  companies' shops, a shop manager their shop, another company's manager nothing, a cashier 403;
* `integrity` ("שלמות נתונים") is the super admin's only — its rows are listed nowhere else;
* one problem, one card: a log row and the till's own reading of the same thing (offline, printer,
  Z, transmission) are listed once, as the log row (it carries "טופל");
* "טופל" says which route this user's dashboard may use (`resolveVia`);
* the hidden groups are kept on the user, come back `hidden`, and leave the counts.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException

from app.models.company import Company
from app.models.dashboard_access import DashboardAccessProfile
from app.models.shift import ShiftStatus
from app.models.shop import Shop
from app.models.user import User, UserRole
from app.routers import problems as R
from app.services import dashboard_access as DA
from app.services import dashboard_sections as DS
from app.services import problems as P
from app.services.exception_alerts import log as L
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def user(w, role, *, shop=None, company=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id,
        company_id=(company or w.company).id if role != UserRole.SUPER_ADMIN else None,
        shop_id=shop.id if shop else None, email=f"{uuid.uuid4().hex[:8]}@example.com",
        username=uuid.uuid4().hex[:10], is_active=True,
    )
    w.db.add(u)
    w.db.flush()
    return u


def profile(w, u, *, full=False, sections=None):
    w.db.add(DashboardAccessProfile(user_id=u.id, full_access=full, sections=dict(sections or {})))
    w.db.flush()
    DA.forget(w.db)


def entry(w, kind, *, till=None, shop=None, severity="high", minutes_ago=5, details=None, machine=True, amount=None):
    till = till or w.tills[0]
    shop = shop or (w.shop if till in w.tills else w.other_shop)
    spec = L.EntrySpec(
        source="test", source_id=uuid.uuid4().hex, dedupe_key=f"test:{uuid.uuid4().hex}", kind=kind,
        severity=severity, occurred_at=NOW - timedelta(minutes=minutes_ago), tenant_id=w.tenant.id,
        company_id=w.company.id, shop_id=shop.id, machine_id=till.id if machine else None,
        details=details, amount=amount, summary=f"{kind} summary",
    )
    row, _ = L.record(w.db, spec, now=NOW)
    w.db.flush()
    return row


def build(w, u, **kw):
    return P.build(w.db, u, w.tenant.id, now=NOW, **kw)


def group(out, key):
    return next((g for g in out["groups"] if g["key"] == key), None)


def ids(out):
    return {i["id"] for g in out["groups"] for i in g["items"]}


def exception_ids(out):
    return {i["exceptionId"] for g in out["groups"] for i in g["items"] if i["exceptionId"]}


# ── Scope ────────────────────────────────────────────────────────────────────


def test_the_super_admin_sees_every_shop_and_the_integrity_group(w):
    here = entry(w, "bon_unprinted")
    there = entry(w, "bon_unprinted", till=w.other_till)
    refused = entry(w, "document_refused")
    out = build(w, w.admin)
    assert [g["key"] for g in out["groups"]] == ["devices", "z_shift", "card", "kitchen", "integrity"]
    assert {str(here.id), str(there.id)} <= {i["exceptionId"] for i in group(out, "kitchen")["items"]}
    integrity = group(out, "integrity")
    assert [i["exceptionId"] for i in integrity["items"]] == [str(refused.id)]
    item = integrity["items"][0]
    assert item["kind"] == "document_refused" and item["severity"] == "high"
    assert item["shopName"] == "Center" and item["machineName"] == "Till 1"
    assert item["link"] == f"/dashboard/exceptions-log?code={refused.short_code}"
    assert item["resolvable"] is True and item["resolveVia"] == "log"
    assert out["counts"]["high"] == 3 and out["total"] == 3


def test_a_company_manager_sees_their_shops_but_never_integrity(w):
    here = entry(w, "bon_unprinted")
    there = entry(w, "bon_unprinted", till=w.other_till)
    entry(w, "document_refused")
    entry(w, "z_totals_mismatch", till=w.other_till)
    out = build(w, user(w, UserRole.COMPANY_MANAGER))
    assert group(out, "integrity") is None
    assert [g["key"] for g in out["groups"]] == ["devices", "z_shift", "card", "kitchen"]
    assert exception_ids(out) == {str(here.id), str(there.id)}
    assert out["total"] == 2


def test_a_shop_manager_sees_their_shop_only(w):
    here = entry(w, "bon_unprinted")
    entry(w, "bon_unprinted", till=w.other_till)
    out = build(w, user(w, UserRole.SHOP_MANAGER, shop=w.shop))
    assert exception_ids(out) == {str(here.id)}


def test_another_companys_manager_sees_nothing(w):
    entry(w, "bon_unprinted")
    other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="514141414")
    w.db.add(other)
    w.db.flush()
    w.db.add(Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, name="Far", settings={}))
    w.db.flush()
    out = build(w, user(w, UserRole.COMPANY_MANAGER, company=other))
    assert ids(out) == set() and out["total"] == 0


def test_a_cashier_is_refused(w):
    cashier = user(w, UserRole.CASHIER, shop=w.shop)
    with pytest.raises(HTTPException) as err:
        build(w, cashier)
    assert err.value.status_code == 403
    with pytest.raises(HTTPException) as err:
        R.list_problems(company_id=None, shop_id=None, current_user=cashier, active_tenant_id=w.tenant.id, db=w.db)
    assert err.value.status_code == 403
    with pytest.raises(HTTPException):
        R.get_preferences(current_user=cashier)


def test_handled_and_back_rows_are_not_problems(w):
    handled = entry(w, "bon_unprinted")
    L.acknowledge(w.db, handled, user=w.admin, acknowledged=True, note="done")
    entry(w, "till_offline", details={"backAt": NOW.isoformat()})
    entry(w, "refund")  # an exception, not a problem: not in any group
    old = entry(w, "bon_unprinted", minutes_ago=60 * 24 * 20)
    w.db.flush()
    out = build(w, w.admin)
    assert str(old.id) not in exception_ids(out)
    assert exception_ids(out) == set()


def test_narrowed_to_a_shop(w):
    entry(w, "bon_unprinted")
    there = entry(w, "bon_unprinted", till=w.other_till)
    out = build(w, w.admin, shop_id=w.other_shop.id)
    assert exception_ids(out) == {str(there.id)}


# ── One problem, one card ────────────────────────────────────────────────────


def _offline_with_open_shift(w, till):
    till.last_heartbeat_at = NOW - timedelta(hours=1)
    w.shift(till, 1, status=ShiftStatus.OPEN, business_date=TODAY, opened_at=NOW - timedelta(hours=3))
    w.db.flush()


def test_an_offline_till_is_listed_from_its_light_when_the_log_has_no_row(w):
    till = w.tills[0]
    _offline_with_open_shift(w, till)
    out = build(w, w.admin)
    devices = group(out, "devices")["items"]
    item = next(i for i in devices if i["id"] == f"offline:{till.id}")
    assert item["kind"] == "till_offline" and item["severity"] == "high"
    assert item["exceptionId"] is None and item["resolvable"] is False
    assert item["link"] == f"/dashboard/machines/{till.id}"
    assert item["machineName"] == "Till 1" and item["shopName"] == "Center"


def test_the_log_row_wins_over_the_light_for_the_same_till(w):
    till = w.tills[0]
    _offline_with_open_shift(w, till)
    row = entry(w, "till_offline", till=till)
    out = build(w, w.admin)
    devices = group(out, "devices")["items"]
    assert f"offline:{till.id}" not in {i["id"] for i in devices}
    assert [i["exceptionId"] for i in devices if i["kind"] == "till_offline"] == [str(row.id)]
    # Another till's own reading is still listed.
    other = w.tills[1]
    _offline_with_open_shift(w, other)
    out = build(w, w.admin)
    assert f"offline:{other.id}" in ids(out)


def test_new_kinds_of_the_alert_policy_group_and_replace_the_flags(w):
    """`till_printer` / `z_missing` (§2, another branch) are strings here: their rows group now."""
    till = w.tills[0]
    till.printer_status = "no_paper"
    till.printer_status_at = NOW - timedelta(minutes=20)
    w.shift(till, 1, status=ShiftStatus.CLOSED, business_date=TODAY - timedelta(days=2))
    w.db.flush()
    out = build(w, w.admin)
    assert f"printer:{till.id}" in ids(out)
    assert f"awaitingz:{till.id}" in ids(out)
    awaiting = next(i for i in group(out, "z_shift")["items"] if i["id"] == f"awaitingz:{till.id}")
    assert awaiting["since"] == (TODAY - timedelta(days=2)).isoformat()
    assert awaiting["link"] == f"/dashboard/shifts?awaitingZ=1&machine={till.id}"

    printer = entry(w, "till_printer", till=till, severity="medium")
    z_missing = entry(w, "z_missing", till=till, machine=False)  # the shop's Z
    out = build(w, w.admin)
    assert f"printer:{till.id}" not in ids(out) and f"awaitingz:{till.id}" not in ids(out)
    assert str(printer.id) in {i["exceptionId"] for i in group(out, "devices")["items"]}
    assert str(z_missing.id) in {i["exceptionId"] for i in group(out, "z_shift")["items"]}
    for key in ("shift_open_overdue", "card_transmission_overdue"):
        row = entry(w, key, till=w.tills[1], severity="medium")
        assert str(row.id) in exception_ids(build(w, w.admin))
    assert P.KIND_GROUP["card_transmission_overdue"] == "card"
    assert P.KIND_GROUP["shift_open_overdue"] == "z_shift"


def test_the_alert_policy_and_push_detector_kinds_group_and_a_daily_summary_never_does(w):
    """
    The release of 14.10.2026 (alert-policy, push-detectors and this screen merged): each of their
    kinds the screen lists is in its group, and "סיכום יום" (`catalog.INFO_KINDS`) is information —
    never an item, never counted. Nor table-restore-payments' reversals and restores.
    """
    from app.services.exception_alerts import catalog as C

    expected = {
        "z_missing": "z_shift", "shift_open_overdue": "z_shift",
        "card_transmission_overdue": "card",
        "till_printer": "devices", "device_battery": "devices", "till_idle": "devices",
        "table_open_long": "kitchen", "kds_ticket_late": "kitchen",
    }
    for kind, key in expected.items():
        assert P.KIND_GROUP[kind] == key, kind
        assert C.kind_spec(kind) is not None, kind  # the log knows it: its label is the card's title
    assert "daily_summary" in C.INFO_KINDS
    assert not set(P.KIND_GROUP) & C.INFO_KINDS
    # table-restore-payments: a payment reversed in a table and a restored table are a manager's
    # business (their own push type), not problems — in no group.
    for kind in ("payment_reversed", "table_restored"):
        assert C.kind_spec(kind) is not None and kind not in P.KIND_GROUP, kind

    rows = {kind: entry(w, kind, till=w.tills[1], severity="medium")
            for kind in ("till_idle", "table_open_long", "kds_ticket_late")}
    before = build(w, w.admin)
    for kind, row in rows.items():
        listed = group(before, expected[kind])["items"]
        assert str(row.id) in {i["exceptionId"] for i in listed}, kind
    summary = entry(w, "daily_summary", machine=False, severity="low")
    reversed_ = entry(w, "payment_reversed", severity="medium", amount=50)
    restored = entry(w, "table_restored", severity="medium")
    after = build(w, w.admin)
    assert not {str(summary.id), str(reversed_.id), str(restored.id)} & exception_ids(after)
    assert after["counts"] == before["counts"] and after["total"] == before["total"]
    assert [g["total"] for g in after["groups"]] == [g["total"] for g in before["groups"]]


def test_a_failed_payment_is_a_problem_only_when_the_terminal_failed(w):
    declined = entry(w, "failed_payment", severity="low", details={"outcome": "declined"})
    no_answer = entry(w, "failed_payment", severity="medium", details={"outcome": "no_answer"})
    stale = entry(w, "failed_payment", severity="medium", details={"outcome": "no_answer"}, minutes_ago=60 * 24 * 3)
    unresolved = entry(w, "failed_payment", details={"outcome": "unresolved"}, minutes_ago=60 * 24 * 3, amount="50")
    card = {i["exceptionId"] for i in group(build(w, w.admin), "card")["items"]}
    assert str(no_answer.id) in card and str(unresolved.id) in card
    assert str(declined.id) not in card and str(stale.id) not in card


# ── "טופל" ───────────────────────────────────────────────────────────────────


def test_resolve_via_the_route_this_user_may_use(w):
    offline = entry(w, "till_offline")  # a push kind
    # A push kind too since alert-policy's "פעולות רגישות" (sensitive_actions): the alerts' "טופל" takes it.
    forced = entry(w, "forced_z_close")
    late = entry(w, "cloud_closed_shift_late_documents")  # not a push kind
    manager = user(w, UserRole.SHOP_MANAGER, shop=w.shop)
    profile(w, manager, sections={"reports": DS.VIEW, "alerts": DS.EDIT})
    items = {i["exceptionId"]: i for g in build(w, manager)["groups"] for i in g["items"]}
    assert items[str(offline.id)]["resolveVia"] == "alerts" and items[str(offline.id)]["resolvable"] is True
    assert items[str(forced.id)]["resolveVia"] == "alerts" and items[str(forced.id)]["resolvable"] is True
    assert items[str(late.id)]["resolvable"] is False and items[str(late.id)]["resolveVia"] is None

    editor = user(w, UserRole.SHOP_MANAGER, shop=w.shop)
    profile(w, editor, sections={"reports": DS.EDIT})
    items = {i["exceptionId"]: i for g in build(w, editor)["groups"] for i in g["items"]}
    assert {i["resolveVia"] for i in items.values()} == {"log"}

    supervisor = user(w, UserRole.SHIFT_SUPERVISOR, shop=w.shop)
    items = [i for g in build(w, supervisor)["groups"] for i in g["items"]]
    assert items and not any(i["resolvable"] for i in items)


# ── Hidden groups ────────────────────────────────────────────────────────────


def test_hidden_groups_round_trip_and_leave_the_counts(w, monkeypatch):
    built = P.build
    monkeypatch.setattr(P, "build", lambda *a, **kw: built(*a, **{**kw, "now": NOW}))  # the world's clock
    manager = user(w, UserRole.COMPANY_MANAGER)
    entry(w, "bon_unprinted")
    entry(w, "forced_z_close", severity="medium")
    assert R.get_preferences(current_user=manager) == {
        "hiddenGroups": [], "groups": ["devices", "z_shift", "card", "kitchen"],
    }
    out = R.put_preferences(body={"hiddenGroups": ["kitchen", "devices", "kitchen"]}, current_user=manager, db=w.db)
    assert out["hiddenGroups"] == ["devices", "kitchen"]
    assert R.get_preferences(current_user=manager)["hiddenGroups"] == ["devices", "kitchen"]
    # Kept beside the profile's own choices, which are untouched.
    from app.services import user_preferences as UP

    assert UP.read_preferences(manager)["homePage"] == "board"
    UP.update_preferences(w.db, manager, {"homePage": "compare"})
    assert UP.read_problems_hidden(manager) == ["devices", "kitchen"]

    listed = R.list_problems(company_id=None, shop_id=None, current_user=manager, active_tenant_id=w.tenant.id, db=w.db)
    assert listed["hiddenGroups"] == ["devices", "kitchen"]
    kitchen = group(listed, "kitchen")
    assert kitchen["hidden"] is True and kitchen["total"] == 1 and len(kitchen["items"]) == 1
    assert kitchen["counts"] == {"high": 1, "medium": 0, "low": 0}
    assert listed["counts"] == {"high": 0, "medium": 1, "low": 0} and listed["total"] == 1

    with pytest.raises(HTTPException) as err:
        R.put_preferences(body={"hiddenGroups": ["nope"]}, current_user=manager, db=w.db)
    assert err.value.status_code == 422
    with pytest.raises(HTTPException):
        R.put_preferences(body={}, current_user=manager, db=w.db)
    assert R.put_preferences(body={"hiddenGroups": []}, current_user=manager, db=w.db)["hiddenGroups"] == []
    assert "problemsHiddenGroups" not in (manager.preferences or {})


def test_the_routes_are_mapped_to_their_sections():
    assert DS.rule_for("GET", "/problems").describe("GET") == "reports:view"
    assert DS.rule_for("PUT", "/problems/preferences").kind == "self"
    assert DS.rule_for("GET", "/problems/preferences").kind == "self"
    reports = next(s for s in DS.SECTIONS if s.id == "reports")
    assert "/dashboard/problems" in reports.pages


def test_every_group_is_bounded_and_says_its_total(w, monkeypatch):
    monkeypatch.setattr(P, "GROUP_LIMIT", 3)
    for n in range(5):
        entry(w, "bon_unprinted", minutes_ago=n + 1)
    kitchen = group(build(w, w.admin), "kitchen")
    assert kitchen["total"] == 5 and len(kitchen["items"]) == 3
    # Newest first within a severity.
    assert [i["since"] for i in kitchen["items"]] == sorted((i["since"] for i in kitchen["items"]), reverse=True)


def test_kiosk_health_parts_are_listed_and_give_way_to_their_log_rows(w, monkeypatch):
    """The kiosks' own health view (`GET /kiosks/health`), stubbed: what it says becomes cards."""
    from app.services import kiosk_health

    kiosk, quiet, night = w.tills[1], w.tills[0], w.other_till

    def part(key, level, code):
        return {"key": key, "level": level, "code": code, "detail": {}}

    view = {"kiosks": [
        {"machineId": str(kiosk.id), "shopId": str(w.shop.id), "online": True, "enabled": True, "parts": [
            part("app", "ok", "running"), part("terminal", "error", "unreachable"),
            part("printer", "warn", "unprinted"), part("kds", "error", "no_screens"), part("media", "warn", "missing"),
        ]},
        {"machineId": str(quiet.id), "shopId": str(w.shop.id), "online": False, "shiftOpen": True, "enabled": True,
         "lastContactAt": (NOW - timedelta(minutes=30)).isoformat(), "parts": [part("printer", "error", "no_paper")]},
        {"machineId": str(night.id), "shopId": str(w.other_shop.id), "online": False, "shiftOpen": False, "enabled": True,
         "parts": []},
    ]}
    monkeypatch.setattr(kiosk_health, "health_view", lambda *a, **k: view)
    out = build(w, w.admin)
    devices = {i["id"]: i for i in group(out, "devices")["items"]}
    assert f"kiosk-terminal:{kiosk.id}" in devices and devices[f"kiosk-terminal:{kiosk.id}"]["severity"] == "medium"
    assert f"kiosk-kds:{kiosk.id}" in devices
    # Its unprinted bons are the kitchen's; media is not a problem; an offline kiosk's parts are stale.
    assert f"kiosk-printer:{kiosk.id}" not in devices and f"kiosk-printer:{quiet.id}" not in devices
    assert devices[f"kiosk-offline:{quiet.id}"]["severity"] == "high"
    assert f"kiosk-offline:{night.id}" not in devices  # switched off with no shift open
    # A log row of the same thing wins.
    row = entry(w, "kiosk_terminal", till=kiosk, severity="medium")
    devices = {i["id"]: i for i in group(build(w, w.admin), "devices")["items"]}
    assert f"kiosk-terminal:{kiosk.id}" not in devices and f"log:{row.id}" in devices
    # Only for the roles the kiosks' pages serve.
    supervisor = user(w, UserRole.SHIFT_SUPERVISOR, shop=w.shop)
    assert not any(i["id"].startswith("kiosk-") for g in build(w, supervisor)["groups"] for i in g["items"])


def test_the_service_worker_opens_the_card_of_every_problem_kind():
    """client/public/sw.js `PROBLEM_KINDS` (a tap on a push opens its card here) names exactly `KIND_GROUP`."""
    import re
    from pathlib import Path

    source = (Path(__file__).absolute().parents[2] / "client" / "public" / "sw.js").read_text(encoding="utf-8")
    block = re.search(r"const PROBLEM_KINDS = new Set\(\[(.*?)\]\);", source, re.S).group(1)
    kinds = set(re.findall(r"'([a-z_]+)'", re.sub(r"//[^\n]*", "", block)))
    assert kinds == set(P.KIND_GROUP)
