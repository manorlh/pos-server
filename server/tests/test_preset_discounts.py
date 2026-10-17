"""
"הנחות קבועות" — preset basket discounts (P:/specs/preset-discounts.md, app/services/preset_discounts.py).

What each class pins:

* **Golden** — the shared fixture's bytes (the same file in kiosk-desktop test/fixtures and
  pos-android app/src/test/resources) and that the server's rule reproduces every case: the
  percent / amount rounding, products that take no discount, the cap at the bill, and how a
  till reads the two settings keys.
* **Settings** — the keys ride the till's settings sync, the deepest layer wins as a whole, a
  dashboard write is validated (ids given, junk refused) and `null` resets.
* **Till design** — a `discount` button may name a preset (`presetId`), nothing else may; an
  old bar keeps its bytes; two preset buttons are no repeat.
* **Documents** — kind "preset" with the preset's columns is stored; anything else stores none;
  the document copy prints the preset's name and rate.
* **Reports** — the discounts report's `preset` kind and `presets.byPreset`; the tracking
  report's rows, totals per preset / person / cashier, and its filters.

Runs on the world of tests/test_shop_areas.py (SQLite).
"""
from __future__ import annotations

import hashlib
import json
import uuid
from decimal import Decimal
from pathlib import Path

import pytest

from app.models.pos_user import PosUser
from app.models.shift import ShiftStatus
from app.models.transaction import Transaction
from app.schemas.pos_settings import PosSettingsV1Patch
from app.services import preset_discounts as PD
from app.services import till_design as T
from app.services.discounts_report import build_discounts_report
from app.services.preset_discounts_report import build_preset_discount_tracking
from app.services.settings_merge import MANAGED_SETTING_KEYS, deep_merge_settings
from shift_world import TODAY
from test_oth_club import _line, _push, _sale, _window
from test_shop_areas import w  # noqa: F401

FIXTURE = Path(__file__).parent / "fixtures" / "preset_discounts_golden.json"
#: The LF bytes' sha256 — the same constant in kiosk-desktop and pos-android.
GOLDEN_SHA256 = "e63eeca9e9b19d111b429def511029b14441ada9ad0e4eeaeb3e4207fe18e443"


def _golden():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class TestGolden:
    def test_bytes_are_pinned(self):
        data = FIXTURE.read_bytes().replace(b"\r\n", b"\n")
        assert hashlib.sha256(data).hexdigest() == GOLDEN_SHA256

    def test_apply_cases(self):
        cases = _golden()["apply"]
        assert len(cases) >= 10
        for c in cases:
            got = PD.apply_preset(c["payableAgorot"], c["nonDiscountableAgorot"], c["preset"]["kind"], c["preset"]["value"])
            assert got == c["expect"], c["name"]

    def test_resolve_cases(self):
        for c in _golden()["resolve"]:
            assert PD.resolve_for_till(c["presetDiscounts"], c["presetDiscountButtons"]) == c["expect"], c["name"]


class TestSettings:
    def test_keys_ride_the_settings_sync(self):
        assert "presetDiscounts" in MANAGED_SETTING_KEYS and "presetDiscountButtons" in MANAGED_SETTING_KEYS

    def test_deepest_layer_wins_as_a_whole(self):
        company = {"presetDiscounts": [{"id": "a", "name": "א", "kind": "percent", "value": 10}]}
        till = {"presetDiscounts": [{"id": "b", "name": "ב", "kind": "amount", "value": 20}], "presetDiscountButtons": []}
        merged = deep_merge_settings(company, {}, till)
        assert [p["id"] for p in merged["presetDiscounts"]] == ["b"]
        assert merged["presetDiscountButtons"] == []
        # Nothing set anywhere: no key, today's till.
        assert "presetDiscounts" not in deep_merge_settings({}, {})

    def test_a_write_is_cleaned_and_given_ids(self):
        patch = PosSettingsV1Patch.model_validate({"presetDiscounts": [
            {"name": "  הנחת   עובדים ", "kind": "percent", "value": 40, "color": "#1e88e5", "forWhom": "required",
             "forWhomSource": "employees"},
            {"id": "member", "name": "הנחת מנוי", "kind": "amount", "value": "12.5", "requiresManager": True},
        ], "presetDiscountButtons": ["member", "member"]})
        first, second = patch.preset_discounts
        uuid.UUID(first["id"])
        assert first == {**first, "name": "הנחת עובדים", "value": 40, "color": "#1E88E5", "active": True,
                         "button": True, "requiresManager": False, "forWhom": "required", "forWhomSource": "employees"}
        assert second["id"] == "member" and second["value"] == 12.5 and second["requiresManager"] is True
        assert patch.preset_discount_buttons == ["member"]

    @pytest.mark.parametrize("bad", [
        [{"name": "", "kind": "percent", "value": 10}],
        [{"name": "x" * 25, "kind": "percent", "value": 10}],
        [{"name": "x", "kind": "gift", "value": 10}],
        [{"name": "x", "kind": "percent", "value": 101}],
        [{"name": "x", "kind": "percent", "value": 0}],
        [{"name": "x", "kind": "amount", "value": 1.234}],
        [{"name": "x", "kind": "percent", "value": 10, "color": "red"}],
        [{"name": "x", "kind": "percent", "value": 10, "forWhom": "maybe"}],
        [{"name": "x", "kind": "percent", "value": 10, "extra": 1}],
        [{"id": "a", "name": "x", "kind": "percent", "value": 10}, {"id": "a", "name": "y", "kind": "percent", "value": 5}],
        [{"name": f"n{i}", "kind": "percent", "value": 1} for i in range(PD.PRESETS_MAX + 1)],
    ])
    def test_junk_is_refused(self, bad):
        with pytest.raises(Exception):
            PosSettingsV1Patch.model_validate({"presetDiscounts": bad})

    def test_null_resets_to_inherit(self):
        from app.routers.settings import TIP_RESETTABLE_KEYS, _tip_settings_patch

        assert {"presetDiscounts", "presetDiscountButtons"} <= set(TIP_RESETTABLE_KEYS)
        patch = PosSettingsV1Patch.model_validate({"presetDiscounts": None, "presetDiscountButtons": None})
        assert _tip_settings_patch(patch) == {"presetDiscounts": None, "presetDiscountButtons": None}


