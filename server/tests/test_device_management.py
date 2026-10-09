"""
"עדכון שקט" — device owner, silent updates, QR provisioning and the cloud reboot
(docs/SPEC_UPDATES.md §5; app/services/device_management.py, app/services/apk_signing.py,
app/routers/device_management.py).

* The signing certificate is read from an APK's v3 / v2 signing block, else its v1 PKCS#7 — the
  same digest `apksigner verify --print-certs` prints — and turned into the QR's checksum.
* The heartbeat's `deviceManagement` block is cleaned and stored; the machine page and the
  rollout rows carry it.
* "הפעל מחדש": only a device-owner till, one request at a time, handed over on the heartbeat,
  acked deferred / rebooting / refused, lapsing after 30 minutes.
* The QR: the shop's assigned release (else the newest), its checksum, a signed short-lived APK
  link that works without an auth header — and refuses a forged, expired or retired one.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import struct
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.config import get_settings
from app.models.app_release import AppRelease, AppReleaseAssignment
from app.models.user import User, UserRole
from app.routers import app_releases as R
from app.routers import device_management as DMR
from app.routers import machines as machines_router
from app.schemas.pos_machine import MachineHeartbeatBody, POSMachineResponse
from app.services import apk_signing as S
from app.services import device_management as DM
from shift_world import accept_str_uuids, make_world

NOW = datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)
CERT = b"0\x82\x01\x0afake-der-certificate CN=R2M Release"
DEBUG_CERT = b"0\x82\x01\x0afake-der-certificate CN=Android Debug, O=Android, C=US"


# ── Synthetic APKs ───────────────────────────────────────────────────────────


def _lp(data: bytes) -> bytes:
    return struct.pack("<I", len(data)) + data


def _scheme_value(cert: bytes, v3: bool = False) -> bytes:
    digests = _lp(_lp(struct.pack("<I", 0x0103) + _lp(b"\x00" * 32)))
    certs = _lp(_lp(cert))
    tail = (struct.pack("<II", 24, 0x7FFFFFFF) + _lp(b"")) if v3 else _lp(b"")
    signed_data = digests + certs + tail
    signer = _lp(signed_data) + (struct.pack("<II", 24, 0x7FFFFFFF) if v3 else b"") + _lp(b"") + _lp(b"public-key")
    return _lp(_lp(signer))


def _signing_block(pairs) -> bytes:
    body = b"".join(struct.pack("<Q", len(v) + 4) + struct.pack("<I", k) + v for k, v in pairs.items())
    size = len(body) + 8 + 16
    return struct.pack("<Q", size) + body + struct.pack("<Q", size) + S.APK_SIG_BLOCK_MAGIC


def _zip(entries=None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in (entries or {"AndroidManifest.xml": b"\x03\x00\x08\x00", "classes.dex": b"dex\n035\x00"}).items():
            z.writestr(name, data)
    return buf.getvalue()


def _with_block(apk: bytes, block: bytes) -> bytes:
    """Insert an APK Signing Block before the central directory, moving the EOCD's offset."""
    eocd = apk.rfind(b"PK\x05\x06")
    (cd_offset,) = struct.unpack_from("<I", apk, eocd + 16)
    out = bytearray(apk[:cd_offset] + block + apk[cd_offset:])
    struct.pack_into("<I", out, eocd + len(block) + 16, cd_offset + len(block))
    return bytes(out)


def signed_apk(cert: bytes = CERT, *, v3_cert: bytes = None, entries=None) -> bytes:
    pairs = {S.V2_BLOCK_ID: _scheme_value(cert)}
    if v3_cert is not None:
        pairs[S.V3_BLOCK_ID] = _scheme_value(v3_cert, v3=True)
    pairs[0x42726577] = b"\x00" * 16  # a verity padding pair the reader skips
    return _with_block(_zip(entries), _signing_block(pairs))


# ── The signing certificate ──────────────────────────────────────────────────


