"""Israeli 9-digit ID normalization (VAT / company reg)."""


def israeli_9th_check_digit(first8_digits: str) -> int:
    digits = "".join(c for c in (first8_digits or "") if c.isdigit()).zfill(8)[:8]
    total = 0
    for i, ch in enumerate(digits):
        n = int(ch) if ch.isdigit() else 0
        if i % 2 == 1:
            n *= 2
        if n > 9:
            n = n // 10 + (n % 10)
        total += n
    return (10 - (total % 10)) % 10


def normalize_israeli_9_digit(value: str) -> str:
    raw = "".join(c for c in (value or "") if c.isdigit())
    base = raw[:8].zfill(8)
    check = israeli_9th_check_digit(base)
    return base + str(check)
