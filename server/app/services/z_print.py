"""
A Z as the till prints it: one print document, built here, for every 80 mm copy.

The dashboard's till view and the Android till's reprint both render this document
(`GET /z-reports/{id}/print-document`, `GET /sync/{machine_id}/z-reports/{id}/print-document`),
so the paper reads the same wherever it comes out. Its content mirrors the till's X
(`ReportRenderer.kt`): who issued it, the window, sales gross → net, VAT, tenders, tips,
the drawer, then the card transmission and offline-declined blocks, and a short
section per till.

The shape is fixed — the till is coded against it::

    {"title": "דו״ח Z", "number": 12, "businessName": "...", "subtitle": ["..."],
     "sections": [{"title": "...", "rows": [{"label": "...", "value": "...", "emphasis": false}]}],
     "footer": ["..."]}

Every value is a finished string (₪ with two decimals, dd/mm/yyyy dates in the tenant's
timezone): the renderer only lays lines out. Labels stay short (≤ LABEL_MAX) for 80 mm.

Built only from what the Z stored at build time (its columns, `per_machine`, `header`) —
never recomputed from documents, never from live settings, except the shop's number
in its company, which the dashboard shows live too.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional

from app.models.z_report import ZReport
from app.services import card_brands, offline_authorizations

TITLE = "דו״ח Z"
#: The widest label that still leaves room for a value on 80 mm paper.
LABEL_MAX = 24
DASH = "—"
ZERO = Decimal("0")
CENT = Decimal("0.01")

#: Tenders by their bucket on paper; anything else is "other" (`exchange` has its own line).
_CASH = {"cash"}
_CARD = {"card", "credit"}
_VOUCHER = {"voucher", "vouchers"}
_EXCHANGE = "exchange"


# ── Formatting ────────────────────────────────────────────────────────────────


def _dec(value: Any) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        return value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def money(value: Any) -> str:
    """₪1,234.00 — a negative as -₪1,234.00; a dash for no figure (never a zero)."""
    d = _dec(value)
    if d is None:
        return DASH
    d = d.quantize(CENT)
    sign = "-" if d < 0 else ""
    return f"{sign}₪{abs(d):,.2f}"


def credit(value: Any) -> str:
    """A line that comes off the total (discounts, refunds): shown negative unless zero."""
    d = _dec(value)
    if d is None:
        return DASH
    return money(-abs(d)) if d != 0 else money(ZERO)


def signed(value: Any) -> str:
    """Over/short with its sign: +₪5.00 over, -₪5.00 short."""
    d = _dec(value)
    if d is None:
        return DASH
    return ("+" if d > 0 else "") + money(d)


def _local(moment: Optional[datetime], tzinfo) -> Optional[datetime]:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(tzinfo) if tzinfo is not None else moment


def day(value: Optional[date]) -> str:
    return value.strftime("%d/%m/%Y") if value is not None else DASH


def stamp(moment: Optional[datetime], tzinfo) -> str:
    local = _local(moment, tzinfo)
    return local.strftime("%d/%m/%Y %H:%M") if local is not None else DASH


def short_stamp(moment: Optional[datetime], tzinfo) -> str:
    local = _local(moment, tzinfo)
    return local.strftime("%d/%m %H:%M") if local is not None else DASH


def _parse_iso(text: Any) -> Optional[datetime]:
    if not text:
        return None
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None


def _clip(label: str, limit: int = LABEL_MAX) -> str:
    label = (label or "").strip()
    return label if len(label) <= limit else label[: limit - 1].rstrip() + "…"


def row(label: str, value: Any, emphasis: bool = False) -> Dict[str, Any]:
    return {"label": _clip(label), "value": DASH if value is None else str(value), "emphasis": bool(emphasis)}


def section(title: str, rows: Iterable[Optional[Dict[str, Any]]]) -> Dict[str, Any]:
    return {"title": _clip(title, 32), "rows": [r for r in rows if r is not None]}


def _count(value: Any) -> str:
    return DASH if value is None else str(value)


# ── Blocks ────────────────────────────────────────────────────────────────────


def _sections_of(z: ZReport) -> List[dict]:
    return [s for s in (z.per_machine or []) if isinstance(s, dict)]


def _payment_buckets(breakdown: Optional[dict], z: Optional[ZReport] = None) -> Dict[str, Decimal]:
    out = {"cash": ZERO, "card": ZERO, "voucher": ZERO, "other": ZERO, "exchange": ZERO}
    if not breakdown:
        # A Z with no stored breakdown still has its cash and card columns.
        if z is not None:
            out["cash"] = _dec(z.total_cash_sales) or ZERO
            out["card"] = _dec(z.total_card_sales) or ZERO
        return out
    for method, amount in breakdown.items():
        value = _dec(amount) or ZERO
        m = (method or "").strip().lower()
        if m in _CASH:
            out["cash"] += value
        elif m in _CARD:
            out["card"] += value
        elif m in _VOUCHER:
            out["voucher"] += value
        elif m == _EXCHANGE:
            out["exchange"] += value
        else:
            out["other"] += value
    return out


def _sales_rows(z: ZReport) -> List[Optional[dict]]:
    sales = _dec(z.total_sales)
    refunds = _dec(z.total_refunds)
    discounts = _dec(z.discounts_total)
    net = None if sales is None else sales - (refunds or ZERO)
    rows: List[Optional[dict]] = []
    if sales is not None and discounts is not None:
        rows.append(row("מכירות ברוטו", money(sales + discounts)))
        rows.append(row("הנחות", credit(discounts)))
        # Item discounts are already inside the lines (and so inside the gross above):
        # shown for information, not taken off again.
        line_discounts = _dec((z.header or {}).get("lineDiscountsTotal"))
        if line_discounts:
            rows.append(row("הנחות פריט (כלולות)", credit(line_discounts)))
        # Promotions ("מבצעים") likewise: part of the discounts above, shown apart.
        promotion_discounts = _dec((z.header or {}).get("promotionDiscountsTotal"))
        if promotion_discounts:
            rows.append(row("הנחות מבצעים (כלולות)", credit(promotion_discounts)))
    else:
        rows.append(row("מכירות", money(sales)))
    rows.append(row("זיכויים", credit(refunds)))
    rows.append(row("סה״כ נטו", money(net), emphasis=True))
    rows.append(row("מסמכים", _count(z.transactions_count)))
    return rows


#: An exempt dealer's Z, in place of the VAT split (docs/SPEC_BUSINESS_TYPE.md).
EXEMPT_NO_VAT = "עוסק פטור — ללא מע״מ"


def _vat_rows(z: ZReport, dealer_type: Optional[str] = None) -> List[Optional[dict]]:
    vat = _dec(z.vat_total)
    sales = _dec(z.total_sales)
    net = None if sales is None else sales - (_dec(z.total_refunds) or ZERO)
    dealer = dealer_type or (getattr(z, "header", None) or {}).get("dealerType")
    # An exempt dealer's Z has no VAT to split. Only when it really has none: a Z of the
    # day the type changed may still hold VAT documents, and then the split is printed.
    if dealer == "exempt" and (vat is None or vat == 0):
        return [row("מע״מ", EXEMPT_NO_VAT)]
    if vat is None:
        return [row("מע״מ", "לא ידוע")]
    return [
        row("נטו ללא מע״מ", money(net - vat) if net is not None else DASH),
        row("מע״מ", money(vat)),
        row("נטו כולל מע״מ", money(net)),
    ]


def _payment_rows(z: ZReport) -> List[Optional[dict]]:
    b = _payment_buckets(z.payment_breakdown, z)
    return [
        row("מזומן", money(b["cash"])),
        row("אשראי", money(b["card"])),
        row("שוברים", money(b["voucher"])),
        row("אחר", money(b["other"])),
        # Only on a Z with mixed baskets: an offset, never money anyone took.
        row("קיזוז החלפה", money(b["exchange"])) if b["exchange"] != 0 else None,
    ]


def _tips_rows(z: ZReport) -> List[Optional[dict]]:
    return [
        row("תשר מזומן", money(z.total_cash_tips if z.total_cash_tips is not None else ZERO)),
        row("תשר אשראי", money(z.total_card_tips if z.total_card_tips is not None else ZERO)),
        row("סה״כ תשר", money(z.total_tips if z.total_tips is not None else ZERO), emphasis=True),
    ]


def _uncounted_shifts(z: ZReport) -> int:
    return sum(int(s.get("uncountedShiftCount") or 0) for s in _sections_of(z))


def _cash_rows(z: ZReport) -> List[Optional[dict]]:
    adjustments = None
    sections = _sections_of(z)
    if sections and all(s.get("betweenShiftAdjustments") is not None for s in sections):
        adjustments = sum((_dec(s.get("betweenShiftAdjustments")) or ZERO for s in sections), ZERO)
    withheld = z.actual_cash is None
    uncounted = _uncounted_shifts(z)
    if withheld:
        counted = f"לא נספר ({uncounted} משמרות)" if uncounted > 1 else "לא נספר"
    else:
        counted = money(z.actual_cash)
    return [
        row("קופה פותחת", money(z.opening_cash)),
        row("תנועות בין משמרות", signed(adjustments)) if adjustments else None,
        row("מזומן צפוי", money(z.expected_cash), emphasis=True),
        row("מזומן שנספר", counted),
        # Withheld, not a balanced zero, when any drawer was not counted.
        row("הפרש", "לא חושב" if withheld or z.discrepancy is None else signed(z.discrepancy), emphasis=True),
    ]


def _card_brand_sections(z: ZReport) -> List[dict]:
    """
    Card takings per brand (מותג) and per acquirer (חברת סליקה), from the `cardBrands`
    each till's section froze at build time. None for a Z built before them.
    """
    if not any(isinstance(s.get("cardBrands"), list) and s.get("cardBrands") for s in _sections_of(z)):
        return []
    rows = card_brands.merge_breakdowns(s.get("cardBrands") for s in _sections_of(z))
    out = []
    for key, title, label_of in (
        ("brand", "אשראי לפי מותג", card_brands.brand_label),
        ("acquirer", "אשראי לפי חברת סליקה", card_brands.acquirer_label),
    ):
        lines: List[Optional[dict]] = []
        for r in card_brands.totals_by(rows, key):
            count = int(r["salesCount"]) + int(r["refundsCount"])
            lines.append(row(f"{label_of(r[key])} ({count})", money(r["net"])))
            if int(r["refundsCount"]):
                lines.append(row(f"  מתוכם זיכויים ({r['refundsCount']})", credit(r["refundsAmount"])))
        out.append(section(title, lines))
    return out


def _transmission_section(z: ZReport, tzinfo) -> Optional[dict]:
    blocks = [s.get("transmission") for s in _sections_of(z) if isinstance(s.get("transmission"), dict)]
    blocks = [b for b in blocks if int(b.get("cardLegs") or 0) > 0 or b.get("batches")]
    if not blocks:
        return None
    card_legs = sum(int(b.get("cardLegs") or 0) for b in blocks)
    transmitted = sum(int(b.get("transmittedLegs") or 0) for b in blocks)
    pending = sum(int(b.get("untransmittedLegs") or 0) for b in blocks)
    pending_amount = sum((_dec(b.get("untransmittedAmount")) or ZERO for b in blocks), ZERO)
    untracked = sum(int(b.get("untrackedLegs") or 0) for b in blocks)
    batches = [batch for b in blocks for batch in (b.get("batches") or []) if isinstance(batch, dict)]
    batches.sort(key=lambda r: _parse_iso(r.get("startedAt")) or datetime.min.replace(tzinfo=timezone.utc))
    last = batches[-1] if batches else None
    rows: List[Optional[dict]] = [
        row("עסקאות אשראי", str(card_legs)),
        row("שודרו", str(transmitted)),
        row("ממתינות לשידור", str(pending), emphasis=pending > 0),
        row("סכום ממתין", money(pending_amount), emphasis=True) if pending > 0 else None,
        row("לפני מעקב שידור", str(untracked)) if untracked > 0 else None,
        row("אצוות בתקופה", str(len(batches))),
    ]
    if last is not None:
        number = last.get("batchNumber")
        when = short_stamp(_parse_iso(last.get("startedAt")), tzinfo)
        rows.append(row("שידור אחרון", f"#{number} {when}" if number not in (None, "") else when))
        rows.append(row("סכום שידור אחרון", money(last.get("amount"))))
    return section("שידור אשראי", rows)


def _offline_section(z: ZReport) -> Optional[dict]:
    totals = offline_authorizations.z_totals(z.per_machine)
    if not totals:
        return None
    if not (totals["authorization_count"] or totals["approved_count"] or totals["declined_count"]):
        return None
    declined = [
        d
        for s in _sections_of(z)
        if isinstance(s.get("offline"), dict)
        for d in (s["offline"].get("declined") or [])
        if isinstance(d, dict)
    ]
    rows: List[Optional[dict]] = [
        row("הרצות אישור", str(totals["authorization_count"])),
        row("אושרו", str(totals["approved_count"])),
        row("נדחו", str(totals["declined_count"]), emphasis=totals["declined_count"] > 0),
        row("סכום שנדחה", money(totals["declined_amount"]), emphasis=totals["declined_count"] > 0),
    ]
    for d in declined:
        number = d.get("documentNumber") or str(d.get("transactionId") or "")[:8] or DASH
        rows.append(row(f"מסמך {number}", money(d.get("amount"))))
    return section("אשראי אופליין שנדחה" if totals["declined_count"] else "אשראי אופליין", rows)


def _waiters_section(z: ZReport) -> Optional[dict]:
    """
    "מלצרים": per waiter (app/services/z_waiters.py) — the net, then tables · guests and
    tips when there are any. Only on a Z that froze the breakdown (`header.byWaiter`).
    """
    waiters = [w for w in ((z.header or {}).get("byWaiter") or []) if isinstance(w, dict)]
    if not waiters:
        return None
    rows: List[Optional[dict]] = []
    for w in waiters:
        name = (w.get("waiter") or "").strip() or "ללא שיוך"
        rows.append(row(name, f"{money(w.get('net'))} · {_count(w.get('salesCount'))} מס׳", emphasis=True))
        if w.get("tables"):
            rows.append(row("· שולחנות / סועדים", f"{w.get('tables')} / {_count(w.get('guests'))}"))
        if (_dec(w.get("tips")) or ZERO) != 0:
            rows.append(row("· תשר", money(w.get("tips"))))
    return section("מלצרים", rows)


def _till_title(s: dict) -> str:
    pos = s.get("posNumber")
    name = (s.get("machineName") or "").strip()
    head = f"קופה {pos}" if pos not in (None, "") else "קופה"
    return f"{head} · {name}" if name else head


#: The document range rows of a Z, per number series (docs/SPEC_DOCUMENT_PREFIX.md).
DOCUMENT_RANGE_LABELS = {320: "חשבוניות מס קבלה", 330: "חשבוניות זיכוי", 400: "קבלות"}


def _document_rows(s: dict) -> List[Dict[str, Any]]:
    """
    "מסמכים" as a range per document type — each type is numbered on its own series — from
    the section's `documentRanges`; a Z built before that has the one range it had.
    """
    ranges = s.get("documentRanges") if isinstance(s.get("documentRanges"), list) else []
    rows: List[Dict[str, Any]] = []
    for r in ranges:
        if not isinstance(r, dict):
            continue
        first, last = r.get("first"), r.get("last")
        if not (first or last):
            continue
        value = f"{first}–{last}" if first and last and first != last else (last or first)
        try:
            label = DOCUMENT_RANGE_LABELS.get(int(r.get("documentType")), "מסמכים")
        except (TypeError, ValueError):
            label = "מסמכים"
        rows.append(row(label, value))
    if rows:
        return rows
    first_doc, last_doc = s.get("firstDocumentNumber"), s.get("lastDocumentNumber")
    docs = f"{first_doc}–{last_doc}" if first_doc and last_doc and first_doc != last_doc else (last_doc or first_doc)
    return [row("מסמכים", docs)] if docs else []


def _till_section(s: dict) -> dict:
    first, last = s.get("firstShiftSequence"), s.get("lastShiftSequence")
    shifts = _count(s.get("shiftCount"))
    if first is not None and last is not None:
        shifts = f"{shifts} (#{first}–#{last})" if first != last else f"{shifts} (#{first})"
    net = _dec(s.get("netSales"))
    if net is None and _dec(s.get("totalSales")) is not None:
        net = _dec(s.get("totalSales")) - (_dec(s.get("totalRefunds")) or ZERO)
    uncounted = int(s.get("uncountedShiftCount") or 0)
    transmission = s.get("transmission") if isinstance(s.get("transmission"), dict) else {}
    pending = int(transmission.get("untransmittedLegs") or 0)
    declined_count, declined_amount = offline_authorizations.section_declined(s)
    return section(
        _till_title(s),
        [
            row("משמרות", shifts),
            *_document_rows(s),
            row("סה״כ נטו", money(net), emphasis=True),
            row("מזומן", money(s.get("totalCash"))),
            row("אשראי", money(s.get("totalCard"))),
            row("מזומן צפוי", money(s.get("expectedCash"))),
            row("הפרש", "לא נספר" if uncounted else signed(s.get("overShort"))),
            row("ממתינות לשידור", str(pending), emphasis=True) if pending else None,
            row("אופליין שנדחה", f"{declined_count} · {money(declined_amount)}", emphasis=True)
            if declined_count
            else None,
        ],
    )


# ── The document ──────────────────────────────────────────────────────────────


def _business_name(z: ZReport) -> str:
    header = z.header or {}
    shop = z.shop
    return header.get("businessName") or header.get("shopName") or (shop.name if shop is not None else None) or DASH


def branch_code_of(z: ZReport) -> Optional[str]:
    """
    The shop's branch code ("קוד סניף") on the Z: as frozen in its header, else the shop's
    now (a Z built before the header carried it). In one branch a shop Z and its tills' own
    Zs are separate runs — the owner: the branch code is on all of them, and the till number
    tells them apart (docs/SPEC_INDEPENDENT_TILL.md §11).
    """
    code = (getattr(z, "header", None) or {}).get("branchId")
    shop = getattr(z, "shop", None)
    if not code and shop is not None:
        code = getattr(shop, "branch_id", None)
    code = str(code).strip() if code is not None else ""
    return code or None


def till_number_of(z: ZReport) -> Optional[str]:
    """A till Z's register number, as frozen in its one section (else its till's now)."""
    if not getattr(z, "is_till_z", False):
        return None
    sections = getattr(z, "per_machine", None) or []
    pos = sections[0].get("posNumber") if sections and isinstance(sections[0], dict) else None
    machine = getattr(z, "machine", None)
    if pos in (None, "") and machine is not None:
        pos = machine.pos_number
    return str(pos).strip() if pos not in (None, "") else None


def sequence_started_of(z: ZReport) -> Optional[str]:
    """
    When a till Z's run began (`header.sequence.startedAt`), for a run that is not the
    till's first: an independent till starts again at Z 1 (SPEC_INDEPENDENT_TILL §3.1), and
    the date tells its "Z 1" from an older one. None for a first run or a shop Z.
    """
    seq = (getattr(z, "header", None) or {}).get("sequence") or {}
    if not getattr(z, "is_till_z", False) or not int(getattr(z, "machine_sequence_epoch", 0) or 0):
        return None
    return seq.get("startedAt")


def sequence_started_label(z: ZReport, tzinfo=None) -> Optional[str]:
    """ "רצף מ-06/10/2026": a till Z's run, by the day it began (None: the till's first run)."""
    started = _parse_iso(sequence_started_of(z))
    if started is None:
        return None
    local = _local(started, tzinfo) if tzinfo is not None else started
    return f"רצף מ-{local.strftime('%d/%m/%Y')}"


def _subtitle(z: ZReport, tzinfo) -> List[str]:
    """Who issued it and when: the lines under the title, the same on every part."""
    header = z.header or {}
    shop = z.shop
    shop_name = header.get("shopName") or (shop.name if shop is not None else None)
    shop_number = shop.shop_number if shop is not None else None
    reg = header.get("companyRegNumber") or header.get("vatNumber")

    subtitle: List[str] = []
    if reg:
        # "ח.פ." / "עוסק מורשה" / "עוסק פטור" as the Z was built (SPEC_BUSINESS_TYPE.md).
        from app.services.dealer_types import reg_label

        subtitle.append(f"{reg_label(header.get('dealerType'))} {reg}")
    if shop_name:
        subtitle.append(f"סניף {shop_name}" + (f" #{shop_number}" if shop_number is not None else ""))
    # The branch code on every Z — shop Z, till Z, independent till Z (§11 of the spec).
    code = branch_code_of(z)
    if code:
        subtitle.append(f"קוד סניף {code}")
    area = header.get("areaName") if z.area_id is not None else None
    if area:
        subtitle.append(f"אזור {area}")
    if z.per_machine is None and z.machine_id is not None and z.machine is not None:
        subtitle.append(f"קופה {z.machine.name}")
    till = till_number_of(z)
    if till:
        # A till Z is told apart from the shop's Z, and from another till's, by its till.
        independent = (header.get("scope") or {}).get("kind") == "independent_till"
        line = f"קופה {till}" + (" (עצמאית)" if independent else "")
        # Made independent, a till starts again at Z 1: the run's first day says which "Z 1".
        run = sequence_started_label(z, tzinfo)
        if run:
            line += f" · {run}"
        subtitle.append(line)
    scope = header.get("scope") or {}
    if scope.get("kind") in ("shop", "area") and scope.get("label"):
        subtitle.append(str(scope["label"]))
    subtitle.append(f"תאריך עסקים {day(z.business_date)}")
    subtitle.append(f"הופק {stamp(z.closed_at, tzinfo)}")
    return subtitle


def _replaced_line(note: dict, tzinfo=None) -> Optional[str]:
    """"המכשיר הוחלף בתאריך …" — the first Z after a till's device was replaced (§4.6.2)."""
    raw = note.get("at")
    if not raw:
        return None
    try:
        moment = datetime.fromisoformat(str(raw))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    when = day(moment.astimezone(tzinfo).date()) if tzinfo is not None else day(moment.date())
    till = note.get("posNumber") or note.get("name")
    return f"המכשיר הוחלף בתאריך {when}" + (f" (קופה {till})" if till else "")


