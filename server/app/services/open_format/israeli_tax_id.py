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


def is_valid_israeli_id(value: str) -> bool:
    """
    A ח.פ. / ע.מ. / ת.ז. that passes the Israeli check digit: 1–9 digits (a shorter one is
    padded with zeros on the left), the ninth the Luhn-style digit of the first eight, and
    not all zeros. Separators a person types (spaces, dashes) are ignored.
    """
    raw = "".join(c for c in (value or "") if c not in " -")
    if not raw.isdigit() or not 1 <= len(raw) <= 9:
        return False
    padded = raw.zfill(9)
    if padded == "000000000":
        return False
    return israeli_9th_check_digit(padded[:8]) == int(padded[8])


def customer_vat_field(value) -> str:
    """
    C100 field 1215, "מספר עוסק מורשה של הלקוח" (9 digits): the buyer's number exactly as the
    document carries it, padded with zeros on the left — never "repaired". A check digit
    recomputed here would file a number the invoice never showed. Nothing, or a number that
    does not fit nine digits (a foreign one), is filed as zeros.
    """
    raw = "".join(c for c in str(value or "") if c.isdigit())
    if not raw or len(raw) > 9:
        return "000000000"
    return raw.zfill(9)
