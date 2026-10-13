"""
The reports with a till "מרוחקת בזד הסניפי" (not on the local server, in the shop Z — the device
preset `remote_shop_z`) and a "קופה עצמאית" in the shop (P:/specs/dedicated-local-server.md §12;
the owner: no gaps, "בדוחות" too).

The shop's day: tills 1–5 in the shop Z on main till 1 — till 4 remote — selling 11, 12, 13, 40
and 15; independent till 6 selling 999 in its own Z. Both ways the shop Z is made: by the cloud's
run, and by the main till (local mode) with till 4's part through the cloud. Every report then:

* **the shop Z** — its print, its summary and its per-till pages, Z by date, the Z table and the
  day summary: the shop Z is the sum of its participants, till 4 among them; till 6 never in it,
  only in its own Z;
* **sales by till and shop** — the overview, tills side by side, the all-in-one report and the
  cashier sales: each till's money exactly once, under its shop and its number;
* **the open-format export** — every document once, nothing missing, the branch code (1231) and
  each till's own document numbers;
* **training** — a training sale of the remote till is in the training report only;
* **accounting and the reconciliation** — the till labels, and the documents in the right Z.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import json
import uuid
from decimal import Decimal
from datetime import timezone

import pytest

from app.models.transaction import Transaction
from app.models.z_report import ZReport
from app.services import work_config as WC
from app.services.reports import resolve_report_window
from shift_world import TODAY
from test_independent_till import (  # noqa: F401 - `w` is the fixture
    _manifest_body, _part, closed_shift, cloud_mode, owner_setup, run_z, upload, w,
)
from test_remote_shop_z_till import answer, ask_remote

AMOUNTS = {"1": "11.00", "2": "12.00", "3": "13.00", "4": "40.00", "5": "15.00", "6": "999.00"}
SHOP_Z_TOTAL = Decimal("91.00")
TZ = "Asia/Jerusalem"


def _till_z(w, till):
    from app.routers import sync as sync_router
    from app.schemas.till_z import TillZIn

    resp = sync_router.post_till_z(
        machine_id=str(till.id), body=TillZIn.model_validate({"clientRequestId": str(uuid.uuid4())}), machine=till, db=w.db,
    )
    assert resp.status_code == 201, resp.body
    return w.db.get(ZReport, uuid.UUID(json.loads(resp.body)["zReport"]["id"]))


def _day(w, mode):
    """The shop's day, its shop Z made by the cloud ("cloud") or by the main till ("local")."""
    owner_setup(w)
    four, six = w.six[3], w.six[5]
    w.shop.branch_id = "12"
    w.other_shop.branch_id = "13"
    WC.apply(w.db, w.admin, four, {"preset": WC.REMOTE_SHOP_Z})
    w.db.commit()
    shifts = {m.id: closed_shift(w, m, 1, AMOUNTS[m.pos_number]) for m in w.six}
    # As a till sends them: each document carries its till's number.
    for tx in w.db.query(Transaction).filter(Transaction.shop_id == w.shop.id).all():
        tx.pos_number = next(m.pos_number for m in w.six if m.id == tx.machine_id)
    w.db.commit()
    if mode == "cloud":
        cloud_mode(w)
        shop_z = w.db.get(ZReport, run_z(w, w.six[:5]).z_report_id)
    else:
        main = w.six[0]
        ask_remote(w, main, four, "q1")
        from app.routers import machines as machines_router

        machines_router.post_my_heartbeat(None, machine=four, db=w.db)
        part = answer(w, four, shifts[four.id], "q1")
        parts = [_part(w, m, [shifts[m.id]]) for m in w.six[:5] if m.id != four.id] + [part]
        code, out = upload(w, main, _manifest_body(w, 1, parts))
        assert code == 201, out
        shop_z = w.db.get(ZReport, uuid.UUID(out["zReportId"]))
    w.db.commit()
    six_z = _till_z(w, six)
    w.db.commit()
    return shop_z, six_z, shifts


def _window(w):
    return resolve_report_window(w.db, w.tenant.id, from_date=TODAY, to_date=TODAY, tz=TZ)


MODES = ("cloud", "local")


# ── The shop Z: the sum of its participants, the remote till among them ────────


