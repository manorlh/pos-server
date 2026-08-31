"""Header-only image validation for uploads that must render on a POS terminal.

Pillow is not a dependency of this project and a branding upload is not worth
adding one for: the pixel dimensions of PNG/JPEG/WebP all sit in the first few
hundred bytes, so they are read straight from the header. Anything unparseable
is rejected rather than guessed at — an image the server cannot identify is an
image the till probably cannot decode either.
"""
from __future__ import annotations

import struct
from typing import Optional, Tuple

#: Content types a POS terminal renders reliably. GIF is deliberately excluded:
#: an animated splash on a low-end Android till is a jank source, not a feature.
ALLOWED_BRANDING_CONTENT_TYPES = ("image/png", "image/jpeg", "image/webp")


def _png_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def _jpeg_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None
    i = 2
    n = len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        # Standalone markers carry no payload.
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if marker == 0xFF:
            i += 1
            continue
        seg_len = struct.unpack(">H", data[i + 2 : i + 4])[0]
        # SOF0..SOF15 hold the frame size; SOF4/SOF8/SOF12 are not frame headers.
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack(">HH", data[i + 5 : i + 9])
            return width, height
        if seg_len < 2:
            return None
        i += 2 + seg_len
    return None


def _webp_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    chunk = data[12:16]
    if chunk == b"VP8 ":
        # Lossy: 14-bit width/height after the 3-byte start code.
        if data[23:26] != b"\x9d\x01\x2a":
            return None
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L":
        bits = struct.unpack("<I", data[21:25])[0]
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8X":
        width = data[24] | (data[25] << 8) | (data[26] << 16)
        height = data[27] | (data[28] << 8) | (data[29] << 16)
        return width + 1, height + 1
    return None


def read_image_dimensions(data: bytes) -> Optional[Tuple[int, int]]:
    """(width, height) in pixels for PNG/JPEG/WebP, or None when unreadable."""
    for reader in (_png_size, _jpeg_size, _webp_size):
        try:
            size = reader(data)
        except (struct.error, IndexError):
            size = None
        if size and size[0] > 0 and size[1] > 0:
            return size
    return None
