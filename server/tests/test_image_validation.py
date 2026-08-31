"""Header-only dimension reading — the gate that keeps a 6000px camera shot off a till."""
from __future__ import annotations

import struct

from app.services.image_validation import ALLOWED_BRANDING_CONTENT_TYPES, read_image_dimensions


def _png(width: int, height: int) -> bytes:
    ihdr = b"IHDR" + struct.pack(">II", width, height) + b"\x08\x06\x00\x00\x00"
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + ihdr + b"\x00" * 4


def _jpeg(width: int, height: int) -> bytes:
    # SOI, an APP0 segment to make sure the marker walk skips payloads, then SOF0.
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9
    sof0 = b"\xff\xc0" + struct.pack(">H", 17) + b"\x08" + struct.pack(">HH", height, width)
    return b"\xff\xd8" + app0 + sof0 + b"\x00" * 12


def _webp_lossy(width: int, height: int) -> bytes:
    body = b"WEBP" + b"VP8 " + struct.pack("<I", 20)
    body += b"\x00\x00\x00" + b"\x9d\x01\x2a" + struct.pack("<HH", width, height)
    return b"RIFF" + struct.pack("<I", len(body)) + body + b"\x00" * 8


def _webp_lossless(width: int, height: int) -> bytes:
    bits = (width - 1) | ((height - 1) << 14)
    body = b"WEBP" + b"VP8L" + struct.pack("<I", 12) + b"\x2f" + struct.pack("<I", bits)
    return b"RIFF" + struct.pack("<I", len(body)) + body + b"\x00" * 12


def test_reads_png_dimensions() -> None:
    assert read_image_dimensions(_png(512, 256)) == (512, 256)


def test_reads_jpeg_dimensions_past_app0_segment() -> None:
    assert read_image_dimensions(_jpeg(1920, 1080)) == (1920, 1080)


def test_reads_lossy_webp_dimensions() -> None:
    assert read_image_dimensions(_webp_lossy(800, 600)) == (800, 600)


def test_reads_lossless_webp_dimensions() -> None:
    assert read_image_dimensions(_webp_lossless(64, 64)) == (64, 64)


def test_rejects_non_image_and_truncated_bytes() -> None:
    assert read_image_dimensions(b"") is None
    assert read_image_dimensions(b"not an image at all") is None
    # A PNG signature with no IHDR must not be reported as a valid image.
    assert read_image_dimensions(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8) is None


def test_gif_is_not_an_allowed_branding_type() -> None:
    # Animated splash screens on a low-end till are a jank source, not a feature.
    assert "image/gif" not in ALLOWED_BRANDING_CONTENT_TYPES
    assert set(ALLOWED_BRANDING_CONTENT_TYPES) == {"image/png", "image/jpeg", "image/webp"}