class TestSigningCertificate:
    def test_v2_gives_the_signers_certificate(self):
        assert S.signing_certificate(io.BytesIO(signed_apk())) == CERT
        assert S.signing_cert_sha256(io.BytesIO(signed_apk())) == hashlib.sha256(CERT).hexdigest()

    def test_v3_wins_over_v2(self):
        other = b"0\x82\x00\x10rotated-cert"
        assert S.signing_certificate(io.BytesIO(signed_apk(CERT, v3_cert=other))) == other

    def test_the_zip_still_reads_as_a_zip(self):
        with zipfile.ZipFile(io.BytesIO(signed_apk())) as z:
            assert "classes.dex" in z.namelist()

    def test_v1_pkcs7_certificate(self):
        crypto = pytest.importorskip("cryptography")  # noqa: F841
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.serialization import pkcs7
        from cryptography.x509.oid import NameOID

        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "R2M v1")])
        cert = (
            x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(7).not_valid_before(NOW).not_valid_after(NOW + timedelta(days=3650))
            .sign(key, hashes.SHA256())
        )
        sig = (
            pkcs7.PKCS7SignatureBuilder().set_data(b"Signature-Version: 1.0\r\n")
            .add_signer(cert, key, hashes.SHA256())
            .sign(serialization.Encoding.DER, [pkcs7.PKCS7Options.DetachedSignature])
        )
        apk = _zip({"AndroidManifest.xml": b"\x03\x00", "META-INF/CERT.EC": sig, "META-INF/MANIFEST.MF": b"x"})
        der = cert.public_bytes(serialization.Encoding.DER)
        assert S.signing_certificate(io.BytesIO(apk)) == der
        assert S.signing_cert_sha256(io.BytesIO(apk)) == hashlib.sha256(der).hexdigest()

    def test_unsigned_or_garbage_is_refused(self):
        with pytest.raises(S.ApkSigningError):
            S.signing_certificate(io.BytesIO(_zip()))
        with pytest.raises(S.ApkSigningError):
            S.signing_certificate(io.BytesIO(b"not a zip at all, not even close"))
        broken = bytearray(signed_apk())
        at = broken.find(S.APK_SIG_BLOCK_MAGIC)
        struct.pack_into("<Q", broken, at - 8, 10**9)  # footer size out of range
        with pytest.raises(S.ApkSigningError):
            S.signing_certificate(io.BytesIO(bytes(broken)))
        assert S.signing_cert_sha256_or_none(io.BytesIO(b"junk" * 10)) is None

    def test_the_qr_checksum_is_url_safe_base64_without_padding(self):
        digest = hashlib.sha256(b"\xfb\xff" * 40).hexdigest()
        checksum = S.provisioning_checksum(digest)
        assert len(checksum) == 43 and "=" not in checksum and "+" not in checksum and "/" not in checksum
        assert base64.urlsafe_b64decode(checksum + "=") == bytes.fromhex(digest)
        # The digest apksigner prints for the build PC's debug key, as the QR carries it.
        assert S.provisioning_checksum(
            "593337def401d9dc5ce4557480d0ffbf0d6cbd478b0b141e9deeda7d3e1a6ba3"
        ) == "WTM33vQB2dxc5FV0gND_vw1svUeLCxQene7afT4aa6M"
        with pytest.raises(ValueError):
            S.provisioning_checksum("abcd")


# ── The heartbeat block ──────────────────────────────────────────────────────

BLOCK = {
    "deviceOwner": True,
    "updatePath": "device_owner",
    "sdk": 29,
    "canRequestInstalls": False,
    "kioskLock": "full",
    "lockTaskPermitted": True,
    "permissionsGranted": ["android.permission.CAMERA", "android.permission.READ_PHONE_STATE"],
    "provisionedBy": "adb",
}


@pytest.fixture
def w(monkeypatch, tmp_path):
    accept_str_uuids(monkeypatch)
    world = make_world()
    world.tmp = tmp_path
    monkeypatch.setattr(get_settings(), "app_releases_dir", str(tmp_path / "releases"))
    return world


