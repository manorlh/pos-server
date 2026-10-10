"""
A virtual till: the documents, shift opens and closes, card transmissions, attendance
actions, failed card attempts and heartbeats a real till sends — built with the till's own
arithmetic (pos-android: core/Money.kt, domain/Vat.kt, Cart.kt, RefundMath.kt,
SaleRepository.buildTransaction / recordRefund, OutboxSync.documentPayload, XReport) and
sent to the till endpoints with the till's own machine token.

Everything the till decides is decided here (what was sold, how it was paid, the tip, the
count in the drawer, its own X). Everything derived from it — the X/Z, the reports, VAT
totals, the uniform file — is computed by the server from what arrives.
"""
from __future__ import annotations

import json
import math
import random
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from . import plan as P

UTC = timezone.utc


# ── Money, exactly as the till computes it ────────────────────────────────────

def jround(x: float) -> int:
    """java.lang.Math.round(double): floor(x + 0.5)."""
    return int(math.floor(x + 0.5))


def vat_net(gross: int, rate: float) -> int:
    """domain/Vat.kt: the net of a VAT-inclusive amount, in agorot."""
    return gross if rate <= 0 else jround(gross / (1.0 + rate))


def sh(agorot: Optional[int]) -> Optional[float]:
    return None if agorot is None else round(agorot / 100.0, 2)


def iso(moment: datetime) -> str:
    u = moment.astimezone(UTC)
    return u.strftime("%Y-%m-%dT%H:%M:%S.") + f"{u.microsecond // 1000:03d}Z"


def pct_of(amount: int, pct: int) -> int:
    """Cart.kt: a percentage of an amount in integer agorot (truncated)."""
    return amount * (pct * 100) // 10_000


def collected_per_line(lines: List[dict], document_discount: int) -> Dict[str, int]:
    """RefundMath.collectedPerLine: what each line actually collected after the basket share."""
    after = {l["id"]: l["gross"] - l["disc"] for l in lines}
    line_disc = sum(l["disc"] for l in lines)
    sum_after = sum(after.values())
    basket = min(max(document_discount - line_disc, 0), max(sum_after, 0))
    if basket == 0 or sum_after <= 0:
        return after
    exact = {k: a * basket / sum_after for k, a in after.items()}
    floors = {k: math.floor(e) for k, e in exact.items()}
    leftover = basket - sum(floors.values())
    extra = {}
    for k in sorted(exact, key=lambda k: -(exact[k] - floors[k])):
        if leftover <= 0:
            break
        extra[k] = 1
        leftover -= 1
    return {k: a - floors[k] - extra.get(k, 0) for k, a in after.items()}


def credit_for(collected: int, orig_qty: float, already: float, qty: float) -> int:
    """RefundMath.creditFor: the money for `qty` more units of a line already credited `already`."""
    if qty <= 0 or orig_qty <= 0:
        return 0
    before = min(max(already, 0.0), orig_qty)
    after = min(before + qty, orig_qty)
    share = lambda q: jround(collected * (q / orig_qty))  # noqa: E731
    return share(after) - share(before)


# ── What a till learns from the cloud ─────────────────────────────────────────

@dataclass
class Product:
    id: str
    sku: Optional[str]
    name: str
    price: int  # agorot
    category: str
    weight: float
    happy_hour: bool


@dataclass
class SaleRecord:
    """A sale as the till keeps it, for a later credit note."""
    id: str
    number: str
    method: str  # cash | card | split
    lines: List[dict]
    document_discount: int
    cashier_id: str
    when: datetime
    card_meta: Optional[dict]
    credited: Dict[str, float] = field(default_factory=dict)


@dataclass
class Shift:
    id: str
    business_date: str
    sequence: int
    opened_at: datetime
    opening_cash: int
    opened_by: P.Person
    docs: List[dict] = field(default_factory=list)


