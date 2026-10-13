"""
"שרת מקומי ייעודי" — an Android device that does not sell (P:/specs/dedicated-local-server.md,
approved 13.10.2026; §10 the owner's decisions, §11 the contract with the device).

The owner: "שרת מקומי נוסף שהוא אינו קופה, ובעצם יכול לנהל את ההדפסות ואת ההזמנות. הוא מחובר לענן,
וכל הקופות נשענות עליו."

* **What it is.** `pos_machines.is_local_server` (set at pairing only, `deviceRole: "local_server"`)
  on a non-fiscal machine: no register number, no shifts, documents, cash or card — every fiscal
  till endpoint answers it 403 `local_server_not_a_till` (app/services/display_devices.py
  `DeviceNotFiscal`). Unlike a display device it is in the shop's LAN group
  (`independent_till.lan_members`) and a valid, *preferred* host: `mainTill`, `tablesHostTill`,
  `printHostTill` and `shopZMasterTill` may name it, and an election that finds it beside a till
  picks it (`host_order`). It is never "independent" and never the subject of a till Z or a shift.
  The host endpoints it needs stay open to it (`require_host_machine`, app/middleware/auth.py).
* **Licensing** (§10.4): never counted as a till license (`counts_as_till_license`).
* **Pairing** (§5): "הוסף מכשיר" → "שרת מקומי" → a code for a shop, Android only. In a shop whose
  work profile says "שרת מקומי: מכשיר ייעודי" (`localServerDevice: "dedicated"`) a super admin's code
  makes it the host at once (`make_host`) — the way the pairing applies the work profile today.
* **Monitoring** (§11.4): its heartbeat's `localServer` block (connected tills, open orders, the
  print queue, the printers) and `lanIdentity` (the key tills verify it by), kept on the machine;
  the device page's "שרת מקומי" card (`card`); remote commands (`command`) reusing the device
  commands — `restart_app`, `upload_logs` — and two of its own, `print_test_page` and
  `clear_print_queue` (with a confirmation).
* **Discovery** (§11.6): what the server announces (`device_block` → `discovery`) and what a till
  checks a discovered server against (`discovery_for` → `lanDiscovery`): its shop, the host the
  cloud named, and a signature by that host's public key.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

ROLE = "local_server"
LABEL = "שרת מקומי"
DEFAULT_NAME = "שרת מקומי"

NOT_A_TILL = "local_server_not_a_till"
NOT_A_TILL_MESSAGE = "שרת מקומי אינו קופה: אין בו מכירות, משמרות, מסמכים, מזומן או אשראי."
ANDROID_ONLY = "local_server_android_only"
ANDROID_ONLY_MESSAGE = (
    "שרת מקומי הוא מכשיר אנדרואיד — אותה אפליקציה, בתפקיד שרת. בחרו פלטפורמה Android."
)

#: Discovery (§11.6).
SERVICE_TYPE = "_r2mpos._tcp"
PROTOCOL = "r2m-lan-v1"
HELLO_PATH = "/lan/v1/hello"
#: How often the server beats (§11.3) — the auto failover's "heard" reads it.
HEARTBEAT_SECONDS = 30
#: The heartbeat's lists are cut to this many entries (never a 422).
MAX_LIST = 50
PRINTER_STATES = ("ok", "offline", "error", "no_paper", "unknown")
#: A status older than this is shown "as of", not as live.
STATUS_FRESH_SECONDS = 300
IDENTITY_ALG = "ES256"
MAX_KEY_BYTES = 512

#: The actions the server's card sends (§11.5): two existing, two of its own.
SERVER_ACTIONS = ("restart_app", "upload_logs", "print_test_page", "clear_print_queue")
SERVER_ONLY_ACTIONS = ("print_test_page", "clear_print_queue")
CLEAR_SCOPES = ("failed", "all")


def _now(now: Optional[datetime] = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _aware(moment: Optional[datetime]) -> Optional[datetime]:
    if moment is None:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    m = _aware(moment)
    return m.isoformat() if m is not None else None


# ── What a machine is ─────────────────────────────────────────────────────────


def is_local_server(machine: Any) -> bool:
    """A machine paired as "שרת מקומי": the flag, on a non-fiscal machine (always so by pairing)."""
    if machine is None:
        return False
    return getattr(machine, "is_local_server", False) is True and getattr(machine, "is_fiscal", True) is False


def counts_as_till_license(machine: Any) -> bool:
    """§10.4: a local server is never counted as a till license (nor is a display device)."""
    return getattr(machine, "is_fiscal", True) is not False


def host_order(machine: Any):
    """
    The order every host election picks in: a local server first (the preferred host — a device
    that does nothing else), then the lowest register number, so every till agrees on one.
    """
    from app.services.main_till import till_order

    return (0 if is_local_server(machine) else 1,) + tuple(till_order(machine))


def servers_of_shop(db: Session, shop_id: Any) -> List[Any]:
    """The shop's active local servers (assigned), by name."""
    from app.models.pos_machine import PairingStatus, POSMachine

    if shop_id is None:
        return []
    sid = shop_id if isinstance(shop_id, uuid.UUID) else uuid.UUID(str(shop_id))
    return (
        db.query(POSMachine)
        .filter(
            POSMachine.shop_id == sid,
            POSMachine.is_active.is_(True),
            POSMachine.pairing_status == PairingStatus.ASSIGNED,
            POSMachine.is_local_server.is_(True),
            POSMachine.is_fiscal.is_(False),
        )
        .order_by(POSMachine.name, POSMachine.id)
        .all()
    )


