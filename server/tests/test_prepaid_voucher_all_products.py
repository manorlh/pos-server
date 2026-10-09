"""
Prepaid vouchers and every product type in the catalog (docs/SPEC_VOUCHER_PRODUCTION.md §7.14;
the owner, 07.10.2026: "תוודא ששוברי הפקה תומכים בכל סוגי המוצרים בקטלוג").

What each class pins:

* **Picker** — every product is shown with whether it can go on a goods voucher and on an
  item discount, why not (the general item, an open price, "לא מקבל הנחות", another company,
  a till's product of a shop the voucher is not for), and what to know (by weight, options,
  a meal, kiosk only, a ticket, not listed in the voucher's shops, made on a till) — usable first.
* **Save** — the picker's rule: what it marks is refused with that reason; a fraction only
  of a product sold by weight; "כולל תוספות" is goods only.
* **Weight** — a goods voucher carries "0.5 ק״ג": looked up, redeemed in parts to the gram,
  given back, reported, printed.
* **Re-check** — at redemption: an item whose product became the general item is not handed
  over; one that became open-priced after its batch was printed still is (paper in hand).
* **Till-made** — a till's own product goes on a voucher of its shop: that till knows it
  by its own id and sells it; the shop's other tills do not list it.
* **Discounts** — the cloud's reserve takes a weighed line per kg, pro rata, and never an
  item discount off the general item.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.category import Category
from app.models.company import Company
from app.models.menu import MealSlot, MealSlotOption, ModifierGroup, ModifierLink, ModifierOption
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatchItem
from app.models.product import CatalogLevel, Product
from app.models.shop_product_override import ShopProductOverride
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    PrepaidVoucherBatchCreate,
    PrepaidVoucherLookupIn,
    PrepaidVoucherRedeemIn,
    PrepaidVoucherReserveIn,
)
from app.services import prepaid_voucher_pdf as PDF
from app.services import prepaid_voucher_reports as PVR
from app.services import prepaid_vouchers as PV
from shift_world import accept_str_uuids, make_world

KINDS = ["items", "order_discount", "item_discount"]


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    db = world.db
    world.food = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, name="אוכל")
    world.deli = Category(id=uuid.uuid4(), tenant_id=world.tenant.id, name="מעדנייה")
    db.add_all([world.food, world.deli])
    db.flush()

    def product(name, price, cat=None, *, listed=True, **kw):
        p = Product(
            id=uuid.uuid4(), tenant_id=world.tenant.id, company_id=world.company.id,
            category_id=(cat or world.food).id, catalog_level=CatalogLevel.GLOBAL, name=name, price=price,
            sku=f"sku-{name}", **kw,
        )
        db.add(p)
        db.flush()
        if listed:
            db.add(ShopProductOverride(id=uuid.uuid4(), shop_id=world.shop.id, global_product_id=p.id, is_listed=True))
        return p

    world.product = product
    world.hotdog = product("נקניקייה", 25)
    world.olives = product("זיתים", 40, world.deli, is_weighed=True, unit_label='ק"ג')
    world.cheese = product("גבינה במשקל", 60, world.deli, is_weighed=True)  # no unit of its own: ק"ג
    world.open = product("פריט פתוח", 10, is_open_price=True)
    world.general = product("פריט כללי", 0, is_general=True, is_open_price=True)
    world.nodisc = product("סיגריות", 38, no_discount=True)
    world.burger = product("המבורגר", 52)
    world.meal = product("ארוחה", 70)
    world.fries = product("צ׳יפס", 15)
    world.kiosk_only = product("קיוסק בלבד", 20, sales_channel="kiosk_only")
    world.ticket = product("כרטיס כניסה", 80, ticket_mode="per_unit")
    world.unlisted = product("לא משויך", 9, listed=False)
    # Options on the burger (cheese +₪5), and a meal (burger + fries, large fries +₪3).
    group = ModifierGroup(id=uuid.uuid4(), tenant_id=world.tenant.id, name="תוספות", kind="addon")
    db.add(group)
    db.flush()
    db.add(ModifierOption(id=uuid.uuid4(), group_id=group.id, name="גבינה", price=5))
    db.add(ModifierLink(id=uuid.uuid4(), tenant_id=world.tenant.id, target_type="product", target_id=world.burger.id,
                        group_id=group.id))
    slot = MealSlot(id=uuid.uuid4(), tenant_id=world.tenant.id, product_id=world.meal.id, name="תוספת")
    db.add(slot)
    db.flush()
    db.add(MealSlotOption(id=uuid.uuid4(), slot_id=slot.id, product_id=world.fries.id, upcharge=3))
    # Made on a till of the shop: no catalog product behind it.
    world.till_made = Product(
        id=uuid.uuid4(), tenant_id=world.tenant.id, category_id=world.food.id, catalog_level=CatalogLevel.LOCAL,
        pos_machine_id=world.tills[0].id, name="מנה של הקופה", price=33, sku="till-made-1",
    )
    world.north_made = Product(
        id=uuid.uuid4(), tenant_id=world.tenant.id, category_id=world.food.id, catalog_level=CatalogLevel.LOCAL,
        pos_machine_id=world.other_till.id, name="מנה של צפון", price=31, sku="till-made-2",
    )
    db.add_all([world.till_made, world.north_made])
    db.commit()
    return world


def _ctx(w):
    return dict(current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)


def refused(fn, *args, **kwargs) -> HTTPException:
    with pytest.raises(HTTPException) as e:
        fn(*args, **kwargs)
    return e.value


def picker(w, *, search=None, purpose="items", shops=None):
    out = R.list_prepaid_voucher_products(
        company_id=str(w.company.id), search=search, limit=200, purpose=purpose, shop_ids=shops, **_ctx(w),
    )["items"]
    return {p["name"]: p for p in out}


def make(w, items, *, kind="items", count=2, split=True, shops=None, **extra):
    body = {"name": "הפקה", "companyId": w.company.id, "count": count, "kind": kind, "splitAllowed": split,
            "items": items, "shopIds": shops, **extra}
    # What today's tills book (the `voucher` tender at list prices): no `features` needed.
    body.setdefault("redemptionAccounting", "payment")
    return R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(**body), **_ctx(w))


def goods(*pairs):
    return [{"productId": p.id, "quantity": q} for p, q in pairs]


def codes(w, batch):
    return [v["code"] for v in R.list_prepaid_vouchers(
        batch["id"], status_filter=None, serial=None, limit=5000, offset=0, **_ctx(w))["items"]]


def lookup(w, code, till=None):
    till = till or w.tills[0]
    return R.lookup_prepaid_voucher(str(till.id), PrepaidVoucherLookupIn(code=code, supportedKinds=KINDS), machine=till, db=w.db)


def redeem(w, code, items, *, till=None, forfeit=False):
    till = till or w.tills[0]
    body = PrepaidVoucherRedeemIn(
        code=code, items=[{"productId": str(p.id), "quantity": q} for p, q in items],
        clientRequestId=str(uuid.uuid4()), forfeitRest=forfeit, posUserId=7, posUserName="דנה",
    )
    return R.redeem_prepaid_voucher(str(till.id), body, machine=till, db=w.db)


# ── Picker ────────────────────────────────────────────────────────────────────


class TestPicker:
    def test_every_product_with_whether_it_can_go_on_and_why_not(self, w):
        rows = picker(w)
        blocked = {n: (r["blocked"]["goods"], r["blocked"]["itemDiscount"]) for n, r in rows.items()}
        assert blocked["נקניקייה"] == (None, None)
        assert blocked["זיתים"] == (None, None)
        assert blocked["פריט פתוח"] == ("open_price", None)
        assert blocked["פריט כללי"] == ("general", "general")
        assert blocked["סיגריות"] == (None, "no_discount")
        assert blocked["המבורגר"] == (None, None)
        assert blocked["ארוחה"] == (None, None)
        assert blocked["מנה של הקופה"] == (None, None)
        # Another shop's till made it: not this company's shops? It is (North is the company's) —
        # usable with no shops picked; a voucher for the shop only refuses it (below).
        assert blocked["מנה של צפון"] == (None, None)

    def test_what_to_know_about_a_usable_product(self, w):
        notes = {n: r["notes"] for n, r in picker(w).items()}
        assert notes["נקניקייה"] == []
        assert "weighed" in notes["זיתים"]
        assert "options" in notes["המבורגר"]
        assert "meal" in notes["ארוחה"]
        assert "open_price" in notes["פריט פתוח"]
        assert "kiosk_only" in notes["קיוסק בלבד"]
        assert "ticket" in notes["כרטיס כניסה"]
        assert "not_listed" in notes["לא משויך"]
        assert "till_made" in notes["מנה של הקופה"]
        rows = picker(w)
        assert (rows["זיתים"]["isWeighed"], rows["זיתים"]["unitLabel"]) == (True, 'ק"ג')
        assert rows["גבינה במשקל"]["unitLabel"] == 'ק"ג'  # none of its own: by the kg
        assert rows["מנה של הקופה"]["shopName"] == w.shop.name

    def test_usable_first_for_the_purpose(self, w):
        names = list(picker(w))
        assert names.index("פריט כללי") > names.index("נקניקייה")
        assert names.index("פריט פתוח") > names.index("סיגריות")
        names = list(picker(w, purpose="item_discount"))
        assert names.index("סיגריות") > names.index("פריט פתוח")

    def test_a_tills_product_of_a_shop_the_voucher_is_not_for(self, w):
        rows = picker(w, shops=[str(w.shop.id)])
        assert rows["מנה של הקופה"]["blocked"]["goods"] is None
        assert rows["מנה של צפון"]["blocked"]["goods"] == "till_shop"

    def test_another_company_only_when_searched_for_and_marked(self, w):
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="שכנים")
        w.db.add(other)
        w.db.flush()
        w.db.add(Product(
            id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, category_id=w.food.id,
            catalog_level=CatalogLevel.GLOBAL, name="פלאפל שכנים", price=20, sku="sku-n",
        ))
        w.db.commit()
        assert "פלאפל שכנים" not in picker(w)
        found = picker(w, search="פלאפל")
        assert found["פלאפל שכנים"]["blocked"] == {"goods": "other_company", "itemDiscount": "other_company"}
        assert found["פלאפל שכנים"]["companyName"] == "שכנים"


# ── Save ──────────────────────────────────────────────────────────────────────


class TestSave:
    def test_what_the_picker_marks_the_save_refuses(self, w):
        assert refused(make, w, goods((w.open, 1))).detail == "prepaid_voucher_product_open_price"
        assert refused(make, w, goods((w.general, 1))).detail == "prepaid_voucher_product_general"
        assert refused(make, w, goods((w.north_made, 1)), shops=[w.shop.id]).detail == "prepaid_voucher_product_till_shop"
        item = dict(kind="item_discount", items=[], discountType="percent", discountValue=10)
        assert refused(make, w, targets={"productIds": [w.nodisc.id]}, **item).detail == "prepaid_voucher_product_no_discount"
        assert refused(make, w, targets={"productIds": [w.general.id]}, **item).detail == "prepaid_voucher_product_general"

    def test_every_other_type_goes_on(self, w):
        b = make(w, goods((w.hotdog, 1), (w.olives, 0.5), (w.burger, 1), (w.meal, 1), (w.kiosk_only, 1),
                          (w.ticket, 2), (w.unlisted, 1), (w.nodisc, 1), (w.till_made, 1)), shops=[w.shop.id])
        assert len(b["items"]) == 9
        item = dict(kind="item_discount", items=[], discountType="fixed", discountValue=5)
        d = make(w, targets={"productIds": [w.open.id, w.olives.id, w.meal.id, w.till_made.id]}, **item)
        assert d["targets"]["names"] == ["פריט פתוח", "זיתים", "ארוחה", "מנה של הקופה"]

    def test_a_fraction_only_by_weight(self, w):
        assert refused(make, w, goods((w.hotdog, 1.5))).detail == PV.QUANTITY_FRACTION
        b = make(w, goods((w.olives, 0.25), (w.cheese, 1)))
        assert [(i["quantity"], i["weighed"], i["unitLabel"]) for i in b["items"]] == [
            (0.25, True, 'ק"ג'), (1, True, 'ק"ג'),
        ]
        assert b["items"][0]["text"] == '0.25 ק"ג זיתים'
        with pytest.raises(ValidationError):  # at most three decimals, above 0
            PrepaidVoucherBatchCreate(name="x", companyId=w.company.id, count=1, items=goods((w.olives, 0.0005)))
        with pytest.raises(ValidationError):
            PrepaidVoucherBatchCreate(name="x", companyId=w.company.id, count=1, items=goods((w.olives, 0)))

    def test_include_extras_is_goods_only_and_off_by_default(self, w):
        assert make(w, goods((w.burger, 1)))["includeExtras"] is False
        assert make(w, goods((w.burger, 1)), includeExtras=True)["includeExtras"] is True
        d = make(w, [], kind="order_discount", discountType="fixed", discountValue=10, includeExtras=True)
        assert d["includeExtras"] is False


# ── Weight ────────────────────────────────────────────────────────────────────


class TestWeight:
    def test_redeemed_to_the_gram_and_given_back(self, w):
        b = make(w, goods((w.olives, 0.5), (w.hotdog, 1)))
        code = codes(w, b)[0]
        seen = lookup(w, code)
        olives = next(i for i in seen["items"] if i["name"] == "זיתים")
        assert (olives["quantity"], olives["remaining"], olives["weighed"], olives["unitLabel"]) == (0.5, 0.5, True, 'ק"ג')
        assert olives["usable"] is True and seen["includeExtras"] is False
        out = redeem(w, code, [(w.olives, 0.3)])
        assert {i["name"]: i["remaining"] for i in out["voucher"]["items"]} == {"זיתים": 0.2, "נקניקייה": 1}
        assert out["redeemed"][0]["quantity"] == 0.3
        assert refused(redeem, w, code, [(w.olives, 0.25)]).detail == PV.INSUFFICIENT
        assert refused(redeem, w, code, [(w.hotdog, 0.5)]).detail == PV.QUANTITY_FRACTION
        R.reverse_prepaid_redemption(str(w.tills[0].id), out["redemptionId"], machine=w.tills[0], db=w.db)
        w.db.expire_all()
        v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == code).one()
        assert v.remaining == {str(w.olives.id): 0.5, str(w.hotdog.id): 1}
        done = redeem(w, code, [(w.olives, 0.5), (w.hotdog, 1)])
        assert done["voucher"]["status"] == "used"

    def test_one_time_part_by_weight_forfeits_the_rest(self, w):
        b = make(w, goods((w.olives, 0.5)), split=False)
        code = codes(w, b)[0]
        assert refused(redeem, w, code, [(w.olives, 0.4)]).detail == PV.PARTIAL_NOT_ALLOWED
        out = redeem(w, code, [(w.olives, 0.4)], forfeit=True)
        assert out["forfeited"][0]["quantity"] == 0.1

    def test_reported_and_printed_by_weight(self, w):
        b = make(w, goods((w.olives, 0.5), (w.hotdog, 2)), count=3)
        code = codes(w, b)[0]
        redeem(w, code, [(w.olives, 0.3)])
        report = PVR.batch_report(w.db, w.admin, w.tenant.id, b["id"])
        olives = next(p for p in report["products"] if p["name"] == "זיתים")
        assert (olives["perVoucher"], olives["issued"], olives["taken"], olives["outstanding"]) == (0.5, 1.5, 0.3, 1.2)
        assert (olives["weighed"], olives["unitLabel"]) == (True, 'ק"ג')
        assert report["totals"]["units"] == 0.3
        batch = PV.get_batch(w.db, w.admin, w.tenant.id, b["id"])
        per, total = PDF.cover_contents(batch, 3)
        assert per == '0.5 ק"ג זיתים + 2× נקניקייה'
        assert total == '1.5 ק"ג זיתים, 6× נקניקייה'
        rows = PDF.manifest_csv(batch, w.db.query(PrepaidVoucher).filter(PrepaidVoucher.batch_id == batch.id).all())
        assert '"0.2 ק""ג זיתים; 2× נקניקייה"' in rows.decode("utf-8-sig")  # CSV doubles the quote
        assert PDF.terms_line(batch) == "ניתן לממש בחלקים"
        batch.include_extras = True
        assert PDF.terms_line(batch) == "ניתן לממש בחלקים · כולל תוספות"
        # The PDF draws (a weight in the quantity column).
        assert PDF.render_pdf(batch, [batch.vouchers[0]], PDF.geometry("card")).startswith(b"%PDF")

    def test_the_column_keeps_a_weight(self, w):
        b = make(w, goods((w.olives, 0.125)))
        w.db.expire_all()
        row = w.db.query(PrepaidVoucherBatchItem).filter(PrepaidVoucherBatchItem.product_id == w.olives.id).one()
        assert PV.qty(row.quantity) == PV.qty("0.125") and row.weighed is True and row.unit_label == 'ק"ג'
        assert b["items"][0]["quantity"] == 0.125


# ── Re-check at redemption ────────────────────────────────────────────────────


class TestRecheck:
    def test_an_item_that_became_the_general_item_is_not_handed_over(self, w):
        b = make(w, goods((w.hotdog, 1), (w.burger, 1)))
        code = codes(w, b)[0]
        w.general.is_general = False  # one general item a company
        w.db.flush()
        w.burger.is_general = True
        w.db.commit()
        burger = next(i for i in lookup(w, code)["items"] if i["name"] == "המבורגר")
        assert (burger["usable"], burger["unusableReason"]) == (False, "general")
        assert refused(redeem, w, code, [(w.burger, 1)]).detail == PV.ITEM_UNUSABLE
        assert redeem(w, code, [(w.hotdog, 1)])["ok"]

    def test_an_item_open_priced_after_its_batch_still_is(self, w):
        b = make(w, goods((w.hotdog, 1)))
        code = codes(w, b)[0]
        w.hotdog.is_open_price = True
        w.db.commit()
        assert lookup(w, code)["items"][0]["usable"] is True
        assert redeem(w, code, [(w.hotdog, 1)])["ok"]


# ── Made on a till ────────────────────────────────────────────────────────────


class TestTillMade:
    def test_its_till_knows_and_sells_it_the_others_do_not_list_it(self, w):
        b = make(w, goods((w.till_made, 1)), shops=[w.shop.id])
        code = codes(w, b)[0]
        mine = lookup(w, code, till=w.tills[0])["items"][0]
        assert (mine["tillProductId"], mine["inAssortment"], mine["price"]) == (str(w.till_made.id), True, 33.0)
        assert lookup(w, code, till=w.tills[1])["items"][0]["inAssortment"] is False
        assert redeem(w, code, [(w.till_made, 1)])["ok"]


# ── Discounts: weight and the general item at the cloud ──────────────────────


class TestDiscounts:
    def _reserve(self, w, code, lines):
        till = w.tills[0]
        body = PrepaidVoucherReserveIn(
            code=code, clientRequestId=str(uuid.uuid4()), saleRef="sale-1", uses=1, supportedKinds=KINDS,
            lines=lines, otherVouchers=[], posUserId=7, posUserName="דנה",
        )
        return R.reserve_prepaid_voucher(str(till.id), body, machine=till, db=w.db)

    def test_an_item_discount_takes_a_weighed_line_per_kg(self, w):
        d = make(w, [], kind="item_discount", discountType="fixed", discountValue=5,
                 targets={"productIds": [w.olives.id]})
        out = self._reserve(w, codes(w, d)[0], [{
            "id": "L1", "productIds": [str(w.olives.id)], "categoryIds": [str(w.deli.id)], "quantity": 0.75,
            "grossAgorot": 3000, "weighed": True,
        }])
        assert out["amountAgorot"] == 375 and out["shares"] == {"L1": 375}

    def test_never_off_the_general_item_by_its_category(self, w):
        d = make(w, [], kind="item_discount", discountType="percent", discountValue=10,
                 targets={"categoryIds": [w.food.id]}, maxUnits=5)
        out = self._reserve(w, codes(w, d)[0], [
            {"id": "L1", "productIds": [str(w.general.id)], "categoryIds": [str(w.food.id)], "quantity": 1,
             "grossAgorot": 5000, "general": True},
            {"id": "L2", "productIds": [str(w.hotdog.id)], "categoryIds": [str(w.food.id)], "quantity": 1,
             "grossAgorot": 2500},
        ])
        assert out["shares"] == {"L2": 250}

    def test_an_order_discount_takes_the_general_item(self, w):
        d = make(w, [], kind="order_discount", discountType="fixed", discountValue=12)
        out = self._reserve(w, codes(w, d)[0], [
            {"id": "L1", "productIds": [str(w.general.id)], "categoryIds": [], "quantity": 1, "grossAgorot": 5000,
             "general": True},
            {"id": "L2", "productIds": [str(w.hotdog.id)], "categoryIds": [], "quantity": 1, "grossAgorot": 1000},
        ])
        assert out["shares"] == {"L1": 1000, "L2": 200}


# ── Migration ─────────────────────────────────────────────────────────────────


def test_the_migration_is_the_single_head():
    import pathlib

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = pathlib.Path(__file__).absolute().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    script = ScriptDirectory.from_config(config)
    # One head, with this migration on its chain (later migrations sit on top of it).
    heads = script.get_heads()
    assert len(heads) == 1
    assert "d8f3a1c5e7b2" in {r.revision for r in script.iterate_revisions(heads[0], "base")}
    assert script.get_revision("d8f3a1c5e7b2").down_revision == "c7e2f4a9d1b6"


def test_the_migration_is_idempotent_on_a_database_that_has_it():
    """create_all (the auto-reloading API) may have made the columns first: the upgrade adds nothing."""
    import importlib.util
    import pathlib

    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    from app.database import Base

    engine = sa.create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        Base.metadata.tables["prepaid_voucher_batches"], Base.metadata.tables["prepaid_voucher_batch_items"],
    ])
    path = pathlib.Path(__file__).absolute().parents[1] / "alembic" / "versions" / "d8f3a1c5e7b2_prepaid_voucher_all_products.py"
    spec = importlib.util.spec_from_file_location("m_d8f3a1c5e7b2", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with engine.begin() as conn:
        ctx = MigrationContext.configure(conn)
        module.op = Operations(ctx)
        module.context = type("C", (), {"is_offline_mode": staticmethod(lambda: False)})
        module.upgrade()
        cols = {c["name"] for c in sa.inspect(conn).get_columns("prepaid_voucher_batch_items")}
    assert {"quantity", "weighed", "unit_label"} <= cols