def _late_section(late: dict) -> dict:
    """"מסמכים מאוחרים מתקופה קודמת (קופה N, הופקו לפני Z מס׳ X שהופק ע״י התמיכה)"."""
    first, last = late.get("firstDocumentNumber"), late.get("lastDocumentNumber")
    number = late.get("sourceZNumber")
    # The 80 mm title is short; the rest of the owner's words are the first rows.
    return section(
        "מסמכים מאוחרים מתקופה קודמת",
        [
            row("קופה", late.get("posNumber")),
            row("הופקו לפני Z" if late.get("producedBySupport", True) else "הגיעו אחרי Z",
                f"מס׳ {number if number is not None else DASH}"),
            row("ה-Z הופק ע״י", "התמיכה") if late.get("producedBySupport", True) else None,
            row("המשמרת נסגרה ע״י", "התמיכה") if late.get("shiftClosedBySupport") else None,
            row("מסמכים", _count(late.get("documents"))),
            row("מס׳", f"{first}–{last}" if first and last and first != last else (first or last)) if (first or last) else None,
            row("מכירות", money(late.get("totalSales"))),
            row("זיכויים", credit(late.get("totalRefunds"))) if late.get("totalRefunds") not in (None, "0.00") else None,
            row("מזומן", money(late.get("totalCash"))),
            row("אשראי", money(late.get("totalCard"))),
            row("מע״מ", money(late.get("vatTotal"))) if late.get("vatTotal") is not None else None,
        ],
    )


