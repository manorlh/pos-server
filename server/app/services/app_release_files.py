"""
Deleting old release FILES ("מחיקת קובץ" / "ניקוי גרסאות ישנות" in "עדכוני גרסה").

The release row is kept — tills' status rows point at it and the dashboard keeps its
history — while the stored binary is removed and the row marked (`file_deleted_at`,
`file_deleted_by`). A release without its file is never offered, downloaded, assigned or
reinstated again (app/services/app_updates.py, app/routers/app_releases.py).

Guards (`check`), all of them server-side:

* `app_release_has_assignments` — it still has a live (not cancelled) assignment;
* `app_release_latest` — it is the newest active release of its platform;
* `app_release_not_retired` — it is active and the caller did not ask to retire it in the
  same confirm (`retire=True` retires and deletes at once).

Devices that still report running that version do not block: the dashboard warns with the
count (deleting the file does not touch them, it only means the version cannot be installed
again).

Storage: the files live on the API's local disk under `settings.app_releases_dir`
(`{id}.apk|.exe|.zip`, written by `upload_app_release`), so they are deleted with the same
filesystem calls. Only a file inside that directory, named after the release's id, is ever
touched. Idempotent: a file already gone counts as deleted (`already_missing`). When the
storage delete fails the row is NOT marked (and a retire in the same confirm is rolled back).
Every delete writes one `AppReleaseFileDeletion` audit row.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.app_release import (
    APP_RELEASE_PLATFORMS,
    AppRelease,
    AppReleaseAssignment,
    AppReleaseFileDeletion,
)
from app.models.kiosk_web import KioskWebDeviceStatus
from app.models.pos_machine import POSMachine
from app.services import app_updates as AU

logger = logging.getLogger(__name__)

#: The bulk cleanup's confirmation word, typed by the owner.
CLEANUP_CONFIRM_WORD = "מחק"
DEFAULT_KEEP = 3
MAX_KEEP = 50

STORAGE_DELETED = "deleted"
STORAGE_ALREADY_MISSING = "already_missing"

REASON_HAS_ASSIGNMENTS = "app_release_has_assignments"
REASON_LATEST = "app_release_latest"
REASON_NOT_RETIRED = "app_release_not_retired"


class StorageDeleteError(Exception):
    """The stored file could not be deleted; the release is left as it was."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Storage ──────────────────────────────────────────────────────────────────


def stored_file(release: AppRelease) -> Optional[Path]:
    """
    Where the release's file is: `app_releases_dir / <its file name>`, and only when that name is
    the release's own (`{id}.apk` …). None for anything else — a path outside the directory or a
    foreign name is never deleted.
    """
    name = Path(str(release.file_path or "")).name
    if not name or not name.startswith(str(release.id)):
        return None
    return Path(get_settings().app_releases_dir) / name


def delete_stored_file(release: AppRelease) -> str:
    """
    Remove the release's file from storage. `deleted`, or `already_missing` when it was not
    there (idempotent). `StorageDeleteError` when it is there and cannot be removed, or when the
    row does not name a file of ours.
    """
    path = stored_file(release)
    if path is None:
        raise StorageDeleteError("file_path_not_in_release_storage")
    try:
        os.remove(path)
    except FileNotFoundError:
        return STORAGE_ALREADY_MISSING
    except OSError as exc:
        raise StorageDeleteError(str(exc)) from exc
    return STORAGE_DELETED


# ── Guards ───────────────────────────────────────────────────────────────────


def live_assignment_counts(db: Session) -> Dict:
    return dict(
        db.query(AppReleaseAssignment.release_id, func.count(AppReleaseAssignment.id))
        .filter(AppReleaseAssignment.cancelled_at.is_(None))
        .group_by(AppReleaseAssignment.release_id)
        .all()
    )


def devices_on_version(db: Session, release: AppRelease) -> int:
    """
    Active devices that last reported running this release's version: the Android / Windows
    app's `app_version` (on a device of the release's platform), or for a kiosk web bundle the
    active bundle the kiosk last reported.
    """
    platform = AU.release_platform(release)
    if platform == AU.PLATFORM_KIOSK_WEB:
        return (
            db.query(func.count(KioskWebDeviceStatus.machine_id))
            .join(POSMachine, POSMachine.id == KioskWebDeviceStatus.machine_id)
            .filter(
                POSMachine.is_active.is_(True),
                KioskWebDeviceStatus.bundle_version == release.version_name,
            )
            .scalar()
            or 0
        )
    machines = (
        db.query(POSMachine)
        .filter(POSMachine.is_active.is_(True), POSMachine.app_version == release.version_name)
        .all()
    )
    return sum(1 for m in machines if AU.machine_platform(m) == platform)


@dataclass
class FileDeleteCheck:
    release: AppRelease
    allowed: bool
    reasons: List[str]
    #: Active: it would be retired in the same confirm.
    needs_retire: bool
    devices_on_version: int
    already_deleted: bool


