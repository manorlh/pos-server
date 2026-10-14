"""
A trading world for "סיכום יום" v2 and the designed PDFs (P:/specs/reports-designed-pdf.md §3).

On the SQLite world of tests/shift_world.py: two shops of Acme (Center with two points of sale,
"בר" and "טרסה", one till each; North with one till), a shop of another company of the same
tenant (Beta › South), products in two departments, three cashiers, tables, till events, an
untransmitted card leg, attendance and exceptions. `TODAY` is the business day; its documents
and the same weekday's of the last four weeks are fixed (`add_base`), so the tests know every
figure. `add_rich` adds a seeded month of trading on top, for the sample PDFs.
"""
from __future__ import annotations

import random
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import List, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

from app.models.audit_exception import AuditException, TillEvent
from app.models.category import Category
from app.models.company import Company
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.pos_user import PosUser
from app.models.product import Product
from app.models.shift import Shift, ShiftStatus
from app.models.shop import Shop
from app.models.shop_area import ShopArea
from app.models.tables import DiningTable, TableOrder, TableZone
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.transaction_payment import TransactionPayment
from shift_world import TODAY, make_world

ZONE = ZoneInfo("Asia/Jerusalem")


def at(day: date, hour: int, minute: int = 0, *, next_day: bool = False) -> datetime:
    """Local wall-clock time on `day` (or the calendar day after it) as UTC."""
    d = day + timedelta(days=1) if next_day else day
    return datetime.combine(d, time(hour, minute), tzinfo=ZONE).astimezone(timezone.utc)


def build(*, rich: bool = False, seed: int = 7):
    w = make_world()
    db = w.db
    w.TODAY = TODAY
    till1, till2 = w.tills
    north = w.other_till
    # Points of sale in Center.
    w.bar = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="בר", sort_order=1)
    w.terrace = ShopArea(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="טרסה", sort_order=2)
    db.add_all([w.bar, w.terrace])
    db.flush()
    till1.area_id, till2.area_id = w.bar.id, w.terrace.id
    w.shop.name, w.other_shop.name = "סניף מרכז", "סניף צפון"
    till1.name, till2.name, north.name = "קופה ראשית", "קופת טרסה", "קופה צפון"
    w.company.name = "Acme קפה בע״מ"
    # Another company of the same tenant.
    w.beta = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Beta", vat_number="2")
    db.add(w.beta)
    db.flush()
    w.south = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.beta.id, name="סניף דרום", settings={})
    db.add(w.south)
    db.flush()
    w.south_till = POSMachine(
        id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.south.id, distributor_id=w.admin.id, name="קופה דרום",
        machine_code="M-S", pos_number="9", is_active=True, pairing_status=PairingStatus.ASSIGNED,
    )
    db.add(w.south_till)
    db.flush()
    # People.
    def person(first, last, shop, number):
        u = PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=shop.id, username=first, first_name=first,
                    last_name=last, worker_number=number, pin_hash="x")
        db.add(u)
        return u

    w.dana = person("דנה", "כהן", w.shop, "11")
    w.yossi = person("יוסי", "לוי", w.shop, "12")
    w.michal = person("מיכל", "פרץ", w.other_shop, "21")
    db.flush()
    # The catalogue.
    w.drinks = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name="שתייה")
    w.pastry = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name="מאפים")
    db.add_all([w.drinks, w.pastry])
    db.flush()

    def product(name, price, cat, sku):
        p = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, category_id=cat.id, name=name, price=Decimal(price), sku=sku)
        db.add(p)
        return p

    w.coffee = product("קפה הפוך", "12", w.drinks, "C1")
    w.croissant = product("קרואסון חמאה", "14", w.pastry, "P1")
    w.juice = product("מיץ תפוזים", "16", w.drinks, "J1")
    db.flush()
    # The shifts each document is rung on (stamped with the till's area).
    w.shifts = {}
    for till, area in ((till1, w.bar.id), (till2, w.terrace.id), (north, None), (w.south_till, None)):
        s = Shift(id=uuid.uuid4(), tenant_id=till.tenant_id, machine_id=till.id, shop_id=till.shop_id,
                  business_date=TODAY, sequence_number=1, opened_at=at(TODAY - timedelta(days=30), 6),
                  opening_cash=Decimal("100"), status=ShiftStatus.OPEN, area_id=area)
        db.add(s)
        w.shifts[till.id] = s
    db.flush()
    w._n = 5000
    add_base(w)
    if rich:
        add_rich(w, seed)
    db.commit()
    return w


