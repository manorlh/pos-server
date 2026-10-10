"""
The demo company, checked: counts and money per bar straight from the documents, the fiscal
invariants, the product's own reconciliation, the month's reports (the product's report
services) against the documents, and the uniform file (מבנה אחיד) produced by the product's
exporter and checked record by record.

Read-only on the database. Writes the report (verification.json / verification.md) and the
uniform-file output under `out_dir`.
"""
from __future__ import annotations

import io
import json
import uuid
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from . import plan as P

IL = ZoneInfo(P.TIMEZONE)
D0 = Decimal("0")
CENT = Decimal("0.01")
SALE_STATUSES = ("completed", "refunded", "partial_refund")


def d(v) -> Decimal:
    return D0 if v is None else Decimal(str(v))


def money(v) -> str:
    return f"{d(v).quantize(CENT):,.2f}"


class Checks:
    def __init__(self):
        self.rows: List[dict] = []

    def add(self, section: str, name: str, ok: bool, detail: Any = "") -> bool:
        self.rows.append({"section": section, "check": name, "ok": bool(ok), "detail": detail})
        return bool(ok)

    def eq(self, section: str, name: str, expected, actual, tol=Decimal("0.005")) -> bool:
        if isinstance(expected, (int, float, Decimal)) and isinstance(actual, (int, float, Decimal)):
            ok = abs(d(expected) - d(actual)) <= tol
        else:
            ok = expected == actual
        return self.add(section, name, ok, {"expected": _js(expected), "actual": _js(actual)})

    @property
    def failed(self) -> List[dict]:
        return [r for r in self.rows if not r["ok"]]


def _js(v):
    if isinstance(v, Decimal):
        return float(v)
    return v


# ── The documents, read straight from the tables ──────────────────────────────

class Books:
    """The tenant's documents with their legs, lines, shifts and Zs (one read)."""

    def __init__(self, db, tenant_id):
        from app.models.pos_machine import POSMachine
        from app.models.shift import Shift
        from app.models.shop_area import ShopArea
        from app.models.transaction import Transaction
        from app.models.transaction_item import TransactionItem
        from app.models.transaction_payment import TransactionPayment
        from app.models.z_report import ZReport

        self.machines = {m.id: m for m in db.query(POSMachine).filter(POSMachine.tenant_id == tenant_id)}
        self.areas = {a.id: a for a in db.query(ShopArea).filter(ShopArea.tenant_id == tenant_id)}
        self.bar_of_area = {a.id: int(a.name.split()[-1]) for a in self.areas.values() if a.name.startswith("בר ")}
        self.shifts = {s.id: s for s in db.query(Shift).filter(Shift.tenant_id == tenant_id)}
        self.zs = {z.id: z for z in db.query(ZReport).filter(ZReport.tenant_id == tenant_id)}
        self.docs = {t.id: t for t in db.query(Transaction).filter(Transaction.tenant_id == tenant_id)}
        ids = list(self.docs)
        self.legs: Dict[Any, list] = defaultdict(list)
        self.items: Dict[Any, list] = defaultdict(list)
        for i in range(0, len(ids), 5000):
            chunk = ids[i:i + 5000]
            for leg in db.query(TransactionPayment).filter(TransactionPayment.transaction_id.in_(chunk)):
                self.legs[leg.transaction_id].append(leg)
            for it in db.query(TransactionItem).filter(TransactionItem.transaction_id.in_(chunk)):
                self.items[it.transaction_id].append(it)

    @staticmethod
    def status(t) -> str:
        return getattr(t.status, "value", t.status)

    def is_credit(self, t) -> bool:
        return t.document_type in (330, -400) or t.refund_of_transaction_id is not None

    def counted(self, t) -> bool:
        return self.status(t) in SALE_STATUSES and not t.duplicate_copy

    def bar_of(self, t) -> Optional[int]:
        s = self.shifts.get(t.shift_id)
        return self.bar_of_area.get(s.area_id) if s is not None else None

    def figures(self, docs) -> Dict[str, Any]:
        """The money of these documents, in the product's definitions (app/services/tenders.py)."""
        from app.services.tenders import normalize_tender

        f = defaultdict(lambda: D0)
        n = Counter()
        for t in docs:
            st = self.status(t)
            if st == "cancelled":
                n["cancelled"] += 1
                continue
            if not self.counted(t):
                n[f"status_{st}"] += 1
                continue
            credit = self.is_credit(t)
            sign = -1 if credit else 1
            if credit:
                n["credit_notes"] += 1
                f["refunds"] += d(t.total_amount)
                f["vat"] -= d(t.vat_amount)
            else:
                n["sales"] += 1
                f["gross"] += d(t.total_amount)
                f["discounts"] += d(t.document_discount)
                f["vat"] += d(t.vat_amount)
            for leg in self.legs.get(t.id, []):
                f[normalize_tender(leg.method)] += sign * d(leg.amount)
            tip = d(t.tip_amount)
            if tip:
                f["tips"] += tip
                f["tips_" + ("cash" if (t.tip_payment_method or "") == "cash" else "card")] += tip
                n["tipped"] += 1
        f["net"] = f["gross"] - f["discounts"] - f["refunds"]
        f["collected"] = f["gross"] - f["discounts"]
        out = {k: v for k, v in f.items()}
        out.update({k: v for k, v in n.items()})
        out["documents"] = n["sales"] + n["credit_notes"]
        return out


# ── 1. Counts and totals per bar ──────────────────────────────────────────────

def per_bar(books: Books, z_mode: str = "area") -> Dict[str, Any]:
    from app.services.document_prefix import document_series_of

    by_bar: Dict[Any, list] = defaultdict(list)
    for t in books.docs.values():
        by_bar[books.bar_of(t)].append(t)
    out = {}
    for bar in sorted(by_bar, key=lambda b: (b is None, b)):
        docs = by_bar[bar]
        f = books.figures(docs)
        types = Counter(f"{t.document_type}/{Books.status(t)}" for t in docs)
        shifts = [s for s in books.shifts.values() if books.bar_of_area.get(s.area_id) == bar]
        if z_mode == "shop":
            # A shop Z has no area: the bar's Zs are the shop Zs that hold its shifts.
            z_ids = {s.z_report_id for s in shifts if s.z_report_id is not None}
            zs = [z for z in books.zs.values() if z.id in z_ids]
        else:
            zs = [z for z in books.zs.values() if books.bar_of_area.get(z.area_id) == bar]
        out[str(bar)] = {
            "bar": f"בר {bar}" if bar else "—",
            "documentsByTypeStatus": dict(sorted(types.items())),
            "sales320": f.get("sales", 0), "creditNotes330": f.get("credit_notes", 0),
            "cancelled320": f.get("cancelled", 0), "shifts": len(shifts), "zReports": len(zs),
            "gross": f["gross"], "discounts": f["discounts"], "refunds": f["refunds"], "net": f["net"],
            "cash": f.get("cash", D0), "card": f.get("card", D0), "other": f.get("other", D0),
            "tips": f.get("tips", D0), "tipsCash": f.get("tips_cash", D0), "tipsCard": f.get("tips_card", D0),
            "vat": f["vat"],
        }
    _ = document_series_of
    return out