def _footer_notes(z: ZReport, tzinfo=None) -> List[str]:
    """What the Z says about itself: reconstructed, remote closes, late documents, tills left out."""
    header = z.header or {}
    footer: List[str] = []
    for note in header.get("devicesReplaced") or []:
        line = _replaced_line(note, tzinfo)
        if line:
            footer.append(line)
    if z.reconstructed:
        footer.append("כולל משמרת ששוחזרה בענן")
    if z.unattended:
        footer.append("כולל משמרת שנסגרה מרחוק")
    if z.late_documents:
        footer.append(f"{z.late_documents} מסמכים הגיעו אחרי ההפקה ואינם בדו״ח")
    if z.amended_documents:
        footer.append(f"{z.amended_documents} מסמכים תוקנו אחרי ההפקה")
    if z.per_machine is None and z.machine_id is not None:
        footer.append("דו״ח Z ישן שהופק בקופה")
    left_out = header.get("openTillsLeftOut") or {}
    if left_out.get("tills"):
        tills = ", ".join(
            str(t.get("posNumber") or t.get("name") or t.get("id")) for t in left_out["tills"]
        )
        line = f"הופק ללא קופות: {tills}"
        if left_out.get("confirmedByName"):
            line += f" — אושר ע״י {left_out['confirmedByName']}"
        footer.append(line)
    return footer


