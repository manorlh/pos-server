"""
"שיוך קופות מהיר לאירוע" (docs/SPEC_EVENTS.md): the bulk assignment, moving a till out of an
overlapping event ("העבר לאירוע הזה"), the history, and what the pickers read — areas, device
groups, kiosks and the shop's latest events to copy tills from.

Everything on the in-memory SQLite world (tests/shift_world.py); the routers are called as
functions, as tests/test_report_events.py does.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.kiosk import KioskDevice
from app.models.machine_group import MachineGroup, MachineGroupMember
from app.models.company import Company
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.report_event import ReportEvent, ReportEventMachine, ReportEventMachineChange
from app.models.shop_area import ShopArea
from app.models.user import User, UserRole
from app.routers import report_events as R
from app.schemas.report_event import (
    ReportEventConfirm,
    ReportEventCreate,
    ReportEventTillsChange,
    ReportEventUpdate,
)
from shift_world import accept_str_uuids, make_world

DAY = "2026-09-27"


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    till3 = POSMachine(
        id=uuid.uuid4(), tenant_id=world.tenant.id, shop_id=world.shop.id, distributor_id=world.admin.id,
        name="Till 3", machine_code="M-T3", pos_number="3", is_active=True, pairing_status=PairingStatus.ASSIGNED,
    )
    world.db.add(till3)
    world.db.flush()
    world.tills.append(till3)
    world.db.commit()
    return world


def user(w, role, shop=None):
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, email=f"{uuid.uuid4().hex[:6]}@x",
        username=f"u-{uuid.uuid4().hex[:6]}", company_id=w.company.id, shop_id=shop.id if shop else None,
    )
    w.db.add(u)
    w.db.commit()
    return u


def create(w, name, tills, start=("18:00", "23:00"), *, by=None, move=(), shop=None):
    body = ReportEventCreate(
        shopId=(shop or w.shop).id, name=name, startDate=DAY, startTime=start[0], endDate=DAY, endTime=start[1],
        machineIds=[t.id for t in tills], moveMachineIds=[t.id for t in move],
    )
    out = R.create_report_event(body, current_user=by or w.admin, active_tenant_id=w.tenant.id, db=w.db)
    return w.db.query(ReportEvent).filter(ReportEvent.id == uuid.UUID(out["id"])).one()


def bulk(w, event, *, add=(), remove=(), move=(), by=None):
    body = ReportEventTillsChange(
        add=[t.id for t in add], remove=[t.id for t in remove], move=[t.id for t in move],
    )
    return R.change_report_event_tills(
        event.id, body, current_user=by or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def tills_of(w, event):
    w.db.expire_all()
    return {
        r.machine_id
        for r in w.db.query(ReportEventMachine).filter(ReportEventMachine.event_id == event.id).all()
    }


def history(w, event=None):
    q = w.db.query(ReportEventMachineChange)
    if event is not None:
        q = q.filter(ReportEventMachineChange.event_id == event.id)
    return sorted((r.action, r.machine_id, r.other_event_id) for r in q.all())


# ── The bulk assignment ───────────────────────────────────────────────────────


def test_bulk_adds_and_removes_in_one_go_and_records_who(w):
    t1, t2, t3 = w.tills
    event = create(w, "ערב", [t1])
    out = bulk(w, event, add=[t2, t3], remove=[t1])
    assert set(out["machineIds"]) == {str(t2.id), str(t3.id)}
    assert set(out["changes"]["added"]) == {str(t2.id), str(t3.id)}
    assert out["changes"]["removed"] == [str(t1.id)] and out["changes"]["moved"] == []
    assert tills_of(w, event) == {t2.id, t3.id}
    assert history(w, event) == sorted([
        ("added", t1.id, None), ("added", t2.id, None), ("added", t3.id, None), ("removed", t1.id, None),
    ])
    assert {r.user_id for r in w.db.query(ReportEventMachineChange).all()} == {w.admin.id}
    # Adding a till already there, removing one that is not: nothing to do, nothing recorded.
    again = bulk(w, event, add=[t2], remove=[t1])
    assert again["changes"] == {"added": [], "removed": [], "moved": []}
    assert len(history(w, event)) == 4
    view = R.get_report_event_till_changes(event.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert {(c["action"], c["machineName"]) for c in view["changes"]} == {
        ("added", "Till 1"), ("added", "Till 2"), ("added", "Till 3"), ("removed", "Till 1"),
    }
    assert all(c["by"] == "admin" for c in view["changes"])


def test_a_till_cannot_be_added_and_removed_together(w):
    t1, *_ = w.tills
    event = create(w, "ערב", [])
    with pytest.raises(HTTPException) as e:
        bulk(w, event, add=[t1], remove=[t1])
    assert e.value.status_code == 422 and e.value.detail["code"] == "invalid_change"


def test_a_busy_till_is_refused_and_nothing_else_changes(w):
    t1, t2, t3 = w.tills
    festival = create(w, "פסטיבל", [t1], ("17:00", "21:00"))
    event = create(w, "ערב", [t2])
    with pytest.raises(HTTPException) as e:
        bulk(w, event, add=[t3, t1], remove=[t2])
    assert e.value.status_code == 409
    detail = e.value.detail
    assert detail["code"] == "till_in_overlapping_event"
    assert detail["eventName"] == "פסטיבל" and detail["machineId"] == str(t1.id)
    assert [b["machineId"] for b in detail["busy"]] == [str(t1.id)]
    # All or nothing: Till 3 was not added and Till 2 not removed.
    assert tills_of(w, event) == {t2.id}
    assert tills_of(w, festival) == {t1.id}
    assert history(w, event) == [("added", t2.id, None)]


def test_move_takes_the_till_out_of_the_other_event_and_records_both_sides(w):
    t1, t2, _t3 = w.tills
    festival = create(w, "פסטיבל", [t1, t2], ("17:00", "21:00"))
    event = create(w, "ערב", [])
    out = bulk(w, event, move=[t1])
    assert out["machineIds"] == [str(t1.id)]
    assert out["changes"]["moved"] == [{
        "machineId": str(t1.id), "machineName": "Till 1",
        "fromEventId": str(festival.id), "fromEventName": "פסטיבל",
    }]
    assert out["changes"]["added"] == [str(t1.id)]
    assert tills_of(w, event) == {t1.id}
    assert tills_of(w, festival) == {t2.id}
    assert history(w, festival) == sorted([
        ("added", t1.id, None), ("added", t2.id, None), ("moved_out", t1.id, event.id),
    ])
    assert history(w, event) == [("moved_in", t1.id, festival.id)]
    names = {r.action: r.other_event_name for r in w.db.query(ReportEventMachineChange)
             .filter(ReportEventMachineChange.machine_id == t1.id).all()}
    assert names["moved_out"] == "ערב" and names["moved_in"] == "פסטיבל"


def test_move_releases_the_till_from_every_overlapping_event(w):
    t1, *_ = w.tills
    early = create(w, "מוקדם", [t1], ("16:00", "19:00"))
    late = create(w, "מאוחר", [t1], ("20:00", "23:30"))
    later = create(w, "למחרת", [t1], ("23:30", "23:59"))     # does not overlap 18:00–23:00
    event = create(w, "ערב", [])
    out = bulk(w, event, move=[t1])
    assert {m["fromEventName"] for m in out["changes"]["moved"]} == {"מוקדם", "מאוחר"}
    assert tills_of(w, early) == set() and tills_of(w, late) == set()
    assert tills_of(w, later) == {t1.id}
    assert tills_of(w, event) == {t1.id}


def test_a_failed_request_undoes_a_move_already_made(w):
    t1, t2, t3 = w.tills
    festival = create(w, "פסטיבל", [t1], ("17:00", "21:00"))
    stage = create(w, "במה", [t2], ("19:00", "20:00"))
    event = create(w, "ערב", [])
    # Till 1 is asked to move; Till 2 is busy too but not asked to: the whole request fails.
    with pytest.raises(HTTPException) as e:
        bulk(w, event, move=[t1], add=[t2, t3])
    assert e.value.status_code == 409 and e.value.detail["eventName"] == "במה"
    assert tills_of(w, festival) == {t1.id}
    assert tills_of(w, stage) == {t2.id}
    assert tills_of(w, event) == set()
    assert w.db.query(ReportEventMachineChange).filter(
        ReportEventMachineChange.action.in_(["moved_in", "moved_out"])
    ).count() == 0


def test_create_and_edit_can_move_a_till_and_only_when_asked(w):
    t1, t2, _t3 = w.tills
    festival = create(w, "פסטיבל", [t1, t2], ("17:00", "21:00"))
    with pytest.raises(HTTPException) as e:
        create(w, "ערב", [t1])
    assert e.value.status_code == 409
    event = create(w, "ערב", [t1], move=[t1])
    assert tills_of(w, event) == {t1.id} and tills_of(w, festival) == {t2.id}
    assert history(w, event) == [("moved_in", t1.id, festival.id)]
    # Editing: Till 2 is busy until it is named in the move list.
    with pytest.raises(HTTPException) as e:
        R.update_report_event(event.id, ReportEventUpdate(machineIds=[t1.id, t2.id]),
                              current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert e.value.status_code == 409
    R.update_report_event(event.id, ReportEventUpdate(machineIds=[t2.id], moveMachineIds=[t2.id]),
                          current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
    assert tills_of(w, event) == {t2.id} and tills_of(w, festival) == set()
    assert ("removed", t1.id, None) in history(w, event)
    # A till may be moved only into the event it is being assigned to.
    with pytest.raises(HTTPException) as e:
        create(w, "אחר", [], ("08:00", "09:00"), move=[t1])
    assert e.value.status_code == 422 and e.value.detail["code"] == "invalid_move"


# ── Permissions and scope ─────────────────────────────────────────────────────


def test_only_a_managing_role_with_access_to_the_shop_may_assign(w):
    t1, t2, _t3 = w.tills
    event = create(w, "ערב", [t1])
    for role, shop in ((UserRole.CASHIER, w.shop), (UserRole.SHIFT_SUPERVISOR, w.shop), (UserRole.SHOP_MANAGER, w.other_shop)):
        with pytest.raises(HTTPException) as e:
            bulk(w, event, add=[t2], by=user(w, role, shop))
        assert e.value.status_code == 403, role
    assert tills_of(w, event) == {t1.id}
    manager = user(w, UserRole.SHOP_MANAGER, w.shop)
    bulk(w, event, add=[t2], by=manager)
    assert tills_of(w, event) == {t1.id, t2.id}
    assert [r.user_id for r in w.db.query(ReportEventMachineChange)
            .filter(ReportEventMachineChange.machine_id == t2.id).all()] == [manager.id]


def test_an_events_tills_come_only_from_its_shop(w):
    t1, *_ = w.tills
    event = create(w, "ערב", [t1])
    with pytest.raises(HTTPException) as e:
        bulk(w, event, add=[w.other_till])
    assert e.value.status_code == 422 and e.value.detail["code"] == "till_not_in_shop"
    with pytest.raises(HTTPException) as e:
        bulk(w, event, move=[w.other_till])
    assert e.value.detail["code"] == "till_not_in_shop"
    with pytest.raises(HTTPException) as e:      # an unknown id
        R.change_report_event_tills(event.id, ReportEventTillsChange(add=[uuid.uuid4()]), current_user=w.admin,
                                    active_tenant_id=w.tenant.id, db=w.db)
    assert e.value.detail["code"] == "till_not_in_shop"
    assert tills_of(w, event) == {t1.id}


def test_moving_needs_the_right_to_edit_the_other_event(w):
    t1, *_ = w.tills
    center = create(w, "מרכז", [t1])
    # The till went to the North shop; its manager may not touch the Center's event.
    t1.shop_id = w.other_shop.id
    w.db.commit()
    north_manager = user(w, UserRole.SHOP_MANAGER, w.other_shop)
    north = create(w, "צפון", [], shop=w.other_shop, by=north_manager)
    with pytest.raises(HTTPException) as e:
        bulk(w, north, move=[t1], add=[w.other_till], by=north_manager)
    assert e.value.status_code == 403 and e.value.detail["code"] == "cannot_edit_other_event"
    assert e.value.detail["eventName"] == "מרכז"
    assert tills_of(w, center) == {t1.id} and tills_of(w, north) == set()
    # Someone who may edit both moves it.
    bulk(w, north, move=[t1], by=w.admin)
    assert tills_of(w, center) == set() and tills_of(w, north) == {t1.id}


def test_a_confirmed_event_takes_no_tills(w):
    t1, t2, _t3 = w.tills
    event = create(w, "ערב", [t1])
    R.confirm_report_event(event.id, ReportEventConfirm(force=True), current_user=w.admin,
                           active_tenant_id=w.tenant.id, db=w.db)
    with pytest.raises(HTTPException) as e:
        bulk(w, event, add=[t2])
    assert e.value.status_code == 409 and e.value.detail["code"] == "event_confirmed"


def test_another_tenants_event_is_not_found(w):
    t1, *_ = w.tills
    event = create(w, "ערב", [t1])
    with pytest.raises(HTTPException) as e:
        R.change_report_event_tills(event.id, ReportEventTillsChange(add=[]), current_user=w.admin,
                                    active_tenant_id=uuid.uuid4(), db=w.db)
    assert e.value.status_code == 404


# ── What the pickers read ─────────────────────────────────────────────────────


def view(w, exclude=None, window=("19:00", "20:00")):
    return R.get_report_event_tills(
        shop_id=w.shop.id, start_date=DAY, start_time=window[0], end_date=DAY, end_time=window[1],
        exclude_event_id=exclude, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def test_the_till_list_carries_areas_groups_and_kiosks(w):
    t1, t2, t3 = w.tills
    bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר", sort_order=2)
    gate = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="כניסה", sort_order=1)
    w.db.add_all([bar, gate])
    w.db.flush()
    t1.area_id, t2.area_id = bar.id, gate.id
    stands = MachineGroup(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="עמדות אירוע")
    other_company = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="514141414")
    w.db.add_all([stands, other_company])
    w.db.flush()
    foreign = MachineGroup(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other_company.id, name="זר")
    w.db.add(foreign)
    w.db.flush()
    w.db.add_all([
        MachineGroupMember(group_id=stands.id, machine_id=t2.id),
        MachineGroupMember(group_id=stands.id, machine_id=t3.id),
        MachineGroupMember(group_id=foreign.id, machine_id=t1.id),
        KioskDevice(machine_id=t3.id, tenant_id=w.tenant.id, shop_id=w.shop.id, company_id=w.company.id, name="קיוסק"),
    ])
    w.db.commit()
    out = view(w)
    by_name = {t["name"]: t for t in out["tills"]}
    assert by_name["Till 1"]["areaId"] == str(bar.id) and by_name["Till 1"]["areaName"] == "בר"
    assert by_name["Till 2"]["areaId"] == str(gate.id)
    assert by_name["Till 3"]["areaId"] is None
    assert [a["name"] for a in out["areas"]] == ["כניסה", "בר"]
    assert out["groups"] == [{"id": str(stands.id), "name": "עמדות אירוע"}]
    assert by_name["Till 1"]["groupIds"] == []           # the other company's group is not shown
    assert by_name["Till 2"]["groupIds"] == [str(stands.id)]
    assert [t["kind"] for t in out["tills"]] == ["till", "till", "kiosk"]


def test_the_till_list_offers_the_latest_events_to_copy_from(w):
    t1, t2, t3 = w.tills
    first = create(w, "שישי", [t1, t2], ("08:00", "10:00"))
    second = create(w, "שבת", [t3], ("10:00", "12:00"))
    create(w, "ריק", [], ("12:00", "13:00"))                  # no tills: nothing to copy
    out = view(w)
    assert [e["name"] for e in out["recentEvents"]] == ["שבת", "שישי"]
    assert set(out["recentEvents"][1]["machineIds"]) == {str(t1.id), str(t2.id)}
    # The event being edited is not offered; a till no longer in the shop is left out.
    t2.shop_id = w.other_shop.id
    w.db.commit()
    out = view(w, exclude=second.id)
    assert [e["name"] for e in out["recentEvents"]] == ["שישי"]
    assert out["recentEvents"][0]["machineIds"] == [str(t1.id)]
    assert out["recentEvents"][0]["id"] == str(first.id)
