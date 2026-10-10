"""
Kiosk web bundles: the zip a super admin uploads as an app release of platform "kiosk_web".

The bundle is the kiosk's screens (the kiosk-desktop React renderer) built as static files,
which the Android kiosk shows in a WebView. At the root of the zip: `manifest.json` and the
files. The manifest:

    {
      "kind": "r2m-kiosk-web",
      "version": "2026.10.07-1530",          → the release's versionName (≤ 64)
      "versionCode": 913530,                 → its versionCode (1 .. 2³¹-1)
      "bridgeApi": 1,                        → `app_releases.bridge_api` (≥ 1)
      "entry": "index.html",                 → one of `files`
      "builtAt": "2026-10-07T15:30:12.000Z",
      "files": [{"path": "index.html", "sha256": "<64 lowercase hex>", "size": 1234}, …]
    }

`files` lists every file of the zip but manifest.json itself; each must be there with that
SHA-256 and size, and the zip may hold nothing else (directories aside). Paths are relative,
"/"-separated, never "..", a leading "/", a backslash or a drive letter. Keys the reader does
not know are ignored (a newer builder may add some, e.g. `minChrome`).

`read_bundle` raises `BundleError` with what is wrong; the router answers it as
`422 {"code": "invalid_bundle", "msg": …}`.
"""
from __future__ import annotations

import hashlib
import json
import re
import zipfile
from dataclasses import dataclass
from typing import Any, BinaryIO, Dict, List, Tuple, Union

BUNDLE_KIND = "r2m-kiosk-web"
MANIFEST_NAME = "manifest.json"
VERSION_MAX = 64
_INT32_MAX = 2_147_483_647
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
#: A manifest larger than this is not a manifest.
_MANIFEST_MAX_BYTES = 4 * 1024 * 1024
#: Unpacked, a bundle is a few MB; these only stop a zip bomb from burning the server.
MAX_ENTRIES = 20_000
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
_CHUNK = 1024 * 1024


class BundleError(ValueError):
    """The upload is not a valid kiosk web bundle; the message says why."""


@dataclass(frozen=True)
class BundleFile:
    path: str
    sha256: str
    size: int


@dataclass(frozen=True)
class BundleManifest:
    version: str
    version_code: int
    bridge_api: int
    entry: str
    files: Tuple[BundleFile, ...]


def unsafe_path_reason(path: Any) -> Union[str, None]:
    """Why `path` may not be a bundle path, or None when it is fine."""
    if not isinstance(path, str) or not path:
        return "empty path"
    if "\\" in path:
        return "backslash"
    if path.startswith("/"):
        return "leading /"
    if ":" in path:
        return "drive letter or ':'"
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in path):
        return "control character"
    for part in path.split("/"):
        if part == "":
            return "empty segment"
        if part in (".", ".."):
            return f"'{part}' segment"
    return None


def _int(value: Any, low: int, high: int) -> Union[int, None]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if low <= value <= high else None