def ref(machine: Any) -> Optional[Dict[str, Any]]:
    """`till_ref` with the role said, for a local server."""
    from app.services.main_till import till_ref

    out = till_ref(machine)
    if out is not None and is_local_server(machine):
        out["deviceRole"] = ROLE
    return out


# ── Pairing ───────────────────────────────────────────────────────────────────


def platform_refusal(platform: Optional[str], role: Optional[str]) -> Optional[Dict[str, str]]:
    """A local server's code is for Android: 422 body for another platform, else None."""
    from app.services.display_devices import PLATFORM_ANDROID

    if role == ROLE and platform not in (None, PLATFORM_ANDROID):
        return {"detail": ANDROID_ONLY, "message": ANDROID_ONLY_MESSAGE}
    return None


def apply_on_pairing(db: Session, pairing_code: Any, machine: Any, options: Optional[Dict[str, Any]] = None) -> bool:
    """
    A local-server code just paired this (non-fiscal) machine into its shop: its name (the one
    typed, else "שרת מקומי"), and — when the shop's work profile says "שרת מקומי: מכשיר ייעודי" and
    the code is a super admin's — it becomes the host (`make_host`), the way the pairing applies
    the work profile today (anyone else's code: the shop's status waits for a super admin).
    Commits. Never raises: the pairing stands whatever happens here; a refusal is kept on the code
    (`work_config_result`) for the device page. True when it became the host.
    """
    from app.models.pairing_code import PairingCode
    from app.models.shop import Shop
    from app.models.user import User, UserRole
    from app.services.machine_names import is_generated_name

    options = options if isinstance(options, dict) else {}
    try:
        name = options.get("name")
        if name:
            machine.name = name
        elif is_generated_name(getattr(machine, "name", None)):
            machine.name = DEFAULT_NAME
        db.commit()
    except Exception:  # noqa: BLE001 - a name is cosmetic
        db.rollback()
        logger.exception("local server %s: name not set", machine.id)
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    if shop is None or not wants_dedicated(shop):
        return False
    user = db.get(User, pairing_code.distributor_id) if getattr(pairing_code, "distributor_id", None) else None
    if getattr(user, "role", None) != UserRole.SUPER_ADMIN:
        return False
    now = _now()
    code_id = getattr(pairing_code, "id", None)
    notify = None
    try:
        out = make_host(db, user, shop, machine, now=now)
        result = {"applied": True, "changes": out.get("changes") or [], "at": now.isoformat(), "source": "workProfile"}
        notify = out
    except Exception as exc:  # noqa: BLE001 - the pairing stands; the shop's page applies it later
        db.rollback()
        detail = getattr(exc, "detail", None)
        body = getattr(exc, "body", None)
        code = (detail.get("code") if isinstance(detail, dict) else detail) or (
            (body or {}).get("detail") if isinstance(body, dict) else None
        ) or "work_profile_failed"
        message = (detail.get("message") if isinstance(detail, dict) else None) or (
            (body or {}).get("message") if isinstance(body, dict) else None
        ) or "תצורת העבודה של הסניף לא הוחלה על השרת המקומי."
        result = {"applied": False, "detail": str(code), "message": message, "at": now.isoformat(), "source": "workProfile"}
        logger.warning("local server %s: not made the host on pairing (%s)", machine.id, code)
    if code_id is not None:
        code_row = db.get(PairingCode, code_id)
        if code_row is not None:
            code_row.work_config = {"preset": "local_server_host", "fromWorkProfile": True}
            code_row.work_config_result = result
    db.commit()
    if notify is not None:
        after_host_change(db, shop)
    return bool(result.get("applied"))


