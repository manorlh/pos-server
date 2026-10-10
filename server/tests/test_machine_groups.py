"""
"קבוצות מכשירים" (app/services/machine_groups.py): named groups of tills across the shops of one
company, and the menus' `group` assignment level — machine > group > area > shop > company; between
a till's groups the higher priority, then the most recently updated assignment. The till is told its
groups in the catalog pull, and a change to a group reaches it on the next delta.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models.catalog_menu import ASSIGNMENT_LEVELS, CatalogMenuAssignment
from app.models.machine_group import MachineGroup, MachineGroupMember
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.routers import machine_groups as GR
from app.schemas.machine_group import MachineGroupCreate, MachineGroupMembersIn, MachineGroupUpdate
from app.services import catalog_menu_rules as RULES
from app.services import catalog_menus as CM
from app.services import machine_groups as G
from shift_world import NOW
from test_catalog_menus import active, assign, create, mw, pull  # noqa: F401
from test_shop_areas import _ctx, refused, w  # noqa: F401


def group(w, name, *tills, company=None):
    body = MachineGroupCreate.model_validate({
        "name": name, "companyId": str((company or w.company).id), "machineIds": [str(t.id) for t in tills],
    })
    return GR.create_machine_group(body, BackgroundTasks(), **_ctx(w))


def at_noon():
    return NOW.replace(hour=10, minute=0, second=0, microsecond=0)


# ── The rules ────────────────────────────────────────────────────────────────


class TestRules:
    def test_the_levels_and_their_order(self):
        assert ASSIGNMENT_LEVELS == ("company", "shop", "area", "group", "machine")
        ranks = [RULES.rank({"level": lvl, "depth": 0}) for lvl in ("machine", "group", "area", "shop", "company")]
        assert ranks == sorted(ranks, reverse=True) and len(set(ranks)) == 5
        # A company far above is still below the shop; an unknown level below every company.
        assert RULES.rank({"level": "group"}) > RULES.rank({"level": "area"}) > RULES.rank({"level": "company", "depth": 3})
        assert RULES.rank({"level": "nope"}) < RULES.rank({"level": "company", "depth": 99})

    def test_updated_at_in_whole_milliseconds(self):
        assert RULES.updated_ms({"updatedAt": "1970-01-01T00:00:01.5009+00:00"}) == 1500
        assert RULES.updated_ms({"updatedAt": "2026-10-05T10:00:00Z"}) == RULES.updated_ms(
            {"updatedAt": "2026-10-05T13:00:00+03:00"}
        )
        for bad in (None, "", "yesterday", "2026-10-05T10:00:00", 5):
            assert RULES.updated_ms({"updatedAt": bad}) == 0

    def test_between_groups_priority_then_the_newest_then_the_name(self):
        menu = lambda i, name: {"id": i, "name": name, "channel": "both", "schedule": {"always": True}}  # noqa: E731
        block = {
            "menus": [menu("a", "א"), menu("b", "ב"), menu("c", "ג")],
            "assignments": [
                {"menuId": "a", "level": "group", "priority": 0, "updatedAt": "2026-10-01T10:00:00+00:00"},
                {"menuId": "b", "level": "group", "priority": 0, "updatedAt": "2026-10-02T10:00:00+00:00"},
                {"menuId": "c", "level": "area", "priority": 99},
            ],
        }
        at = datetime(2026, 10, 6, 12, 0)
        assert RULES.resolve(block, at)["menuId"] == "b"
        block["assignments"][0]["priority"] = 1
        assert RULES.resolve(block, at)["menuId"] == "a"
        # Without a time (an older block): the name, as before.
        for a in block["assignments"]:
            a.pop("updatedAt", None)
            a["priority"] = 0 if a["level"] == "group" else a["priority"]
        assert RULES.resolve(block, at)["menuId"] == "a"


# ── The groups ───────────────────────────────────────────────────────────────


class TestGroups:
    def test_create_list_rename_members_delete(self, mw):  # noqa: F811
        out = group(mw, "  קיוסקים ", mw.t1, mw.other_till)
        assert out["name"] == "קיוסקים" and out["companyId"] == str(mw.company.id)
        assert set(out["machineIds"]) == {str(mw.t1.id), str(mw.other_till.id)}
        assert {m["shopName"] for m in out["machines"]} == {"Center", "North"}
        assert out["canEdit"] is True
        listed = GR.list_machine_groups(company_id=None, **_ctx(mw))
        assert [g["name"] for g in listed] == ["קיוסקים"]

        gid = out["id"]
        renamed = GR.update_machine_group(gid, MachineGroupUpdate(name="בר"), BackgroundTasks(), **_ctx(mw))
        assert renamed["name"] == "בר"
        members = GR.set_machine_group_members(
            gid, MachineGroupMembersIn(machineIds=[mw.t2.id]), BackgroundTasks(), **_ctx(mw),
        )
        assert members["machineIds"] == [str(mw.t2.id)]

        GR.delete_machine_group(gid, BackgroundTasks(), **_ctx(mw))
        assert mw.db.query(MachineGroup).count() == 0
        assert mw.db.query(MachineGroupMember).count() == 0

    def test_a_name_once_per_company(self, mw):  # noqa: F811
        group(mw, "בר")
        with pytest.raises(HTTPException) as e:
            group(mw, " בר ")
        assert (e.value.status_code, e.value.detail) == (409, G.NAME_TAKEN)

    def test_only_active_tills_of_the_groups_company(self, mw):  # noqa: F811
        rival_shop = Shop(id=uuid.uuid4(), tenant_id=mw.tenant.id, company_id=mw.rival.id, name="Rival 1", settings={})
        mw.db.add(rival_shop)
        mw.db.flush()
        rival_till = POSMachine(
            id=uuid.uuid4(), tenant_id=mw.tenant.id, shop_id=rival_shop.id, name="Rival till",
            distributor_id=mw.admin.id, is_active=True, machine_code="M-RIVAL", pos_number="77",
        )
        mw.db.add(rival_till)
        mw.db.commit()
        with pytest.raises(HTTPException) as e:
            group(mw, "בר", mw.t1, rival_till)
        assert e.value.detail == f"{G.NOT_IN_COMPANY}:{rival_till.id}"
        mw.t2.is_active = False
        mw.db.commit()
        with pytest.raises(HTTPException) as e:
            group(mw, "בר", mw.t2)
        assert e.value.detail.startswith(G.NOT_IN_COMPANY)
        assert mw.db.query(MachineGroup).count() == 0

    def test_a_group_of_the_company_above_takes_tills_of_the_companies_below(self, mw):  # noqa: F811
        out = group(mw, "כל הקיוסקים", mw.t1, company=mw.group)
        assert out["machineIds"] == [str(mw.t1.id)]


# ── Menus on a group ─────────────────────────────────────────────────────────


class TestMenusOnAGroup:
    def test_a_group_beats_the_point_of_sale_and_the_till_beats_the_group(self, mw):  # noqa: F811
        area_menu = create(mw, name="נקודת מכירה")
        group_menu = create(mw, name="קבוצה")
        till_menu = create(mw, name="קופה")
        g = group(mw, "בר", mw.t1)
        assign(mw, "area", mw.bar, (area_menu, 50))
        assign(mw, "group", MachineGroup(id=uuid.UUID(g["id"])), group_menu)
        assert active(mw, mw.t1, at_noon())["menuId"] == group_menu["id"]
        assert active(mw, mw.t1, at_noon())["level"] == "group"
        # A till not in the group: the point of sale's (t2 is not in "Bar" either: none).
        assert active(mw, mw.t2, at_noon())["mode"] == "catalog"
        assign(mw, "machine", mw.t1, till_menu)
        assert active(mw, mw.t1, at_noon())["menuId"] == till_menu["id"]

    def test_two_groups_the_higher_priority_then_the_most_recently_updated(self, mw):  # noqa: F811
        first = create(mw, name="א — ראשון")
        second = create(mw, name="ת — אחרון")
        g1 = MachineGroup(id=uuid.UUID(group(mw, "קיוסקים", mw.t1)["id"]))
        g2 = MachineGroup(id=uuid.UUID(group(mw, "עמדות אירוע", mw.t1)["id"]))
        assign(mw, "group", g1, first)
        assign(mw, "group", g2, second)
        # One priority: the newer assignment, not the name.
        assert active(mw, mw.t1, at_noon())["menuId"] == second["id"]
        assign(mw, "group", g1, (first, 1))
        assert active(mw, mw.t1, at_noon())["menuId"] == first["id"]

    def test_the_pull_tells_the_till_its_groups_and_each_group_assignments_time(self, mw):  # noqa: F811
        menu = create(mw, name="בר")
        g = group(mw, "בר", mw.t1)
        assign(mw, "group", MachineGroup(id=uuid.UUID(g["id"])), menu)
        block = pull(mw, mw.t1)["catalogMenus"]
        assert block["groups"] == [{"id": g["id"], "name": "בר"}]
        [a] = block["assignments"]
        assert a["level"] == "group" and a["depth"] == 0 and RULES.updated_ms(a) > 0
        # Another till: neither the group's menu nor any groups.
        other = pull(mw, mw.t2)["catalogMenus"]
        assert other["assignments"] == [] and "groups" not in other

    def test_a_change_to_a_group_reaches_the_till_on_the_next_delta(self, mw):  # noqa: F811
        from app.models.catalog_menu import CatalogMenuSyncState

        menu = create(mw, name="בר")
        g = group(mw, "בר")
        assign(mw, "group", MachineGroup(id=uuid.UUID(g["id"])), menu)
        # Everything so far is older than the till's last pull: a delta carries no menus.
        state = mw.db.query(CatalogMenuSyncState).first()
        state.changed_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
        mw.db.commit()
        since = datetime(2026, 6, 1, tzinfo=timezone.utc)
        assert pull(mw, mw.t1, since=since)["catalogMenus"] is None
        # The till joins the group: its next delta carries the block, its groups and their menus.
        GR.set_machine_group_members(
            g["id"], MachineGroupMembersIn(machineIds=[mw.t1.id]), BackgroundTasks(), **_ctx(mw),
        )
        block = pull(mw, mw.t1, since=since)["catalogMenus"]
        assert block is not None and block["groups"][0]["name"] == "בר"
        assert block["assignments"][0]["menuId"] == menu["id"]

    def test_deleting_a_group_takes_its_menus_off_its_tills(self, mw):  # noqa: F811
        menu = create(mw, name="בר")
        g = group(mw, "בר", mw.t1)
        assign(mw, "group", MachineGroup(id=uuid.UUID(g["id"])), menu, fallback="none")
        GR.delete_machine_group(g["id"], BackgroundTasks(), **_ctx(mw))
        assert mw.db.query(CatalogMenuAssignment).filter(CatalogMenuAssignment.level == "group").count() == 0
        assert active(mw, mw.t1, at_noon())["mode"] == "catalog"

    def test_the_assignments_page_and_the_simulator_know_groups(self, mw):  # noqa: F811
        from app.routers import catalog_menus as R

        menu = create(mw, name="בר")
        g = group(mw, "בר", mw.t1)
        assign(mw, "group", MachineGroup(id=uuid.UUID(g["id"])), (menu, 3))
        tree = R.get_catalog_menu_targets(company_id=None, shop_id=None, **_ctx(mw))
        node = next(t for t in tree["targets"] if t["level"] == "group")
        assert node["id"] == g["id"] and node["parentId"] == str(mw.company.id)
        assert node["machineIds"] == [str(mw.t1.id)] and node["canEdit"] is True
        assert {"level": "group", "targetId": g["id"], "menuId": menu["id"], "priority": 3} in tree["assignments"]
        sim = CM.simulate(mw.db, mw.admin, mw.tenant.id, level="group", target_id=g["id"], at="2026-10-06T12:00", preview=False)
        assert sim["resolution"]["menuId"] == menu["id"] and sim["resolution"]["level"] == "group"
        now = CM.now_overview(mw.db, mw.admin, mw.tenant.id, at="2026-10-06T12:00")
        till_row = next(r for r in now["rows"] if r["id"] == str(mw.t1.id))
        assert till_row["pos"]["menuId"] == menu["id"]

    def test_a_menu_of_another_company_is_out_of_a_groups_reach(self, mw):  # noqa: F811
        rival_menu = create(mw, name="יריב", companyId=str(mw.rival.id))
        g = group(mw, "בר", mw.t1)
        with pytest.raises(HTTPException) as e:
            assign(mw, "group", MachineGroup(id=uuid.UUID(g["id"])), rival_menu)
        assert e.value.detail == CM.OUT_OF_REACH


def test_the_migration_chains_on_the_head_it_was_written_for():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "e8b3f5a1c7d2_machine_groups.py"
    spec = importlib.util.spec_from_file_location("mg_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Written on 6b1e9d4f2a87; re-chained after restricted items' c7e2a9d4f1b6 at the integration merge.
    assert (module.revision, module.down_revision) == ("e8b3f5a1c7d2", "c7e2a9d4f1b6")
    assert "'group'" in module.LEVELS_WITH_GROUP