Line = Tuple[Product, float, str]  # (product, quantity, line discount)


def sale(w, till: POSMachine, when: datetime, lines: Sequence[Line], *, cashier: Optional[PosUser] = None,
         method: str = "cash", legs=None, tip: str = "0", tip_method: Optional[str] = None,
         credit_note: bool = False, status: TransactionStatus = TransactionStatus.COMPLETED,
         oth: Sequence[Tuple[Product, float]] = (), terminal_uid: Optional[str] = None) -> Transaction:
    """A document with its lines and legs. A credit note's lines and total are the money handed back."""
    w._n += 1
    db = w.db
    gross = Decimal("0")
    discount = Decimal("0")
    items = []
    for p, qty, disc in lines:
        line = (Decimal(str(p.price)) * Decimal(str(qty))).quantize(Decimal("0.01"))
        d = Decimal(disc)
        gross += line
        if not credit_note:
            discount += d
        items.append((p, qty, line, d, None))
    for p, qty in oth:
        line = (Decimal(str(p.price)) * Decimal(str(qty))).quantize(Decimal("0.01"))
        gross += line
        discount += line
        items.append((p, qty, line, line, "לקוח קבוע"))
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=till.tenant_id, machine_id=till.id, shop_id=till.shop_id,
        shift_id=w.shifts[till.id].id, transaction_number=str(w._n), status=status,
        document_type=330 if credit_note else 320, payment_method=method, total_amount=gross,
        document_discount=discount, tip_amount=Decimal(tip), tip_payment_method=tip_method,
        cashier_id=str(cashier.id) if cashier else None, created_at=when, updated_at=when, server_received_at=when,
    )
    db.add(tx)
    db.flush()
    for p, qty, line, d, oth_reason in items:
        db.add(TransactionItem(
            id=uuid.uuid4(), transaction_id=tx.id, product_id=p.id, product_name=p.name, sku=p.sku,
            quantity=Decimal(str(qty)), unit_price=Decimal(str(p.price)), total_price=line,
            discount=d if (d and not credit_note) else None, oth_reason=oth_reason,
            oth_by=str(cashier.id) if (oth_reason and cashier) else None,
        ))
    collected = gross if credit_note else gross - discount
    for i, (m, amount) in enumerate(legs or [(method, str(collected))], start=1):
        db.add(TransactionPayment(id=uuid.uuid4(), transaction_id=tx.id, sequence=i, method=m, amount=Decimal(amount),
                                  terminal_uid=terminal_uid if m == "card" else None))
    db.flush()
    return tx


