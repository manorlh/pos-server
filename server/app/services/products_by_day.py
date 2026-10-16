"""
"מכירות מוצרים לפי ימים" (P:/specs/reports-designed-pdf.md §8, contract §7.6): the product sales
of a date range day by day — each day's products, the days side by side, the whole range summed
up, a product × day matrix of quantities and the range's insights — as JSON
(`GET /reports/products-by-day`) and as a designed PDF (`GET /reports/products-by-day/pdf`).

**The figures are the product report's** (`GET /reports/products`): the same documents
(`build_scoped_transaction_query`), the same line rules (net = the line's gross − its discounts
and promotions − credit notes' lines; a production voucher's ₪0 memo line is no unit), a meal as
its components by default (`meals=components`, its money allocated to them), and calendar days in
the report's timezone — so the range's summary equals the product report over the same range.

Scope as everywhere (`day_summary.Scope`: company, shops, points of sale, tills — narrowing only),
and `categoryIds` (a department; `none`: products with none).
"""
from __future__ import annotations

import math
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.models.transaction import Transaction
from app.models.transaction_item import TransactionItem
from app.models.user import User
from app.services import day_summary as DS
from app.services import report_design as D
from app.services import report_insights as I
from app.services import report_pdf as P
from app.services.reports import ReportWindow, _is_refund_condition, _load_zoneinfo, _to_float
from app.services.tenders import sale_condition

SHORT_WEEKDAYS = ("יום ב׳", "יום ג׳", "יום ד׳", "יום ה׳", "יום ו׳", "שבת", "יום א׳")
#: Days above which the matrix is by week (§8.4).
MATRIX_DAYS_MAX = 14
#: Products in the matrix (the best sellers); the summary lists them all.
MATRIX_ROWS_MAX = 80
#: A day's products listed in its section of the PDF.
DAY_ROWS_MAX = 200


def _r(v: Any) -> float:
    return round(_to_float(v), 2)


def _q(v: Any) -> float:
    return round(_to_float(v), 3)


def _days(window: ReportWindow) -> List[date]:
    return [window.from_date + timedelta(days=i) for i in range((window.to_date - window.from_date).days + 1)]


def day_label(d: date, *, year: bool = True) -> str:
    return f"{SHORT_WEEKDAYS[d.weekday()]} {d.strftime('%d.%m.%Y' if year else '%d.%m')}"


def _local_day(window: ReportWindow, moment: Any) -> date:
    if isinstance(moment, date) and not isinstance(moment, datetime):
        return moment
    if isinstance(moment, str):
        if len(moment) <= 10:
            return date.fromisoformat(moment)
        moment = datetime.fromisoformat(moment)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(_load_zoneinfo(window.tz_name)).date()


def _day_expr(db: Session, window: ReportWindow):
    if db.get_bind().dialect.name == "postgresql":
        return func.date(func.timezone(window.tz_name, Transaction.created_at))
    return Transaction.created_at


def _category_filter(category_ids: Sequence[Any], product_col):
    """Products of these departments (`none`: of none), as a predicate on a product id column."""
    from sqlalchemy import select

    from app.models.product import Product

    ids = [c for c in category_ids if isinstance(c, uuid.UUID)]
    clauses = []
    if ids:
        clauses.append(product_col.in_(select(Product.id).where(Product.category_id.in_(ids))))
    if any(c == "none" for c in category_ids):
        clauses.append(product_col.is_(None))
    return or_(*clauses) if clauses else None


def parse_categories(raw: Optional[Sequence[str]]) -> List[Any]:
    from fastapi import HTTPException, status

    out: List[Any] = []
    for value in raw or []:
        text = (value or "").strip()
        if not text:
            continue
        if text.lower() == "none":
            out.append("none")
            continue
        try:
            out.append(uuid.UUID(text))
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail="categoryIds must be category ids or 'none'") from exc
    return out


