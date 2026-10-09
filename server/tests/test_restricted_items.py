"""
"מחייב אישור מנהל במכירה" (app/services/restricted_items.py): the flag on products and
categories, inherited down the category tree; the permission SELL_RESTRICTED_ITEMS in the till
roles; the till's record of each approval; and kiosks never selling such a product.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.category import Category
from app.models.product import Product
from app.routers import sync as sync_router
from app.schemas.category import CategoryCreate, CategoryResponse, CategoryUpdate
from app.schemas.product import ProductCreate, ProductResponse, ProductUpdate
from app.services import general_item
from app.services import restricted_items as RI
from app.services import till_permissions as TP
from app.services.sync import _serialize_category, _serialize_merged_product, _serialize_product
from test_kiosk_insights import check, w  # noqa: F401
from test_product_availability import world  # noqa: F401
from test_product_channels import _actor, tw  # noqa: F401
from test_product_weighed import _product

A, P, D = TP.ALLOW, TP.APPROVAL, TP.DENY


# ── The tree ──────────────────────────────────────────────────────────────────


class TestInheritance:
    def test_a_flagged_category_restricts_everything_beneath_it(self):
        rows = [
            ("drinks", None, False),
            ("alcohol", "drinks", True),
            ("wine", "alcohol", False),
            ("red", "wine", False),
            ("soft", "drinks", False),
            ("food", None, False),
        ]
        assert RI.restricted_category_ids(rows) == {"alcohol", "wine", "red"}

    def test_the_product_its_category_or_an_ancestor(self):
        cats = RI.restricted_category_ids([("a", None, True), ("b", "a", False), ("c", None, False)])
        assert RI.is_restricted(True, "c", cats)  # its own flag
        assert RI.is_restricted(False, "a", cats)  # its category's
        assert RI.is_restricted(False, "b", cats)  # an ancestor's
        assert not RI.is_restricted(False, "c", cats)
        assert not RI.is_restricted(None, None, cats)

    def test_nothing_flagged_is_nothing_restricted_and_a_cycle_ends(self):
        assert RI.restricted_category_ids([("a", None, False), ("b", "a", False)]) == set()
        # Bad data (a cycle, an unknown parent) never hangs and never restricts by accident.
        assert RI.restricted_category_ids([("a", "b", False), ("b", "a", False), ("c", "zz", False)]) == set()
        assert RI.restricted_category_ids([("a", "b", True), ("b", "a", False)]) == {"a", "b"}

    def test_ids_of_any_kind_are_compared_as_text(self):
        u = uuid.uuid4()
        child = uuid.uuid4()
        cats = RI.restricted_category_ids([(u, None, True), (child, u, False)])
        assert cats == {str(u), str(child)}
        assert RI.is_restricted(False, child, cats) and RI.is_restricted(False, str(child), cats)

    def test_a_kiosk_catalog_leaves_out_restricted_products_and_categories(self):
        categories = [
            {"id": "drinks", "parentId": None, RI.FIELD: False},
            {"id": "alcohol", "parentId": "drinks", RI.FIELD: True},
            {"id": "wine", "parentId": "alcohol"},
        ]
        products = [
            {"id": "cola", "categoryId": "drinks"},
            {"id": "beer", "categoryId": "alcohol"},
            {"id": "merlot", "categoryId": "wine"},
            {"id": "cigars", "categoryId": "drinks", RI.FIELD: True},
        ]
        kept, cats = RI.kiosk_catalog(products, categories)
        assert [p["id"] for p in kept] == ["cola"]
        assert [c["id"] for c in cats] == ["drinks"]
        # A delta carries no parents: the rows that complete the tree are taken from elsewhere.
        kept, cats = RI.kiosk_catalog([{"id": "merlot", "categoryId": "wine"}], [], extra_categories=categories)
        assert kept == [] and cats == []


# ── The API's schemas ─────────────────────────────────────────────────────────

_BASE = {"name": "יין", "price": "50.00", "sku": "W-1", "categoryId": str(uuid.uuid4())}


class TestSchemas:
    def test_a_product_is_not_restricted_unless_told(self):
        assert ProductCreate.model_validate(_BASE).requires_manager_approval is False
        assert ProductCreate.model_validate({**_BASE, "requiresManagerApproval": True}).requires_manager_approval is True

    def test_an_update_leaves_it_alone_unless_sent_and_null_is_not_sent(self):
        assert "requires_manager_approval" not in ProductUpdate.model_validate({"price": "2"}).model_dump(exclude_unset=True)
        assert "requires_manager_approval" not in ProductUpdate.model_validate(
            {"requiresManagerApproval": None}
        ).model_dump(exclude_unset=True)
        assert ProductUpdate.model_validate({"requiresManagerApproval": True}).model_dump(exclude_unset=True) == {
            "requires_manager_approval": True,
        }

    def test_a_category_the_same(self):
        assert CategoryCreate.model_validate({"name": "אלכוהול"}).requires_manager_approval is False
        assert CategoryCreate.model_validate({"name": "אלכוהול", "requiresManagerApproval": True}).requires_manager_approval
        assert "requires_manager_approval" not in CategoryUpdate.model_validate(
            {"requiresManagerApproval": None}
        ).model_dump(exclude_unset=True)
        assert CategoryUpdate.model_validate({"requiresManagerApproval": False}).model_dump(exclude_unset=True) == {
            "requires_manager_approval": False,
        }

    def test_the_responses_always_carry_it(self):
        now = datetime.now(timezone.utc)
        cat = SimpleNamespace(
            id=uuid.uuid4(), tenant_id=None, company_id=None, shop_id=None, catalog_level="global", name="x",
            description=None, color=None, image_url=None, parent_id=None, voucher_id=None, ticket_mode=None,
            requires_manager_approval=None, is_active=True, sort_order=0, created_at=now, updated_at=now,
        )
        assert CategoryResponse.model_validate(cat).model_dump(by_alias=True)["requiresManagerApproval"] is False
        cat.requires_manager_approval = True
        assert CategoryResponse.model_validate(cat).model_dump(by_alias=True)["requiresManagerApproval"] is True
        prod = SimpleNamespace(
            id=uuid.uuid4(), tenant_id=None, company_id=None, shop_id=None, pos_machine_id=None,
            global_product_id=None, catalog_level="global", is_local_override=False, name="x",
            description=None, price=1, sku="1", global_sku=None, sku_auto_assigned=False,
            category_id=uuid.uuid4(), image_url=None, in_stock=True, is_available=True,
            stock_quantity=0, barcode=None, tax_rate=None, voucher_id=None, dietary_tags=None,
            alerts=None, companions=None, allergen_alert=None, allergen_alert_require_ack=None,
            sales_channel=None, requires_manager_approval=True, created_at=now, updated_at=now,
        )
        assert ProductResponse.model_validate(prod).model_dump(by_alias=True)["requiresManagerApproval"] is True


# ── The tills' and kiosks' catalog ────────────────────────────────────────────


class TestSyncPayload:
    def test_both_product_serialisers_ship_the_products_own_flag(self):
        p = _product(is_weighed=False, unit_label=None)
        p.requires_manager_approval = True
        for row in (_serialize_product(p), _serialize_merged_product(p, None, None, uuid.uuid4(), None)):
            assert row["requiresManagerApproval"] is True
        p.requires_manager_approval = None
        assert _serialize_product(p)["requiresManagerApproval"] is False

    def test_from_the_global_row(self):
        global_p = _product(is_weighed=False, unit_label=None)
        global_p.requires_manager_approval = True
        local = _product(is_weighed=False, unit_label=None)
        local.requires_manager_approval = False
        assert _serialize_merged_product(global_p, local, None, uuid.uuid4(), None)["requiresManagerApproval"] is True

    def test_a_category_ships_its_own_flag_and_its_parent(self):
        parent = uuid.uuid4()
        c = Category(id=uuid.uuid4(), name="יין", parent_id=parent, requires_manager_approval=True, is_active=True, sort_order=0)
        row = _serialize_category(c)
        assert row["requiresManagerApproval"] is True and row["parentId"] == str(parent)
        c.requires_manager_approval = None
        assert _serialize_category(c)["requiresManagerApproval"] is False


def test_the_dashboard_routers_store_and_ship_it(monkeypatch):
    from shift_world import accept_str_uuids, make_world

    from app.routers import categories as CR
    from app.routers import products as PR

    accept_str_uuids(monkeypatch)
    world = make_world()
    monkeypatch.setattr(PR, "_trigger_catalog_notify", lambda *a, **k: None)
    monkeypatch.setattr(CR, "_trigger_catalog_notify", lambda *a, **k: None)
    monkeypatch.setattr(PR, "allocate_global_sku", lambda *a, **k: "100001")
    monkeypatch.setattr(PR, "resolve_sku_for_create", lambda db, tenant, sku: (sku, False))
    ctx = dict(current_user=world.admin, active_tenant_id=world.tenant.id, db=world.db)

    cat = CR.create_category(CategoryCreate.model_validate({
        "name": "אלכוהול", "companyId": str(world.company.id), "requiresManagerApproval": True,
    }), **ctx)
    assert world.db.get(Category, cat.id).requires_manager_approval is True
    assert _serialize_category(world.db.get(Category, cat.id))["requiresManagerApproval"] is True
    CR.update_category(str(cat.id), CategoryUpdate.model_validate({"name": "משקאות חריפים"}), **ctx)
    assert world.db.get(Category, cat.id).requires_manager_approval is True
    CR.update_category(str(cat.id), CategoryUpdate.model_validate({"requiresManagerApproval": False}), **ctx)
    assert world.db.get(Category, cat.id).requires_manager_approval is False

    created = PR.create_product(ProductCreate.model_validate({
        "name": "וויסקי", "price": "120.00", "sku": "WH-1", "categoryId": str(cat.id),
        "companyId": str(world.company.id), "requiresManagerApproval": True,
    }), **ctx)
    assert world.db.get(Product, created.id).requires_manager_approval is True
    assert ProductResponse.model_validate(created).model_dump(by_alias=True)["requiresManagerApproval"] is True

    def update(body):
        PR.update_product(str(created.id), ProductUpdate.model_validate(body), **ctx)
        return world.db.get(Product, created.id)

    assert update({"price": "130.00"}).requires_manager_approval is True
    assert update({"requiresManagerApproval": None}).requires_manager_approval is True
    assert update({"requiresManagerApproval": False}).requires_manager_approval is False


class TestFromTheTill:
    """The flag is set in the dashboard ("בהגדרה"): a till neither sets nor clears it."""

    def test_a_product_made_on_the_till_is_never_restricted(self, tw):  # noqa: F811
        body = ProductCreate.model_validate({
            "name": "וודקה", "price": "90.00", "categoryId": str(tw.P.category_id), "requiresManagerApproval": True,
        })
        out = sync_router.machine_create_cloud_product(str(tw.h1.id), body, machine=tw.h1, actor=_actor(), db=tw.db)
        assert tw.db.get(Product, out.id).requires_manager_approval is False

    def test_an_echo_from_the_till_changes_nothing(self, tw):  # noqa: F811
        tw.Q.requires_manager_approval = True
        tw.db.commit()
        sync_router.machine_update_cloud_product(
            str(tw.h1.id), str(tw.Q.id), ProductUpdate.model_validate({"requiresManagerApproval": False, "price": "3.00"}),
            machine=tw.h1, actor=_actor(), db=tw.db,
        )
        assert tw.db.get(Product, tw.Q.id).requires_manager_approval is True


def test_the_general_item_never_needs_a_manager():
    """The calculator sells through it: a dashboard echo of false is fine, true is refused."""
    assert general_item.LOCKED_FIELDS["requires_manager_approval"] is False
    item = SimpleNamespace(is_general=True)
    general_item.check_general_item_update(item, {"requires_manager_approval": False})
    with pytest.raises(HTTPException):
        general_item.check_general_item_update(item, {"requires_manager_approval": True})


# ── The permission ────────────────────────────────────────────────────────────


class TestPermission:
    def test_in_the_sale_group_with_its_scope(self):
        spec = TP.PERMISSIONS_BY_CODE["SELL_RESTRICTED_ITEMS"]
        assert spec.label == "מכירת פריט המחייב אישור מנהל"
        assert spec.group == "sale" and spec.scope == RI.SCOPE == "sale:restricted"
        assert TP.SCOPE_PERMISSIONS["sale:restricted"] == RI.PERMISSION == "SELL_RESTRICTED_ITEMS"
        assert "windows" not in spec.devices

    def test_managers_sell_alone_everyone_else_asks(self):
        states = {key: TP.DEFAULTS[key]["SELL_RESTRICTED_ITEMS"] for key in TP.BUILTIN_BY_KEY}
        assert states == {
            TP.WAITER: P, TP.CASHIER: P, TP.SUPERVISOR: A, TP.MANAGER: A,
            TP.LEGACY_CASHIER: P, TP.LEGACY_MANAGER: A,
        }
        # A role made before the code existed answers from its template — no migration.
        assert TP.effective_permissions(template=TP.MANAGER, role_states={"SELL": A}).allows("SELL_RESTRICTED_ITEMS")
        assert TP.effective_permissions(template=TP.CASHIER).state("SELL_RESTRICTED_ITEMS") == P

    def test_an_older_tills_reading_of_a_role_does_not_move(self):
        assert "SELL_RESTRICTED_ITEMS" not in TP.LEGACY_SENIOR_CODES
        senior_only = {code: (A if code in TP.LEGACY_SENIOR_CODES else D) for code in TP.CODES}
        assert TP.legacy_role_for(senior_only) == "shop_manager"
        assert TP.legacy_role_for(TP.DEFAULTS[TP.MANAGER]) == "shop_manager"
        assert TP.legacy_role_for(TP.DEFAULTS[TP.CASHIER]) == "cashier"

    def test_the_dashboard_reads_it_from_the_catalogue(self):
        by_code = {p["code"]: p for p in TP.catalogue_out()["permissions"]}
        assert by_code["SELL_RESTRICTED_ITEMS"]["scope"] == "sale:restricted"
        assert by_code["SELL_RESTRICTED_ITEMS"]["group"] == "sale"


# ── The till's record of each approval ───────────────────────────────────────


def test_the_till_records_who_approved_which_product_where_and_when(monkeypatch):
    from fastapi import Response

    from app.models.audit_exception import AuditException, TillEvent
    from app.routers import exceptions as ER
    from app.schemas.audit_exception import TillEventIn
    from shift_world import NOW, accept_str_uuids, make_world

    accept_str_uuids(monkeypatch)
    w = make_world()  # noqa: F811
    ident = uuid.uuid4()
    details = {
        "productId": "p-1", "productName": "וויסקי", "quantity": 1, "lineId": "l-1",
        "approvedBy": "דנה כהן", "approvedById": "pu-9", "self": False,
    }
    body = TillEventIn(id=ident, type="restricted_item", occurredAt=NOW, posUserId="pu-1", details=details)
    till = w.tills[0]
    assert ER.post_till_event(str(till.id), body, Response(), machine=till, db=w.db).status == "accepted"
    stored = w.db.get(TillEvent, ident)
    assert stored.event_type == "restricted_item" and stored.machine_id == till.id
    assert stored.details["approvedBy"] == "דנה כהן" and stored.details["productName"] == "וויסקי"
    assert stored.occurred_at is not None
    # For the record only: no exception is raised for it.
    assert w.db.query(AuditException).count() == 0


# ── Kiosks ────────────────────────────────────────────────────────────────────


class TestKiosk:
    def test_the_basket_check_refuses_a_restricted_product(self, w):  # noqa: F811
        w.p["צ'יפס"].requires_manager_approval = True
        w.db.commit()
        out = check(w, [
            {"productId": str(w.p["צ'יפס"].id), "unitPriceAgorot": 1800},
            {"productId": str(w.p["קפה"].id), "unitPriceAgorot": 1200},
        ])
        lines = {l["productId"]: l for l in out["lines"]}
        assert lines[str(w.p["צ'יפס"].id)]["reason"] == "not_on_kiosk"
        assert lines[str(w.p["קפה"].id)]["available"] and out["ok"] is False

    def test_and_everything_under_a_restricted_category(self, w):  # noqa: F811
        w.drinks.requires_manager_approval = True
        w.db.commit()
        out = check(w, [{"productId": str(w.p["קפה"].id), "unitPriceAgorot": 1200}])
        assert out["lines"][0]["reason"] == "not_on_kiosk" and out["ok"] is False


# ── The menu-broadcast review ─────────────────────────────────────────────────


def test_the_broadcast_review_sees_the_flag_but_not_an_older_snapshot():
    from app.services import menu_broadcast as MB

    def snap(product=None, category=None):
        return {
            "products": {"p1": {"name": "יין", "price": 1, "shopListed": True, **(product or {})}},
            "categories": {"c1": {"name": "אלכוהול", **(category or {})}},
        }

    changed = MB.diff(snap({RI.FIELD: False}), snap({RI.FIELD: True}))
    assert [c["field"] for c in changed["products"][0]["changes"]] == [RI.FIELD]
    changed = MB.diff(snap(category={RI.FIELD: False}), snap(category={RI.FIELD: True}))
    assert [c["field"] for c in changed["categories"][0]["changes"]] == [RI.FIELD]
    assert MB.diff(snap(), snap({RI.FIELD: False}, {RI.FIELD: False})) == MB.diff(snap(), snap())
