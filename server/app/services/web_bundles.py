"""
Web bundles: a zip of screens a super admin uploads as an app release — two kinds, one reader.

* **"r2m-kiosk-web"** (release platform "kiosk_web"): the kiosk's screens (the kiosk-desktop
  React renderer) built as static files, shown by the Android kiosk in a WebView
  (bridgeApi 1). Unchanged since it was the only kind (app/services/kiosk_web_bundle.py
  re-exports this reader for it).
* **"r2m-app"** (release platform "web_app", web-till spec v2 §8.1): ONE bundle of every
  role's screens — till, kiosk, KDS, ready board, customer display — for every host: the
  browser loader `/app`, the Windows app, the APK's AppWebSession and the iOS shell. It
  is SIGNED, and it says which till engine protocol and which shell APIs it needs.

At the root of the zip: `manifest.json` and the files (and, for "r2m-app", `manifest.sig`).
The manifest:

    {
      "kind": "r2m-kiosk-web" | "r2m-app",
      "version": "2026.10.07-1530",          → the release's versionName (≤ 64)
      "versionCode": 913530,                 → its versionCode (1 .. 2³¹-1)
      "bridgeApi": 1,                        → `app_releases.bridge_api` (≥ 1; r2m-app: optional)
      "entry": "index.html",                 → one of `files`
      "builtAt": "2026-10-07T15:30:12.000Z",
      "files": [{"path": "index.html", "sha256": "<64 lowercase hex>", "size": 1234}, …],

      // r2m-app only
      "roles": ["till", "kiosk", "kds", "board", "display"],   → non-empty; unknown roles ignored
      "protocol": 1,                         → `app_releases.protocol`: till_web_protocol.json's
                                               `protocol`; must be one this server knows
                                               (`WEB_APP_PROTOCOLS`)
      "shellApi": {"electron": 1, "android": 1, "ios": 1}   → `app_releases.shell_api`: the shell
                                               API it needs from each shell (a shell it does not
                                               name: 0, nothing); optional
    }

`files` lists every file of the zip but manifest.json (and manifest.sig) itself; each must be
there with that SHA-256 and size, and the zip may hold nothing else (directories aside).
Paths are relative, "/"-separated, never "..", a leading "/", a backslash or a drive letter.
Keys the reader does not know are ignored (a newer builder may add some, e.g. `minChrome`).

**The signature ("r2m-app").** `manifest.sig`: the Ed25519 signature of the exact bytes of
`manifest.json` in the zip, as base64 text (a trailing newline allowed). Since the manifest
pins every file's SHA-256, it signs the whole bundle. The private key lives in CI, never in
the cloud (owner decision 11); the server trusts the public keys in
`settings.web_bundle_public_keys` (base64 of the raw 32-byte keys, comma separated — more
than one while a key is rotated), the shells and the browser loader pin the same keys. No
key configured → every "r2m-app" upload is refused: a cloud that cannot check the
signature never hands a bundle to a shell that sits next to the printer and the pinpad.

`read_bundle` raises `BundleError` with what is wrong; the router answers it as
`422 {"code": "invalid_bundle", "msg": …}`.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import zipfile
from dataclasses import dataclass, field
from typing import Any, BinaryIO, Dict, List, Optional, Sequence, Tuple, Union

KIND_KIOSK_WEB = "r2m-kiosk-web"
KIND_APP = "r2m-app"
KINDS = (KIND_KIOSK_WEB, KIND_APP)
#: The kind of bundle each release platform takes (app/services/app_updates.py).
KIND_OF_PLATFORM = {"kiosk_web": KIND_KIOSK_WEB, "web_app": KIND_APP}
#: Kept for the kiosk web reader's importers.
BUNDLE_KIND = KIND_KIOSK_WEB

MANIFEST_NAME = "manifest.json"
SIGNATURE_NAME = "manifest.sig"
VERSION_MAX = 64
_INT32_MAX = 2_147_483_647
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
#: A manifest larger than this is not a manifest.
_MANIFEST_MAX_BYTES = 4 * 1024 * 1024
_SIGNATURE_MAX_BYTES = 1024
#: Unpacked, a bundle is a few MB; these only stop a zip bomb from burning the server.
MAX_ENTRIES = 20_000
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
_CHUNK = 1024 * 1024

#: The till engine protocols this server knows (till_web_protocol.json `protocol`): an
#: "r2m-app" bundle that speaks another one is refused at upload.
WEB_APP_PROTOCOLS = (1,)
#: The roles an "r2m-app" bundle may carry (web-till spec v2 §6.1).
WEB_APP_ROLES = ("till", "kiosk", "kds", "board", "display")
#: The shells that may host an "r2m-app" bundle (`shellApi` keys): the Windows app, the APK,
#: the iOS shell. The browser is shell API 0.
SHELLS = ("electron", "android", "ios")


class BundleError(ValueError):
    """The upload is not a valid web bundle; the message says why."""


@dataclass(frozen=True)
class BundleFile:
    path: str
    sha256: str
    size: int


@dataclass(frozen=True)
class BundleManifest:
    version: str
    version_code: int
    #: "r2m-kiosk-web": always set; "r2m-app": None when the manifest names none.
    bridge_api: Optional[int]
    entry: str
    files: Tuple[BundleFile, ...]
    kind: str = KIND_KIOSK_WEB
    #: "r2m-app" only.
    protocol: Optional[int] = None
    shell_api: Optional[Dict[str, int]] = None
    roles: Tuple[str, ...] = ()
    #: The id of the trusted key whose signature checked out (`key_id`), "r2m-app" only.
    signed_by: Optional[str] = field(default=None, compare=False)


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


def _common(data: Any, kind: str) -> Tuple[str, int, str, Tuple[BundleFile, ...]]:
    """(version, versionCode, entry, files) — the fields every kind shares, checked."""
    reserved = (MANIFEST_NAME, SIGNATURE_NAME) if kind == KIND_APP else (MANIFEST_NAME,)
    if not isinstance(data, dict):
        raise BundleError("manifest.json is not a JSON object")
    if data.get("kind") != kind:
        raise BundleError(f"manifest kind must be {kind!r}")
    version = data.get("version")
    if not isinstance(version, str) or not version.strip():
        raise BundleError("manifest version is missing")
    version = version.strip()
    if len(version) > VERSION_MAX:
        raise BundleError(f"manifest version is longer than {VERSION_MAX} characters")
    version_code = _int(data.get("versionCode"), 1, _INT32_MAX)
    if version_code is None:
        raise BundleError(f"manifest versionCode must be a whole number 1..{_INT32_MAX}")
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
        if path in reserved:
            raise BundleError(f"manifest files must not list {path}")
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
    return version, version_code, entry, tuple(files)


def parse_kiosk_manifest(data: Any) -> BundleManifest:
    """An "r2m-kiosk-web" manifest, checked; `BundleError` for anything the contract refuses."""
    version, version_code, entry, files = _common(data, KIND_KIOSK_WEB)
    bridge_api = _int(data.get("bridgeApi"), 1, _INT32_MAX)
    if bridge_api is None:
        raise BundleError("manifest bridgeApi must be a whole number ≥ 1")
    return BundleManifest(version=version, version_code=version_code, bridge_api=bridge_api, entry=entry, files=files)


def parse_app_manifest(data: Any) -> BundleManifest:
    """An "r2m-app" manifest, checked (roles, protocol, shellApi); `BundleError` otherwise."""
    version, version_code, entry, files = _common(data, KIND_APP)
    roles_in = data.get("roles")
    if not isinstance(roles_in, list) or not roles_in or not all(isinstance(r, str) for r in roles_in):
        raise BundleError("manifest roles must be a non-empty list of role names")
    roles = tuple(dict.fromkeys(r for r in roles_in if r in WEB_APP_ROLES))
    if not roles:
        raise BundleError(f"manifest roles name none of {', '.join(WEB_APP_ROLES)}")
    protocol = _int(data.get("protocol"), 1, _INT32_MAX)
    if protocol is None:
        raise BundleError("manifest protocol must be a whole number ≥ 1")
    if protocol not in WEB_APP_PROTOCOLS:
        known = ", ".join(str(p) for p in WEB_APP_PROTOCOLS)
        raise BundleError(f"manifest protocol {protocol} is not one this server knows ({known})")
    shell_in = data.get("shellApi")
    shell_api: Dict[str, int] = {}
    if shell_in is not None:
        if not isinstance(shell_in, dict):
            raise BundleError("manifest shellApi must be an object of shell → whole number")
        for shell, level in shell_in.items():
            value = _int(level, 0, _INT32_MAX)
            if value is None:
                raise BundleError(f"manifest shellApi.{shell} must be a whole number ≥ 0")
            shell_api[str(shell)] = value
    bridge_api = None
    if data.get("bridgeApi") is not None:
        bridge_api = _int(data.get("bridgeApi"), 1, _INT32_MAX)
        if bridge_api is None:
            raise BundleError("manifest bridgeApi must be a whole number ≥ 1")
    return BundleManifest(
        version=version, version_code=version_code, bridge_api=bridge_api, entry=entry, files=files,
        kind=KIND_APP, protocol=protocol, shell_api=shell_api, roles=roles,
    )


def parse_manifest(data: Any, kind: str = KIND_KIOSK_WEB) -> BundleManifest:
    """The manifest of a bundle of `kind`, checked."""
    if kind == KIND_APP:
        return parse_app_manifest(data)
    if kind == KIND_KIOSK_WEB:
        return parse_kiosk_manifest(data)
    raise BundleError(f"unknown bundle kind {kind!r}")


# ── The signature ────────────────────────────────────────────────────────────


def key_id(public_key: bytes) -> str:
    """A short, stable name for a public key: the first 16 hex digits of its SHA-256."""
    return hashlib.sha256(public_key).hexdigest()[:16]


def parse_public_keys(value: Optional[str]) -> List[bytes]:
    """
    `settings.web_bundle_public_keys`: base64 of raw 32-byte Ed25519 public keys, separated by
    commas or whitespace. `BundleError` for a value that is not one (a misconfigured server
    says so instead of trusting nothing silently).
    """
    keys: List[bytes] = []
    for token in re.split(r"[\s,]+", (value or "").strip()):
        if not token:
            continue
        try:
            raw = base64.b64decode(token, validate=True)
        except (binascii.Error, ValueError):
            raise BundleError("web_bundle_public_keys: a key is not base64") from None
        if len(raw) != 32:
            raise BundleError("web_bundle_public_keys: an Ed25519 public key is 32 bytes")
        if raw not in keys:
            keys.append(raw)
    return keys


def trusted_keys() -> List[bytes]:
    """The release keys this server trusts (`settings.web_bundle_public_keys`)."""
    from app.config import get_settings

    return parse_public_keys(getattr(get_settings(), "web_bundle_public_keys", ""))


def verify_signature(manifest_bytes: bytes, signature_text: bytes, keys: Sequence[bytes]) -> str:
    """
    The id of the key whose Ed25519 signature `signature_text` (base64) over `manifest_bytes`
    checks out; `BundleError` when none does, or when no key is trusted at all.
    """
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    if not keys:
        raise BundleError(
            "this server has no bundle signing key configured (web_bundle_public_keys): "
            "an r2m-app bundle cannot be checked, so it is not accepted"
        )
    try:
        text = signature_text.decode("ascii").strip()
        signature = base64.b64decode(text, validate=True)
    except (UnicodeDecodeError, binascii.Error, ValueError):
        raise BundleError("manifest.sig is not base64") from None
    if len(signature) != 64:
        raise BundleError("manifest.sig is not an Ed25519 signature (64 bytes)")
    for raw in keys:
        try:
            Ed25519PublicKey.from_public_bytes(raw).verify(signature, manifest_bytes)
        except InvalidSignature:
            continue
        return key_id(raw)
    raise BundleError("manifest.sig does not match manifest.json under any trusted key")


# ── The zip ──────────────────────────────────────────────────────────────────


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


def read_bundle(
    source: Union[str, BinaryIO],
    kind: str = KIND_KIOSK_WEB,
    public_keys: Optional[Sequence[bytes]] = None,
) -> BundleManifest:
    """
    Open the zip, read and check its manifest (of `kind`), and check every file against it:
    present, same size, same SHA-256; no entry the manifest does not list; no unsafe path
    anywhere. An "r2m-app" bundle must also carry `manifest.sig`, signed by one of
    `public_keys` (default: `trusted_keys()`).
    """
    if kind not in KINDS:
        raise BundleError(f"unknown bundle kind {kind!r}")
    signed = kind == KIND_APP
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
        manifest = parse_manifest(data, kind)

        signed_by = None
        if signed:
            sig_info = entries.get(SIGNATURE_NAME)
            if sig_info is None:
                raise BundleError("manifest.sig is missing at the root of the zip (an r2m-app bundle is signed)")
            if sig_info.file_size > _SIGNATURE_MAX_BYTES:
                raise BundleError("manifest.sig is too large")
            try:
                sig_text = archive.read(sig_info)
            except (RuntimeError, zipfile.BadZipFile, OSError) as exc:
                raise BundleError(f"manifest.sig is unreadable ({exc.__class__.__name__})") from None
            keys = trusted_keys() if public_keys is None else list(public_keys)
            signed_by = verify_signature(raw, sig_text, keys)

        listed = {f.path for f in manifest.files}
        own = {MANIFEST_NAME, SIGNATURE_NAME} if signed else {MANIFEST_NAME}
        for name in entries:
            if name not in own and name not in listed:
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
        if signed_by is not None:
            manifest = BundleManifest(
                version=manifest.version, version_code=manifest.version_code, bridge_api=manifest.bridge_api,
                entry=manifest.entry, files=manifest.files, kind=manifest.kind, protocol=manifest.protocol,
                shell_api=manifest.shell_api, roles=manifest.roles, signed_by=signed_by,
            )
        return manifest
