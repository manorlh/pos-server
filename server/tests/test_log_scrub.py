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
GOLDEN_SHA256 = "97645490e345509858ba48311af7764a22d854ad92988c0a63148047b380ebc9"
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


def test_long_lines_stay_linear():
    """A device scrubs megabytes: no pattern may go quadratic on a long run of key or digit characters."""
    blobs = ["a" * 200_000 + "=x", "1 " * 100_000, "x." * 100_000 + "@", "token" * 40_000]
    start = time.perf_counter()
    for blob in blobs:
        S.scrub(blob)
    assert time.perf_counter() - start < 5.0
