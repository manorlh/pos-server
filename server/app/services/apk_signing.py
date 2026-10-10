"""
The SHA-256 of an APK's signing certificate, with nothing but the standard library.

Android Enterprise QR provisioning (docs/SPEC_UPDATES.md §5) checks the APK it downloads
against `android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM`: the URL-safe base64
(no padding) of the SHA-256 of the signing certificate's DER — the same digest `apksigner verify
--print-certs` prints as "certificate SHA-256 digest". The certificate is read, not verified: the
device verifies the signature itself; this only says which key the release was signed with.

Where it is found, in Android's own order of preference:

* **v3 / v2** — the APK Signing Block, just before the zip's central directory: id-value pairs,
  the v3 (0xf05368c0) or v2 (0x7109871a) scheme's value a length-prefixed list of signers, each
  with its signed data holding the digests and then the X.509 certificates (the first is the
  signer's own).
* **v1** — the JAR signature: `META-INF/*.RSA|DSA|EC`, a PKCS#7 SignedData whose `certificates`
  hold the signer's certificate.

Anything unexpected is an `ApkSigningError`; the upload then keeps the release without the
checksum (computed again when a QR is asked for), so a parser gap never blocks a release.
"""
from __future__ import annotations

import base64
import hashlib
import struct
import zipfile
from typing import BinaryIO, Dict, Optional, Tuple, Union

APK_SIG_BLOCK_MAGIC = b"APK Sig Block 42"
V2_BLOCK_ID = 0x7109871A
V3_BLOCK_ID = 0xF05368C0
V31_BLOCK_ID = 0x1B93AD61

_EOCD_MAGIC = b"PK\x05\x06"
_EOCD_MIN = 22
_MAX_COMMENT = 0xFFFF
#: A signing block bigger than this is not one (real ones are a few KB, with padding 4096-aligned).
_MAX_BLOCK = 64 * 1024 * 1024


class ApkSigningError(ValueError):
    """Not an APK, or no signature this reader understands."""


def _eocd_central_directory_offset(f: BinaryIO, size: int) -> int:
    read = min(size, _EOCD_MIN + _MAX_COMMENT)
    f.seek(size - read)
    tail = f.read(read)
    idx = tail.rfind(_EOCD_MAGIC)
    while idx >= 0:
        if idx + _EOCD_MIN <= len(tail):
            (comment_len,) = struct.unpack_from("<H", tail, idx + 20)
            if idx + _EOCD_MIN + comment_len == len(tail):
                (cd_offset,) = struct.unpack_from("<I", tail, idx + 16)
                return cd_offset
        idx = tail.rfind(_EOCD_MAGIC, 0, idx)
    raise ApkSigningError("no end of central directory")


def signing_block_pairs(f: BinaryIO, size: int) -> Dict[int, bytes]:
    """The APK Signing Block's id → value pairs; empty when the APK has none (v1 only)."""
    cd_offset = _eocd_central_directory_offset(f, size)
    if cd_offset < 32 or cd_offset > size:
        return {}
    f.seek(cd_offset - 24)
    footer = f.read(24)
    size_in_footer, magic = struct.unpack("<Q16s", footer)
    if magic != APK_SIG_BLOCK_MAGIC:
        return {}
    total = size_in_footer + 8
    if size_in_footer < 24 or total > _MAX_BLOCK or total > cd_offset:
        raise ApkSigningError("signing block size out of range")
    f.seek(cd_offset - total)
    block = f.read(total)
    (size_in_header,) = struct.unpack_from("<Q", block, 0)
    if size_in_header != size_in_footer:
        raise ApkSigningError("signing block sizes disagree")
    pairs = block[8:-24]
    out: Dict[int, bytes] = {}
    pos = 0
    while pos + 12 <= len(pairs):
        (length,) = struct.unpack_from("<Q", pairs, pos)
        if length < 4 or pos + 8 + length > len(pairs):
            raise ApkSigningError("corrupt signing block pair")
        (pair_id,) = struct.unpack_from("<I", pairs, pos + 8)
        out[pair_id] = pairs[pos + 12 : pos + 8 + length]
        pos += 8 + length
    return out


def _length_prefixed(buf: bytes, pos: int) -> Tuple[bytes, int]:
    if pos + 4 > len(buf):
        raise ApkSigningError("truncated length prefix")
    (n,) = struct.unpack_from("<I", buf, pos)
    start = pos + 4
    end = start + n
    if end > len(buf):
        raise ApkSigningError("length prefix past the end")
    return buf[start:end], end