class VirtualTill:
    def __init__(self, api, bar: P.Bar, index: int, machine_id: str, token: str, name: str):
        self.api = api
        self.bar = bar
        self.index = index
        self.id = machine_id
        self.token = token
        self.name = name
        self.pos_number: Optional[str] = None
        self.prefix: Optional[str] = None
        self.branch_id: Optional[str] = None
        self.vat_rate = 0.18
        self.dealer_type = "licensed"
        self.products: List[Product] = []
        self.counters: Dict[int, int] = {320: 0, 330: 0, 400: 0}
        #: What this till issues, by the company's "סוג עוסק" (`FiscalDocuments`): a tax invoice-receipt 320
        #: and a credit note 330 — or, for an exempt dealer, a receipt 400 and a receipt refund -400.
        self.sale_type = 320
        self.credit_type = 330
        self.shift_seq = 0
        self.shift: Optional[Shift] = None
        self.outbox: List[dict] = []
        self.sales: List[SaleRecord] = []          # tonight's sales (for credit notes)
        self.card_legs: List[Tuple[str, int]] = []  # (terminal uid, signed charged agorot) since the last batch
        self.batch_no = 0
        self.terminal = P.terminal_number(bar.index, index)
        self.uid_seq = 0
        self.stats = {"pushed": 0, "duplicates": 0}

    # ── the cloud's answers ───────────────────────────────────────────────────

    def learn(self) -> None:
        """What the till reads after pairing: its identity, settings and catalog."""
        me = self.api.till(self.token, "GET", "/machines/me")
        self.pos_number = me.get("posNumber")
        self.prefix = me.get("documentPrefix")
        settings = self.api.till(self.token, "GET", f"/sync/{self.id}/settings")
        merged = settings.get("settings") or {}
        bi = settings.get("businessInfo") or {}
        self.branch_id = bi.get("branchId")
        self.dealer_type = bi.get("dealerType") or merged.get("dealerType") or "company"
        rate = merged.get("globalTaxRate")
        exempt = self.dealer_type == "exempt"
        self.sale_type = 400 if exempt else 320
        self.credit_type = -400 if exempt else 330
        self.vat_rate = 0.0 if self.dealer_type == "exempt" else (float(rate) / 100.0 if rate is not None else 0.18)
        catalog = self.api.till(self.token, "GET", f"/sync/{self.id}/catalog")
        by_name = {it.name: (key, it) for key, _n, _c, items in P.CATEGORIES for it in items}
        self.products = []
        for p in catalog.get("products") or []:
            name = p.get("name") or ""
            if name not in by_name:
                continue  # e.g. the company's "פריט כללי"
            key, item = by_name[name]
            self.products.append(Product(id=str(p["id"]), sku=p.get("sku"), name=name,
                                         price=jround(float(p["price"]) * 100), category=key,
                                         weight=item.weight, happy_hour=item.happy_hour))
        if len(self.products) != len(by_name):
            raise RuntimeError(f"{self.name} sees {len(self.products)} of {len(by_name)} menu products")

    # ── numbering ─────────────────────────────────────────────────────────────

    def next_number(self, doc_type: int) -> str:
        series = 400 if doc_type in (400, -400) else doc_type
        self.counters[series] += 1
        return str(self.counters[series])

    def _uid(self, when: datetime) -> str:
        self.uid_seq += 1
        local = when.astimezone(P_IL)
        return local.strftime("%y%m%d%H%M%S") + f"{self.bar.index}{self.index}{self.uid_seq % 1000:03d}"

    # ── documents ─────────────────────────────────────────────────────────────

    def _card_meta(self, rng: random.Random, when: datetime, leg: int, tip: int = 0) -> Tuple[dict, str, str, str]:
        uid = self._uid(when)
        auth = f"{rng.randint(0, 9_999_999):07d}"
        last4 = f"{rng.randint(0, 9999):04d}"
        brand, acquirer = _pick_brand(rng)
        charged = leg + tip
        result = {"statusCode": 0, "uid": uid, "transactionId": f"{rng.randint(10**8, 10**9 - 1)}",
                  "issuerAuthNum": auth, "cardNumber": "************" + last4, "amount": charged}
        meta = {"vuid": f"{rng.randint(10**11, 10**12 - 1)}", "uid": uid, "authNum": auth, "cardLast4": last4,
                "statusCode": "0", "outcome": "approved", "keyed": "false",
                "result": json.dumps(result, separators=(",", ":"))}
        if tip:
            meta["terminalTip"] = json.dumps({"agorot": tip, "source": "amount_difference", "requestedAgorot": leg,
                                              "chargedAgorot": charged, "replyAmountAgorot": charged, "field": None},
                                             separators=(",", ":"))
            meta["chargedAmount"] = str(charged)
        return meta, brand, acquirer, last4

    def build_sale(self, rng: random.Random, when: datetime, cashier: P.Person, lines_spec: List[Tuple[Product, int]],
                   *, payment: str, happy_hour: bool = False, basket: Optional[Tuple[int, str]] = None,
                   oth: Optional[Tuple[Product, str]] = None, approver: Optional[P.Person] = None,
                   tip_rate: Optional[float] = None, status: str = "completed",
                   number: Optional[str] = None) -> Tuple[dict, SaleRecord]:
        shift = self.shift
        lines = []
        for product, qty in lines_spec:
            gross = product.price * qty
            disc = pct_of(gross, 20) if (happy_hour and product.happy_hour) else 0
            lines.append({"id": str(uuid.uuid4()), "p": product, "qty": qty, "unit": product.price,
                          "gross": gross, "disc": disc, "oth": None})
        if oth is not None:
            product, reason = oth
            lines.append({"id": str(uuid.uuid4()), "p": product, "qty": 1, "unit": product.price,
                          "gross": product.price, "disc": product.price, "oth": reason})
        gross = sum(l["gross"] for l in lines)
        line_disc = sum(l["disc"] for l in lines)
        basket_disc = pct_of(gross - line_disc, basket[0]) if basket else 0
        discount = line_disc + basket_disc
        collected = gross - discount
        net = vat_net(collected, self.vat_rate)
        created = iso(when)
        done = when + timedelta(seconds=rng.randint(12, 45)) if payment != "cash" else when
        payments: List[dict] = []
        tip = 0
        tip_method = None
        tendered = change = None
        doc_meta = None
        card_meta = None
        if status == "completed" and payment == "cash":
            if tip_rate is not None and rng.random() < tip_rate:
                tip, tip_method = rng.choice(P.CASH_TIPS), "cash"
            due = collected + tip
            step = rng.choice([2000, 5000, 10000, 20000])
            tendered = due if rng.random() < 0.3 else ((due + step - 1) // step) * step
            change = tendered - due
            payments.append({"id": str(uuid.uuid4()), "sequence": 1, "method": "cash", "amount": sh(collected),
                             "createdAt": iso(done)})
        elif status == "completed":
            cash_part = 0
            if payment == "split":
                cash_part = min(collected - 500, rng.choice([2000, 5000, 5000, 10000]))
                if cash_part <= 0:
                    cash_part = collected // 2
                payments.append({"id": str(uuid.uuid4()), "sequence": 1, "method": "cash", "amount": sh(cash_part),
                                 "createdAt": iso(when + timedelta(seconds=5))})
            card_leg = collected - cash_part
            if tip_rate is not None and rng.random() < tip_rate:
                pct = rng.choice(P.CARD_TIP_PCTS)
                tip = max(500, jround(card_leg * pct / 100.0 / 100.0) * 100)
                tip_method = "card"
            meta, brand, acquirer, _last4 = self._card_meta(rng, done, card_leg, tip)
            card_meta = meta
            doc_meta = meta
            payments.append({"id": str(uuid.uuid4()), "sequence": len(payments) + 1, "method": "card",
                             "amount": sh(card_leg), "nayaxMeta": meta, "creditPayments": 1,
                             "createdAt": iso(done), "cardBrand": brand, "cardAcquirer": acquirer,
                             "cardIssuer": acquirer})
            self.card_legs.append((meta["uid"], card_leg + tip))
        items = []
        for l in lines:
            item = {"id": l["id"], "productId": l["p"].id, "productName": l["p"].name, "quantity": float(l["qty"]),
                    "unitPrice": sh(l["unit"]), "totalPrice": sh(l["gross"]), "transactionType": 2}
            if l["p"].sku:
                item["sku"] = l["p"].sku
            if l["disc"]:
                item.update({"discount": sh(l["disc"]), "discountType": "fixed", "lineDiscount": -sh(l["disc"])})
            if l["oth"]:
                item.update({"othReason": l["oth"], "othBy": cashier.id,
                             "othApprovedBy": approver.id if approver is not None else None})
            items.append(item)
        doc = {
            "id": str(uuid.uuid4()),
            "transactionNumber": number or self.next_number(self.sale_type),
            "documentPrefix": self.prefix,
            "status": status,
            "documentType": self.sale_type,
            "documentProductionDate": created,
            "paymentMethod": "cash" if payment == "cash" else "card",
            "tipAmount": sh(tip),
            "totalAmount": sh(gross),
            "netAmount": sh(net),
            "vatAmount": sh(collected - net),
            "vatRate": self.vat_rate,
            "cashierId": cashier.id,
            "branchId": self.branch_id,
            "issuedVouchers": [],
            "payments": payments,
            "stockMovements": [],
            "promotions": [],
            "shiftId": shift.id,
            "businessDate": shift.business_date,
            "createdAt": created,
            "updatedAt": iso(done),
            "items": items,
        }
        if tip_method:
            doc["tipPaymentMethod"] = tip_method
        if tendered is not None:
            doc["amountTendered"] = sh(tendered)
            doc["changeAmount"] = sh(change)
        if discount:
            doc["documentDiscount"] = sh(discount)
        if basket_disc:
            doc.update({"basketDiscount": sh(basket_disc), "basketDiscountPercent": float(basket[0]),
                        "basketDiscountKind": basket[1]})
        if doc_meta is not None:
            doc["nayaxMeta"] = doc_meta
        if approver is not None:
            doc["approvedByPosUserId"] = approver.id
        record = SaleRecord(id=doc["id"], number=doc["transactionNumber"], method=payment, lines=lines,
                            document_discount=discount, cashier_id=cashier.id, when=when, card_meta=card_meta,
                            credited={l["id"]: 0.0 for l in lines})
        if status == "completed":
            self.sales.append(record)
        return doc, record

    def refundable(self, when: datetime) -> List[SaleRecord]:
        """Tonight's sales a customer can still bring back: paid by one method, not fully credited."""
        return [s for s in self.sales
                if s.method in ("cash", "card") and s.when < when - timedelta(minutes=4)
                and any(s.credited[l["id"]] < l["qty"] for l in s.lines if not l["oth"])]

    def build_credit_note(self, rng: random.Random, when: datetime, approver: P.Person) -> Optional[dict]:
        """A credit note (330) for part or all of an earlier sale tonight, by its own method."""
        candidates = self.refundable(when)
        if not candidates:
            return None
        orig = rng.choice(candidates)
        remaining = {l["id"]: l["qty"] - orig.credited[l["id"]] for l in orig.lines if not l["oth"]}
        if rng.random() < 0.45:
            quantities = {k: q for k, q in remaining.items() if q > 0}
        else:
            line = rng.choice([l for l in orig.lines if remaining.get(l["id"], 0) > 0])
            quantities = {line["id"]: rng.randint(1, int(remaining[line["id"]]))}
        collected = collected_per_line(orig.lines, orig.document_discount)
        out_lines = []
        for l in orig.lines:
            q = quantities.get(l["id"], 0)
            if q <= 0:
                continue
            gross = jround(l["unit"] * float(q))
            total = credit_for(collected[l["id"]], float(l["qty"]), float(orig.credited[l["id"]]), float(q))
            out_lines.append((l, q, total, gross - total))
            orig.credited[l["id"]] += q
        credited = sum(x[2] for x in out_lines)
        if credited <= 0:
            return None
        net = vat_net(credited, self.vat_rate)
        created = iso(when)
        done = when + timedelta(seconds=rng.randint(10, 40)) if orig.method == "card" else when
        leg = {"id": str(uuid.uuid4()), "sequence": 1, "method": orig.method, "amount": sh(credited),
               "createdAt": iso(done)}
        doc_meta = None
        if orig.method == "card":
            uid = self._uid(done)
            original = json.loads(orig.card_meta["result"]) if orig.card_meta else {}
            doc_meta = {"vuid": f"{rng.randint(10**11, 10**12 - 1)}", "uid": uid,
                        "authNum": f"{rng.randint(0, 9_999_999):07d}",
                        "cardLast4": (orig.card_meta or {}).get("cardLast4", "0000"), "statusCode": "0",
                        "outcome": "approved",
                        "result": json.dumps({"statusCode": 0, "uid": uid, "amount": credited,
                                              "transactionId": f"{rng.randint(10**8, 10**9 - 1)}"},
                                             separators=(",", ":")),
                        "refundOfTransactionId": orig.id,
                        "originalNayaxTransactionId": str(original.get("transactionId", ""))}
            leg.update({"nayaxMeta": doc_meta, "cardBrand": "visa", "cardAcquirer": "cal"})
            self.card_legs.append((uid, -credited))
        doc = {
            "id": str(uuid.uuid4()),
            "transactionNumber": self.next_number(self.credit_type),
            "documentPrefix": self.prefix,
            "status": "completed",
            "documentType": self.credit_type,
            "documentProductionDate": created,
            "paymentMethod": orig.method,
            "amountTendered": sh(credited),
            "changeAmount": 0.0,
            "tipAmount": 0.0,
            "totalAmount": sh(credited),
            "netAmount": sh(net),
            "vatAmount": sh(credited - net),
            "vatRate": self.vat_rate,
            # The till names the original sale's cashier on its credit note (DetailViewModel).
            "cashierId": orig.cashier_id,
            "branchId": self.branch_id,
            "refundOfTransactionId": orig.id,
            "approvedByPosUserId": approver.id,
            "issuedVouchers": [],
            "payments": [leg],
            "stockMovements": [],
            "promotions": [],
            "shiftId": self.shift.id,
            "businessDate": self.shift.business_date,
            "createdAt": created,
            "updatedAt": iso(done),
            "items": [{
                "id": str(uuid.uuid4()), "productId": l["p"].id, "productName": l["p"].name,
                "quantity": float(q), "unitPrice": sh(l["unit"]), "totalPrice": sh(total),
                "transactionType": 2, "refundOfItemId": l["id"],
                **({"sku": l["p"].sku} if l["p"].sku else {}),
                **({"discount": sh(share), "discountType": "fixed", "lineDiscount": -sh(share)} if share else {}),
            } for (l, q, total, share) in out_lines],
        }
        if doc_meta is not None:
            doc["nayaxMeta"] = doc_meta
        return doc

    # ── the outbox ────────────────────────────────────────────────────────────

    def queue(self, doc: dict) -> None:
        self.outbox.append(doc)
        if doc["status"] != "cancelled":
            self.shift.docs.append(doc)

    def push(self) -> None:
        """OutboxSync: everything waiting, oldest first; every one must be accepted."""
        if not self.outbox:
            return
        batch, self.outbox = self.outbox, []
        out = self.api.till(self.token, "POST", f"/sync/{self.id}/transactions", {"transactions": batch})
        for r in out.get("results") or []:
            if r.get("status") == "duplicate":
                self.stats["duplicates"] += 1
            elif r.get("status") != "accepted":
                raise RuntimeError(f"{self.name}: document {r.get('id')} {r.get('status')}: {r.get('reason')}")
            if r.get("warnings"):
                raise RuntimeError(f"{self.name}: document {r.get('id')} stored with warnings {r.get('warnings')}")
        if out.get("unidentified"):
            raise RuntimeError(f"{self.name}: unidentified documents {out['unidentified']}")
        self.stats["pushed"] += len(batch)

    def heartbeat(self) -> dict:
        body = {"appVersion": "demo-virtual-till", "pendingCount": 0, "pendingDocuments": 0,
                "realtimeConnected": True, "clockSkewMs": 0,
                "documentCounters": {str(k): v for k, v in self.counters.items()}}
        if self.shift is not None:
            body.update({"openShiftId": self.shift.id, "openShiftOpenedAt": iso(self.shift.opened_at),
                         "openShiftSequence": self.shift.sequence})
        return self.api.till(self.token, "POST", "/machines/me/heartbeat", body)

    # ── shifts ────────────────────────────────────────────────────────────────

    def open_shift(self, when: datetime, business_date: str, person: P.Person) -> Shift:
        self.shift_seq += 1
        shift = Shift(id=str(uuid.uuid4()), business_date=business_date, sequence=self.shift_seq, opened_at=when,
                      opening_cash=self.bar.opening_cash, opened_by=person)
        self.api.till(self.token, "POST", f"/sync/{self.id}/shifts", {
            "id": shift.id, "businessDate": business_date, "sequenceNumber": shift.sequence,
            "openedAt": iso(when), "openingCash": sh(shift.opening_cash),
            "openedByUserId": person.id, "openedByName": person.name})
        self.shift = shift
        return shift

    def till_x(self) -> dict:
        """XReport: the till's own figures over the shift's documents."""
        docs = self.shift.docs
        sales = [d for d in docs if d["documentType"] in (320, 400)]
        credits = [d for d in docs if d["documentType"] in (330, -400)]
        a = lambda v: jround((v or 0) * 100)  # noqa: E731

        def legs(d, method):
            return sum(a(p["amount"]) for p in d["payments"] if p["method"] == method)

        cash = sum(legs(d, "cash") for d in sales) - sum(legs(d, "cash") for d in credits)
        card = sum(legs(d, "card") for d in sales) - sum(legs(d, "card") for d in credits)
        tips = sum(a(d["tipAmount"]) for d in docs)
        cash_tips = sum(a(d["tipAmount"]) for d in docs if d.get("tipPaymentMethod") == "cash")
        card_tips = sum(a(d["tipAmount"]) for d in docs if d.get("tipPaymentMethod") == "card")
        expected = self.shift.opening_cash + cash + cash_tips
        return {
            "openingCash": sh(self.shift.opening_cash),
            "expectedCash": sh(expected),
            "totalSales": sh(sum(a(d["totalAmount"]) for d in sales)),
            "totalDiscounts": sh(sum(a(d.get("documentDiscount")) for d in sales)),
            "totalRefunds": sh(sum(a(d["totalAmount"]) for d in credits)),
            "totalCash": sh(cash),
            "totalCard": sh(card),
            "totalTips": sh(tips),
            "totalCashTips": sh(cash_tips),
            "totalCardTips": sh(card_tips),
            "vatTotal": sh(sum(a(d["vatAmount"]) for d in sales) - sum(a(d["vatAmount"]) for d in credits)),
            "transactionsCount": len(sales) + len(credits),
            "itemsCount": sum(int(i["quantity"]) for d in sales for i in d["items"]),
            "_expected": expected,
        }

    def close_shift(self, when: datetime, person: P.Person, variance: int) -> dict:
        """The count and the close. The cloud must accept it and agree with the till's X."""
        self.push()
        x = self.till_x()
        expected = x.pop("_expected")
        body = {
            "closedAt": iso(when), "closedByUserId": person.id, "closedByName": person.name, "unattended": False,
            "countedCash": sh(expected + variance), "expectedCash": sh(expected),
            "transactionIds": [d["id"] for d in self.shift.docs],
            "lastTransactionNumber": str(max(self.counters.values())),
            "till": x,
            "businessDate": self.shift.business_date, "sequenceNumber": self.shift.sequence,
            "openedAt": iso(self.shift.opened_at), "openingCash": sh(self.shift.opening_cash),
            "openedByUserId": self.shift.opened_by.id, "openedByName": self.shift.opened_by.name,
        }
        out = self.api.till(self.token, "POST", f"/sync/{self.id}/shifts/{self.shift.id}/close", body)
        if out.get("status") != "accepted":
            raise RuntimeError(f"{self.name}: shift close {self.shift.id} answered {out}")
        if out.get("totalsMismatch"):
            raise RuntimeError(f"{self.name}: the cloud's X disagrees with the till's: till={x} cloud={out.get('serverTotals')}")
        closed = self.shift
        self.shift = None
        return {"shift": closed, "answer": out, "till": x, "variance": variance}

    # ── around the documents ──────────────────────────────────────────────────

    def transmit(self, rng: random.Random, when: datetime, fail_first: bool) -> List[dict]:
        """The terminal's batch (שידור) for everything charged since the last one."""
        sent = []
        if fail_first:
            body = {"id": str(uuid.uuid4()), "trigger": "daily", "startedAt": iso(when),
                    "finishedAt": iso(when + timedelta(seconds=35)), "status": "failed", "statusCode": 3,
                    "statusMessage": "אין תקשורת לשב״א", "terminalTransactionIds": []}
            sent.append(self.api.till(self.token, "POST", f"/sync/{self.id}/transmissions", body))
            when = when + timedelta(minutes=rng.randint(4, 9))
        if not self.card_legs and not fail_first:
            return sent
        self.batch_no += 1
        uids = [u for u, _ in self.card_legs]
        amount = sum(v for _, v in self.card_legs)
        body = {"id": str(uuid.uuid4()), "trigger": "daily", "startedAt": iso(when),
                "finishedAt": iso(when + timedelta(seconds=rng.randint(20, 50))), "status": "success",
                "statusCode": 0, "batchNumber": f"{self.batch_no:03d}", "transactionCount": len(uids),
                "amount": sh(amount), "terminalTransactionIds": uids,
                "reportText": f"מסוף {self.terminal} · שידור {self.batch_no:03d} · {len(uids)} עסקאות",
                "assumedTerminalTransactionIds": []}
        sent.append(self.api.till(self.token, "POST", f"/sync/{self.id}/transmissions", body))
        self.card_legs = []
        return sent

    def failed_payment(self, when: datetime, cashier: P.Person, doc: dict, outcome: str, rng: random.Random) -> dict:
        reasons = {"declined": ("4", "העסקה נדחתה על ידי חברת האשראי"),
                   "cancelled_cashier": ("cashier", "בוטלה על ידי הקופאי"),
                   "no_answer": ("timeout", "אין תשובה מהמסוף — לא חויב")}
        code, message = reasons[outcome]
        brand, _acq = _pick_brand(rng)
        amount = jround(doc["totalAmount"] * 100) - jround((doc.get("documentDiscount") or 0) * 100)
        body = {"id": str(uuid.uuid4()), "occurredAt": iso(when), "resolvedAt": iso(when + timedelta(seconds=30)),
                "shiftId": self.shift.id, "businessDate": self.shift.business_date, "posUserId": cashier.id,
                "employeeName": cashier.name, "amountAgorot": amount, "method": "card", "kind": "sale",
                "channel": "till", "terminalType": "nayax_lan", "terminalId": self.terminal, "outcome": outcome,
                "reasonCode": code, "reasonMessage": message, "cardBrand": brand,
                "cardLast4": f"{rng.randint(0, 9999):04d}", "lineCount": len(doc["items"]),
                "vuid": f"{rng.randint(10**11, 10**12 - 1)}", "transactionId": doc["id"],
                "updatedAt": iso(when + timedelta(seconds=30))}
        self.api.till(self.token, "POST", f"/sync/{self.id}/failed-payments", body)
        return body

    def failed_payment_paid(self, attempt: dict, paid_doc: dict, method: str, when: datetime) -> None:
        body = {**attempt, "paidByTransactionId": paid_doc["id"], "paidByMethod": method,
                "paidAt": iso(when), "updatedAt": iso(when)}
        self.api.till(self.token, "POST", f"/sync/{self.id}/failed-payments", body)

    def event(self, when: datetime, kind: str, person: P.Person, amount: int, details: dict) -> None:
        body = {"id": str(uuid.uuid4()), "type": kind, "occurredAt": iso(when), "shiftId": self.shift.id,
                "posUserId": person.id, "amount": sh(amount), "details": details}
        self.api.till(self.token, "POST", f"/sync/{self.id}/events", body)

    def attendance(self, when: datetime, kind: str, person: P.Person, att_shift: dict,
                   break_id: Optional[str] = None, break_started: Optional[datetime] = None) -> None:
        body = {"id": str(uuid.uuid4()), "type": kind, "posUserId": person.id, "shiftId": att_shift["id"],
                "at": iso(when), "sentAt": iso(when + timedelta(seconds=2))}
        if kind != "clock_in":
            body.update({"shiftClockInAt": iso(att_shift["at"]), "shiftClockInMachineId": att_shift["machine"]})
        if break_id:
            body["breakId"] = break_id
        if break_started is not None:
            body["breakStartedAt"] = iso(break_started)
        self.api.till(self.token, "POST", f"/sync/{self.id}/attendance/actions", body)

    def elevate(self, approver: P.Person, scope: str) -> dict:
        """A manager's code at the till: the grant the approval on the document stands for."""
        out = self.api.till(self.token, "POST", "/elevation/sessions",
                            {"posUserId": approver.id, "pin": approver.pin, "scopes": [scope]})
        if str(out.get("approverPosUserId")) != str(approver.id):
            raise RuntimeError(f"elevation answered for {out.get('approverPosUserId')}, asked {approver.id}")
        return out


P_IL = None  # set by `use_timezone`


def use_timezone(tz) -> None:
    global P_IL
    P_IL = tz


def _pick_brand(rng: random.Random) -> Tuple[str, str]:
    r = rng.random()
    acc = 0.0
    for brand, acquirer, w in P.CARD_BRANDS:
        acc += w
        if r <= acc:
            return brand, acquirer
    return P.CARD_BRANDS[-1][0], P.CARD_BRANDS[-1][1]
