"""
Prepaid vouchers — the one filter model and the reports (app/services/prepaid_voucher_analytics.py):

* **The filter model** — every choice checked (a 400 names the parameter), lists split on commas,
  reversed ranges refused.
* **The batch list** — for whom, event, kind, accounting, pricing, override, offline, value and
  production-price ranges (the price only for whoever sees prices), created by, issue dates, a day it
  is valid on, the batch status (cancelled / not started / expired / fully redeemed / has open), the
  shop (a company-wide batch covers every shop of its company), "redeemed at till X", the employee,
  the words; the sorts; each row's issued / redeemed / open / rate.
* **"כל השוברים"** — across batches, the voucher states, group, service number / code / note, the
  redemption filters, paging; the batch each voucher belongs to.
* **The wide search** — batches, vouchers, tills and employees, grouped.
* **"מימושים לפי קופה"** — a row per till with its shop and the value per accounting mode (what is
  not recorded yet is None, never 0); the series (hour profile, every day of the range); a till's
  redemptions with the employee.
* **The indexes' migration** — idempotent, offline.
"""
from __future__ import annotations

import importlib.util
import io
import pathlib
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch, PrepaidVoucherRedemption
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import PrepaidVoucherBatchCreate
from app.services import prepaid_voucher_analytics as A
from test_prepaid_voucher_types import company_manager
from test_prepaid_vouchers import _ctx, redeem, refused, vouchers, w  # noqa: F401 — `w` is the fixture

IL = ZoneInfo("Asia/Jerusalem")
ROOT = pathlib.Path(__file__).absolute().parents[1]


def today() -> date:
    return datetime.now(IL).date()


def local(day: date, hour: int) -> datetime:
    return datetime(day.year, day.month, day.day, hour, 0, tzinfo=IL).astimezone(timezone.utc)


def batch(w, *, name="הפקה", customer=None, event=None, count=3, items=None, user=None, **extra):
    body = PrepaidVoucherBatchCreate(
        name=name, companyId=w.company.id, customerName=customer, eventName=event, count=count,
        items=items or [{"productId": w.hotdog.id, "quantity": 1}], splitAllowed=True, **extra,
    )
    return R.create_prepaid_voucher_batch(body, **_ctx(w, user))


def codes(w, b):
    return [v["code"] for v in vouchers(w, b)]


def take(w, code, *, till=None, when=None, items=None):
    out = redeem(w, code, items or [(w.hotdog, 1)], till=till)
    if when is not None:
        w.db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.id == uuid.UUID(out["redemptionId"])).update(
            {"redeemed_at": when})
        w.db.commit()
    return out


def S(**kw) -> A.Scope:
    return A.make_scope(**kw)


def names(rows):
    return [r["name"] for r in rows]


def listed(w, user=None, sort="newest", **kw):
    return names(A.list_batches(w.db, user or w.admin, w.tenant.id, S(**kw), sort=sort)["items"])


# ── The filter model ──────────────────────────────────────────────────────────


class TestScope:
    @pytest.mark.parametrize("kw, name", [
        ({"accounting": "exempt"}, "accounting"),
        ({"pricing": "free"}, "pricing"),
        ({"override": "maybe"}, "override"),
        ({"batch_status": "lost"}, "batchStatus"),
        ({"state": "gone"}, "state"),
        ({"value_min": "abc"}, "valueMin"),
        ({"value_min": "-1"}, "valueMin"),
        ({"date_from": "2026-13-01"}, "from"),
        ({"date_from": "2026-10-08", "date_to": "2026-10-01"}, "to"),
        ({"value_min": "50", "value_max": "10"}, "valueMax"),
    ])
    def test_a_bad_value_names_its_parameter(self, kw, name):
        e = refused(A.make_scope, **kw)
        assert (e.status_code, e.detail) == (400, f"{A.BAD_FILTER}:{name}")

    def test_lists_split_on_commas_and_all_means_none(self):
        s = A.make_scope(customer=["אלון, קייטרינג", "אלון"], accounting="all", override="yes", offline="no", value_min="12,5")
        assert (s.customers, s.accounting, s.override, s.offline, s.value_min) == (("אלון", "קייטרינג"), None, True, False,
                                                                                   Decimal("12.5"))

    def test_the_router_builds_it_from_the_query(self, w):
        batch(w, name="א", customer="אלון")
        batch(w, name="ב", customer="דנה")
        scope = R.voucher_scope(customer=["דנה"], event=None, type_id=None, kind=None, batch_id=None, shop_id=None,
                                company_id=None, accounting=None, pricing=None, override=None, offline=None,
                                value_min=None, value_max=None, price_min=None, price_max=None, created_by=None,
                                issued_from=None, issued_to=None, valid_on=None, batch_status=None, date_from=None,
                                date_to=None, machine_id=None, employee=None, state=None, group=None, q=None)
        out = R.list_prepaid_voucher_batches(include_cancelled=True, sort="newest", scope=scope, **_ctx(w))
        assert (names(out["items"]), out["total"]) == (["ב"], 1)
        # A direct call without filters lists every batch, as before.
        assert len(R.list_prepaid_voucher_batches(**_ctx(w))["items"]) == 2


