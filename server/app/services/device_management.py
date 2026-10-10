"""
Device owner, silent updates, factory-reset (QR) provisioning and the cloud reboot
(docs/SPEC_UPDATES.md §5; the owner, 2026-10-07: "אני רוצה שתעדכן ספריות לבד כשאנחנו מוסיפים
פיצ'ר חדש, אני לא רוצה לבקש אישור מהאנדרואיד").

* **Status** — every heartbeat may carry a `deviceManagement` block (pos-android
  system/DeviceManagement.kt): whether the app is the device owner, which path its updates take
  (`updatePath`: device_owner / self_update / urovo / pax — silent; tap — someone confirms on
  screen), the Android version, how its kiosk lock holds (full / pinned / none), what it granted
  itself as the owner, and a technician's release of the device owner ("שחרור בעלות מכשיר",
  when and by whom). Cleaned here key by key — never a 422 — and kept whole on the machine.
* **QR provisioning** — the Android Enterprise QR for a factory-reset device: the app as device
  owner (`COMPONENT_NAME`), downloaded from the cloud by a short-lived signed token (no auth header
  is possible during setup; `make_apk_token` / `read_apk_token`), checked by the device against the
  SHA-256 of the release's signing certificate (app/services/apk_signing.py). The release is the
  one assigned to the shop (or to the till), else the newest Android one.
* **Reboot** — the dashboard's "הפעל מחדש", for a device-owner till only: waits on
  `pos_machines.reboot_request`, handed over on the heartbeat (`pendingReboot`), and the till acks
  it (deferred while a sale, payment or card operation is open; rebooting; refused). Expires after
  `REBOOT_TTL` so a till that was busy all evening does not restart in the morning rush.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.config import get_settings

logger = logging.getLogger(__name__)

# ── The heartbeat block ──────────────────────────────────────────────────────

#: How an update gets in. The first four need nobody at the screen.
UPDATE_PATHS = ("device_owner", "self_update", "urovo", "pax", "tap")
SILENT_UPDATE_PATHS = frozenset({"device_owner", "self_update", "urovo", "pax"})
#: How the kiosk lock holds now: Android's full lock task (device owner), app pinning, or none.
KIOSK_LOCKS = ("full", "pinned", "none")
PROVISIONED_BY = ("qr", "adb")
VENDOR_INSTALLERS = ("urovo", "pax")

_PERMISSIONS_MAX = 24
_PERMISSION = re.compile(r"^[A-Za-z0-9_.]{1,100}$")


def _str(value: Any, max_len: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:max_len] if text else None


def _bool(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _int(value: Any, lo: int, hi: int) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if lo <= value <= hi else None


def _choice(value: Any, choices) -> Optional[str]:
    text = _str(value, 32)
    if text is None:
        return None
    text = text.lower()
    return text if text in choices else None


def _permissions(value: Any) -> Optional[List[str]]:
    if not isinstance(value, list):
        return None
    out: List[str] = []
    for item in value[:_PERMISSIONS_MAX]:
        if isinstance(item, str) and _PERMISSION.match(item) and item not in out:
            out.append(item)
    return out


def clean_block(block: Any) -> Optional[Dict[str, Any]]:
    """
    The block as stored: known keys only, each typed and cut. `silentUpdate` follows
    `updatePath` when the till names one (a till never says "silent" over a path that is not).
    Never raises: it rides on the heartbeat, which must never fail.
    """
    if hasattr(block, "model_dump"):
        block = block.model_dump(by_alias=True, exclude_none=True)
    if not isinstance(block, dict):
        return None
    path = _choice(block.get("updatePath"), UPDATE_PATHS)
    silent = (path in SILENT_UPDATE_PATHS) if path is not None else _bool(block.get("silentUpdate"))
    out = {
        "deviceOwner": _bool(block.get("deviceOwner")),
        "silentUpdate": silent,
        "updatePath": path,
        "sdk": _int(block.get("sdk"), 1, 99),
        "canRequestInstalls": _bool(block.get("canRequestInstalls")),
        "kioskLock": _choice(block.get("kioskLock"), KIOSK_LOCKS),
        "lockTaskPermitted": _bool(block.get("lockTaskPermitted")),
        "vendorInstaller": _choice(block.get("vendorInstaller"), VENDOR_INSTALLERS),
        "permissionsGranted": _permissions(block.get("permissionsGranted")),
        "permissionsMissing": _permissions(block.get("permissionsMissing")),
        "provisionedBy": _choice(block.get("provisionedBy"), PROVISIONED_BY),
        "ownerReleasedAt": _str(block.get("ownerReleasedAt"), 40),
        "ownerReleasedBy": _str(block.get("ownerReleasedBy"), 80),
        "ownerSessionFailed": _bool(block.get("ownerSessionFailed")),
    }
    cleaned = {k: v for k, v in out.items() if v is not None}
    return cleaned or None


def apply_heartbeat(machine: Any, body: Any, *, now: Optional[datetime] = None) -> None:
    """The beat's `deviceManagement` block onto the machine. Absent: as it was. Never raises."""
    try:
        block = clean_block(getattr(body, "device_management", None)) if body is not None else None
        if block is None:
            return
        before = getattr(machine, "device_management", None) or {}
        if before.get("deviceOwner") is True and block.get("deviceOwner") is False:
            logger.warning(
                "machine %s is no longer the device owner (released %s by %s)",
                getattr(machine, "id", None), block.get("ownerReleasedAt") or "?", block.get("ownerReleasedBy") or "?",
            )
        elif before.get("deviceOwner") is not True and block.get("deviceOwner") is True:
            logger.info("machine %s reports it is the device owner (%s)", getattr(machine, "id", None),
                        block.get("provisionedBy") or "provisioned")
        machine.device_management = block
        machine.device_management_reported_at = now or datetime.now(timezone.utc)
    except Exception:  # noqa: BLE001 - a status block never fails a heartbeat
        logger.exception("device management block not applied for %s", getattr(machine, "id", None))


