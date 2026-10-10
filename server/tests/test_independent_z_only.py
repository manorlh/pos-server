"""
"קופה עצמאית — Z בלבד, בלי משמרות" (app/services/independent_z_only.py; the owner, 10.10.2026).

Two built-in till parameters the Android till reads: `independentTillZOnly` (default ON, "אוטומטי") and
`independentTillAskOpeningCash` (default off). As scenarios: they are registered with their Hebrew
labels and defaults; created once and never overwritten after a super admin changed them; resolved like
every till parameter (till › area › shop › company › default) for an independent till and for any other
till alike (only an independent till acts on them); an independent till's own resolution
(`apply_to_resolved`) leaves them as they are; a value that is not a boolean is refused.
"""
from __future__ import annotations

import pytest

from app.models.till_parameter import TillParameter
from app.services import independent_z_only as Z
from app.services import till_parameters as TP
from shift_world import accept_str_uuids, freeze_z_run_clock, make_world
from test_main_till import set_param

KEYS = (Z.Z_ONLY_KEY, Z.ASK_OPENING_CASH_KEY)


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    freeze_z_run_clock(monkeypatch)
    world = make_world()
    TP.ensure_builtin_parameters(world.db)
    world.db.flush()
    return world


def make_independent(till):
    till.independent_till = True
    till.z_mode = "till"


def resolved(w, till):
    return TP.till_parameters_for_machine(w.db, till).parameters


# ── Registered ────────────────────────────────────────────────────────────────


def test_the_two_parameters_are_builtins_with_the_owners_words_and_defaults():
    by_key = {p.key: p for p in TP.BUILTIN_PARAMETERS}
    only = by_key["independentTillZOnly"]
    assert only.label == "קופה עצמאית — Z בלבד, בלי משמרות"
    assert only.value_type == "boolean" and only.default_value is True
    assert not only.admin_only
    ask = by_key["independentTillAskOpeningCash"]
    assert ask.label == "קופה עצמאית — לשאול קופה פותחת"
    assert ask.value_type == "boolean" and ask.default_value is False
    assert not ask.admin_only


def test_the_help_text_says_it_is_for_independent_tills_and_the_shifts_stay_internal():
    only = next(p for p in TP.BUILTIN_PARAMETERS if p.key == Z.Z_ONLY_KEY)
    assert "קופה עצמאית" in only.description
    assert "לא משפיע על קופה שאינה עצמאית" in only.description
    assert "הפק Z" in only.description and "דו״ח X" in only.description
    # The shifts are kept: sent to the cloud, every document filed in one.
    assert "נשלחות לענן" in only.description
    ask = next(p for p in TP.BUILTIN_PARAMETERS if p.key == Z.ASK_OPENING_CASH_KEY)
    assert "₪0" in ask.description and "פעם אחת" in ask.description


def test_the_keys_are_valid_and_no_key_is_listed_twice():
    keys = [p.key for p in TP.BUILTIN_PARAMETERS]
    for key in KEYS:
        assert TP.KEY_PATTERN.match(key)
        assert keys.count(key) == 1
    assert len({k.lower() for k in keys}) == len(keys)


def test_they_are_created_once_and_never_overwritten(w):
    for key in KEYS:
        row = w.db.query(TillParameter).filter(TillParameter.key == key).one()
        assert row.is_active and row.value_type == "boolean"
    assert w.db.query(TillParameter).filter(TillParameter.key == Z.Z_ONLY_KEY).one().default_value is True
    assert w.db.query(TillParameter).filter(TillParameter.key == Z.ASK_OPENING_CASH_KEY).one().default_value is False
    # A second run creates none of them, and a super admin's re-wording and re-default stand.
    row = w.db.query(TillParameter).filter(TillParameter.key == Z.Z_ONLY_KEY).one()
    row.label = "שם אחר"
    row.default_value = False
    w.db.flush()
    created = TP.ensure_builtin_parameters(w.db)
    assert not set(KEYS) & set(created)
    row = w.db.query(TillParameter).filter(TillParameter.key == Z.Z_ONLY_KEY).one()
    assert row.label == "שם אחר" and row.default_value is False


# ── Resolved like every till parameter ───────────────────────────────────────


def test_an_independent_till_gets_zonly_on_and_ask_off_by_default(w):
    till = w.tills[0]
    make_independent(till)
    p = resolved(w, till)
    assert p[Z.Z_ONLY_KEY] is True
    assert p[Z.ASK_OPENING_CASH_KEY] is False


def test_any_other_till_resolves_them_the_same_and_the_till_app_ignores_them(w):
    # The cloud hands every till the same resolved map; only an independent till acts on it.
    till = w.tills[0]
    assert not till.independent_till
    p = resolved(w, till)
    assert p[Z.Z_ONLY_KEY] is True and p[Z.ASK_OPENING_CASH_KEY] is False


def test_the_most_specific_level_wins_company_shop_till(w):
    till = w.tills[0]
    make_independent(till)
    # Off for the whole company, back on for the shop, off again for this one till.
    set_param(w, Z.Z_ONLY_KEY, "company", w.company.id, False)
    assert resolved(w, till)[Z.Z_ONLY_KEY] is False
    set_param(w, Z.Z_ONLY_KEY, "shop", w.shop.id, True)
    assert resolved(w, till)[Z.Z_ONLY_KEY] is True
    set_param(w, Z.Z_ONLY_KEY, "machine", till.id, False)
    assert resolved(w, till)[Z.Z_ONLY_KEY] is False
    # A neighbour in the same shop keeps the shop's value.
    other = w.tills[1]
    make_independent(other)
    assert resolved(w, other)[Z.Z_ONLY_KEY] is True


def test_asking_the_opening_cash_is_set_per_till(w):
    first, second = w.tills[0], w.tills[1]
    make_independent(first)
    make_independent(second)
    set_param(w, Z.ASK_OPENING_CASH_KEY, "machine", first.id, True)
    assert resolved(w, first)[Z.ASK_OPENING_CASH_KEY] is True
    assert resolved(w, second)[Z.ASK_OPENING_CASH_KEY] is False


def test_the_independent_tills_own_resolution_leaves_them_alone(w):
    # apply_to_resolved turns the LAN-host flags off and fixes tablesMode — nothing of these two.
    till = w.tills[0]
    make_independent(till)
    set_param(w, Z.Z_ONLY_KEY, "machine", till.id, False)
    set_param(w, Z.ASK_OPENING_CASH_KEY, "machine", till.id, True)
    p = resolved(w, till)
    assert p[Z.Z_ONLY_KEY] is False and p[Z.ASK_OPENING_CASH_KEY] is True


# ── Validated ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("key", KEYS)
def test_a_value_that_is_not_a_boolean_is_refused(key):
    spec = next(p for p in TP.BUILTIN_PARAMETERS if p.key == key)
    for bad in ("yes", "true", 1, 0, None, ["x"]):
        with pytest.raises(TP.TillParameterValueError):
            TP.validate_value(spec.value_type, bad)
    assert TP.validate_value(spec.value_type, True) is True
    assert TP.validate_value(spec.value_type, False) is False
