"""
Prepaid vouchers ("שוברי הפקה") — production (docs/SPEC_VOUCHER_PRODUCTION.md).

What each class pins:

* **Groups** — a run is split into groups when it is made (1000 in tens = groups 1..100 of
  10; 1005 in tens = 100 of 10 and 1 of 5; any size); the group is fixed per voucher, more
  vouchers start a new group, an ungrouped batch can be grouped once.
* **Files** — production in groups is a ZIP with one PDF per group (1000 / 10 = 100 files,
  each of 10, each opened by its cover sheet) and the CSV manifest; without groups it is
  one file, exactly as before.
* **The code under the barcode** — a per-batch setting (off by default), editable later,
  logged; it changes what is printed under the barcode and nothing else.
* **Group cancel** — one action cancels a group's open vouchers (used ones stay used), a
  till refuses them, it is logged with who and why, and a second call changes nothing.
* **Code 128** — the line barcode is the standard subset B, pinned by the same expected
  widths as the dashboard's copy (client/src/lib/barcode128.test.ts).

Runs on the in-memory SQLite world of tests/shift_world.py (fixtures of test_prepaid_vouchers).
"""
from __future__ import annotations

import csv
import io
import uuid
import zipfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherEvent
from app.routers import prepaid_vouchers as R
from app.schemas.prepaid_voucher import (
    PrepaidVoucherAddIn,
    PrepaidVoucherBatchCreate,
    PrepaidVoucherBatchUpdate,
    PrepaidVoucherCancelIn,
    PrepaidVoucherGroupsIn,
)
from app.services import barcode128
from app.services import prepaid_voucher_pdf as PDF
from app.services import prepaid_vouchers as PV
from test_prepaid_vouchers import _ctx, lookup, redeem, refused, w  # noqa: F401 — `w` is the fixture

#: The dashboard's barcode128.test.ts pins the very same string.
GOLDEN_TEXT = "PV:ABCDEFGH23456789"
GOLDEN_WIDTHS = (
    "2112143131213111233212211113231311231313211123131321131323112113132311132232112211322212312132122231"
    "123121313112223211223211222331112"
)


def make(w, *, count, group_size=None, split=False, show_code=False, barcode="qr", **extra):
    body = PrepaidVoucherBatchCreate(
        name="הפקה — מזון",
        companyId=w.company.id,
        eventName="פסטיבל הקיץ",
        splitAllowed=split,
        items=[{"productId": w.hotdog.id, "quantity": 1}, {"productId": w.drink.id, "quantity": 2}],
        count=count,
        groupSize=group_size,
        showCode=show_code,
        barcodeType=barcode,
        **extra,
    )
    return R.create_prepaid_voucher_batch(body, **_ctx(w))


def rows(w, batch, **kw):
    return R.list_prepaid_vouchers(
        batch["id"], status_filter=None, serial=None, limit=5000, offset=0,
        group=kw.get("group"), code=kw.get("code"), **_ctx(w),
    )["items"]


def file(w, batch, fmt, **kw):
    return R.prepaid_vouchers_file(
        batch["id"], fmt=fmt, layout=kw.get("layout", "ticket80x50"), width=None, height=None,
        voucher_id=kw.get("voucher_id"), include_used=kw.get("include_used", True),
        group=kw.get("group"), covers=kw.get("covers", True), **_ctx(w),
    )


@pytest.fixture
def stub_render(monkeypatch):
    """PDF drawing replaced by a record of what each file would hold (1000 real pages is slow)."""
    calls = []

    def fake(batch, vouchers, g, *, logo=None, labels=None, opts=None, cover=None, made=None):
        calls.append({"serials": [v.serial for v in vouchers], "cover": cover, "opts": opts})
        return b"%PDF-stub-" + str(len(vouchers)).encode()

    monkeypatch.setattr(PDF, "render_pdf", fake)
    return calls


def zip_names(resp) -> list:
    return zipfile.ZipFile(io.BytesIO(resp.body)).namelist()


# ── Groups ────────────────────────────────────────────────────────────────────


class TestGroupPlan:
    def test_a_thousand_in_tens_is_a_hundred_groups_of_ten(self):
        plan = PV.group_plan(1000, 10)
        assert len(plan) == 100
        assert {g["count"] for g in plan} == {10}
        assert [plan[0]["group"], plan[-1]["group"]] == [1, 100]
        assert plan[-1]["offset"] == 990

    def test_the_last_group_holds_what_is_left(self):
        plan = PV.group_plan(1005, 10)
        assert len(plan) == 101
        assert [g["count"] for g in plan[:100]] == [10] * 100
        assert plan[-1] == {"group": 101, "offset": 1000, "count": 5}

    def test_any_size_and_a_starting_number(self):
        assert [g["count"] for g in PV.group_plan(20, 7)] == [7, 7, 6]
        assert [g["group"] for g in PV.group_plan(20, 7, first_group=4)] == [4, 5, 6]
        assert [g["count"] for g in PV.group_plan(20, 20)] == [20]
        assert [g["count"] for g in PV.group_plan(5, 20)] == [5]

    def test_no_size_is_no_groups(self):
        assert PV.group_plan(1000, None) == [] and PV.group_plan(1000, 0) == []