# ── 2. Fiscal invariants ──────────────────────────────────────────────────────

def invariants(books: Books, checks: Checks, expected_nights: Dict[int, List[str]], z_mode: str = "area") -> None:
    from app.services.document_prefix import document_series_of

    S = "invariants"
    # (a) Per till and series: 1..N, no gap, no duplicate (every status — a cancelled
    #     attempt keeps the number it burned).
    series: Dict[Tuple[Any, int], List[int]] = defaultdict(list)
    for t in books.docs.values():
        series[(t.machine_id, document_series_of(t.document_type))].append(int(t.transaction_number))
    bad = []
    for (mid, s), nums in sorted(series.items(), key=lambda kv: (str(kv[0][0]), kv[0][1])):
        nums.sort()
        if nums != list(range(1, len(nums) + 1)):
            dup = [n for n, c in Counter(nums).items() if c > 1]
            gaps = sorted(set(range(1, max(nums) + 1)) - set(nums))
            bad.append({"till": books.machines[mid].name, "series": s, "dups": dup[:10], "gaps": gaps[:10]})
    checks.add(S, "document numbers per till and type: 1..N, no gaps, no duplicates", not bad,
               bad or {"series": len(series), "documents": len(books.docs)})
    # (b) Unique in the business: (series, prefix + number) — what the uniform file reads.
    keys = Counter((document_series_of(t.document_type), t.document_prefix, t.transaction_number)
                   for t in books.docs.values())
    dups = [k for k, c in keys.items() if c > 1]
    prefixes = {m.name: m.effective_document_prefix for m in books.machines.values()}
    stamped = {(t.machine_id, t.document_prefix) for t in books.docs.values()}
    checks.add(S, "every document carries its till's prefix", all(p == books.machines[m].effective_document_prefix for m, p in stamped), sorted({str(p) for _m, p in stamped}))
    checks.add(S, "document numbers unique in the business (prefix per till)",
               not dups and len(set(prefixes.values())) == len(prefixes), {"duplicates": dups[:5], "prefixes": prefixes})

    # (c) Every document in exactly one shift of its own till, every shift closed and in one Z.
    homeless = [str(t.id) for t in books.docs.values()
                if t.shift_id is None or t.shift_id not in books.shifts
                or books.shifts[t.shift_id].machine_id != t.machine_id]
    checks.add(S, "every document filed in a shift of its own till", not homeless, homeless[:5] or len(books.docs))
    open_or_unz = [str(s.id) for s in books.shifts.values()
                   if getattr(s.status, "value", s.status) != "closed" or s.z_report_id is None
                   or s.z_report_id not in books.zs]
    checks.add(S, "every shift closed and in exactly one Z", not open_or_unz,
               open_or_unz[:5] or {"shifts": len(books.shifts)})
    if z_mode == "area":
        wrong_area = [str(s.id) for s in books.shifts.values()
                      if s.z_report_id in books.zs and books.zs[s.z_report_id].area_id != s.area_id]
        checks.add(S, "each shift's Z is its own bar's (area) Z", not wrong_area, wrong_area[:5] or "all")
    else:
        # Shop Z ("Z סניפי"): not an area's, not a till's — the branch's, and in its own night.
        not_shop = [z.shop_sequence_number for z in books.zs.values()
                    if z.area_id is not None or z.machine_id is not None or z.origin != "cloud"
                    or ((z.header or {}).get("scope") or {}).get("kind") != "shop"]
        checks.add(S, "every Z is a shop Z (no area, no till; header scope 'shop')", not not_shop,
                   not_shop[:10] or {"zs": len(books.zs)})
        wrong_night = [str(s.id) for s in books.shifts.values()
                       if s.z_report_id in books.zs and books.zs[s.z_report_id].business_date != s.business_date]
        checks.add(S, "each shift is in the shop Z of its own business night", not wrong_night,
                   wrong_night[:5] or {"shifts": len(books.shifts)})

    # (d) Z numbering: the shop's one gapless sequence; area mode — per bar strictly increasing, one
    #     Z per bar per business night, exactly the nights it opened; shop mode — one Z per business
    #     night, exactly the nights any bar opened, holding every shift of that night.
    zs = sorted(books.zs.values(), key=lambda z: z.shop_sequence_number or 0)
    numbers = [z.shop_sequence_number for z in zs]
    checks.add(S, "shop Z numbers 1..K, no gaps or repeats", numbers == list(range(1, len(numbers) + 1)),
               {"count": len(numbers), "first": numbers[:3], "last": numbers[-3:]})
    if z_mode == "shop":
        dates = [z.business_date.isoformat() for z in zs]
        nights = sorted({n for ns in expected_nights.values() for n in ns})
        checks.add(S, "shop Z numbers strictly increase with the business night", dates == sorted(dates),
                   {"first": dates[:2], "last": dates[-2:]})
        checks.add(S, "exactly one shop Z for every night the branch traded (any bar opened)",
                   dates == nights, {"zs": len(dates), "nights": len(nights),
                                     "missing": sorted(set(nights) - set(dates))[:5],
                                     "extra": sorted(set(dates) - set(nights))[:5]})
        by_night: Dict[Any, list] = defaultdict(list)
        for s in books.shifts.values():
            by_night[s.business_date.isoformat()].append(s)
        bars_of_night = {n: {b for b, ns in expected_nights.items() if n in ns} for n in nights}
        off = []
        for z in zs:
            tonight = by_night.get(z.business_date.isoformat(), [])
            held = [s for s in tonight if s.z_report_id == z.id]
            want_tills = {m.id for m in books.machines.values()
                          if books.bar_of_area.get(m.area_id) in bars_of_night.get(z.business_date.isoformat(), set())}
            if len(held) != len(tonight) or {s.machine_id for s in held} != want_tills:
                off.append({"z": z.shop_sequence_number, "night": z.business_date.isoformat(),
                            "shiftsThatNight": len(tonight), "inThisZ": len(held),
                            "tillsInZ": len({s.machine_id for s in held}), "tillsThatTraded": len(want_tills)})
        checks.add(S, "every shop Z holds all the shifts of its night and every till that traded",
                   not off, off[:6] or {"zs": len(zs), "shifts": len(books.shifts)})
    else:
        per_area: Dict[Any, list] = defaultdict(list)
        for z in zs:
            per_area[books.bar_of_area.get(z.area_id)].append(z)
        ok_order, nights_ok, detail = True, True, {}
        for bar, rows in sorted(per_area.items(), key=lambda kv: (kv[0] is None, kv[0])):
            nums = [z.shop_sequence_number for z in rows]
            dates = [z.business_date.isoformat() for z in rows]
            ok_order &= nums == sorted(nums) and len(set(nums)) == len(nums) and dates == sorted(dates)
            nights_ok &= bar is not None and sorted(dates) == sorted(expected_nights.get(bar, [])) \
                and len(set(dates)) == len(dates)
            detail[f"בר {bar}"] = {"zs": len(rows), "numbers": f"{nums[0]}…{nums[-1]}" if nums else "-"}
        checks.add(S, "per bar: Z numbers strictly increasing with the night", ok_order, detail)
        checks.add(S, "per bar: exactly one Z for every night it opened", nights_ok,
                   {k: len(v) for k, v in expected_nights.items()})

    # (e) Z totals = the sum of their documents.
    by_z: Dict[Any, list] = defaultdict(list)
    for t in books.docs.values():
        s = books.shifts.get(t.shift_id)
        if s is not None and s.z_report_id is not None:
            by_z[s.z_report_id].append(t)
    mism = []
    for z in zs:
        f = books.figures(by_z.get(z.id, []))
        pairs = {
            "transactions_count": (f["documents"], z.transactions_count),
            "total_sales": (f["collected"], z.total_sales),
            "discounts_total": (f["discounts"], z.discounts_total),
            "total_refunds": (f["refunds"], z.total_refunds),
            "total_cash_sales": (f.get("cash", D0), z.total_cash_sales),
            "total_card_sales": (f.get("card", D0), z.total_card_sales),
            "total_tips": (f.get("tips", D0), z.total_tips),
            "total_cash_tips": (f.get("tips_cash", D0), z.total_cash_tips),
            "total_card_tips": (f.get("tips_card", D0), z.total_card_tips),
            "vat_total": (f["vat"], z.vat_total),
            "shift_count": (len({t.shift_id for t in by_z.get(z.id, [])} | {s.id for s in books.shifts.values()
                                                                           if s.z_report_id == z.id}), z.shift_count),
        }
        for k, (exp, act) in pairs.items():
            if abs(d(exp) - d(act)) > Decimal("0.005"):
                mism.append({"z": z.shop_sequence_number, "field": k, "documents": _js(d(exp)), "z_value": _js(d(act))})
    checks.add(S, "every Z's totals = the sum of its documents (count, sales, discounts, refunds, cash, card, "
                  "tips cash/card, VAT, shifts)", not mism, mism[:10] or {"zs": len(zs)})

    # (f) Credit notes never exceed their source.
    over = []
    credited_by_source: Dict[Any, Decimal] = defaultdict(lambda: D0)
    qty_by_line: Dict[Any, Decimal] = defaultdict(lambda: D0)
    for t in books.docs.values():
        if not (books.counted(t) and books.is_credit(t)):
            continue
        src = books.docs.get(t.refund_of_transaction_id)
        if src is None:
            over.append({"credit": t.transaction_number, "problem": "no source"})
            continue
        credited_by_source[src.id] += d(t.total_amount)
        src_lines = {it.id: it for it in books.items.get(src.id, [])}
        for it in books.items.get(t.id, []):
            if it.refund_of_item_id not in src_lines:
                over.append({"credit": t.transaction_number, "problem": "line not in source"})
            qty_by_line[it.refund_of_item_id] += d(it.quantity)
    for sid, total in credited_by_source.items():
        src = books.docs[sid]
        collected = d(src.total_amount) - d(src.document_discount)
        if total > collected + CENT:
            over.append({"source": src.transaction_number, "credited": float(total), "collected": float(collected)})
        expected_status = "refunded" if total >= collected - CENT else "partial_refund"
        if Books.status(src) != expected_status:
            over.append({"source": src.transaction_number, "status": Books.status(src), "expected": expected_status})
    all_items = {it.id: it for items in books.items.values() for it in items}
    for line_id, q in qty_by_line.items():
        if line_id in all_items and q > d(all_items[line_id].quantity):
            over.append({"line": str(line_id), "credited_qty": float(q), "sold_qty": float(all_items[line_id].quantity)})
    checks.add(S, "credit notes never exceed their source (money, per line quantity) and mark it refunded/partial",
               not over, over[:10] or {"creditNotes": sum(1 for t in books.docs.values() if books.is_credit(t)),
                                       "sources": len(credited_by_source)})


