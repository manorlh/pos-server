"""
Remote app updates ("עדכוני גרסה"): which release a device gets, and who to tell.

Two platforms: the Android till app (`android`, an APK) and the Windows app
(`windows`, an NSIS installer). A device only ever resolves releases of its own
platform — the `platform` query of `GET /sync/{id}/app-update` (absent = android, so the
till's original call is unchanged); for the dashboard `machine_platform` (the pairing's
`device_info.platform`). Android and Windows assignments never interfere.

A super admin uploads a release (`AppRelease`) and sends it to targets
(`AppReleaseAssignment`). A device takes the live assignment of the most specific level
that has one:

    the device itself → its area → its shop → the shop's company → its tenant

and within one level the newest. Cancelled assignments, retired releases, releases of
the other platform and assignments whose rollout stage leaves the device out
(`in_rollout_stage`) do not count — resolution simply goes on to the next newest at the
level, then to the less specific levels, so an older shop-level release keeps the rest
of the shop while a new one is staged.

The device is then offered that release only if it is not what it already runs and is
not a downgrade (`offer_for`) — Android refuses to install a lower versionCode over a
higher one, and a till must never be sent round that loop. A Windows assignment may
`allow_downgrade` (a rollback); an Android rollback is a rebuild of the old code with a
higher versionCode.

`resolve_assignment` is a pure function over plain rows, so the order is tested without
a database; `resolved_for_machine` only gathers those rows for one device.
"""
from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.app_release import AppRelease, AppReleaseAssignment
from app.models.company import Company
from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tenant import Tenant
from app.services.ably_notify import publish_settings_notify
from app.services.areas import as_utc
from app.services.till_parameters import as_uuid

#: The Ably `settings` notify reason after an assignment changes. Any `settings` event
#: makes the till sync now, and every sync asks `/sync/{id}/app-update`.
NOTIFY_REASON = "app_update_assigned"

#: Most specific first — the order a till resolves in.
_PRECEDENCE = ("machine", "area", "shop", "company", "tenant")

PLATFORM_ANDROID = "android"
PLATFORM_WINDOWS = "windows"
PLATFORMS = (PLATFORM_ANDROID, PLATFORM_WINDOWS)

#: A Windows version name: "a.b.c", an optional "-pre" / "+build" suffix ignored.
_WINDOWS_VERSION = re.compile(r"^\s*(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$")
#: The version in an installer's file name: `R2M-Kiosk-0.2.0-setup.exe`.
_INSTALLER_NAME = re.compile(r"[-_ ](\d+\.\d+\.\d+)-setup\.exe$", re.IGNORECASE)
_INT32_MAX = 2_147_483_647
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


# ── Platforms and versions ───────────────────────────────────────────────────


def normalize_platform(value: Optional[str]) -> str:
    """"android" for nothing; else the platform lower-cased. `ValueError` for an unknown one."""
    if value is None or not str(value).strip():
        return PLATFORM_ANDROID
    platform = str(value).strip().lower()
    if platform not in PLATFORMS:
        raise ValueError(f"unknown platform {value!r}")
    return platform


def release_platform(release: Any) -> str:
    return getattr(release, "platform", None) or PLATFORM_ANDROID


def machine_platform(machine: Any) -> str:
    """'windows' when the device said so at pairing (`device_info.platform`), else 'android'."""
    info = getattr(machine, "device_info", None)
    if isinstance(info, dict) and str(info.get("platform") or "").strip().lower() == PLATFORM_WINDOWS:
        return PLATFORM_WINDOWS
    return PLATFORM_ANDROID


def windows_version_code(version_name: str) -> int:
    """
    The Windows app's versionCode — the same rule as the app's own updater:
    "a.b.c" (any "-pre" / "+build" suffix ignored) → a·1 000 000 + b·1 000 + c.
    `ValueError` for a name that is not "a.b.c", b or c above 999, or past a 32-bit int.
    """
    match = _WINDOWS_VERSION.match(version_name or "")
    if match is None:
        raise ValueError("not a.b.c")
    major, minor, patch = (int(g) for g in match.groups())
    if minor > 999 or patch > 999:
        raise ValueError("minor and patch are at most 999")
    code = major * 1_000_000 + minor * 1_000 + patch
    if code < 1 or code > _INT32_MAX:
        raise ValueError("out of range")
    return code


def version_from_installer_name(filename: Optional[str]) -> Optional[str]:
    """`R2M-Kiosk-0.2.0-setup.exe` → "0.2.0"; None when the name carries no version."""
    match = _INSTALLER_NAME.search((filename or "").strip())
    return match.group(1) if match else None


