"""
"מצב סנכרון של מכשיר" — what a device reports it holds, compared with the cloud
(P:/specs/device-sync-status.md §5.3–§5.7).

**The report.** The heartbeat (`POST /machines/me/heartbeat`) and `POST /sync/{m}/sync-state`
carry `syncState: {<key>: {version, pulledAt, ok, error?, errorSince?}}` and `outbox: {documents,
events, attendance, refunds, oldestAt}`. Each block replaces the stored one whole, in
`pos_machines.device_info` (`syncState`: `{keys, reportedAt}`; `outbox`: the counts and
`reportedAt`). Cleaned value by value (`clean_sync_state`, `clean_outbox`): an unknown key, an
over-long string, an unreadable date is dropped — a report never fails the call that carries it.

**The comparison** (`evaluate`): each reported key against the cloud's current version for that
machine (app/services/sync_versions.py) — `ok: false` is an error, a different version pending,
the same version up to date. A domain of several keys (`settings`) takes the worst of them.
Pending since: the later of the device's last pull and the cloud's change (when known); an error
since its first failure (else the last good pull).

**Stale** — a device online (a heartbeat within `ONLINE_WINDOW_SEC`) with a domain not up to date
for longer than `syncStaleMinutes` (a till parameter, default 30): an item on "בעיות"
(app/services/problems.py, `device_sync_stale`). Only devices whose report could be stale at all
are compared (`could_be_stale`): one that pulled everything within the threshold cannot be.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy.orm import Session

from app.services import sync_versions as V

logger = logging.getLogger(__name__)

#: What a report may hold.
VERSION_MAX = 200
ERROR_MAX = 300
COUNT_MAX = 10_000_000
OUTBOX_KINDS = ("documents", "events", "attendance", "refunds")

#: Statuses, worst first.
UP_TO_DATE = "up_to_date"
PENDING = "pending"
ERROR = "error"
UNKNOWN = "unknown"
NOT_REPORTED = "not_reported"
_RANK = {ERROR: 3, PENDING: 2, UNKNOWN: 1, UP_TO_DATE: 0}

#: More than this many times the threshold (or an error): "בינונית" on "בעיות", else "נמוכה".
MEDIUM_FACTOR = 2


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime]) -> Optional[str]:
    moment = V.utc(moment)
    return moment.isoformat() if moment is not None else None


def parse_moment(value: Any) -> Optional[datetime]:
    """An ISO-8601 moment (a trailing Z too) as aware UTC; None for anything unreadable."""
    if isinstance(value, datetime):
        return V.utc(value)
    if not isinstance(value, str) or not value.strip() or len(value) > 64:
        return None
    try:
        return V.utc(datetime.fromisoformat(value.strip().replace("Z", "+00:00")))
    except ValueError:
        return None


def _text(value: Any, limit: int) -> Optional[str]:
    if value is None or isinstance(value, (dict, list, bool)):
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def _count(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value < 0:  # NaN, negative
        return None
    return int(min(value, COUNT_MAX))


# ── The report ───────────────────────────────────────────────────────────────


def clean_sync_state(raw: Any) -> Optional[Dict[str, Dict[str, Any]]]:
    """
    `syncState` as stored: known keys only, each `{version, pulledAt, ok, error, errorSince}`
    with what could be read. None when the block is not an object (nothing to store).
    """
    if not isinstance(raw, dict):
        return None
    out: Dict[str, Dict[str, Any]] = {}
    for key, entry in raw.items():
        if key not in V.KEYS or not isinstance(entry, dict):
            continue
        version = entry.get("version")
        version = V.normalize(version)[:VERSION_MAX] if isinstance(version, (str, int, float)) and not isinstance(version, bool) else None
        ok = entry.get("ok")
        error = _text(entry.get("error"), ERROR_MAX)
        # `ok` absent: an error says it failed; nothing says it is fine.
        ok = ok if isinstance(ok, bool) else error is None
        out[key] = {
            "version": version or None,
            "pulledAt": _iso(parse_moment(entry.get("pulledAt"))),
            "ok": ok,
            "error": None if ok else error,
            "errorSince": None if ok else _iso(parse_moment(entry.get("errorSince"))),
        }
    return out


def clean_outbox(raw: Any) -> Optional[Dict[str, Any]]:
    """`outbox` as stored: a count per kind (unreadable: absent) and `oldestAt`. None when not an object."""
    if not isinstance(raw, dict):
        return None
    out: Dict[str, Any] = {}
    for kind in OUTBOX_KINDS:
        n = _count(raw.get(kind))
        if n is not None:
            out[kind] = n
    out["oldestAt"] = _iso(parse_moment(raw.get("oldestAt")))
    return out


def apply_report(machine: Any, sync_state: Any, outbox: Any, *, now: Optional[datetime] = None) -> bool:
    """
    Store the report in `machine.device_info` (a new dict, so the JSON column sees the change);
    what is absent or not an object is left as it was. Whether anything was stored. Never raises.
    """
    try:
        now = V.utc(now) or _now()
        keys = clean_sync_state(sync_state)
        box = clean_outbox(outbox)
        if keys is None and box is None:
            return False
        info = dict(machine.device_info) if isinstance(machine.device_info, dict) else {}
        if keys is not None:
            info["syncState"] = {"keys": keys, "reportedAt": now.isoformat()}
        if box is not None:
            info["outbox"] = {**box, "reportedAt": now.isoformat()}
        machine.device_info = info
        return True
    except Exception:  # noqa: BLE001 - a report never fails the heartbeat carrying it
        logger.exception("sync state not stored for %s", getattr(machine, "id", None))
        return False


def reported(machine: Any) -> Tuple[Dict[str, Dict[str, Any]], Optional[datetime]]:
    """The stored keys and when they were reported ({} and None: never)."""
    info = machine.device_info if isinstance(getattr(machine, "device_info", None), dict) else {}
    block = info.get("syncState") if isinstance(info.get("syncState"), dict) else {}
    keys = block.get("keys") if isinstance(block.get("keys"), dict) else {}
    return {k: v for k, v in keys.items() if k in V.KEYS and isinstance(v, dict)}, parse_moment(block.get("reportedAt"))


def outbox_out(machine: Any) -> Optional[Dict[str, Any]]:
    info = machine.device_info if isinstance(getattr(machine, "device_info", None), dict) else {}
    box = info.get("outbox")
    if not isinstance(box, dict):
        return None
    counts = {kind: _count(box.get(kind)) or 0 for kind in OUTBOX_KINDS}
    return {
        **counts,
        "total": sum(counts.values()),
        "oldestAt": _iso(parse_moment(box.get("oldestAt"))),
        "reportedAt": _iso(parse_moment(box.get("reportedAt"))),
    }


# ── The comparison ───────────────────────────────────────────────────────────


def key_status(entry: Dict[str, Any], cloud: Optional[V.CloudVersion]) -> str:
    if entry.get("ok") is False:
        return ERROR
    if cloud is None:
        return UNKNOWN
    return UP_TO_DATE if V.normalize(entry.get("version")) == V.normalize(cloud.version) else PENDING


def key_since(status: str, entry: Dict[str, Any], cloud: Optional[V.CloudVersion]) -> Optional[datetime]:
    """Since when the key has not been up to date (None: up to date, or not known)."""
    pulled = parse_moment(entry.get("pulledAt"))
    if status == ERROR:
        return parse_moment(entry.get("errorSince")) or pulled
    if status == PENDING:
        changed = cloud.changed_at if cloud is not None else None
        return V.latest([pulled, changed])
    return None


def worst(statuses: Iterable[str]) -> str:
    listed = list(statuses)
    if not listed:
        return UNKNOWN
    top = max(listed, key=lambda s: _RANK.get(s, 0))
    if top == UNKNOWN and any(s == UP_TO_DATE for s in listed):
        return UP_TO_DATE
    return top


def threshold_of(minutes: Optional[int]) -> int:
    from app.services.till_parameters import (
        SYNC_STALE_MINUTES_DEFAULT,
        SYNC_STALE_MINUTES_MAX,
        SYNC_STALE_MINUTES_MIN,
    )

    if isinstance(minutes, bool) or not isinstance(minutes, (int, float)):
        return SYNC_STALE_MINUTES_DEFAULT
    return int(min(max(minutes, SYNC_STALE_MINUTES_MIN), SYNC_STALE_MINUTES_MAX))


def evaluate(
    ctx: V.VersionContext,
    machine: Any,
    *,
    now: Optional[datetime] = None,
    stale_minutes: Optional[int] = None,
) -> Dict[str, Any]:
    """`GET /machines/{id}/sync-status`'s answer for one device (P:/specs/device-sync-status.md §5.7)."""
    from app.services.machine_status import is_online

    now = V.utc(now) or _now()
    threshold = threshold_of(stale_minutes)
    keys, reported_at = reported(machine)
    online = is_online(getattr(machine, "last_heartbeat_at", None), now=now)
    out: Dict[str, Any] = {
        "machineId": str(machine.id),
        "online": online,
        "reported": bool(keys),
        "reportedAt": _iso(reported_at),
        "status": NOT_REPORTED,
        "pendingCount": 0,
        "errorCount": 0,
        "stale": False,
        "staleSince": None,
        "staleMinutes": threshold,
        "domains": [],
        "outbox": outbox_out(machine),
    }
    if not keys:
        return out
    cloud = ctx.many(machine, list(keys))
    domains: List[Dict[str, Any]] = []
    for domain, label, domain_keys in V.DOMAINS:
        rows = []
        for key in domain_keys:
            entry = keys.get(key)
            if entry is None:
                continue
            current = cloud.get(key)
            status = key_status(entry, current)
            since = key_since(status, entry, current)
            rows.append({
                "key": key,
                "label": V.KEY_LABELS.get(key, key),
                "status": status,
                "version": entry.get("version"),
                "cloudVersion": current.version if current is not None else None,
                "pulledAt": _iso(parse_moment(entry.get("pulledAt"))),
                "changedAt": _iso(current.changed_at) if current is not None else None,
                "since": _iso(since),
                "error": entry.get("error"),
            })
        if not rows:
            continue
        status = worst(r["status"] for r in rows)
        pulled = [parse_moment(r["pulledAt"]) for r in rows]
        sinces = [parse_moment(r["since"]) for r in rows if r["status"] in (PENDING, ERROR) and r["since"]]
        since = min(sinces) if sinces else None
        stale = bool(
            online and status in (PENDING, ERROR) and since is not None
            and now - since > timedelta(minutes=threshold)
        )
        domains.append({
            "domain": domain,
            "label": label,
            "status": status,
            # The oldest of its keys' last pulls: what the domain as a whole is as fresh as.
            "pulledAt": _iso(min(p for p in pulled if p is not None)) if any(p is not None for p in pulled) else None,
            "changedAt": _iso(V.latest(parse_moment(r["changedAt"]) for r in rows)),
            "pendingSince": _iso(since),
            "error": next((r["error"] for r in rows if r["status"] == ERROR and r["error"]), None),
            "stale": stale,
            "keys": rows,
        })
    out["domains"] = domains
    # "unknown" only when the cloud could work out none of what the device reported.
    out["status"] = worst(d["status"] for d in domains) if domains else NOT_REPORTED
    out["pendingCount"] = sum(1 for d in domains if d["status"] == PENDING)
    out["errorCount"] = sum(1 for d in domains if d["status"] == ERROR)
    stale_since = [parse_moment(d["pendingSince"]) for d in domains if d["stale"]]
    out["stale"] = bool(stale_since)
    out["staleSince"] = _iso(min(stale_since)) if stale_since else None
    return out


