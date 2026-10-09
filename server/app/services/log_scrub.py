"""
"שליחת לוגים לענן" §4 — privacy: what is hidden in a device's log text and in its note.

The device scrubs its whole log before compressing it (pos-android mirrors this module); the
cloud scrubs the `note` again on upload (app/services/device_logs.py). Both are pinned by one
golden fixture, tests/fixtures/device_logs_scrub_golden.json (the Android copy is the same bytes),
and scrubbing twice changes nothing (idempotent).

The rules, applied in this order over the whole text:

1. **track2** — `;`? 13–19 digits, `=` or `D`, 4+ digits, an optional `F` pad and `?` → `***`.
2. **Secrets** — the value of any key whose name contains `token`, `secret`, `password`,
   `passwd`, `pin`, `cvv`, `authorization`, `api_key`, `apikey` or `terminal_password` (any
   case; `key=v`, `key: v`, `"key":"v"`, `\\"key\\":\\"v\\"`, `key='v'`) → `***`, its quotes kept
   (an unterminated quote runs to the end of the line). The key is the whole run of
   `[A-Za-z0-9_.-]` before the separator. A bare value runs to whitespace or one of
   `,;&"'(){}[]<>\\`; an auth scheme before it (`Bearer` / `Basic` / `Token` + spaces) is part
   of the value.
3. **Bearer** — `Bearer <token>` anywhere else → `Bearer ***`.
4. **Card numbers** — a run of digit groups separated by single spaces or dashes; inside it, the
   leftmost, then longest, window of whole groups with 13–19 digits that passes Luhn →
   `************` + its last 4 digits (then on after that window).
5. **Israeli mobiles** — `05X-XXXXXXX` (also `+972` / `00972` / `972`, spaces or dashes) →
   `05X-***-XX` + the last 2 digits.
6. **Emails** — `a***@domain`: the first character of the local part, `***`, the domain.

Workers' and managers' codes are never written to a log at all (the device's side, §4).

Portable on purpose (pos-android uses java.util.regex): ASCII classes only (`[0-9]`, explicit
whitespace), ASCII-only case folding, no `\\b` / `\\d` / `\\s`. Linear on long lines: every
pattern starts only where its run starts (a lookbehind), and a card window is at most 19 digits.
"""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

#: What a hidden value becomes.
MASK = "***"
#: A card's mask before its last 4 digits (the spec: `************1234`).
CARD_MASK = "*" * 12

_FLAGS = re.ASCII | re.IGNORECASE

#: Any key containing one of these words (case-insensitive) has its value hidden.
SECRET_KEY_WORDS = (
    "token", "secret", "password", "passwd", "pin", "cvv", "authorization", "api_key", "apikey",
    "terminal_password",
)

_TRACK2 = re.compile(r"(?<![0-9]);?[0-9]{13,19}[=D][0-9]{4,}F?\??", _FLAGS)

_KEY = r"[A-Za-z0-9_.\-]"
_WORDS = "|".join(re.escape(w) for w in SECRET_KEY_WORDS)
_BARE = r"[^ \t\r\n\x0B\f,;&\"'(){}\[\]<>\\]"
_SECRET_KV = re.compile(
    rf"(?<!{_KEY})(?={_KEY}*?(?:{_WORDS}))(?P<key>{_KEY}+)"
    r"(?P<close>\\?[\"']?)"
    r"(?P<sep>[ \t]*[:=][ \t]*)"
    r"(?P<val>"
    r"\\\"(?:(?!\\\").)*(?:\\\")?"  # an escaped-quoted value inside a JSON string: \"v\"
    r"|\"(?:[^\"\\\r\n]|\\.)*\"?"  # "v"
    r"|'(?:[^'\\\r\n]|\\.)*'?"  # 'v'
    rf"|(?:(?:bearer|basic|token)[ \t]+)?{_BARE}+"  # v, with its auth scheme
    r")",
    _FLAGS,
)
_BEARER = re.compile(r"(?<![A-Za-z0-9_])(?P<word>bearer[ \t]+)[A-Za-z0-9\-._~+/]+=*", _FLAGS)

_DIGIT_RUN = re.compile(r"[0-9]+(?:[ \-][0-9]+)*")
_GROUP_SEP = re.compile(r"[ \-]")

_PHONE = re.compile(
    r"(?<![0-9+])(?:\+972|00972|972|0)[ \-]?(?P<pre>5[0-9])[ \-]?[0-9]{3}[ \-]?[0-9]{2}[ \-]?(?P<last>[0-9]{2})(?![0-9])"
)
_EMAIL = re.compile(
    r"(?<![A-Za-z0-9._%+\-])(?P<first>[A-Za-z0-9])[A-Za-z0-9._%+\-]*@(?P<domain>[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+)"
)


def luhn_ok(digits: str) -> bool:
    """The Luhn check of a string of ASCII digits."""
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _secret_value(m: "re.Match[str]") -> str:
    val = m.group("val")
    if val.startswith('\\"'):
        hidden = '\\"' + MASK + '\\"'
    elif val[0] in "\"'":
        hidden = val[0] + MASK + val[0]
    else:
        hidden = MASK
    return m.group("key") + m.group("close") + m.group("sep") + hidden


def _card_windows(groups: List[str]) -> List[Tuple[int, int]]:
    """The (first, last) groups of each card: leftmost, then longest, never overlapping."""
    out: List[Tuple[int, int]] = []
    i, n = 0, len(groups)
    while i < n:
        ends: List[int] = []
        total = 0
        for j in range(i, n):
            total += len(groups[j])
            if total > 19:
                break
            if total >= 13:
                ends.append(j)
        found = next((j for j in reversed(ends) if luhn_ok("".join(groups[i:j + 1]))), None)
        if found is None:
            i += 1
        else:
            out.append((i, found))
            i = found + 1
    return out


def _mask_run(run: str) -> str:
    groups = _GROUP_SEP.split(run)
    seps = _GROUP_SEP.findall(run)
    windows = dict(_card_windows(groups))
    if not windows:
        return run
    parts: List[str] = []
    i = 0
    while i < len(groups):
        if i > 0:
            parts.append(seps[i - 1])
        if i in windows:
            last = windows[i]
            parts.append(CARD_MASK + "".join(groups[i:last + 1])[-4:])
            i = last + 1
        else:
            parts.append(groups[i])
            i += 1
    return "".join(parts)


def mask_cards(text: str) -> str:
    """Rule 4 alone."""
    return _DIGIT_RUN.sub(lambda m: _mask_run(m.group(0)), text)


def scrub(text: Optional[str]) -> Optional[str]:
    """The text with §4's rules applied (None stays None). Idempotent."""
    if text is None:
        return None
    out = _TRACK2.sub(MASK, text)
    out = _SECRET_KV.sub(_secret_value, out)
    out = _BEARER.sub(lambda m: m.group("word") + MASK, out)
    out = mask_cards(out)
    out = _PHONE.sub(lambda m: "0" + m.group("pre") + "-" + MASK + "-XX" + m.group("last"), out)
    out = _EMAIL.sub(lambda m: m.group("first") + MASK + "@" + m.group("domain"), out)
    return out


__all__ = ["scrub", "luhn_ok", "mask_cards", "MASK", "CARD_MASK", "SECRET_KEY_WORDS"]