# ── The work profile: "שרת מקומי: מכשיר ייעודי" ───────────────────────────────


def wants_dedicated(shop: Any) -> bool:
    """The shop's stored work profile says "שרת מקומי: מכשיר ייעודי"."""
    from app.services import work_profile_templates as T

    profile = T.stored(getattr(shop, "settings", None))
    return bool(profile) and profile.get("localServer") is True and profile.get(T.LOCAL_SERVER_DEVICE) == T.DEVICE_DEDICATED


def make_host(db: Session, user: Any, shop: Any, server: Any, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    `server` becomes the shop's host — its main till, so the tables host, the print server and
    the shop Z producer, and "רשת מקומית" on (local mode: it produces the shop Z). A till that
    held the role gives it up in the full move of "העברת שרת מקומי" (the notice to every till, the
    audit, `source: "work_profile"`). The super admin's (the presets' services are). Flushed, not
    committed: the caller commits (and then `after_host_change`). Raises the services' refusals.
    """
    from app.services import lan_server as LS
    from app.services import local_server_switch as LSS
    from app.services.local_shop_z import LocalShopZRefused, ProducerGuard

    now = _now(now)
    if getattr(user, "role", None) is None or not LSS.is_super(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="super_admin_only")
    if not is_local_server(server) or str(server.shop_id) != str(shop.id):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "target_not_in_shop", "message": "השרת המקומי אינו בסניף הזה."},
        )
    reason = LSS.ineligible_reason(db, server, now, require_online=False)
    if reason is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "target_not_eligible", "reason": reason,
                    "message": f"{LSS.till_label(server)}: {LSS.INELIGIBLE[reason]}."},
        )
    from app.services import main_till as MT

    changes: List[str] = []
    moved = None
    main = MT.main_till_of_shop(db, shop.id)
    if main is None or main.id != server.id:
        old = LSS.current_server(db, shop)
        if old is not None and old.id != server.id:
            # A device that serves the shop now gives it up: the full move, the tills told.
            moved = LSS.move_from_work_profile(db, user, shop, server, old, now=now)
            changes.extend(moved.get("moved") or [])
        main = MT.main_till_of_shop(db, shop.id)
        if main is None or main.id != server.id:
            # No host before (or a lone server that held the tables by default): named by its flag.
            guard = ProducerGuard(db, [shop], now=now)
            MT.set_main_till(db, shop, server.id, now=now)
            db.flush()
            try:
                guard.check(user=user)
            except LocalShopZRefused as refused:
                raise HTTPException(
                    status_code=refused.status_code,
                    detail={"code": refused.body.get("detail"), **{k: v for k, v in refused.body.items() if k != "detail"}},
                )
            if "mainTill" not in changes:
                changes.append("mainTill")
    if not bool(getattr(shop, "local_network", False)):
        guard = ProducerGuard(db, [shop], now=now)
        LS.set_local_network(db, user, shop, True, now=now)
        db.flush()
        try:
            guard.check(user=user)
        except LocalShopZRefused as refused:
            raise HTTPException(
                status_code=refused.status_code,
                detail={"code": refused.body.get("detail"), **{k: v for k, v in refused.body.items() if k != "detail"}},
            )
        changes.append("localNetwork")
    db.flush()
    return {"changes": changes, "switch": moved}


def after_host_change(db: Session, shop: Any) -> None:
    """After the commit: every till re-reads its parameters, printers and the tables' host."""
    from app.services import tables as T
    from app.services import till_parameters as TP

    forget_shop(getattr(shop, "id", None))
    try:
        TP.publish_parameters_notify(TP.notify_targets_for_scope(db, "shop", shop.id))
    except Exception:  # noqa: BLE001 - the tills' next sync pulls it anyway
        logger.warning("local server: parameters notify for shop %s failed", getattr(shop, "id", None))
    try:
        T.tables_changed(db, shop.id, tenant_id=shop.tenant_id)
    except Exception:  # noqa: BLE001
        logger.warning("local server: tables notify for shop %s failed", getattr(shop, "id", None))