def beat(w, till, payload=None):
    body = MachineHeartbeatBody.model_validate(payload) if payload is not None else None
    return machines_router.post_my_heartbeat(body=body, machine=till, db=w.db, request=None)


class TestBlock:
    def test_known_keys_typed_and_the_silence_follows_the_path(self):
        out = DM.clean_block({**BLOCK, "silentUpdate": False, "extra": 1, "sdk": 290})
        assert out["silentUpdate"] is True  # the path says so, whatever the flag
        assert "extra" not in out and "sdk" not in out
        assert DM.clean_block({"updatePath": "tap", "silentUpdate": True})["silentUpdate"] is False
        assert DM.clean_block({"updatePath": "PAX"})["silentUpdate"] is True
        assert DM.clean_block({"updatePath": "magic", "silentUpdate": True}) == {"silentUpdate": True}

    def test_garbage_is_dropped_never_raised(self):
        assert DM.clean_block("nope") is None
        assert DM.clean_block({}) is None
        out = DM.clean_block({"deviceOwner": "yes", "kioskLock": "half", "permissionsGranted": ["ok.P", 5, "bad perm!"],
                              "ownerReleasedBy": "x" * 200})
        assert out == {"permissionsGranted": ["ok.P"], "ownerReleasedBy": "x" * 80}
        assert DM.silent_update_status(None) is None
        assert DM.silent_update_status({"silentUpdate": False}) == "tap"
        assert DM.silent_update_status({"silentUpdate": True}) == "silent"

    def test_the_heartbeat_stores_it_and_an_old_till_changes_nothing(self, w):
        till = w.tills[0]
        beat(w, till, {"appVersion": "0.1.300", "deviceManagement": BLOCK})
        assert till.device_management["deviceOwner"] is True
        assert till.device_management["updatePath"] == "device_owner"
        assert till.device_management_reported_at is not None
        beat(w, till, {"appVersion": "0.1.300"})
        assert till.device_management["kioskLock"] == "full"
        body = MachineHeartbeatBody.model_validate({"deviceManagement": "junk"})
        assert body.device_management is None

    def test_a_release_by_the_technician_is_kept_and_logged(self, w, caplog, monkeypatch):
        till = w.tills[0]
        beat(w, till, {"deviceManagement": BLOCK})
        released = {"deviceOwner": False, "updatePath": "tap", "sdk": 29, "kioskLock": "pinned",
                    "ownerReleasedAt": "2026-10-07T08:00:00Z", "ownerReleasedBy": "טכנאי"}
        # An earlier test's alembic env.py (fileConfig) disables every existing logger,
        # this one included (tests/test_machine_catalog.py, test_general_item.py, ...).
        monkeypatch.setattr(DM.logger, "disabled", False)
        with caplog.at_level("WARNING", logger=DM.logger.name):
            beat(w, till, {"deviceManagement": released})
        assert till.device_management["ownerReleasedBy"] == "טכנאי"
        assert till.device_management["silentUpdate"] is False
        assert "no longer the device owner" in caplog.text

    def test_the_machine_page_carries_it(self, w):
        till = w.tills[0]
        beat(w, till, {"deviceManagement": BLOCK})
        fields = DM.machine_fields(till)
        assert fields["deviceManagement"]["sdk"] == 29
        rows = machines_router.list_machines(
            skip=0, limit=100, shop_id=None, tenant_id=None, distributor_id=None,
            include_inactive=False, area_id=None, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        )
        mine = next(r for r in rows if r["id"] == till.id)
        dumped = POSMachineResponse.model_validate(mine).model_dump(by_alias=True)
        assert dumped["deviceManagement"]["updatePath"] == "device_owner"
        assert dumped["deviceManagementReportedAt"] is not None
        assert dumped["rebootRequest"] is None
        DM.request_reboot(till, w.admin)
        mine = next(r for r in machines_router.list_machines(
            skip=0, limit=100, shop_id=None, tenant_id=None, distributor_id=None,
            include_inactive=False, area_id=None, current_user=w.admin,
            active_tenant_id=w.tenant.id, db=w.db,
        ) if r["id"] == till.id)
        assert POSMachineResponse.model_validate(mine).model_dump(by_alias=True)["rebootRequest"]["status"] == "pending"

    def test_the_rollout_rows_carry_it(self, w):
        till = w.tills[0]
        beat(w, till, {"deviceManagement": {**BLOCK, "deviceOwner": False, "updatePath": "self_update"}})
        admin = MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=w.admin.id)
        rows = R.get_app_release_rollout(
            tenant_id=None, company_id=None, shop_id=None, current_user=admin,
            active_tenant_id=w.tenant.id, db=w.db, platform=None,
        )
        row = next(r for r in rows if r.machine_id == till.id)
        dumped = row.model_dump(by_alias=True)
        assert (dumped["deviceOwner"], dumped["silentUpdate"], dumped["updatePath"]) == (False, True, "self_update")
        other = next(r for r in rows if r.machine_id == w.tills[1].id)
        assert other.silent_update is None