class TestTheShopZ:
    @pytest.mark.parametrize("mode", MODES)
    def test_the_shop_z_is_the_sum_of_its_tills_with_the_remote_one(self, w, mode):
        shop_z, six_z, shifts = _day(w, mode)
        sections = {s["posNumber"]: s for s in shop_z.per_machine}
        assert set(sections) == {"1", "2", "3", "4", "5"}
        assert Decimal(str(shop_z.total_sales)) == SHOP_Z_TOTAL
        assert sum(Decimal(str(s.get("totalSales") or s.get("grossSales"))) for s in sections.values()) == SHOP_Z_TOTAL
        assert Decimal(str(sections["4"].get("totalSales") or sections["4"].get("grossSales"))) == Decimal("40.00")
        assert shop_z.shop_sequence_number == 1 and shop_z.machine_count == 5
        # Every participant's shift is in it, once; till 6's is in its own Z only.
        assert {s.z_report_id for mid, s in shifts.items() if mid != w.six[5].id} == {shop_z.id}
        assert shifts[w.six[5].id].z_report_id == six_z.id
        assert Decimal(str(six_z.total_sales)) == Decimal("999.00") and six_z.shop_sequence_number is None

    @pytest.mark.parametrize("mode", MODES)
    def test_its_print_summary_and_till_pages(self, w, mode):
        from app.services import z_print as ZPR

        shop_z, six_z, _ = _day(w, mode)
        doc = ZPR.build_print_document(shop_z, timezone.utc)
        text = json.dumps(doc, ensure_ascii=False)
        assert "קופה 4" in text and "קופה 6" not in text.split("לא כולל")[0]
        summary = ZPR.build_summary_document(shop_z, timezone.utc)
        assert len(summary["tills"]) == 5
        assert ZPR.build_till_document(shop_z, w.six[3].id, timezone.utc) is not None
        assert ZPR.build_till_document(shop_z, w.six[5].id, timezone.utc) is None
        assert ZPR.branch_code_of(shop_z) == "12"
        # Till 6's Z: it alone, as an independent till.
        own = ZPR.build_print_document(six_z, timezone.utc)
        assert "קופה 6" in json.dumps(own, ensure_ascii=False)
        assert ZPR.build_till_document(six_z, w.six[3].id, timezone.utc) is None
        assert ZPR.till_number_of(six_z) == "6"

    @pytest.mark.parametrize("mode", MODES)
    def test_z_by_date_and_the_z_table(self, w, mode):
        from app.services import z_by_date as ZBD
        from app.services import z_table as ZT

        shop_z, six_z, _ = _day(w, mode)
        out = ZBD.build_summary(w.db, [shop_z, six_z], timezone.utc)
        totals = {z["id"]: z for z in out["zs"]}
        assert set(totals) == {str(shop_z.id), str(six_z.id)}
        table = ZT.build_z_table(w.db, [shop_z, six_z], timezone.utc)
        rows = [(r["zReportId"], r["posNumber"]) for r in table["tills"]]
        assert sorted(p for z, p in rows if z == str(shop_z.id)) == ["1", "2", "3", "4", "5"]
        assert [p for z, p in rows if z == str(six_z.id)] == ["6"]
        assert len(rows) == 6  # each till once

    @pytest.mark.parametrize("mode", MODES)
    def test_the_day_summary_counts_each_till_once(self, w, mode):
        from app.services import reports as R

        shop_z, six_z, _ = _day(w, mode)
        out = R.build_day_summary_report(w.db, w.admin, w.tenant.id, _window(w))
        data = out.model_dump(by_alias=True)
        (day,) = [d for d in data["days"] if d["contributors"]]
        assert day["zReportCount"] == 2 and day["machineCount"] == 6
        assert day["totals"]["net"] == 1090.0
        # The shop Z's tills — till 4 among them — and till 6 by its own Z, each once.
        own = [c for c in day["contributors"] if c["independent"]]
        assert [(c["posNumber"], c["net"], str(c["zReportId"])) for c in own] == [("6", 999.0, str(six_z.id))]
        shop = [c for c in day["contributors"] if not c["independent"]]
        assert {str(c["zReportId"]) for c in shop} == {str(shop_z.id)}
        assert round(sum(c["net"] for c in day["contributors"]), 2) == 1090.0


# ── Sales by till and shop: each till once, under its shop and number ────────


class TestSalesByTill:
    @pytest.mark.parametrize("mode", MODES)
    def test_the_overview(self, w, mode):
        from app.services.overview import build_overview

        _day(w, mode)
        out = build_overview(w.db, w.admin, w.tenant.id, _window(w))
        shop = next(s for c in out.companies for s in c.shops if s.id == w.shop.id)
        by_number = {m.pos_number: m.sales_today for m in shop.machines}
        assert {k: by_number[k] for k in AMOUNTS} == {k: float(v) for k, v in AMOUNTS.items()}
        assert round(sum(by_number[k] for k in AMOUNTS), 2) == shop.sales_today == 1090.0

    @pytest.mark.parametrize("mode", MODES)
    def test_tills_side_by_side(self, w, mode):
        from app.services import period_compare as PC
        from shift_world import NOW

        _day(w, mode)
        got = {}
        # At most four side by side: the remote till with its neighbours, then the independent one.
        for group in (w.six[:4], w.six[3:]):
            out = PC.build_side_by_side(w.db, w.admin, w.tenant.id, _window(w), kind="machine",
                                        ids=[str(m.id) for m in group], now=NOW)
            for e in out.entities:
                assert got.setdefault(e.number, e.figures.sales) == e.figures.sales
        assert got == {k: float(v) for k, v in AMOUNTS.items()}

    @pytest.mark.parametrize("mode", MODES)
    def test_the_all_in_one_report(self, w, mode):
        from app.services import all_in_one as AIO

        shop_z, six_z, _ = _day(w, mode)
        out = AIO.build_all_in_one(w.db, w.admin, w.tenant.id, _window(w), shop_ids=[w.shop.id])
        by_till = {r.get("posNumber"): r["net"] for r in out["byTill"]}
        assert by_till == {k: float(v) for k, v in AMOUNTS.items()}
        assert out["summary"]["net"] == pytest.approx(1090.0)
        assert {z["id"] for z in out["zs"]["zs"]} == {str(shop_z.id), str(six_z.id)}

    @pytest.mark.parametrize("mode", MODES)
    def test_the_cashier_sales_total(self, w, mode):
        from app.services.reports import build_cashier_sales_report

        _day(w, mode)
        out = build_cashier_sales_report(w.db, w.admin, w.tenant.id, _window(w), shop_id=w.shop.id)
        assert round(out.totals.net, 2) == 1090.0
        till4 = build_cashier_sales_report(w.db, w.admin, w.tenant.id, _window(w), machine_id=w.six[3].id)
        assert round(till4.totals.net, 2) == 40.0