def clean_install_window(start: Optional[str], end: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """
    `(start, end)` "HH:MM" both, or `(None, None)`. `ValueError` for one without the
    other, a malformed time, or an empty window (start == end). Crossing midnight is fine.
    """
    start = (start or "").strip() or None
    end = (end or "").strip() or None
    if start is None and end is None:
        return None, None
    if start is None or end is None:
        raise ValueError("both or neither")
    if not _HHMM.match(start) or not _HHMM.match(end):
        raise ValueError("HH:MM")
    if start == end:
        raise ValueError("empty window")
    return start, end


def in_rollout_stage(assignment_id: Any, machine_id: Any, percent: Optional[int]) -> bool:
    """
    Whether a staged assignment covers this device: the first 8 hex digits of
    sha256(f"{assignment_id}:{machine_id}") (canonical lower-case UUIDs) as a number,
    mod 100, below `percent`. Fixed per pair, so raising the percent keeps every device
    that was already in.
    """
    percent = 100 if percent is None else int(percent)
    if percent >= 100:
        return True
    if percent <= 0 or machine_id is None or assignment_id is None:
        return False
    key = f"{as_uuid(assignment_id)}:{as_uuid(machine_id)}".encode("utf-8")
    return int(hashlib.sha256(key).hexdigest()[:8], 16) % 100 < percent


@dataclass(frozen=True)
class MachineChain:
    """The entities a till's assignment can come from. Any of them may be missing."""

    machine_id: Optional[uuid.UUID]
    area_id: Optional[uuid.UUID] = None
    shop_id: Optional[uuid.UUID] = None
    company_id: Optional[uuid.UUID] = None
    tenant_id: Optional[uuid.UUID] = None

    def levels(self) -> List[Tuple[str, uuid.UUID]]:
        """`(level, id)` most specific first, skipping the levels the till lacks."""
        ids = {
            "machine": self.machine_id,
            "area": self.area_id,
            "shop": self.shop_id,
            "company": self.company_id,
            "tenant": self.tenant_id,
        }
        return [(level, as_uuid(ids[level])) for level in _PRECEDENCE if ids[level] is not None]


Resolved = Tuple[AppReleaseAssignment, AppRelease]


def resolve_assignment(
    rows: Iterable[Resolved],
    chain: MachineChain,
    platform: str = PLATFORM_ANDROID,
    machine_id: Any = None,
) -> Optional[Resolved]:
    """
    The assignment (and its release) this device takes, or None.

    `rows` may hold assignments of any target; only those on `chain` count, and of those
    only the live ones (not cancelled) of active releases of `platform` whose rollout
    stage covers the device (`machine_id`, by default the chain's). Most specific level
    first, then the newest `created_at`; an assignment that leaves the device out of its
    stage is passed over, so the next one in that order applies.
    """
    machine_id = machine_id if machine_id is not None else chain.machine_id
    rank = {key: i for i, key in enumerate(chain.levels())}
    best: Optional[Tuple[Tuple[int, float], Resolved]] = None
    for assignment, release in rows:
        if assignment.cancelled_at is not None or not release.is_active:
            continue
        if release_platform(release) != platform:
            continue
        position = rank.get((assignment.level, as_uuid(assignment.target_id)))
        if position is None:
            continue
        if not in_rollout_stage(assignment.id, machine_id, getattr(assignment, "rollout_percent", None)):
            continue
        created = as_utc(assignment.created_at)
        # Lower is better: a more specific level, then a later stamp.
        key = (position, -(created.timestamp() if created is not None else 0.0))
        if best is None or key < best[0]:
            best = (key, (assignment, release))
    return best[1] if best is not None else None


def offer_for(
    release: AppRelease,
    version_code: Optional[int],
    version_name: Optional[str],
    allow_downgrade: bool = False,
) -> bool:
    """
    Whether a device running `version_code` / `version_name` should take `release`.

    Never when it already runs it (same versionName). Not a downgrade either — a release
    with a lower versionCode than the device's is not offered even though it is assigned —
    unless `allow_downgrade` (a Windows rollback; the caller passes it only for a Windows
    release: Android cannot install a lower versionCode without uninstalling, which loses
    the till's data, so an Android "rollback" is the old code rebuilt with a higher one).
    """
    if version_name is not None and release.version_name == version_name:
        return False
    if version_code is not None and release.version_code < version_code and not allow_downgrade:
        return False
    return True


def allows_downgrade(assignment: Any, release: Any) -> bool:
    """The assignment's rollback flag, which only ever counts for a Windows release."""
    return bool(getattr(assignment, "allow_downgrade", False)) and release_platform(release) == PLATFORM_WINDOWS


def install_window_of(assignment: Any) -> Optional[Dict[str, str]]:
    start = getattr(assignment, "install_window_start", None)
    end = getattr(assignment, "install_window_end", None)
    return {"start": start, "end": end} if start and end else None


def chain_for_machine(db: Session, machine: POSMachine) -> MachineChain:
    """The till, its area, its shop, that shop's company and the tenant — as they are now."""
    company_id = None
    tenant_id = machine.tenant_id
    if machine.shop_id is not None:
        row = db.query(Shop.company_id, Shop.tenant_id).filter(Shop.id == machine.shop_id).first()
        if row is not None:
            company_id = row[0]
            tenant_id = tenant_id or row[1]
    return MachineChain(
        machine_id=machine.id,
        area_id=machine.area_id,
        shop_id=machine.shop_id,
        company_id=company_id,
        tenant_id=tenant_id,
    )


def _rows_on_chains(db: Session, chains: Sequence[MachineChain]) -> List[Resolved]:
    on_chain = {(level, ident) for chain in chains for level, ident in chain.levels()}
    if not on_chain:
        return []
    predicates = [
        and_(AppReleaseAssignment.level == level, AppReleaseAssignment.target_id == ident)
        for level, ident in on_chain
    ]
    return (
        db.query(AppReleaseAssignment, AppRelease)
        .join(AppRelease, AppRelease.id == AppReleaseAssignment.release_id)
        .filter(
            AppReleaseAssignment.cancelled_at.is_(None),
            AppRelease.is_active.is_(True),
            or_(*predicates),
        )
        .all()
    )


def resolved_for_machine(db: Session, machine: POSMachine, platform: Optional[str] = None) -> Optional[Resolved]:
    """The device's assignment among releases of `platform` (default: `machine_platform`)."""
    chain = chain_for_machine(db, machine)
    platform = platform or machine_platform(machine)
    return resolve_assignment(_rows_on_chains(db, [chain]), chain, platform=platform, machine_id=machine.id)


def resolved_for_machines(db: Session, machines: Sequence[POSMachine]) -> Dict[uuid.UUID, Optional[Resolved]]:
    """Per device, as `resolved_for_machine` for its own platform, in one query for the assignments."""
    shop_ids = {m.shop_id for m in machines if m.shop_id is not None}
    shops = (
        {row[0]: (row[1], row[2]) for row in db.query(Shop.id, Shop.company_id, Shop.tenant_id)
         .filter(Shop.id.in_(list(shop_ids))).all()}
        if shop_ids
        else {}
    )
    chains = {}
    for m in machines:
        company_id, shop_tenant = shops.get(m.shop_id, (None, None))
        chains[m.id] = MachineChain(
            machine_id=m.id,
            area_id=m.area_id,
            shop_id=m.shop_id,
            company_id=company_id,
            tenant_id=m.tenant_id or shop_tenant,
        )
    rows = _rows_on_chains(db, list(chains.values()))
    platforms = {m.id: machine_platform(m) for m in machines}
    return {
        mid: resolve_assignment(rows, chain, platform=platforms[mid], machine_id=mid)
        for mid, chain in chains.items()
    }


def newest_releases(db: Session) -> Dict[str, AppRelease]:
    """Per platform, its newest active release (highest versionCode, then the latest upload)."""
    out: Dict[str, AppRelease] = {}
    for release in (
        db.query(AppRelease)
        .filter(AppRelease.is_active.is_(True))
        .order_by(AppRelease.version_code.desc(), AppRelease.created_at.desc())
        .all()
    ):
        out.setdefault(release_platform(release), release)
    return out


# ── Targets ──────────────────────────────────────────────────────────────────

_TARGET_MODELS = {
    "tenant": Tenant,
    "company": Company,
    "shop": Shop,
    "area": ShopArea,
    "machine": POSMachine,
}


def target_entity(db: Session, level: str, target_id: Any):
    """The tenant, company, shop, area or till an assignment names, or None."""
    model = _TARGET_MODELS[level]
    return db.query(model).filter(model.id == target_id).first()


def target_tenant_id(level: str, entity) -> Optional[uuid.UUID]:
    return entity.id if level == "tenant" else entity.tenant_id


def machines_under(db: Session, level: str, target_id: Any, platform: Optional[str] = None) -> List[POSMachine]:
    """
    The active devices an assignment at this level reaches (whether or not it wins there);
    with `platform`, only those of that platform (`machine_platform`).
    """
    machines = _machines_under(db, level, target_id)
    if platform is None:
        return machines
    return [m for m in machines if machine_platform(m) == platform]


def _machines_under(db: Session, level: str, target_id: Any) -> List[POSMachine]:
    query = db.query(POSMachine).filter(POSMachine.is_active.is_(True))
    if level == "machine":
        query = query.filter(POSMachine.id == target_id)
    elif level == "area":
        query = query.filter(POSMachine.area_id == target_id)
    elif level == "shop":
        query = query.filter(POSMachine.shop_id == target_id)
    elif level == "company":
        shop_ids = [row[0] for row in db.query(Shop.id).filter(Shop.company_id == target_id).all()]
        if not shop_ids:
            return []
        query = query.filter(POSMachine.shop_id.in_(shop_ids))
    elif level == "tenant":
        query = query.filter(POSMachine.tenant_id == target_id)
    else:
        return []
    return query.all()


NotifyTarget = Tuple[str, str]


def notify_targets(machines: Iterable[POSMachine]) -> List[NotifyTarget]:
    return [(str(m.tenant_id), str(m.id)) for m in machines if m.tenant_id]


def publish_update_notify(targets: Iterable[NotifyTarget]) -> None:
    """
    Best effort: one Ably `settings` notify per till, which makes it sync now and so ask
    for its update. Without Ably configured `publish_settings_notify` only logs; a till
    that misses it still asks on its next scheduled sync.
    """
    for tenant_id, machine_id in targets:
        publish_settings_notify(tenant_id, machine_id, reason=NOTIFY_REASON)