# ── 3. The product's reconciliation ("התאמות") ────────────────────────────────

def reconciliation(db, user, tenant_id, shop_id, window, checks: Checks) -> Dict[str, Any]:
    from app.services.reconciliation import build_reconciliation

    out = build_reconciliation(db, user, tenant_id, window, shop_ids=[shop_id])
    bad = [r for r in out["rows"] if r.get("status") not in ("match",)]
    checks.add("reconciliation", "the product's reconciliation: every row 'match' (all checks)", not bad,
               [{k: r.get(k) for k in ("check", "status", "subject", "reason", "expected", "actual", "count")}
                for r in bad[:12]] or out["summary"])
    return {"summary": out["summary"], "totals": out.get("totals"), "notMatching": len(bad)}


# ── 4. The month's reports against the documents ─────────────────────────────

def reports(db, user, tenant, shop, books: Books, checks: Checks, window) -> Dict[str, Any]:
    from app.services import all_in_one, extra_reports, z_table
    from app.services import reports as R
    from app.services import tips as TIPS
    from app.services.tenders import normalize_tender

    S = "reports"
    tid = tenant.id
    in_window = [t for t in books.docs.values() if window.start <= t.created_at < window.end]
    raw = books.figures(in_window)
    out: Dict[str, Any] = {"window": [window.start.isoformat(), window.end.isoformat()]}

    # Sales per employee ("דוח קופאים").
    cashiers = R.build_cashier_sales_report(db, user, tid, window, shop_id=shop.id)
    tot = cashiers.totals
    for k, exp in (("gross", raw["gross"]), ("discounts", raw["discounts"]), ("refunds", raw["refunds"]),
                   ("net", raw["net"]), ("cash_net", raw.get("cash", D0)), ("card_net", raw.get("card", D0))):
        checks.eq(S, f"cashier report totals.{k}", exp, tot.__getattribute__(k))
    checks.eq(S, "cashier report totals.documentCount", raw["documents"], tot.document_count)
    by_cashier: Dict[str, list] = defaultdict(list)
    for t in in_window:
        by_cashier[t.cashier_id].append(t)
    worst = []
    for row in cashiers.rows:
        f = books.figures(by_cashier.get(row.cashier_id, []))
        for k, exp in (("net", f["net"]), ("gross", f["gross"]), ("refunds", f["refunds"])):
            if abs(d(getattr(row, k)) - exp) > Decimal("0.005"):
                worst.append({"cashier": row.cashier_name, "field": k, "report": getattr(row, k), "documents": float(exp)})
    checks.add(S, "cashier report: every employee's gross / refunds / net = their documents", not worst,
               worst[:8] or {"employees": len(cashiers.rows)})
    out["perEmployee"] = [{"name": r.cashier_name, "worker": r.worker_number, "documents": r.document_count,
                           "net": r.net, "cash": r.cash_net, "card": r.card_net,
                           "tips": getattr(r, "tips", None)} for r in cashiers.rows]

    # Sales by point of sale (area).
    by_area = R.build_sales_by_area_report(db, user, tid, window, shop=shop)
    worst = []
    for row in by_area.rows:
        bar = books.bar_of_area.get(row.area_id)
        f = books.figures([t for t in in_window if books.bar_of(t) == bar])
        for k, exp in (("gross", f["gross"]), ("discounts", f["discounts"]), ("refunds", f["refunds"]),
                       ("net", f["net"]), ("cash", f.get("cash", D0)), ("card", f.get("card", D0)),
                       ("transactions_count", f["documents"])):
            if abs(d(getattr(row, k)) - d(exp)) > Decimal("0.005"):
                worst.append({"area": row.area_name, "field": k, "report": getattr(row, k), "documents": _js(exp)})
    checks.add(S, "sales by area: every bar's row = its documents (stamped area)", not worst,
               worst[:8] or {"areas": len(by_area.rows)})
    checks.eq(S, "sales by area: totals.net = the shop's net", raw["net"], by_area.totals.net)
    out["byArea"] = [{"area": r.area_name, "documents": r.transactions_count, "gross": r.gross, "net": r.net,
                      "cash": r.cash, "card": r.card} for r in by_area.rows]

    # Payment methods ("אמצעי תשלום").
    pm = extra_reports.build_payment_methods_report(db, user, tid, window, shop_id=shop.id)
    pm_rows = pm.model_dump(by_alias=True).get("rows", [])
    buckets = defaultdict(lambda: D0)
    for r in pm_rows:
        buckets[r.get("bucket") or normalize_tender(r.get("method"))] += d(r.get("amount"))
    for k in ("cash", "card"):
        checks.eq(S, f"payment methods report: {k} (signed legs)", raw.get(k, D0), buckets.get(k, D0))
    out["paymentMethods"] = {k: float(v) for k, v in buckets.items()}

    # Tips: the range report and the shop's tips report with its distribution.
    tips = R.build_tips_range_report(db, user, tid, window, shop_id=shop.id)
    checks.eq(S, "tips report: cash tips", raw.get("tips_cash", D0), tips.tips_cash)
    checks.eq(S, "tips report: card tips", raw.get("tips_card", D0), tips.tips_card)
    checks.eq(S, "tips report: other", D0, tips.tips_other)
    shop_tips = TIPS.build_tips_report(db, shop, from_date=window.from_date, to_date=window.to_date)
    utc_docs = [t for t in books.docs.values()
                if datetime.combine(window.from_date, datetime.min.time(), tzinfo=timezone.utc) <= t.created_at
                <= datetime.combine(window.to_date, datetime.max.time(), tzinfo=timezone.utc)]
    f_utc = books.figures(utc_docs)
    checks.eq(S, f"shop tips report ({shop_tips.distribution}): total", f_utc.get("tips", D0), shop_tips.total_tips)
    checks.eq(S, "shop tips report: card", f_utc.get("tips_card", D0), shop_tips.total_card_tips)
    checks.eq(S, "shop tips report: owed = collected", shop_tips.total_tips,
              sum(d(c.amount_owed) for c in shop_tips.cashiers), tol=Decimal("0.05"))
    out["tips"] = {"cash": tips.tips_cash, "card": tips.tips_card, "distribution": shop_tips.distribution,
                   "employees": len(shop_tips.cashiers)}

    # VAT (all-in-one, per rate).
    q = all_in_one.documents_query(db, user, tid, window, shop_ids=[shop.id])
    vat = all_in_one.by_vat_rate(q)
    vat_rows = vat.get("rows", vat) if isinstance(vat, dict) else vat
    total_vat = sum(d(r.get("vat")) for r in (vat_rows if isinstance(vat_rows, list) else []))
    total_gross = sum(d(r.get("gross")) for r in (vat_rows if isinstance(vat_rows, list) else []))
    checks.eq(S, "VAT by rate: VAT = Σ sales VAT − Σ credit-note VAT", raw["vat"], total_vat)
    checks.eq(S, "VAT by rate: gross incl. VAT = net collected", raw["net"], total_gross)
    out["vat"] = vat

    # Z list ("דוחות Z") and the day summary.
    zq = z_table.filtered_z_query(db, user, tid, from_date=P.MONTH_FIRST, to_date=P.MONTH_LAST,
                                  date_basis="business", tzinfo=IL, shop_ids=[shop.id])
    zs = zq.all() if hasattr(zq, "all") else list(zq)
    table = z_table.build_z_table(db, zs, IL)
    checks.eq(S, "Z list: every Z of the month listed", len(books.zs), len(table["zs"]))
    z_by_id = {str(r.get("id")): r for r in table["zs"]}
    listed_bad = [n for n, z in ((z.shop_sequence_number, z) for z in books.zs.values())
                  if str(z.id) not in z_by_id or abs(d(z_by_id[str(z.id)].get("totalSales")) - d(z.total_sales)) > CENT]
    checks.add(S, "Z list: each Z's sales as filed", not listed_bad, listed_bad[:10] or len(z_by_id))
    out["zList"] = {"rows": len(table["zs"])}
    day = R.build_day_summary_report(db, user, tid, window, shop_ids=[shop.id])
    dd = day.model_dump(by_alias=True)
    out["daySummary"] = {k: dd.get(k) for k in ("totals",) if k in dd}

    # Products.
    prod = R.build_product_sales_report(db, user, tid, window, shop_id=shop.id, limit=1000)
    sold = sum(d(it.total_price) for t in in_window if books.counted(t) and not books.is_credit(t)
               for it in books.items.get(t.id, []))
    back = sum(d(it.total_price) for t in in_window if books.counted(t) and books.is_credit(t)
               for it in books.items.get(t.id, []))
    checks.eq(S, "products report: gross = Σ sold lines", sold, prod.totals.gross)
    checks.eq(S, "products report: refunds = Σ credited lines", back, prod.totals.refunds)
    out["products"] = {"rows": len(prod.rows), "gross": prod.totals.gross, "net": prod.totals.net}
    out["raw"] = {k: _js(v) for k, v in raw.items()}
    return out