# ── The heartbeat: what the server reports (§11.4) ────────────────────────────


def _int(value: Any, high: int = 1_000_000_000) -> Optional[int]:
    if isinstance(value, bool):
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if 0 <= n <= high else None


def _text(value: Any, limit: int) -> Optional[str]:
    if value is None or isinstance(value, (dict, list)):
        return None
    text = " ".join(str(value).split())
    return text[:limit] or None


def _uuid_text(value: Any) -> Optional[str]:
    try:
        return str(uuid.UUID(str(value))) if value else None
    except (TypeError, ValueError, AttributeError):
        return None


def clean_status(raw: Any) -> Optional[Dict[str, Any]]:
    """The heartbeat's `localServer` block, field by field — a field that cannot be read is dropped."""
    if not isinstance(raw, dict):
        return None
    out: Dict[str, Any] = {}
    for key in ("connectedTills", "openOrders", "uptimeMs"):
        n = _int(raw.get(key))
        if n is not None:
            out[key] = n
    tills = []
    for t in (raw.get("tills") if isinstance(raw.get("tills"), list) else [])[:MAX_LIST]:
        if not isinstance(t, dict):
            continue
        mid = _uuid_text(t.get("machineId"))
        if mid is None:
            continue
        tills.append({"machineId": mid, "ageMs": _int(t.get("ageMs"))})
    if isinstance(raw.get("tills"), list):
        out["tills"] = tills
    queue = raw.get("printQueue")
    if isinstance(queue, dict):
        out["printQueue"] = {
            "pending": _int(queue.get("pending")) or 0,
            "failed": _int(queue.get("failed")) or 0,
            "oldestPendingAgeMs": _int(queue.get("oldestPendingAgeMs")),
        }
    printers = []
    for p in (raw.get("printers") if isinstance(raw.get("printers"), list) else [])[:MAX_LIST]:
        if not isinstance(p, dict):
            continue
        state = str(p.get("state") or "").strip().lower()
        printers.append({
            "printerId": _uuid_text(p.get("printerId")),
            "name": _text(p.get("name"), 100),
            "state": state if state in PRINTER_STATES else "unknown",
            "message": _text(p.get("message"), 200),
            "lastOkAgeMs": _int(p.get("lastOkAgeMs")),
        })
    if isinstance(raw.get("printers"), list):
        out["printers"] = printers
    return out


def key_id(der: bytes) -> str:
    """The first 16 hex of the key's SHA-256 (§11.4)."""
    return hashlib.sha256(der).hexdigest()[:16]


