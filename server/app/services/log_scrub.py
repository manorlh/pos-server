"""
"שליחת לוגים לענן" §4 — privacy: what is hidden in a device's log text and in its note.

The device scrubs its whole log before compressing it (pos-android mirrors this module); the
cloud scrubs the `note` again on upload (app/services/device_logs.py). Both are pinned by one
golden fixture, tests/fixtures/device_logs_scrub_golden.json (the Android copy is the same bytes),
and scrubbing twice changes nothing (idempotent).

The rules, applied in this order over the whole text:

1. **track2** — `;`? 13–19 digits, `=` or `D`, 4+ digits, an optional `F` pad and `?` → `***`.
2. **Secrets** — `key=v`, `key: v`, `"key":"v"`, `\\"key\\":\\"v\\"`, `key='v'`: the value of a
   secret key → `***`, its quotes kept (an unterminated quote runs to the end of the line). The
   key is the whole run of `[A-Za-z0-9_.-]` before the separator. It is secret when, split into
   tokens (at `_`, `-`, `.`, camelCase — `managerPin`, `APIKey` — and letter/digit boundaries —
   `cvv2`), lower-cased, a token is one of `SECRET_TOKENS` or two tokens in a row are `api`,
   `key`; or when the whole key (lower-cased) is one of `SECRET_FULL_NAMES`. By token, never by
   substring: `pinpadHost`, `mapping`, `typing`, `shipping` stay visible. A key that is not secret
   hides nothing, and the search goes on right after it (its value is read as text again). A bare
   value runs to whitespace or one of `,;&"'(){}[]<>\\`; an auth scheme before it (`Bearer` /
   `Basic` / `Token` + spaces) is part of the value.
3. **Bearer** — `Bearer <token>` anywhere else → `Bearer ***`.
4. **Card numbers** — a run of digit groups separated by single spaces or dashes; inside it, the
   leftmost, then longest, window of whole groups whose digits are a card → `************` + its
   last 4 digits (then on after that window). A card (`pan_ok`): Luhn, and by length — 13 digits
   starting with 4; 14 starting with 30, 36 or 38; 15 starting with 34 or 37; 16–19 any. (An
   epoch in milliseconds — 13 digits starting with 1 — is never a card.)
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

#: A key with one of these tokens (lower-cased) is secret.
SECRET_TOKENS = frozenset({
    "pin", "pincode", "password", "passwd", "secret", "token", "cvv", "authorization", "apikey",
})
#: Two tokens in a row that make a key secret (`api_key`, `apiKey`, `x-api-key`).
SECRET_TOKEN_PAIRS = frozenset({("api", "key")})
#: A whole key (lower-cased) that is secret as written.
SECRET_FULL_NAMES = frozenset({
    "token", "secret", "password", "passwd", "pin", "pincode", "cvv", "authorization", "api_key", "apikey",
    "terminal_password",
})

_TRACK2 = re.compile(r"(?<![0-9]);?[0-9]{13,19}[=D][0-9]{4,}F?\??", _FLAGS)

_KEY = r"[A-Za-z0-9_.\-]"
_BARE = r"[^ \t\r\n\x0B\f,;&\"'(){}\[\]<>\\]"
#: A key-value candidate. The lookahead only skips keys that cannot be secret (every secret key
#: contains one of these letters); `is_secret_key` decides.
_SECRET_KV = re.compile(
    rf"(?<!{_KEY})(?={_KEY}*?(?:pin|passw|secret|token|cvv|authorization|api))(?P<key>{_KEY}+)"
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
#: Where a key splits into tokens: `_` `-` `.`, camelCase (`aB`, `1B`, the end of an acronym
#: `ABc`), and letter/digit boundaries. Case-sensitive on purpose.
_KEY_SPLIT = re.compile(
    r"[_.\-]+"
    r"|(?<=[a-z0-9])(?=[A-Z])"
    r"|(?<=[A-Z])(?=[A-Z][a-z])"
    r"|(?<=[A-Za-z])(?=[0-9])"
    r"|(?<=[0-9])(?=[A-Za-z])",
    re.ASCII,
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


def pan_ok(digits: str) -> bool:
    """A card number: by length and prefix (13: 4; 14: 30/36/38; 15: 34/37; 16–19: any), and Luhn."""
    n = len(digits)
    if n == 13:
        fits = digits.startswith("4")
    elif n == 14:
        fits = digits[:2] in ("30", "36", "38")
    elif n == 15:
        fits = digits[:2] in ("34", "37")
    else:
        fits = 16 <= n <= 19
    return fits and luhn_ok(digits)


def key_tokens(key: str) -> List[str]:
    """`managerPin` → ["manager", "pin"]; `X-API-Key` → ["x", "api", "key"]; `cvv2` → ["cvv", "2"]."""
    return [t.lower() for t in _KEY_SPLIT.split(key) if t]


def is_secret_key(key: str) -> bool:
    """Rule 2's test of a key name: by token (or the whole name), never by substring."""
    if key.lower() in SECRET_FULL_NAMES:
        return True
    tokens = key_tokens(key)
    if any(t in SECRET_TOKENS for t in tokens):
        return True
    return any(pair in SECRET_TOKEN_PAIRS for pair in zip(tokens, tokens[1:]))


def _secret_value(m: "re.Match[str]") -> str:
    val = m.group("val")
    if val.startswith('\\"'):
        hidden = '\\"' + MASK + '\\"'
    elif val[0] in "\"'":
        hidden = val[0] + MASK + val[0]
    else:
        hidden = MASK
    return m.group("key") + m.group("close") + m.group("sep") + hidden


def mask_secrets(text: str) -> str:
    """Rule 2 alone. A key that is not secret is passed over; the search goes on right after it."""
    out: List[str] = []
    last = pos = 0
    while True:
        m = _SECRET_KV.search(text, pos)
        if m is None:
            break
        if is_secret_key(m.group("key")):
            out.append(text[last:m.start()])
            out.append(_secret_value(m))
            last = pos = m.end()
        else:
            pos = m.end("key")
    out.append(text[last:])
    return "".join(out)


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
        found = next((j for j in reversed(ends) if pan_ok("".join(groups[i:j + 1]))), None)
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
    out = mask_secrets(out)
    out = _BEARER.sub(lambda m: m.group("word") + MASK, out)
    out = mask_cards(out)
    out = _PHONE.sub(lambda m: "0" + m.group("pre") + "-" + MASK + "-XX" + m.group("last"), out)
    out = _EMAIL.sub(lambda m: m.group("first") + MASK + "@" + m.group("domain"), out)
    return out


__all__ = [
    "scrub", "luhn_ok", "pan_ok", "key_tokens", "is_secret_key", "mask_secrets", "mask_cards",
    "MASK", "CARD_MASK", "SECRET_TOKENS", "SECRET_TOKEN_PAIRS", "SECRET_FULL_NAMES",
]