class TestGroups:
    def test_a_run_is_issued_in_groups(self, w):
        batch = make(w, count=1005, group_size=10)
        assert (batch["groupSize"], batch["groupCount"], batch["stats"]["total"]) == (10, 101, 1005)
        vs = rows(w, batch)
        assert [v["groupNo"] for v in vs[:11]] == [1] * 10 + [2]
        assert [v["serial"] for v in vs if v["groupNo"] == 101] == [1001, 1002, 1003, 1004, 1005]
        report = R.prepaid_voucher_groups(batch["id"], **_ctx(w))["items"]
        assert len(report) == 101
        assert (report[0]["fromSerial"], report[0]["toSerial"], report[0]["total"]) == (1, 10, 10)
        assert (report[-1]["group"], report[-1]["total"]) == (101, 5)

    def test_without_a_size_nothing_is_grouped(self, w):
        batch = make(w, count=12)
        assert batch["groupSize"] is None and batch["groupCount"] == 0
        assert {v["groupNo"] for v in rows(w, batch)} == {None}

    def test_more_vouchers_start_a_new_group(self, w):
        batch = make(w, count=15, group_size=10)
        out = R.add_prepaid_vouchers(batch["id"], PrepaidVoucherAddIn(count=10), **_ctx(w))
        assert out["groupCount"] == 3
        by_group = {}
        for v in rows(w, batch):
            by_group.setdefault(v["groupNo"], []).append(v["serial"])
        # Group 2 (5 vouchers, already packed) is never topped up.
        assert by_group == {1: list(range(1, 11)), 2: list(range(11, 16)), 3: list(range(16, 26))}
        out = R.add_prepaid_vouchers(batch["id"], PrepaidVoucherAddIn(count=4, groupSize=2), **_ctx(w))
        assert out["groupCount"] == 5

    def test_an_ungrouped_batch_is_grouped_once(self, w):
        batch = make(w, count=25)
        out = R.assign_prepaid_voucher_groups(batch["id"], PrepaidVoucherGroupsIn(groupSize=10), **_ctx(w))
        assert (out["groupSize"], out["groupCount"]) == (10, 3)
        assert [r["total"] for r in R.prepaid_voucher_groups(batch["id"], **_ctx(w))["items"]] == [10, 10, 5]
        e = refused(R.assign_prepaid_voucher_groups, batch["id"], PrepaidVoucherGroupsIn(groupSize=5), **_ctx(w))
        assert (e.status_code, e.detail) == (409, PV.ALREADY_GROUPED)

    def test_the_voucher_list_by_group_and_by_code(self, w):
        batch = make(w, count=30, group_size=10)
        assert [v["serial"] for v in rows(w, batch, group=2)] == list(range(11, 21))
        target = rows(w, batch)[6]
        assert [v["serial"] for v in rows(w, batch, code=target["displayCode"].lower())] == [7]
        assert [v["serial"] for v in rows(w, batch, code="PV:" + target["code"])] == [7]
        assert 7 in [v["serial"] for v in rows(w, batch, code=target["code"][4:10])]
        assert rows(w, batch, code="AB") == []


# ── Files ─────────────────────────────────────────────────────────────────────