def _rows_by_day(db: Session, q, window: ReportWindow, category_ids: Sequence[Any], meals: str
                 ) -> Tuple[Dict[Tuple[date, str], Dict[str, Any]], Dict[date, int]]:
    """{(day, product key): {productId, name, units, net}}, and the sale documents per day."""
    from app.models.menu import TransactionItemPart as Part
    from app.services.reports import _meal_item_ids

    day = _day_expr(db, window)
    tx_sub = q.with_entities(
        Transaction.id.label("tx_id"),
        day.label("day"),
        case((_is_refund_condition(), True), else_=False).label("is_refund"),
    ).subquery()
    is_refund = tx_sub.c.is_refund
    qty = case((TransactionItem.voucher_memo_value.isnot(None), 0), else_=TransactionItem.quantity)
    line_discount = (func.coalesce(TransactionItem.discount, 0) + func.coalesce(TransactionItem.promotion_discount, 0)
                     + func.coalesce(TransactionItem.voucher_discount, 0))
    lines = (
        db.query(
            tx_sub.c.day, TransactionItem.product_id, TransactionItem.product_name,
            func.coalesce(func.sum(case((is_refund.is_(False), qty), else_=-qty)), 0),
            func.coalesce(func.sum(case((is_refund.is_(False), TransactionItem.total_price - line_discount),
                                        else_=-TransactionItem.total_price)), 0),
        )
        .select_from(TransactionItem)
        .join(tx_sub, tx_sub.c.tx_id == TransactionItem.transaction_id)
    )
    if meals != "meals":
        lines = lines.filter(~TransactionItem.id.in_(_meal_item_ids(db)))
    pred = _category_filter(category_ids, TransactionItem.product_id)
    if pred is not None:
        lines = lines.filter(pred)
    rows = list(lines.group_by(tx_sub.c.day, TransactionItem.product_id, TransactionItem.product_name).all())
    if meals != "meals":
        parts = (
            db.query(
                tx_sub.c.day, Part.product_id, Part.name,
                func.coalesce(func.sum(case((is_refund.is_(False), Part.quantity), else_=-Part.quantity)), 0),
                func.coalesce(func.sum(case((is_refund.is_(False), Part.gross - func.coalesce(Part.discount, 0)),
                                            else_=-Part.gross)), 0),
            )
            .join(tx_sub, tx_sub.c.tx_id == Part.transaction_id)
            .filter(Part.kind == "component")
        )
        pred = _category_filter(category_ids, Part.product_id)
        if pred is not None:
            parts = parts.filter(pred)
        rows += list(parts.group_by(tx_sub.c.day, Part.product_id, Part.name).all())
    out: Dict[Tuple[date, str], Dict[str, Any]] = {}
    for raw_day, pid, name, units, net in rows:
        d = _local_day(window, raw_day)
        key = str(pid) if pid else f"name:{name}"
        acc = out.setdefault((d, key), {"productId": str(pid) if pid else None, "name": name or P.DASH,
                                        "units": 0.0, "net": 0.0})
        acc["units"] += _to_float(units)
        acc["net"] += _to_float(net)
    docs: Dict[date, int] = {}
    for raw_day, n in (
        q.filter(sale_condition()).with_entities(day, func.count(Transaction.id)).group_by(day).all()
    ):
        d = _local_day(window, raw_day)
        docs[d] = docs.get(d, 0) + int(n or 0)
    return out, docs


def _departments(db: Session, product_ids: Sequence[str]) -> Dict[str, str]:
    from app.models.category import Category
    from app.models.product import Product

    ids = []
    for p in product_ids:
        try:
            ids.append(uuid.UUID(p))
        except (TypeError, ValueError):
            continue
    if not ids:
        return {}
    rows = (
        db.query(Product.id, Category.name)
        .outerjoin(Category, Category.id == Product.category_id)
        .filter(Product.id.in_(ids))
        .all()
    )
    return {str(pid): name for pid, name in rows if name}