# ── Reboot ───────────────────────────────────────────────────────────────────


class TestReboot:
    def _owner(self, w):
        till = w.tills[0]
        beat(w, till, {"deviceManagement": BLOCK})
        return till

    def test_only_a_device_owner_android_till(self, w):
        till = w.tills[0]
        with pytest.raises(DM.RebootRefused) as exc:
            DM.request_reboot(till, w.admin, now=NOW)
        assert (exc.value.status_code, exc.value.detail) == (409, "reboot_needs_device_owner")
        beat(w, till, {"deviceManagement": BLOCK})
        till.device_info = {"platform": "windows"}
        with pytest.raises(DM.RebootRefused) as exc:
            DM.request_reboot(till, w.admin, now=NOW)
        assert exc.value.detail == "reboot_android_only"
        till.device_info = None
        till.pairing_status = SimpleNamespace(value="unpaired")
        with pytest.raises(DM.RebootRefused) as exc:
            DM.request_reboot(till, w.admin, now=NOW)
        assert exc.value.detail == "machine_not_assigned"

    def test_one_request_handed_over_until_the_till_reboots(self, w):
        till = self._owner(w)
        req, created = DM.request_reboot(till, w.admin, now=NOW)
        assert created and req["status"] == "pending" and req["requestedBy"]
        again, created_again = DM.request_reboot(till, w.admin, now=NOW + timedelta(minutes=1))
        assert not created_again and again["id"] == req["id"]
        pending = DM.take_pending_reboot(till, now=NOW + timedelta(minutes=2))
        assert pending == {"requestId": req["id"], "requestedAt": req["requestedAt"], "requestedBy": req["requestedBy"]}
        # Busy: deferred, and still handed over.
        DM.apply_reboot_ack(till, req["id"], "deferred", "busy_sale", now=NOW + timedelta(minutes=3))
        assert till.reboot_request["status"] == "deferred" and till.reboot_request["reason"] == "busy_sale"
        assert DM.take_pending_reboot(till, now=NOW + timedelta(minutes=4)) is not None
        DM.apply_reboot_ack(till, req["id"], "rebooting", now=NOW + timedelta(minutes=5))
        assert till.reboot_request["status"] == "rebooting" and till.reboot_request["rebootingAt"]
        assert DM.take_pending_reboot(till, now=NOW + timedelta(minutes=6)) is None
        # An ended request is answered as it is.
        assert DM.apply_reboot_ack(till, req["id"], "refused", now=NOW)["status"] == "rebooting"
        with pytest.raises(DM.RebootRefused) as exc:
            DM.apply_reboot_ack(till, uuid.uuid4(), "rebooting", now=NOW)
        assert exc.value.status_code == 404
        with pytest.raises(DM.RebootRefused):
            DM.apply_reboot_ack(till, req["id"], "maybe", now=NOW)

    def test_it_lapses_and_can_be_withdrawn(self, w):
        till = self._owner(w)
        req, _ = DM.request_reboot(till, w.admin, now=NOW)
        assert DM.reboot_request_out(till.reboot_request, now=NOW + timedelta(minutes=31))["status"] == "expired"
        assert DM.take_pending_reboot(till, now=NOW + timedelta(minutes=31)) is None
        assert till.reboot_request["status"] == "expired"
        fresh, created = DM.request_reboot(till, w.admin, now=NOW + timedelta(minutes=32))
        assert created and fresh["id"] != req["id"]
        DM.cancel_reboot(till, now=NOW + timedelta(minutes=33))
        assert till.reboot_request["status"] == "cancelled"
        with pytest.raises(DM.RebootRefused) as exc:
            DM.cancel_reboot(till, now=NOW + timedelta(minutes=34))
        assert exc.value.detail == "reboot_not_pending"

    def test_through_the_routes_and_the_heartbeat(self, w):
        till = self._owner(w)
        out = DMR.request_machine_reboot(machine_id=till.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert out["created"] is True
        request_id = out["rebootRequest"]["id"]
        reply = beat(w, till, {"appVersion": "1"})
        assert reply["pendingReboot"]["requestId"] == request_id
        ack = DMR.post_reboot_ack(
            machine_id=str(till.id),
            body=DMR.RebootAckIn.model_validate({"requestId": request_id, "phase": "rebooting"}),
            machine=till, db=w.db,
        )
        assert ack == {"ok": True, "status": "rebooting"}
        assert "pendingReboot" not in beat(w, till, {"appVersion": "1"})
        with pytest.raises(HTTPException) as exc:
            DMR.cancel_machine_reboot(machine_id=till.id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db)
        assert exc.value.status_code == 409
        with pytest.raises(HTTPException) as exc:
            DMR.request_machine_reboot(
                machine_id=w.tills[1].id, current_user=w.admin, active_tenant_id=w.tenant.id, db=w.db
            )
        assert exc.value.detail == "reboot_needs_device_owner"


# ── QR provisioning ──────────────────────────────────────────────────────────


def _release(w, name="0.1.400", code=400, cert=CERT, active=True, created=NOW):
    data = signed_apk(cert)
    path = w.tmp / f"{name}.apk"
    path.write_bytes(data)
    r = AppRelease(
        id=uuid.uuid4(), platform="android", version_code=code, version_name=name,
        sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data), file_path=str(path),
        is_active=active, created_at=created,
    )
    w.db.add(r)
    w.db.commit()
    return r