# ── The batch list ────────────────────────────────────────────────────────────


class TestBatchList:
    def test_for_whom_event_kind_and_words(self, w):
        batch(w, name="א", customer="קייטרינג אלון", event="פסטיבל הקיץ", orderRef="PO-77")
        batch(w, name="ב", customer="הפקות דנה", event="ערב גאלה", freeText="כניסה מהשער הצפוני")
        R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="ג", companyId=w.company.id, count=1, kind="order_discount", discountType="fixed", discountValue=10,
        ), **_ctx(w))
        assert listed(w, customer=["קייטרינג אלון"]) == ["א"]
        assert listed(w, event=["ערב גאלה"]) == ["ב"]
        assert listed(w, kind="discount") == ["ג"]
        assert sorted(listed(w, kind="items")) == ["א", "ב"]
        assert listed(w, q="po-77") == ["א"]
        assert listed(w, q="השער הצפוני") == ["ב"]

    def test_accounting_pricing_override_offline_and_value(self, w):
        batch(w, name="קיזוז")
        batch(w, name="תשלום", redemptionAccounting="payment", tillValue=50)
        batch(w, name="כפייה", discountBlockPolicy={"mode": "auto"}, offlineAllowed=True, tillValue=80)
        assert listed(w, accounting="payment") == ["תשלום"]
        assert sorted(listed(w, pricing="fixed")) == ["כפייה", "תשלום"]
        assert listed(w, pricing="cover") == ["קיזוז"]
        assert listed(w, override="yes") == ["כפייה"]
        assert sorted(listed(w, override="no")) == ["קיזוז", "תשלום"]
        assert listed(w, offline="yes") == ["כפייה"]
        assert listed(w, value_min="60") == ["כפייה"]
        assert listed(w, value_max="60") == ["תשלום"]

    def test_the_production_price_only_for_whoever_sees_prices(self, w):
        batch(w, name="זול", productionPrice=10)
        batch(w, name="יקר", productionPrice=40)
        assert listed(w, price_min="20") == ["יקר"]
        cm = company_manager(w)
        assert sorted(listed(w, user=cm, price_min="20")) == ["זול", "יקר"]  # ignored, never a leak

    def test_created_by_issue_dates_and_a_day_it_is_valid_on(self, w):
        old = batch(w, name="ישנה", validUntil=datetime.now(timezone.utc) - timedelta(days=1))
        batch(w, name="חדשה", validFrom=datetime.now(timezone.utc) + timedelta(days=2))
        w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(old["id"])).update(
            {"created_at": datetime.now(timezone.utc) - timedelta(days=30)})
        w.db.commit()
        assert listed(w, created_by=str(w.admin.id), sort="newest") == ["חדשה", "ישנה"]
        assert listed(w, created_by=str(uuid.uuid4())) == []
        assert listed(w, issued_from=(today() - timedelta(days=1)).isoformat()) == ["חדשה"]
        assert listed(w, issued_to=(today() - timedelta(days=10)).isoformat()) == ["ישנה"]
        assert listed(w, valid_on=today().isoformat()) == []
        assert listed(w, valid_on=(today() + timedelta(days=3)).isoformat()) == ["חדשה"]

    def test_the_batch_status(self, w):
        active = batch(w, name="פעילה", count=2)
        batch(w, name="עתידית", validFrom=datetime.now(timezone.utc) + timedelta(days=2))
        batch(w, name="פגה", validUntil=datetime.now(timezone.utc) - timedelta(hours=1))
        done = batch(w, name="מומשה", count=1)
        cancelled = batch(w, name="מבוטלת")
        R.cancel_prepaid_voucher_batch(cancelled["id"], **_ctx(w))
        take(w, codes(w, done)[0])
        take(w, codes(w, active)[0])
        assert sorted(listed(w, batch_status="active")) == ["מומשה", "פעילה"]
        assert listed(w, batch_status="not_started") == ["עתידית"]
        assert listed(w, batch_status="expired") == ["פגה"]
        assert listed(w, batch_status="fully_redeemed") == ["מומשה"]
        assert sorted(listed(w, batch_status="has_open")) == ["עתידית", "פעילה"]
        assert listed(w, batch_status="cancelled") == ["מבוטלת"]

    def test_a_shop_takes_its_own_batches_and_the_company_wide_ones(self, w):
        batch(w, name="מרכז", shopIds=[w.shop.id])
        batch(w, name="צפון", shopIds=[w.other_shop.id])
        batch(w, name="כל החברה")
        assert sorted(listed(w, shop_id=[str(w.shop.id)])) == ["כל החברה", "מרכז"]
        assert sorted(listed(w, shop_id=[str(w.other_shop.id)])) == ["כל החברה", "צפון"]

    def test_redeemed_at_till_x_and_by_an_employee(self, w):
        a = batch(w, name="א")
        b = batch(w, name="ב")
        take(w, codes(w, a)[0], till=w.tills[0])
        take(w, codes(w, b)[0], till=w.other_till)
        assert listed(w, machine_id=[str(w.other_till.id)]) == ["ב"]
        assert sorted(listed(w, employee=["דנה"])) == ["א", "ב"]
        assert listed(w, employee=["יוסי"]) == []
        assert listed(w, machine_id=[str(w.tills[0].id)], date_from=(today() + timedelta(days=1)).isoformat()) == []

    def test_the_figures_and_the_sorts(self, w):
        a = batch(w, name="א", customer="תמר", event="ב-אירוע", count=4)
        batch(w, name="ב", customer="אבי", event="א-אירוע", count=2)
        cs = codes(w, a)
        take(w, cs[0])
        take(w, cs[1])
        rows = {r["name"]: r for r in A.list_batches(w.db, w.admin, w.tenant.id, S())["items"]}
        assert rows["א"]["figures"] == {"issued": 4, "redeemed": 2, "fullyRedeemed": 2, "open": 2, "cancelled": 0, "rate": 0.5}
        assert rows["ב"]["figures"]["rate"] == 0.0
        assert rows["א"]["state"]["has_open"] is True
        assert listed(w, sort="customer") == ["ב", "א"]
        assert listed(w, sort="event") == ["ב", "א"]
        assert listed(w, sort="redeemed") == ["א", "ב"]
        assert refused(A.list_batches, w.db, w.admin, w.tenant.id, S(), sort="cheapest").status_code == 400


