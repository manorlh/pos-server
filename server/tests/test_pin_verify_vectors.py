"""
The till PIN check, the same everywhere: tests/fixtures/pin_verify_vectors.json is kept byte-equal in
kiosk-desktop/test/fixtures (its core/desktopExit.ts `verifyPin` — the port of the Android till's
PinVerifier — runs every line too). Here the cloud, which made the hashes, must agree with each one:
a PIN matches its bcrypt hash only; anything that is not bcrypt is a refusal, never a comparison.
"""
from __future__ import annotations

import json
import pathlib

import pytest
from passlib.exc import UnknownHashError

from app.services.auth import verify_password

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "pin_verify_vectors.json"
VECTORS = json.loads(FIXTURE.read_text("utf-8"))["vectors"]
BCRYPT_PREFIXES = ("$2a$", "$2b$", "$2y$")


def _cloud_verifies(pin: str, stored: str) -> bool:
    if not pin or not stored.startswith(BCRYPT_PREFIXES):
        return False
    try:
        return verify_password(pin, stored)
    except (ValueError, UnknownHashError):
        return False


@pytest.mark.parametrize("vector", VECTORS, ids=[v["note"] for v in VECTORS])
def test_the_cloud_agrees_with_every_vector(vector):
    assert _cloud_verifies(vector["pin"], vector["hash"]) is vector["expect"]


def test_the_vectors_cover_every_bcrypt_flavour_and_the_refusals():
    hashes = [v["hash"] for v in VECTORS if v["expect"]]
    for prefix in BCRYPT_PREFIXES:
        assert any(h.startswith(prefix) for h in hashes), prefix
    assert any(not v["hash"].startswith("$2") for v in VECTORS)  # a non-bcrypt value is refused
    assert any(v["hash"] == v["pin"] for v in VECTORS)  # a plaintext "hash" never matches


def test_the_kiosk_desktop_copy_is_the_same_bytes():
    other = pathlib.Path(__file__).resolve().parents[2] / "kiosk-desktop" / "test" / "fixtures" / FIXTURE.name
    if not other.exists():
        pytest.skip("kiosk-desktop is not next to the server here")
    assert other.read_bytes().replace(b"\r\n", b"\n") == FIXTURE.read_bytes().replace(b"\r\n", b"\n")