def _assign(w, release, level, target_id, percent=100):
    a = AppReleaseAssignment(
        id=uuid.uuid4(), release_id=release.id, level=level, target_id=target_id, tenant_id=w.tenant.id,
        auto_install=True, rollout_percent=percent, created_at=NOW,
    )
    w.db.add(a)
    w.db.commit()
    return a


def _request(base="https://pos-cloud-api.fly.dev/", headers=None):
    return SimpleNamespace(base_url=base, headers=headers or {})


def _qr(w, request=None, **body):
    return DMR.create_provisioning_qr(
        body=DMR.ProvisioningQrIn.model_validate(body),
        request=request or _request(),
        current_user=w.admin,
        active_tenant_id=w.tenant.id,
        db=w.db,
    )


class TestApkToken:
    def test_round_trip_tamper_and_expiry(self):
        rid = uuid.uuid4()
        token = DM.make_apk_token(rid, NOW + timedelta(hours=24))
        assert len(token) < 80
        assert DM.read_apk_token(token, now=NOW) == rid
        with pytest.raises(DM.ApkTokenExpired):
            DM.read_apk_token(token, now=NOW + timedelta(hours=25))
        head, exp, sig = token.split(".")
        for forged in (f"{uuid.uuid4().hex}.{exp}.{sig}", f"{head}.{int(exp, 16) + 3600:x}.{sig}", "a.b", ""):
            with pytest.raises(DM.ApkTokenInvalid):
                DM.read_apk_token(forged, now=NOW)

    def test_the_link_lives_one_to_seventy_two_hours(self):
        assert DM.apk_token_expiry(None, now=NOW) == NOW + timedelta(hours=24)
        assert DM.apk_token_expiry(0, now=NOW) == NOW + timedelta(hours=1)
        assert DM.apk_token_expiry(500, now=NOW) == NOW + timedelta(hours=72)