def clean_identity(raw: Any) -> Optional[Dict[str, Any]]:
    """
    The heartbeat's `lanIdentity`: an EC P-256 public key (SPKI DER, base64) — `{publicKey, alg,
    keyId}` — or None when it is not one (dropped, never a 422).
    """
    if not isinstance(raw, dict):
        return None
    alg = str(raw.get("alg") or IDENTITY_ALG).strip().upper()
    if alg != IDENTITY_ALG:
        return None
    text = raw.get("publicKey")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_KEY_BYTES * 2:
        return None
    try:
        der = base64.b64decode("".join(text.split()), validate=True)
    except (binascii.Error, ValueError):
        return None
    if not der or len(der) > MAX_KEY_BYTES:
        return None
    try:
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.serialization import load_der_public_key

        key = load_der_public_key(der)
        if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
            return None
    except Exception:  # noqa: BLE001 - not a key: dropped
        return None
    return {"publicKey": base64.b64encode(der).decode("ascii"), "alg": IDENTITY_ALG, "keyId": key_id(der)}


def apply_heartbeat(machine: Any, status_block: Any, identity_block: Any, *, now: Optional[datetime] = None) -> None:
    """
    A beat's `localServer` (kept on a local server only) and `lanIdentity` (any device that serves
    the LAN may send one): stored, never failing the beat.
    """
    now = _now(now)
    if status_block is not None and is_local_server(machine):
        cleaned = clean_status(status_block)
        if cleaned is not None:
            machine.local_server_status = cleaned
            machine.local_server_status_at = now
    if identity_block is not None:
        identity = clean_identity(identity_block)
        if identity is not None:
            held = machine.lan_identity if isinstance(getattr(machine, "lan_identity", None), dict) else {}
            if held.get("keyId") != identity["keyId"]:
                if held.get("keyId"):
                    logger.warning(
                        "machine %s: LAN identity replaced (%s -> %s)", machine.id, held.get("keyId"), identity["keyId"],
                    )
                machine.lan_identity = {**identity, "at": now.isoformat()}


def identity_of(machine: Any) -> Dict[str, Any]:
    held = getattr(machine, "lan_identity", None)
    if isinstance(held, dict) and held.get("publicKey") and held.get("keyId"):
        return {"publicKey": held["publicKey"], "keyId": held["keyId"], "at": held.get("at")}
    return {"publicKey": None, "keyId": None, "at": None}


# ── What the cloud tells the devices (§11.3, §11.6) ───────────────────────────


def hosting(db: Session, machine: Any) -> Dict[str, bool]:
    """Which host roles `machine` holds now: the main till, the tables, the printing, the shop Z."""
    from app.models.shop import Shop
    from app.services import local_shop_z as LZ
    from app.services import main_till as MT
    from app.services.printers import print_host_of_shop
    from app.services.tables import tables_host_of_shop

    out = {"mainTill": False, "tables": False, "print": False, "shopZ": False}
    if getattr(machine, "shop_id", None) is None:
        return out
    shop = db.get(Shop, machine.shop_id)
    if shop is None:
        return out
    mid = str(machine.id)
    main = MT.main_till_of_shop(db, shop.id)
    tables = tables_host_of_shop(db, shop.id)
    printer = print_host_of_shop(db, shop.id)
    out["mainTill"] = main is not None and str(main.id) == mid
    out["tables"] = tables is not None and str(tables.id) == mid
    out["print"] = printer is not None and str(printer.id) == mid
    pin = LZ._pin(shop) or LZ.configured_producer(db, shop)
    if pin.get("kind") == LZ.LOCAL:
        out["shopZ"] = str(pin.get("machineId") or "") == mid
    else:
        out["shopZ"] = out["mainTill"] or MT.is_on(MT._params(db, machine).get(MT.SHOP_Z_MASTER_KEY))
    return out


def _lan_port(db: Session, machine: Any) -> int:
    from app.models.printers import DEFAULT_LAN_PORT, KitchenPrintHost

    row = db.query(KitchenPrintHost).filter(KitchenPrintHost.machine_id == machine.id).first()
    return int(row.port) if row is not None and row.port else DEFAULT_LAN_PORT