# ── The threshold, for many devices at once ──────────────────────────────────


def stale_minutes_by_machine(db: Session, machines: Sequence[Any]) -> Dict[str, int]:
    """
    `syncStaleMinutes` per device, resolved till → area → shop → company → default, in three
    queries whatever the number of devices.
    """
    from app.models.shop import Shop
    from app.models.till_parameter import TillParameter, TillParameterValue
    from app.services import till_parameters as TP

    out = {str(m.id): TP.SYNC_STALE_MINUTES_DEFAULT for m in machines}
    if not machines:
        return out
    try:
        param = db.query(TillParameter).filter(TillParameter.key == TP.SYNC_STALE_MINUTES_KEY).first()
        if param is None:
            return out
        shop_ids = {m.shop_id for m in machines if m.shop_id is not None}
        companies = {
            sid: cid for sid, cid in db.query(Shop.id, Shop.company_id).filter(Shop.id.in_(list(shop_ids))).all()
        } if shop_ids else {}
        scope_ids = set()
        for m in machines:
            scope_ids.update(x for x in (m.id, getattr(m, "area_id", None), m.shop_id, companies.get(m.shop_id)) if x is not None)
        values = (
            db.query(TillParameterValue)
            .filter(TillParameterValue.parameter_id == param.id, TillParameterValue.scope_id.in_(list(scope_ids)))
            .all()
        )
        for m in machines:
            chain = TP.TillScopeChain(
                machine_id=m.id, area_id=getattr(m, "area_id", None), shop_id=m.shop_id,
                company_id=companies.get(m.shop_id),
            )
            value = TP.resolve_till_parameters([param], values, chain).parameters.get(TP.SYNC_STALE_MINUTES_KEY)
            out[str(m.id)] = threshold_of(value)
    except Exception:  # noqa: BLE001 - the default, never a failed page
        logger.exception("syncStaleMinutes not resolved")
    return out