def add_base(w) -> None:
    """The fixed documents the tests count on (see tests/test_day_summary_v2.py for the sums)."""
    db = w.db
    till1, till2 = w.tills
    north = w.other_till
    d = TODAY
    till1.transmission_tracking_started_at = at(d - timedelta(days=1), 6)
    # Center › בר › till 1, דנה.
    sale(w, till1, at(d, 10, 15), [(w.coffee, 2, "0"), (w.croissant, 1, "0")], cashier=w.dana)            # 38
    sale(w, till1, at(d, 13, 30), [(w.coffee, 1, "0")], oth=[(w.croissant, 1)], cashier=w.dana,
         method="card", terminal_uid="T-1")                                                                # 26 − 14
    sale(w, till1, at(d, 13, 45), [(w.juice, 3, "8")], cashier=w.dana, method="card", tip="5", tip_method="card")  # 48 − 8
    sale(w, till1, at(d, 20, 0), [(w.coffee, 2, "0"), (w.croissant, 1, "0")], cashier=w.dana, credit_note=True)  # −38
    # Center › טרסה › till 2, יוסי (02:30 is still the business day; 04:30 is the next one).
    sale(w, till2, at(d, 13, 10), [(w.coffee, 5, "0")], cashier=w.yossi, method="card")                  # 60
    sale(w, till2, at(d, 2, 30, next_day=True), [(w.juice, 1, "0")], cashier=w.yossi)                     # 16
    sale(w, till2, at(d, 4, 30, next_day=True), [(w.coffee, 1, "0")], cashier=w.yossi)                    # next day
    # North, מיכל; a cancelled sale counts nowhere.
    sale(w, north, at(d, 12, 0), [(w.croissant, 2, "0")], cashier=w.michal)                               # 28
    sale(w, north, at(d, 12, 30), [(w.croissant, 9, "0")], cashier=w.michal, status=TransactionStatus.CANCELLED)
    # Beta › South: another company.
    sale(w, w.south_till, at(d, 11, 0), [(w.juice, 3, "0"), (w.coffee, 1, "0")])                          # 60
    # The same weekday before.
    sale(w, till1, at(d - timedelta(days=7), 11, 0), [(w.coffee, 4, "0")], cashier=w.dana)                # 48
    sale(w, north, at(d - timedelta(days=7), 12, 0), [(w.croissant, 1, "0")], cashier=w.michal)          # 14
    sale(w, till1, at(d - timedelta(days=14), 11, 0), [(w.coffee, 5, "20")], cashier=w.dana)              # 40 (60 − 20)
    sale(w, till1, at(d - timedelta(days=14), 12, 0), [(w.juice, 5, "0")], cashier=w.dana)                # 80 → 120 net? see tests
    sale(w, till1, at(d - timedelta(days=21), 11, 0), [(w.coffee, 5, "0"), (w.juice, 1, "4")], cashier=w.dana)  # 72
    sale(w, till1, at(d - timedelta(days=28), 11, 0), [(w.croissant, 10, "0")], cashier=w.dana)            # 140
    # Till events: a voided line on till 2, a drawer opened with no sale on till 1.
    for till, kind, who, amount in ((till2, "line_void", w.yossi, "9"), (till1, "drawer_open", w.dana, None)):
        db.add(TillEvent(id=uuid.uuid4(), tenant_id=w.tenant.id, machine_id=till.id, shop_id=till.shop_id,
                         event_type=kind, occurred_at=at(d, 15, 0), pos_user_id=str(who.id),
                         amount=Decimal(amount) if amount else None))
    # Tables in Center: one paid (3 guests, ₪60), one open at the day's end, one cancelled.
    zone = TableZone(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, name="אולם")
    db.add(zone)
    db.flush()
    tables = []
    for n in (1, 2, 3):
        t = DiningTable(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, zone_id=zone.id, number=n)
        db.add(t)
        tables.append(t)
    db.flush()

    def order(t, opened, closed, status, guests, total, paid=None, closer=None):
        db.add(TableOrder(
            id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, table_id=t.id, table_number=t.number,
            status=status, guests=guests, total=Decimal(total), paid_total=Decimal(paid) if paid else None,
            opened_at=opened, closed_at=closed, opened_machine_id=till2.id, closed_machine_id=till2.id if closed else None,
            waiter_pos_user_id=str(w.yossi.id), waiter_pos_user_name="יוסי לוי",
            closed_by_pos_user_id=str(closer.id) if closer else None,
            closed_by_pos_user_name=f"{closer.first_name} {closer.last_name}" if closer else None,
        ))

    order(tables[0], at(d, 12, 0), at(d, 13, 30), "paid", 3, "60", paid="60", closer=w.yossi)
    order(tables[1], at(d, 21, 0), None, "open", 2, "40")
    order(tables[2], at(d, 19, 0), at(d, 19, 20), "cancelled", 2, "30", closer=w.dana)
    # Attendance: דנה 09:00–17:00.
    from app.models.attendance import AttendanceShift

    db.add(AttendanceShift(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
                           pos_user_id=w.dana.id, clock_in_at=at(d, 9, 0), clock_out_at=at(d, 17, 0)))
    # Exceptions found that day.
    for kind in ("discount", "refund"):
        db.add(AuditException(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, shop_id=w.shop.id,
                              machine_id=till1.id, exception_type=kind, dedupe_key=f"{kind}:{uuid.uuid4()}",
                              occurred_at=at(d, 14, 0)))
    db.flush()


#: Rich trading: (hour, weight) of a café's day.
HOUR_WEIGHTS = [(7, 3), (8, 7), (9, 9), (10, 8), (11, 7), (12, 10), (13, 11), (14, 7), (15, 5), (16, 5),
                (17, 6), (18, 8), (19, 9), (20, 7), (21, 4), (22, 2)]