def device_block(db: Session, machine: Any) -> Optional[Dict[str, Any]]:
    """The server's own `localServer` block (§11.3) — on `machines/me` and its heartbeat; None for any other device."""
    from app.models.shop import Shop
    from app.services import local_shop_z as LZ

    if not is_local_server(machine):
        return None
    held = hosting(db, machine)
    shop = db.get(Shop, machine.shop_id) if machine.shop_id is not None else None
    identity = identity_of(machine)
    shop_id = str(machine.shop_id) if machine.shop_id else None
    return {
        "shopId": shop_id,
        "machineId": str(machine.id),
        "isHost": any(held.values()),
        "hosting": held,
        "localShopZ": bool(held["shopZ"] and shop is not None and LZ.local_mode_of_shop(db, shop)),
        "heartbeatSeconds": HEARTBEAT_SECONDS,
        "discovery": {
            "serviceType": SERVICE_TYPE,
            "instanceName": f"r2m-{machine.id.hex[:8] if isinstance(machine.id, uuid.UUID) else str(machine.id)[:8]}",
            "port": _lan_port(db, machine),
            "txt": {
                "v": "1",
                "shop": shop_id or "",
                "mid": str(machine.id),
                "role": ROLE,
                "kid": identity["keyId"] or "",
            },
        },
        "identity": {"registered": identity["keyId"] is not None, "keyId": identity["keyId"]},
    }


#: The LAN host per shop, kept a few seconds per process: a heartbeat of every till asks.
_HOST_CACHE: Dict[str, Tuple[float, Optional[str]]] = {}
_HOST_CACHE_LOCK = threading.Lock()
HOST_CACHE_SECONDS = 15.0


def forget_shop(shop_id: Any) -> None:
    """The shop's host moved (a switch): look it up again."""
    if shop_id is None:
        return
    with _HOST_CACHE_LOCK:
        _HOST_CACHE.pop(str(shop_id), None)


def _host_id(db: Session, shop_id: Any) -> Optional[str]:
    from app.services.tables import tables_host_of_shop

    key = str(shop_id)
    now = time.monotonic()
    with _HOST_CACHE_LOCK:
        hit = _HOST_CACHE.get(key)
    if hit is not None and now - hit[0] < HOST_CACHE_SECONDS:
        return hit[1]
    host = tables_host_of_shop(db, shop_id)
    value = str(host.id) if host is not None else None
    with _HOST_CACHE_LOCK:
        _HOST_CACHE[key] = (now, value)
    return value


def discovery_for(db: Session, machine: Any, *, cached: bool = True) -> Optional[Dict[str, Any]]:
    """
    `lanDiscovery` (§11.6): the host the cloud named for `machine`'s shop, and the key a
    discovered server must prove it holds — for a till, a kiosk or a local server of the shop's
    LAN group; None without a host, for an independent till or a display device.
    """
    from app.models.pos_machine import POSMachine
    from app.services.display_devices import is_fiscal
    from app.services.independent_till import is_independent
    from app.services.printers import machine_label
    from app.services.tables import tables_host_of_shop

    if getattr(machine, "shop_id", None) is None or is_independent(machine):
        return None
    if not is_fiscal(machine) and not is_local_server(machine):
        return None
    if cached:
        host_id = _host_id(db, machine.shop_id)
        host = db.get(POSMachine, uuid.UUID(host_id)) if host_id else None
    else:
        host = tables_host_of_shop(db, machine.shop_id)
    if host is None:
        return None
    identity = identity_of(host)
    return {
        "protocol": PROTOCOL,
        "serviceType": SERVICE_TYPE,
        "shopId": str(machine.shop_id),
        "host": {
            "machineId": str(host.id),
            "deviceRole": ROLE if is_local_server(host) else "till",
            "name": machine_label(host),
            "publicKey": identity["publicKey"],
            "keyId": identity["keyId"],
        },
    }


