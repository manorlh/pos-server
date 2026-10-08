"""
The Z as the till prints it (80 mm): one print document built on the server
(`app/services/z_print.py`), served to the dashboard and to the till.

* Content: header, sales gross → net, VAT, tenders, tips, drawer, per-till sections —
  and the card transmission / offline-declined blocks only when the Z has them.
* Dashboard: `GET /z-reports/{id}/print-document` and `GET /z-reports/print-documents`
  (ids, or one shop's range; Z-number order; at most 200), scoped like the Z itself.
* Till: `GET /sync/{id}/z-reports` (its shop's Zs, newest first, paged) and
  `GET /sync/{id}/z-reports/{zid}/print-document` — another shop's Z is a 404.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.user import User, UserRole
from app.models.z_report import ZReport
from app.routers import sync as sync_router
from app.routers import z_reports as zr_router
from app.services import z_print
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    return make_world()


def _section(till, **extra):
    base = {
        "machineId": str(till.id),
        "machineName": till.name,
        "posNumber": till.pos_number,
        "shiftCount": 2,
        "firstShiftSequence": 4,
        "lastShiftSequence": 5,
        "firstDocumentNumber": "1001",
        "lastDocumentNumber": "1040",
        "totalSales": "1200.00",
        "netSales": "1150.00",
        "totalRefunds": "50.00",
        "totalCash": "400.00",
        "totalCard": "750.00",
        "expectedCash": "500.00",
        "overShort": "-2.00",
        "uncountedShiftCount": 0,
        "betweenShiftAdjustments": "0.00",
    }
    base.update(extra)
    return base


_DEFAULT = object()


def _z(w, seq, *, shop=None, per_machine=_DEFAULT, business=date(2026, 9, 27), closed=None, **cols) -> ZReport:
    shop = shop or w.shop
    z = ZReport(
        id=uuid.uuid4(),
        tenant_id=w.tenant.id,
        shop_id=shop.id,
        shop_sequence_number=seq,
        business_date=business,
        # 19:20 UTC = 22:20 in Israel (UTC+3 in September).
        closed_at=closed or datetime(2026, 9, 27, 19, 20, tzinfo=timezone.utc),
        period_start=datetime(2026, 9, 27, 5, 0, tzinfo=timezone.utc),
        period_end=datetime(2026, 9, 27, 19, 0, tzinfo=timezone.utc),
        shift_count=2,
        machine_count=1,
        total_sales=Decimal("1200.00"),
        total_refunds=Decimal("50.00"),
        discounts_total=Decimal("34.00"),
        vat_total=Decimal("167.09"),
        total_cash_sales=Decimal("400.00"),
        total_card_sales=Decimal("750.00"),
        total_tips=Decimal("30.00"),
        total_cash_tips=Decimal("10.00"),
        total_card_tips=Decimal("20.00"),
        transactions_count=40,
        payment_breakdown={"cash": "400.00", "card": "700.00", "voucher": "50.00"},
        opening_cash=Decimal("100.00"),
        expected_cash=Decimal("500.00"),
        actual_cash=Decimal("498.00"),
        discrepancy=Decimal("-2.00"),
        header={"businessName": "Acme Ltd", "companyRegNumber": "515151515", "shopName": "Center"},
        per_machine=[_section(w.tills[0])] if per_machine is _DEFAULT else per_machine,
    )
    for key, value in cols.items():
        setattr(z, key, value)
    w.db.add(z)
    w.db.flush()
    return z


def _rows(doc, title):
    for s in doc["sections"]:
        if s["title"] == title:
            return {r["label"]: r["value"] for r in s["rows"]}
    return None


def _titles(doc):
    return [s["title"] for s in doc["sections"]]


def _tz():
    from zoneinfo import ZoneInfo

    return ZoneInfo("Asia/Jerusalem")


# ── Content ───────────────────────────────────────────────────────────────────


class TestDocument:
    def test_the_fixed_shape(self, w):
        doc = z_print.build_print_document(_z(w, 12), _tz())
        assert set(doc) == {"title", "number", "businessName", "subtitle", "sections", "footer"}
        assert doc["title"] == "דו״ח Z"
        assert doc["number"] == 12
        assert doc["businessName"] == "Acme Ltd"
        for s in doc["sections"]:
            assert set(s) == {"title", "rows"}
            for r in s["rows"]:
                assert set(r) == {"label", "value", "emphasis"}
                assert isinstance(r["value"], str)
                assert len(r["label"]) <= z_print.LABEL_MAX

    def test_header_dates_in_the_tenant_timezone(self, w):
        doc = z_print.build_print_document(_z(w, 12), _tz())
        assert "ח.פ. 515151515" in doc["subtitle"]
        assert "סניף Center" in doc["subtitle"]
        assert "תאריך עסקים 27/09/2026" in doc["subtitle"]
        assert "הופק 27/09/2026 22:20" in doc["subtitle"]

    def test_figures_are_formatted_strings(self, w):
        doc = z_print.build_print_document(_z(w, 12), _tz())
        sales = _rows(doc, "מכירות")
        assert sales["מכירות ברוטו"] == "₪1,234.00"
        assert sales["הנחות"] == "-₪34.00"
        assert sales["זיכויים"] == "-₪50.00"
        assert sales["סה״כ נטו"] == "₪1,150.00"
        assert _rows(doc, "מע״מ")["מע״מ"] == "₪167.09"
        assert _rows(doc, "מע״מ")["נטו ללא מע״מ"] == "₪982.91"
        pay = _rows(doc, "אמצעי תשלום")
        assert (pay["מזומן"], pay["אשראי"], pay["שוברים"], pay["אחר"]) == (
            "₪400.00", "₪700.00", "₪50.00", "₪0.00",
        )
        tips = _rows(doc, "תשר")
        assert (tips["תשר מזומן"], tips["תשר אשראי"]) == ("₪10.00", "₪20.00")
        cash = _rows(doc, "קופה")
        assert cash["מזומן צפוי"] == "₪500.00"
        assert cash["מזומן שנספר"] == "₪498.00"
        assert cash["הפרש"] == "-₪2.00"

    def test_an_uncounted_drawer_is_withheld_not_zero(self, w):
        z = _z(w, 12, actual_cash=None, discrepancy=None,
               per_machine=[_section(w.tills[0], uncountedShiftCount=1, overShort=None)])
        doc = z_print.build_print_document(z, _tz())
        cash = _rows(doc, "קופה")
        assert cash["מזומן שנספר"] == "לא נספר"
        assert cash["הפרש"] == "לא חושב"

    def test_a_till_section_per_register(self, w):
        z = _z(w, 12, per_machine=[_section(w.tills[0]), _section(w.tills[1], lastShiftSequence=4)])
        doc = z_print.build_print_document(z, _tz())
        till = _rows(doc, "קופה 1 · Till 1")
        assert till["משמרות"] == "2 (#4–#5)"
        assert till["מסמכים"] == "1001–1040"
        assert till["סה״כ נטו"] == "₪1,150.00"
        assert _rows(doc, "קופה 2 · Till 2")["משמרות"] == "2 (#4)"

    def test_without_transmission_or_offline_blocks(self, w):
        doc = z_print.build_print_document(_z(w, 12), _tz())
        assert "שידור אשראי" not in _titles(doc)
        assert not any(t.startswith("אשראי אופליין") for t in _titles(doc))

    def test_empty_blocks_print_nothing(self, w):
        section = _section(
            w.tills[0],
            transmission={"batches": [], "cardLegs": 0, "transmittedLegs": 0, "untransmittedLegs": 0},
            offline={"authorizationCount": 0, "approvedCount": 0, "declinedCount": 0, "declinedAmount": "0.00", "declined": []},
        )
        doc = z_print.build_print_document(_z(w, 12, per_machine=[section]), _tz())
        assert "שידור אשראי" not in _titles(doc)
        assert not any(t.startswith("אשראי אופליין") for t in _titles(doc))

    def test_with_transmission_and_offline_blocks(self, w):
        section = _section(
            w.tills[0],
            transmission={
                "batches": [
                    {"batchNumber": 7, "status": "ok", "startedAt": "2026-09-27T12:00:00+00:00", "amount": "300.00"},
                    {"batchNumber": 8, "status": "ok", "startedAt": "2026-09-27T18:00:00+00:00", "amount": "400.00"},
                ],
                "cardLegs": 12, "transmittedLegs": 10, "untransmittedLegs": 2,
                "untransmittedAmount": "50.00", "untrackedLegs": 0,
            },
            offline={
                "authorizationCount": 1, "approvedCount": 3, "declinedCount": 1,
                "declinedAmount": "25.00",
                "declined": [{"transactionId": str(uuid.uuid4()), "documentNumber": "1033", "amount": "25.00"}],
            },
        )
        doc = z_print.build_print_document(_z(w, 12, per_machine=[section]), _tz())
        tx = _rows(doc, "שידור אשראי")
        assert tx["עסקאות אשראי"] == "12"
        assert tx["ממתינות לשידור"] == "2"
        assert tx["סכום ממתין"] == "₪50.00"
        assert tx["שידור אחרון"] == "#8 27/09 21:00"
        off = _rows(doc, "אשראי אופליין שנדחה")
        assert off["נדחו"] == "1"
        assert off["סכום שנדחה"] == "₪25.00"
        assert off["מסמך 1033"] == "₪25.00"
        till = _rows(doc, "קופה 1 · Till 1")
        assert till["ממתינות לשידור"] == "2"
        assert till["אופליין שנדחה"] == "1 · ₪25.00"

    def test_footer_notices(self, w):
        z = _z(w, 12, late_documents=3, unattended=True)
        doc = z_print.build_print_document(z, _tz(), printed_at=datetime(2026, 10, 3, 19, 20, tzinfo=timezone.utc))
        assert any("3 מסמכים" in line for line in doc["footer"])
        assert "הודפס 03/10/2026 22:20" in doc["footer"]
        assert doc["footer"][-1] == "סוף דו״ח Z #12"

    def test_a_legacy_z(self, w):
        z = _z(w, 3, per_machine=None, machine_id=w.tills[0].id, payment_breakdown=None)
        w.db.flush()
        doc = z_print.build_print_document(z, _tz())
        pay = _rows(doc, "אמצעי תשלום")
        assert (pay["מזומן"], pay["אשראי"]) == ("₪400.00", "₪750.00")
        assert "דו״ח Z ישן שהופק בקופה" in doc["footer"]


# ── Dashboard endpoints ───────────────────────────────────────────────────────


def _docs(w, user=None, **kw):
    args = dict(
        ids=None, shop_id=None, from_date=None, to_date=None, from_number=None, to_number=None,
        date_basis="business", current_user=user or w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )
    args.update(kw)
    return zr_router.get_z_print_documents(**args)


def _shop_user(w, shop):
    u = User(id=uuid.uuid4(), role=UserRole.SHOP_MANAGER, tenant_id=w.tenant.id, shop_id=shop.id,
             email=f"{uuid.uuid4().hex[:6]}@x", username=uuid.uuid4().hex[:8])
    w.db.add(u)
    w.db.flush()
    return u


class TestDashboard:
    def test_one(self, w):
        z = _z(w, 12)
        doc = zr_router.get_z_print_document(z.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert doc["number"] == 12

    def test_one_out_of_scope_is_404(self, w):
        z = _z(w, 12, shop=w.other_shop)
        with pytest.raises(HTTPException) as e:
            zr_router.get_z_print_document(
                z.id, current_user=_shop_user(w, w.shop), active_tenant_id=w.tenant.id, db=w.db,
            )
        assert e.value.status_code == 404

    def test_ids_in_z_number_order(self, w):
        a, b, c = _z(w, 3), _z(w, 1), _z(w, 2)
        out = _docs(w, ids=f"{a.id},{b.id},{c.id}")
        assert [i["number"] for i in out["items"]] == [1, 2, 3]
        assert out["total"] == 3
        assert out["items"][0]["document"]["number"] == 1

    def test_an_id_out_of_scope_is_404(self, w):
        mine, theirs = _z(w, 1), _z(w, 1, shop=w.other_shop)
        with pytest.raises(HTTPException) as e:
            _docs(w, user=_shop_user(w, w.shop), ids=f"{mine.id},{theirs.id}")
        assert e.value.status_code == 404

    def test_a_number_range_of_one_shop(self, w):
        for n in range(1, 6):
            _z(w, n)
        _z(w, 3, shop=w.other_shop)
        out = _docs(w, shop_id=w.shop.id, from_number=2, to_number=4)
        assert [i["number"] for i in out["items"]] == [2, 3, 4]
        assert {i["shopId"] for i in out["items"]} == {str(w.shop.id)}

    def test_a_date_range(self, w):
        _z(w, 1, business=date(2026, 9, 25))
        _z(w, 2, business=date(2026, 9, 26))
        _z(w, 3, business=date(2026, 9, 27))
        out = _docs(w, shop_id=w.shop.id, from_date=date(2026, 9, 26), to_date=date(2026, 9, 27))
        assert [i["number"] for i in out["items"]] == [2, 3]

    def test_a_range_needs_bounds(self, w):
        with pytest.raises(HTTPException) as e:
            _docs(w, shop_id=w.shop.id)
        assert e.value.status_code == 400
        with pytest.raises(HTTPException) as e:
            _docs(w)
        assert e.value.status_code == 400

    def test_the_cap(self, w, monkeypatch):
        monkeypatch.setattr(zr_router, "PRINT_DOCUMENTS_MAX", 3)
        for n in range(1, 5):
            _z(w, n)
        with pytest.raises(HTTPException) as e:
            _docs(w, shop_id=w.shop.id, from_number=1)
        assert e.value.status_code == 400
        assert "too_many_z_reports" in e.value.detail
        assert len(_docs(w, shop_id=w.shop.id, from_number=2)["items"]) == 3

    def test_the_cap_on_ids(self, w):
        ids = ",".join(str(uuid.uuid4()) for _ in range(zr_router.PRINT_DOCUMENTS_MAX + 1))
        with pytest.raises(HTTPException) as e:
            _docs(w, ids=ids)
        assert e.value.status_code == 400

    def test_the_cap_is_200(self):
        assert zr_router.PRINT_DOCUMENTS_MAX == 200


# ── Till endpoints ────────────────────────────────────────────────────────────


def _till_list(w, till, limit=20, offset=0):
    return sync_router.list_own_shop_z_reports(str(till.id), limit=limit, offset=offset, machine=till, db=w.db)


class TestTill:
    def test_its_shops_zs_newest_first(self, w):
        for n in range(1, 6):
            _z(w, n)
        _z(w, 9, shop=w.other_shop)
        out = _till_list(w, w.tills[0])
        assert out["total"] == 5
        assert [i["number"] for i in out["items"]] == [5, 4, 3, 2, 1]
        first = out["items"][0]
        assert set(first) >= {"id", "number", "businessDate", "productionDate", "totalSales", "shiftCount", "machineCount"}
        assert first["totalSales"] == "₪1,200.00"
        assert first["businessDate"] == "2026-09-27"

    def test_paging(self, w):
        for n in range(1, 6):
            _z(w, n)
        out = _till_list(w, w.tills[1], limit=2, offset=2)
        assert out["total"] == 5
        assert [i["number"] for i in out["items"]] == [3, 2]

    def test_production_date_is_local(self, w):
        # 21:30 UTC on the 26th is 00:30 on the 27th in Israel.
        _z(w, 1, business=date(2026, 9, 26), closed=datetime(2026, 9, 26, 21, 30, tzinfo=timezone.utc))
        item = _till_list(w, w.tills[0])["items"][0]
        assert (item["businessDate"], item["productionDate"]) == ("2026-09-26", "2026-09-27")

    def test_print_document_of_its_shop(self, w):
        z = _z(w, 7)
        doc = sync_router.get_own_shop_z_print_document(str(w.tills[0].id), z.id, machine=w.tills[0], db=w.db)
        assert doc["number"] == 7
        assert doc == z_print.build_print_document(z, _tz(), printed_at=None) | {"footer": doc["footer"]}

    def test_another_shops_z_is_404(self, w):
        theirs = _z(w, 1, shop=w.other_shop)
        with pytest.raises(HTTPException) as e:
            sync_router.get_own_shop_z_print_document(str(w.tills[0].id), theirs.id, machine=w.tills[0], db=w.db)
        assert e.value.status_code == 404

    def test_an_unassigned_till_is_refused(self, w):
        till = w.tills[0]
        till.shop_id = None
        with pytest.raises(HTTPException) as e:
            _till_list(w, till)
        assert e.value.status_code == 400


def test_routes_are_mounted():
    from app.main import app

    mounted = {(m, r.path) for r in app.routes for m in (getattr(r, "methods", None) or ())}
    assert {
        ("GET", "/api/v1/z-reports/{z_report_id}/print-document"),
        ("GET", "/api/v1/z-reports/print-documents"),
        ("GET", "/api/v1/sync/{machine_id}/z-reports"),
        ("GET", "/api/v1/sync/{machine_id}/z-reports/{z_report_id}/print-document"),
    } <= mounted
    paths = [r.path for r in app.routes]
    # Before `/{z_report_id}`, or the id route would answer it with a 422.
    assert paths.index("/api/v1/z-reports/print-documents") < paths.index("/api/v1/z-reports/{z_report_id}")


# ── "טיפ באשראי משולם מהמזומן": two rows at the bottom of the drawer, only with the figure ──


def _labels(doc, title):
    for s in doc["sections"]:
        if s["title"] == title:
            return [r["label"] for r in s["rows"]]
    return None


TIPS_LABEL = z_print.CARD_TIPS_FROM_DRAWER_LABEL
DRAWER_LABEL = z_print.DRAWER_CASH_LABEL


def _with_drawer_tips(w, seq=12, **extra):
    section = _section(w.tills[0], expectedCash="40.00", cardTipsFromDrawer="10.00", drawerCash="40.00")
    header = {"businessName": "Acme Ltd", "shopName": "Center", "cardTipsFromDrawer": "10.00", "drawerCash": "40.00"}
    return _z(w, seq, per_machine=[section], header=header, expected_cash=Decimal("40.00"), **extra)


class TestCardTipsPaidFromTheDrawer:
    def test_nothing_new_without_the_figure(self, w):
        z = _z(w, 12)
        for doc in (
            z_print.build_print_document(z, _tz()),
            z_print.build_summary_document(z, _tz()),
            z_print.build_till_document(z, w.tills[0].id, _tz()),
        ):
            for s in doc["sections"]:
                labels = [r["label"] for r in s["rows"]]
                assert TIPS_LABEL not in labels and DRAWER_LABEL not in labels, s["title"]
        assert z_print.drawer_tips_of(z) is None

    def test_the_z_the_summary_and_the_till_print_them_at_the_bottom(self, w):
        z = _with_drawer_tips(w)
        for doc in (z_print.build_print_document(z, _tz()), z_print.build_summary_document(z, _tz())):
            assert _labels(doc, "קופה")[-2:] == [TIPS_LABEL, DRAWER_LABEL]
            cash = _rows(doc, "קופה")
            assert (cash[TIPS_LABEL], cash[DRAWER_LABEL]) == ("₪10.00", "₪40.00")
            assert cash["מזומן צפוי"] == "₪40.00"
        till = _rows(z_print.build_print_document(z, _tz()), "קופה 1 · Till 1")
        assert (till[TIPS_LABEL], till[DRAWER_LABEL]) == ("₪10.00", "₪40.00")
        part = z_print.build_till_document(z, w.tills[0].id, _tz())
        assert _labels(part, "קופה")[-2:] == [TIPS_LABEL, DRAWER_LABEL]
        assert _rows(part, "קופה")[DRAWER_LABEL] == "₪40.00"

    def test_the_labels_fit_80mm(self, w):
        doc = z_print.build_print_document(_with_drawer_tips(w), _tz())
        for s in doc["sections"]:
            for r in s["rows"]:
                assert len(r["label"]) <= z_print.LABEL_MAX and not r["label"].endswith("…"), r["label"]

    def test_the_tips_themselves_are_untouched(self, w):
        tips = _rows(z_print.build_print_document(_with_drawer_tips(w), _tz()), "תשר")
        assert (tips["תשר מזומן"], tips["תשר אשראי"], tips["סה״כ תשר"]) == ("₪10.00", "₪20.00", "₪30.00")

    def test_a_z_stored_as_printed_reads_them_from_its_sections(self, w):
        # No header figure (a local shop Z kept as the main till printed it): Σ of the sections,
        # a till without the figure counted whole (its cash + cash tips).
        with_tips = _section(w.tills[0], cardTipsFromDrawer="10.00", drawerCash="40.00")
        without = _section(w.tills[1], cashSalesNet="25.00", totalCashTips="5.00")
        z = _z(w, 12, per_machine=[with_tips, without])
        assert z_print.drawer_tips_of(z) == {"cardTipsFromDrawer": Decimal("10.00"), "drawerCash": Decimal("70.00")}
        cash = _rows(z_print.build_print_document(z, _tz()), "קופה")
        assert (cash[TIPS_LABEL], cash[DRAWER_LABEL]) == ("₪10.00", "₪70.00")
        out = zr_router.z_to_out(z).model_dump(by_alias=True, mode="json")
        assert (Decimal(out["cardTipsFromDrawer"]), Decimal(out["drawerCash"])) == (Decimal("10"), Decimal("70"))
