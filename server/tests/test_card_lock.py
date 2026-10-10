"""
"אל תאפשר לקיוסק לעבוד עם מסוף לא תואם" / "תנעל את האשראי, לא את הקופה" (docs/SPEC_KIOSK.md §20):
the cloud's mirror of the till's card lock (app/services/terminal_status.py card_lock_of) and the
alert line the tills show (app/services/kiosk_ops.py identity_text).
"""
from datetime import datetime, timezone

from app.services.kiosk_ops import alert_text
from app.services.terminal_status import (
    LOCK_MISMATCH,
    LOCK_NOT_CONFIGURED,
    LOCK_UNKNOWN,
    card_lock_of,
)

AT = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


def test_network_pinpad_needs_its_own_number_and_a_matching_report():
    assert card_lock_of("nayax_lan", "0882612", "machine", False, "882612", AT) is None
    assert card_lock_of("nayax_lan", "882612", "machine", False, "1807770", AT) == LOCK_MISMATCH
    # Not reported yet: unknown, never trusted.
    assert card_lock_of("nayax_lan", "882612", "machine", False, None, None) == LOCK_UNKNOWN
    assert card_lock_of("nayax_lan", "882612", "machine", False, "882612", None) == LOCK_UNKNOWN


def test_network_pinpad_inherited_number_never_counts():
    assert card_lock_of("nayax_lan", "882612", "shop", False, "882612", AT) == LOCK_NOT_CONFIGURED
    assert card_lock_of("nayax_lan", "882612", "company", False, "882612", AT) == LOCK_NOT_CONFIGURED
    assert card_lock_of("nayax_lan", None, None, False, "882612", AT) == LOCK_NOT_CONFIGURED
    # A forced setup is no way out for a pinpad that is never written.
    assert card_lock_of("nayax_lan", "882612", "machine", True, "1807770", AT) == LOCK_MISMATCH


def test_built_in_terminal_keeps_the_establishment_flow():
    assert card_lock_of("agamento", "882612", "shop", False, "0882612", AT) is None
    assert card_lock_of("agamento", "882612", "shop", False, "1807770", AT) == LOCK_MISMATCH
    # A forced setup on its way, nothing expected, or nothing reported: not locked.
    assert card_lock_of("agamento", "882612", "shop", True, "1807770", AT) is None
    assert card_lock_of("agamento", None, None, False, "1807770", AT) is None
    assert card_lock_of("agamento", "882612", "shop", False, None, None) is None


def test_other_integrations_are_not_this_rule():
    assert card_lock_of("zcredit", "882612", "shop", False, "1807770", AT) is None
    # An external SynqPay terminal IS this rule, as a network pinpad (docs/SPEC_SYNQPAY.md §2.1;
    # tests/test_synqpay_devices.py): no machine-level number is "not configured".
    assert card_lock_of("synqpay", None, None, False, None, None) == LOCK_NOT_CONFIGURED
    assert card_lock_of(None, "882612", "machine", False, "1807770", AT) is None


def test_the_tills_line_names_both_terminals():
    assert alert_text(
        "קיוסק רויאל", "terminal", "terminal_mismatch",
        {"expected": "0882612", "actual": "1807770", "merchant": "מגנום בר"},
    ) == "קיוסק רויאל — המסופון המחובר (מספר 1807770 / מגנום בר) אינו תואם למסוף שהוגדר (0882612)"
    assert alert_text("קיוסק רויאל", "terminal", "terminal_not_configured", {"actual": "882612"}) == (
        "קיוסק רויאל — לא הוגדר מסוף לקיוסק (המסופון המחובר: מספר 882612)"
    )
    assert alert_text("קיוסק רויאל", "terminal", "terminal_not_configured", {}) == "קיוסק רויאל — לא הוגדר מסוף לקיוסק"
    assert alert_text("קיוסק רויאל", "terminal", "terminal_unknown", {"expected": "882612"}) == (
        "קיוסק רויאל — לא ניתן לקרוא את זהות המסופון (מסוף שהוגדר: 882612)"
    )
    # The other terminal alerts are unchanged.
    assert alert_text("קיוסק רויאל", "terminal", "unreachable", {"address": "192.168.0.167"}) == (
        "קיוסק רויאל — אין תקשורת למסופון האשראי (192.168.0.167)"
    )