def add_rich(w, seed: int = 7) -> None:
    """A seeded month of a café (more products, cashiers, tips, refunds) for the sample PDFs."""
    db = w.db
    rnd = random.Random(seed)
    cats = {
        "שתייה חמה": [("אספרסו", "9"), ("קפוצ׳ינו", "12"), ("אמריקנו", "11"), ("תה צמחים", "10"), ("שוקו חם", "13")],
        "שתייה קרה": [("מיץ תפוזים סחוט", "16"), ("לימונדה", "14"), ("Coca Cola", "10"), ("אייס קפה", "15")],
        "מאפים": [("קרואסון פיסטוק", "14"), ("קרואסון שקדים", "17"), ("מאפה גבינה", "15"), ("עוגת שמרים", "18")],
        "ארוחות": [("כריך טונה", "34"), ("סלט יווני", "48"), ("שקשוקה", "52"), ("טוסט גבינות", "36"),
                   ("ארוחת בוקר זוגית", "128")],
        "קינוחים": [("עוגת גבינה", "26"), ("בראוניז", "22"), ("פאי תפוחים", "24")],
    }
    products: List[Tuple[Product, float]] = []
    for cname, items in cats.items():
        c = Category(id=uuid.uuid4(), tenant_id=w.tenant.id, name=cname)
        db.add(c)
        db.flush()
        for i, (name, price) in enumerate(items):
            p = Product(id=uuid.uuid4(), tenant_id=w.tenant.id, category_id=c.id, name=name, price=Decimal(price),
                        sku=f"R{len(products) + 1}")
            db.add(p)
            products.append((p, 1.0 / (1 + i * 0.6) * (2.2 if cname.startswith("שתייה") else 1.0)))
    db.flush()
    extra = [PosUser(id=uuid.uuid4(), tenant_id=w.tenant.id, shop_id=w.shop.id, username=f"u{i}", first_name=f, last_name=l,
                     worker_number=str(30 + i), pin_hash="x")
             for i, (f, l) in enumerate((("רוני", "אברהם"), ("נועה", "שמש"), ("אבי", "ביטון")))]
    db.add_all(extra)
    db.flush()
    staff = {w.tills[0].id: [w.dana, extra[0]], w.tills[1].id: [w.yossi, extra[1]], w.other_till.id: [w.michal, extra[2]]}
    weights = [p[1] for p in products]
    for back in range(0, 29):
        day = w.TODAY - timedelta(days=back)
        busy = 1.0 + (0.35 if day.weekday() in (4, 5) else 0.0) + rnd.uniform(-0.15, 0.15)
        for till in (w.tills[0], w.tills[1], w.other_till):
            base = {w.tills[0].id: 26, w.tills[1].id: 18, w.other_till.id: 14}[till.id]
            for hour, weight in HOUR_WEIGHTS:
                n = max(0, int(round(base * busy * weight / 100 * rnd.uniform(0.6, 1.4))))
                for _ in range(n):
                    when = at(day, hour, rnd.randint(0, 59))
                    k = rnd.choice((1, 1, 2, 2, 3, 4))
                    lines = []
                    for p, _w in rnd.choices(products, weights=weights, k=k):
                        disc = "0"
                        if rnd.random() < 0.06:
                            disc = str((Decimal(str(p.price)) * Decimal("0.2")).quantize(Decimal("0.01")))
                        lines.append((p, rnd.choice((1, 1, 1, 2)), disc))
                    method = rnd.choices(("card", "cash", "voucher"), weights=(68, 28, 4))[0]
                    tip = "0"
                    if till.id != w.other_till.id and rnd.random() < 0.25:
                        tip = str(rnd.choice((3, 5, 8, 10, 12)))
                    oth = [(rnd.choice(products)[0], 1)] if rnd.random() < 0.01 else []
                    sale(w, till, when, lines, cashier=rnd.choice(staff[till.id]), method=method, tip=tip,
                         tip_method="card" if tip != "0" and method == "card" else ("cash" if tip != "0" else None), oth=oth)
            if rnd.random() < 0.5:
                p = rnd.choice(products)[0]
                sale(w, till, at(day, rnd.choice((13, 17, 19)), 5), [(p, 1, "0")], cashier=staff[till.id][0],
                     credit_note=True)
    # Today: a cashier refunds more than usual, so the risks say so.
    for i in range(4):
        sale(w, w.tills[1], at(w.TODAY, 18, 10 + i), [(products[12][0], 1, "0")], cashier=extra[1], credit_note=True)
    db.flush()