class TestTillDesign:
    def _bar(self, *items):
        return {"actionBar": {"quick": [*items, {"action": "pay"}]}}

    def test_a_discount_button_names_a_preset(self):
        layer, issues = T.validate_layer(self._bar(
            {"action": "discount", "presetId": " staff "}, {"action": "discount", "presetId": "member", "label": "מנוי"},
            {"action": "discount"},
        ))
        assert issues == []
        assert layer["actionBar"]["quick"][:3] == [
            {"action": "discount", "label": "", "presetId": "staff"},
            {"action": "discount", "label": "מנוי", "presetId": "member"},
            {"action": "discount", "label": ""},
        ]
        view = T.for_profile(T.resolve(layer), "handheld")
        assert view["actions"]["quick"][0]["presetId"] == "staff"

    def test_an_old_bar_keeps_its_bytes(self):
        layer, issues = T.validate_layer(self._bar({"action": "discount"}, {"action": "hold"}))
        assert issues == [] and all("presetId" not in b for b in layer["actionBar"]["quick"])
        layer, _ = T.validate_layer(self._bar({"action": "discount", "presetId": None}))
        assert "presetId" not in layer["actionBar"]["quick"][0]

    @pytest.mark.parametrize("item,code", [
        ({"action": "hold", "presetId": "x"}, "invalid_value"),
        ({"action": "discount", "presetId": ""}, "invalid_type"),
        ({"action": "discount", "presetId": 5}, "invalid_type"),
        ({"action": "discount", "presetId": "x" * 65}, "invalid_type"),
    ])
    def test_refused(self, item, code):
        _layer, issues = T.validate_layer(self._bar(item))
        assert [(i.path, i.code) for i in issues] == [("actionBar.quick[0].presetId", code)]

    def test_the_same_preset_twice_is_a_repeat(self):
        _layer, issues = T.validate_layer(self._bar(
            {"action": "discount", "presetId": "a"}, {"action": "discount", "presetId": "a"},
        ))
        assert [i.code for i in issues] == ["duplicate"]


def _preset_sale(shift, number, *, amount="40.00", percent="40", name="הנחת עובדים", pid="staff", whom=None,
                 cashier=None, **over):
    fields = {"basketDiscount": amount, "basketDiscountKind": "preset", "presetDiscountId": pid, "presetDiscountName": name}
    if whom:
        fields.update(presetDiscountFor=whom, presetDiscountForKind="employee", presetDiscountForRef="u1")
    if percent is not None:
        fields["basketDiscountPercent"] = percent
    fields.update(over)
    return _sale(shift, [_line("burger", 1, "100.00")], number=number, discount=amount, cashier=cashier, **fields)


class TestDocuments:
    def test_stored_and_printed(self, w):
        from app.services.print_documents import build_invoice_copy

        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        assert _push(w, till, _preset_sale(shift, "7101", whom="  דנה   כהן ")) == ["accepted"]
        tx = w.db.query(Transaction).one()
        assert (tx.basket_discount_kind, tx.preset_discount_id, tx.preset_discount_name, tx.preset_discount_for,
                tx.preset_discount_for_kind, tx.preset_discount_for_ref) == (
            "preset", "staff", "הנחת עובדים", "דנה כהן", "employee", "u1")
        printed = build_invoice_copy(w.db, tx).model_dump_json()
        assert "הנחת עובדים 40%" in printed and "עבור: דנה כהן" in printed

    def test_not_a_preset_stores_none(self, w):
        till = w.tills[0]
        shift = w.shift(till, 1, status=ShiftStatus.OPEN)
        _push(w, till, _preset_sale(shift, "7102", basketDiscountKind="manual"))
        tx = w.db.query(Transaction).one()
        assert tx.basket_discount_kind == "manual" and tx.preset_discount_id is None and tx.preset_discount_name is None

    def test_long_text_is_cut_and_an_unknown_for_kind_is_typed(self):
        shift = type("S", (), {"id": uuid.uuid4()})()
        doc = _preset_sale(shift, "1", name="נ" * 100, whom="x" * 300, presetDiscountForKind="phone")
        cols = PD.clean_document_fields(doc.basket_discount_kind, {
            "id": doc.preset_discount_id, "name": doc.preset_discount_name, "for": doc.preset_discount_for,
            "forKind": doc.preset_discount_for_kind, "forRef": doc.preset_discount_for_ref,
        })
        assert len(cols["preset_discount_name"]) == 60 and len(cols["preset_discount_for"]) == 200
        assert cols["preset_discount_for_kind"] == "typed"