def check(
    db: Session,
    release: AppRelease,
    *,
    retire: bool = True,
    counts: Optional[Dict] = None,
    newest: Optional[Dict[str, AppRelease]] = None,
    with_devices: bool = True,
) -> FileDeleteCheck:
    """May the release's file be deleted now (with `retire`: retiring it in the same confirm)?"""
    counts = live_assignment_counts(db) if counts is None else counts
    newest = AU.newest_releases(db) if newest is None else newest
    reasons: List[str] = []
    already = release.file_deleted_at is not None
    if not already:
        if counts.get(release.id, 0) > 0:
            reasons.append(REASON_HAS_ASSIGNMENTS)
        latest = newest.get(AU.release_platform(release))
        if release.is_active and latest is not None and latest.id == release.id:
            reasons.append(REASON_LATEST)
        if release.is_active and not retire:
            reasons.append(REASON_NOT_RETIRED)
    return FileDeleteCheck(
        release=release,
        allowed=not reasons,
        reasons=reasons,
        needs_retire=bool(release.is_active) and not already,
        devices_on_version=devices_on_version(db, release) if with_devices else 0,
        already_deleted=already,
    )


# ── Delete ───────────────────────────────────────────────────────────────────


@dataclass
class DeleteResult:
    release: AppRelease
    storage_result: Optional[str]
    retired: bool
    devices_on_version: int
    #: False when the file was already deleted before this call (nothing done).
    deleted_now: bool


def delete_file(
    db: Session,
    release: AppRelease,
    user_id,
    *,
    retire: bool,
    mode: str = "single",
    verdict: Optional[FileDeleteCheck] = None,
) -> DeleteResult:
    """
    Delete one release's file after `check` allowed it (the caller refuses otherwise), and
    commit. Already deleted: nothing happens. `StorageDeleteError` leaves the row (and its
    `is_active`) untouched — the session is rolled back.
    """
    verdict = verdict or check(db, release, retire=retire)
    if verdict.already_deleted:
        return DeleteResult(release, None, False, verdict.devices_on_version, False)
    if not verdict.allowed:
        raise ValueError(verdict.reasons[0])
    retired_now = False
    if release.is_active:
        release.is_active = False
        retired_now = True
    try:
        result = delete_stored_file(release)
    except StorageDeleteError:
        db.rollback()
        logger.exception("app release %s (%s): file delete failed", release.id, release.version_name)
        raise
    when = _now()
    release.file_deleted_at = when
    release.file_deleted_by = user_id
    db.add(
        AppReleaseFileDeletion(
            release_id=release.id,
            platform=AU.release_platform(release),
            version_name=release.version_name,
            size_bytes=release.size_bytes or 0,
            mode=mode,
            retired=retired_now,
            devices_on_version=verdict.devices_on_version,
            storage_result=result,
            deleted_by_user_id=user_id,
            deleted_at=when,
        )
    )
    db.commit()
    db.refresh(release)
    logger.info(
        "app release %s %s %s: file %s by %s (%s, retired=%s, devices on it=%d)",
        AU.release_platform(release), release.version_name, release.id, result, user_id, mode,
        retired_now, verdict.devices_on_version,
    )
    return DeleteResult(release, result, retired_now, verdict.devices_on_version, True)


# ── Bulk cleanup ─────────────────────────────────────────────────────────────


@dataclass
class PlatformPlan:
    platform: str
    kept: List[AppRelease] = field(default_factory=list)
    candidates: List[FileDeleteCheck] = field(default_factory=list)
    skipped: List[FileDeleteCheck] = field(default_factory=list)

    @property
    def bytes(self) -> int:
        return sum(c.release.size_bytes or 0 for c in self.candidates)


def clamp_keep(keep: Optional[int]) -> int:
    if keep is None:
        return DEFAULT_KEEP
    if isinstance(keep, bool) or not isinstance(keep, int) or not 1 <= keep <= MAX_KEEP:
        raise ValueError("keep_invalid")
    return keep


def cleanup_plan(db: Session, keep: int, platform: Optional[str] = None) -> List[PlatformPlan]:
    """
    Per platform: of the releases whose file is still kept (newest versionCode first, then the
    latest upload), the first `keep` stay; every older one is a candidate when `check` allows it
    (an active one is retired in the same confirm), else skipped with its reasons.
    """
    counts = live_assignment_counts(db)
    newest = AU.newest_releases(db)
    query = db.query(AppRelease).filter(AppRelease.file_deleted_at.is_(None))
    if platform is not None:
        query = query.filter(AppRelease.platform == platform)
    rows = query.order_by(AppRelease.version_code.desc(), AppRelease.created_at.desc()).all()
    plans: Dict[str, PlatformPlan] = {}
    for release in rows:
        p = AU.release_platform(release)
        plan = plans.setdefault(p, PlatformPlan(platform=p))
        if len(plan.kept) < keep:
            plan.kept.append(release)
            continue
        verdict = check(db, release, retire=True, counts=counts, newest=newest)
        (plan.candidates if verdict.allowed else plan.skipped).append(verdict)
    order = {name: i for i, name in enumerate(APP_RELEASE_PLATFORMS)}
    return sorted(plans.values(), key=lambda pl: (order.get(pl.platform, 99), pl.platform))