# ── 5. The uniform file ───────────────────────────────────────────────────────

LENGTHS = {"A100": 95, "B110": 376, "C100": 444, "D110": 339, "D120": 222, "M100": 298, "Z900": 110}


def _c100(line):
    return {"1203": line[22:25], "1204": line[25:45].strip(), "1205": line[45:53], "1219": int(line[287:302]),
            "1220": int(line[302:317]), "1221": int(line[317:332]), "1222": int(line[332:347]),
            "1223": int(line[347:362]), "1228": line[399], "1230": line[400:408], "1231": line[408:415].strip()}


def _d110(line):
    return {"1253": line[22:25], "1254": line[25:45].strip(), "1267": int(line[270:285])}


def _d120(line):
    return {"1312": int(line[103:118])}


def uniform_file(db, tenant, company, books: Books, checks: Checks, out_dir: Optional[Path],
                 registration_number: Optional[str] = None, window: Optional[Tuple[date, date]] = None,
                 dealer_type: str = "licensed") -> Dict[str, Any]:
    from app.services import tax_reports as TR
    from app.services.open_format.israeli_tax_id import israeli_9th_check_digit
    from app.services.open_format.tax_report_generator import duplicate_document_numbers

    S = "uniform file"
    exempt = dealer_type == "exempt"
    first, last = window or (P.MONTH_FIRST, P.MONTH_LAST)
    full_month = (first, last) == (P.MONTH_FIRST, P.MONTH_LAST)
    ctx = TR.resolve_export_context(db, company=company, shop=None, mode="date-range",
                                    from_date=first, to_date=last)
    result, tx_dicts, zip_bytes = TR.build_tax_open_format_export(db, tenant.id, ctx, company_id=company.id)
    ini, bk = list(result.ini_content), list(result.bkmv_content)
    info: Dict[str, Any] = {"recordCounts": dict(result.record_counts) if isinstance(result.record_counts, dict)
                            else getattr(result.record_counts, "__dict__", str(result.record_counts))}

    # Files: INI.TXT + BKMVDATA.TXT, the dashboard's zip, and the 1.31 §2.2 folder layout.
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        ini_bytes, bk_bytes = zf.read("INI.TXT"), zf.read("BKMVDATA.TXT")
    a000 = ini[0]
    vat8 = a000[24:33][:8]
    proc_date, proc_time = a000[382:390], a000[390:394]
    folder = f"OPENFRMT/{vat8}.{proc_date[2:4]}/{proc_date[4:8]}{proc_time}"
    if out_dir is not None:
        target = out_dir / ("uniform-2026-09" if full_month else f"uniform-{first.isoformat()}_to_{last.isoformat()}")
        target.mkdir(parents=True, exist_ok=True)
        (target / "INI.TXT").write_bytes(ini_bytes)
        (target / "BKMVDATA.TXT").write_bytes(bk_bytes)
        (target / f"OPENFRMT-{vat8}-{proc_date[4:8]}{proc_time}.zip").write_bytes(zip_bytes)
        inner = io.BytesIO()
        with zipfile.ZipFile(inner, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("BKMVDATA.TXT", bk_bytes)
        tree = target / folder
        tree.mkdir(parents=True, exist_ok=True)
        (tree / "INI.TXT").write_bytes(ini_bytes)
        (tree / "BKMVDATA.zip").write_bytes(inner.getvalue())
        info["folder"] = str(target)
    info["layout"] = folder
    if not full_month:
        info["period"] = f"{first.isoformat()} – {last.isoformat()}"

    # Structure: lengths, record numbers, A000 / Z900 totals, INI summary = records.
    checks.eq(S, "A000 length 466", 466, len(a000))
    wrong_len = [(i, l[:4], len(l)) for i, l in enumerate(bk) if l[:4] in LENGTHS and len(l) != LENGTHS[l[:4]]]
    checks.add(S, "every BKMVDATA record has its 1.31 length", not wrong_len, wrong_len[:5] or len(bk))
    recnums = [int(l[4:13]) for l in bk]
    checks.add(S, "record numbers run 1..N", recnums == list(range(1, len(bk) + 1)), {"records": len(bk)})
    counts = Counter(l[:4] for l in bk)
    z900 = [l for l in bk if l.startswith("Z900")]
    checks.eq(S, "A000 1002 total records = BKMVDATA lines", len(bk), int(a000[9:24]))
    checks.eq(S, "Z900 total records = BKMVDATA lines", len(bk), int(z900[0][46:61]) if z900 else -1)
    summary = {l[:4]: int(l[4:19]) for l in ini[1:] if len(l) >= 19}
    checks.add(S, "INI summary lines = the records written, per type",
               all(summary.get(k) == v for k, v in counts.items()) and set(summary) == set(counts),
               {"ini": summary, "bkmv": dict(counts)})
    if registration_number is not None:
        # A000 1006 is the platform setting `openFormat.registrationNumber` (written by the seeder's
        # --registration-number / DEMO_SOFTWARE_REGISTRATION_NUMBER): the file must carry exactly it —
        # in the generator's A000 and in INI.TXT as delivered (the one place 1.31 writes it).
        want = "".join(c for c in str(registration_number) if c.isdigit()).zfill(8)
        ini_a000 = ini_bytes.decode("iso-8859-8").split("\r\n")[0]
        checks.add(S, "A000 1006 software registration number = the configured one, not zeros",
                   a000[56:64] == want and ini_a000[56:64] == want and want.strip("0") != "",
                   {"expected": want, "generator": a000[56:64], "INI.TXT": ini_a000[56:64]})
        in_bkmv = bk_bytes.count(want.encode("ascii"))
        info["registrationNumberInBKMVDATA"] = in_bkmv
    vat9 = a000[24:33]
    checks.add(S, "ח.פ. in A000 has a valid check digit", israeli_9th_check_digit(vat9[:8]) == int(vat9[8]), vat9)
    checks.add(S, "every record carries the same ח.פ.",
               all(l[13:22] == vat9 for l in bk if l[:4] in ("A100", "B110", "C100", "D110", "D120", "M100", "Z900")),
               "")

    # Per document: Σ D110 1267 = 1219, 1219 + 1220 = 1221, 1221 + 1222 = 1223, Σ D120 = 1223, no D120 under 330.
    docs = []
    i = 0
    bad = []
    while i < len(bk):
        if bk[i].startswith("C100"):
            head = _c100(bk[i])
            j = i + 1
            body, pays = [], []
            while j < len(bk) and bk[j][:4] in ("D110", "D120"):
                (body if bk[j].startswith("D110") else pays).append(bk[j])
                j += 1
            rows = [_d110(x) for x in body]
            problems = []
            if head["1203"] == "400":
                if rows:  # an exempt dealer's receipt carries its header and payments only
                    problems.append("D110 under a receipt")
            elif sum(r["1267"] for r in rows) != head["1219"]:
                problems.append("Σ1267≠1219")
            if head["1219"] + head["1220"] != head["1221"]:
                problems.append("1219+1220≠1221")
            if head["1221"] + head["1222"] != head["1223"]:
                problems.append("1221+1222≠1223")
            if head["1203"] == "330" and pays:
                problems.append("D120 under 330")
            if head["1203"] != "330" and head["1228"] != "1" and sum(_d120(x)["1312"] for x in pays) != head["1223"]:
                problems.append("Σ1312≠1223")
            if any(r["1254"] != head["1204"] or r["1253"] != head["1203"] for r in rows):
                problems.append("D110 names another document")
            if problems:
                bad.append({"doc": head["1204"], "type": head["1203"], "problems": problems})
            docs.append((head, rows, pays))
            i = j
        else:
            i += 1
    checks.add(S, "every document adds up (lines, discount, VAT, payments)", not bad, bad[:8] or len(docs))
    keys = Counter((h["1203"], h["1204"]) for h, _r, _p in docs)
    dup = [k for k, c in keys.items() if c > 1]
    checks.add(S, "no document number twice for a type (whole file)", not dup and not duplicate_document_numbers(tx_dicts),
               dup[:5] or len(keys))
    dates = sorted({h["1205"] for h, _r, _p in docs})
    label = "1–30.9.2026" if full_month else f"{first.strftime('%d.%m')}–{last.strftime('%d.%m.%Y')}"
    checks.add(S, f"document dates inside {label}",
               bool(dates) and dates[0] >= first.strftime("%Y%m%d") and dates[-1] <= last.strftime("%Y%m%d"),
               {"first": dates[0] if dates else None, "last": dates[-1] if dates else None})

    # Against the database: which documents and how much.
    start = datetime.combine(first, datetime.min.time(), tzinfo=IL)
    end = datetime.combine(last + timedelta(days=1), datetime.min.time(), tzinfo=IL)
    db_docs = [t for t in books.docs.values() if start <= t.created_at < end and not t.duplicate_copy]
    tail = [t for t in books.docs.values() if t.created_at >= end]
    checks.eq(S, "C100 records = the documents dated 1–30.9 (every status)" if full_month
              else f"C100 records = the documents dated {label} (every status)", len(db_docs), len(docs))
    by_type = Counter(h["1203"] for h, _r, _p in docs)
    def filed_type(t) -> str:  # an exempt dealer's receipt and receipt refund are both filed as 400
        if t.document_type in (400, -400):
            return "400"
        return "330" if books.is_credit(t) else "320"

    db_types = Counter(filed_type(t) for t in db_docs)
    checks.add(S, "C100 per type = the database", dict(by_type) == dict(db_types),
               {"file": dict(by_type), "db": dict(db_types)})
    cancelled_file = sum(1 for h, _r, _p in docs if h["1228"] == "1")
    checks.eq(S, "cancelled documents flagged (1228 = 1)", sum(1 for t in db_docs if Books.status(t) == "cancelled"),
              cancelled_file)
    f = books.figures(db_docs)
    # A 400 with negative amounts is the exempt dealer's receipt refund (-400); positive, its sale.
    live = [h for h, _r, _p in docs if h["1228"] != "1"]
    sale_docs = [h for h in live if h["1203"] == "320" or (h["1203"] == "400" and h["1223"] >= 0)]
    credit_docs = [h for h in live if h["1203"] == "330" or (h["1203"] == "400" and h["1223"] < 0)]
    sales_1223 = sum(abs(h["1223"]) for h in sale_docs)
    credit_1223 = sum(abs(h["1223"]) for h in credit_docs)
    vat_file = sum(abs(h["1222"]) for h in sale_docs) - sum(abs(h["1222"]) for h in credit_docs)
    receipt_refunds = sum(abs(h["1223"]) for h in credit_docs if h["1203"] == "400")
    checks.eq(S, "Σ 1223 of sales = Σ collected (DB)", f["collected"], Decimal(sales_1223) / 100)
    checks.eq(S, "Σ 1223 of credit notes = Σ refunds (DB)", f["refunds"], Decimal(credit_1223) / 100)
    checks.eq(S, "Σ 1222 VAT (sales − credits) = DB VAT", f["vat"], Decimal(vat_file) / 100)
    d120_total = sum(_d120(x)["1312"] for h, _r, pays in docs if h["1228"] != "1" for x in pays)
    # A receipt refund (-400) carries negative payments; a credit note (330) carries none.
    checks.eq(S, "Σ D120 = Σ sales collected (payments, tips excluded)" if not exempt
              else "Σ D120 = Σ receipts − Σ receipt refunds (payments, tips excluded)",
              f["collected"] - Decimal(receipt_refunds) / 100, Decimal(d120_total) / 100)
    lines_db = sum(len(books.items.get(t.id, [])) for t in db_docs if t.document_type not in (400, -400))
    checks.eq(S, "D110 records = document lines (DB)", lines_db, counts.get("D110", 0))
    b110 = [l for l in bk if l.startswith("B110")]
    if b110:
        debit = sum(int(l[292:307]) for l in b110)
        credit = sum(int(l[307:322]) for l in b110)
        checks.eq(S, "B110 debit = Σ sales (1223)", sales_1223, debit, tol=Decimal(1))
        checks.eq(S, "B110 credit = Σ credit notes (1223)", credit_1223, credit, tol=Decimal(1))
    # The takings of exactly the documents the file holds (dated 1–30.9): the Z of the last night also
    # holds what was issued after midnight (dated 1.10), which this file does not.
    info["figures"] = {k: _js(f.get(k, D0)) for k in ("collected", "refunds", "vat", "cash", "card", "tips_cash",
                                                        "tips_card")}
    # The documents the file holds, by the type and status they are stored with (-400 = a receipt refund).
    info["byStoredTypeStatus"] = dict(sorted(Counter(f"{t.document_type}/{Books.status(t)}" for t in db_docs).items()))
    info.update({"documents": len(docs), "byType": dict(by_type), "cancelled": cancelled_file,
                 "salesTotal": sales_1223 / 100, "creditTotal": credit_1223 / 100, "vat": vat_file / 100,
                 "A000": {"1006": a000[56:64], "1007": a000[64:84].strip(), "1008": a000[84:104].strip(),
                          "1003": vat9, "1024": a000[366:374], "1025": a000[374:382], "1034": a000[419]},
                 "october1Tail": {"documents": len(tail), "collected": float(books.figures(tail)["collected"])}})
    return info


# ── Entry ─────────────────────────────────────────────────────────────────────

def _expected_nights(days: Optional[List[date]] = None) -> Dict[int, List[str]]:
    """The nights each bar traded — all of the month, or (a rehearsal) only the nights simulated."""
    return {bar.index: [n.isoformat() for n in P.nights(bar) if days is None or n in days] for bar in P.BARS}


def shop_z_rows(books: Books) -> List[Dict[str, Any]]:
    """The shop Zs as the product filed them (number, night, tills, shifts, takings), in number order."""
    rows = []
    for z in sorted(books.zs.values(), key=lambda z: z.shop_sequence_number or 0):
        shifts = [s for s in books.shifts.values() if s.z_report_id == z.id]
        rows.append({"number": z.shop_sequence_number, "businessDate": z.business_date.isoformat(),
                     "tills": len({s.machine_id for s in shifts}), "shifts": len(shifts),
                     "documents": z.transactions_count, "sales": d(z.total_sales), "refunds": d(z.total_refunds),
                     "cash": d(z.total_cash_sales), "card": d(z.total_card_sales), "tips": d(z.total_tips),
                     "tipsCash": d(z.total_cash_tips), "tipsCard": d(z.total_card_tips), "vat": d(z.vat_total)})
    return rows


def run(tenant_id, out_dir: Optional[Path], log, z_mode: str = "area", registration_number: Optional[str] = None,
        days: Optional[List[date]] = None, dealer_type: str = "licensed",
        export_window: Optional[Tuple[date, date]] = None) -> int:
    from app.database import SessionLocal
    from app.models.company import Company
    from app.models.shop import Shop
    from app.models.tenant import Tenant
    from app.models.user import User, UserRole
    from app.services.reports import resolve_report_window

    db = SessionLocal()
    checks = Checks()
    report: Dict[str, Any] = {}
    try:
        tenant = db.get(Tenant, uuid.UUID(str(tenant_id)))
        company = db.query(Company).filter(Company.tenant_id == tenant.id).one()
        shop = db.query(Shop).filter(Shop.tenant_id == tenant.id).one()
        user = db.query(User).filter(User.role == UserRole.SUPER_ADMIN, User.is_active.is_(True)).first()
        books = Books(db, tenant.id)
        report["tenant"] = {"id": str(tenant.id), "name": tenant.name, "companyId": str(company.id),
                            "company": company.name, "vatNumber": company.vat_number, "shopId": str(shop.id),
                            "shop": shop.name, "areas": {a.name: str(a.id) for a in books.areas.values()},
                            "tills": sorted([{"id": str(m.id), "name": m.name, "posNumber": m.pos_number,
                                              "prefix": m.effective_document_prefix,
                                              "area": books.areas[m.area_id].name if m.area_id else None}
                                             for m in books.machines.values()], key=lambda x: x["name"])}
        if z_mode == "shop":  # the area default writes exactly the report it always did
            report["zMode"] = "shop"
        if dealer_type != "licensed":
            report["dealerType"] = dealer_type
        if export_window is None and days:
            export_window = (min(days), max(days))  # a rehearsal / short run: the file covers what was simulated
        report["perBar"] = per_bar(books, z_mode)
        report["all"] = {k: _js(v) for k, v in books.figures(list(books.docs.values())).items()}
        if z_mode == "shop":
            report["shopZs"] = shop_z_rows(books)
        invariants(books, checks, _expected_nights(days), z_mode)
        window = resolve_report_window(db, tenant.id, from_date=P.MONTH_FIRST, to_date=date(2026, 10, 1))
        report["reconciliation"] = reconciliation(db, user, tenant.id, shop.id, window, checks)
        report["reports"] = reports(db, user, tenant, shop, books, checks, window)
        report["uniformFile"] = uniform_file(db, tenant, company, books, checks, out_dir, registration_number,
                                           window=export_window, dealer_type=dealer_type)
        from app.models.attendance import AttendanceShift

        att = db.query(AttendanceShift).filter(AttendanceShift.shop_id == shop.id).all()
        report["attendance"] = {"shifts": len(att), "open": sum(1 for a in att if a.clock_out_at is None),
                                "hours": round(sum((a.clock_out_at - a.clock_in_at).total_seconds()
                                                   for a in att if a.clock_out_at) / 3600, 1)}
        report["clockLeaks"] = clock_leaks(db, tenant.id)
        checks.add("clock", "no row of the tenant stamped after 4.10.2026 (a wall-clock leak)",
                   not report["clockLeaks"], report["clockLeaks"][:10])
    finally:
        db.rollback()
        db.close()
    report["checks"] = checks.rows
    report["failed"] = checks.failed
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_js),
                                                   encoding="utf-8")
        (out_dir / "verification.md").write_text(summary_md(report), encoding="utf-8")
    for r in checks.rows:
        log(f"  [{'OK ' if r['ok'] else 'FAIL'}] {r['section']}: {r['check']}"
            + ("" if r["ok"] else f" — {json.dumps(r['detail'], ensure_ascii=False, default=_js)[:600]}"))
    log(f"verification: {len(checks.rows) - len(checks.failed)}/{len(checks.rows)} checks passed")
    return 0 if not checks.failed else 1