# ── "כל השוברים" ──────────────────────────────────────────────────────────────


def states(w, **kw):
    return sorted((v["batch"]["name"], v["serial"], v["state"]) for v in A.list_vouchers(w.db, w.admin, w.tenant.id, S(**kw))["items"])


class TestVouchers:
    def test_across_batches_with_each_ones_state(self, w):
        a = batch(w, name="א", count=3, items=[{"productId": w.hotdog.id, "quantity": 2}])
        b = batch(w, name="ב", count=1, validUntil=datetime.now(timezone.utc) - timedelta(hours=1))
        cs = codes(w, a)
        take(w, cs[0], items=[(w.hotdog, 2)])
        take(w, cs[1], items=[(w.hotdog, 1)])
        w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == cs[2]).update({"status": "cancelled"})
        w.db.commit()
        assert states(w) == [("א", 1, "redeemed"), ("א", 2, "partial"), ("א", 3, "cancelled"), ("ב", 1, "expired")]
        assert states(w, state="open") == []
        assert states(w, state="expired") == [("ב", 1, "expired")]
        assert states(w, state="partial") == [("א", 2, "partial")]
        assert states(w, batch_id=[b["id"]]) == [("ב", 1, "expired")]
        out = A.list_vouchers(w.db, w.admin, w.tenant.id, S(), limit=2, offset=0)
        assert (out["total"], len(out["items"])) == (4, 2)
        assert out["items"][0]["batch"]["customerName"] is None and "displayCode" in out["items"][0]

    def test_a_service_number_a_code_or_a_note(self, w):
        a = batch(w, name="א", count=3)
        vs = vouchers(w, a)
        w.db.query(PrepaidVoucher).filter(PrepaidVoucher.id == uuid.UUID(vs[1]["id"])).update({"note": "נמסר לבמאי"})
        w.db.commit()
        assert states(w, q="#3") == [("א", 3, "open")]
        assert states(w, q=vs[0]["displayCode"]) == [("א", 1, "open")]
        assert states(w, q=vs[0]["code"][4:10]) == [("א", 1, "open")]
        assert states(w, q="במאי") == [("א", 2, "open")]
        assert states(w, q="x") == []

    def test_the_redemption_filters_and_a_group(self, w):
        a = batch(w, name="א", count=4, groupSize=2)
        cs = codes(w, a)
        take(w, cs[0], till=w.tills[0], when=local(today() - timedelta(days=3), 10))
        take(w, cs[2], till=w.other_till)
        assert states(w, machine_id=[str(w.other_till.id)]) == [("א", 3, "redeemed")]
        assert states(w, date_to=(today() - timedelta(days=1)).isoformat()) == [("א", 1, "redeemed")]
        assert states(w, group=2) == [("א", 3, "redeemed"), ("א", 4, "open")]
        assert states(w, employee=["דנה"], state="redeemed") == [("א", 1, "redeemed"), ("א", 3, "redeemed")]

    def test_the_router_pages_them(self, w):
        batch(w, name="א", count=3)
        out = R.list_all_prepaid_vouchers(limit=2, offset=2, scope=S(), **_ctx(w))
        assert (out["total"], [v["serial"] for v in out["items"]]) == (3, [3])