# ── The open-format export ────────────────────────────────────────────────────


class TestTheTaxExport:
    @pytest.mark.parametrize("mode", MODES)
    def test_every_document_once_with_its_branch_and_till(self, w, mode):
        from app.services import tax_reports as TR
        from test_open_format_131 import c100, records

        _day(w, mode)
        ctx = TR.resolve_export_context(w.db, company=w.company, shop=w.shop, mode="date-range",
                                        from_date=TODAY, to_date=TODAY)
        result, dicts, _zip = TR.build_tax_open_format_export(w.db, w.tenant.id, ctx, shop_id=w.shop.id)
        heads = [c100(line) for line in records(result, "C100")]
        ours = w.db.query(Transaction).filter(Transaction.shop_id == w.shop.id).all()
        assert len(heads) == len(ours) == 6  # nothing missing, nothing twice
        assert len({(h["1203"], h["1204"]) for h in heads}) == 6
        assert {h["1231"] for h in heads} == {"12"}
        # Each till's documents under its own number.
        numbers = {TR.export_document_number(tx): tx.pos_number for tx in ours}
        assert {h["1204"] for h in heads} == set(numbers)
        assert sorted(numbers.values()) == ["1", "2", "3", "4", "5", "6"]
        assert all(n.startswith(p) for n, p in numbers.items())


# ── Training stays apart ─────────────────────────────────────────────────────


class TestTraining:
    def test_a_training_sale_of_the_remote_till_is_in_the_training_report_only(self, w):
        from app.services import training_mode as TM
        from app.services.overview import build_overview

        _day(w, "local")
        four = w.six[3]
        before = w.db.query(Transaction).count()
        TM.store(w.db, four, w.shop, "transaction", str(uuid.uuid4()), {"totalAmount": "77.00", "documentType": 320},
                 number="ה-1")
        w.db.commit()
        report = TM.report(w.db, w.shop)
        assert [r.get("posNumber") for r in report["byTill"]] == ["4"]
        assert w.db.query(Transaction).count() == before
        out = build_overview(w.db, w.admin, w.tenant.id, _window(w))
        shop = next(s for c in out.companies for s in c.shops if s.id == w.shop.id)
        assert shop.sales_today == 1090.0


# ── Accounting and the reconciliation ────────────────────────────────────────


class TestAccountingAndReconciliation:
    @pytest.mark.parametrize("mode", MODES)
    def test_the_accounting_facts_name_each_till_once(self, w, mode):
        from app.services.accounting import journal as J

        shop_z, six_z, _ = _day(w, mode)
        facts = J.load_z_facts(w.db, shop_z)
        own = J.load_z_facts(w.db, six_z)
        assert own.till_label.startswith("קופה 6")
        assert facts.z_number == 1 and own.z_id == six_z.id and facts.z_id == shop_z.id
        assert Decimal(str(facts.net)) == SHOP_Z_TOTAL and Decimal(str(own.net)) == Decimal("999.00")

    def test_the_reconciliation_finds_every_document_in_its_z(self, w):
        from datetime import timedelta

        from app.services import reconciliation as REC
        from shift_world import NOW

        _day(w, "cloud")
        out = REC.build_reconciliation(
            w.db, w.admin, w.tenant.id, _window(w), machine_ids=[w.six[3].id],
            checks=("documents_z",), now=NOW + timedelta(hours=1),
        )
        data = out if isinstance(out, dict) else out.model_dump(by_alias=True)
        (row,) = data["rows"]
        assert (row["status"], row["gapType"], row["posNumber"], row["zNumber"], row["actual"]) == (
            "match", "in_z", "4", "1", 40.0,
        )
