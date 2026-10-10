"""
"דו״ח Z — גרסה 2": the Z report's presentation sections, one computation on the till and here.

The owner's reference Z (09.10) reads, after its header and the period: sales (incl. VAT,
without tip) — before discounts and refunds, discounts, refunds, total; the VAT summary; the
payments for the sales (cash / card / vouchers); the tips taken at the till; the receipts from
sales and tips; the cash drawer reconciliation; then the footer. Beside them the owner asked
for: the card transmission ("שודר ✓ / לא שודר / שודר חלקית", per terminal, the terminal number
masked to its last 4 digits, matched against the till's card total), "כמה נמכר" (documents,
units, the average sale), the sales by order type (tables / quick order / kiosk / any other
channel the data has), per employee (the till parameter `zShowPerEmployee`), and the card
brands with the split into sale and tip.

**Presentation only.** Nothing here is a fiscal figure: the Z's own columns, its numbering, the
uniform file and the VAT stay as they are. The sections are derived from the same documents the
Z's figures are (`app.services.shift_totals` counts them the same way), and the drawer's
figures are the Z's own — opening, expected, counted and over/short are taken, never recomputed.

**One computation in both repos.** The till's twin is `domain/ZReportSections.kt` (pos-android);
the dashboard renders the same lines (`client/src/lib/zReportSections.ts`). All three run the
shared golden fixture `tests/fixtures/z_report_v2_golden.json` (the same bytes in pos-android's
`app/src/test/resources/`): the same documents in, the same sections and the same paper lines
out — so the printed till Z (and X), the cloud Z and the dashboard's Z page say one thing.

A document, as the computation reads it (`facts`; money as decimal strings)::

    {"id", "type", "status", "refundOf", "total", "discount", "deduction", "vat", "vatRate",
     "tip", "tipMethod", "paymentMethod", "payments": [{"method", "amount", "brand"}],
     "units", "orderType", "employeeId", "employeeName", "voucherMemo"}

- Counted: status `completed`, `refunded` or `partial_refund`; a ₪0 production-voucher memo
  (`voucherMemo` with no total and no tip) is no document at all — as the Z's counts.
- A credit: type 330 or -400, or a document that names the sale it refunds. It contributes its
  `total` (already the money handed back); a sale its `total - discount`.
- `deduction`: a production voucher's deduction (in neither the gross nor the discounts).
- Legs: as recorded, in order; a document with none has one for its collected amount by its
  payment method. A card tip is charged with the document's last card leg (the terminal's
  batch holds it so), so its brand is that leg's — "other" when it had none.
- `orderType`: tables | quick | kiosk | takeaway | delivery | …; none is a quick order.
- `employeeId` / `employeeName`: whose document it is (a table's waiter, else its cashier).

Pure: no database, no clock. The database side (`sections_for_z`) only gathers the facts.
"""
from __future__ import annotations

import logging
import uuid
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

VERSION = 1

#: The till parameter that adds the per-employee section (company → shop → area → till).
SHOW_PER_EMPLOYEE_KEY = "zShowPerEmployee"
#: The drawer parameter that makes counting part of the close ("ספירה עיוורת": the cashier
#: counts before seeing the expected cash). Off: the Z hides counted / gap unless a count was
#: made anyway (the owner, 09.10).
BLIND_COUNT_KEY = "cashDrawer.blindCount"

COUNTED_STATUSES = ("completed", "refunded", "partial_refund")
CREDIT_TYPES = (330, -400)

#: Order types in the order the paper lists them; anything else follows, by name.
ORDER_TYPES = ("tables", "quick", "kiosk", "takeaway", "delivery")
DEFAULT_ORDER_TYPE = "quick"
#: Card brands in the order the paper lists them; a leg of no known brand is "other", last.
BRANDS = ("visa", "mastercard", "isracard", "amex", "diners", "jcb", "discover", "maestro")
OTHER_BRAND = "other"
#: Tenders: cash and card always, then these when not zero, then the rest by name, no-money last.
PAYMENT_ORDER = ("cash", "card", "voucher", "exchange")
NO_MONEY = "no_money"
_VOUCHER_METHODS = ("voucher", "vouchers", "production_voucher")

#: Transmission states, per terminal and overall.
SENT, PARTIAL, NOT_SENT = "sent", "partial", "not_sent"

_CENT = Decimal("0.01")
_MILLI = Decimal("0.001")


# ── Values ────────────────────────────────────────────────────────────────────