class TestProvisioningQr:
    def test_the_shops_assigned_release_and_its_checksum(self, w):
        newest = _release(w, "0.1.500", 500)
        shop_release = _release(w, "0.1.450", 450)
        _assign(w, shop_release, "shop", w.shop.id)
        out = _qr(w, shopId=str(w.shop.id))
        p = out["payload"]
        assert p[DM.EXTRA_COMPONENT] == "il.co.runnersys.pos/.system.PosDeviceAdmin"
        assert p[DM.EXTRA_CHECKSUM] == S.provisioning_checksum(hashlib.sha256(CERT).hexdigest())
        assert p[DM.EXTRA_SYSTEM_APPS] is True
        assert p[DM.EXTRA_ADMIN_BUNDLE] == {
            DM.ADMIN_EXTRA_SERVER_URL: "https://pos-cloud-api.fly.dev",
            DM.ADMIN_EXTRA_SHOP_ID: str(w.shop.id),
            DM.ADMIN_EXTRA_SHOP_NAME: "Center",
        }
        assert out["release"] == {"id": str(shop_release.id), "versionName": "0.1.450", "versionCode": 450,
                                  "source": "assigned"}
        assert out["warnings"] == []
        assert out["adbCommand"] == "adb shell dpm set-device-owner il.co.runnersys.pos/.system.PosDeviceAdmin"
        url = p[DM.EXTRA_DOWNLOAD]
        assert url.startswith("https://pos-cloud-api.fly.dev/api/v1/device-management/provisioning/apk/")
        assert json.loads(out["payloadJson"]) == p
        assert w.db.get(AppRelease, shop_release.id).signing_cert_sha256 == hashlib.sha256(CERT).hexdigest()
        assert newest.id != shop_release.id

    def test_a_staged_shop_assignment_does_not_count_and_the_newest_is_flagged(self, w):
        _release(w, "0.1.500", 500)
        staged = _release(w, "0.1.450", 450)
        _assign(w, staged, "shop", w.shop.id, percent=30)
        out = _qr(w, shopId=str(w.shop.id))
        assert out["release"]["versionName"] == "0.1.500" and out["release"]["source"] == "newest"
        assert "not_assigned" in out["warnings"]

    def test_a_till_takes_its_own_assignment(self, w):
        _release(w, "0.1.500", 500)
        mine = _release(w, "0.1.460", 460)
        _assign(w, mine, "machine", w.tills[1].id)
        out = _qr(w, machineId=str(w.tills[1].id))
        assert out["release"]["id"] == str(mine.id) and out["shopId"] == str(w.shop.id)

    def test_warnings_for_a_local_api_and_the_debug_key(self, w):
        _release(w, cert=DEBUG_CERT)
        out = _qr(w, request=_request("http://localhost:8001/"), shopId=str(w.shop.id))
        assert {"localhost", "http", "debug_key", "not_assigned"} <= set(out["warnings"])
        behind_edge = _qr(w, request=_request("http://api.example.com/", {"x-forwarded-proto": "https"}),
                          shopId=str(w.shop.id))
        assert behind_edge["downloadUrl"].startswith("https://api.example.com/")

    def test_refusals(self, w):
        with pytest.raises(HTTPException) as exc:
            _qr(w, shopId=str(w.shop.id))
        assert exc.value.detail == "no_android_release"
        with pytest.raises(HTTPException) as exc:
            _qr(w)
        assert exc.value.detail == "shop_required"
        broken = _release(w)
        (w.tmp / "0.1.400.apk").write_bytes(_zip())
        with pytest.raises(HTTPException) as exc:
            _qr(w, shopId=str(w.shop.id))
        assert exc.value.detail == "apk_signature_unreadable"
        assert broken.is_active


