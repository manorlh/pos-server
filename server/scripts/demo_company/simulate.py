"""
The month: every night of every bar, in the order it happened.

Each bar-night is a set of timed actions — clock-ins, shift opens, sales, credit notes,
failed card attempts, voids, pushes, heartbeats, closes, the terminal's batch, clock-outs,
and the Z (each bar's own, or — in shop mode — the branch's one). All bars' actions run on one
queue in time order, and the clock is set to
each action's moment before it runs, so every "now" the product reads is that moment.

Every random choice of a till comes from that till's own generator for that night, so the
month is the same whatever order the bars' actions interleave in.
"""
from __future__ import annotations

import heapq
import itertools
import random
import zlib
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Callable, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from . import plan as P
from .till import VirtualTill

IL = ZoneInfo(P.TIMEZONE)


def at(day: date, hh: int, mm: int, plus_days: int = 0, sec: int = 0) -> datetime:
    return datetime.combine(day + timedelta(days=plus_days), time(hh, mm, sec), tzinfo=IL)


class Queue:
    def __init__(self):
        self._heap: List[Tuple[datetime, int, Callable]] = []
        self._seq = itertools.count()

    def add(self, when: datetime, fn: Callable) -> None:
        heapq.heappush(self._heap, (when, next(self._seq), fn))

    def run(self, clock) -> int:
        n = 0
        while self._heap:
            when, _s, fn = heapq.heappop(self._heap)
            clock.set(when)
            fn(when)
            n += 1
        return n


@dataclass
class TillNight:
    till: VirtualTill
    rng: random.Random
    staff: List[Tuple[P.Person, float]]   # who rings sales on it, with weights
    operator: P.Person                     # who opened the current shift
    next_operator: Optional[P.Person] = None


@dataclass
class Ledger:
    """What happened, for the run's log and the verification's expectations."""
    zs: List[dict] = field(default_factory=list)
    closes: List[dict] = field(default_factory=list)
    counts: Dict[str, int] = field(default_factory=lambda: {
        "sales": 0, "credit_notes": 0, "cancelled": 0, "failed_attempts": 0, "line_voids": 0,
        "basket_cancels": 0, "approvals": 0, "oth": 0, "transmissions": 0, "attendance": 0,
        "heartbeats": 0, "elevations": 0})


def _seed(*parts) -> int:
    return zlib.crc32("|".join(str(p) for p in parts).encode()) ^ P.RNG_SEED


def _weighted(rng: random.Random, pairs):
    total = sum(w for _x, w in pairs)
    r = rng.random() * total
    acc = 0.0
    for x, w in pairs:
        acc += w
        if r <= acc:
            return x
    return pairs[-1][0]


Z_MODES = ("area", "shop")