# ── "בעיות" ──────────────────────────────────────────────────────────────────


def could_be_stale(machine: Any, threshold_minutes: int, now: datetime) -> bool:
    """
    Whether the device's report could show it stale at all — without asking the cloud's versions:
    online, and some key failing or not pulled within the threshold (a key pulled since cannot
    have been pending for longer).
    """
    from app.services.machine_status import is_online

    keys, _ = reported(machine)
    if not keys or not is_online(getattr(machine, "last_heartbeat_at", None), now=now):
        return False
    limit = now - timedelta(minutes=threshold_minutes)
    for entry in keys.values():
        if entry.get("ok") is False:
            return True
        pulled = parse_moment(entry.get("pulledAt"))
        if pulled is None or pulled < limit:
            return True
    return False


def stale_devices(db: Session, machines: Sequence[Any], *, now: Optional[datetime] = None) -> List[Tuple[Any, Dict[str, Any]]]:
    """(device, its evaluation) for every device of `machines` stale now (the problems screen)."""
    now = V.utc(now) or _now()
    reporting = [m for m in machines if reported(m)[0]]
    if not reporting:
        return []
    thresholds = stale_minutes_by_machine(db, reporting)
    ctx = V.VersionContext(db)
    out = []
    for m in reporting:
        threshold = thresholds.get(str(m.id))
        if not could_be_stale(m, threshold_of(threshold), now):
            continue
        result = evaluate(ctx, m, now=now, stale_minutes=threshold)
        if result["stale"]:
            out.append((m, result))
    return out


def severity_of(result: Dict[str, Any], now: datetime) -> str:
    """"בינונית" with an error, or stale for more than `MEDIUM_FACTOR` × the threshold; else "נמוכה"."""
    if result.get("errorCount"):
        return "medium"
    since = parse_moment(result.get("staleSince"))
    limit = timedelta(minutes=(result.get("staleMinutes") or threshold_of(None)) * MEDIUM_FACTOR)
    return "medium" if since is not None and now - since > limit else "low"


def problem_detail(result: Dict[str, Any]) -> str:
    """"קטלוג, פרמטרים ממתינים · הגדרות: HTTP 500" — what is behind, in a line."""
    pending = [d["label"] for d in result.get("domains") or [] if d.get("stale") and d["status"] == PENDING]
    errors = [d for d in result.get("domains") or [] if d.get("stale") and d["status"] == ERROR]
    parts = []
    if pending:
        parts.append(", ".join(pending) + (" ממתין לעדכון" if len(pending) == 1 else " ממתינים לעדכון"))
    for d in errors:
        parts.append(f"{d['label']}: {d['error']}" if d.get("error") else f"{d['label']}: שגיאה")
    return " · ".join(parts)
