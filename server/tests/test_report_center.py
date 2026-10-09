"""
The report center (docs/SPEC_REPORTS.md): Z types and the consolidated Z table (§3–4), the
all-in-one report (§5) and the reconciliation (§6).

How each could look fine while doing damage:

* **Z types** — the Python rule and the SQL filter must agree, or the list's filter and the
  row's label tell two stories; a kiosk's Z must not hide among the shop's.
* **Z table** — a row per Z with the numbers it froze, and a line per till of a shop Z; more
  Zs than the cap refused, never cut.
* **All-in-one** — its tables must add up to the same net as the per-cashier report over the
  same documents, and every section must be there even when empty.
* **Reconciliation** — a document outside any Z, a Z whose documents changed, a numbering gap,
  a Z-number jump, an untransmitted card sale and a transmission that never completed must each
  come out with the right status and a reason; a clean day must come out "תואם".
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.card_transmission import CardTransmission, CardTransmissionItem
from app.models.kiosk import KioskDevice
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_payment import TransactionPayment
from app.models.z_report import ZOrigin, ZReport
from app.routers import report_center as RC
from app.routers import z_reports as ZR
from app.services import all_in_one as AIO
from app.services import reconciliation as REC
from app.services import z_table as ZT
from app.services.reports import build_cashier_sales_report, resolve_report_window
from app.services.z_builder import build_z
from shift_world import NOW, TODAY, accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch, z_activity_unchecked):
    accept_str_uuids(monkeypatch)
    return make_world()


def _window(w, days_back=1, days_ahead=1):
    return resolve_report_window(
        w.db, w.tenant.id, from_date=TODAY - timedelta(days=days_back), to_date=TODAY + timedelta(days=days_ahead),
        tz="Asia/Jerusalem",
    )


def _kiosk(w):
    from app.models.pos_machine import POSMachine, PairingStatus

    k = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, distributor_id=w.admin.id, name="Kiosk",
        machine_code="M-K", pos_number="9", is_active=True, pairing_status=PairingStatus.ASSIGNED, z_mode="till",
    )
    w.db.add(k)
    w.db.flush()
    w.db.add(KioskDevice(machine_id=k.id, tenant_id=w.tenant.id, shop_id=w.shop.id, name="Kiosk"))
    w.db.flush()
    return k


def _zs_of_every_type(w):
    t1, t2 = w.tills
    s1 = w.shift(t1, 1)
    w.doc(t1, s1, "100.00", vat="14.53", number="10")
    shop_z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(t1, s1.id)], now=NOW)

    t2.z_mode = "till"
    s2 = w.shift(t2, 1)
    w.doc(t2, s2, "50.00", method="card", number="20")
    own_z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(t2, s2.id)], now=NOW,
                    origin=ZOrigin.TILL)

    ind = w.other_till
    ind.z_mode, ind.independent_till = "till", True
    s3 = w.shift(ind, 1)
    w.doc(ind, s3, "30.00", number="30")
    independent_z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.other_shop.id, selections=[(ind, s3.id)],
                            now=NOW, origin=ZOrigin.TILL)

    k = _kiosk(w)
    s4 = w.shift(k, 1)
    w.doc(k, s4, "12.00", method="card", number="40")
    kiosk_z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(k, s4.id)], now=NOW,
                      origin=ZOrigin.TILL)

    legacy = ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, machine_id=t1.id,
                     business_date=TODAY, closed_at=NOW, total_sales=Decimal("5.00"), per_machine=None)
    w.db.add(legacy)
    w.db.flush()
    return {"shop": shop_z, "till": own_z, "independent": independent_z, "kiosk": kiosk_z, "legacy": legacy}


# ── Z types ─────────────────────────────────────────────────────────────────


class TestZTypes:
    def test_every_type_by_the_rule(self, w):
        zs = _zs_of_every_type(w)
        kiosks = ZT.kiosk_machine_ids(w.db)
        for kind, z in zs.items():
            assert ZT.z_type_of(z, kiosks) == kind, kind

    @pytest.mark.parametrize("kind", ZT.Z_TYPES)
    def test_the_sql_filter_agrees_with_the_rule(self, w, kind):
        zs = _zs_of_every_type(w)
        got = ZT.filter_z_types(w.db.query(ZReport), [kind]).all()
        assert {z.id for z in got} == {zs[kind].id}

    def test_several_types_at_once(self, w):
        zs = _zs_of_every_type(w)
        got = ZT.filter_z_types(w.db.query(ZReport), ["independent", "kiosk"]).all()
        assert {z.id for z in got} == {zs["independent"].id, zs["kiosk"].id}

    def test_parse_reads_repeated_and_comma_separated_and_refuses_unknown(self):
        assert ZT.parse_z_types(["shop,kiosk", "independent"]) == ["shop", "kiosk", "independent"]
        assert ZT.parse_z_types(None) == []
        with pytest.raises(HTTPException) as e:
            ZT.parse_z_types(["nope"])
        assert e.value.status_code == 400

    def test_the_z_list_filters_by_type_and_labels_each_row(self, w):
        zs = _zs_of_every_type(w)
        out = ZR.list_z_reports(
            z_types=["shop", "independent"], from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1),
            machine_id=None, machine_ids=None, shop_id=None, closed_from=None, closed_to=None, area_id=None,
            tz=None, origin=None, date_basis="business", page=1, page_size=50,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert {i.id for i in out.items} == {zs["shop"].id, zs["independent"].id}
        assert {i.z_type for i in out.items} == {"shop", "independent"}
        assert out.model_dump(by_alias=True)["items"][0]["zType"] in ("shop", "independent")

    def test_the_detail_names_its_type(self, w):
        zs = _zs_of_every_type(w)
        assert ZR.z_detail_out(w.db, zs["kiosk"]).z_type == "kiosk"


# ── The Z table ─────────────────────────────────────────────────────────────


class TestZTable:
    def _table(self, w, **kw):
        return RC.get_z_table(
            from_date=TODAY - timedelta(days=1), to_date=TODAY + timedelta(days=1),
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db, **kw,
        )

    def test_a_row_per_z_with_what_it_froze(self, w):
        zs = _zs_of_every_type(w)
        out = self._table(w)
        assert out["total"] == 5
        row = next(r for r in out["zs"] if r["id"] == str(zs["shop"].id))
        assert row["zType"] == "shop" and row["zTypeLabel"] == "Z סניפי"
        assert row["totalSales"] == "100.00" and row["vatTotal"] == "14.53" and row["netOfVat"] == "85.47"
        assert row["payments"] == {"cash": "100.00"}
        assert row["invoiceRange"] and row["invoiceCount"] == 1
        assert row["transmission"]["cardLegs"] == 0
        assert "cash" in out["paymentMethods"] and "card" in out["paymentMethods"]

    def test_a_line_per_till_section(self, w):
        zs = _zs_of_every_type(w)
        out = self._table(w)
        lines = [t for t in out["tills"] if t["zReportId"] == str(zs["till"].id)]
        assert len(lines) == 1 and lines[0]["posNumber"] == w.tills[1].pos_number
        assert lines[0]["payments"] == {"card": "50.00"}

    def test_filtered_by_type_and_shop(self, w):
        zs = _zs_of_every_type(w)
        out = self._table(w, z_types=["independent"])
        assert [r["id"] for r in out["zs"]] == [str(zs["independent"].id)]
        out = self._table(w, shop_ids=[w.other_shop.id])
        assert [r["id"] for r in out["zs"]] == [str(zs["independent"].id)]

    def test_too_many_zs_are_refused(self, w, monkeypatch):
        _zs_of_every_type(w)
        monkeypatch.setattr(ZT, "Z_TABLE_MAX", 2)
        with pytest.raises(HTTPException) as e:
            self._table(w)
        assert e.value.status_code == 400


# ── All in one ──────────────────────────────────────────────────────────────


class TestAllInOne:
    def _world(self, w):
        t1, t2 = w.tills
        s1, s2 = w.shift(t1, 1), w.shift(t2, 1)
        a = w.doc(t1, s1, "100.00", discount="10.00", vat="13.08", tip="5.00", tip_method="cash", number="1")
        a.cashier_id = "emp-1"
        b = w.doc(t2, s2, "60.00", legs=[("cash", "20.00"), ("card", "40.00")], vat="8.72", number="2")
        b.cashier_id = "emp-2"
        c = w.doc(t2, s2, "15.00", credit_note=True, vat="2.18", number="3")
        c.refund_of_transaction_id = b.id
        w.doc(t1, s1, "9.00", status=TransactionStatus.CANCELLED, number="4")
        w.doc(w.other_till, None, "999.00", number="5")
        w.db.flush()

    def _report(self, w, **kw):
        return AIO.build_all_in_one(w.db, w.admin, w.tenant.id, _window(w), **kw)

    def test_every_section_is_there(self, w):
        self._world(w)
        out = self._report(w, shop_ids=[w.shop.id])
        for key in ("summary", "byPaymentMethod", "cardBrands", "byTill", "byEmployee", "byDay", "byCategory",
                    "byItem", "refunds", "discounts", "tips", "vat", "zs", "transmissions", "failedPayments",
                    "meals", "kiosks"):
            assert key in out, key

    def test_the_summary_is_the_cashier_reports_money(self, w):
        self._world(w)
        out = self._report(w, shop_ids=[w.shop.id])
        ref = build_cashier_sales_report(w.db, w.admin, w.tenant.id, _window(w), shop_id=w.shop.id).totals
        s = out["summary"]
        assert s["net"] == round(ref.net, 2) == 135.0
        assert s["gross"] == round(ref.gross, 2) and s["refunds"] == 15.0 and s["discounts"] == 10.0
        assert s["cash"] + s["card"] + s["other"] + s["exchange"] == pytest.approx(s["net"])
        assert s["tips"] == 5.0 and s["cancelledDocuments"] == 1
        assert s["vat"] == pytest.approx(13.08 + 8.72 - 2.18)

    def test_by_till_and_employee_add_up_to_the_summary(self, w):
        self._world(w)
        out = self._report(w, shop_ids=[w.shop.id])
        assert sum(r["net"] for r in out["byTill"]) == pytest.approx(out["summary"]["net"])
        assert sum(r["net"] for r in out["byEmployee"]) == pytest.approx(out["summary"]["net"])
        assert sum(r["net"] for r in out["byDay"]) == pytest.approx(out["summary"]["net"])

    def test_payment_methods_and_refunds(self, w):
        self._world(w)
        out = self._report(w, shop_ids=[w.shop.id])
        methods = {r["method"]: r["amount"] for r in out["byPaymentMethod"]}
        assert methods["card"] == 40.0 and methods["cash"] == pytest.approx(90.0 + 20.0 - 15.0)
        assert out["refunds"]["count"] == 1 and out["refunds"]["total"] == 15.0
        assert out["refunds"]["items"][0]["originalNumber"] is not None
        assert out["tips"]["cash"] == 5.0

    def test_several_shops_and_tills(self, w):
        self._world(w)
        both = self._report(w, shop_ids=[w.shop.id, w.other_shop.id])
        assert both["summary"]["net"] == pytest.approx(135.0 + 999.0)
        one = self._report(w, machine_ids=[w.tills[0].id])
        assert one["summary"]["net"] == 90.0

    def test_another_tenant_gets_an_empty_report(self, w):
        self._world(w)
        out = AIO.build_all_in_one(w.db, w.admin, uuid.uuid4(), _window(w))
        assert out["summary"]["documents"] == 0


# ── Reconciliation ──────────────────────────────────────────────────────────


def _rows(out, check, **match):
    return [r for r in out["rows"] if r["check"] == check and all(r.get(k) == v for k, v in match.items())]


class TestReconciliation:
    def _rec(self, w, **kw):
        kw.setdefault("now", NOW + timedelta(hours=1))
        return REC.build_reconciliation(w.db, w.admin, w.tenant.id, _window(w), **kw)

    def test_a_clean_z_day_is_a_match(self, w):
        t1 = w.tills[0]
        s1 = w.shift(t1, 1)
        w.doc(t1, s1, "10.00", vat="1.45", number="1")
        w.doc(t1, s1, "20.00", vat="2.91", number="2")
        build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(t1, s1.id)], now=NOW)
        out = self._rec(w, machine_ids=[t1.id], checks=("documents_z", "z_totals", "document_numbers"))
        assert {r["status"] for r in out["rows"]} == {"match"}
        assert out["totals"]["match"] == len(out["rows"]) >= 3

    def test_documents_outside_a_z(self, w):
        t1 = w.tills[0]
        closed = w.shift(t1, 1)
        w.doc(t1, closed, "10.00", number="1")
        open_shift = w.shift(t1, 2, status=ShiftStatus.OPEN)
        w.doc(t1, open_shift, "20.00", number="2")
        w.doc(t1, None, "30.00", number="3")
        out = self._rec(w, machine_ids=[t1.id], checks=("documents_z",))
        by_status = {r["status"] for r in _rows(out, "documents_z") if r["subject"] != "מסמכים"}
        assert "missing" in by_status and "pending" in by_status
        reasons = " ".join(r["reason"] for r in out["rows"])
        assert "לא נכללה באף Z" in reasons and "ללא משמרת" in reasons and "עדיין פתוחה" in reasons

    def test_a_document_landing_after_its_z(self, w):
        t1 = w.tills[0]
        s1 = w.shift(t1, 1)
        w.doc(t1, s1, "10.00", number="1")
        z = build_z(w.db, tenant_id=w.tenant.id, shop_id=w.shop.id, selections=[(t1, s1.id)], now=NOW)
        late = w.doc(t1, s1, "5.00", number="2")
        late.server_received_at = NOW + timedelta(hours=2)
        z.created_at = NOW
        z.late_documents = 1
        w.db.flush()
        out = self._rec(w, machine_ids=[t1.id], checks=("documents_z", "z_totals"))
        assert any(r["status"] == "difference" and "אחרי הפקת ה-Z" in r["reason"] for r in _rows(out, "documents_z"))
        z_row = _rows(out, "z_totals")[0]
        assert z_row["status"] == "difference" and z_row["difference"] == 5.0
        assert "1 מסמכים הגיעו אחרי הפקת ה-Z" in z_row["reason"]

    def test_a_numbering_gap(self, w):
        t1 = w.tills[0]
        s1 = w.shift(t1, 1)
        for n in ("1", "2", "4", "5"):
            w.doc(t1, s1, "1.00", number=n)
        out = self._rec(w, machine_ids=[t1.id], checks=("document_numbers",))
        row = _rows(out, "document_numbers", series=320)[0]
        assert row["status"] == "missing" and "חסרים 1 מספרים: 3" in row["reason"]
        assert row["difference"] == -1.0 and row["count"] == 4

    def test_a_gap_names_the_clouds_refusals_of_the_tills_documents(self, w):
        from app.models.sync_log import SyncLog, SyncAction, SyncDirection, SyncEntityType, SyncStatus

        t1 = w.tills[0]
        s1 = w.shift(t1, 1)
        for n in ("1", "3"):
            w.doc(t1, s1, "1.00", number=n)
        w.db.add(SyncLog(id=uuid.uuid4(), machine_id=t1.id, direction=SyncDirection.POS_TO_SERVER,
                         entity_type=SyncEntityType.TRANSACTIONS, entity_id=uuid.uuid4(), action=SyncAction.UPDATE,
                         status=SyncStatus.FAILED, conflict_note="approver_unknown_or_inactive", created_at=NOW))
        w.db.flush()
        out = self._rec(w, machine_ids=[t1.id], checks=("document_numbers",))
        row = _rows(out, "document_numbers", series=320)[0]
        assert "approver_unknown_or_inactive ×1" in row["reason"]

    def test_a_gap_against_the_number_before_the_window(self, w):
        t1 = w.tills[0]
        before = w.doc(t1, None, "1.00", number="7")
        before.created_at = NOW - timedelta(days=5)
        s1 = w.shift(t1, 1)
        w.doc(t1, s1, "1.00", number="9")
        w.db.flush()
        out = self._rec(w, machine_ids=[t1.id], checks=("document_numbers",))
        row = _rows(out, "document_numbers", series=320)[0]
        assert row["status"] == "missing" and row["previousNumber"] == "7" and "8" in row["reason"]

    def test_z_numbers_must_be_sequential(self, w):
        t1 = w.tills[0]
        for seq in (1, 2, 4):
            w.db.add(ZReport(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, business_date=TODAY,
                             closed_at=NOW, shop_sequence_number=seq, per_machine=[]))
        w.db.flush()
        out = self._rec(w, shop_ids=[w.shop.id], checks=("z_numbers",))
        row = _rows(out, "z_numbers")[0]
        assert row["status"] == "missing" and "3" in row["reason"]

    def test_card_sales_against_transmissions(self, w):
        t1, t2 = w.tills
        t1.transmission_tracking_started_at = NOW - timedelta(days=3)
        t2.transmission_tracking_started_at = NOW - timedelta(days=3)
        s1 = w.shift(t1, 1)
        sold = w.doc(t1, s1, "40.00", method="card", number="1")
        leg = w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == sold.id).one()
        leg.terminal_uid = "U1"
        tr = CardTransmission(id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=t1.id, shop_id=w.shop.id,
                              trigger="shift_close", started_at=NOW + timedelta(minutes=5), status="success",
                              transaction_count=1, amount=Decimal("40.00"), terminal_transaction_count=1)
        w.db.add(tr)
        w.db.flush()
        w.db.add(CardTransmissionItem(id=uuid.uuid4(), transmission_id=tr.id, machine_id=t1.id, terminal_uid="U1"))
        leg.transmission_id = tr.id
        # Till 2: a card sale a day and a half old, never transmitted.
        s2 = w.shift(t2, 1)
        old = w.doc(t2, s2, "25.00", method="card", number="2")
        old.created_at = NOW - timedelta(hours=10)
        leg2 = w.db.query(TransactionPayment).filter(TransactionPayment.transaction_id == old.id).one()
        leg2.terminal_uid = "U2"
        w.db.flush()

        out = self._rec(w, shop_ids=[w.shop.id], checks=("card_legs", "transmissions"), now=NOW + timedelta(days=1))
        mine = _rows(out, "card_legs", machineId=str(t1.id))[0]
        assert mine["status"] == "match" and mine["expected"] == mine["actual"] == 40.0
        theirs = _rows(out, "card_legs", machineId=str(t2.id))[0]
        assert theirs["status"] == "missing" and "מעל 24 שעות" in theirs["reason"]
        assert theirs["untransmittedLegs"] == 1 and theirs["actual"] == 0.0
        batch = _rows(out, "transmissions", machineId=str(t1.id))[0]
        assert batch["status"] == "match"
        never = _rows(out, "transmissions", machineId=str(t2.id))[0]
        assert never["status"] == "missing" and "מעולם" in never["reason"]

    def test_a_failed_transmission_never_completed(self, w):
        t1 = w.tills[0]
        w.db.add(CardTransmission(id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=t1.id, shop_id=w.shop.id,
                                  trigger="daily", started_at=NOW, status="failed", error="terminal_unavailable"))
        w.db.flush()
        out = self._rec(w, machine_ids=[t1.id], checks=("transmissions",))
        row = _rows(out, "transmissions")[0]
        assert row["status"] == "missing" and "לא הושלם" in row["reason"]

    def test_a_batch_amount_that_differs_from_its_sales(self, w):
        t1 = w.tills[0]
        w.db.add(CardTransmission(id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=t1.id, shop_id=w.shop.id,
                                  trigger="shift_close", started_at=NOW, status="success", transaction_count=2,
                                  amount=Decimal("80.00"), terminal_transaction_count=0))
        w.db.flush()
        out = self._rec(w, machine_ids=[t1.id], checks=("transmissions",))
        row = _rows(out, "transmissions")[0]
        assert row["status"] == "difference" and row["expected"] == 80.0 and row["actual"] == 0.0

    def test_the_summary_counts_every_row(self, w):
        t1 = w.tills[0]
        w.doc(t1, None, "1.00", number="1")
        out = self._rec(w, machine_ids=[t1.id])
        assert sum(out["totals"].values()) == len(out["rows"])
        assert [c["key"] for c in out["checks"]] == list(REC.CHECKS)

    def test_the_route_refuses_an_unknown_check(self, w):
        with pytest.raises(HTTPException) as e:
            RC.get_reconciliation(checks=["nope"], current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert e.value.status_code == 400
