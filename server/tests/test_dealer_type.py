"""
"סוג עוסק" — company / licensed (עוסק מורשה) / exempt (עוסק פטור). docs/SPEC_BUSINESS_TYPE.md.

* **Setting it** — on the company, "company" by default; a change is the company
  administrators' only, recorded with who and when, and wakes the tills.
* **To the till** — `businessInfo.dealerType` and `settings.dealerType` on every pull.
* **Documents** — an exempt dealer's receipt (400) and receipt refund (-400): the refund
  is a refund everywhere a 330 is (reports, tenders, the "refunds" filter).
* **Tax files** — the open format files both as 400 without item lines, the refund with
  negative amounts and no VAT; a company's 320/330 are unchanged.
* **Z and books** — the Z header freezes the type and prints "ללא מע״מ"; the journal books
  an exempt Z as exempt income with no VAT line.
* **The ceiling** — a platform setting; the year's turnover against it.

Runs on the in-memory SQLite world of tests/shift_world.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import func

from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.routers import companies as companies_router
from app.routers import sync as sync_router
from app.routers import system_access as system_router
from app.schemas.company import CompanyCreate, CompanyResponse, CompanyUpdate
from app.services import dealer_types as DT
from app.services import settings_notify
from app.services.accounting.journal import ZFacts, build_lines
from app.services.accounting.settings import missing_core
from app.services.open_format.tax_report_generator import (
    generate_tax_report,
    open_format_document_type,
)
from app.services.tax_reports import transform_transaction_for_open_format
from app.services.tenders import (
    is_refund_document,
    refund_condition,
    sale_condition,
)
from app.services.z_header import snapshot_header
from app.services.z_print import EXEMPT_NO_VAT, _subtitle, _vat_rows
from shift_world import NOW, accept_str_uuids, make_world

D = Decimal

ADMIN = SimpleNamespace(role=UserRole.SUPER_ADMIN, id=uuid.uuid4(), username="admin")
SHOP_MANAGER = SimpleNamespace(role=UserRole.SHOP_MANAGER, id=uuid.uuid4(), username="shop")
COMPANY_MANAGER = SimpleNamespace(role=UserRole.COMPANY_MANAGER, id=uuid.uuid4(), username="dana")

BUSINESS = {
    "vatNumber": "034567891",
    "companyName": "קפה דנה",
    "companyAddress": "הרצל",
    "companyAddressNumber": "1",
    "companyCity": "חיפה",
    "companyZip": "",
    "companyRegNumber": "",
    "withholdingFileNumber": "000000000",
    "hasBranches": False,
}


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.woken = []
    monkeypatch.setattr(
        companies_router,
        "notify_machines_for_company_settings",
        lambda _db, company_id, reason: world.woken.append((company_id, reason)),
    )
    monkeypatch.setattr(companies_router, "notify_machines_for_shop", lambda *a, **k: None)
    monkeypatch.setattr(settings_notify, "notify_machine_settings", lambda *a, **k: None)
    monkeypatch.setattr(companies_router, "user_covers_company", lambda *a, **k: True)
    return world


def _user(w, role) -> User:
    u = User(
        id=uuid.uuid4(), role=role, tenant_id=w.tenant.id, company_id=w.company.id,
        email=f"{uuid.uuid4().hex[:6]}@x", username=uuid.uuid4().hex[:8],
    )
    w.db.add(u)
    w.db.flush()
    return u


def _doc(w, document_type, total, *, net=None, vat=None, refund_of=None, number=None, created_at=NOW):
    till = w.tills[0]
    tx = Transaction(
        id=uuid.uuid4(),
        tenant_id=till.tenant_id,
        machine_id=till.id,
        shop_id=till.shop_id,
        transaction_number=number or uuid.uuid4().hex[:6],
        status=TransactionStatus.COMPLETED,
        document_type=document_type,
        payment_method="cash",
        total_amount=D(total),
        document_discount=D("0"),
        net_amount=D(net) if net is not None else None,
        vat_amount=D(vat) if vat is not None else None,
        vat_rate=D("0") if vat == "0" else (D("0.18") if vat is not None else None),
        refund_of_transaction_id=refund_of,
        created_at=created_at,
        updated_at=created_at,
        server_received_at=created_at,
    )
    w.db.add(tx)
    w.db.flush()
    w.db.add(
        TransactionItem(
            id=uuid.uuid4(), transaction_id=tx.id, product_name="קפה", sku="1",
            quantity=D("1"), unit_price=D(total), total_price=D(total), transaction_type=2,
        )
    )
    w.db.flush()
    w.db.refresh(tx)
    return tx


# ── Setting it ────────────────────────────────────────────────────────────────


class TestApply:
    def test_a_new_company_is_a_company_unless_told_otherwise(self, w):
        c = SimpleNamespace(dealer_type=None, dealer_type_history=None)
        DT.apply_dealer_type(ADMIN, c, {}, creating=True)
        assert c.dealer_type == "company" and c.dealer_type_history == []
        DT.apply_dealer_type(ADMIN, c, {"dealer_type": "exempt"}, creating=True)
        assert c.dealer_type == "exempt"

    def test_an_unknown_type_is_refused(self, w):
        with pytest.raises(HTTPException) as refused:
            DT.apply_dealer_type(ADMIN, w.company, {"dealer_type": "partnership"})
        assert refused.value.status_code == 422

    def test_a_shop_manager_may_not_change_it_but_may_send_it_back_unchanged(self, w):
        with pytest.raises(HTTPException) as refused:
            DT.apply_dealer_type(SHOP_MANAGER, w.company, {"dealer_type": "exempt"})
        assert refused.value.detail == "dealer_type_forbidden"
        updates = {"name": "x", "dealer_type": "company"}
        assert DT.apply_dealer_type(SHOP_MANAGER, w.company, updates) is False
        assert updates == {"name": "x"}

    def test_a_change_records_who_and_when_and_keeps_every_change(self, w):
        at = datetime(2026, 10, 6, 9, 0, tzinfo=timezone.utc)
        assert DT.apply_dealer_type(COMPANY_MANAGER, w.company, {"dealer_type": "exempt"}, now=at)
        assert DT.apply_dealer_type(COMPANY_MANAGER, w.company, {"dealer_type": "licensed"}, now=at)
        assert w.company.dealer_type == "licensed"
        assert w.company.dealer_type_changed_at == at
        assert w.company.dealer_type_changed_by == COMPANY_MANAGER.id
        assert [(h["from"], h["to"], h["byName"]) for h in w.company.dealer_type_history] == [
            ("company", "exempt", "dana"),
            ("exempt", "licensed", "dana"),
        ]

    def test_the_labels(self):
        assert [DT.reg_label(t) for t in ("company", "licensed", "exempt", None)] == [
            "ח.פ.", "עוסק מורשה", "עוסק פטור", "ח.פ.",
        ]


class TestRoutes:
    def test_create_with_a_type_and_without(self, w, monkeypatch):
        monkeypatch.setattr(companies_router, "invalidate_company_hierarchy_cache", lambda db: None)
        # The general item's SKU query is Postgres-only (a regex); not what is tested here.
        monkeypatch.setattr(companies_router, "ensure_general_item", lambda db, company: None)
        admin = _user(w, UserRole.SUPER_ADMIN)
        plain = companies_router.create_company(
            CompanyCreate(name="רגילה"), admin, w.tenant.id, w.db
        )
        exempt = companies_router.create_company(
            CompanyCreate(name="דנה", vatNumber="034567891", dealerType="exempt"), admin, w.tenant.id, w.db
        )
        assert CompanyResponse.model_validate(plain).dealer_type == "company"
        out = CompanyResponse.model_validate(exempt).model_dump(by_alias=True)
        assert out["dealerType"] == "exempt" and out["dealerTypeHistory"] == []

    def test_a_change_wakes_the_tills_and_is_returned_with_its_history(self, w, monkeypatch):
        monkeypatch.setattr(companies_router, "invalidate_company_hierarchy_cache", lambda db: None)
        manager = _user(w, UserRole.COMPANY_MANAGER)
        out = companies_router.update_company(
            str(w.company.id), CompanyUpdate(dealerType="exempt"), manager, w.tenant.id, w.db
        )
        body = CompanyResponse.model_validate(out).model_dump(by_alias=True)
        assert body["dealerType"] == "exempt"
        assert body["dealerTypeChangedBy"] == manager.id
        assert body["dealerTypeHistory"][0]["to"] == "exempt"
        assert w.woken == [(str(w.company.id), "company_profile_updated")]

    def test_a_shop_manager_is_refused(self, w, monkeypatch):
        monkeypatch.setattr(companies_router, "invalidate_company_hierarchy_cache", lambda db: None)
        manager = _user(w, UserRole.SHOP_MANAGER)
        with pytest.raises(HTTPException) as refused:
            companies_router.update_company(
                str(w.company.id), CompanyUpdate(dealerType="exempt"), manager, w.tenant.id, w.db
            )
        assert refused.value.status_code == 403
        assert w.company.dealer_type == "company"


# ── To the till ───────────────────────────────────────────────────────────────


class TestSync:
    def _pull(self, w):
        till = w.tills[0]
        return sync_router.get_settings_sync(machine_id=str(till.id), since=None, machine=till, db=w.db)

    def test_existing_companies_stay_companies(self, w):
        pulled = self._pull(w)
        assert pulled.settings["dealerType"] == "company"
        assert pulled.business_info.dealer_type == "company"

    def test_an_exempt_dealer_reaches_the_till(self, w):
        w.company.dealer_type = "exempt"
        w.db.flush()
        pulled = self._pull(w)
        assert pulled.settings["dealerType"] == "exempt"
        assert pulled.model_dump(by_alias=True)["businessInfo"]["dealerType"] == "exempt"


# ── Documents ─────────────────────────────────────────────────────────────────


class TestRefundDetection:
    def test_a_receipt_refund_is_a_refund_and_a_receipt_is_a_sale(self, w):
        assert is_refund_document(document_type=-400, refund_of_transaction_id=None)
        assert not is_refund_document(document_type=400, refund_of_transaction_id=None)
        sale = _doc(w, 400, "50.00", net="50.00", vat="0")
        back = _doc(w, -400, "20.00", net="20.00", vat="0")
        refunds = {t.id for t in w.db.query(Transaction).filter(refund_condition()).all()}
        sales = {t.id for t in w.db.query(Transaction).filter(sale_condition()).all()}
        assert back.id in refunds and back.id not in sales
        assert sale.id in sales and sale.id not in refunds


# ── Tax files ─────────────────────────────────────────────────────────────────


def _records(result, kind):
    return [line for line in result.bkmv_content if line.startswith(kind)]


class TestOpenFormat:
    def test_the_mapping(self):
        assert open_format_document_type(400, False) == (400, 1)
        assert open_format_document_type(-400, True) == (400, -1)
        assert open_format_document_type(320, False) == (320, 1)
        assert open_format_document_type(330, True) == (330, 1)
        assert open_format_document_type(None, True) == (330, 1)

    def test_an_exempt_dealers_receipts_are_400_without_lines_or_vat(self, w):
        sale = _doc(w, 400, "50.00", net="50.00", vat="0", number="7")
        back = _doc(w, -400, "20.00", net="20.00", vat="0", number="8", refund_of=sale.id)
        result = generate_tax_report(
            [transform_transaction_for_open_format(t, 18.0) for t in (sale, back)],
            BUSINESS, {"year": 2026}, global_tax_rate=18.0,
        )
        c100 = _records(result, "C100")
        assert [line[22:25] for line in c100] == ["400", "400"]
        assert _records(result, "D110") == [] and _records(result, "M100") == []
        # 1221 (net), 1222 (VAT) and 1223 (total), each a signed 15-character amount.
        def money(line, index):
            start = 4 + 9 + 9 + 3 + 20 + 8 + 4 + 50 + 50 + 10 + 30 + 8 + 30 + 2 + 15 + 9 + 8 + 15 + 3
            return line[start + 15 * index : start + 15 * (index + 1)]
        assert [money(c100[0], i) for i in (2, 3, 4)] == [
            "+00000000005000", "+00000000000000", "+00000000005000",
        ]
        assert [money(c100[1], i) for i in (2, 3, 4)] == [
            "-00000000002000", "+00000000000000", "-00000000002000",
        ]
        d120 = _records(result, "D120")
        assert len(d120) == 2
        assert "+00000000005000" in d120[0] and "-00000000002000" in d120[1]

    def test_a_companys_documents_are_unchanged(self, w):
        sale = _doc(w, 320, "118.00", net="100.00", vat="18.00")
        result = generate_tax_report(
            [transform_transaction_for_open_format(sale, 18.0)], BUSINESS, {"year": 2026}, global_tax_rate=18.0,
        )
        assert [line[22:25] for line in _records(result, "C100")] == ["320"]
        assert len(_records(result, "D110")) == 1 and len(_records(result, "M100")) == 1


# ── Z and books ───────────────────────────────────────────────────────────────


class TestZ:
    def test_the_header_freezes_the_type(self, w):
        w.company.dealer_type = "exempt"
        w.db.flush()
        assert snapshot_header(w.db, w.shop)["dealerType"] == "exempt"

    def test_an_exempt_z_prints_no_vat_split(self):
        z = SimpleNamespace(vat_total=D("0"), total_sales=D("100"), total_refunds=D("0"),
                            header={"dealerType": "exempt"})
        assert [r["value"] for r in _vat_rows(z)] == [EXEMPT_NO_VAT]

    def test_a_z_of_the_day_the_type_changed_still_splits_its_vat(self):
        z = SimpleNamespace(vat_total=D("18"), total_sales=D("118"), total_refunds=D("0"),
                            header={"dealerType": "exempt"})
        assert len(_vat_rows(z)) == 3

    def test_the_subtitle_names_the_type(self):
        def z(dealer):
            return SimpleNamespace(
                header={"vatNumber": "034567891", "dealerType": dealer, "shopName": "מרכז"},
                shop=None, area_id=None, per_machine=[], machine_id=None, machine=None,
                business_date=datetime(2026, 10, 6).date(), closed_at=NOW,
            )
        assert _subtitle(z("exempt"), timezone.utc)[0] == "עוסק פטור 034567891"
        assert _subtitle(z("licensed"), timezone.utc)[0] == "עוסק מורשה 034567891"
        assert _subtitle(z(None), timezone.utc)[0] == "ח.פ. 034567891"


class TestJournal:
    ACCOUNTS = {"cash": "1001", "card": "1200", "incomeExempt": "4100", "incomeTaxable": "4000",
                "vatOutput": "2400"}

    def test_an_exempt_z_is_exempt_income_with_no_vat_line(self):
        facts = ZFacts(
            z_id=uuid.uuid4(), z_number=3, business_date=datetime(2026, 10, 6).date(), shop_id=None,
            shop_name="מרכז", breakdown={"cash": D("80.00"), "card": D("20.00")}, vat_total=D("0"),
            net=D("100.00"), income_by_rate={D("0"): (D("100.00"), D("0"))},
        )
        lines, problems = build_lines(facts, {"movementType": "ZZ1", "accounts": self.ACCOUNTS})
        assert problems == []
        assert [(l.side, l.key, l.amount) for l in lines] == [
            ("D", "cash", D("80.00")), ("D", "card", D("20.00")), ("C", "incomeExempt", D("100.00")),
        ]

    def test_an_exempt_dealer_needs_no_vat_account(self):
        effective = {"movementType": "ZZ1", "accounts": {"cash": "1", "card": "2", "incomeExempt": "3"}}
        assert missing_core(effective, "exempt") == []
        assert missing_core(effective, "company") == ["accounts.incomeTaxable", "accounts.vatOutput"]


# ── The ceiling ───────────────────────────────────────────────────────────────


class TestTurnover:
    def test_unset_by_default_and_only_the_super_admin_sets_it(self, w):
        assert DT.get_settings(w.db) == {"exemptTurnoverThreshold": None, "warnRatio": 0.8}
        body = system_router.DealerTypesIn(exemptTurnoverThreshold=100, warnRatio=0.75)
        with pytest.raises(HTTPException):
            system_router.put_dealer_types(body, _user(w, UserRole.DISTRIBUTOR), w.db)
        out = system_router.put_dealer_types(body, _user(w, UserRole.SUPER_ADMIN), w.db)
        assert out == {"exemptTurnoverThreshold": 100.0, "warnRatio": 0.75}

    def test_the_years_turnover_nets_refunds_and_takes_vat_out(self, w):
        _doc(w, 400, "50.00", net="50.00", vat="0")
        _doc(w, -400, "20.00", net="20.00", vat="0")
        _doc(w, 320, "118.00", net="100.00", vat="18.00")
        _doc(w, 400, "999.00", net="999.00", vat="0", created_at=datetime(2025, 6, 1, tzinfo=timezone.utc))
        assert DT.year_turnover(w.db, w.company, 2026) == D("130.00")

    def test_the_status(self, w):
        w.company.dealer_type = "exempt"
        _doc(w, 400, "85.00", net="85.00", vat="0")
        assert DT.turnover_status(w.db, w.company, 2026)["status"] == "none"  # no ceiling set
        DT.set_settings(w.db, w.admin, {"exemptTurnoverThreshold": 100, "warnRatio": 0.8})
        assert DT.turnover_status(w.db, w.company, 2026)["status"] == "approaching"
        _doc(w, 400, "20.00", net="20.00", vat="0")
        status = DT.turnover_status(w.db, w.company, 2026)
        assert (status["status"], status["turnover"]) == ("exceeded", D("105.00"))
        w.company.dealer_type = "licensed"
        assert DT.turnover_status(w.db, w.company, 2026)["status"] == "none"
        assert DT.turnover_state(D("10"), 100.0, 0.8, True) == "ok"

    def test_the_route(self, w):
        w.company.dealer_type = "exempt"
        _doc(w, 400, "40.00", net="40.00", vat="0")
        out = companies_router.get_dealer_turnover(
            str(w.company.id), 2026, _user(w, UserRole.COMPANY_MANAGER), w.tenant.id, w.db
        )
        assert (out["dealerType"], out["turnover"], out["status"]) == ("exempt", 40.0, "none")
        # The count query used the world's documents only.
        assert w.db.query(func.count(Transaction.id)).scalar() == 1


# ── Reprints from the cloud ───────────────────────────────────────────────────


class TestReprint:
    def _print(self, w, tx):
        from app.routers.transactions import get_print_document

        return get_print_document(
            transaction_id=tx.id, kind="invoice", payment_id=None,
            current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )

    def test_an_exempt_receipt_is_titled_as_one_with_no_vat(self, w):
        w.company.dealer_type = "exempt"
        sale = _doc(w, 400, "50.00", net="50.00", vat="0")
        doc = self._print(w, sale)
        assert doc.title.startswith("קבלה ")
        assert any(line.startswith("עוסק פטור 515151515") for line in doc.subtitle)
        labels = {r.label for s in doc.sections for r in s.rows}
        assert not any("מע" in label for label in labels)

    def test_a_receipt_refund_and_a_licensed_dealers_invoice(self, w):
        refund = _doc(w, -400, "20.00", net="20.00", vat="0")
        assert self._print(w, refund).title.startswith("קבלה – החזר כספי")
        w.company.dealer_type = "licensed"
        sale = _doc(w, 320, "118.00", net="100.00", vat="18.00")
        doc = self._print(w, sale)
        assert any(line.startswith("עוסק מורשה 515151515") for line in doc.subtitle)
        assert 'מע"מ 18%' in {r.label for s in doc.sections for r in s.rows}