def build(db: Session, user: User, tenant_id, window: ReportWindow, *, scope: Optional[DS.Scope] = None,
          category_ids: Sequence[Any] = (), amounts: bool = True, hide_empty_days: bool = False, sort: str = "qty",
          meals: str = "components") -> Dict[str, Any]:
    """The report (§7.6)."""
    scope = scope or DS.Scope()
    sort = "amount" if sort == "amount" else "qty"
    q = DS.documents(db, user, tenant_id, window, scope)
    by_day, docs = _rows_by_day(db, q, window, category_ids, meals) if q is not None else ({}, {})
    departments = _departments(db, sorted({v["productId"] for v in by_day.values() if v["productId"]}))

    def product_row(v: Dict[str, Any], day_total: float, day_units: float) -> Dict[str, Any]:
        share = (v["net"] / day_total * 100 if day_total else 0.0) if amounts else (
            v["units"] / day_units * 100 if day_units else 0.0)
        return {"productId": v["productId"], "name": v["name"],
                "department": departments.get(v["productId"] or "") or None,
                "units": _q(v["units"]), "net": _r(v["net"]), "share": round(share, 2)}

    def order(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        key = (lambda r: (-r["net"], -r["units"])) if sort == "amount" else (lambda r: (-r["units"], -r["net"]))
        return sorted(rows, key=lambda r: (*key(r), r["name"]))

    days_out: List[Dict[str, Any]] = []
    previous: Optional[Dict[str, Any]] = None
    for d in _days(window):
        products = [v for (day, _k), v in by_day.items() if day == d]
        total = sum(v["net"] for v in products)
        units = sum(v["units"] for v in products)
        if hide_empty_days and not products and not docs.get(d):
            continue
        basis = (lambda x: x["net"]) if amounts else (lambda x: x["items"])
        row = {
            "date": d.isoformat(), "weekday": SHORT_WEEKDAYS[d.weekday()], "label": day_label(d),
            "items": _q(units), "net": _r(total), "documents": docs.get(d, 0), "changePct": None,
            "products": order([product_row(v, total, units) for v in products]),
        }
        if previous is not None and basis(previous):
            row["changePct"] = round((basis(row) - basis(previous)) / abs(basis(previous)) * 100, 2)
        previous = row
        days_out.append(row)

    # The whole range.
    totals: Dict[str, Dict[str, Any]] = {}
    sold_days: Dict[str, set] = {}
    for (d, key), v in by_day.items():
        acc = totals.setdefault(key, {"productId": v["productId"], "name": v["name"], "units": 0.0, "net": 0.0})
        acc["units"] += v["units"]
        acc["net"] += v["net"]
        if v["units"] > 0:
            sold_days.setdefault(key, set()).add(d)
    n_days = max(1, len(days_out))
    range_net = sum(v["net"] for v in totals.values())
    range_units = sum(v["units"] for v in totals.values())
    summary_rows = []
    for key, v in totals.items():
        row = product_row(v, range_net, range_units)
        row.update(averagePerDay=round(v["units"] / n_days, 2), daysSold=len(sold_days.get(key, ())))
        row["_key"] = key
        summary_rows.append(row)
    summary_rows = order(summary_rows)

    # Product × day (or × week) quantities.
    all_days = [date.fromisoformat(x["date"]) for x in days_out]
    weekly = len(all_days) > MATRIX_DAYS_MAX
    if weekly:
        starts = sorted({d - timedelta(days=(d.weekday() + 1) % 7) for d in all_days})
        columns = [{"key": s.isoformat(), "label": f"{s.strftime('%d.%m')}–{(s + timedelta(days=6)).strftime('%d.%m')}"}
                   for s in starts]
        bucket = lambda d: (d - timedelta(days=(d.weekday() + 1) % 7)).isoformat()  # noqa: E731
    else:
        columns = [{"key": d.isoformat(), "label": d.strftime("%d.%m")} for d in all_days]
        bucket = lambda d: d.isoformat()  # noqa: E731
    col_index = {c["key"]: i for i, c in enumerate(columns)}
    matrix_rows = []
    for row in sorted(summary_rows, key=lambda r: (-r["units"], r["name"]))[:MATRIX_ROWS_MAX]:
        values = [0.0] * len(columns)
        for (d, key), v in by_day.items():
            if key == row["_key"] and bucket(d) in col_index:
                values[col_index[bucket(d)]] += v["units"]
        matrix_rows.append({"productId": row["productId"], "name": row["name"],
                            "values": [_q(x) for x in values], "total": _q(sum(values))})
    for row in summary_rows:
        row.pop("_key", None)

    traded = [x for x in days_out if x["net"] or x["items"]]
    best = max(traded, key=lambda x: x["net"] if amounts else x["items"]) if traded else None
    worst = min(traded, key=lambda x: x["net"] if amounts else x["items"]) if traded else None

    def day_text(x: Optional[Dict[str, Any]]) -> Optional[str]:
        if not x:
            return None
        figure = D.format_value(x["net"], "money", short=True) if amounts else f"{P.format_number(x['items'])} פריטים"
        return f"{day_label(date.fromisoformat(x['date']), year=False)} · {figure}"

    kpis = []
    if amounts:
        kpis.append({"key": "net", "label": "סה״כ מכירות", "kind": "money", "value": _r(range_net)})
    kpis += [
        {"key": "items", "label": "סה״כ פריטים", "kind": "number", "value": _q(range_units)},
        {"key": "days", "label": "מספר ימים", "kind": "number", "value": len(days_out)},
        {"key": "averagePerDay", "label": "ממוצע ליום", "kind": "money" if amounts else "number",
         "value": _r((range_net if amounts else range_units) / n_days)},
        {"key": "bestDay", "label": "היום החזק", "kind": "text", "value": day_text(best)},
        {"key": "worstDay", "label": "היום החלש", "kind": "text", "value": day_text(worst)},
    ]
    out = {
        "window": window.to_schema().model_dump(by_alias=True, mode="json"),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scope": {**scope.as_json(), "categoryIds": [str(c) for c in category_ids], "label": DS.scope_label(db, scope)},
        "options": {"amounts": amounts, "hideEmptyDays": hide_empty_days, "sort": sort, "meals": meals},
        "kpis": kpis,
        "days": days_out,
        "summary": {
            "products": summary_rows,
            "totals": {"units": _q(range_units), "net": _r(range_net), "documents": sum(docs.values()),
                       "days": len(days_out)},
        },
        "matrix": {"grouping": "week" if weekly else "day", "columns": columns, "rows": matrix_rows},
    }
    out["insights"] = [i.as_json() for i in insights(out, by_day)]
    return out


def insights(data: Dict[str, Any], by_day: Dict[Tuple[date, str], Dict[str, Any]]) -> List[D.Insight]:
    """The range's sentences (§8.5): risers and fallers, unusual days, products that may have sold out."""
    days = data["days"]
    amounts = data["options"]["amounts"]
    out: List[Tuple[float, D.Insight]] = []
    traded = [d for d in days if d["net"] or d["items"]]
    if len(traded) < 2:
        return []
    fmt = (lambda v: D.format_value(v, "money", short=True)) if amounts else (lambda v: f"{P.format_number(round(v, 1))} יח׳")  # noqa: E731
    basis = (lambda d: d["net"]) if amounts else (lambda d: d["items"])  # noqa: E731

    # Unusual days (MAD over the days' figures).
    values = [basis(d) for d in traded]
    med = I.median(values)
    if len(traded) >= I.MIN_OUTLIER_ROWS and med:
        for d in sorted(traded, key=lambda d: -abs(basis(d) - med))[:2]:
            z = I.robust_z(basis(d), values)
            if z is not None and abs(z) >= I.ROBUST_Z and abs(basis(d) - med) / med >= 0.3:
                word = "חריג כלפי מעלה" if basis(d) > med else "חריג כלפי מטה"
                out.append((80, D.Insight("alert", f"יום {word}: {d['label']} — {fmt(basis(d))}, מול חציון של {fmt(med)} ליום")))
    best = max(traded, key=basis)
    out.append((70, D.Insight("leader", f"היום החזק בטווח: {best['label']} — {fmt(basis(best))}")))

    # Risers and fallers: the first third of the range against the last, per day.
    all_days = [date.fromisoformat(d["date"]) for d in days]
    if len(all_days) >= 3:
        third = max(1, len(all_days) // 3)
        first, last = set(all_days[:third]), set(all_days[-third:])
        per: Dict[str, List[float]] = {}
        names: Dict[str, str] = {}
        for (d, key), v in by_day.items():
            acc = per.setdefault(key, [0.0, 0.0])
            names[key] = v["name"]
            figure = v["net"] if amounts else v["units"]
            if d in first:
                acc[0] += figure / len(first)
            if d in last:
                acc[1] += figure / len(last)
        moves = [(b - a, k, a, b) for k, (a, b) in per.items() if a > 0 or b > 0]
        if moves:
            up = max(moves)
            down = min(moves)
            if up[0] > 0 and up[2] > 0:
                out.append((78, D.Insight("up", f"העלייה הגדולה בטווח: {names[up[1]]} — מ-{fmt(up[2])} ל-{fmt(up[3])} ליום "
                                                f"({I._p((up[3] - up[2]) / up[2] * 100)})")))
            if down[0] < 0:
                out.append((77, D.Insight("down", f"הירידה הגדולה בטווח: {names[down[1]]} — מ-{fmt(down[2])} ל-{fmt(down[3])} ליום")))

    # Sold most days, but not on some — maybe sold out.
    n = len(traded)
    traded_days = {date.fromisoformat(d["date"]) for d in traded}
    sold: Dict[str, set] = {}
    names2: Dict[str, str] = {}
    for (d, key), v in by_day.items():
        if v["units"] > 0:
            sold.setdefault(key, set()).add(d)
            names2[key] = v["name"]
    if n >= 4:
        gaps = []
        for key, ds in sold.items():
            if len(ds) >= max(3, math.ceil(n * 0.6)) and len(ds) < n:
                missing = sorted(traded_days - ds)
                gaps.append((len(ds), key, missing))
        gaps.sort(key=lambda g: -g[0])
        for count, key, missing in gaps[:2]:
            when = ", ".join(day_label(d, year=False) for d in missing[:3]) + (" ועוד" if len(missing) > 3 else "")
            out.append((74, D.Insight("alert", f"{names2[key]} נמכר ב-{count} מתוך {n} הימים, אבל לא ב{when} — ייתכן שאזל")))
    out.sort(key=lambda x: -x[0])
    return [i for _s, i in out[:I.MAX_INSIGHTS]]


# ── The PDF ──────────────────────────────────────────────────────────────────


def document(data: Dict[str, Any], *, title: str = "מכירות מוצרים לפי ימים", branding: Optional[Dict[str, Any]] = None,
             user_name: str = "") -> D.Document:
    branding = branding or {}
    amounts = data["options"]["amounts"]
    w = data["window"]
    tz = w.get("timezone") or "Asia/Jerusalem"
    f, t = date.fromisoformat(w["from"]), date.fromisoformat(w["to"])
    kpis = [D.Kpi(key=k["key"], label=k["label"], value=k["value"], kind=k["kind"], icon=D.icon_of(k["key"]))
            for k in data["kpis"]]
    for k in kpis:
        if k.key in ("bestDay", "worstDay"):
            k.icon = "calendar"
    blocks: List[Any] = [D.Section("תמונת מצב", "chart"), D.KpiBlock(kpis)]
    if data["insights"]:
        blocks.append(D.Section("תובנות — מה חשוב לדעת", "tip_bulb"))
        blocks.append(D.InsightBlock([D.Insight(i["type"], i["text"]) for i in data["insights"]]))
    days = data["days"]
    blocks.append(D.Section("יום אחרי יום", "calendar"))
    if days:
        figure = "net" if amounts else "items"
        blocks.append(D.ChartBlock([D.Chart(
            "bar" if len(days) <= 31 else "line", [date.fromisoformat(d["date"]).strftime("%d.%m") for d in days],
            [D.Series("", [d[figure] for d in days])], "מכירות לפי יום" if amounts else "פריטים לפי יום",
            "money" if amounts else "number")]))

    col = DS._col
    day_cols = [col("label", "תאריך"), col("items", "כמות פריטים", "number")]
    if amounts:
        day_cols.append(col("net", "מכירות", "money"))
    day_cols += [col("documents", "עסקאות", "number"), col("changePct", "שינוי מול היום הקודם", "trend")]
    totals = data["summary"]["totals"]
    day_totals = [P.TOTAL_LABEL, P.format_number(totals["units"])] + ([P.format_money(totals["net"])] if amounts else []) + [
        P.format_number(totals["documents"]), ""]
    blocks.append(D.Table(day_cols, DS._cells(day_cols, days), totals=day_totals, title="מכירות לפי יום"))

    prod_cols = [col("name", "מוצר"), col("department", "מחלקה"), col("units", "כמות", "number")]
    if amounts:
        prod_cols.append(col("net", "מכירות", "money"))
    prod_cols.append(col("share", "% מהיום", "percent"))
    long = sum(min(len(d["products"]), DAY_ROWS_MAX) for d in days) > 45 or len(days) > 7
    sold = [d for d in days if d["products"]]
    if sold:
        blocks.append(D.Section("המוצרים של כל יום", "box", new_page=long))
    for k, d in enumerate(sold):
        head = f"{d['label']} · " + (f"{D.format_value(d['net'], 'money', short=True)} · " if amounts else "") + \
            f"{P.format_number(d['items'])} פריטים"
        blocks.append(D.Heading(head, new_page=long and k > 0))
        blocks.append(D.Table(prod_cols, DS._cells(prod_cols, d["products"][:DAY_ROWS_MAX])))

    blocks.append(D.Section("סיכום כל הימים יחד", "list", new_page=True))
    sum_cols = [col("name", "מוצר"), col("department", "מחלקה"), col("units", "כמות כוללת", "number")]
    if amounts:
        sum_cols.append(col("net", "מכירות", "money"))
    sum_cols += [col("share", "% מהטווח", "percent"), col("averagePerDay", "ממוצע ליום", "number"),
                 col("daysSold", "ימים שנמכר", "number")]
    sum_totals = [P.TOTAL_LABEL, "", P.format_number(totals["units"])] + ([P.format_money(totals["net"])] if amounts else []) + [
        "100%" if data["summary"]["products"] else "", P.format_number(round(totals["units"] / max(1, totals["days"]), 2)), ""]
    blocks.append(D.Table(sum_cols, DS._cells(sum_cols, data["summary"]["products"]), totals=sum_totals))

    m = data["matrix"]
    if m["rows"] and m["columns"]:
        cols = [col("name", "מוצר")] + [col(c["key"], c["label"], "number") for c in m["columns"][:30]] + [
            col("total", "סה״כ", "number")]
        rows = [[r["name"]] + [P.format_number(v) if v else "" for v in r["values"][:30]] + [P.format_number(r["total"])]
                for r in m["rows"]]
        blocks.append(D.Table(cols, rows, title="מוצר × " + ("שבוע" if m["grouping"] == "week" else "יום") + " (כמויות)"))
    period = f"{f.strftime('%d.%m.%Y')} – {t.strftime('%d.%m.%Y')}"
    facts = [("תקופה", period), ("ימים", P.format_number(totals["days"])), ("היקף", data["scope"]["label"]),
             ("מוצרים", P.format_number(len(data["summary"]["products"]))), ("פריטים", P.format_number(totals["units"]))]
    return D.Document(
        title=title,
        period=period,
        scope=data["scope"]["label"],
        facts=facts,
        generated_at=D.now_label(tz),
        generated_by=user_name,
        business_name=branding.get("name") or "",
        logo=branding.get("logo"),
        accent=branding.get("accent") or D.DEFAULT_ACCENT,
        orientation="auto",
        cover="auto",
        blocks=blocks,
    )


def render_pdf(data: Dict[str, Any], **kw) -> bytes:
    return D.render_document(document(data, **kw))