class TestReports:
    def _world(self, w):
        dana = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username="dana",
                       first_name="דנה", last_name="כהן", pin_hash="x")
        w.db.add(dana)
        w.db.commit()
        t1, t2 = w.tills
        s1 = w.shift(t1, 1, status=ShiftStatus.OPEN)
        s2 = w.shift(t2, 1, status=ShiftStatus.OPEN)
        _push(w, t1, _preset_sale(s1, "8101", whom="משה", cashier=str(dana.id)))
        _push(w, t1, _preset_sale(s1, "8102", whom="רינה"))
        _push(w, t2, _preset_sale(s2, "8103", amount="10.00", percent="10", name="הנחת מנוי", pid="member"))
        _push(w, t2, _preset_sale(s2, "8104", amount="15.00", percent=None, name="הנחת מנוי", pid="member",
                                  approvedByPosUserId=str(dana.id)))
        _push(w, t2, _sale(s2, [_line("salad", 1, "50.00")], number="8105", discount="5.00",
                           basketDiscount="5.00", basketDiscountKind="manual"))
        # A credit note is left out.
        _push(w, t2, _preset_sale(s2, "8106", documentType=330))
        return dana

    def test_the_discounts_report_counts_presets(self, w):
        self._world(w)
        out = build_discounts_report(w.db, w.admin, w.tenant.id, _window(w), shop_id=w.shop.id)
        assert out["basketByKind"] == [
            {"kind": "manual", "count": 1, "amount": 5.0}, {"kind": "preset", "count": 4, "amount": 105.0},
        ]
        assert out["presets"] == {"totals": {"count": 4, "amount": 105.0}, "byPreset": [
            {"presetId": "staff", "name": "הנחת עובדים", "count": 2, "amount": 80.0},
            {"presetId": "member", "name": "הנחת מנוי", "count": 2, "amount": 25.0},
        ]}

    def test_tracking_rows_totals_and_filters(self, w):
        dana = self._world(w)
        out = build_preset_discount_tracking(w.db, w.admin, w.tenant.id, _window(w), shop_id=w.shop.id)
        assert out["totals"] == {"count": 4, "amount": 105.0} and not out["truncated"]
        assert [(r["presetId"], r["count"], r["amount"]) for r in out["byPreset"]] == [("staff", 2, 80.0), ("member", 2, 25.0)]
        assert sorted((r["for"] or "", r["amount"]) for r in out["byPerson"]) == [("", 25.0), ("משה", 40.0), ("רינה", 40.0)]
        assert ("דנה כהן", 40.0) in [(r["cashierName"], r["amount"]) for r in out["byCashier"]]
        by_number = {r["documentNumber"]: r for r in out["rows"]}
        assert len(by_number) == 4
        row = next(r for r in out["rows"] if r["for"] == "משה")
        assert (row["presetName"], row["kind"], row["percent"], row["amount"], row["cashierName"], row["tillName"],
                row["shopName"], row["forKind"]) == ("הנחת עובדים", "percent", 40.0, 40.0, "דנה כהן", "Till 1",
                                                     "Center", "employee")
        amount_row = next(r for r in out["rows"] if r["amount"] == 15.0)
        assert amount_row["kind"] == "amount" and amount_row["percent"] is None and amount_row["approverName"] == "דנה כהן"

        def count(**f):
            return build_preset_discount_tracking(w.db, w.admin, w.tenant.id, _window(w), **f)["totals"]["count"]

        assert count(preset_id="member") == 2
        assert count(person="מש") == 1
        assert count(cashier_id=str(dana.id)) == 1
        assert count(machine_id=w.tills[1].id) == 2
        # Another shop's manager sees none of it.
        assert build_preset_discount_tracking(w.db, w.north_manager, w.tenant.id, _window(w))["totals"]["count"] == 0

    def test_through_the_router(self, w):
        from app.routers import promotions as R

        out = R.get_preset_discounts_report(
            from_date=TODAY, to_date=TODAY, from_hour=None, to_hour=None, tz=None, shop_id=None, machine_id=None,
            preset_id=None, cashier_id=None, person=None, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db,
        )
        assert out["rows"] == [] and out["totals"] == {"count": 0, "amount": 0.0}


def test_money_is_decimal_safe():
    assert PD.apply_preset(1, 0, "percent", 100)["discountAgorot"] == 1
    assert Decimal(str(PD.apply_preset(300, 0, "amount", 1)["ratePercent"])) == Decimal("33.33")