class TestFiles:
    def test_a_thousand_in_tens_is_a_hundred_files_of_ten(self, w, stub_render):
        batch = make(w, count=1000, group_size=10, customerName="קייטרינג אלון", orderRef="PO-77")
        resp = file(w, batch, "groups")
        names = zip_names(resp)
        pdfs = [n for n in names if n.endswith(".pdf")]
        assert len(pdfs) == 100 and len(stub_render) == 100
        assert all(len(c["serials"]) == 10 for c in stub_render)
        assert pdfs[0].endswith("_קבוצה-001-מתוך-100_שוברים-0001-0010.pdf")
        assert pdfs[-1].endswith("_קבוצה-100-מתוך-100_שוברים-0991-1000.pdf")
        covers = [c["cover"] for c in stub_render]
        assert [(c.group, c.groups, c.low, c.high, c.count) for c in covers[:2]] == [
            (1, 100, 1, 10, 10), (2, 100, 11, 20, 10),
        ]
        # The run's manifest rides along: every code, once.
        manifest = [n for n in names if n.endswith(".csv")]
        assert len(manifest) == 1
        text = zipfile.ZipFile(io.BytesIO(resp.body)).read(manifest[0]).decode("utf-8-sig")
        assert len(list(csv.reader(io.StringIO(text)))) == 1001
        assert resp.media_type == "application/zip"

    def test_an_uneven_run_ends_with_a_smaller_file(self, w, stub_render):
        batch = make(w, count=1005, group_size=10)
        pdfs = [n for n in zip_names(file(w, batch, "groups")) if n.endswith(".pdf")]
        assert len(pdfs) == 101
        assert [len(c["serials"]) for c in stub_render] == [10] * 100 + [5]
        assert stub_render[-1]["cover"].groups == 101 and stub_render[-1]["cover"].count == 5

    def test_a_custom_size(self, w, stub_render):
        batch = make(w, count=25, group_size=7)
        pdfs = [n for n in zip_names(file(w, batch, "groups")) if n.endswith(".pdf")]
        assert len(pdfs) == 4
        assert [len(c["serials"]) for c in stub_render] == [7, 7, 7, 4]

    def test_no_grouping_is_one_file_as_before(self, w, stub_render):
        batch = make(w, count=30)
        resp = file(w, batch, "pdf")
        assert resp.media_type == "application/pdf"
        assert len(stub_render) == 1 and stub_render[0]["serials"] == list(range(1, 31))
        assert stub_render[0]["cover"] is None
        e = refused(file, w, batch, "groups")
        assert (e.status_code, e.detail) == (409, PV.NOT_GROUPED)

    def test_one_group_as_one_pdf_with_its_cover(self, w, stub_render):
        batch = make(w, count=30, group_size=10)
        resp = file(w, batch, "pdf", group=3)
        assert stub_render[0]["serials"] == list(range(21, 31))
        assert (stub_render[0]["cover"].group, stub_render[0]["cover"].groups) == (3, 3)
        assert "%D7%A7%D7%91%D7%95%D7%A6%D7%94-003" in resp.headers["content-disposition"]  # "קבוצה-003"

    def test_a_cancelled_voucher_is_left_out_but_its_group_keeps_its_numbers(self, w, stub_render):
        batch = make(w, count=20, group_size=10)
        R.cancel_prepaid_voucher(rows(w, batch)[3]["id"], None, **_ctx(w))
        file(w, batch, "groups")
        first = stub_render[0]
        assert 4 not in first["serials"] and len(first["serials"]) == 9
        assert (first["cover"].low, first["cover"].high, first["cover"].count, first["cover"].issued) == (1, 10, 9, 10)

    def test_the_real_files_are_pdfs_and_the_manifest_is_complete(self, w):
        batch = make(w, count=12, group_size=5, show_code=True, barcode="code128",
                     customerName="קייטרינג אלון", orderRef="PO-77",
                     validUntil=datetime(2026, 8, 14, 20, 59, 59, tzinfo=timezone.utc))
        z = zipfile.ZipFile(io.BytesIO(file(w, batch, "groups").body))
        pdfs = [n for n in z.namelist() if n.endswith(".pdf")]
        assert len(pdfs) == 3
        assert all(z.read(n).startswith(b"%PDF") for n in pdfs)
        resp = file(w, batch, "csv")
        assert resp.body.startswith("﻿".encode("utf-8"))
        table = list(csv.reader(io.StringIO(resp.body.decode("utf-8-sig"))))
        assert table[0][:5] == ["מס׳ שובר", "קבוצה", "קוד", "קוד מודפס", "תוכן הברקוד"]
        assert len(table) == 13
        first = rows(w, batch)[0]
        assert table[1][:5] == ["1", "1", first["code"], first["displayCode"], "PV:" + first["code"]]
        assert table[1][5] == "פעיל" and table[1][7:9] == ["קייטרינג אלון", "PO-77"]


# ── The code under the barcode ────────────────────────────────────────────────