def agorot(value: Any) -> Optional[int]:
    """Money to agorot, half away from zero (null stays null; unreadable is null)."""
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        amount = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite():
        return None
    return int((amount * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def money(value: Optional[int]) -> Optional[str]:
    """Agorot as a decimal string: "12.30", "-0.50"."""
    if value is None:
        return None
    sign = "-" if value < 0 else ""
    whole, cents = divmod(abs(int(value)), 100)
    return f"{sign}{whole}.{cents:02d}"


def _ag(value: Any) -> int:
    return agorot(value) or 0


def _milli(value: Any) -> int:
    """A quantity in thousandths, half away from zero (null is 0)."""
    if value is None or value == "" or isinstance(value, bool):
        return 0
    try:
        q = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError):
        return 0
    if not q.is_finite():
        return 0
    return int((q * 1000).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def units_text(milli: int) -> str:
    """Thousandths as the paper prints a quantity: "2", "2.5", "0.125"."""
    d = (Decimal(int(milli)) / 1000).quantize(_MILLI)
    text = format(d.normalize(), "f")
    return "0" if text in ("-0", "") else text


def average(total: int, count: int) -> int:
    """total / count in agorot, half away from zero; 0 with no count."""
    if count <= 0:
        return 0
    q = (Decimal(int(total)) / Decimal(int(count))).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    return int(q)


def rate_key(rate: Any) -> Optional[str]:
    """A VAT rate as a percent label: 0.18 and 18 are both "18"; 17.5 is "17.5"; null stays null."""
    if rate is None or rate == "" or isinstance(rate, bool):
        return None
    try:
        r = rate if isinstance(rate, Decimal) else Decimal(str(rate))
    except (InvalidOperation, ValueError):
        return None
    if not r.is_finite():
        return None
    if abs(r) <= 1:
        r = r * 100
    r = r.quantize(_CENT, rounding=ROUND_HALF_UP)
    text = format(r.normalize(), "f")
    return "0" if text in ("-0", "") else text


def mask_terminal(raw: Any) -> Optional[str]:
    """A terminal number as the paper may show it: its last 4 digits only ("****4567")."""
    if raw is None:
        return None
    text = "".join(str(raw).split())
    if not text:
        return None
    return "****" + text[-4:]


def canonical_method(method: Any) -> str:
    m = (str(method) if method is not None else "").strip().lower()
    if not m:
        return "other"
    if m == "credit":
        return "card"
    if m in _VOUCHER_METHODS:
        return "voucher"
    return m


def canonical_brand(brand: Any) -> str:
    b = (str(brand) if brand is not None else "").strip().lower()
    return b if b in BRANDS else OTHER_BRAND


def canonical_type(order_type: Any) -> str:
    t = (str(order_type) if order_type is not None else "").strip().lower()
    return t or DEFAULT_ORDER_TYPE


def _order(keys: Iterable[str], first: Sequence[str], last: Sequence[str] = ()) -> List[str]:
    keys = set(keys)
    head = [k for k in first if k in keys]
    tail = [k for k in last if k in keys]
    rest = sorted(k for k in keys if k not in first and k not in last)
    return head + rest + tail


def is_credit(doc: Dict[str, Any]) -> bool:
    t = doc.get("type")
    try:
        if t is not None and int(t) in CREDIT_TYPES:
            return True
    except (TypeError, ValueError):
        pass
    ref = doc.get("refundOf")
    return bool(str(ref).strip()) if ref is not None else False


def is_counted(doc: Dict[str, Any]) -> bool:
    return (doc.get("status") or "").strip().lower() in COUNTED_STATUSES


def _tip_is_cash(tip_method: Any, sale_method: Any) -> bool:
    """`shift_totals.tip_goes_to_cash`: the tip's own method, else the sale's; cash or card."""
    method = (str(tip_method or sale_method or "")).strip().lower()
    if method in ("cash", "card"):
        return method == "cash"
    return (str(sale_method or "")).strip().lower() == "cash"


# ── The accumulator ───────────────────────────────────────────────────────────


class _Acc:
    """The sections' raw sums, in agorot; `finish` derives every total, average and state."""

    def __init__(self) -> None:
        self.gross = 0
        self.discounts = 0
        self.refunds = 0
        self.vat_known = True
        self.vat = 0
        self.vat_total = 0
        self.rates: Dict[Optional[str], List[int]] = {}
        self.payments: Dict[str, int] = {}
        self.tip_cash = 0
        self.tip_card = 0
        self.tip_cash_refunds = 0
        self.tip_card_refunds = 0
        self.tip_direct = 0
        self.documents = 0
        self.units = 0
        self.types: Dict[str, List[int]] = {}
        self.employees: Optional[Dict[str, Dict[str, Any]]] = None
        self.brands: Dict[str, List[int]] = {}
        self.drawer: Optional[Dict[str, Any]] = None
        self.terminals: Optional[List[Dict[str, Any]]] = None

    # ── one document ──

    def add_document(self, doc: Dict[str, Any], show_employees: bool) -> None:
        if not is_counted(doc):
            return
        if doc.get("voucherMemo") and not _ag(doc.get("total")) and not _ag(doc.get("tip")):
            return
        credit = is_credit(doc)
        sign = -1 if credit else 1
        total = _ag(doc.get("total"))
        discount = _ag(doc.get("discount"))
        collected = total if credit else total - discount
        if credit:
            self.refunds += collected
        else:
            deduction = _ag(doc.get("deduction"))
            self.gross += total - deduction
            self.discounts += discount - deduction
            self.documents += 1
            self.units += _milli(doc.get("units"))

        vat = agorot(doc.get("vat"))
        if vat is None:
            self.vat_known = False
        else:
            self.vat += sign * vat
        self.vat_total += sign * collected
        rate = rate_key(doc.get("vatRate"))
        bucket = self.rates.setdefault(rate, [0, 0])
        bucket[0] += sign * collected
        bucket[1] += sign * (vat or 0)

        payments = [p for p in (doc.get("payments") or []) if isinstance(p, dict)]
        legs: List[Tuple[str, int, Any]] = (
            [(canonical_method(p.get("method")), _ag(p.get("amount")), p.get("brand")) for p in payments]
            if payments
            else [(canonical_method(doc.get("paymentMethod")), collected, None)]
        )
        for method, amount, _brand in legs:
            self.payments[method] = self.payments.get(method, 0) + sign * amount

        tip = _ag(doc.get("tip"))
        tip_cash = _tip_is_cash(doc.get("tipMethod"), doc.get("paymentMethod"))
        if tip:
            if credit:
                if tip_cash:
                    self.tip_cash_refunds += tip
                else:
                    self.tip_card_refunds += tip
            elif tip_cash:
                self.tip_cash += tip
            else:
                self.tip_card += tip

        kind = canonical_type(doc.get("orderType"))
        t = self.types.setdefault(kind, [0, 0])
        if not credit:
            t[0] += 1
        t[1] += sign * collected

        card_legs = [(amount, brand) for method, amount, brand in legs if method == "card"]
        for amount, brand in card_legs:
            b = self.brands.setdefault(canonical_brand(brand), [0, 0, 0])
            b[0] += 1
            b[1] += sign * amount
        if tip and not tip_cash:
            last = canonical_brand(card_legs[-1][1]) if card_legs else OTHER_BRAND
            self.brands.setdefault(last, [0, 0, 0])[2] += sign * tip

        if show_employees:
            if self.employees is None:
                self.employees = {}
            ident = doc.get("employeeId")
            ident = str(ident).strip() if ident not in (None, "") else None
            name = doc.get("employeeName")
            name = str(name).strip() if name not in (None, "") else None
            key = ident or name or ""
            e = self.employees.setdefault(
                key, {"id": ident, "name": name, "cash": 0, "card": 0, "other": 0, "cashTip": 0, "cardTip": 0}
            )
            if e["name"] is None and name:
                e["name"] = name
            for method, amount, _brand in legs:
                bucket_key = "cash" if method == "cash" else "card" if method == "card" else "other"
                e[bucket_key] += sign * amount
            if tip:
                e["cashTip" if tip_cash else "cardTip"] += sign * tip

    # ── merging finished sections ──

    def add_sections(self, s: Dict[str, Any]) -> None:
        sales = s.get("sales") or {}
        self.gross += _ag(sales.get("gross"))
        self.discounts += _ag(sales.get("discounts"))
        self.refunds += _ag(sales.get("refunds"))
        vat = s.get("vat") or {}
        if not vat.get("known", True):
            self.vat_known = False
        self.vat += _ag(vat.get("vat"))
        self.vat_total += _ag(vat.get("total"))
        for r in vat.get("rates") or []:
            bucket = self.rates.setdefault(r.get("rate"), [0, 0])
            bucket[0] += _ag(r.get("total"))
            bucket[1] += _ag(r.get("vat"))
        for row in (s.get("payments") or {}).get("rows") or []:
            m = row.get("method") or "other"
            self.payments[m] = self.payments.get(m, 0) + _ag(row.get("amount"))
        tips = s.get("tips") or {}
        self.tip_cash += _ag(tips.get("cash"))
        self.tip_card += _ag(tips.get("card"))
        self.tip_cash_refunds += _ag(tips.get("cashRefunds"))
        self.tip_card_refunds += _ag(tips.get("cardRefunds"))
        self.tip_direct += _ag(tips.get("direct"))
        sold = s.get("sold") or {}
        self.documents += int(sold.get("documents") or 0)
        self.units += _milli(sold.get("units"))
        for row in (s.get("orderTypes") or {}).get("rows") or []:
            t = self.types.setdefault(row.get("type") or DEFAULT_ORDER_TYPE, [0, 0])
            t[0] += int(row.get("count") or 0)
            t[1] += _ag(row.get("total"))
        if isinstance(s.get("employees"), list):
            if self.employees is None:
                self.employees = {}
            for row in s["employees"]:
                key = row.get("id") or row.get("name") or ""
                e = self.employees.setdefault(
                    key,
                    {"id": row.get("id"), "name": row.get("name"), "cash": 0, "card": 0, "other": 0, "cashTip": 0, "cardTip": 0},
                )
                if e["name"] is None and row.get("name"):
                    e["name"] = row.get("name")
                for k in ("cash", "card", "other", "cashTip", "cardTip"):
                    e[k] += _ag(row.get(k))
        for row in (s.get("cardBrands") or {}).get("rows") or []:
            b = self.brands.setdefault(row.get("brand") or OTHER_BRAND, [0, 0, 0])
            b[0] += int(row.get("count") or 0)
            b[1] += _ag(row.get("sale"))
            b[2] += _ag(row.get("tip"))
        d = s.get("drawer")
        if isinstance(d, dict):
            self._merge_drawer(d)
        t = s.get("transmission")
        if isinstance(t, dict):
            if self.terminals is None:
                self.terminals = []
            for term in t.get("terminals") or []:
                self.terminals.append({
                    "terminal": term.get("terminal"),
                    "legs": int(term.get("legs") or 0),
                    "transmittedLegs": int(term.get("transmittedLegs") or 0),
                    "transmitted": _ag(term.get("transmitted")),
                    "batches": [dict(b) for b in term.get("batches") or [] if isinstance(b, dict)],
                })

    def _merge_drawer(self, d: Dict[str, Any]) -> None:
        def opt(v: Any) -> Optional[int]:
            return agorot(v)

        part = {
            "opening": _ag(d.get("opening")),
            "expected": _ag(d.get("expected")),
            "counted": opt(d.get("counted")),
            "overShort": opt(d.get("gap")),
            "tipsPaidFromDrawer": opt(d.get("tipsPaidFromDrawer")),
            "betweenShifts": _ag(d.get("betweenShifts")),
            "cashIn": opt(d.get("cashIn")),
            "expenses": opt(d.get("expenses")),
            "safeDrop": opt(d.get("safeDrop")),
            "countRequired": bool(d.get("countRequired")),
        }
        if self.drawer is None:
            self.drawer = part
            return
        acc = self.drawer
        for k in ("opening", "expected", "betweenShifts"):
            acc[k] += part[k]
        # Counted and over/short: every drawer's, or none (as the Z's own drawer sums).
        for k in ("counted", "overShort"):
            acc[k] = None if acc[k] is None or part[k] is None else acc[k] + part[k]
        # The optional lines: the sum of those that have one; none when none does.
        for k in ("tipsPaidFromDrawer", "cashIn", "expenses", "safeDrop"):
            if part[k] is not None:
                acc[k] = (acc[k] or 0) + part[k]
        acc["countRequired"] = acc["countRequired"] or part["countRequired"]

    def set_drawer(self, drawer: Optional[Dict[str, Any]], count_required: bool) -> None:
        if not isinstance(drawer, dict):
            self.drawer = None
            return
        self.drawer = {
            "opening": _ag(drawer.get("opening")),
            "expected": _ag(drawer.get("expected")),
            "counted": agorot(drawer.get("counted")),
            "overShort": agorot(drawer.get("overShort")),
            "tipsPaidFromDrawer": agorot(drawer.get("tipsPaidFromDrawer")),
            "betweenShifts": _ag(drawer.get("betweenShifts")),
            "cashIn": agorot(drawer.get("cashIn")),
            "expenses": agorot(drawer.get("expenses")),
            "safeDrop": agorot(drawer.get("safeDrop")),
            "countRequired": bool(count_required),
        }

    def set_transmission(self, transmission: Optional[Dict[str, Any]]) -> None:
        if not isinstance(transmission, dict):
            self.terminals = None
            return
        self.terminals = []
        for term in transmission.get("terminals") or []:
            if not isinstance(term, dict):
                continue
            self.terminals.append({
                "terminal": mask_terminal(term.get("terminal")),
                "legs": int(term.get("legs") or 0),
                "transmittedLegs": int(term.get("transmittedLegs") or 0),
                "transmitted": _ag(term.get("transmitted")),
                "batches": [
                    {
                        "at": b.get("at"),
                        "batch": None if b.get("batch") in (None, "") else str(b.get("batch")),
                        "count": None if b.get("count") is None else int(b.get("count")),
                        "amount": money(agorot(b.get("amount"))),
                    }
                    for b in term.get("batches") or []
                    if isinstance(b, dict)
                ],
            })

    # ── the sections ──

    def finish(self) -> Dict[str, Any]:
        net = self.gross - self.discounts - self.refunds
        pay_keys = _order(set(self.payments) | {"cash", "card"}, PAYMENT_ORDER, (NO_MONEY,))
        pay_rows = [
            {"method": m, "amount": money(self.payments.get(m, 0))}
            for m in pay_keys
            if m in ("cash", "card") or self.payments.get(m, 0) != 0
        ]
        pay_total = sum(self.payments.values())
        cash_tips = self.tip_cash - self.tip_cash_refunds
        card_tips = self.tip_card - self.tip_card_refunds
        tip_refunds = self.tip_cash_refunds + self.tip_card_refunds
        tips_net = self.tip_cash + self.tip_card - tip_refunds
        paid_out = self.drawer.get("tipsPaidFromDrawer") if self.drawer is not None else None
        receipts = []
        for row in pay_rows:
            m = row["method"]
            tip = cash_tips if m == "cash" else card_tips if m == "card" else 0
            sale = self.payments.get(m, 0)
            receipts.append({"method": m, "sales": money(sale), "tips": money(tip), "total": money(sale + tip)})

        rate_rows = []
        if self.vat_known:
            for key in sorted(self.rates, key=lambda r: (r is None, -(Decimal(r) if r is not None else 0))):
                total, vat = self.rates[key]
                if total == 0 and vat == 0:
                    continue
                rate_rows.append({"rate": key, "total": money(total), "vat": money(vat), "base": money(total - vat)})

        types = []
        for kind in _order(self.types, ORDER_TYPES):
            count, total = self.types[kind]
            if count == 0 and total == 0:
                continue
            types.append({"type": kind, "count": count, "total": money(total), "average": money(average(total, count))})
        type_count = sum(r["count"] for r in types)
        type_total = sum(self.types[k][1] for k in self.types)

        employees = None
        if self.employees is not None:
            rows = []
            for e in self.employees.values():
                sales = e["cash"] + e["card"] + e["other"]
                tips = e["cashTip"] + e["cardTip"]
                if not any((e["cash"], e["card"], e["other"], e["cashTip"], e["cardTip"])) and not e["name"] and not e["id"]:
                    continue
                rows.append({
                    "id": e["id"], "name": e["name"],
                    "cash": money(e["cash"]), "card": money(e["card"]), "other": money(e["other"]),
                    "cashTip": money(e["cashTip"]), "cardTip": money(e["cardTip"]),
                    "sales": money(sales), "tips": money(tips), "total": money(sales + tips),
                    "_total": sales + tips,
                })
            rows.sort(key=lambda r: (-r["_total"], r["name"] is None, r["name"] or "", r["id"] or ""))
            for r in rows:
                r.pop("_total")
            employees = rows

        brand_rows = []
        for brand in _order(self.brands, BRANDS, (OTHER_BRAND,)):
            count, sale, tip = self.brands[brand]
            if count == 0 and sale == 0 and tip == 0:
                continue
            brand_rows.append({"brand": brand, "count": count, "sale": money(sale), "tip": money(tip), "amount": money(sale + tip)})
        b_count = sum(self.brands[b][0] for b in self.brands)
        b_sale = sum(self.brands[b][1] for b in self.brands)
        b_tip = sum(self.brands[b][2] for b in self.brands)

        drawer = None
        if self.drawer is not None:
            d = self.drawer
            show = bool(d["countRequired"]) or d["counted"] is not None
            drawer = {
                "opening": money(d["opening"]),
                "cashReceipts": money(self.payments.get("cash", 0) + cash_tips),
                "tipsPaidFromDrawer": money(d["tipsPaidFromDrawer"]),
                "betweenShifts": money(d["betweenShifts"]),
                "cashIn": money(d["cashIn"]),
                "expenses": money(d["expenses"]),
                "safeDrop": money(d["safeDrop"]),
                "expected": money(d["expected"]),
                "countRequired": bool(d["countRequired"]),
                "showCount": show,
                "counted": money(d["counted"]) if show else None,
                "gap": money(d["overShort"]) if show else None,
            }

        transmission = None
        card_total = self.payments.get("card", 0) + card_tips
        if self.terminals is not None and sum(t["legs"] for t in self.terminals) > 0:
            terminals = []
            for t in self.terminals:
                terminals.append({
                    "terminal": t["terminal"],
                    "status": _status(t["legs"], t["transmittedLegs"]),
                    "legs": t["legs"],
                    "transmittedLegs": t["transmittedLegs"],
                    "transmitted": money(t["transmitted"]),
                    "batches": t["batches"],
                })
            legs = sum(t["legs"] for t in self.terminals)
            sent_legs = sum(t["transmittedLegs"] for t in self.terminals)
            sent = sum(t["transmitted"] for t in self.terminals)
            status = _status(legs, sent_legs)
            transmission = {
                "status": status,
                "legs": legs,
                "transmittedLegs": sent_legs,
                "transmitted": money(sent),
                "cardTotal": money(card_total),
                "matched": status == SENT and sent == card_total,
                "terminals": terminals,
            }

        return {
            "version": VERSION,
            "sales": {"gross": money(self.gross), "discounts": money(self.discounts), "refunds": money(self.refunds), "total": money(net)},
            "vat": {
                "known": self.vat_known,
                "base": money(self.vat_total - self.vat) if self.vat_known else None,
                "vat": money(self.vat) if self.vat_known else None,
                "total": money(self.vat_total),
                "rates": rate_rows,
            },
            "payments": {"rows": pay_rows, "total": money(pay_total)},
            "tips": {
                "cash": money(self.tip_cash),
                "card": money(self.tip_card),
                "refunds": money(tip_refunds),
                "cashRefunds": money(self.tip_cash_refunds),
                "cardRefunds": money(self.tip_card_refunds),
                "net": money(tips_net),
                "paidFromDrawer": money(paid_out),
                "direct": money(self.tip_direct),
                "toDistribute": money(tips_net - (paid_out or 0) - self.tip_direct),
            },
            "receipts": {"rows": receipts, "total": money(pay_total + tips_net)},
            "drawer": drawer,
            "sold": {"documents": self.documents, "units": units_text(self.units), "average": money(average(net, self.documents))},
            "orderTypes": {"rows": types, "count": type_count, "total": money(type_total), "average": money(average(type_total, type_count))},
            "employees": employees,
            "cardBrands": {"rows": brand_rows, "count": b_count, "sale": money(b_sale), "tip": money(b_tip), "amount": money(b_sale + b_tip)},
            "transmission": transmission,
        }


def _status(legs: int, transmitted: int) -> str:
    if legs > 0 and transmitted >= legs:
        return SENT
    if transmitted > 0:
        return PARTIAL
    return NOT_SENT


# ── The two entry points ──────────────────────────────────────────────────────


def compute(
    documents: Iterable[Dict[str, Any]],
    *,
    drawer: Optional[Dict[str, Any]] = None,
    transmission: Optional[Dict[str, Any]] = None,
    show_employees: bool = False,
    count_required: bool = False,
) -> Dict[str, Any]:
    """The sections over `documents` (facts, the module docstring), with the drawer and card
    transmission they are printed with. `drawer`: the Z's (or the X's) own figures —
    `{opening, expected, counted, overShort, tipsPaidFromDrawer, betweenShifts, cashIn, expenses,
    safeDrop}`; `transmission`: `{terminals: [{terminal, legs, transmittedLegs, transmitted,
    batches: [{at, batch, count, amount}]}]}` — the terminal number is masked here."""
    acc = _Acc()
    if show_employees:
        acc.employees = {}
    for doc in documents:
        if isinstance(doc, dict):
            acc.add_document(doc, show_employees)
    acc.set_drawer(drawer, count_required)
    acc.set_transmission(transmission)
    return acc.finish()


def merge(parts: Iterable[Optional[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
    """Several tills' sections as one (a shop Z of their parts); None when no part has any."""
    acc = _Acc()
    found = False
    for part in parts:
        if isinstance(part, dict) and part.get("version") == VERSION:
            acc.add_sections(part)
            found = True
    return acc.finish() if found else None


# ── The paper ─────────────────────────────────────────────────────────────────

LABELS_HE: Dict[str, Any] = {
    "sales": "מכירות (כולל מע״מ, ללא טיפ)",
    "salesGross": "לפני הנחות והחזרים",
    "salesDiscounts": "הנחות",
    "salesRefunds": "החזרים",
    "salesTotal": "סה״כ מכירות",
    "vat": "סיכום מע״מ",
    "vatBase": "סה״כ לפני מע״מ",
    "vatRow": "מע״מ",
    "vatRateRow": "מע״מ {rate}%",
    "vatRateBase": "בסיס {rate}%",
    "vatTotal": "סה״כ כולל מע״מ",
    "vatUnknown": "לא ידוע",
    "vatExempt": "עוסק פטור — ללא מע״מ",
    "payments": "תשלומים עבור מכירות",
    "paymentsTotal": "סה״כ תשלומים",
    "tips": "טיפים שנגבו בקופה",
    "tipCash": "טיפ מזומן",
    "tipCard": "טיפ אשראי",
    "tipRefunds": "החזרי טיפ",
    "tipNet": "סה״כ טיפים נטו",
    "tipPaidFromDrawer": "שולם לעובדים מהמגירה",
    "tipToDistribute": "יתרה לחלוקה",
    "tipDirect": "טיפ ישיר",
    "receipts": "תקבולים ממכירות וטיפים",
    "receiptsTotal": "סה״כ תקבולים",
    "drawer": "התאמת מגירת מזומן",
    "drawerOpening": "קופה פותחת",
    "drawerCashReceipts": "תקבולי מזומן כולל טיפ",
    "drawerTipsPaid": "טיפים ששולמו מהמגירה",
    "drawerBetweenShifts": "תנועות בין משמרות",
    "drawerCashIn": "הכנסות מזומן",
    "drawerExpenses": "הוצאות",
    "drawerSafeDrop": "הפקדה לכספת",
    "drawerExpected": "מזומן צפוי",
    "drawerCounted": "מזומן שנספר",
    "drawerGap": "פער",
    "drawerNotCounted": "לא נספר",
    "drawerGapWithheld": "לא חושב",
    "transmission": "שידור אשראי",
    "transmissionStatus": "סטטוס",
    "transmissionSent": "שודר ✓",
    "transmissionPartial": "שודר חלקית",
    "transmissionNotSent": "לא שודר",
    "transmissionTerminal": "מסוף",
    "transmissionBatch": "אצווה {batch}",
    "transmissionBatchFigures": "  עסקאות · סכום",
    "transmissionPending": "ממתינות לשידור",
    "transmissionCardTotal": "אשראי בקופה",
    "transmissionTransmitted": "שודר",
    "transmissionMatch": "התאמה",
    "transmissionMatched": "תואם ✓",
    "transmissionNotMatched": "לא תואם",
    "sold": "כמה נמכר",
    "soldDocuments": "מסמכי מכירה",
    "soldUnits": "יחידות שנמכרו",
    "soldAverage": "ממוצע למכירה",
    "orderTypes": "לפי סוג הזמנה",
    "orderTypeAverage": "  ממוצע",
    "orderTypesTotal": "סה״כ ({count})",
    "cardBrands": "אשראי לפי מותג",
    "brandSplit": "  מכירה / טיפ",
    "brandsTotal": "סה״כ אשראי ({count})",
    "employees": "לפי עובד",
    "employeeNone": "ללא שיוך",
    "employeeCard": "  מכירות אשראי",
    "employeeCash": "  מכירות מזומן",
    "employeeOther": "  אמצעי תשלום אחרים",
    "employeeCardTip": "  טיפ אשראי",
    "employeeCashTip": "  טיפ מזומן",
    "employeeSales": "  סה״כ מכירות",
    "employeeTips": "  סה״כ טיפים",
    "methods": {
        "cash": "מזומן", "card": "אשראי", "voucher": "שוברים", "exchange": "קיזוז החלפה",
        "no_money": "זיכוי ללא החזר", "check": "המחאה", "other": "אחר",
    },
    "types": {
        "tables": "שולחנות", "quick": "הזמנה מהירה", "kiosk": "קיוסק", "takeaway": "טייק אוויי",
        "delivery": "משלוחים",
    },
    "brands": {
        "visa": "ויזה", "mastercard": "מאסטרקארד", "isracard": "ישראכרט", "amex": "אמריקן אקספרס",
        "diners": "דיינרס", "jcb": "JCB", "discover": "דיסקבר", "maestro": "מאסטרו", "other": "אחר",
    },
}

#: The longest name an employee row prints: 58 mm paper leaves room for a value beside it.
NAME_MAX = 20


def _neg(value: Optional[str]) -> Optional[str]:
    """A figure that comes off (discounts, refunds, paid out): shown negative unless zero."""
    a = agorot(value)
    if a is None:
        return None
    return money(-abs(a))


def _clip(text: str, limit: int = NAME_MAX) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


Line = Tuple[str, str, bool]
Block = Tuple[str, List[Line]]


def lines(
    s: Optional[Dict[str, Any]],
    *,
    exempt: bool = False,
    fmt: Callable[[Optional[str]], str] = lambda v: v or "—",
    stamp: Callable[[Optional[str]], str] = lambda v: v or "—",
    labels: Optional[Dict[str, Any]] = None,
) -> List[Block]:
    """
    The sections as the paper lists them: (title, [(label, value, bold)]) per block, in the
    owner's order. A block with no data is left out. `fmt` formats money (a decimal string),
    `stamp` a transmission's ISO time; `exempt`: an exempt dealer ("סוג עוסק").
    """
    if not isinstance(s, dict):
        return []
    L = labels or LABELS_HE

    def signed(value: Optional[str]) -> str:
        a = agorot(value)
        if a is None:
            return fmt(None)
        return ("+" if a > 0 else "") + fmt(value)

    def method_label(m: str) -> str:
        return L["methods"].get(m, m)

    out: List[Block] = []
    sales = s.get("sales") or {}
    out.append((L["sales"], [
        (L["salesGross"], fmt(sales.get("gross")), False),
        (L["salesDiscounts"], fmt(_neg(sales.get("discounts"))), False),
        (L["salesRefunds"], fmt(_neg(sales.get("refunds"))), False),
        (L["salesTotal"], fmt(sales.get("total")), True),
    ]))

    vat = s.get("vat") or {}
    vat_rows: List[Line] = []
    if exempt and not _ag(vat.get("vat")):
        vat_rows.append((L["vatRow"], L["vatExempt"], False))
    elif not vat.get("known", True):
        vat_rows.append((L["vatRow"], L["vatUnknown"], False))
    else:
        rates = vat.get("rates") or []
        vat_rows.append((L["vatBase"], fmt(vat.get("base")), False))
        if len(rates) >= 2:
            for r in rates:
                rate = r.get("rate")
                if rate is None:
                    vat_rows.append((L["vatRow"], fmt(r.get("vat")), False))
                    continue
                vat_rows.append((L["vatRateBase"].format(rate=rate), fmt(r.get("base")), False))
                vat_rows.append((L["vatRateRow"].format(rate=rate), fmt(r.get("vat")), False))
            vat_rows.append((L["vatRow"], fmt(vat.get("vat")), False))
        elif len(rates) == 1 and rates[0].get("rate") is not None:
            vat_rows.append((L["vatRateRow"].format(rate=rates[0]["rate"]), fmt(vat.get("vat")), False))
        else:
            vat_rows.append((L["vatRow"], fmt(vat.get("vat")), False))
        vat_rows.append((L["vatTotal"], fmt(vat.get("total")), True))
    out.append((L["vat"], vat_rows))

    payments = s.get("payments") or {}
    out.append((L["payments"], [
        *[(method_label(r.get("method")), fmt(r.get("amount")), False) for r in payments.get("rows") or []],
        (L["paymentsTotal"], fmt(payments.get("total")), True),
    ]))

    tips = s.get("tips") or {}
    has_tips = any(_ag(tips.get(k)) for k in ("cash", "card", "refunds", "direct")) or tips.get("paidFromDrawer") is not None
    if has_tips:
        rows: List[Line] = [
            (L["tipCash"], fmt(tips.get("cash")), False),
            (L["tipCard"], fmt(tips.get("card")), False),
        ]
        if _ag(tips.get("refunds")):
            rows.append((L["tipRefunds"], fmt(_neg(tips.get("refunds"))), False))
        rows.append((L["tipNet"], fmt(tips.get("net")), True))
        if tips.get("paidFromDrawer") is not None:
            rows.append((L["tipPaidFromDrawer"], fmt(_neg(tips.get("paidFromDrawer"))), False))
        rows.append((L["tipToDistribute"], fmt(tips.get("toDistribute")), True))
        if _ag(tips.get("direct")):
            rows.append((L["tipDirect"], fmt(tips.get("direct")), False))
        out.append((L["tips"], rows))

    receipts = s.get("receipts") or {}
    out.append((L["receipts"], [
        *[(method_label(r.get("method")), fmt(r.get("total")), False) for r in receipts.get("rows") or []],
        (L["receiptsTotal"], fmt(receipts.get("total")), True),
    ]))

    d = s.get("drawer")
    if isinstance(d, dict):
        rows = [
            (L["drawerOpening"], fmt(d.get("opening")), False),
            (L["drawerCashReceipts"], fmt(d.get("cashReceipts")), False),
        ]
        if d.get("tipsPaidFromDrawer") is not None:
            rows.append((L["drawerTipsPaid"], fmt(_neg(d.get("tipsPaidFromDrawer"))), False))
        if _ag(d.get("betweenShifts")):
            rows.append((L["drawerBetweenShifts"], signed(d.get("betweenShifts")), False))
        if _ag(d.get("cashIn")):
            rows.append((L["drawerCashIn"], fmt(d.get("cashIn")), False))
        if _ag(d.get("expenses")):
            rows.append((L["drawerExpenses"], fmt(_neg(d.get("expenses"))), False))
        if _ag(d.get("safeDrop")):
            rows.append((L["drawerSafeDrop"], fmt(_neg(d.get("safeDrop"))), False))
        rows.append((L["drawerExpected"], fmt(d.get("expected")), True))
        if d.get("showCount"):
            counted = d.get("counted")
            rows.append((L["drawerCounted"], fmt(counted) if counted is not None else L["drawerNotCounted"], False))
            gap = d.get("gap")
            rows.append((L["drawerGap"], signed(gap) if gap is not None else L["drawerGapWithheld"], True))
        out.append((L["drawer"], rows))

    t = s.get("transmission")
    if isinstance(t, dict):
        status_word = {SENT: L["transmissionSent"], PARTIAL: L["transmissionPartial"]}.get(t.get("status"), L["transmissionNotSent"])
        rows = [(L["transmissionStatus"], status_word, True)]
        for term in t.get("terminals") or []:
            rows.append((L["transmissionTerminal"], term.get("terminal") or "—", False))
            for b in term.get("batches") or []:
                rows.append((L["transmissionBatch"].format(batch=b.get("batch") or "—").strip(), stamp(b.get("at")), False))
                count = b.get("count")
                rows.append((L["transmissionBatchFigures"], f"{'—' if count is None else count} · {fmt(b.get('amount'))}", False))
            pending = int(term.get("legs") or 0) - int(term.get("transmittedLegs") or 0)
            if pending > 0:
                rows.append((L["transmissionPending"], str(pending), False))
        rows.append((L["transmissionCardTotal"], fmt(t.get("cardTotal")), False))
        rows.append((L["transmissionTransmitted"], fmt(t.get("transmitted")), False))
        rows.append((L["transmissionMatch"], L["transmissionMatched"] if t.get("matched") else L["transmissionNotMatched"], True))
        out.append((L["transmission"], rows))

    sold = s.get("sold") or {}
    if int(sold.get("documents") or 0) > 0:
        out.append((L["sold"], [
            (L["soldDocuments"], str(int(sold.get("documents") or 0)), False),
            (L["soldUnits"], str(sold.get("units") or "0"), False),
            (L["soldAverage"], fmt(sold.get("average")), True),
        ]))

    types = s.get("orderTypes") or {}
    if types.get("rows"):
        rows = []
        for r in types["rows"]:
            rows.append((f"{L['types'].get(r.get('type'), r.get('type'))} ({int(r.get('count') or 0)})", fmt(r.get("total")), False))
            rows.append((L["orderTypeAverage"], fmt(r.get("average")), False))
        rows.append((L["orderTypesTotal"].format(count=int(types.get("count") or 0)), fmt(types.get("total")), True))
        rows.append((L["soldAverage"], fmt(types.get("average")), False))
        out.append((L["orderTypes"], rows))

    brands = s.get("cardBrands") or {}
    if brands.get("rows"):
        rows = []
        for r in brands["rows"]:
            rows.append((f"{L['brands'].get(r.get('brand'), r.get('brand'))} ({int(r.get('count') or 0)})", fmt(r.get("amount")), False))
            rows.append((L["brandSplit"], f"{fmt(r.get('sale'))} / {fmt(r.get('tip'))}", False))
        rows.append((L["brandsTotal"].format(count=int(brands.get("count") or 0)), fmt(brands.get("amount")), True))
        rows.append((L["brandSplit"], f"{fmt(brands.get('sale'))} / {fmt(brands.get('tip'))}", False))
        out.append((L["cardBrands"], rows))

    employees = s.get("employees")
    if isinstance(employees, list) and employees:
        rows = []
        for e in employees:
            rows.append((_clip(e.get("name") or L["employeeNone"]), fmt(e.get("total")), True))
            rows.append((L["employeeCard"], fmt(e.get("card")), False))
            rows.append((L["employeeCash"], fmt(e.get("cash")), False))
            if _ag(e.get("other")):
                rows.append((L["employeeOther"], fmt(e.get("other")), False))
            if _ag(e.get("cardTip")):
                rows.append((L["employeeCardTip"], fmt(e.get("cardTip")), False))
            if _ag(e.get("cashTip")):
                rows.append((L["employeeCashTip"], fmt(e.get("cashTip")), False))
            rows.append((L["employeeSales"], fmt(e.get("sales")), False))
            rows.append((L["employeeTips"], fmt(e.get("tips")), False))
        out.append((L["employees"], rows))
    return out


# ── The database side: the facts of a Z's documents ───────────────────────────


def _flag(value: Any) -> bool:
    """A boolean till parameter as resolved (JSON true, or the words a till also reads)."""
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in ("true", "1", "yes", "on", "כן")


def machine_options(db, machine) -> Dict[str, bool]:
    """
    The two parameters the sections read, as this till has them now: `zShowPerEmployee` and
    whether counting is part of its close (`cashDrawer.blindCount`). Never raises: a till
    whose parameters cannot be read gets neither.
    """
    try:
        from app.services.till_parameters import till_parameters_for_machine

        params = till_parameters_for_machine(db, machine).parameters
    except Exception:  # noqa: BLE001 - presentation never blocks a Z
        logger.exception("z sections: parameters of machine %s unreadable", getattr(machine, "id", None))
        return {"showEmployees": False, "countRequired": False}
    return {
        "showEmployees": _flag(params.get(SHOW_PER_EMPLOYEE_KEY)),
        "countRequired": _flag(params.get(BLIND_COUNT_KEY)),
    }


def _str(value: Any) -> Optional[str]:
    return None if value is None else str(value)


def _money_text(value: Any) -> Optional[str]:
    return money(agorot(value))


def documents_of(db, shift_ids: Sequence[uuid.UUID]) -> List[Any]:
    """The documents of these shifts a Z counts from — the shifts' own tills' (`compute_totals`)."""
    from app.models.shift import Shift
    from app.models.transaction import Transaction

    ids = list(shift_ids)
    if not ids:
        return []
    return [
        d
        for d in (
            db.query(Transaction)
            .join(Shift, Shift.id == Transaction.shift_id)
            .filter(Transaction.shift_id.in_(ids), Transaction.machine_id == Shift.machine_id)
            .all()
        )
        if not getattr(d, "duplicate_copy", False)
    ]


def document_facts(db, documents: Sequence[Any], shop_id: Any) -> List[Dict[str, Any]]:
    """
    The facts of `documents` (Transaction rows), as `compute` reads them: their legs in
    order (a no-money credit's legs in their own bucket, as `shift_totals`), the units of
    a sale, its production vouchers' deduction, its order type and whose it is.
    """
    from sqlalchemy import func

    from app.models.kiosk import KioskOrder
    from app.models.transaction import Transaction
    from app.models.transaction_item import TransactionItem
    from app.models.transaction_payment import TransactionPayment
    from app.services.dashboard_stats import SALE_STATUSES
    from app.services.shift_totals import production_deductions_of
    from app.services.tenders import is_refund_document
    from app.services.z_table import kiosk_machine_ids
    from app.services.z_waiters import _names, _orders_by_tx, _uuid_text

    counted = [d for d in documents if d.status in SALE_STATUSES]
    if not counted:
        return []
    ids = [d.id for d in counted]
    legs: Dict[Any, List[Any]] = {}
    for leg in db.query(TransactionPayment).filter(TransactionPayment.transaction_id.in_(ids)).all():
        legs.setdefault(leg.transaction_id, []).append(leg)
    for rows in legs.values():
        rows.sort(key=lambda leg: (leg.sequence or 0))

    def credit(d) -> bool:
        return is_refund_document(document_type=d.document_type, refund_of_transaction_id=d.refund_of_transaction_id)

    sale_ids = [d.id for d in counted if not credit(d)]
    units: Dict[Any, Any] = {}
    if sale_ids:
        units = {
            tid: q
            for tid, q in db.query(TransactionItem.transaction_id, func.coalesce(func.sum(TransactionItem.quantity), 0))
            .filter(TransactionItem.transaction_id.in_(sale_ids))
            .group_by(TransactionItem.transaction_id)
        }
    deductions = production_deductions_of(db, sale_ids)

    # A no-money credit against a sale of another shift moved no money: its own bucket.
    no_money_originals = {
        d.refund_of_transaction_id for d in counted
        if d.refund_of_transaction_id is not None
        and any(getattr(leg, "no_money_movement", False) for leg in legs.get(d.id, ()))
    }
    original_shift: Dict[Any, Any] = {}
    if no_money_originals:
        original_shift = {
            row[0]: row[1]
            for row in db.query(Transaction.id, Transaction.shift_id).filter(Transaction.id.in_(list(no_money_originals)))
        }

    orders = _orders_by_tx(db, shop_id, counted)
    kiosks = kiosk_machine_ids(db, {d.machine_id for d in counted})
    from_kiosk = {
        str(row[0])
        for row in db.query(KioskOrder.transaction_id).filter(KioskOrder.transaction_id.in_([str(i) for i in ids]))
        if row[0]
    }
    names = _names(db, [d.cashier_id for d in counted if d.cashier_id])

    out: List[Dict[str, Any]] = []
    for d in counted:
        refund = credit(d)
        order = orders.get(str(d.id))
        if order is None and refund:
            order = orders.get(_uuid_text(d.refund_of_transaction_id) or "")
        if order is not None:
            kind = "tables"
            employee_id = order.waiter_pos_user_id or order.opened_by_pos_user_id
            employee_name = order.waiter_pos_user_name or order.opened_by_pos_user_name or (
                names.get(_uuid_text(employee_id) or "") if employee_id else None
            )
        else:
            kind = "kiosk" if (d.machine_id in kiosks or str(d.id) in from_kiosk) else DEFAULT_ORDER_TYPE
            raw = (d.cashier_id or "").strip() or None
            employee_id = raw
            employee_name = (names.get(_uuid_text(raw) or "") or raw) if raw else None
        payments = []
        for leg in legs.get(d.id, ()):
            method = leg.method
            if (
                refund
                and getattr(leg, "no_money_movement", False)
                and (
                    d.refund_of_transaction_id not in original_shift
                    or original_shift[d.refund_of_transaction_id] != d.shift_id
                )
            ):
                method = NO_MONEY
            payments.append({"method": method, "amount": _money_text(leg.amount), "brand": getattr(leg, "card_brand", None)})
        out.append({
            "id": str(d.id),
            "type": d.document_type,
            "status": _str(getattr(d.status, "value", d.status)),
            "refundOf": _str(d.refund_of_transaction_id),
            "total": _money_text(d.total_amount),
            "discount": _money_text(d.document_discount),
            "deduction": None if refund else _money_text(deductions.get(d.id)),
            "vat": _money_text(d.vat_amount),
            "vatRate": None if d.vat_rate is None else str(d.vat_rate),
            "tip": _money_text(d.tip_amount),
            "tipMethod": d.tip_payment_method,
            "paymentMethod": d.payment_method,
            "payments": payments,
            "units": None if refund else str(units.get(d.id, 0)),
            "orderType": kind,
            "employeeId": None if employee_id is None else str(employee_id),
            "employeeName": employee_name,
            "voucherMemo": bool(getattr(d, "voucher_memo", False)),
            "_machine": d.machine_id,
        })
    return out


def transmission_facts(db, machine, shifts: Sequence[Any], block: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    One terminal's transmission over a till's shifts, from the section's frozen `transmission`
    block (`transmissions.period_block`): the card legs it tracks, how many a batch claimed and
    what they charged (tip included, as the batch holds it), and the batches that carried them.
    """
    if not isinstance(block, dict):
        return None
    from app.models.transaction import Transaction
    from app.models.transaction_payment import TransactionPayment
    from app.services.transmissions import CARD_METHOD, TRANSMITTABLE_STATUSES, _charged_by_leg

    from app.services.tenders import is_refund_document

    shift_ids = [s.id for s in shifts]
    transmitted = [
        (row[0], is_refund_document(document_type=row[1], refund_of_transaction_id=row[2]))
        for row in db.query(TransactionPayment.id, Transaction.document_type, Transaction.refund_of_transaction_id)
        .join(Transaction, Transaction.id == TransactionPayment.transaction_id)
        .filter(
            Transaction.shift_id.in_(shift_ids),
            Transaction.machine_id == machine.id,
            TransactionPayment.method == CARD_METHOD,
            TransactionPayment.terminal_uid.isnot(None),
            TransactionPayment.transmission_id.isnot(None),
            Transaction.status.in_(TRANSMITTABLE_STATUSES),
        )
    ] if shift_ids else []
    # A credit's leg takes its money back out of the batch: signed, as the till's card total is.
    by_leg = _charged_by_leg(db, [leg_id for leg_id, _credit in transmitted]) if transmitted else {}
    charged = sum((-by_leg.get(leg_id, Decimal(0)) if credit else by_leg.get(leg_id, Decimal(0)) for leg_id, credit in transmitted), Decimal(0))
    sent = int(block.get("transmittedLegs") or 0)
    pending = int(block.get("untransmittedLegs") or 0)
    batches = [
        {"at": b.get("startedAt"), "batch": b.get("batchNumber"), "count": b.get("transactionCount"), "amount": b.get("amount")}
        for b in sorted(
            (b for b in block.get("batches") or [] if isinstance(b, dict)),
            key=lambda b: str(b.get("startedAt") or ""),
        )
        if int(b.get("legsInPeriod") or 0) > 0 and (b.get("status") or "") == "success"
    ]
    return {
        "terminal": getattr(machine, "terminal_number", None),
        "legs": sent + pending,
        "transmittedLegs": sent,
        "transmitted": money(agorot(charged)),
        "batches": batches,
    }


def _drawer_of(cash: Dict[str, Any]) -> Dict[str, Any]:
    """The Z's own drawer figures (`z_builder.till_cash_summary` / `z_cash_summary`)."""
    # "Z — מזומן צפוי כולל הפקדות ותנועות מזומן" (app/services/z_expected_cash.py): with the
    # parameter on, the Z's expected cash moves with Cash In / Out and the safe deposits, as the
    # X's does — and prints them, so every line of its drawer adds up to its expected. Off (the
    # default), a Z prints none of them and its expected does not move with them: as ever.
    cash_in, cash_out, deposits = cash.get("cash_movements") or (None, None, None)
    return {
        "opening": _money_text(cash.get("opening")),
        "expected": _money_text(cash.get("expected")),
        "counted": _money_text(cash.get("counted")),
        "overShort": _money_text(cash.get("over_short")),
        "tipsPaidFromDrawer": _money_text(cash.get("card_tips_from_drawer")),
        "betweenShifts": _money_text(cash.get("between_shifts")),
        "cashIn": _money_text(cash_in),
        "expenses": _money_text(cash_out),
        "safeDrop": _money_text(deposits),
    }


def sections_for_z(
    db,
    *,
    shop_id: Any,
    per_machine: Sequence[Tuple[Any, Sequence[Any]]],
    sections: Sequence[Dict[str, Any]],
    with_movements: Optional[Sequence[bool]] = None,
) -> Tuple[Optional[Dict[str, Any]], List[Optional[Dict[str, Any]]]]:
    """
    A Z's sections — the whole Z's and each till's — from its documents, its drawer and its
    tills' transmission blocks (frozen with each section). Built once, at build time, and
    frozen with the Z like its other breakdowns. Never raises: a failure here leaves the Z
    without them (it prints as before), never without a Z.

    `with_movements`: per till, as the Z froze it ("Z — מזומן צפוי כולל הפקדות ותנועות מזומן") —
    the drawer is the same `z_builder` summary the Z's sections were built with; none: off.
    """
    try:
        from app.services.z_builder import till_cash_summary, z_cash_summary

        all_shifts = [s for _m, shifts in per_machine for s in shifts]
        facts = document_facts(db, documents_of(db, [s.id for s in all_shifts]), shop_id)
        by_shift_machine: Dict[Any, List[Dict[str, Any]]] = {}
        for f in facts:
            by_shift_machine.setdefault(f.pop("_machine"), []).append(f)
        options = {m.id: machine_options(db, m) for m, _s in per_machine}
        flags = [bool(f) for f in with_movements] if with_movements is not None else [False] * len(per_machine)
        per: List[Optional[Dict[str, Any]]] = []
        terminals: List[Dict[str, Any]] = []
        for (machine, shifts), section, flag in zip(per_machine, sections, flags):
            mine = by_shift_machine.get(machine.id, []) if shifts else []
            term = transmission_facts(db, machine, shifts, (section or {}).get("transmission"))
            if term is not None:
                terminals.append(term)
            opts = options.get(machine.id) or {}
            per.append(compute(
                mine,
                drawer=_drawer_of(till_cash_summary(shifts, flag)),
                transmission={"terminals": [term]} if term is not None else None,
                show_employees=bool(opts.get("showEmployees")),
                count_required=bool(opts.get("countRequired")),
            ))
        whole = compute(
            facts,
            drawer=_drawer_of(z_cash_summary([shifts for _m, shifts in per_machine], flags)),
            transmission={"terminals": terminals} if terminals else None,
            show_employees=any(o.get("showEmployees") for o in options.values()),
            count_required=any(o.get("countRequired") for o in options.values()),
        )
        return whole, per
    except Exception:  # noqa: BLE001 - presentation never blocks a Z
        logger.exception("z sections: not built for shop %s", shop_id)
        return None, [None for _ in per_machine]


def sections_of_z(db, z) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """
    A Z's sections for the dashboard: as frozen at build ("stored"); for a Z stored as printed
    (a local shop Z) its tills' printed sections merged ("stored"); for a Z built before them,
    read now from its documents ("documents"); none for a till-issued legacy Z.
    """
    header = getattr(z, "header", None) or {}
    stored = header.get("reportSections")
    if isinstance(stored, dict):
        return stored, "stored"
    parts = [s.get("reportSections") for s in (getattr(z, "per_machine", None) or []) if isinstance(s, dict)]
    if parts and all(isinstance(p, dict) for p in parts):
        return merge(parts), "stored"
    if getattr(z, "per_machine", None) is None or header.get("asPrinted"):
        return None, None
    try:
        from app.models.pos_machine import POSMachine
        from app.models.shift import Shift

        shifts = db.query(Shift).filter(Shift.z_report_id == z.id).all()
        if not shifts:
            return None, None
        machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.id.in_({s.machine_id for s in shifts}))}
        grouped: Dict[Any, List[Any]] = {}
        for s in sorted(shifts, key=lambda s: (s.sequence_number or 0, str(s.opened_at))):
            grouped.setdefault(s.machine_id, []).append(s)
        per_machine = [(machines[mid], ss) for mid, ss in grouped.items() if mid in machines]
        frozen = {str(s.get("machineId")): s for s in (z.per_machine or []) if isinstance(s, dict)}
        sections = [frozen.get(str(m.id), {}) for m, _ss in per_machine]
        # The drawer as the Z froze it ("Z — מזומן צפוי כולל הפקדות ותנועות מזומן"): a till's section that
        # carries the movements block had the parameter on — never the parameter as it stands now.
        from app.services import z_expected_cash as ZEC

        flags = [isinstance(s.get(ZEC.BLOCK), dict) for s in sections]
        whole, _per = sections_for_z(
            db, shop_id=z.shop_id, per_machine=per_machine, sections=sections, with_movements=flags,
        )
        return whole, ("documents" if whole is not None else None)
    except Exception:  # noqa: BLE001
        logger.exception("z sections: not read for z %s", getattr(z, "id", None))
        return None, None