def silent_update_status(block: Optional[Dict[str, Any]]) -> Optional[str]:
    """"silent" / "tap" — or None while the till has not said (an older build)."""
    if not block:
        return None
    silent = block.get("silentUpdate")
    if silent is None:
        return None
    return "silent" if silent else "tap"


def machine_fields(machine: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """The machine page's and the list's fields."""
    return {
        "deviceManagement": getattr(machine, "device_management", None),
        "deviceManagementReportedAt": getattr(machine, "device_management_reported_at", None),
        "rebootRequest": reboot_request_out(getattr(machine, "reboot_request", None), now=now),
    }


def rollout_fields(machine: Any) -> Dict[str, Any]:
    """The app-release rollout row's "עדכון שקט" columns."""
    block = getattr(machine, "device_management", None) or {}
    return {
        "device_owner": block.get("deviceOwner"),
        "silent_update": block.get("silentUpdate"),
        "update_path": block.get("updatePath"),
        "kiosk_lock": block.get("kioskLock"),
        "device_management_reported_at": getattr(machine, "device_management_reported_at", None),
    }


# ── Reboot ───────────────────────────────────────────────────────────────────

REBOOT_TTL = timedelta(minutes=30)
REBOOT_STATUSES = ("pending", "deferred", "rebooting", "refused", "expired", "cancelled")
REBOOT_PENDING = ("pending", "deferred")
REBOOT_ACK_PHASES = ("deferred", "rebooting", "refused")


class RebootRefused(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _iso(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse(text: Any) -> Optional[datetime]:
    if not isinstance(text, str) or not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _expired(req: Dict[str, Any], now: datetime) -> bool:
    at = _parse(req.get("requestedAt"))
    return at is not None and now - at > REBOOT_TTL


def reboot_request_out(req: Any, *, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The stored request as the dashboard reads it, a lapsed one shown as `expired`."""
    if not isinstance(req, dict) or not req.get("id"):
        return None
    now = now or datetime.now(timezone.utc)
    out = dict(req)
    if out.get("status") in REBOOT_PENDING and _expired(out, now):
        out["status"] = "expired"
    return out


def _who(user: Any) -> Optional[str]:
    for attr in ("full_name", "name", "email"):
        value = getattr(user, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()[:80]
    return None


def request_reboot(machine: Any, user: Any, *, now: Optional[datetime] = None) -> Tuple[Dict[str, Any], bool]:
    """
    `(request, created)` — the one already waiting on a second click. Refused (`RebootRefused`):
    `409 machine_not_assigned`, `409 reboot_android_only` (a Windows device), `409
    reboot_needs_device_owner` (the till has not said it is the device owner — Android lets only
    the device owner restart the device).
    """
    now = now or datetime.now(timezone.utc)
    status_value = getattr(getattr(machine, "pairing_status", None), "value", getattr(machine, "pairing_status", None))
    if status_value != "assigned":
        raise RebootRefused(409, "machine_not_assigned")
    if (getattr(machine, "device_info", None) or {}).get("platform") == "windows":
        raise RebootRefused(409, "reboot_android_only")
    block = getattr(machine, "device_management", None) or {}
    if block.get("deviceOwner") is not True:
        raise RebootRefused(409, "reboot_needs_device_owner")
    current = getattr(machine, "reboot_request", None)
    if isinstance(current, dict) and current.get("status") in REBOOT_PENDING and not _expired(current, now):
        return dict(current), False
    req = {
        "id": str(uuid.uuid4()),
        "status": "pending",
        "requestedAt": _iso(now),
        "requestedBy": _who(user),
        "updatedAt": _iso(now),
        "reason": None,
    }
    machine.reboot_request = req
    return dict(req), True


def cancel_reboot(machine: Any, *, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """Withdraw a waiting request (`409 reboot_not_pending` once it has ended)."""
    now = now or datetime.now(timezone.utc)
    current = getattr(machine, "reboot_request", None)
    if not isinstance(current, dict) or current.get("status") not in REBOOT_PENDING or _expired(current, now):
        raise RebootRefused(409, "reboot_not_pending")
    machine.reboot_request = {**current, "status": "cancelled", "updatedAt": _iso(now)}
    return machine.reboot_request


def take_pending_reboot(machine: Any, *, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The heartbeat's `pendingReboot` — while a request waits; a lapsed one is marked expired."""
    now = now or datetime.now(timezone.utc)
    current = getattr(machine, "reboot_request", None)
    if not isinstance(current, dict) or current.get("status") not in REBOOT_PENDING:
        return None
    if _expired(current, now):
        machine.reboot_request = {**current, "status": "expired", "updatedAt": _iso(now)}
        return None
    return {"requestId": current.get("id"), "requestedAt": current.get("requestedAt"), "requestedBy": current.get("requestedBy")}


def apply_reboot_ack(
    machine: Any, request_id: Any, phase: str, reason: Optional[str] = None, *, now: Optional[datetime] = None
) -> Dict[str, Any]:
    """
    The till's answer: `deferred` (busy — a sale, a payment, a card on the terminal; asked again
    on the next beat), `rebooting` (done: nothing more is handed over), `refused` (not the device
    owner any more, or Android said no). `404 reboot_request_not_found` for another id; an ended
    request is answered as it is.
    """
    now = now or datetime.now(timezone.utc)
    if phase not in REBOOT_ACK_PHASES:
        raise RebootRefused(422, "invalid_phase")
    current = getattr(machine, "reboot_request", None)
    if not isinstance(current, dict) or str(current.get("id")) != str(request_id):
        raise RebootRefused(404, "reboot_request_not_found")
    if current.get("status") not in REBOOT_PENDING:
        return dict(current)
    updated = {**current, "status": phase, "updatedAt": _iso(now), "reason": _str(reason, 200)}
    if phase == "rebooting":
        updated["rebootingAt"] = _iso(now)
    machine.reboot_request = updated
    logger.info("machine %s reboot %s: %s %s", getattr(machine, "id", None), request_id, phase, reason or "")
    return dict(updated)


# ── QR provisioning ──────────────────────────────────────────────────────────

#: The app's device admin receiver (pos-android system/PosDeviceAdmin.kt).
PACKAGE_NAME = "il.co.runnersys.pos"
COMPONENT_NAME = "il.co.runnersys.pos/.system.PosDeviceAdmin"
ADB_COMMAND = f"adb shell dpm set-device-owner {COMPONENT_NAME}"

_EXTRA = "android.app.extra."
EXTRA_COMPONENT = _EXTRA + "PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME"
EXTRA_DOWNLOAD = _EXTRA + "PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION"
EXTRA_CHECKSUM = _EXTRA + "PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM"
EXTRA_SYSTEM_APPS = _EXTRA + "PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED"
EXTRA_SKIP_ENCRYPTION = _EXTRA + "PROVISIONING_SKIP_ENCRYPTION"
EXTRA_LOCALE = _EXTRA + "PROVISIONING_LOCALE"
EXTRA_TIME_ZONE = _EXTRA + "PROVISIONING_TIME_ZONE"
EXTRA_ADMIN_BUNDLE = _EXTRA + "PROVISIONING_ADMIN_EXTRAS_BUNDLE"
EXTRA_WIFI_SSID = _EXTRA + "PROVISIONING_WIFI_SSID"
EXTRA_WIFI_PASSWORD = _EXTRA + "PROVISIONING_WIFI_PASSWORD"
EXTRA_WIFI_SECURITY = _EXTRA + "PROVISIONING_WIFI_SECURITY_TYPE"
EXTRA_WIFI_HIDDEN = _EXTRA + "PROVISIONING_WIFI_HIDDEN"

#: What the app reads from the admin extras bundle after provisioning (pos-android
#: domain/DeviceManagement.kt ProvisioningExtras): the cloud it pairs with, and the shop.
ADMIN_EXTRA_SERVER_URL = "il.co.runnersys.pos.SERVER_URL"
ADMIN_EXTRA_SHOP_ID = "il.co.runnersys.pos.SHOP_ID"
ADMIN_EXTRA_SHOP_NAME = "il.co.runnersys.pos.SHOP_NAME"

APK_TOKEN_HOURS_DEFAULT = 24
APK_TOKEN_HOURS_MAX = 72
APK_PATH = "/device-management/provisioning/apk"


class ApkTokenInvalid(Exception):
    pass


class ApkTokenExpired(Exception):
    pass


def _token_key() -> bytes:
    secret = (get_settings().jwt_secret_key or "").encode("utf-8")
    # Its own key: a provisioning link can never be read as, or forged into, anything else.
    return hashlib.sha256(b"r2m-apk-provisioning:" + secret).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def make_apk_token(release_id: Any, expires_at: datetime) -> str:
    """`<release hex>.<expiry, hex epoch>.<HMAC-SHA256, 16 bytes>` — short, so the QR stays small."""
    body = f"{uuid.UUID(str(release_id)).hex}.{int(expires_at.timestamp()):x}"
    sig = hmac.new(_token_key(), body.encode("ascii"), hashlib.sha256).digest()[:16]
    return f"{body}.{_b64(sig)}"


def read_apk_token(token: str, *, now: Optional[datetime] = None) -> uuid.UUID:
    """The release a token names. `ApkTokenInvalid` (forged, malformed), `ApkTokenExpired`."""
    now = now or datetime.now(timezone.utc)
    parts = (token or "").strip().split(".")
    if len(parts) != 3:
        raise ApkTokenInvalid()
    rid, exp, sig = parts
    body = f"{rid}.{exp}"
    want = _b64(hmac.new(_token_key(), body.encode("ascii"), hashlib.sha256).digest()[:16])
    if not hmac.compare_digest(want, sig):
        raise ApkTokenInvalid()
    try:
        release_id = uuid.UUID(hex=rid)
        expires = datetime.fromtimestamp(int(exp, 16), tz=timezone.utc)
    except (ValueError, OverflowError):
        raise ApkTokenInvalid()
    if now > expires:
        raise ApkTokenExpired()
    return release_id


def public_api_base(request: Any) -> str:
    """
    The cloud's own address as a device outside reaches it: `PUBLIC_API_BASE_URL` when set,
    else the request's, made https when the edge says the request was (Fly terminates TLS).
    """
    configured = (os.getenv("PUBLIC_API_BASE_URL") or "").strip().rstrip("/")
    if configured:
        return configured
    base = str(getattr(request, "base_url", "") or "").rstrip("/")
    try:
        proto = request.headers.get("x-forwarded-proto") or request.headers.get("fly-forwarded-proto")
    except Exception:  # noqa: BLE001 - a stand-in request
        proto = None
    if proto and proto.lower() == "https" and base.startswith("http://"):
        base = "https://" + base[len("http://"):]
    return base


def download_url_warnings(url: str) -> List[str]:
    """What stops a factory-reset device from reaching the APK: "localhost", "http"."""
    out: List[str] = []
    host = re.sub(r"^[a-z]+://", "", url.lower()).split("/", 1)[0].rsplit(":", 1)[0]
    if host in ("localhost", "127.0.0.1", "[::1]", "::1") or host.endswith(".localhost"):
        out.append("localhost")
    if url.lower().startswith("http://"):
        out.append("http")
    return out


def provisioning_payload(
    *,
    download_url: str,
    signature_checksum: str,
    server_url: Optional[str] = None,
    shop_id: Any = None,
    shop_name: Optional[str] = None,
    locale: Optional[str] = "he_IL",
    time_zone: Optional[str] = "Asia/Jerusalem",
    skip_encryption: bool = False,
) -> Dict[str, Any]:
    """
    The QR's JSON (Android Enterprise, Android 7+). Wi-Fi is added on the dashboard, in the
    browser (client/src/lib/deviceManagement.ts `withWifi`) — its password never reaches here.
    """
    payload: Dict[str, Any] = {
        EXTRA_COMPONENT: COMPONENT_NAME,
        EXTRA_DOWNLOAD: download_url,
        EXTRA_CHECKSUM: signature_checksum,
        EXTRA_SYSTEM_APPS: True,
    }
    if skip_encryption:
        payload[EXTRA_SKIP_ENCRYPTION] = True
    if locale:
        payload[EXTRA_LOCALE] = locale
    if time_zone:
        payload[EXTRA_TIME_ZONE] = time_zone
    extras: Dict[str, Any] = {}
    if server_url:
        extras[ADMIN_EXTRA_SERVER_URL] = server_url
    if shop_id is not None:
        extras[ADMIN_EXTRA_SHOP_ID] = str(shop_id)
    if shop_name:
        extras[ADMIN_EXTRA_SHOP_NAME] = shop_name[:80]
    if extras:
        payload[EXTRA_ADMIN_BUNDLE] = extras
    return payload


def apk_token_expiry(valid_hours: Optional[int], *, now: Optional[datetime] = None) -> datetime:
    hours = APK_TOKEN_HOURS_DEFAULT if valid_hours is None else int(valid_hours)
    hours = max(1, min(APK_TOKEN_HOURS_MAX, hours))
    return (now or datetime.now(timezone.utc)) + timedelta(hours=hours)


def is_debug_certificate(cert_der: bytes) -> bool:
    """The build PC's Android debug key ("CN=Android Debug") — never a key to provision with."""
    return b"Android Debug" in (cert_der or b"")