# ── The wide search ───────────────────────────────────────────────────────────


class TestSearch:
    def test_grouped_by_what_matched(self, w):
        a = batch(w, name="ערב השקה", customer="קייטרינג אלון", orderRef="PO-12", count=12)
        v = vouchers(w, a)
        take(w, v[0]["code"], till=w.other_till)
        found = A.search(w.db, w.admin, w.tenant.id, "אלון")
        assert names(found["batches"]) == ["ערב השקה"] and found["vouchers"] == []
        assert names(A.search(w.db, w.admin, w.tenant.id, "po-12")["batches"]) == ["ערב השקה"]
        assert [x["serial"] for x in A.search(w.db, w.admin, w.tenant.id, "12")["vouchers"]] == [12]
        assert [x["serial"] for x in A.search(w.db, w.admin, w.tenant.id, v[1]["displayCode"])["vouchers"]] == [2]
        tills = A.search(w.db, w.admin, w.tenant.id, "north")["tills"]
        assert [(t["name"], t["redemptions"]) for t in tills] == [("North 1", 1)]
        assert [e["name"] for e in A.search(w.db, w.admin, w.tenant.id, "דנ")["employees"]] == ["דנה"]
        assert A.search(w.db, w.admin, w.tenant.id, "a") == {"batches": [], "vouchers": [], "tills": [], "employees": []}

    def test_the_facets(self, w):
        a = batch(w, name="א", customer="אלון", event="פסטיבל")
        batch(w, name="ב", customer="אלון")
        take(w, codes(w, a)[0], till=w.tills[1])
        f = A.facets(w.db, w.admin, w.tenant.id)
        assert f["customers"] == [{"value": "אלון", "batches": 2}]
        assert f["events"] == [{"value": "פסטיבל", "batches": 1}]
        assert [t["name"] for t in f["tills"]] == ["Till 2"]
        assert f["employees"] == [{"id": "7", "name": "דנה"}]
        assert f["creators"] == [{"id": str(w.admin.id), "name": "admin"}]
        assert {s["name"] for s in f["shops"]} == {"Center", "North"}
        assert len(f["types"]) == 2 and f["pricesVisible"] is True