def build_print_document(z: ZReport, tzinfo, *, printed_at: Optional[datetime] = None) -> Dict[str, Any]:
    """The Z as an 80 mm print document (the module docstring has the shape)."""
    header = z.header or {}
    shop = z.shop
    shop_name = header.get("shopName") or (shop.name if shop is not None else None)
    subtitle = _subtitle(z, tzinfo)

    sections: List[dict] = [
        section(
            "תקופה",
            [
                row("מ-", stamp(z.period_start, tzinfo)) if z.period_start else None,
                row("עד", stamp(z.period_end, tzinfo)) if z.period_end else None,
                row("משמרות", _count(z.shift_count)),
                row("קופות", _count(z.machine_count if z.machine_count is not None else (1 if z.machine_id else None))),
            ],
        ),
        section("מכירות", _sales_rows(z)),
        section("מע״מ", _vat_rows(z)),
        section("אמצעי תשלום", _payment_rows(z)),
        section("תשר", _tips_rows(z)),
        section("קופה", _cash_rows(z)),
    ]
    sections += _card_brand_sections(z)
    transmission = _transmission_section(z, tzinfo)
    if transmission is not None:
        sections.append(transmission)
    offline = _offline_section(z)
    if offline is not None:
        sections.append(offline)
    # Late documents of a support Z, carried into this Z (SPEC_OFFLINE_TILL_Z §4.6.3).
    for late in (z.header or {}).get("lateFromEarlier") or []:
        sections.append(_late_section(late))
    waiters = _waiters_section(z)
    if waiters is not None:
        sections.append(waiters)
    for s in _sections_of(z):
        sections.append(_till_section(s))

    footer = _footer_notes(z, tzinfo)
    footer.append(f"הודפס {stamp(printed_at or datetime.now(timezone.utc), tzinfo)}")
    footer.append(f"סוף {TITLE}" + (f" #{z.z_number}" if z.z_number is not None else ""))

    return {
        "title": TITLE,
        "number": z.z_number,
        "businessName": header.get("businessName") or shop_name or DASH,
        "subtitle": subtitle,
        "sections": sections,
        "footer": footer,
    }