def hello_message(shop_id: Any, machine_id: Any, nonce: str) -> bytes:
    """What the host signs for a till's challenge (§11.6): `r2m-lan-hello|v1|shop|machine|nonce`."""
    return f"r2m-lan-hello|v1|{shop_id}|{machine_id}|{nonce}".encode("utf-8")


def host_block_fields(machine: Any) -> Dict[str, Any]:
    """Added to `lanHost` and the print server's block: who the host is, and its key's id."""
    return {"deviceRole": ROLE if is_local_server(machine) else "till", "keyId": identity_of(machine)["keyId"]}


# ── The device page's card (§7, §11.4) ────────────────────────────────────────


def _mirror(machine: Any, now: datetime) -> Dict[str, Any]:
    from app.services.lan_server import host_sync_state

    return host_sync_state(machine, now=now)


def card(db: Session, machine: Any, user: Any = None, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """"שרת מקומי" on the device page: what it serves, its tills, orders, print queue, printers, lag."""
    from app.models.device_command import DeviceCommand
    from app.models.pos_machine import POSMachine
    from app.models.printers import KitchenPrinter
    from app.services import device_commands as DC
    from app.services.machine_status import is_online
    from app.services.printers import machine_label

    now = _now(now)
    report = machine.local_server_status if isinstance(machine.local_server_status, dict) else {}
    at = _aware(machine.local_server_status_at)
    fresh = at is not None and (now - at).total_seconds() <= STATUS_FRESH_SECONDS
    till_rows = report.get("tills") if isinstance(report.get("tills"), list) else []
    ids = []
    for t in till_rows:
        try:
            ids.append(uuid.UUID(t["machineId"]))
        except (KeyError, TypeError, ValueError):
            continue
    names = {str(m.id): m for m in db.query(POSMachine).filter(POSMachine.id.in_(ids)).all()} if ids else {}
    tills = []
    for t in till_rows:
        m = names.get(str(t.get("machineId")))
        tills.append({
            "machineId": t.get("machineId"),
            "name": machine_label(m) if m is not None else None,
            "posNumber": m.pos_number if m is not None else None,
            "ageMs": t.get("ageMs"),
        })
    printer_rows = report.get("printers") if isinstance(report.get("printers"), list) else []
    pids = []
    for p in printer_rows:
        try:
            if p.get("printerId"):
                pids.append(uuid.UUID(p["printerId"]))
        except (TypeError, ValueError):
            continue
    known = {str(p.id): p for p in db.query(KitchenPrinter).filter(KitchenPrinter.id.in_(pids)).all()} if pids else {}
    printers = []
    for p in printer_rows:
        row = known.get(str(p.get("printerId")))
        printers.append({**p, "name": p.get("name") or (row.name if row is not None else None)})
    recent = (
        db.query(DeviceCommand)
        .filter(DeviceCommand.machine_id == machine.id)
        .order_by(DeviceCommand.created_at.desc(), DeviceCommand.id.desc())
        .limit(10)
        .all()
    )
    held = hosting(db, machine)
    identity = identity_of(machine)
    return {
        "machineId": str(machine.id),
        "name": machine.name,
        "shopId": str(machine.shop_id) if machine.shop_id else None,
        "deviceRole": ROLE,
        "online": is_online(machine.last_heartbeat_at, now=now),
        "lastHeartbeatAt": _iso(machine.last_heartbeat_at),
        "appVersion": machine.app_version,
        "serialNumber": machine.serial_number,
        "lanIp": machine.lan_ip,
        "lastIp": machine.last_ip,
        "isHost": any(held.values()),
        "hosting": held,
        "reportedAt": _iso(at),
        "fresh": fresh,
        "connectedTills": report.get("connectedTills"),
        "tills": tills,
        "openOrders": report.get("openOrders"),
        "printQueue": report.get("printQueue") or {"pending": None, "failed": None, "oldestPendingAgeMs": None},
        "printers": printers,
        "uptimeMs": report.get("uptimeMs"),
        "mirror": _mirror(machine, now),
        "identity": {"registered": identity["keyId"] is not None, "keyId": identity["keyId"], "at": identity["at"]},
        "countsAsTillLicense": False,
        "actions": list(SERVER_ACTIONS),
        "commands": [DC.command_out(r) for r in recent],
    }


def shop_servers(db: Session, shop: Any, *, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """The shop page's "שרת מקומי": each server — online, what it hosts, its lag and its queue."""
    from app.services.machine_status import is_online

    now = _now(now)
    out = []
    for m in servers_of_shop(db, shop.id):
        report = m.local_server_status if isinstance(m.local_server_status, dict) else {}
        held = hosting(db, m)
        out.append({
            "machineId": str(m.id),
            "name": m.name,
            "online": is_online(m.last_heartbeat_at, now=now),
            "lastHeartbeatAt": _iso(m.last_heartbeat_at),
            "isHost": any(held.values()),
            "hosting": held,
            "connectedTills": report.get("connectedTills"),
            "openOrders": report.get("openOrders"),
            "printQueue": report.get("printQueue"),
            "mirror": _mirror(m, now),
            "appVersion": m.app_version,
        })
    return out


# ── Remote commands (§11.5) ───────────────────────────────────────────────────


def _bad(code: str, message: str, status_code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def command_params(db: Session, machine: Any, action: str, raw: Optional[Dict[str, Any]], *, confirm: bool) -> Optional[Dict[str, Any]]:
    """
    The parameters of a server command, checked: `upload_logs` {minutes}; `print_test_page`
    {printerId} — a printer of the server's shop; `clear_print_queue` {printerId | null, scope} —
    only with `confirm` (422 `confirm_required`). 422 `invalid_action` for anything else.
    """
    from app.models.printers import KitchenPrinter
    from app.services import device_logs

    raw = raw if isinstance(raw, dict) else {}
    if action not in SERVER_ACTIONS:
        raise _bad("invalid_action", "פעולה לא מוכרת לשרת מקומי.")
    if action == "restart_app":
        return None
    if action == "upload_logs":
        try:
            return device_logs.request_params(raw)
        except ValueError as exc:
            raise _bad("invalid_params", f"טווח הלוגים לא תקין ({exc}).") from exc

    def printer_of(value: Any):
        pid = _uuid_text(value)
        if pid is None:
            return None
        row = db.get(KitchenPrinter, uuid.UUID(pid))
        if row is None or (row.shop_id is not None and str(row.shop_id) != str(machine.shop_id)):
            raise _bad("printer_not_found", "המדפסת לא נמצאה בסניף של השרת.")
        return pid

    if action == "print_test_page":
        pid = printer_of(raw.get("printerId"))
        if pid is None:
            raise _bad("printer_required", "בחרו מדפסת להדפסת דף הבדיקה.")
        return {"printerId": pid}
    # clear_print_queue
    if not confirm:
        raise _bad(
            "confirm_required",
            "ניקוי התור מוחק עבודות הדפסה שעוד לא הודפסו. אשרו את הפעולה כדי לשלוח אותה.",
        )
    scope = str(raw.get("scope") or "failed").strip().lower()
    if scope not in CLEAR_SCOPES:
        raise _bad("invalid_scope", "אפשר לנקות את העבודות שנכשלו (failed) או את כל התור (all).")
    return {"printerId": printer_of(raw.get("printerId")), "scope": scope}


def command(db: Session, user: Any, machine: Any, action: str, params: Optional[Dict[str, Any]], *, confirm: bool = False):
    """One command to the server (the caller checked who, commits and wakes it)."""
    from app.services import device_commands as DC

    if not is_local_server(machine):
        raise _bad("not_a_local_server", "הפקודות האלה נשלחות רק לשרת מקומי.", status.HTTP_409_CONFLICT)
    cleaned = command_params(db, machine, action, params, confirm=confirm)
    return DC.create(db, [machine], action, user=user, params=cleaned)[0]