class TestCodeUnderBarcode:
    def test_off_by_default_and_set_per_batch(self, w):
        assert make(w, count=1)["showCode"] is False
        batch = make(w, count=1, show_code=True)
        assert batch["showCode"] is True and batch["barcodeType"] == "qr"

    def test_what_is_printed_under_the_barcode(self, w):
        batch = make(w, count=12, group_size=10)
        v = PrepaidVoucher(serial=11, group_no=2, code="ABCDEFGH23456789")
        assert PDF.under_barcode_lines(v, PDF.PrintOptions(show_code=False)) == ["מס׳ 0011 · קבוצה 2"]
        assert PDF.under_barcode_lines(v, PDF.PrintOptions(show_code=True)) == [
            "ABCD-EFGH-2345-6789", "מס׳ 0011 · קבוצה 2",
        ]
        plain = PrepaidVoucher(serial=3, group_no=None, code="ABCDEFGH23456789")
        assert PDF.under_barcode_lines(plain, PDF.PrintOptions()) == ["מס׳ 0003"]
        assert batch["groupSize"] == 10

    def test_it_reaches_the_paper(self, w):
        batch_row = make(w, count=1)
        from app.models.prepaid_voucher import PrepaidVoucherBatch

        b = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(batch_row["id"])).one()
        v = b.vouchers[0]
        g = PDF.geometry("ticket80x50")
        without = PDF._draw_card(b, v, g.card_w, g.card_h, None, PDF.Labels(), False, PDF.PrintOptions(show_code=False))
        with_code = PDF._draw_card(b, v, g.card_w, g.card_h, None, PDF.Labels(), False, PDF.PrintOptions(show_code=True))
        assert without.size == with_code.size and without.tobytes() != with_code.tobytes()
        line = PDF._draw_card(b, v, g.card_w, g.card_h, None, PDF.Labels(), False,
                              PDF.PrintOptions(barcode_type="code128", show_code=True))
        assert line.tobytes() != with_code.tobytes()

    def test_changed_later_and_logged(self, w):
        batch = make(w, count=2)
        out = R.update_prepaid_voucher_batch(
            batch["id"], PrepaidVoucherBatchUpdate(showCode=True, barcodeType="code128", orderRef="PO-9"), **_ctx(w)
        )
        assert (out["showCode"], out["barcodeType"], out["orderRef"]) == (True, "code128", "PO-9")
        events = R.prepaid_voucher_events(batch["id"], **_ctx(w))["items"]
        assert events[0]["action"] == "update"
        assert events[0]["details"]["fields"] == ["barcode_type", "order_ref", "show_code"]
        # A null never clears a print setting.
        out = R.update_prepaid_voucher_batch(batch["id"], PrepaidVoucherBatchUpdate(showCode=None), **_ctx(w))
        assert out["showCode"] is True

    def test_only_known_barcode_types(self, w):
        with pytest.raises(ValueError):
            PrepaidVoucherBatchCreate(
                name="x", companyId=w.company.id, items=[{"productId": w.hotdog.id, "quantity": 1}],
                count=1, barcodeType="ean13",
            )


# ── Group cancel ──────────────────────────────────────────────────────────────


class TestGroupCancel:
    def test_a_lost_envelope_is_cancelled_in_one_action(self, w):
        batch = make(w, count=30, group_size=10, split=True)
        vs = rows(w, batch)
        redeem(w, vs[10]["code"], [(w.hotdog, 1), (w.drink, 2)])  # #11 used up
        redeem(w, vs[11]["code"], [(w.hotdog, 1)])  # #12 partly used
        out = R.cancel_prepaid_voucher_group(
            batch["id"], 2, PrepaidVoucherCancelIn(reason="המעטפה אבדה"), **_ctx(w)
        )
        assert out["cancelled"] == 9
        assert out["groupStats"]["used"] == 1 and out["groupStats"]["cancelled"] == 9
        # A till refuses them from now on; the other groups are untouched.
        assert lookup(w, vs[11]["code"])["reason"] == PV.CANCELLED
        assert lookup(w, vs[15]["code"])["reason"] == PV.CANCELLED
        assert lookup(w, vs[10]["code"])["reason"] == PV.USED
        assert lookup(w, vs[0]["code"])["redeemable"] and lookup(w, vs[20]["code"])["redeemable"]
        ev = R.prepaid_voucher_events(batch["id"], **_ctx(w))["items"][0]
        assert (ev["action"], ev["group"], ev["count"], ev["reason"], ev["userName"]) == (
            "cancel_group", 2, 9, "המעטפה אבדה", w.admin.username,
        )
        assert ev["details"]["serials"] == [12, 13, 14, 15, 16, 17, 18, 19, 20]

    def test_twice_is_once(self, w):
        batch = make(w, count=20, group_size=10)
        R.cancel_prepaid_voucher_group(batch["id"], 1, None, **_ctx(w))
        again = R.cancel_prepaid_voucher_group(batch["id"], 1, None, **_ctx(w))
        assert again["cancelled"] == 0
        assert w.db.query(PrepaidVoucherEvent).filter(PrepaidVoucherEvent.action == "cancel_group").count() == 1

    def test_an_unknown_group(self, w):
        batch = make(w, count=20, group_size=10)
        e = refused(R.cancel_prepaid_voucher_group, batch["id"], 9, None, **_ctx(w))
        assert (e.status_code, e.detail) == (404, PV.GROUP_NOT_FOUND)

    def test_a_shop_manager_of_another_shop_cannot(self, w):
        batch = make(w, count=10, group_size=5)
        e = refused(R.cancel_prepaid_voucher_group, batch["id"], 1, None, **_ctx(w, w.manager))
        assert e.status_code == 403

    def test_the_report_shows_what_came_back_per_group(self, w):
        batch = make(w, count=20, group_size=10)
        vs = rows(w, batch)
        for v in vs[:3]:
            redeem(w, v["code"], [(w.hotdog, 1), (w.drink, 2)])
        report = R.prepaid_voucher_groups(batch["id"], **_ctx(w))["items"]
        assert (report[0]["redeemed"], report[0]["used"], report[0]["active"]) == (3, 3, 7)
        assert report[1]["redeemed"] == 0

    def test_every_action_is_in_the_audit_trail(self, w):
        batch = make(w, count=10, group_size=5)
        R.add_prepaid_vouchers(batch["id"], PrepaidVoucherAddIn(count=5), **_ctx(w))
        R.cancel_prepaid_voucher(rows(w, batch)[0]["id"], PrepaidVoucherCancelIn(reason="נקרע"), **_ctx(w))
        R.cancel_prepaid_voucher_batch(batch["id"], PrepaidVoucherCancelIn(reason="האירוע בוטל"), **_ctx(w))
        actions = [e["action"] for e in R.prepaid_voucher_events(batch["id"], **_ctx(w))["items"]]
        assert sorted(actions) == ["add", "cancel_batch", "cancel_voucher", "create"]