# ── A shop Z in parts: one summary, then each till on its own ─────────────────
#
# A shop Z over many tills is a long strip when every till's section is in it. The
# master till prints the summary — the shop's totals and one line per till — and then,
# if the operator asks, each till's detail as a document of its own, with its own header
# and cut, in till-number order. The full document above stays what the dashboard prints.


def _pos_key(s: dict):
    pos = str(s.get("posNumber") or "").strip()
    return (0, int(pos), "") if pos.isdigit() else (1, 0, pos or str(s.get("machineName") or ""))


def _ordered_sections(z: ZReport) -> List[dict]:
    """The tills' sections in till-number order."""
    return sorted(_sections_of(z), key=_pos_key)


def z_tills(z: ZReport) -> List[Dict[str, Any]]:
    """The tills a Z covers, in till-number order: what a till offers to print apart."""
    return [
        {"machineId": str(s.get("machineId")), "posNumber": s.get("posNumber"), "name": s.get("machineName")}
        for s in _ordered_sections(z)
        if s.get("machineId")
    ]


def _shifts_label(s: dict) -> Optional[str]:
    first, last = s.get("firstShiftSequence"), s.get("lastShiftSequence")
    if first is None or last is None:
        return None
    return f"#{first}" if first == last else f"#{first}–{last}"