def parse_manifest(data: Any) -> BundleManifest:
    """The manifest's fields, checked; `BundleError` for anything the contract refuses."""
    if not isinstance(data, dict):
        raise BundleError("manifest.json is not a JSON object")
    if data.get("kind") != BUNDLE_KIND:
        raise BundleError(f"manifest kind must be {BUNDLE_KIND!r}")
    version = data.get("version")
    if not isinstance(version, str) or not version.strip():
        raise BundleError("manifest version is missing")
    version = version.strip()
    if len(version) > VERSION_MAX:
        raise BundleError(f"manifest version is longer than {VERSION_MAX} characters")
    version_code = _int(data.get("versionCode"), 1, _INT32_MAX)
    if version_code is None:
        raise BundleError(f"manifest versionCode must be a whole number 1..{_INT32_MAX}")
    bridge_api = _int(data.get("bridgeApi"), 1, _INT32_MAX)
    if bridge_api is None:
        raise BundleError("manifest bridgeApi must be a whole number ≥ 1")
    files_in = data.get("files")
    if not isinstance(files_in, list) or not files_in:
        raise BundleError("manifest files must be a non-empty list")
    files: List[BundleFile] = []
    seen = set()
    for i, item in enumerate(files_in):
        if not isinstance(item, dict):
            raise BundleError(f"manifest files[{i}] is not an object")
        path = item.get("path")
        reason = unsafe_path_reason(path)
        if reason is not None:
            raise BundleError(f"unsafe path {path!r} in manifest files ({reason})")
        if path == MANIFEST_NAME:
            raise BundleError("manifest files must not list manifest.json")
        if path in seen:
            raise BundleError(f"{path} is listed twice in manifest files")
        seen.add(path)
        sha = item.get("sha256")
        if not isinstance(sha, str) or not _SHA256.match(sha):
            raise BundleError(f"{path}: sha256 must be 64 lowercase hex digits")
        size = _int(item.get("size"), 0, MAX_UNPACKED_BYTES)
        if size is None:
            raise BundleError(f"{path}: size must be a whole number ≥ 0")
        files.append(BundleFile(path=path, sha256=sha, size=size))
    entry = data.get("entry")
    if not isinstance(entry, str) or entry not in seen:
        raise BundleError(f"manifest entry {entry!r} is not among its files")
    return BundleManifest(
        version=version,
        version_code=version_code,
        bridge_api=bridge_api,
        entry=entry,
        files=tuple(files),
    )


def _hash_entry(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> Tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with archive.open(info) as stream:
        while True:
            chunk = stream.read(_CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UNPACKED_BYTES:
                raise BundleError(f"{info.filename} is too large unpacked")
            digest.update(chunk)
    return digest.hexdigest(), size


def read_bundle(source: Union[str, BinaryIO]) -> BundleManifest:
    """
    Open the zip, read and check its manifest, and check every file against it: present,
    same size, same SHA-256; no entry the manifest does not list; no unsafe path anywhere.
    """
    try:
        archive = zipfile.ZipFile(source)
    except (zipfile.BadZipFile, OSError, ValueError) as exc:
        raise BundleError(f"not a zip ({exc})") from None
    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            raise BundleError(f"more than {MAX_ENTRIES} entries")
        if sum(i.file_size for i in infos) > MAX_UNPACKED_BYTES:
            raise BundleError("too large unpacked")
        entries: Dict[str, zipfile.ZipInfo] = {}
        for info in infos:
            name = info.filename
            is_dir = name.endswith("/")
            reason = unsafe_path_reason(name[:-1] if is_dir else name)
            if reason is not None:
                raise BundleError(f"unsafe path {name!r} in the zip ({reason})")
            if is_dir:
                continue
            if name in entries:
                raise BundleError(f"{name} is in the zip twice")
            entries[name] = info

        manifest_info = entries.get(MANIFEST_NAME)
        if manifest_info is None:
            raise BundleError("manifest.json is missing at the root of the zip")
        if manifest_info.file_size > _MANIFEST_MAX_BYTES:
            raise BundleError("manifest.json is too large")
        try:
            raw = archive.read(manifest_info)
            data = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError, RuntimeError, zipfile.BadZipFile, OSError) as exc:
            raise BundleError(f"manifest.json is unreadable ({exc.__class__.__name__})") from None
        manifest = parse_manifest(data)

        listed = {f.path for f in manifest.files}
        for name in entries:
            if name != MANIFEST_NAME and name not in listed:
                raise BundleError(f"{name} is in the zip but not in the manifest")
        for item in manifest.files:
            info = entries.get(item.path)
            if info is None:
                raise BundleError(f"{item.path} is in the manifest but not in the zip")
            if info.file_size != item.size:
                raise BundleError(f"{item.path}: size {info.file_size}, the manifest says {item.size}")
            try:
                sha, size = _hash_entry(archive, info)
            except BundleError:
                raise
            except (RuntimeError, zipfile.BadZipFile, OSError, EOFError, NotImplementedError) as exc:
                raise BundleError(f"{item.path} could not be read ({exc.__class__.__name__})") from None
            if size != item.size:
                raise BundleError(f"{item.path}: size {size}, the manifest says {item.size}")
            if sha != item.sha256:
                raise BundleError(f"{item.path}: sha256 differs from the manifest")
        return manifest
