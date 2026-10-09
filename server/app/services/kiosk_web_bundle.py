"""
Kiosk web bundles ("r2m-kiosk-web") — the reader moved to app/services/web_bundles.py, which
reads both kinds of web bundle (this one, and the signed "r2m-app" of the web till). Kept so
its importers keep working; `read_bundle` here reads a kiosk web bundle, exactly as before.
"""
from __future__ import annotations

from typing import BinaryIO, Union

from app.services.web_bundles import (  # noqa: F401  (re-exported)
    BUNDLE_KIND,
    KIND_KIOSK_WEB,
    MANIFEST_NAME,
    MAX_ENTRIES,
    MAX_UNPACKED_BYTES,
    VERSION_MAX,
    BundleError,
    BundleFile,
    BundleManifest,
    unsafe_path_reason,
)
from app.services.web_bundles import parse_kiosk_manifest as parse_manifest  # noqa: F401
from app.services.web_bundles import read_bundle as _read


def read_bundle(source: Union[str, BinaryIO]) -> BundleManifest:
    """A kiosk web bundle's manifest, the zip checked against it (`BundleError` otherwise)."""
    return _read(source, KIND_KIOSK_WEB)