def _section_net(s: dict) -> Optional[Decimal]:
    net = _dec(s.get("netSales"))
    if net is None and _dec(s.get("totalSales")) is not None:
        net = _dec(s.get("totalSales")) - (_dec(s.get("totalRefunds")) or ZERO)
    return net


def _till_line(s: dict) -> dict:
    """One till on the summary, on one line: its number (or name), shifts, net and documents."""
    pos = s.get("posNumber")
    name = (s.get("machineName") or "").strip()
    label = f"קופה {pos}" if pos not in (None, "") else (name or "קופה")
    shifts = _shifts_label(s)
    if shifts:
        label += f" · מש׳ {shifts}"
    return row(label, f"{money(_section_net(s))} · {_count(s.get('transactionsCount'))} מס׳")


def build_summary_document(z: ZReport, tzinfo, *, printed_at: Optional[datetime] = None) -> Dict[str, Any]:
    """
    The shop Z's summary: the shop's totals and one compact line per till (number,
    shifts, net, documents) — no till's detail. `tills` lists them for printing apart.
    """
    sections: List[dict] = [
        section(
            "תקופה",
            [
                row("מ-", stamp(z.period_start, tzinfo)) if z.period_start else None,
                row("עד", stamp(z.period_end, tzinfo)) if z.period_end else None,
                row("משמרות", _count(z.shift_count)),
                row("קופות", _count(z.machine_count if z.machine_count is not None else (1 if z.machine_id else None))),
            ],
        ),
        section("מכירות", _sales_rows(z)),
        section("מע״מ", _vat_rows(z)),
        section("אמצעי תשלום", _payment_rows(z)),
        section("תשר", _tips_rows(z)),
        section("קופה", _cash_rows(z)),
    ]
    sections += _card_brand_sections(z)
    transmission = _transmission_section(z, tzinfo)
    if transmission is not None:
        sections.append(transmission)
    offline = _offline_section(z)
    if offline is not None:
        sections.append(offline)
    # Late documents of a support Z, carried into this Z (SPEC_OFFLINE_TILL_Z §4.6.3).
    for late in (z.header or {}).get("lateFromEarlier") or []:
        sections.append(_late_section(late))
    lines = [_till_line(s) for s in _ordered_sections(z)]
    if lines:
        sections.append(section("קופות", lines))
    waiters = _waiters_section(z)
    if waiters is not None:
        sections.append(waiters)

    footer = _footer_notes(z, tzinfo)
    if lines:
        footer.append("פירוט מלא לכל קופה — בהדפסה נפרדת")
    footer.append(f"הודפס {stamp(printed_at or datetime.now(timezone.utc), tzinfo)}")
    footer.append(f"סוף סיכום {TITLE}" + (f" #{z.z_number}" if z.z_number is not None else ""))
    return {
        "title": TITLE,
        "number": z.z_number,
        "businessName": _business_name(z),
        "subtitle": ["סיכום סניף", *_subtitle(z, tzinfo)],
        "sections": sections,
        "footer": footer,
        "tills": z_tills(z),
    }


