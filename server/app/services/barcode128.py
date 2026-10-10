"""
Code 128 (subset B) — the line barcode a prepaid voucher ("שובר הפקה") can carry instead of
its QR, for the 1D laser scanners a QR is lost on (docs/SPEC_VOUCHER_PRODUCTION.md).

Pure: text in, bar / space widths out (in modules). The dashboard draws the same barcode
from its own copy of this table (`client/src/lib/barcode128.ts`); both are pinned by the
same expected widths in their tests, so the paper looks the same whichever drew it.

Subset B covers printable ASCII (32–126), which is all a voucher's "PV:" + code needs.
"""
from __future__ import annotations

from typing import List

#: Bar / space widths of the 107 symbols (values 0–105 and the stop), bar first. Each
#: symbol is 11 modules wide; the stop (with its final bar) is 13.
PATTERNS = (
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
    "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
    "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
    "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
    "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
    "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
    "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
    "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
    "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
)
START_B = 104
STOP = 106
#: The light margin each side, in modules (the standard asks for at least 10).
QUIET_ZONE = 10


class Code128Error(ValueError):
    pass


def values_b(text: str) -> List[int]:
    """The symbol values of [text] in subset B: start, data, checksum, stop."""
    if not text:
        raise Code128Error("empty")
    data = []
    for ch in text:
        code = ord(ch)
        if code < 32 or code > 126:
            raise Code128Error(f"not in subset B: {ch!r}")
        data.append(code - 32)
    checksum = (START_B + sum(i * v for i, v in enumerate(data, start=1))) % 103
    return [START_B, *data, checksum, STOP]


def widths(text: str) -> str:
    """Bar / space widths of the whole symbol, bar first, without the quiet zones."""
    return "".join(PATTERNS[v] for v in values_b(text))


def modules(text: str) -> List[bool]:
    """The symbol module by module (True = bar), quiet zones included."""
    out: List[bool] = [False] * QUIET_ZONE
    bar = True
    for w in widths(text):
        out.extend([bar] * int(w))
        bar = not bar
    out.extend([False] * QUIET_ZONE)
    return out


def module_count(text: str) -> int:
    """Width of the symbol in modules, quiet zones included: 11 per symbol + 2 + 2 × quiet."""
    return len(modules(text))
