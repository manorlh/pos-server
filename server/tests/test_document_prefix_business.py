"""
"קידומת מסמכים" is unique in the whole business (docs/SPEC_DOCUMENT_PREFIX.md §5, §9).

The Tax Authority's simulator refused the "רויאל בר" file: branch 1's and branch 2's
"קופה 1" both issued 320 #10000001, and in one business's open-format file two documents
of one type may not carry one number whatever their branch codes ("נמצאה יותר מרשומה
אחת עם אותו מס אסמכתא", C100 field 1204). So:

* the scope of the uniqueness rule is the business — every shop of the company, and of
  companies of the tenant under the same VAT number;
* a till that draws a register number already held in the business gets the lowest free
  prefix of the business (branch 2's tills 1–3 → 4–6);
* tills that already collide are listed, with a free prefix to move to, and moving one
  changes only its future documents;
* the export refuses a file with one (type, number) twice, naming the documents.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal as D

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from app.models.company import Company
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.shop import Shop
from app.models.shop_register_sequence import ShopRegisterSequence
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from app.routers import machines as machines_router
from app.routers import tax_reports as tax_router
from app.schemas.pos_machine import POSMachineUpdate
from app.services import document_prefix as DP
from app.services import tax_reports as TR
from app.services.open_format.tax_report_generator import duplicate_document_numbers
from app.services.register_number import set_machine_shop
from shift_world import accept_str_uuids, make_world

UTC = timezone.utc
NOON = datetime(2026, 9, 27, 9, 0, tzinfo=UTC)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(machines_router, "get_catalog_change_watermark_for_machine", lambda db, m: None)
    monkeypatch.setattr(machines_router, "refuse_leaving_shop_with_shifts", lambda db, m: None)
    world = make_world()
    world.shop.branch_id = "1"
    world.other_shop.branch_id = "2"
    world.db.commit()
    return world


def _till(w, shop, pos_number, name=None, *, prefix=None):
    """A till as it stands in the database, its prefix not settled (an existing row)."""
    till = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop.id, distributor_id=w.admin.id,
        name=name or f"{shop.name} {pos_number}", machine_code=f"M-{uuid.uuid4().hex[:8]}",
        pos_number=pos_number, document_prefix=prefix, is_active=True,
        pairing_status=PairingStatus.ASSIGNED,
    )
    w.db.add(till)
    w.db.flush()
    return till


def _doc(w, till, number, *, prefix, document_type=320, refund_of=None, when=NOON, total="11.80"):
    """A document of [till] as the ingest stores it: its register stamped, its prefix frozen."""
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=till.tenant_id, machine_id=till.id, shop_id=till.shop_id,
        transaction_number=number, document_prefix=prefix, pos_number=till.pos_number,
        status=TransactionStatus.COMPLETED, document_type=document_type, payment_method="cash",
        total_amount=D(total), document_discount=D("0"), net_amount=D("10.00"), vat_amount=D("1.80"),
        vat_rate=D("0.18"), refund_of_transaction_id=refund_of,
        created_at=when, updated_at=when, document_production_date=when, server_received_at=when,
    )
    w.db.add(tx)
    w.db.flush()
    w.db.add(TransactionItem(id=uuid.uuid4(), transaction_id=tx.id, product_name="קפה", sku="1",
                             quantity=D("1"), unit_price=D(total), total_price=D(total), transaction_type=2))
    w.db.add(TransactionPayment(id=uuid.uuid4(), transaction_id=tx.id, sequence=1, method="cash", amount=D(total)))
    w.db.flush()
    w.db.refresh(tx)
    return tx


def _put(w, till, **body):
    return machines_router.update_machine(
        machine_id=str(till.id), machine_data=POSMachineUpdate(**body),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


def _refused(result):
    import json

    assert isinstance(result, JSONResponse), result
    return result.status_code, json.loads(result.body)


def _conflicts(w, **kw):
    return machines_router.list_document_prefix_conflicts(
        company_id=kw.get("company_id", str(w.company.id)), shop_id=kw.get("shop_id"),
        current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )["conflicts"]


def _assign(w, till):
    return machines_router.assign_free_document_prefix(
        machine_id=str(till.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
    )


# ── The scope: the business ───────────────────────────────────────────────────────────


class TestScope:
    def test_two_branches_cannot_share_a_prefix_whatever_their_codes(self, w):
        assert (w.shop.branch_id, w.other_shop.branch_id) == ("1", "2")
        status, body = _refused(_put(w, w.other_till, documentPrefix="1"))
        assert status == 409 and body["code"] == "document_prefix_in_use"
        assert 'בסניף "Center"' in body["detail"] and "קופה 1" in body["detail"]
        assert w.other_till.document_prefix is None

    def test_going_back_to_a_default_another_branch_took_is_refused(self, w):
        _put(w, w.other_till, documentPrefix="9")
        _put(w, w.tills[0], documentPrefix="3")  # North's till 3 left 3: free now
        status, body = _refused(_put(w, w.other_till, documentPrefix=None))
        assert status == 409 and "ברירת המחדל" in body["detail"] and "Center" in body["detail"]
        assert w.other_till.document_prefix == "9"

    def test_a_prefix_on_another_branchs_documents_is_never_reused(self, w):
        _doc(w, w.other_till, "1", prefix="3")
        _put(w, w.other_till, documentPrefix="9")
        status, body = _refused(_put(w, w.tills[0], documentPrefix="3"))
        assert status == 409 and "מסמכים" in body["detail"] and 'בסניף "North"' in body["detail"]

    def test_the_scope_is_every_shop_of_the_company(self, w):
        assert set(DP.business_shop_ids(w.db, w.shop)) == {w.shop.id, w.other_shop.id}
        assert DP.business_shop_ids(w.db, w.shop)[0] == w.shop.id
        assert DP.business_shop_ids(w.db, None) == []

    def test_a_company_under_the_same_vat_number_is_the_same_business(self, w):
        twin = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Acme (שני)", vat_number=" 515151515 ")
        w.db.add(twin)
        w.db.flush()
        shop = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=twin.id, name="Twin", branch_id="1", settings={})
        w.db.add(shop)
        w.db.flush()
        till = _till(w, shop, "1")
        assert set(DP.business_shop_ids(w.db, shop)) == {shop.id, w.shop.id, w.other_shop.id}
        with pytest.raises(DP.DocumentPrefixRefused) as e:
            DP.check_prefix(w.db, till, None)
        assert e.value.status_code == 409 and 'בסניף "Center"' in e.value.detail

    def test_another_business_is_another_series(self, w):
        other = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Other", vat_number="123456782")
        w.db.add(other)
        w.db.flush()
        shop = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=other.id, name="Elsewhere", branch_id="1", settings={})
        w.db.add(shop)
        w.db.flush()
        till = _till(w, shop, "1")
        assert DP.business_shop_ids(w.db, shop) == [shop.id]
        assert DP.check_prefix(w.db, till, None) is None
        assert DP.check_prefix(w.db, till, "2") == "2"

    def test_companies_without_a_vat_number_are_not_one_business(self, w):
        a = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="A", vat_number=None)
        b = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="B", vat_number="000000000")
        w.db.add_all([a, b])
        w.db.flush()
        assert DP.business_company_ids(w.db, a) == [a.id]
        assert DP.business_company_ids(w.db, b) == [b.id]


# ── A new till's default ──────────────────────────────────────────────────────────────


def _branches(w):
    """A company like רויאל בר: two branches, each numbering its tills from 1."""
    company = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="רויאל", vat_number="123456782")
    w.db.add(company)
    w.db.flush()
    shops = []
    for code in ("1", "2"):
        shop = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=company.id, name=f"סניף {code}",
                    branch_id=code, settings={})
        w.db.add(shop)
        w.db.flush()
        w.db.add(ShopRegisterSequence(shop_id=shop.id, next_value=1))
        shops.append(shop)
    w.db.flush()
    return company, shops


def _pair(w, shop, name):
    """A new till put into [shop] the one way a till is: `set_machine_shop`."""
    till = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=None, distributor_id=w.admin.id, name=name,
        machine_code=f"M-{uuid.uuid4().hex[:8]}", is_active=True, pairing_status=PairingStatus.ASSIGNED,
    )
    w.db.add(till)
    w.db.flush()
    set_machine_shop(w.db, till, shop.id)
    w.db.flush()
    return till


class TestDefault:
    def test_the_second_branchs_tills_get_the_next_free_prefixes(self, w):
        _company, (one, two) = _branches(w)
        first = [_pair(w, one, f"קופה {i}") for i in (1, 2, 3)]
        second = [_pair(w, two, f"קופה {i}") for i in (1, 2, 3)]
        assert [t.pos_number for t in first + second] == ["1", "2", "3", "1", "2", "3"]
        assert [t.effective_document_prefix for t in first] == ["1", "2", "3"]
        assert [t.document_prefix for t in first] == [None, None, None]  # their defaults stand
        assert [t.effective_document_prefix for t in second] == ["4", "5", "6"]
        assert [t.document_prefix for t in second] == ["4", "5", "6"]  # stored as their own
        # A fourth till of branch 1: register number 4 is branch 2's till 1 now → 7.
        assert _pair(w, one, "קופה 4").effective_document_prefix == "7"

    def test_a_register_number_free_in_the_business_stays_the_prefix(self, w):
        _company, (one, two) = _branches(w)
        till = _pair(w, two, "קופה 1")
        assert (till.pos_number, till.document_prefix, till.effective_document_prefix) == ("1", None, "1")
        assert _pair(w, one, "קופה 1").effective_document_prefix == "2"

    def test_a_number_on_another_branchs_documents_is_held(self, w):
        _company, (one, two) = _branches(w)
        old = _pair(w, one, "קופה 1")
        _doc(w, old, "1", prefix="1")
        old.document_prefix = "8"  # moved on since; its documents keep 1
        w.db.flush()
        assert _pair(w, two, "קופה 1").effective_document_prefix == "2"

    def test_lowest_free_skips_every_holder(self):
        assert DP.first_free_prefix(["1", "2", "4"]) == "3"
        assert DP.first_free_prefix([]) == "1"
        assert DP.first_free_prefix([str(n) for n in range(1, 1000)]) is None


# ── Tills that already collide ────────────────────────────────────────────────────────


class TestConflicts:
    def test_two_branches_on_one_prefix_are_listed_with_a_free_prefix(self, w):
        center_one = w.tills[0]
        _doc(w, center_one, "1", prefix="1")  # the one with the documents keeps 1
        north_one = _till(w, w.other_shop, "1", "North 1")  # an existing row, never settled
        rows = _conflicts(w)
        assert [r["machineId"] for r in rows] == [str(north_one.id)]
        row = rows[0]
        assert (row["prefix"], row["ownPrefix"], row["shopName"], row["branchId"]) == ("1", False, "North", "2")
        # 1, 2 and 3 are held (Center's tills 1–2, North's till 3): the lowest free is 4.
        assert row["suggestedPrefix"] == "4"
        assert row["heldBy"][0]["kind"] == "till" and row["heldBy"][0]["machineId"] == str(center_one.id)
        assert 'בסניף "Center"' in row["heldBy"][0]["text"]

    def test_assigning_a_free_prefix_moves_it_for_its_future_documents_only(self, w):
        _doc(w, w.tills[0], "1", prefix="1")
        _doc(w, w.tills[0], "2", prefix="1")  # more documents under 1: Center keeps it
        north_one = _till(w, w.other_shop, "1", "North 1")
        issued = _doc(w, north_one, "1", prefix="1")
        out = _assign(w, north_one)
        assert out["changed"] is True and out["documentPrefix"] == "4" and out["effectiveDocumentPrefix"] == "4"
        assert out["status"]["uniqueInBusiness"] is True
        w.db.refresh(issued)
        assert issued.document_prefix == "1" and issued.document_number == "10000001"  # frozen
        # Center's till 1 is past North's numbers under 1 (its #2 > North's #1): no future
        # number of it repeats one.
        assert _conflicts(w) == []
        # And again: nothing to do.
        assert _assign(w, north_one)["changed"] is False

    def test_a_keeper_behind_the_other_tills_numbers_is_listed_too(self, w):
        center_one = w.tills[0]
        north_one = _till(w, w.other_shop, "1", "North 1")
        for n in ("1", "2", "3"):
            _doc(w, north_one, n, prefix="1")
        _doc(w, center_one, "1", prefix="1")
        _doc(w, center_one, "1", prefix="1", document_type=330)
        # North has more documents under 1: it keeps it; Center's till 1 moves …
        rows = _conflicts(w)
        assert {r["machineId"] for r in rows} == {str(center_one.id), str(north_one.id)}
        # … and North is listed as well: Center's credit note 1 is past North's 330
        # counter (none), so North's first credit note would be 10000001 again.
        north = next(r for r in rows if r["machineId"] == str(north_one.id))
        assert [(h["kind"], h["series"], h["highest"], h["ownHighest"]) for h in north["heldBy"]] == [
            ("documents", 330, 1, 0)
        ]
        assert "חשבוניות זיכוי" in north["heldBy"][0]["text"]
        _assign(w, center_one)
        assert [r["machineId"] for r in _conflicts(w)] == [str(north_one.id)]
        _assign(w, north_one)
        assert _conflicts(w) == []

    def test_a_till_that_reported_higher_counters_is_past_them(self, w):
        center_one = w.tills[0]
        north_one = _till(w, w.other_shop, "1", "North 1", prefix="9")
        _doc(w, north_one, "5", prefix="1")  # North issued under 1 before moving to 9
        assert [r["machineId"] for r in _conflicts(w)] == [str(center_one.id)]
        center_one.reported_document_counters = {"320": 7}  # issued up to 7, not all sent yet
        w.db.flush()
        assert _conflicts(w) == []

    def test_a_retired_till_is_not_listed(self, w):
        _doc(w, w.tills[0], "1", prefix="1")
        north_one = _till(w, w.other_shop, "1", "North 1")
        north_one.is_active = False
        w.db.flush()
        assert _conflicts(w) == []

    def test_by_shop_and_the_tills_status(self, w):
        _doc(w, w.tills[0], "1", prefix="1")
        north_one = _till(w, w.other_shop, "1", "North 1")
        by_shop = _conflicts(w, company_id=None, shop_id=str(w.other_shop.id))
        assert [r["machineId"] for r in by_shop] == [str(north_one.id)]
        status = machines_router.get_machine_document_prefix(
            machine_id=str(north_one.id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert status["uniqueInBusiness"] is False and status["suggestedPrefix"] == "4"
        assert status["prefix"] == "1" and status["ownPrefix"] is False and status["businessShopCount"] == 2
        fine = machines_router.get_machine_document_prefix(
            machine_id=str(w.tills[1].id), current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert fine["uniqueInBusiness"] is True and fine["heldBy"] == [] and fine["suggestedPrefix"] is None

    def test_a_scope_is_required(self, w):
        with pytest.raises(HTTPException) as e:
            _conflicts(w, company_id=None, shop_id=None)
        assert e.value.status_code == 400


# ── The export guard ──────────────────────────────────────────────────────────────────


def _export(w):
    ctx = TR.resolve_export_context(w.db, company=w.company, shop=None, mode="date-range",
                                    from_date=date(2026, 9, 27), to_date=date(2026, 9, 27))
    return TR.build_tax_open_format_export(w.db, w.tenant.id, ctx, company_id=w.company.id)


class TestExportGuard:
    def test_one_number_twice_across_branches_is_refused_by_name(self, w):
        _doc(w, w.tills[0], "1", prefix="1")
        _doc(w, w.other_till, "1", prefix="1")  # North's till 3, issued under 1
        with pytest.raises(HTTPException) as e:
            _export(w)
        assert e.value.status_code == 409
        detail = e.value.detail
        assert detail["code"] == "duplicate_document_numbers"
        assert detail["duplicates"][0]["documentType"] == 320
        assert detail["duplicates"][0]["documentNumber"] == "10000001"
        assert {h["shopName"] for h in detail["duplicates"][0]["documents"]} == {"Center", "North"}
        message = detail["message"]
        assert "320 מס׳ 10000001: Center — קופה 1; North — קופה 3" in message
        assert "נמצאה יותר מרשומה אחת עם אותו מס אסמכתא" in message
        assert "קידומת" in message and "מסמכים שכבר הופקו" in message

    def test_the_preview_refuses_as_well(self, w):
        _doc(w, w.tills[0], "1", prefix="1")
        _doc(w, w.other_till, "1", prefix="1")
        with pytest.raises(HTTPException) as e:
            tax_router.preview_tax_open_format(
                scope="company", shop_id=None, company_id=str(w.company.id), mode="date-range",
                from_date=date(2026, 9, 27), to_date=date(2026, 9, 27), year=None,
                current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
            )
        assert e.value.status_code == 409

    def test_unique_prefixes_export(self, w):
        _doc(w, w.tills[0], "1", prefix="1")
        _doc(w, w.other_till, "1", prefix="4")
        result, dicts, _zip = _export(w)
        assert sorted(d["transactionNumber"] for d in dicts) == ["10000001", "40000001"]
        assert result.record_counts["C100"] == 2

    def test_a_320_and_a_330_of_one_number_are_two_documents(self, w):
        sale = _doc(w, w.tills[0], "1", prefix="1")
        _doc(w, w.tills[0], "1", prefix="1", document_type=330, refund_of=sale.id,
             when=NOON + timedelta(minutes=5))
        result, _dicts, _zip = _export(w)
        assert result.record_counts["C100"] == 2

    def test_the_duplicates_are_by_filed_type(self):
        docs = [
            {"id": "a", "documentType": 400, "transactionNumber": "10000001"},
            {"id": "b", "documentType": -400, "transactionNumber": "10000001"},  # filed as a 400
            {"id": "c", "documentType": 320, "transactionNumber": "10000002"},
            {"id": "d", "documentType": 320, "transactionNumber": "10000002", "refundOfTransactionId": "c"},  # a 330
            {"id": "e", "documentType": 330, "transactionNumber": "10000003"},
        ]
        assert {k: [d["id"] for d in v] for k, v in duplicate_document_numbers(docs).items()} == {
            (400, "10000001"): ["a", "b"],
        }
