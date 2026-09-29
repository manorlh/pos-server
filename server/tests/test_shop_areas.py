"""
Shop areas (docs/AREAS_API.md): a shop's tills grouped into bar, kitchen, terrace.

What each class pins, and how it could look fine while doing damage:

* **CRUD** — one live name per shop whatever its case; an archived area frees its name,
  is never deleted, and cannot be archived while a till stands in it.
* **Membership** — `PUT /areas/{id}/machines` sets exactly the list, refuses a till of
  another shop without changing anything, and tells only the tills that moved.
* **One shop** — every path that changes a till's shop (PUT, pairing assign, unpair,
  shop deletion) takes it out of its area; retiring does too. A till in an area of
  another shop would put one shop's takings in another's report.
* **Stamped, not joined** — a shift keeps the area its till had when the cloud created
  it; moving the till later moves no past total, and its next shift takes the new area.
* **Roll-up, tenancy, permissions, the till** — the area light, isolation, the write
  rule of `PUT /shops`, and the `area` a till reads.

A Z for an area is in tests/test_area_z.py, the area reports in tests/test_area_reports.py;
both use this world. Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

from app.models.company import Company
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shift import Shift
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.shop_register_sequence import ShopRegisterSequence
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.routers import areas as areas_router
from app.routers import machines as machines_router
from app.routers import shifts as shifts_router
from app.routers import shops as shops_router
from app.routers import sync as sync_router
from app.schemas.area import AreaCreate, AreaMembershipIn, AreaUpdate
from app.schemas.pos_machine import POSMachineResponse, POSMachineUpdate
from app.schemas.shift import ShiftCloseIn, ShiftOpenIn
from app.services import ably_notify
from app.services import pairing as P
from app.services.machine_status import ALL_STATUSES, ROLLUP_SEVERITY, MachineStatus, rollup_status
from app.services.register_number import set_machine_shop
from app.services.shifts import apply_shift_close, report_shift_open
from shift_world import NOW, TODAY, accept_str_uuids, freeze_z_run_clock, make_world


# ── World ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    db = world.db
    # The register counters exist, so moving a till draws a number without the
    # Postgres-only fallback query (`~` is not SQLite).
    for shop in (world.shop, world.other_shop):
        db.add(ShopRegisterSequence(shop_id=shop.id, next_value=10))
    world.notified = []
    monkeypatch.setattr(
        ably_notify,
        "publish_settings_notify",
        lambda tenant_id, machine_id, **kw: world.notified.append((machine_id, kw.get("reason"))),
    )
    monkeypatch.setattr(ably_notify, "publish_close_shift_notify", lambda *a, **k: None)
    monkeypatch.setattr(machines_router, "shop_belongs_to_company", lambda *a: True)

    def user(role, name, **kw):
        u = User(id=uuid.uuid4(), role=role, tenant_id=world.tenant.id, email=f"{name}@x", username=name, **kw)
        db.add(u)
        return u

    world.manager = user(UserRole.SHOP_MANAGER, "manager", shop_id=world.shop.id)
    world.cashier = user(UserRole.CASHIER, "cashier", shop_id=world.shop.id)
    world.north_manager = user(UserRole.SHOP_MANAGER, "north", shop_id=world.other_shop.id)
    world.company_manager = user(UserRole.COMPANY_MANAGER, "cm", company_id=world.company.id)

    # Another tenant, with a shop and an area of its own.
    tenant2 = Tenant(id=uuid.uuid4(), name="T2", slug="t2", timezone="Asia/Jerusalem")
    db.add(tenant2)
    db.flush()
    company2 = Company(id=uuid.uuid4(), tenant_id=tenant2.id, name="Other", vat_number="1")
    db.add(company2)
    db.flush()
    world.foreign_shop = Shop(id=uuid.uuid4(), tenant_id=tenant2.id, company_id=company2.id, name="Far", settings={})
    db.add(world.foreign_shop)
    db.flush()
    world.foreign_area = ShopArea(id=uuid.uuid4(), tenant_id=tenant2.id, shop_id=world.foreign_shop.id, name="Bar")
    db.add(world.foreign_area)
    db.commit()
    return world


def _ctx(w, user=None):
    return dict(current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db)


def create(w, name, *, shop=None, sort_order=None, user=None):
    return areas_router.create_shop_area(
        (shop or w.shop).id, AreaCreate(name=name, sortOrder=sort_order), **_ctx(w, user)
    )


def listed(w, *, shop=None, include_archived=False, user=None):
    return areas_router.list_shop_areas((shop or w.shop).id, include_archived=include_archived, **_ctx(w, user))


def members(w, area_id, *machines, user=None):
    return areas_router.set_area_machines(
        area_id, AreaMembershipIn(machineIds=[m.id for m in machines]), **_ctx(w, user)
    )


def put_machine(w, machine, user=None, **fields):
    return machines_router.update_machine(
        str(machine.id), POSMachineUpdate(**fields), **_ctx(w, user)
    )


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def area_row(w, area_id) -> ShopArea:
    return w.db.get(ShopArea, area_id if isinstance(area_id, uuid.UUID) else uuid.UUID(str(area_id)))


def open_shift(w, till, seq=1, *, opened_at=None):
    """A shift the till reports opening — through the real path that creates it."""
    return report_shift_open(
        w.db,
        till,
        ShiftOpenIn(
            id=uuid.uuid4(),
            businessDate=TODAY,
            sequenceNumber=seq,
            openedAt=opened_at or (NOW - timedelta(hours=10) + timedelta(minutes=seq)),
            openingCash="100.00",
        ),
    )


def close_shift(w, till, shift, docs=()):
    made = [w.doc(till, shift, **spec) for spec in docs]
    body = ShiftCloseIn.model_validate({
        "closedAt": (shift.opened_at + timedelta(hours=4)).isoformat(),
        "countedCash": None,
        "transactionIds": [str(d.id) for d in made],
    })
    shift, outcome = apply_shift_close(w.db, till, shift.id, body)
    assert outcome == "accepted"
    return shift


def closed_shift(w, till, seq, docs=()):
    return close_shift(w, till, open_shift(w, till, seq), docs)


# ── CRUD ──────────────────────────────────────────────────────────────────────


class TestCreateAndList:
    def test_a_new_area_is_empty_trimmed_and_unlit(self, w):
        out = create(w, "  Bar  ", sort_order=2)

        assert out["name"] == "Bar"
        assert out["shopId"] == w.shop.id
        assert out["sortOrder"] == 2
        assert out["archivedAt"] is None
        assert out["machineCount"] == 0
        assert out["status"]["worst"] is None
        assert set(out["status"]["counts"]) == set(ALL_STATUSES)
        assert not any(out["status"]["counts"].values())
        assert area_row(w, out["id"]).tenant_id == w.tenant.id

    @pytest.mark.parametrize("name", ["", "   ", "x" * 101, None])
    def test_a_name_must_be_real_text_of_at_most_100(self, name):
        with pytest.raises(ValidationError):
            AreaCreate(name=name)

    def test_one_hundred_characters_is_fine(self):
        assert AreaCreate(name="x" * 100).name == "x" * 100

    def test_the_name_is_unique_per_shop_whatever_its_case(self, w):
        create(w, "Bar")

        assert refused(create, w, "bAR ").detail == "area_name_taken"
        # Another shop may have its own bar.
        assert create(w, "Bar", shop=w.other_shop)["name"] == "Bar"

    def test_listed_by_sort_order_then_name_with_archived_on_request(self, w):
        kitchen = create(w, "Kitchen", sort_order=1)
        create(w, "Terrace", sort_order=0)
        create(w, "Bar", sort_order=1)
        areas_router.archive_shop_area(kitchen["id"], **_ctx(w))

        assert [a["name"] for a in listed(w)] == ["Terrace", "Bar"]
        everything = listed(w, include_archived=True)
        assert [a["name"] for a in everything] == ["Terrace", "Bar", "Kitchen"]
        assert everything[2]["archivedAt"] is not None

    def test_the_database_refuses_a_second_live_name_but_not_an_archived_one(self, w):
        db = w.db
        db.add(ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="Bar"))
        db.flush()
        db.add(ShopArea(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="bar",
            archived_at=NOW,
        ))
        db.flush()
        db.add(ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="BAR"))
        with pytest.raises(IntegrityError):
            db.flush()


class TestRenameArchiveRestore:
    def test_rename_and_reorder(self, w):
        bar = create(w, "Bar")

        out = areas_router.update_shop_area(bar["id"], AreaUpdate(name="Main bar", sortOrder=5), **_ctx(w))

        assert (out["name"], out["sortOrder"]) == ("Main bar", 5)

    def test_a_rename_onto_a_live_name_is_refused_but_a_change_of_case_is_not(self, w):
        bar = create(w, "Bar")
        create(w, "Kitchen")

        assert refused(
            areas_router.update_shop_area, bar["id"], AreaUpdate(name="kitchen"), **_ctx(w)
        ).detail == "area_name_taken"
        assert areas_router.update_shop_area(bar["id"], AreaUpdate(name="BAR"), **_ctx(w))["name"] == "BAR"

    def test_an_archived_area_cannot_be_renamed_but_can_be_reordered(self, w):
        bar = create(w, "Bar")
        areas_router.archive_shop_area(bar["id"], **_ctx(w))

        assert refused(
            areas_router.update_shop_area, bar["id"], AreaUpdate(name="Pub"), **_ctx(w)
        ).detail == "area_archived"
        assert areas_router.update_shop_area(bar["id"], AreaUpdate(sortOrder=9), **_ctx(w))["sortOrder"] == 9

    def test_archive_is_refused_while_an_active_till_stands_in_it(self, w):
        bar = create(w, "Bar")
        members(w, bar["id"], w.tills[0])

        assert refused(areas_router.archive_shop_area, bar["id"], **_ctx(w)).detail == "area_has_machines"

        members(w, bar["id"])
        out = areas_router.archive_shop_area(bar["id"], **_ctx(w))
        assert out["archivedAt"] is not None

    def test_archive_is_idempotent_and_never_deletes(self, w):
        bar = create(w, "Bar")
        first = areas_router.archive_shop_area(bar["id"], **_ctx(w))["archivedAt"]

        again = areas_router.archive_shop_area(bar["id"], **_ctx(w))

        assert again["archivedAt"] == first
        assert area_row(w, bar["id"]) is not None

    def test_an_archived_name_is_free_and_restoring_onto_it_is_refused(self, w):
        old = create(w, "Bar")
        areas_router.archive_shop_area(old["id"], **_ctx(w))
        new = create(w, "bar")

        assert refused(areas_router.restore_shop_area, old["id"], **_ctx(w)).detail == "area_name_taken"

        areas_router.update_shop_area(new["id"], AreaUpdate(name="New bar"), **_ctx(w))
        restored = areas_router.restore_shop_area(old["id"], **_ctx(w))
        assert restored["archivedAt"] is None
        # Idempotent.
        assert areas_router.restore_shop_area(old["id"], **_ctx(w))["archivedAt"] is None

    def test_an_unknown_area_is_404(self, w):
        assert refused(areas_router.archive_shop_area, uuid.uuid4(), **_ctx(w)).status_code == 404


# ── Membership ────────────────────────────────────────────────────────────────


class TestMembership:
    def test_the_area_becomes_exactly_the_list(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        kitchen = create(w, "Kitchen")
        members(w, kitchen["id"], t2)
        members(w, bar["id"], t1)
        w.notified.clear()

        # t2 comes over from the kitchen, t1 is left out.
        out = members(w, bar["id"], t2)

        assert [m["id"] for m in out["machines"]] == [t2.id]
        assert out["machineCount"] == 1
        w.db.refresh(t1), w.db.refresh(t2)
        assert t1.area_id is None
        assert str(t2.area_id) == str(bar["id"])
        assert listed(w)[1]["machineCount"] == 0  # the kitchen
        assert sorted(m for m, _ in w.notified) == sorted([str(t1.id), str(t2.id)])
        assert {reason for _, reason in w.notified} == {"area_changed"}

    def test_setting_the_same_list_again_changes_and_tells_nobody(self, w):
        bar = create(w, "Bar")
        members(w, bar["id"], *w.tills)
        stamp = w.db.get(POSMachine, w.tills[0].id).area_changed_at
        w.notified.clear()

        members(w, bar["id"], *w.tills)

        assert w.notified == []
        assert w.db.get(POSMachine, w.tills[0].id).area_changed_at == stamp

    def test_a_till_of_another_shop_is_refused_and_nothing_changes(self, w):
        bar = create(w, "Bar")
        members(w, bar["id"], w.tills[0])

        e = refused(members, w, bar["id"], w.tills[1], w.other_till)

        assert (e.status_code, e.detail) == (400, f"machine_not_in_shop:{w.other_till.id}")
        w.db.rollback()
        assert str(w.db.get(POSMachine, w.tills[0].id).area_id) == str(bar["id"])
        assert w.db.get(POSMachine, w.tills[1].id).area_id is None

    def test_an_unknown_or_retired_till_is_not_in_the_shop(self, w):
        bar = create(w, "Bar")
        ghost = uuid.uuid4()
        e = refused(
            areas_router.set_area_machines, bar["id"], AreaMembershipIn(machineIds=[ghost]), **_ctx(w)
        )
        assert e.detail == f"machine_not_in_shop:{ghost}"

        w.tills[1].is_active = False
        w.db.commit()
        assert refused(members, w, bar["id"], w.tills[1]).detail == f"machine_not_in_shop:{w.tills[1].id}"

    def test_an_archived_area_takes_no_tills(self, w):
        bar = create(w, "Bar")
        areas_router.archive_shop_area(bar["id"], **_ctx(w))

        assert refused(members, w, bar["id"], w.tills[0]).detail == "area_archived"


# ── Machines ──────────────────────────────────────────────────────────────────


class TestMachineAreaField:
    def test_put_sets_clears_and_omitted_leaves_it(self, w):
        till = w.tills[0]
        bar = create(w, "Bar")

        out = put_machine(w, till, areaId=bar["id"])
        assert str(out.area_id) == str(bar["id"])
        assert POSMachineResponse.model_validate(out).model_dump(by_alias=True)["areaName"] == "Bar"
        assert w.notified == [(str(till.id), "area_changed")]

        put_machine(w, till, name="Renamed")
        assert str(w.db.get(POSMachine, till.id).area_id) == str(bar["id"])

        put_machine(w, till, areaId=None)
        assert w.db.get(POSMachine, till.id).area_id is None

    def test_an_area_of_another_shop_or_unknown_is_refused(self, w):
        north_bar = create(w, "Bar", shop=w.other_shop)

        assert refused(put_machine, w, w.tills[0], areaId=north_bar["id"]).detail == "area_not_in_machine_shop"
        assert refused(put_machine, w, w.tills[0], areaId=uuid.uuid4()).detail == "area_not_in_machine_shop"
        assert refused(put_machine, w, w.tills[0], areaId=w.foreign_area.id).detail == "area_not_in_machine_shop"

    def test_an_archived_area_is_refused(self, w):
        bar = create(w, "Bar")
        areas_router.archive_shop_area(bar["id"], **_ctx(w))

        assert refused(put_machine, w, w.tills[0], areaId=bar["id"]).detail == "area_archived"

    def test_listing_and_reading_carry_the_area_and_filter_on_it(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        members(w, bar["id"], t1)

        def ids(area_id):
            rows = machines_router.list_machines(
                skip=0, limit=100, shop_id=None, tenant_id=None, distributor_id=None,
                include_inactive=False, area_id=area_id, **_ctx(w),
            )
            return {r["id"] for r in rows}, rows

        in_bar, rows = ids(str(bar["id"]))
        assert in_bar == {t1.id}
        assert (rows[0]["areaId"], rows[0]["areaName"]) == (t1.area_id, "Bar")
        assert ids("none")[0] == {t2.id, w.other_till.id}
        assert ids(None)[0] == {t1.id, t2.id, w.other_till.id}
        assert refused(ids, "bar").status_code == 422

        one = machines_router.get_machine(str(t2.id), **_ctx(w))
        assert (one["areaId"], one["areaName"]) == (None, None)


class TestAChangeOfShopLeavesTheArea:
    """`area.shop_id == machine.shop_id`, on every path that moves a till."""

    def _in_bar(self, w, till=None):
        bar = create(w, "Bar")
        members(w, bar["id"], till or w.tills[0])
        return bar

    def test_put_shop_clears_the_area(self, w):
        self._in_bar(w)

        put_machine(w, w.tills[0], shopId=w.other_shop.id)

        till = w.db.get(POSMachine, w.tills[0].id)
        assert str(till.shop_id) == str(w.other_shop.id)
        assert till.area_id is None
        assert (str(till.id), "area_changed") in w.notified

    def test_put_shop_with_an_area_of_the_new_shop_seats_it_there(self, w):
        self._in_bar(w)
        terrace = create(w, "Terrace", shop=w.other_shop)

        put_machine(w, w.tills[0], shopId=w.other_shop.id, areaId=terrace["id"])

        assert str(w.db.get(POSMachine, w.tills[0].id).area_id) == str(terrace["id"])

    def test_put_shop_with_an_area_of_the_old_shop_is_refused(self, w):
        bar = self._in_bar(w)

        e = refused(put_machine, w, w.tills[0], shopId=w.other_shop.id, areaId=bar["id"])

        assert e.detail == "area_not_in_machine_shop"

    def test_put_of_its_own_shop_keeps_the_area(self, w):
        bar = self._in_bar(w)

        put_machine(w, w.tills[0], shopId=w.shop.id)

        assert str(w.db.get(POSMachine, w.tills[0].id).area_id) == str(bar["id"])

    def test_retiring_clears_the_area(self, w):
        self._in_bar(w)

        put_machine(w, w.tills[0], isActive=False)

        assert w.db.get(POSMachine, w.tills[0].id).area_id is None

    def test_set_machine_shop_is_the_one_writer(self, w):
        self._in_bar(w)
        till = w.db.get(POSMachine, w.tills[0].id)

        set_machine_shop(w.db, till, None)

        assert till.area_id is None and till.area_changed_at is not None

    def test_pairing_assign_to_another_shop_clears_it(self, w):
        self._in_bar(w)
        till = w.db.get(POSMachine, w.tills[0].id)
        till.pairing_status = PairingStatus.PAIRED
        w.db.commit()

        P.assign_machine_to_shop(w.db, till.id, w.other_shop.id)

        assert w.db.get(POSMachine, till.id).area_id is None

    def test_a_replacement_keeps_the_same_till_in_the_same_area(self, w):
        bar = self._in_bar(w)

        P.adopt_machine(w.db, w.tills[0].id, device_info={"serial": "NEW"})

        assert str(w.db.get(POSMachine, w.tills[0].id).area_id) == str(bar["id"])

    def test_unpairing_a_till_with_history_clears_it(self, w):
        self._in_bar(w)
        w.doc(w.tills[0], None, "5.00")  # history, so the delete is a soft one
        w.db.commit()

        out = machines_router.delete_machine(str(w.tills[0].id), **_ctx(w))

        assert out["mode"] == "soft"
        assert w.db.get(POSMachine, w.tills[0].id).area_id is None

    def test_deleting_the_shop_takes_its_tills_out_of_its_areas(self, w):
        self._in_bar(w)

        shops_router.delete_shop(str(w.shop.id), **_ctx(w))

        till = w.db.get(POSMachine, w.tills[0].id)
        assert till.shop_id is None and till.area_id is None
        assert w.db.query(ShopArea).filter(ShopArea.shop_id == w.shop.id).count() == 0


# ── Shifts: stamped, not joined ───────────────────────────────────────────────


class TestShiftStamp:
    def test_a_shift_takes_its_tills_area_when_the_cloud_creates_it(self, w):
        bar = create(w, "Bar")
        members(w, bar["id"], w.tills[0])

        shift = open_shift(w, w.db.get(POSMachine, w.tills[0].id))

        assert str(shift.area_id) == str(bar["id"])

    def test_moving_the_till_later_does_not_move_the_shift_and_the_next_takes_the_new_area(self, w):
        till = w.tills[0]
        bar = create(w, "Bar")
        terrace = create(w, "Terrace")
        members(w, bar["id"], till)
        first = open_shift(w, till, 1)

        # Moved while the shift is open, and the till reports it again (idempotent open).
        members(w, terrace["id"], till)
        report_shift_open(
            w.db, till,
            ShiftOpenIn(id=first.id, businessDate=TODAY, sequenceNumber=1, openedAt=first.opened_at),
        )
        close_shift(w, till, first, [dict(total="10.00")])
        second = open_shift(w, till, 2)

        assert str(w.db.get(Shift, first.id).area_id) == str(bar["id"])
        assert str(second.area_id) == str(terrace["id"])

    def test_a_shift_opened_by_a_sale_is_stamped_too(self, w):
        from app.services.shifts import _new_shift

        bar = create(w, "Bar")
        members(w, bar["id"], w.tills[0])

        shift = _new_shift(w.db.get(POSMachine, w.tills[0].id), shift_id=None, business_date=None, opened_at=None)

        assert str(shift.area_id) == str(bar["id"])

    def test_the_shift_list_reads_and_filters_on_the_stamp(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        members(w, bar["id"], t1)
        in_bar = closed_shift(w, t1, 1)
        members(w, bar["id"], t2)  # t1 leaves the bar afterwards
        unassigned = closed_shift(w, t1, 2)
        w.db.commit()

        def listed_shifts(area_id):
            out = shifts_router.list_shifts(
                shop_id=None, machine_id=None, status_=None, awaiting_z=None,
                from_date=None, to_date=None, area_id=area_id, page=1, page_size=50, **_ctx(w),
            )
            return out.items

        rows = listed_shifts(str(bar["id"]))
        assert [s.id for s in rows] == [in_bar.id]
        dumped = rows[0].model_dump(by_alias=True)
        assert (dumped["areaId"], dumped["areaName"]) == (in_bar.area_id, "Bar")
        assert [s.id for s in listed_shifts("none")] == [unassigned.id]


# ── Roll-up ───────────────────────────────────────────────────────────────────


class TestRollup:
    def test_the_severity_order_and_its_exclusions(self):
        assert ROLLUP_SEVERITY == (
            "offline_with_unsynced", "offline", "shift_close_pending", "pending_sync",
            "no_open_shift", "online",
        )
        assert MachineStatus.RETIRED not in ROLLUP_SEVERITY
        assert MachineStatus.NOT_PAIRED not in ROLLUP_SEVERITY

    def test_worst_and_counts(self):
        out = rollup_status(["online", "no_open_shift", "offline", "online"])
        assert out["worst"] == "offline"
        assert out["counts"]["online"] == 2 and out["counts"]["offline"] == 1
        assert out["counts"]["pending_sync"] == 0

        assert rollup_status([])["worst"] is None
        assert rollup_status(["not_paired", "retired"])["worst"] is None
        assert rollup_status(["online", "shift_close_pending", "pending_sync"])["worst"] == "shift_close_pending"

    def test_an_areas_status_is_its_active_tills(self, w):
        t1, t2 = w.tills
        bar = create(w, "Bar")
        members(w, bar["id"], t1, t2)
        now = datetime.now(timezone.utc)
        t1.last_heartbeat_at = now - timedelta(seconds=5)  # online, no shift open
        t2.last_heartbeat_at = now - timedelta(hours=2)
        t2.pending_documents = 3  # offline holding sales
        w.db.commit()

        out = listed(w)[0]

        assert out["machineCount"] == 2
        assert out["status"]["worst"] == "offline_with_unsynced"
        assert out["status"]["counts"]["offline_with_unsynced"] == 1
        assert out["status"]["counts"]["no_open_shift"] == 1
        assert {m["status"] for m in out["machines"]} == {"offline_with_unsynced", "no_open_shift"}

        # Retiring t2 takes it out of the area and out of the light.
        put_machine(w, t2, isActive=False)
        out = listed(w)[0]
        assert out["machineCount"] == 1 and out["status"]["worst"] == "no_open_shift"


# ── Tenancy and permissions ───────────────────────────────────────────────────


class TestTenancyAndPermissions:
    def test_another_tenants_shop_and_area_are_forbidden(self, w):
        assert refused(listed, w, shop=w.foreign_shop).detail == "tenant_forbidden"
        assert refused(create, w, "Kitchen", shop=w.foreign_shop).detail == "tenant_forbidden"
        for call in (
            lambda: areas_router.update_shop_area(w.foreign_area.id, AreaUpdate(name="X"), **_ctx(w)),
            lambda: areas_router.archive_shop_area(w.foreign_area.id, **_ctx(w)),
            lambda: areas_router.restore_shop_area(w.foreign_area.id, **_ctx(w)),
            lambda: areas_router.set_area_machines(w.foreign_area.id, AreaMembershipIn(), **_ctx(w)),
        ):
            assert refused(call).detail == "tenant_forbidden"

    def test_whoever_may_edit_the_shop_may_write_its_areas(self, w):
        assert create(w, "Bar", user=w.manager)["name"] == "Bar"
        assert create(w, "Kitchen", user=w.company_manager)["name"] == "Kitchen"

    def test_a_cashier_reads_but_does_not_write(self, w):
        bar = create(w, "Bar")

        assert [a["name"] for a in listed(w, user=w.cashier)] == ["Bar"]
        assert refused(create, w, "Kitchen", user=w.cashier).status_code == 403
        assert refused(members, w, bar["id"], w.tills[0], user=w.cashier).status_code == 403
        assert refused(
            areas_router.update_shop_area, bar["id"], AreaUpdate(name="Pub"), **_ctx(w, w.cashier)
        ).status_code == 403
        assert refused(areas_router.archive_shop_area, bar["id"], **_ctx(w, w.cashier)).status_code == 403

    def test_another_shops_manager_can_neither_read_nor_write(self, w):
        bar = create(w, "Bar")

        assert refused(listed, w, user=w.north_manager).status_code == 403
        assert refused(create, w, "Kitchen", user=w.north_manager).status_code == 403
        assert refused(members, w, bar["id"], w.tills[0], user=w.north_manager).status_code == 403


# ── The till ──────────────────────────────────────────────────────────────────


def settings_of(w, till, since=None):
    return sync_router.get_settings_sync(str(till.id), since=since, machine=till, db=w.db)


class TestTheTillReadsItsArea:
    def test_machines_me_carries_the_area(self, w):
        till = w.tills[0]
        assert machines_router.get_my_machine(machine=till)["area"] is None

        bar = create(w, "Bar")
        members(w, bar["id"], till)
        w.db.refresh(till)

        assert machines_router.get_my_machine(machine=till)["area"] == {"id": str(bar["id"]), "name": "Bar"}

    def test_the_settings_sync_carries_it_and_its_watermark_moves_with_it(self, w):
        till = w.tills[0]
        first = settings_of(w, till)
        assert first.area is None
        since = first.settings_updated_at.isoformat()
        assert settings_of(w, till, since=since).sync_type == "unchanged"

        bar = create(w, "Bar")
        members(w, bar["id"], till)
        w.db.refresh(till)
        moved = settings_of(w, till, since=since)
        assert moved.sync_type == "delta"
        assert moved.area == {"id": str(bar["id"]), "name": "Bar"}

        # Unchanged still says which area — the truth, not a reset to "none".
        since = moved.settings_updated_at.isoformat()
        still = settings_of(w, till, since=since)
        assert still.sync_type == "unchanged" and still.area["name"] == "Bar"

        # A rename moves it too, and tells the tills in the area.
        w.notified.clear()
        area = area_row(w, bar["id"])
        area.updated_at = datetime.now(timezone.utc) - timedelta(seconds=1)  # before the rename
        w.db.commit()
        areas_router.update_shop_area(bar["id"], AreaUpdate(name="Pub"), **_ctx(w))
        renamed = settings_of(w, till, since=since)
        assert renamed.sync_type == "delta" and renamed.area["name"] == "Pub"
        assert w.notified == [(str(till.id), "area_changed")]

    def test_a_till_with_no_shop_has_no_area(self, w):
        till = w.tills[0]
        till.shop_id = None
        assert settings_of(w, till).area is None


# ── Migration ─────────────────────────────────────────────────────────────────


def test_the_migration_is_the_single_head_on_top_of_main():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)

    # One head (later migrations stack on this one: mixed basket is d9e0f1a2b3c4).
    assert len(script.get_heads()) == 1
    assert script.get_revision("c8d9e0f1a2b3").down_revision == "b7c8d9e0f1a2"
