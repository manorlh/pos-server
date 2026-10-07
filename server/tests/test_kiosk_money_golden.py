"""
The kiosk's money golden fixture (tests/fixtures/kiosk_money_golden.json, PARITY.md guard rail 1).

The fixture pins what a dish with its choices, a meal and a basket with promotions cost — the
Android till's rules, ported once to TypeScript for the Windows and the browser kiosk
(client/src/lib/kioskMoney.ts, whose test runs every case). Here: the file is the pinned one, and
the cloud's own twin of the choice rules (app/services/menu.py `price_picks` / `validate_picks`,
which the server uses to check what a till sends) answers every choice case the same way.
"""
import hashlib
import json
from pathlib import Path

import pytest

from app.services import menu as MENU

GOLDEN = Path(__file__).parent / "fixtures" / "kiosk_money_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in client/src/lib/kioskMoney.test.ts,
#: kiosk-desktop/test/kioskMoney.test.ts and, to come, the Android kiosk's test. Change them together.
GOLDEN_SHA256 = "69424fcab136e5f783c2d3ce472c77a81ba703b5f1dc0ce6a1314245df888c0e"

#: The cloud's names for the till's PickProblem values.
PROBLEM = {"duplicate": "duplicate_option"}


def _text() -> str:
    return GOLDEN.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _golden() -> dict:
    return json.loads(_text())


def test_the_fixture_is_the_pinned_one():
    assert hashlib.sha256(_text().encode("utf-8")).hexdigest() == GOLDEN_SHA256


def _rules(group: dict) -> MENU.GroupRules:
    options = group.get("options") or []
    return MENU.GroupRules(
        min_select=group.get("minSelect") or 0,
        max_select=group.get("maxSelect"),
        free_count=group.get("freeCount") or 0,
        allow_quantity=bool(group.get("allowQuantity")),
        allow_pre=bool(group.get("allowPre")),
        prices={o["id"]: MENU._agorot(o.get("price")) for o in options},
        limits={o["id"]: o["maxQty"] for o in options if o.get("maxQty")},
    )


@pytest.mark.parametrize("case", _golden()["modifiers"], ids=lambda c: c["name"][:60])
def test_the_clouds_choice_rules_answer_every_case_the_same(case):
    group = case["group"]
    picks = case["picks"]
    if picks is None:
        picks = [{"optionId": o["id"], "qty": 1, "pre": None} for o in group["options"] if o.get("isDefault")]
    rules = _rules(group)
    cloud = [MENU.Pick(option_id=p["optionId"], qty=p["qty"], pre=p["pre"]) for p in picks]
    assert MENU.price_picks(rules, cloud) == case["expected"]["charges"]
    assert MENU.validate_picks(rules, cloud) == [PROBLEM.get(p, p) for p in case["expected"]["problems"]]