# ── "לוח בקרה" ────────────────────────────────────────────────────────────────


# ── "מימושים לפי קופה" ────────────────────────────────────────────────────────


class TestTills:
    def test_a_row_per_till_and_its_redemptions(self, w):
        a = batch(w, name="א", customer="אלון", count=3)
        p = batch(w, name="ב", count=1, tillValue=40, redemptionAccounting="payment")
        cs = codes(w, a)
        take(w, cs[0], till=w.tills[0])
        take(w, cs[1], till=w.tills[0])
        take(w, codes(w, p)[0], till=w.other_till)
        out = A.tills_report(w.db, w.admin, w.tenant.id, S())
        rows = {r["name"]: r for r in out["items"]}
        assert (rows["Till 1"]["shopName"], rows["Till 1"]["vouchers"], rows["Till 1"]["items"]) == ("Center", 2, 2)
        assert rows["Till 1"]["value"] == {"discount": 5000, "payment": 0, "zero": 0, "total": 5000}
        assert rows["North 1"]["value"]["payment"] == 4000
        assert (rows["North 1"]["topUp"], rows["North 1"]["refusals"], rows["North 1"]["overrides"]) == (None, None, None)
        assert out["totals"]["redemptions"] == 3 and out["totals"]["value"]["total"] == 9000
        assert [r["name"] for r in A.tills_report(w.db, w.admin, w.tenant.id, S(customer=["אלון"]))["items"]] == ["Till 1"]
        reds = A.redemptions_list(w.db, w.admin, w.tenant.id, S(machine_id=[str(w.tills[0].id)]))
        assert reds["total"] == 2
        first = reds["items"][0]
        assert (first["machineName"], first["employeeName"], first["batch"]["name"], first["accounting"]) == (
            "Till 1", "דנה", "א", "discount")
        assert first["items"][0]["name"] == "נקניקייה" and first["serial"] in (1, 2)


def discount_use(w, voucher_code, amount_agorot, *, till, when):
    v = w.db.query(PrepaidVoucher).filter(PrepaidVoucher.code == voucher_code).one()
    w.db.add(PrepaidVoucherRedemption(
        id=uuid.uuid4(), tenant_id=w.tenant.id, voucher_id=v.id, batch_id=v.batch_id, machine_id=till.id,
        shop_id=till.shop_id, client_request_id=str(uuid.uuid4()), items=[], uses=1, discount_amount=amount_agorot,
        redeemed_at=when, pos_user_id="9", pos_user_name="רון",
    ))
    w.db.commit()