class TestProvisioningApk:
    def test_served_by_a_good_token_only(self, w):
        release = _release(w)
        token = DM.make_apk_token(release.id, datetime.now(timezone.utc) + timedelta(hours=1))
        res = DMR.provisioning_apk(token=token, db=w.db)
        assert isinstance(res, FileResponse) and res.path == release.file_path
        assert res.media_type == "application/vnd.android.package-archive"
        with pytest.raises(HTTPException) as exc:
            DMR.provisioning_apk(token=token[:-2] + "xx", db=w.db)
        assert exc.value.status_code == 404
        old = DM.make_apk_token(release.id, datetime.now(timezone.utc) - timedelta(minutes=1))
        with pytest.raises(HTTPException) as exc:
            DMR.provisioning_apk(token=old, db=w.db)
        assert exc.value.status_code == 410
        release.is_active = False
        w.db.commit()
        with pytest.raises(HTTPException) as exc:
            DMR.provisioning_apk(token=token, db=w.db)
        assert exc.value.status_code == 404

    def test_the_route_needs_no_auth_header(self):
        from fastapi.routing import APIRoute

        from app.main import app

        route = next(r for r in app.routes if isinstance(r, APIRoute)
                     and r.path == "/api/v1/device-management/provisioning/apk/{token}")
        assert {"GET", "HEAD"} <= route.methods
        names = {d.call.__name__ for d in route.dependant.dependencies}
        assert names == {"get_db"}


class TestUpload:
    def test_the_signing_certificate_is_kept_on_upload(self, w):
        data = signed_apk()
        out = R.upload_app_release(
            file=UploadFile(file=io.BytesIO(data), filename="till.apk"),
            version_name="0.1.401", version_code=401, notes=None,
            admin=MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=None), db=w.db, platform=None,
        )
        assert out.signing_cert_sha256 == hashlib.sha256(CERT).hexdigest()
        assert out.model_dump(by_alias=True)["signingCertSha256"] == out.signing_cert_sha256

    def test_an_unsigned_apk_still_uploads(self, w):
        out = R.upload_app_release(
            file=UploadFile(file=io.BytesIO(_zip()), filename="till.apk"),
            version_name="0.1.402", version_code=402, notes=None,
            admin=MagicMock(spec=User, role=UserRole.SUPER_ADMIN, id=None), db=w.db, platform=None,
        )
        assert out.signing_cert_sha256 is None


# ── The contract shared with the till (tests/fixtures/device_management_contract.json) ──


class TestContract:
    def test_the_fixture_is_what_the_cloud_sends_and_reads(self):
        from pathlib import Path

        contract = json.loads((Path(__file__).parent / "fixtures" / "device_management_contract.json").read_text("utf-8"))
        assert DM.PACKAGE_NAME == contract["packageName"]
        assert DM.COMPONENT_NAME == contract["componentName"]
        assert DM.ADB_COMMAND == contract["adbCommand"]
        assert {
            "serverUrl": DM.ADMIN_EXTRA_SERVER_URL,
            "shopId": DM.ADMIN_EXTRA_SHOP_ID,
            "shopName": DM.ADMIN_EXTRA_SHOP_NAME,
        } == contract["adminExtras"]
        assert {p: p in DM.SILENT_UPDATE_PATHS for p in DM.UPDATE_PATHS} == contract["updatePaths"]
        assert list(DM.KIOSK_LOCKS) == contract["kioskLocks"]
        assert list(DM.REBOOT_ACK_PHASES) == contract["rebootAckPhases"]
        # The till's block comes back exactly as sent.
        assert DM.clean_block(contract["heartbeatBlock"]) == contract["heartbeatBlock"]
