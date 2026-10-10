"""
"שליחת לוגים לענן" §4 — the scrubber (app/services/log_scrub.py): the device's log before it is
compressed, and the note again in the cloud.

The golden fixture is shared with pos-android (`app/src/test/resources/`, the same bytes): both
suites scrub every case and must match `expected` exactly, both check that scrubbing twice changes
nothing, and both pin the file's SHA-256 — so the Kotlin and the Python scrubbers are one scrubber.
"""
import hashlib
import json
import time
from pathlib import Path

import pytest

from app.services import log_scrub as S

GOLDEN = Path(__file__).parent / "fixtures" / "device_logs_scrub_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in pos-android's scrubber
#: test. Change the fixture in both repositories, and both constants, together.
GOLDEN_SHA256 = "300f27efba9d810c8f1bad71d8ba09e8cb7013b36294eb6e4032f68f4b82d909"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _cases():
    return json.loads(_text(GOLDEN))["cases"]


def test_the_fixture_is_the_pinned_one():
    assert hashlib.sha256(_text(GOLDEN).encode("utf-8")).hexdigest() == GOLDEN_SHA256


def test_the_device_has_the_same_fixture():
    if not SIBLING.exists():
        pytest.skip("pos-android's copy is not beside pos-server (yet)")
    assert _text(SIBLING) == _text(GOLDEN)


def test_the_case_names_are_unique():
    names = [c["name"] for c in _cases()]
    assert len(names) == len(set(names)) and len(names) >= 40


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_every_golden_case(case):
    assert S.scrub(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_scrubbing_twice_changes_nothing(case):
    assert S.scrub(case["expected"]) == case["expected"]


def test_none_stays_none_and_empty_stays_empty():
    assert S.scrub(None) is None and S.scrub("") == ""


@pytest.mark.parametrize("digits, ok", [
    ("4111111111111111", True), ("4111111111111112", False), ("378282246310005", True), ("0", True), ("18", True),
])
def test_luhn(digits, ok):
    assert S.luhn_ok(digits) is ok


def test_the_fixture_is_version_2_and_has_the_reviewed_cases():
    doc = json.loads(_text(GOLDEN))
    assert doc["version"] == 2
    by_name = {c["name"]: c for c in doc["cases"]}
    for kept in ("kv_pinpad_host_stays", "kv_mapping_stays", "kv_typing_shipping_spinner_stay", "epoch_ms_kept",
                 "epoch_ms_luhn_fails_kept", "epoch_ms_luhn_valid_kept", "card_13_not_starting_with_4_kept"):
        assert by_name[kept]["expected"] == by_name[kept]["input"], kept
    assert by_name["kv_manager_pin"]["expected"] == "managerPin=***"
    assert by_name["card_13_digits"]["expected"].endswith("************2222")
    assert by_name["card_amex_15"]["expected"] == "amex ************0005"


@pytest.mark.parametrize("key, secret", [
    ("pin", True), ("PIN", True), ("userPin", True), ("pin_code", True), ("managerPin", True), ("PINCode", True),
    ("pincode", True), ("cvv2", True), ("terminal_password", True), ("terminalPassword", True), ("passwd", True),
    ("api_key", True), ("apiKey", True), ("X-API-Key", True), ("APIKEY", True), ("access_token", True),
    ("clientSecret", True), ("Authorization", True),
    ("pinpadHost", False), ("mapping", False), ("typing", False), ("shipping", False), ("spinner", False),
    ("tokenizer", False), ("apiVersion", False), ("keyboard", False), ("terminalNumber", False),
])
def test_secret_keys_are_matched_by_token_not_substring(key, secret):
    assert S.is_secret_key(key) is secret


def test_key_tokens():
    assert S.key_tokens("managerPin") == ["manager", "pin"]
    assert S.key_tokens("X-API-Key") == ["x", "api", "key"]
    assert S.key_tokens("PINCode") == ["pin", "code"]
    assert S.key_tokens("cvv2") == ["cvv", "2"]
    assert S.key_tokens("config.terminal_password") == ["config", "terminal", "password"]


@pytest.mark.parametrize("digits, card", [
    ("4222222222222", True),    # 13, Visa
    ("1760000000008", False),   # 13, Luhn-valid epoch ms: not a card
    ("5123456789010", False),   # 13 not starting with 4
    ("30569309025904", True),   # 14, Diners
    ("12345678901237", False),  # 14, another prefix
    ("378282246310005", True),  # 15, Amex
    ("412345678901233", False),  # 15, not 34 / 37
    ("4111111111111111", True), ("4111111111111112", False), ("6221260000000000001", True),
    ("411111111111", False), ("41111111111111111111", False),
])
def test_a_card_by_length_prefix_and_luhn(digits, card):
    assert S.pan_ok(digits) is card


def test_long_lines_stay_linear():
    """A device scrubs megabytes: no pattern may go quadratic on a long run of key or digit characters."""
    blobs = [
        "a" * 200_000 + "=x", "1 " * 100_000, "x." * 100_000 + "@", "token" * 40_000,
        "mapping=x " * 20_000, "pinpad" * 30_000 + "=1",
    ]
    start = time.perf_counter()
    for blob in blobs:
        S.scrub(blob)
    assert time.perf_counter() - start < 5.0