# ── Paper details ─────────────────────────────────────────────────────────────


class TestPaper:
    def test_validity_in_the_tenants_days(self, w):
        b = PV.PrepaidVoucherBatch(valid_from=None, valid_until=datetime(2026, 8, 14, 20, 59, 59, tzinfo=timezone.utc))
        assert PDF.validity_text(b, ZoneInfo("Asia/Jerusalem")) == "בתוקף עד 14/08/2026"
        b.valid_from = datetime(2026, 8, 11, 21, 0, tzinfo=timezone.utc)
        assert PDF.validity_text(b, ZoneInfo("Asia/Jerusalem")) == "בתוקף 12/08/2026-14/08/2026"
        assert PDF.validity_text(PV.PrepaidVoucherBatch(), None) is None

    def test_the_cover_sheet_says_which_envelope(self, w):
        batch_row = make(w, count=30, group_size=10, customerName="קייטרינג אלון", orderRef="PO-77")
        from app.models.prepaid_voucher import PrepaidVoucherBatch

        b = w.db.query(PrepaidVoucherBatch).filter(PrepaidVoucherBatch.id == uuid.UUID(batch_row["id"])).one()
        info = PDF.GroupInfo(group=3, groups=100, low=21, high=30, count=10, issued=10)
        texts = [t for _, t in PDF.cover_lines(b, info, PDF.PrintOptions(validity="בתוקף עד 14/08/2026"))]
        for expected in ("קבוצה 3 מתוך 100", "שוברים 0021-0030", "10 שוברים בקבוצה", "לקוח: קייטרינג אלון",
                         "הזמנה: PO-77", "בתוקף עד 14/08/2026"):
            assert expected in texts
        assert "סה״כ בקבוצה: 10× נקניקייה, 20× שתייה" in texts


class TestCode128:
    def test_the_golden_symbol(self):
        assert barcode128.widths(GOLDEN_TEXT) == GOLDEN_WIDTHS
        # 21 symbols of 11 + the stop's 13 + quiet zones of 10 each side.
        assert barcode128.module_count(GOLDEN_TEXT) == 21 * 11 + 13 + 20

    def test_the_checksum(self):
        # PV:ABCDEFGH23456789 → (104 + Σ i·value) mod 103 = 25.
        assert barcode128.values_b(GOLDEN_TEXT)[-2] == 25

    def test_the_table(self):
        assert len(barcode128.PATTERNS) == 107 == len(set(barcode128.PATTERNS))
        assert all(sum(map(int, p)) == 11 for p in barcode128.PATTERNS[:106])
        assert sum(map(int, barcode128.PATTERNS[106])) == 13

    def test_only_printable_ascii(self):
        with pytest.raises(barcode128.Code128Error):
            barcode128.widths("שובר")
        with pytest.raises(barcode128.Code128Error):
            barcode128.widths("")
