"""
"התקנת גשר ל-Windows" (docs/SPEC_KIOSK.md §28) — the Windows installer for the dashboard's
"הוספת מכשיר" → קיוסק בדפדפן, for any machine admin (the release management itself stays the super
admin's, app/routers/app_releases.py):

GET /app-releases/windows/latest            → the newest active Windows release (version, size)
GET /app-releases/windows/latest/download   → its installer, as R2M-POS-Windows-bridge-setup.exe
                                              (`?flavor=app`: under its built name)

The installer reads its own file name: "bridge" in it starts R2M POS for Windows in bridge mode —
a tray program giving the browser kiosk / KDS / board on that PC the card terminal, the printer
and the browser in kiosk mode at start. One installer, one updater.
"""
from __future__ import annotations

import logging
import os
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_machine_admin
from app.models.app_release import AppRelease
from app.models.user import User
from app.services import app_updates as AU

logger = logging.getLogger(__name__)
router = APIRouter(tags=["app-releases"])

#: The bridge's download: the newest Windows installer under this name. The installer reads its
#: own file name ("bridge" in it) and starts R2M POS for Windows in bridge mode (no kiosk window,
#: a tray program for the browser kiosk / KDS / board on that PC). Same installer, same updates.
BRIDGE_INSTALLER_NAME = "R2M-POS-Windows-bridge-setup.exe"
WINDOWS_MEDIA_TYPE = "application/vnd.microsoft.portable-executable"


def _newest_windows(db: Session) -> Optional[AppRelease]:
    release = AU.newest_releases(db).get(AU.PLATFORM_WINDOWS)
    if release is None or not release.file_path or not os.path.isfile(release.file_path):
        return None
    return release


@router.get("/app-releases/windows/latest")
def get_newest_windows_installer(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_machine_admin),
):
    """
    The newest active Windows release (for "הוספת מכשיר" → קיוסק בדפדפן → "התקנת גשר ל-Windows"):
    its version and size, or `available: false` when none was uploaded. Any machine admin.
    """
    release = _newest_windows(db)
    if release is None:
        return {"available": False}
    return {
        "available": True,
        "versionName": release.version_name,
        "sizeBytes": release.size_bytes,
        "sha256": release.sha256,
        "fileName": BRIDGE_INSTALLER_NAME,
    }


@router.get("/app-releases/windows/latest/download")
def download_newest_windows_installer(
    flavor: Annotated[Optional[str], Query()] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_machine_admin),
):
    """
    The newest Windows installer itself — `?flavor=bridge` (the default) under the bridge's name,
    `?flavor=app` under its built name. `404 windows_release_missing` when there is none.
    """
    release = _newest_windows(db)
    if release is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="windows_release_missing")
    name = (
        f"R2M-POS-Windows-{release.version_name}-setup.exe"
        if (flavor or "bridge").strip().lower() == "app"
        else BRIDGE_INSTALLER_NAME
    )
    logger.info("windows installer %s downloaded by %s as %s", release.version_name, current_user.id, name)
    return FileResponse(release.file_path, media_type=WINDOWS_MEDIA_TYPE, filename=name)