class Month:
    """
    `z_mode` — who the Zs are for:

    * `area` (default): each bar's own Z at the end of its night (`POST /z-runs` with its `areaId`
      and its two tills) — one Z per bar per night.
    * `shop` ("Z סניפי"): every till closes its shift, and then ONE Z for the whole branch is
      produced, as the dashboard's Z wizard does it (the candidates, then `POST /z-runs` with every
      till that has something to report and no `areaId`) — one Z per shop per business night.

    Nothing else differs: the documents, shifts, closes, tips and cancellations of a night are
    drawn from the same per-till generators in both modes.
    """

    def __init__(self, api, world, clock, log, z_mode: str = "area"):
        if z_mode not in Z_MODES:
            raise ValueError(f"z_mode must be one of {Z_MODES}, not {z_mode!r}")
        self.api = api
        self.world = world
        self.clock = clock
        self.log = log
        self.z_mode = z_mode
        self.ledger = Ledger()
        self.q = Queue()
        self.last_beat: Dict[str, datetime] = {}

    # ── one bar, one night ────────────────────────────────────────────────────

    def plan_bar_night(self, bar: P.Bar, day: date) -> None:
        w = self.world
        rng = random.Random(_seed("roster", bar.index, day.isoformat()))
        people = w.bar_people(bar.index)
        sm = next(p for p in people if p.job == P.JOB_SHIFT_MANAGER)
        bartenders = [p for p in people if p.job == P.JOB_BARTENDER]
        waiters = [p for p in people if p.job == P.JOB_WAITER]
        weekend = day.weekday() in P.WEEKEND
        k = day.toordinal()
        if weekend:
            b1, b2, b3 = bartenders[k % 3], bartenders[(k + 1) % 3], bartenders[(k + 2) % 3]
            w1, w2 = waiters[k % 2], waiters[(k + 1) % 2]
            roster = [sm, b1, b2, b3, w1, w2]
        else:
            b1, b2, b3 = bartenders[k % 3], bartenders[(k + 1) % 3], None
            w1 = w2 = waiters[k % 2]
            roster = [sm, b1, b2, w1]
        manager = None
        if day.weekday() in (P.THU, P.FRI) and bar.index in (1, 3):
            manager = w.person("manager-1" if bar.index == 1 else "manager-2")
            roster.append(manager)
        approvers = [sm] + ([manager] if manager else [])

        (oh, om), (ch, cm) = P.opening_hours(day)
        open_at = at(day, oh, om)
        close_at = at(day, ch, cm, plus_days=1)
        t1, t2 = w.bar_tills(bar.index)
        nights = {
            t1.id: TillNight(t1, random.Random(_seed("till", t1.id, day.isoformat())),
                             [(b1, 0.55), (sm, 0.15), (w1, 0.30)], operator=b1, next_operator=b3),
            t2.id: TillNight(t2, random.Random(_seed("till", t2.id, day.isoformat())),
                             [(b2, 0.60), (w2, 0.40)], operator=b2),
        }
        for tn in nights.values():
            tn.till.sales = []

        # Attendance: everyone on the roster clocks in at till 1 and out after closing.
        att_rng = random.Random(_seed("attendance", bar.index, day.isoformat()))
        for person in roster:
            cin = open_at - timedelta(minutes=att_rng.randint(5, 32))
            cout = close_at + timedelta(minutes=att_rng.randint(8, 35))
            shift = {"id": None, "at": cin, "machine": t1.id}
            self.q.add(cin, self._attendance(t1, "clock_in", person, shift))
            if weekend and att_rng.random() < 0.45:
                b_at = at(day, 21, 30) + timedelta(minutes=att_rng.randint(0, 120))
                b_len = timedelta(minutes=att_rng.randint(15, 30))
                brk = {"id": None, "at": b_at}
                self.q.add(b_at, self._attendance(t1, "break_start", person, shift, brk))
                self.q.add(b_at + b_len, self._attendance(t1, "break_end", person, shift, brk))
            self.q.add(cout, self._attendance(t1, "clock_out", person, shift))

        factor = (P.BASE_DOCS_PER_TILL * P.WEEKDAY_FACTOR[day.weekday()] * bar.volume
                  * P.HOLIDAY_BOOST.get(day, 1.0))
        span = (close_at - open_at).total_seconds()
        for tn in nights.values():
            till, trng = tn.till, tn.rng
            share = 1.0 if till.index == 1 else 0.85
            n_sales = max(8, int(round(factor * share * trng.uniform(0.88, 1.12))))
            opened = open_at - timedelta(minutes=trng.randint(1, 8))
            self.q.add(opened + timedelta(seconds=60), self._heartbeat(till))
            self.q.add(opened, self._open(tn, day, tn.operator))
            for _ in range(n_sales):
                offset = trng.triangular(120, span - 600, span * 0.42)
                self.q.add(open_at + timedelta(seconds=int(offset)), self._sale(tn, day, approvers))
            for _ in range(sum(1 for _ in range(n_sales) if trng.random() < P.REFUND_RATE)):
                offset = trng.uniform(span * 0.3, span - 900)
                self.q.add(open_at + timedelta(seconds=int(offset)), self._credit(tn, approvers))
            for _ in range(sum(1 for _ in range(n_sales) if trng.random() < P.FAILED_CARD_RATE)):
                offset = trng.uniform(1800, span - 1200)
                self.q.add(open_at + timedelta(seconds=int(offset)), self._failed_card(tn, day))
            for _ in range(trng.randint(*P.LINE_VOID_PER_TILL_NIGHT)):
                self.q.add(open_at + timedelta(seconds=int(trng.uniform(600, span - 900))), self._void(tn, "line_void"))
            for _ in range(trng.randint(*P.BASKET_CANCEL_PER_TILL_NIGHT)):
                self.q.add(open_at + timedelta(seconds=int(trng.uniform(600, span - 900))), self._void(tn, "basket_cancel"))
            # The outbox: every half hour.
            t = opened + timedelta(minutes=30 + till.index * 2)
            while t < close_at:
                self.q.add(t, self._push(till))
                t += timedelta(minutes=30)
            # A weekend shift handover on till 1.
            if weekend and till.index == 1 and tn.next_operator is not None:
                handover = at(day, 23, 30) + timedelta(minutes=trng.randint(-6, 6))
                self.q.add(handover, self._handover(tn, day))
            closing = close_at + timedelta(minutes=trng.randint(2, 6) + 3 * (till.index - 1))
            self.q.add(closing, self._close(tn, bar, day))
            self.q.add(closing + timedelta(minutes=2), self._heartbeat(till))
            self.q.add(closing + timedelta(minutes=trng.randint(3, 6)), self._transmit(tn))
        if self.z_mode == "area":
            z_at = close_at + timedelta(minutes=rng.randint(24, 40))
            for till in (t1, t2):
                self.q.add(z_at - timedelta(seconds=45), self._heartbeat(till))
            self.q.add(z_at, self._z(bar, day))
        # shop mode: the night's one Z is planned once for all bars (`plan_shop_z`).

    def plan_shop_z(self, bars: List[P.Bar], day: date) -> None:
        """The branch's one Z of the night, after the last till has closed and transmitted."""
        _open, (ch, cm) = P.opening_hours(day)
        close_at = at(day, ch, cm, plus_days=1)
        rng = random.Random(_seed("shop-z", day.isoformat()))
        z_at = close_at + timedelta(minutes=rng.randint(24, 40))
        tills = [t for bar in bars for t in self.world.bar_tills(bar.index)]
        for till in tills:
            self.q.add(z_at - timedelta(seconds=45), self._heartbeat(till))
        self.q.add(z_at, self._shop_z(bars, tills, day))

    # ── the actions ───────────────────────────────────────────────────────────

    def _heartbeat(self, till: VirtualTill):
        def run(when):
            till.heartbeat()
            self.last_beat[till.id] = when
            self.ledger.counts["heartbeats"] += 1
        return run

    def _push(self, till: VirtualTill):
        """The outbox, every half hour. A real till also beats every 2 minutes; the cloud keeps
        only the latest beat, so the virtual till beats when it matters: at the shift's open,
        after its close and just before the bar's Z (`plan_bar_night`)."""
        def run(when):
            till.push()
        return run

    def _open(self, tn: TillNight, day: date, person: P.Person):
        def run(when):
            tn.till.open_shift(when, day.isoformat(), person)
            tn.operator = person
        return run

    def _staff(self, tn: TillNight) -> List[Tuple[P.Person, float]]:
        if tn.till.index == 1 and tn.next_operator is not None and tn.operator is tn.next_operator:
            return [(tn.next_operator if p is tn.staff[0][0] else p, wt) for p, wt in tn.staff]
        return tn.staff

    def _basket(self, tn: TillNight) -> List:
        rng, till, bar = tn.rng, tn.till, tn.till.bar
        n_lines = _weighted(rng, [(1, 30), (2, 30), (3, 20), (4, 12), (5, 8)])
        cats = [(key, P.CATEGORY_WEIGHT[key] * bar.taste.get(key, 1.0)) for key, *_ in P.CATEGORIES]
        chosen: Dict[str, int] = {}
        products = {p.name: p for p in till.products}
        for _ in range(n_lines):
            key = _weighted(rng, cats)
            pool = [(p, p.weight) for p in till.products if p.category == key]
            product = _weighted(rng, pool)
            qty = 1 if product.price >= 15000 else _weighted(rng, [(1, 75), (2, 20), (3, 5)])
            chosen[product.name] = chosen.get(product.name, 0) + qty
        return [(products[name], qty) for name, qty in chosen.items()]

    def _sale(self, tn: TillNight, day: date, approvers: List[P.Person]):
        def run(when):
            till, rng = tn.till, tn.rng
            if till.shift is None:  # mid-handover: the customer waits a minute
                self.q.add(when + timedelta(minutes=2), self._sale(tn, day, approvers))
                return
            cashier = _weighted(rng, self._staff(tn))
            lines = self._basket(tn)
            r = rng.random()
            payment = "cash" if r < P.PAY_CASH else ("card" if r < P.PAY_CASH + P.PAY_CARD else "split")
            gross = sum(p.price * q for p, q in lines)
            if payment == "split" and gross < 6000:
                payment = "card"
            local = when.astimezone(IL)
            happy = local.hour < 20 or (local.hour == 20 and local.minute < 30)
            basket = None
            oth = None
            approver = None
            x = rng.random()
            if x < P.STAFF_MEAL_RATE:
                basket, approver = (50, "staff"), rng.choice(approvers)
            elif x < P.STAFF_MEAL_RATE + P.BASKET_DISCOUNT_RATE:
                basket = (10, "manual") if rng.random() < 0.7 else (15, "manual")
                if basket[0] >= 15:
                    approver = rng.choice(approvers)
            if rng.random() < P.OTH_RATE:
                chaser = rng.choice([p for p in till.products if p.name in P.ON_THE_HOUSE_ITEMS])
                oth = (chaser, rng.choice(P.OTH_REASONS))
                approver = approver or rng.choice(approvers)
            if approver is not None:
                till.elevate(approver, "discount")
                self.ledger.counts["elevations"] += 1
                self.ledger.counts["approvals"] += 1
            tip_rate = {"cash": P.CASH_TIP_RATE, "card": P.CARD_TIP_RATE, "split": P.SPLIT_TIP_RATE}[payment]
            doc, _rec = till.build_sale(rng, when, cashier, lines, payment=payment, happy_hour=happy, basket=basket,
                                        oth=oth, approver=approver, tip_rate=tip_rate)
            till.queue(doc)
            self.ledger.counts["sales"] += 1
            self.ledger.counts["oth"] += 1 if oth else 0
        return run

    def _credit(self, tn: TillNight, approvers: List[P.Person]):
        def run(when):
            till, rng = tn.till, tn.rng
            if till.shift is None:
                self.q.add(when + timedelta(minutes=3), self._credit(tn, approvers))
                return
            if not till.refundable(when):
                return
            approver = rng.choice(approvers)
            # The till asks for the manager's grant before it issues the credit note.
            till.elevate(approver, "refund")
            self.ledger.counts["elevations"] += 1
            doc = till.build_credit_note(rng, when, approver)
            if doc is not None:
                till.queue(doc)
                self.ledger.counts["credit_notes"] += 1
        return run

    def _failed_card(self, tn: TillNight, day: date):
        def run(when):
            till, rng = tn.till, tn.rng
            if till.shift is None:
                self.q.add(when + timedelta(minutes=2), self._failed_card(tn, day))
                return
            cashier = _weighted(rng, self._staff(tn))
            lines = self._basket(tn)
            doc, _rec = till.build_sale(rng, when, cashier, lines, payment="card", status="cancelled")
            till.queue(doc)  # the burned number, pushed as a cancelled document
            outcome = _weighted(rng, [("declined", 0.6), ("cancelled_cashier", 0.2), ("no_answer", 0.2)])
            attempt = till.failed_payment(when, cashier, doc, outcome, rng)
            self.ledger.counts["cancelled"] += 1
            self.ledger.counts["failed_attempts"] += 1
            paid_at = when + timedelta(seconds=rng.randint(70, 160))
            method = "cash" if rng.random() < 0.5 else "card"

            def pay(when2):
                if till.shift is None:
                    return
                paid, _r = till.build_sale(rng, when2, cashier, lines, payment=method,
                                           tip_rate={"cash": P.CASH_TIP_RATE, "card": P.CARD_TIP_RATE}[method])
                till.queue(paid)
                self.ledger.counts["sales"] += 1
                self.q.add(when2 + timedelta(seconds=40),
                           lambda w3: till.failed_payment_paid(attempt, paid, method, w3))
            self.q.add(paid_at, pay)
        return run

    def _void(self, tn: TillNight, kind: str):
        def run(when):
            till, rng = tn.till, tn.rng
            if till.shift is None:
                return
            person = _weighted(rng, self._staff(tn))
            lines = self._basket(tn)
            if kind == "line_void":
                product, qty = lines[0]
                till.event(when, "line_void", person, product.price * qty,
                           {"productName": product.name, "quantity": qty, "reason": "טעות בהקלדה"})
                self.ledger.counts["line_voids"] += 1
            else:
                till.event(when, "basket_cancel", person, sum(p.price * q for p, q in lines),
                           {"lineCount": len(lines), "reason": "הלקוח ויתר"})
                self.ledger.counts["basket_cancels"] += 1
        return run

    def _variance(self, rng: random.Random) -> int:
        r = rng.random()
        if r < 0.75:
            return 0
        sign = -1 if rng.random() < 0.6 else 1
        return sign * (rng.randint(100, 1000) if r < 0.9 else rng.randint(1000, 3000))

    def _handover(self, tn: TillNight, day: date):
        def run(when):
            till = tn.till
            closed = till.close_shift(when, tn.operator, self._variance(tn.rng))
            self.ledger.closes.append({"till": till.id, "bar": till.bar.index, "day": day.isoformat(), **_close_row(closed)})
            self.q.add(when + timedelta(minutes=1), self._open(tn, day, tn.next_operator))
        return run

    def _close(self, tn: TillNight, bar: P.Bar, day: date):
        def run(when):
            till = tn.till
            if till.shift is None:
                self.q.add(when + timedelta(minutes=1), self._close(tn, bar, day))
                return
            closed = till.close_shift(when, tn.operator, self._variance(tn.rng))
            self.ledger.closes.append({"till": till.id, "bar": bar.index, "day": day.isoformat(), **_close_row(closed)})
        return run

    def _transmit(self, tn: TillNight):
        def run(when):
            fail = tn.rng.random() < P.TRANSMISSION_FIRST_FAILS
            sent = tn.till.transmit(tn.rng, when, fail)
            self.ledger.counts["transmissions"] += len(sent)
        return run

    def _attendance(self, till: VirtualTill, kind: str, person: P.Person, shift: dict, brk: Optional[dict] = None):
        import uuid as _uuid

        def run(when):
            if kind == "clock_in":
                shift["id"] = str(_uuid.uuid4())
                shift["at"] = when
            if brk is not None and kind == "break_start":
                brk["id"] = str(_uuid.uuid4())
                brk["at"] = when
            till.attendance(when, kind, person, shift, break_id=brk["id"] if brk else None,
                            break_started=brk["at"] if (brk and kind == "break_end") else None)
            self.ledger.counts["attendance"] += 1
        return run

    def _z(self, bar: P.Bar, day: date):
        def run(when):
            tills = self.world.bar_tills(bar.index)
            out = self.api.admin("POST", "/z-runs", {
                "shopId": self.world.shop_id, "areaId": self.world.areas[bar.index],
                "businessDate": day.isoformat(), "machines": [{"machineId": t.id} for t in tills]})
            if out.get("status") != "completed" or not out.get("zReportId"):
                raise RuntimeError(f"{bar.name} {day}: Z run {out.get('id')} is {out.get('status')}: {out}")
            self.ledger.zs.append({"bar": bar.index, "day": day.isoformat(), "runId": out["id"],
                                   "zReportId": out["zReportId"], "at": when.isoformat()})
        return run

    def _shop_z(self, bars: List[P.Bar], tills: List[VirtualTill], day: date):
        """The Z wizard for the whole branch: ask for the candidates, send every till that has a
        shift to report (no area), and expect the Z built at once, numbered by the shop's counter."""
        def run(when):
            shop_id = self.world.shop_id
            cands = self.api.admin("GET", f"/shops/{shop_id}/z-candidates")
            by_id = {str(m["machineId"]): m for m in cands["machines"]}
            reporting = [m for m in cands["machines"] if m.get("openShift") or m.get("closedShifts")]
            open_now = [m["machineName"] for m in reporting if m.get("openShift")]
            if open_now:
                raise RuntimeError(f"{day}: shop Z asked while a shift is still open on {open_now}")
            want = {t.id for t in tills}
            have = {str(m["machineId"]) for m in reporting}
            if have != want:
                raise RuntimeError(f"{day}: tills with shifts awaiting the shop Z {sorted(have)} "
                                   f"differ from the tills of the bars that traded {sorted(want)}")
            if cands.get("zScope") != "shop" or any(by_id[t.id].get("zMode") != "cloud" for t in tills):
                raise RuntimeError(f"{day}: the shop is not in shop-Z mode: {cands.get('zScope')}")
            out = self.api.admin("POST", "/z-runs", {
                "shopId": shop_id, "businessDate": day.isoformat(),
                "machines": [{"machineId": t.id} for t in tills]})
            if out.get("status") != "completed" or not out.get("zReportId"):
                raise RuntimeError(f"{day}: shop Z run {out.get('id')} is {out.get('status')}: {out}")
            if out.get("areaId") is not None:
                raise RuntimeError(f"{day}: the shop Z run carries an area: {out.get('areaId')}")
            self.ledger.zs.append({"shop": True, "bars": [b.index for b in bars], "tills": len(tills),
                                   "day": day.isoformat(), "runId": out["id"], "zReportId": out["zReportId"],
                                   "zNumber": out.get("zNumber"), "at": when.isoformat()})
        return run

    # ── the month ─────────────────────────────────────────────────────────────

    def run(self, days: Optional[List[date]] = None) -> Ledger:
        d = P.MONTH_FIRST
        while d <= P.MONTH_LAST:
            if days is None or d in days:
                open_bars = [bar for bar in P.BARS if d in P.nights(bar)]
                for bar in open_bars:
                    self.plan_bar_night(bar, d)
                if self.z_mode == "shop" and open_bars:
                    self.plan_shop_z(open_bars, d)
                n = self.q.run(self.clock)
                docs = sum(t.stats["pushed"] for t in self.world.tills)
                self.log(f"{d.isoformat()} ({d.strftime('%a')}): bars {[b.index for b in open_bars]} "
                         f"actions {n} · documents so far {docs} · Zs {len(self.ledger.zs)} · calls {self.api.calls}")
            d += timedelta(days=1)
        return self.ledger


def _close_row(closed: dict) -> dict:
    answer = closed["answer"]
    return {"shiftId": closed["shift"].id, "variance": closed["variance"],
            "documents": len(closed["shift"].docs), "totalsMismatch": answer.get("totalsMismatch")}
