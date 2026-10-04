"""
Read `versionCode` and `versionName` out of an APK, with nothing but the standard library.

An APK is a zip whose `AndroidManifest.xml` is compiled to Android's binary XML (AXML):
a chunk stream holding a string pool, a resource-id map and one chunk per element. Only
the root `<manifest>` element's two attributes are wanted, so this reads exactly that
much and stops — no full XML model, and no dependency for one upload form.

Anything unexpected is a `ApkManifestError`; the upload then falls back to the version
the uploader typed (app/routers/app_releases.py), so a parser gap never blocks a release.
"""
from __future__ import annotations

import struct
import zipfile
from dataclasses import dataclass
from typing import BinaryIO, List, Optional, Union

_RES_XML_TYPE = 0x0003
_RES_STRING_POOL_TYPE = 0x0001
_RES_XML_RESOURCE_MAP_TYPE = 0x0180
_RES_XML_START_ELEMENT_TYPE = 0x0102

_UTF8_FLAG = 1 << 8
_NO_INDEX = 0xFFFFFFFF

#: android:versionCode / android:versionName. Release builds often strip attribute names
#: from the string pool, leaving only these ids in the resource map to go by.
_VERSION_CODE_ID = 0x0101021B
_VERSION_NAME_ID = 0x0101021C

_TYPE_STRING = 0x03
_TYPE_INT_DEC = 0x10
_TYPE_INT_HEX = 0x11


class ApkManifestError(ValueError):
    """Not an APK, or a manifest this reader does not understand."""


@dataclass(frozen=True)
class ApkVersion:
    version_code: Optional[int]
    version_name: Optional[str]


def _strings(data: bytes, start: int) -> List[str]:
    _type, header_size, _size, count, _styles, flags, strings_start, _styles_start = struct.unpack_from(
        "<HHIIIIII", data, start
    )
    offsets = struct.unpack_from(f"<{count}I", data, start + header_size)
    base = start + strings_start
    utf8 = bool(flags & _UTF8_FLAG)
    out: List[str] = []
    for offset in offsets:
        pos = base + offset
        if utf8:
            # Two lengths, each one byte or two (high bit set): characters, then bytes.
            pos += 2 if data[pos] & 0x80 else 1
            length = data[pos]
            if length & 0x80:
                length = ((length & 0x7F) << 8) | data[pos + 1]
                pos += 2
            else:
                pos += 1
            out.append(data[pos : pos + length].decode("utf-8", errors="replace"))
        else:
            (length,) = struct.unpack_from("<H", data, pos)
            pos += 2
            if length & 0x8000:
                (low,) = struct.unpack_from("<H", data, pos)
                length = ((length & 0x7FFF) << 16) | low
                pos += 2
            out.append(data[pos : pos + length * 2].decode("utf-16-le", errors="replace"))
    return out


def parse_binary_manifest(data: bytes) -> ApkVersion:
    """The root element's version attributes from a compiled `AndroidManifest.xml`."""
    try:
        if len(data) < 8 or struct.unpack_from("<H", data, 0)[0] != _RES_XML_TYPE:
            raise ApkManifestError("not a binary XML manifest")
        (header_size,) = struct.unpack_from("<H", data, 2)
        pos = header_size
        strings: List[str] = []
        resource_ids: List[int] = []
        while pos + 8 <= len(data):
            chunk_type, chunk_header, chunk_size = struct.unpack_from("<HHI", data, pos)
            if chunk_size < 8:
                raise ApkManifestError("corrupt chunk")
            if chunk_type == _RES_STRING_POOL_TYPE:
                strings = _strings(data, pos)
            elif chunk_type == _RES_XML_RESOURCE_MAP_TYPE:
                count = (chunk_size - chunk_header) // 4
                resource_ids = list(struct.unpack_from(f"<{count}I", data, pos + chunk_header))
            elif chunk_type == _RES_XML_START_ELEMENT_TYPE:
                # The first element is <manifest>; its attributes are all that is wanted.
                return _manifest_attributes(data, pos, chunk_header, strings, resource_ids)
            pos += chunk_size
    except (struct.error, IndexError) as exc:
        raise ApkManifestError("corrupt manifest") from exc
    raise ApkManifestError("no manifest element")


def _manifest_attributes(
    data: bytes, pos: int, header_size: int, strings: List[str], resource_ids: List[int]
) -> ApkVersion:
    ext = pos + header_size
    _ns, _name, attr_start, attr_size, attr_count = struct.unpack_from("<IIHHH", data, ext)
    code: Optional[int] = None
    name: Optional[str] = None
    for i in range(attr_count):
        at = ext + attr_start + i * attr_size
        _attr_ns, attr_name, raw_value, _value_size, _res0, data_type, value = struct.unpack_from(
            "<IIIHBBI", data, at
        )
        res_id = resource_ids[attr_name] if attr_name < len(resource_ids) else None
        label = strings[attr_name] if attr_name < len(strings) else ""
        if res_id == _VERSION_CODE_ID or label == "versionCode":
            if data_type in (_TYPE_INT_DEC, _TYPE_INT_HEX):
                code = value
            elif data_type == _TYPE_STRING and value < len(strings):
                code = int(strings[value])
        elif res_id == _VERSION_NAME_ID or label == "versionName":
            if raw_value != _NO_INDEX and raw_value < len(strings):
                name = strings[raw_value]
            elif data_type == _TYPE_STRING and value < len(strings):
                name = strings[value]
    return ApkVersion(version_code=code, version_name=name)


def read_apk_version(source: Union[str, BinaryIO]) -> ApkVersion:
    """`versionCode` / `versionName` of the APK at `source` (a path or a binary file)."""
    try:
        with zipfile.ZipFile(source) as apk:
            manifest = apk.read("AndroidManifest.xml")
    except (zipfile.BadZipFile, KeyError, OSError) as exc:
        raise ApkManifestError("not an APK") from exc
    try:
        return parse_binary_manifest(manifest)
    except ValueError as exc:
        if isinstance(exc, ApkManifestError):
            raise
        raise ApkManifestError("unreadable manifest") from exc