class TestTillFigures:
    def test_the_value_basis_per_kind(self, w):
        listp = batch(w, name="מחירון", count=2)  # cover: the goods at list prices, a deduction
        fixed = batch(w, name="קבוע", count=1, tillValue=30, redemptionAccounting="payment",
                      items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 1}])
        disc = R.create_prepaid_voucher_batch(PrepaidVoucherBatchCreate(
            name="הנחה", companyId=w.company.id, count=1, kind="order_discount", discountType="fixed", discountValue=10,
        ), **_ctx(w))
        take(w, codes(w, listp)[0], till=w.tills[1])
        take(w, codes(w, fixed)[0], items=[(w.hotdog, 1)], till=w.tills[1])  # half of ₪30
        discount_use(w, codes(w, disc)[0], 1000, till=w.tills[1], when=datetime.now(timezone.utc))
        row = A.tills_report(w.db, w.admin, w.tenant.id, S())["items"][0]
        assert (row["name"], row["redemptions"], row["vouchers"], row["items"]) == ("Till 2", 3, 3, 2)
        assert row["value"] == {"discount": 2500 + 1000, "payment": 1500, "zero": 0, "total": 5000}
        bases = {r["batch"]["name"]: r["valueBasis"] for r in A.redemptions_list(w.db, w.admin, w.tenant.id, S())["items"]}
        assert bases == {"מחירון": "list", "קבוע": "fixed", "הנחה": "discount"}

    def test_the_series_and_the_days(self, w):
        b = batch(w, name="א", count=3)
        cs = codes(w, b)
        d0 = today() - timedelta(days=2)
        take(w, cs[0], when=local(d0, 9))
        take(w, cs[1], when=local(d0, 9))
        take(w, cs[2], when=local(today(), 18))
        out = A.tills_report(w.db, w.admin, w.tenant.id, S(date_from=d0.isoformat(), date_to=today().isoformat()))
        assert [(d["key"], d["redemptions"]) for d in out["series"]] == [
            (d0.isoformat(), 2), ((d0 + timedelta(days=1)).isoformat(), 0), (today().isoformat(), 1)]
        hours = A.tills_report(w.db, w.admin, w.tenant.id, S(), bucket="hour")["series"]
        assert len(hours) == 24 and (hours[9]["redemptions"], hours[18]["redemptions"]) == (2, 1)
        only_today = A.tills_report(w.db, w.admin, w.tenant.id, S(date_from=today().isoformat(), date_to=today().isoformat()))
        assert only_today["totals"]["redemptions"] == 1
        assert refused(A.tills_report, w.db, w.admin, w.tenant.id, S(), bucket="week").status_code == 400

    def test_a_reversed_redemption_counts_nowhere(self, w):
        b = batch(w, name="א", count=1)
        out = take(w, codes(w, b)[0])
        w.db.query(PrepaidVoucherRedemption).filter(PrepaidVoucherRedemption.id == uuid.UUID(out["redemptionId"])).update(
            {"reversed_at": datetime.now(timezone.utc)})
        w.db.commit()
        assert A.tills_report(w.db, w.admin, w.tenant.id, S())["items"] == []
        assert A.redemptions_list(w.db, w.admin, w.tenant.id, S())["total"] == 0


# ── The indexes ───────────────────────────────────────────────────────────────


class TestIndexesMigration:
    def test_idempotent_and_offline(self):
        import sqlalchemy as sa
        from alembic.operations import Operations
        from alembic.runtime.migration import MigrationContext

        path = ROOT / "alembic" / "versions" / "5d8a3c1e7b92_prepaid_voucher_analytics_indexes.py"
        spec = importlib.util.spec_from_file_location("migration_5d8a3c1e7b92", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        assert module.down_revision == "9e4b2d7c1a05"
        engine = sa.create_engine("sqlite://")
        with engine.begin() as conn:
            conn.execute(sa.text("CREATE TABLE prepaid_voucher_batches (id CHAR(32) PRIMARY KEY, tenant_id CHAR(32), created_at TIMESTAMP)"))
            conn.execute(sa.text("CREATE TABLE prepaid_vouchers (id CHAR(32) PRIMARY KEY, batch_id CHAR(32), status VARCHAR)"))
            conn.execute(sa.text("CREATE TABLE prepaid_voucher_redemptions (id CHAR(32) PRIMARY KEY, batch_id CHAR(32), "
                                 "machine_id CHAR(32), voucher_id CHAR(32), redeemed_at TIMESTAMP)"))
            with Operations.context(MigrationContext.configure(conn)):
                module.upgrade()
                module.upgrade()  # idempotent
            got = {i["name"] for t in ("prepaid_voucher_batches", "prepaid_vouchers", "prepaid_voucher_redemptions")
                   for i in sa.inspect(conn).get_indexes(t)}
            assert got == {n for n, _t, _c in module.INDEXES}
        buf = io.StringIO()
        offline = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": buf})
        with Operations.context(offline):
            module.upgrade()
        assert buf.getvalue().count("CREATE INDEX") == 5
