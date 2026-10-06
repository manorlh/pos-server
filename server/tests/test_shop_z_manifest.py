"""
The local shop Z manifest — one computation on the till and in the cloud
(docs/SPEC_INDEPENDENT_TILL.md §8.12).

The golden fixtures are shared with pos-android (`app/src/test/resources/`, the same
bytes): both suites compute every case and must match `expected` exactly, and both pin
the file's SHA-256 — so the Kotlin and the Python computations are the same computation.
"""
import hashlib
import json
from pathlib import Path

import pytest

from app.services import shop_z_manifest as M

GOLDEN = Path(__file__).parent / "fixtures" / "shop_z_manifest_golden.json"
#: The file's SHA-256 (line endings read as LF) — the same constant in pos-android's
#: ShopZManifestTest. Change the fixtures in both repositories, and both constants, together.
GOLDEN_SHA256 = "b14e69e8181b2dfc9b3c19ae7a4b500d6accf2403526ffa3bd0f08b8f078a057"
#: pos-android beside pos-server (as on the developers' machines): the two copies must be equal.
SIBLING = Path(__file__).resolve().parents[3] / "pos-android" / "app" / "src" / "test" / "resources" / GOLDEN.name


def _text(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def _cases():
    return json.loads(_text(GOLDEN))["cases"]


def test_the_fixtures_are_the_pinned_ones():
    assert hashlib.sha256(_text(GOLDEN).encode("utf-8")).hexdigest() == GOLDEN_SHA256


def test_the_till_has_the_same_fixtures():
    if not SIBLING.exists():
        pytest.skip("pos-android is not checked out beside pos-server")
    assert _text(SIBLING) == _text(GOLDEN)


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"][:60])
def test_every_golden_case_to_the_agora(case):
    assert M.manifest_of(case["documents"]) == case["expected"]


def test_the_digest_names_every_document_and_every_agora():
    docs = _cases()[2]["documents"]
    base = M.manifest_of(docs)
    one_agora = [dict(d) for d in docs]
    one_agora[0]["total"] = "50.01"
    assert M.manifest_of(one_agora)["digest"] != base["digest"]
    other_leg = [dict(d) for d in docs]
    other_leg[1]["payments"] = [{"method": "cash", "amount": "20.00"}, {"method": "card", "amount": "10.00"}]
    changed = M.manifest_of(other_leg)
    assert changed["totals"]["gross"] == base["totals"]["gross"] and changed["digest"] != base["digest"]
    # The order documents come in is not a difference.
    assert M.manifest_of(list(reversed(docs))) == base


def test_compare_says_what_differs_and_nothing_else():
    docs = _cases()[2]["documents"]
    printed = M.manifest_of(docs)
    assert M.compare(printed, M.manifest_of(docs)) == []
    fewer = M.manifest_of(docs[1:])
    keys = {d["key"] for d in M.compare(printed, fewer)}
    assert {"documents", "types.320.count", "types.320.first", "totals.gross", "digest"} <= keys


def test_the_shops_totals_are_the_sum_of_its_parts():
    a = M.manifest_of(_cases()[1]["documents"])
    b = M.manifest_of(_cases()[2]["documents"])
    total = M.sum_totals([a, b])
    assert total["gross"] == "132.00" and total["documents"] == 5 and total["vat"] == "17.70"
    unknown = M.manifest_of(_cases()[5]["documents"])
    assert M.sum_totals([a, unknown])["vat"] is None