class _TillAsZ:
    """One till's section of a Z, read through the attributes the Z's blocks read."""

    def __init__(self, s: dict):
        self.per_machine = [s]
        self.header = {
            "lineDiscountsTotal": s.get("lineDiscountsTotal"),
            "promotionDiscountsTotal": s.get("promotionDiscountsTotal"),
        }
        self.total_sales = _dec(s.get("totalSales"))
        self.total_refunds = _dec(s.get("totalRefunds"))
        self.discounts_total = _dec(s.get("discountsTotal"))
        self.transactions_count = s.get("transactionsCount")
        self.vat_total = _dec(s.get("vatTotal"))
        self.payment_breakdown = s.get("paymentBreakdown")
        self.total_cash_sales = _dec(s.get("totalCash"))
        self.total_card_sales = _dec(s.get("totalCard"))
        self.total_tips = _dec(s.get("totalTips"))
        self.total_cash_tips = _dec(s.get("totalCashTips"))
        self.total_card_tips = _dec(s.get("totalCardTips"))
        self.opening_cash = _dec(s.get("openingCash"))
        self.expected_cash = _dec(s.get("expectedCash"))
        self.actual_cash = _dec(s.get("countedCash"))
        self.discrepancy = _dec(s.get("overShort"))


def build_till_document(
    z: ZReport, machine_id: Any, tzinfo, *, printed_at: Optional[datetime] = None
) -> Optional[Dict[str, Any]]:
    """
    One till's part of a shop Z, as a document of its own: the same blocks as the Z,
    from that till's section only (frozen at build time like the rest). None if the Z
    has no such till.
    """
    s = next((s for s in _sections_of(z) if str(s.get("machineId")) == str(machine_id)), None)
    if s is None:
        return None
    view = _TillAsZ(s)
    title = _till_title(s)
    shifts = _count(s.get("shiftCount"))
    if _shifts_label(s):
        shifts = f"{shifts} ({_shifts_label(s)})"
    sections: List[dict] = [
        section("משמרות", [row("משמרות", shifts), *_document_rows(s)]),
        section("מכירות", _sales_rows(view)),  # type: ignore[arg-type]
        section("מע״מ", _vat_rows(view, (z.header or {}).get("dealerType"))),  # type: ignore[arg-type]
        section("אמצעי תשלום", _payment_rows(view)),  # type: ignore[arg-type]
        section("תשר", _tips_rows(view)),  # type: ignore[arg-type]
        section("קופה", _cash_rows(view)),  # type: ignore[arg-type]
    ]
    sections += _card_brand_sections(view)  # type: ignore[arg-type]
    transmission = _transmission_section(view, tzinfo)  # type: ignore[arg-type]
    if transmission is not None:
        sections.append(transmission)
    offline = _offline_section(view)  # type: ignore[arg-type]
    if offline is not None:
        sections.append(offline)

    footer: List[str] = []
    if int(s.get("reconstructedShiftCount") or 0):
        footer.append("כולל משמרת ששוחזרה בענן")
    if int(s.get("unattendedShiftCount") or 0):
        footer.append("כולל משמרת שנסגרה מרחוק")
    footer.append(f"הודפס {stamp(printed_at or datetime.now(timezone.utc), tzinfo)}")
    number = f" · {TITLE} #{z.z_number}" if z.z_number is not None else ""
    footer.append(f"סוף פירוט {title}{number}")
    return {
        "title": TITLE,
        "number": z.z_number,
        "businessName": _business_name(z),
        "subtitle": [f"פירוט {title}", *_subtitle(z, tzinfo)],
        "sections": sections,
        "footer": footer,
    }


def list_item(z: ZReport, tzinfo) -> Dict[str, Any]:
    """One row of the till's Z list (`GET /sync/{machine_id}/z-reports`)."""
    produced = _local(z.closed_at, tzinfo)
    return {
        "id": str(z.id),
        "number": z.z_number,
        "businessDate": z.business_date.isoformat() if z.business_date else None,
        "productionDate": produced.date().isoformat() if produced is not None else None,
        "producedAt": produced.isoformat() if produced is not None else None,
        "totalSales": money(z.total_sales),
        "shiftCount": z.shift_count,
        "machineCount": z.machine_count if z.machine_count is not None else (1 if z.machine_id else None),
        # Its tills, in till-number order, for printing a till's detail on its own.
        "tills": z_tills(z),
        # Two Zs of one branch with the same number are told apart by the till (§11).
        "branchCode": branch_code_of(z),
        "posNumber": till_number_of(z),
        # …and two "Z 1" of one till by its run (SPEC_INDEPENDENT_TILL §3.1).
        "sequenceEpoch": int(getattr(z, "machine_sequence_epoch", 0) or 0),
        "sequenceStartedAt": sequence_started_of(z),
    }