def summary_md(report: Dict[str, Any]) -> str:
    """The verification in short: the bars' table, the checks, the uniform file."""
    t = report.get("tenant", {})
    L = [f"# {t.get('name', '')} — verification", "",
         f"Tenant `{t.get('id')}` · company `{t.get('companyId')}` (ח.פ. {t.get('vatNumber')}) · "
         f"shop `{t.get('shopId')}` {t.get('shop', '')}", "",
         "| Bar | 320 | 330 | cancelled 320 | shifts | Zs | net ₪ | cash ₪ | card ₪ | tips cash ₪ | tips card ₪ | VAT ₪ |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for row in report.get("perBar", {}).values():
        L.append(f"| {row['bar']} | {row['sales320']} | {row['creditNotes330']} | {row['cancelled320']} | "
                 f"{row['shifts']} | {row['zReports']} | {money(row['net'])} | {money(row['cash'])} | "
                 f"{money(row['card'])} | {money(row['tipsCash'])} | {money(row['tipsCard'])} | {money(row['vat'])} |")
    if report.get("dealerType") == "exempt":
        L += ["", "Dealer type: **exempt (עוסק פטור)** — no VAT; receipts (400) and receipt refunds (-400, filed as a 400 "
                  "with negative amounts); a receipt carries no D110 lines and the file has no M100 records.", ""]
    zs = report.get("shopZs")
    if zs is not None:
        L += ["", "Z mode: **shop Z (\"Z סניפי\")** — one Z per branch per business night; in the table above, "
                  "\"Zs\" is the number of shop Zs holding that bar's shifts.", "",
              f"## Shop Zs ({len(zs)}, numbered {zs[0]['number'] if zs else '-'}…{zs[-1]['number'] if zs else '-'})", "",
              "| Z | night | tills | shifts | documents | sales ₪ | refunds ₪ | cash ₪ | card ₪ | tips cash ₪ | tips card ₪ | VAT ₪ |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for z in zs:
            L.append(f"| {z['number']} | {z['businessDate']} | {z['tills']} | {z['shifts']} | {z['documents']} | "
                     f"{money(z['sales'])} | {money(z['refunds'])} | {money(z['cash'])} | {money(z['card'])} | "
                     f"{money(z['tipsCash'])} | {money(z['tipsCard'])} | {money(z['vat'])} |")
        L.append(f"| **total** | | | {sum(z['shifts'] for z in zs)} | {sum(z['documents'] for z in zs)} | "
                 f"{money(sum(z['sales'] for z in zs))} | {money(sum(z['refunds'] for z in zs))} | "
                 f"{money(sum(z['cash'] for z in zs))} | {money(sum(z['card'] for z in zs))} | "
                 f"{money(sum(z['tipsCash'] for z in zs))} | {money(sum(z['tipsCard'] for z in zs))} | "
                 f"{money(sum(z['vat'] for z in zs))} |")
    checks = report.get("checks", [])
    L += ["", f"Checks: {sum(1 for c in checks if c['ok'])}/{len(checks)} passed.", ""]
    for c in checks:
        L.append(f"- {'OK' if c['ok'] else 'FAIL'} — {c['section']}: {c['check']}"
                 + ("" if c["ok"] else f" — `{json.dumps(c['detail'], ensure_ascii=False, default=_js)[:400]}`"))
    uf = report.get("uniformFile", {})
    if uf:
        L += ["", f"## Uniform file ({uf.get('period') or 'September 2026'})", "",
              f"Records: {json.dumps(uf.get('recordCounts'), ensure_ascii=False, default=_js)}; "
              f"documents {uf.get('documents')} {json.dumps(uf.get('byType'), ensure_ascii=False)}; "
              f"cancelled {uf.get('cancelled')}; sales ₪{uf.get('salesTotal')}; credit notes ₪{uf.get('creditTotal')}; "
              f"VAT ₪{uf.get('vat')}; A000 {json.dumps(uf.get('A000'), ensure_ascii=False)}; "
              f"after midnight on 30.9 (dated 1.10, not in this file): {json.dumps(uf.get('october1Tail'))}."]
    return "\n".join(L) + "\n"


def clock_leaks(db, tenant_id) -> List[dict]:
    """Every timestamp column of the tenant's rows after 2026-10-04: a "now" the simulation missed."""
    from sqlalchemy import text

    from app.database import Base

    leaks = []
    # After the month, its last Z run and its 36 h expiry, and long before the real date the
    # seeder runs on: a value past it is a "now" the simulation clock did not give.
    cutoff = datetime(2026, 10, 4, tzinfo=timezone.utc)
    # The tenant's rows: by their own tenant_id, else through the row they belong to.
    owners = (("tenant_id", None), ("machine_id", "pos_machines"), ("pos_machine_id", "pos_machines"),
              ("shop_id", "shops"), ("transaction_id", "transactions"), ("shift_id", "shifts"),
              ("z_report_id", "z_reports"), ("run_id", "z_runs"), ("pos_user_id", "pos_users"))
    for table in Base.metadata.tables.values():
        owner = next(((c, parent) for c, parent in owners if c in table.c), None)
        if owner is None:
            continue
        col_name, parent = owner
        scope = (f'"{col_name}" = :t' if parent is None
                 else f'"{col_name}" in (select id from "{parent}" where tenant_id = :t)')
        for col in table.c:
            if col.type.__class__.__name__ not in ("DateTime", "TIMESTAMP"):
                continue
            n = db.execute(text(f'select count(*) from "{table.name}" where {scope} and "{col.name}" > :c'),
                           {"t": tenant_id, "c": cutoff}).scalar()
            if n:
                leaks.append({"table": table.name, "column": col.name, "rows": n})
    return leaks