def first_certificate_of_scheme(value: bytes) -> bytes:
    """The first signer's first certificate (DER) from a v2 / v3 scheme block's value."""
    signers, _ = _length_prefixed(value, 0)
    signer, _ = _length_prefixed(signers, 0)
    signed_data, _ = _length_prefixed(signer, 0)
    _digests, pos = _length_prefixed(signed_data, 0)
    certificates, _ = _length_prefixed(signed_data, pos)
    certificate, _ = _length_prefixed(certificates, 0)
    if not certificate:
        raise ApkSigningError("empty certificate")
    return certificate


# ── v1: PKCS#7 SignedData (DER) ───────────────────────────────────────────────


def _tlv(buf: bytes, pos: int) -> Tuple[int, int, int, int]:
    """(tag, content start, content end, element end) of the DER element at `pos`."""
    if pos + 2 > len(buf):
        raise ApkSigningError("truncated DER")
    tag = buf[pos]
    first = buf[pos + 1]
    if first < 0x80:
        length, start = first, pos + 2
    else:
        count = first & 0x7F
        if count == 0 or count > 4 or pos + 2 + count > len(buf):
            raise ApkSigningError("unsupported DER length")
        length = int.from_bytes(buf[pos + 2 : pos + 2 + count], "big")
        start = pos + 2 + count
    end = start + length
    if end > len(buf):
        raise ApkSigningError("DER element past the end")
    return tag, start, end, end


def _children(buf: bytes, start: int, end: int):
    pos = start
    while pos < end:
        tag, c_start, c_end, nxt = _tlv(buf, pos)
        yield tag, pos, c_start, c_end
        pos = nxt


def first_certificate_of_pkcs7(der: bytes) -> bytes:
    """The first certificate (DER) in a PKCS#7 ContentInfo holding SignedData."""
    tag, start, end, _ = _tlv(der, 0)
    if tag != 0x30:
        raise ApkSigningError("not a PKCS#7 ContentInfo")
    parts = list(_children(der, start, end))
    if len(parts) < 2 or parts[1][0] != 0xA0:
        raise ApkSigningError("no SignedData")
    _t, _p, inner_start, inner_end = parts[1]
    tag, sd_start, sd_end, _ = _tlv(der, inner_start)
    if tag != 0x30:
        raise ApkSigningError("SignedData is not a SEQUENCE")
    for child_tag, _pos, c_start, c_end in _children(der, sd_start, sd_end):
        if child_tag == 0xA0:  # [0] IMPLICIT certificates
            for cert_tag, cert_pos, _cs, cert_end in _children(der, c_start, c_end):
                if cert_tag == 0x30:
                    return der[cert_pos:cert_end]
    raise ApkSigningError("no certificate in SignedData")


def _v1_certificate(f: BinaryIO) -> bytes:
    f.seek(0)
    try:
        with zipfile.ZipFile(f) as apk:
            names = sorted(
                n for n in apk.namelist()
                if n.upper().startswith("META-INF/") and n.upper().rsplit(".", 1)[-1] in ("RSA", "DSA", "EC")
            )
            if not names:
                raise ApkSigningError("no v1 signature")
            return first_certificate_of_pkcs7(apk.read(names[0]))
    except (zipfile.BadZipFile, KeyError, OSError) as exc:
        raise ApkSigningError("not an APK") from exc


def signing_certificate(source: Union[str, BinaryIO]) -> bytes:
    """The signer's certificate (DER): v3, else v2, else v1."""
    if isinstance(source, str):
        with open(source, "rb") as f:
            return signing_certificate(f)
    f = source
    f.seek(0, 2)
    size = f.tell()
    if size < _EOCD_MIN:
        raise ApkSigningError("not an APK")
    try:
        pairs = signing_block_pairs(f, size)
        for block_id in (V3_BLOCK_ID, V2_BLOCK_ID):
            if block_id in pairs:
                return first_certificate_of_scheme(pairs[block_id])
    except struct.error as exc:
        raise ApkSigningError("corrupt signing block") from exc
    return _v1_certificate(f)


def signing_cert_sha256(source: Union[str, BinaryIO]) -> str:
    """Lowercase hex SHA-256 of the signing certificate."""
    return hashlib.sha256(signing_certificate(source)).hexdigest()


def signing_cert_sha256_or_none(source: Union[str, BinaryIO]) -> Optional[str]:
    try:
        return signing_cert_sha256(source)
    except (ApkSigningError, OSError, ValueError):
        return None


def provisioning_checksum(cert_sha256_hex: str) -> str:
    """The QR's `PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM`: URL-safe base64, no padding."""
    raw = bytes.fromhex(cert_sha256_hex)
    if len(raw) != 32:
        raise ValueError("not a SHA-256")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
