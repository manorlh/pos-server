"""
"כרטיס שולחן" in the dashboard's live view (P:/specs/live-tables-cloud.md §2): what the table holds — its
lines by diner and course with what the kitchen got of each, when and in which round; its payments
(parts paid, payments given back) and the balance; who opened it, its waiter and its times; the next
course and when it goes; its history — and the pure pieces the dashboard's actions share with it
(app/services/table_actions.py): the sent rounds as the till's reprint picker lists them, what a reprint
or a rush prints, and a merge of orders.

Everything here reads the order as the till stores it (TableCartCodec / HeldSaleCodec in `cart_json`,
TableExtras in `extras_json` — app/services/course_auto_fire.py parses both) and follows the till's own
rules, ported:

* **The rounds** — `TableReprint.rounds` (pos-android domain/TableReprint.kt, #65): the send log's rounds
  (`log`), each with what the kitchen still has of it, oldest first; what the log does not cover is a round
  of its own by when it went (`at:<time>`), else "לפני כן" (`earlier`). A line sent "בלי בון" (`"s": true`)
  is never in them (P:/specs/courses-fire-v2.md §6): the kitchen never had it on paper.
* **A reprint** — `TableReprint.plan` / `ticketLines`: the chosen quantities of the lines, each with its
  current note and how it is made (a meal by its components), as "כל מה שנשלח" prints them. A rush ("זרז")
  is every round's (courses-fire-v2 §3: by the rounds kept in the order, so a course sent before an
  earlier one is never left out).
* **A merge** — `TablesRepository.mergedOf`: the target's lines, then each source's (a line id already
  taken gets a new one), what the kitchen had of each line and its notes carried with it, fired courses
  and parts paid kept — and here the send log, the payments given back and the held courses too.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from app.services import course_auto_fire as F

EPS = 1e-9
#: A round of what the log does not cover and no time places: "לפני כן".
EARLIER_ROUND = "earlier"
#: A round of what the log does not cover, by when it went: "at:<iso>".
AT_ROUND_PREFIX = "at:"


# ── The rounds (TableReprint.rounds) ──────────────────────────────────────────


@dataclass(frozen=True)
class RoundLine:
    round_id: str
    line_id: str
    name: str
    #: What this round gave the kitchen of the line, as far as the kitchen still has it.
    quantity: float
    course: Optional[str] = None


@dataclass(frozen=True)
class Round:
    id: str
    at: Optional[str]
    number: int
    lines: Tuple[RoundLine, ...]


Pick = Tuple[str, str]  # (round id, line id)


def paper_sent(extras: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """The `sent` rows the kitchen has on paper: a quantity, and not "נשלח (בלי בון)"."""
    sent = extras.get("sent")
    if not isinstance(sent, dict):
        return {}
    return {
        str(k): v for k, v in sent.items()
        if isinstance(v, dict) and F._float(v.get("q")) > EPS and v.get("s") is not True
    }


def _log(extras: Dict[str, Any]) -> List[Tuple[str, Optional[str], Dict[str, float]]]:
    """The send log (`log`): (id, at, {line: quantity > 0}) of each round, as TableExtras.decode reads it."""
    out = []
    for r in extras.get("log") or []:
        if not isinstance(r, dict):
            continue
        ident = F._str_or_none(r.get("i"))
        if ident is None:
            continue
        lines: Dict[str, float] = {}
        raw = r.get("l") if isinstance(r.get("l"), dict) else {}
        for k, q in raw.items():
            qty = F._float(q)
            if qty > 0.0:
                lines[str(k)] = qty
        out.append((ident, F._str_or_none(r.get("a")), lines))
    return out


def reprint_rounds(lines: Sequence[F.Line], extras: Dict[str, Any]) -> List[Round]:
    """
    The table's sent rounds as the till's picker lists them (TableReprint.rounds): oldest first, each
    with the lines the kitchen still has of it, in the cart's order. Empty: nothing was sent on paper.
    """
    live = [line for line in lines if line.quantity > EPS]
    by_id: Dict[str, F.Line] = {}
    for line in live:
        by_id.setdefault(line.id, line)
    held: Dict[str, float] = {}
    for line in live:
        held[line.id] = held.get(line.id, 0.0) + line.quantity
    sent = paper_sent(extras)
    has = {
        i: min(held.get(i, 0.0), F._float(sent[i].get("q")))
        for i in by_id if i in sent
    }
    has = {i: q for i, q in has.items() if q > EPS}
    log = _log(extras)
    logged: Dict[str, float] = {}
    for _id, _at, rl in log:
        for k, q in rl.items():
            if q > EPS:
                logged[k] = logged.get(k, 0.0) + q
    # The part no logged round covers went first: before the log, or from a till without it.
    unlogged = {i: q - logged.get(i, 0.0) for i, q in has.items() if q - logged.get(i, 0.0) > EPS}
    left = {i: q - unlogged.get(i, 0.0) for i, q in has.items()}

    raws: List[Tuple[str, Optional[str], Dict[str, float]]] = []
    by_when: Dict[str, Tuple[str, Optional[str], Dict[str, float]]] = {}
    for i, q in unlogged.items():
        # A line with logged rounds too: when its unlogged units went is not known.
        at = F._str_or_none(sent[i].get("a")) if logged.get(i, 0.0) <= EPS else None
        key = f"{AT_ROUND_PREFIX}{at}" if at else EARLIER_ROUND
        if key not in by_when:
            by_when[key] = (key, at, {})
        by_when[key][2][i] = q
    raws.extend(by_when.values())
    for ident, at, rl in log:
        given: Dict[str, float] = {}
        for k, q in rl.items():
            rest = left.get(k, 0.0)
            give = min(q, rest)
            if give > EPS:
                given[k] = given.get(k, 0.0) + give
                left[k] = rest - give
        raws.append((ident, at, given))

    def when(raw) -> Tuple[int, float]:
        moment = F.parse_time(raw[1]) if raw[1] else None
        # Nulls first, as the till sorts them; the sort is stable.
        return (0, 0.0) if moment is None else (1, moment.timestamp())

    kept = sorted((r for r in raws if r[2]), key=when)
    out = []
    for n, (ident, at, given) in enumerate(kept, start=1):
        out.append(Round(
            id=ident, at=at, number=n,
            lines=tuple(
                RoundLine(ident, line.id, line.name, given[line.id], line.course.name if line.course else None)
                for line in by_id.values() if line.id in given
            ),
        ))
    return out


def every_pick(rounds: Sequence[Round]) -> Set[Pick]:
    """"הכל": every line of every round."""
    return {(r.id, line.line_id) for r in rounds for line in r.lines}


def round_picks(rounds: Sequence[Round], round_id: str) -> Set[Pick]:
    """A whole round's lines; none for a round the table does not have."""
    return {(r.id, line.line_id) for r in rounds if r.id == round_id for line in r.lines}


def quantities(rounds: Sequence[Round], picks: Iterable[Pick]) -> Dict[str, float]:
    """How much of each line the picks print: its chosen rounds' shares together."""
    chosen = set(picks)
    out: Dict[str, float] = {}
    for r in rounds:
        for line in r.lines:
            if (r.id, line.line_id) in chosen:
                out[line.line_id] = out.get(line.line_id, 0.0) + line.quantity
    return out


def reprint_items(lines: Sequence[F.Line], extras: Dict[str, Any], wanted: Dict[str, float]) -> List[F.KitchenItem]:
    """
    What a reprint (or a rush) prints (TableReprint.plan → ticketLines): `wanted` of each line (never more
    than the line holds), with its current note and how it is made — a meal by its components.
    """
    seat_names = F.seat_names_of(extras)
    out: List[F.KitchenItem] = []
    seen: Set[str] = set()
    for line in lines:
        if line.quantity <= EPS or line.id in seen or line.id not in wanted:
            continue
        seen.add(line.id)
        qty = min(wanted[line.id], line.quantity)
        if qty <= EPS:
            continue
        out.extend(F.items_of(line, qty, F.line_notes(line, extras), seat_names))
    return out


def reprint_seed(order_id: Any, request_id: Any) -> str:
    """The dashboard's reprint (P:/specs/live-tables-cloud.md §6.3): "reprint|<order>|<request>"."""
    from app.services.table_void_tickets import java_name_uuid

    return str(java_name_uuid(f"reprint|{order_id}|{request_id}"))


def rush_seed(order_id: Any, request_id: Any) -> str:
    """The dashboard's "זרז" (§6.3): "rush|<order>|<request>"."""
    from app.services.table_void_tickets import java_name_uuid

    return str(java_name_uuid(f"rush|{order_id}|{request_id}"))


# ── A merge (TablesRepository.mergedOf) ───────────────────────────────────────


def cart_of(cart_json: Optional[str]) -> Dict[str, Any]:
    root = F._object(cart_json) if cart_json else None
    out = dict(root) if root else {}
    if not isinstance(out.get("lines"), list):
        out["lines"] = []
    return out


def has_basket_discount(cart: Dict[str, Any]) -> bool:
    """A basket discount ("הנחת חשבון"): it cannot be carried over line by line — the till refuses the merge."""
    kind = cart.get("documentDiscountType")
    return kind not in (None, "", "null")


def _strings(value: Any) -> List[str]:
    return [str(v) for v in value if v is not None and str(v) != ""] if isinstance(value, list) else []


def merged(
    target_cart: Dict[str, Any],
    target_extras: Dict[str, Any],
    sources: Sequence[Tuple[Dict[str, Any], Dict[str, Any]]],
    new_id: Callable[[], str] = lambda: str(uuid.uuid4()),
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    The merged cart and bookkeeping: the target's lines, then each source's (a line id already taken gets
    a new one, and what the kitchen had of it and its note go with it); the target's diners and waiter
    (else the first source's); fired courses of any table stay fired (and are held no more); parts paid
    and payments given back at any table are the merged table's (once each); the send log keeps every
    round (its lines renamed with them), oldest first, the last `ROUNDS_KEPT`.
    """
    lines = [dict(line) for line in target_cart.get("lines") or [] if isinstance(line, dict)]
    used = {str(line.get("id")) for line in lines}
    sent = dict(target_extras.get("sent") or {}) if isinstance(target_extras.get("sent"), dict) else {}
    notes = dict(target_extras.get("notes") or {}) if isinstance(target_extras.get("notes"), dict) else {}
    fired = _strings(target_extras.get("fired"))
    hold = _strings(target_extras.get("hold"))
    log = [dict(r) for r in target_extras.get("log") or [] if isinstance(r, dict)]
    partials = [p for p in target_extras.get("partials") or [] if isinstance(p, dict)]
    reversals = [r for r in target_extras.get("reversals") or [] if isinstance(r, dict)]
    waiter = target_extras.get("waiter") if isinstance(target_extras.get("waiter"), dict) else None
    for cart, extras in sources:
        renamed: Dict[str, str] = {}
        src_sent = extras.get("sent") if isinstance(extras.get("sent"), dict) else {}
        src_notes = extras.get("notes") if isinstance(extras.get("notes"), dict) else {}
        for line in cart.get("lines") or []:
            if not isinstance(line, dict):
                continue
            old = str(line.get("id"))
            ident = old if old not in used else new_id()
            used.add(ident)
            renamed[old] = ident
            lines.append({**line, "id": ident})
            if old in src_sent:
                sent[ident] = src_sent[old]
            if old in src_notes:
                notes[ident] = src_notes[old]
        for r in extras.get("log") or []:
            if not isinstance(r, dict) or not isinstance(r.get("l"), dict):
                continue
            moved = {renamed[k]: v for k, v in r["l"].items() if k in renamed}
            if moved:
                log.append({**r, "l": moved})
        fired += [c for c in _strings(extras.get("fired")) if c not in fired]
        hold += [c for c in _strings(extras.get("hold")) if c not in hold]
        known = {str(p.get("tx")) for p in partials}
        partials += [p for p in extras.get("partials") or [] if isinstance(p, dict) and str(p.get("tx")) not in known]
        given = {str(r.get("credit")) for r in reversals}
        reversals += [r for r in extras.get("reversals") or [] if isinstance(r, dict) and str(r.get("credit")) not in given]
        if waiter is None and isinstance(extras.get("waiter"), dict):
            waiter = extras["waiter"]
    hold = [c for c in hold if c not in fired]

    def when(r: Dict[str, Any]) -> Tuple[int, float]:
        moment = F.parse_time(r.get("a"))
        return (0, 0.0) if moment is None else (1, moment.timestamp())

    log = sorted(log, key=when)[-F.ROUNDS_KEPT:]
    out_extras = dict(target_extras)
    out_extras["sent"] = sent
    out_extras["notes"] = notes
    for key, value in (("fired", fired), ("hold", hold), ("log", log), ("partials", partials), ("reversals", reversals)):
        if value:
            out_extras[key] = value
        else:
            out_extras.pop(key, None)
    if waiter is not None:
        out_extras["waiter"] = waiter
    return {**target_cart, "lines": lines}, out_extras


# ── The card's lines and payments ─────────────────────────────────────────────


def _agorot(value: Any) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return 0


def _line_amount(raw: Dict[str, Any], quantity: float) -> float:
    """The line before promotions (CartLine.gross − its own discount), in shekels."""
    gross = _agorot(raw.get("unitPrice")) * quantity
    discount = _agorot(raw.get("discount"))
    kind = raw.get("discountType")
    if kind == "PERCENTAGE":
        off = gross * discount / 10_000
    elif kind == "FIXED":
        off = discount
    else:
        off = 0
    return round((gross - off) / 100.0, 2)


def card_lines(cart_json: Optional[str], extras: Dict[str, Any], rounds: Sequence[Round], now: datetime) -> List[Dict[str, Any]]:
    """
    The order's lines as the card lists them, in the cart's order: what it is, how many, the diner and
    the course, what the kitchen got of it (and whether "בלי בון"), when its last units went, in which
    rounds — and whether it waits: for "שלח", or held with its course.
    """
    lines = F.cart_lines(cart_json)
    raw_by_id = {str(o.get("id")): o for o in (cart_of(cart_json).get("lines") or []) if isinstance(o, dict)}
    sent = extras.get("sent") if isinstance(extras.get("sent"), dict) else {}
    fired = F.fired_courses(lines, extras)
    hold = set(_strings(extras.get("hold")))
    seat_names = F.seat_names_of(extras)
    in_rounds: Dict[str, List[int]] = {}
    for r in rounds:
        for rl in r.lines:
            in_rounds.setdefault(rl.line_id, []).append(r.number)
    out = []
    for line in lines:
        row = sent.get(line.id) if isinstance(sent.get(line.id), dict) else {}
        sent_qty = F._float(row.get("q"))
        details = line.details or {}
        seat = details.get("seat")
        seat_n = F._int(seat, -1) if seat is not None and not isinstance(seat, bool) else -1
        mods, removals = F._split(details.get("modifiers"))
        course = line.course
        if sent_qty + EPS >= line.quantity and line.quantity > EPS:
            state = "sent"
        elif sent_qty > EPS:
            state = "partly_sent"
        elif course is not None and (course.id in hold or course.id not in fired):
            state = "held"
        else:
            state = "waiting"
        raw = raw_by_id.get(line.id, {})
        out.append({
            "id": line.id,
            "productId": line.product_id,
            "name": line.name,
            "quantity": line.quantity,
            "amount": _line_amount(raw, line.quantity),
            "notes": F.line_notes(line, extras),
            "mods": list(mods),
            "removals": list(removals),
            "seat": seat_n if seat_n >= 0 else None,
            "seatName": seat_names.get(seat_n) if seat_n >= 0 else None,
            "course": {"id": course.id, "name": course.name, "order": course.order} if course is not None else None,
            "courseHeld": course is not None and course.id in hold,
            "sentQuantity": sent_qty,
            "silent": row.get("s") is True,
            "sentAt": F._str_or_none(row.get("a")),
            "rounds": in_rounds.get(line.id, []),
            "state": state,
        })
    return out


def payments_of(extras: Dict[str, Any]) -> Dict[str, Any]:
    """Parts paid ("פיצול חשבון") and payments given back (§3 of table-restore-payments), in shekels."""
    partials = [
        {
            "transactionId": F._str_or_none(p.get("tx")),
            "number": F._str_or_none(p.get("no")),
            "amount": round(_agorot(p.get("amount")) / 100.0, 2),
            "seat": F._int(p.get("seat"), 0) or None,
        }
        for p in extras.get("partials") or [] if isinstance(p, dict)
    ]
    reversals = [
        {
            "transactionId": F._str_or_none(r.get("tx")),
            "creditNumber": F._str_or_none(r.get("no")),
            "method": F._str_or_none(r.get("method")),
            "kind": F._str_or_none(r.get("kind")),
            "amount": round(_agorot(r.get("amount")) / 100.0, 2),
            "tip": round(_agorot(r.get("tip")) / 100.0, 2),
            "at": F._str_or_none(r.get("at")),
            "by": F._str_or_none(r.get("by")),
            "approvedBy": F._str_or_none(r.get("ok")),
            "note": F._str_or_none(r.get("note")),
        }
        for r in extras.get("reversals") or [] if isinstance(r, dict)
    ]
    paid = round(sum(p["amount"] for p in partials), 2)
    given = round(sum(r["amount"] for r in reversals), 2)
    return {"partials": partials, "reversals": reversals, "paid": paid, "reversed": given, "net": round(paid - given, 2)}


def rounds_out(rounds: Sequence[Round]) -> List[Dict[str, Any]]:
    return [
        {
            "id": r.id,
            "at": r.at,
            "number": r.number,
            "lines": [{"lineId": rl.line_id, "name": rl.name, "quantity": rl.quantity, "course": rl.course} for rl in r.lines],
        }
        for r in rounds
    ]


def courses_of(cart_json: Optional[str], extras: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The order's courses in the sequence: fired, held (waiting for "הוצא"), or paused ("השהה")."""
    lines = F.cart_lines(cart_json)
    fired = F.fired_courses(lines, extras)
    hold = set(_strings(extras.get("hold")))
    waiting = {c.id for c in F.held_courses(lines, extras)}
    paper = paper_sent(extras)
    seen: Dict[str, F.Course] = {}
    for line in lines:
        if line.live and line.course is not None:
            seen.setdefault(line.course.id, line.course)
    out = []
    for c in sorted(seen.values(), key=lambda c: c.order):
        out.append({
            "id": c.id,
            "name": c.name,
            "order": c.order,
            "fired": c.id in fired and c.id not in waiting,
            "waiting": c.id in waiting,
            "paused": c.id in hold,
            # "השהה" is offered only for a course nothing of which went to the kitchen on paper.
            "holdable": not any(
                line.id in paper for line in F.course_lines(lines, c.id)
            ),
        })
    return out


def table_note_of(extras: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    note = extras.get(F.TABLE_NOTE_KEY)
    if not isinstance(note, dict) or not F._str_or_none(note.get("t")):
        return None
    return {"text": F._str_or_none(note.get("t")), "by": F._str_or_none(note.get("by")),
            "at": F._str_or_none(note.get("a")), "printed": bool(note.get("p"))}


def encode(value: Dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# ── The card (reads the database) ─────────────────────────────────────────────


def _iso(moment: Optional[datetime]) -> Optional[str]:
    from app.services.areas import as_utc

    moment = as_utc(moment)
    return moment.isoformat() if moment is not None else None


def _as_utc(moment):
    from app.services.areas import as_utc

    return as_utc(moment)


def next_course(db, order, table, now: datetime, cache: Optional[Dict[Any, Any]] = None) -> Optional[Dict[str, Any]]:
    """
    The order's next course (courses-fire-v2 §1, the cloud's own reckoning of #96): which, whether the
    waiter paused it ("השהה"), and when it goes by itself — `dueAt` null when it does not (auto-fire off,
    nothing before it sent, `after_ready` not ready yet).
    """
    lines = F.cart_lines(order.cart_json)
    if not lines:
        return None
    extras = F.extras_of(order.extras_json)
    held = F.held_courses(lines, extras)
    if not held:
        return None
    first = held[0]
    paused = first.id in set(_strings(extras.get("hold")))
    out: Dict[str, Any] = {
        "courseId": first.id, "name": first.name, "paused": paused, "dueAt": None, "trigger": None, "minutes": None,
    }
    if paused:
        return out
    try:
        found = F.evaluate(db, order, table, now, cache)
    except Exception:  # noqa: BLE001 - the card is shown without its countdown
        found = None
    if found is not None and found.plan.pending.course.id == first.id:
        out["dueAt"] = _iso(found.plan.due_at)
        out["trigger"] = found.plan.trigger
        out["minutes"] = found.plan.minutes
    return out


def history(db, order, table, *, limit: int = 80) -> List[Dict[str, Any]]:
    """
    The table's history since the order opened: its events (sends, reprints, moves, cancels, the
    dashboard's actions…) and the dashboard's commands to a till with their outcome — newest first.
    """
    from sqlalchemy import or_

    from app.models.device_command import DeviceCommand
    from app.models.tables import TableEvent
    from app.models.user import User
    from app.services import device_commands as DC
    from app.services import table_actions as TA

    opened = order.opened_at
    cond = TableEvent.order_id == order.id
    if opened is not None:
        cond = or_(cond, (TableEvent.table_id == table.id) & (TableEvent.occurred_at >= opened))
    rows = (
        db.query(TableEvent)
        .filter(TableEvent.shop_id == order.shop_id, cond)
        .order_by(TableEvent.occurred_at.desc())
        .limit(limit)
        .all()
    )
    user_ids = {r.user_id for r in rows if r.user_id}
    users = (
        {u.id: (u.username or u.email) for u in db.query(User).filter(User.id.in_(list(user_ids))).all()}
        if user_ids else {}
    )
    out: List[Dict[str, Any]] = []
    for r in rows:
        details = dict(r.details or {})
        out.append({
            "source": "event",
            "kind": r.kind,
            "at": _iso(r.occurred_at),
            "by": r.pos_user_name or details.get("by") or users.get(r.user_id),
            "fromDashboard": details.get("from") == "dashboard" or r.user_id is not None,
            "version": r.version,
            "details": details,
        })
    cq = db.query(DeviceCommand).filter(
        DeviceCommand.shop_id == order.shop_id,
        DeviceCommand.action.in_([*TA.COMMANDS, "cancel_table"]),
    )
    if opened is not None:
        cq = cq.filter(DeviceCommand.created_at >= opened)
    now = DC.utc_now()
    waiting = {"pending": "waiting", "delivered": "waiting", "expired": "timeout"}
    for row in cq.order_by(DeviceCommand.created_at.desc()).limit(60).all():
        params = row.params or {}
        if params.get("orderId") != str(order.id) or params.get("retargetOf"):
            continue
        seen = TA.view(db, row, now) if row.action in TA.COMMANDS else {}
        state = DC.as_of(row, now)
        out.append({
            "source": "command",
            "kind": "command",
            "action": TA.ACTION_OF_COMMAND.get(row.action, "cancel" if row.action == "cancel_table" else row.action),
            "at": _iso(row.created_at),
            "by": row.created_by_name,
            "fromDashboard": True,
            "outcome": seen.get("outcome") or waiting.get(state["status"], state["status"]),
            "reason": seen.get("reason") or (state["detail"] if state["status"] == "refused" else None),
            "heldBy": seen.get("heldBy"),
            "hostName": seen.get("hostName"),
            "details": {
                k: params.get(k) for k in ("courseName", "targetLabel", "text", "scope", "printerName")
                if params.get(k) is not None
            },
        })
    out.sort(key=lambda e: e.get("at") or "", reverse=True)
    return out[:limit]


#: The card's actions, in the order the sheet lists them.
CARD_ACTIONS = ("print-bill", "reprint", "fire", "hold", "rush", "set-waiter", "move", "merge", "note", "release", "cancel")


def card(db, shop, table, user, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """`GET /tables/tables/{id}/card` (P:/specs/live-tables-cloud.md §2, §6.8)."""
    from app.models.tables import TableZone
    from app.services import dashboard_access as DA
    from app.services import dashboard_sections as DS
    from app.services import remote_table_cancel as RTC
    from app.services import table_actions as TA
    from app.services import tables as T

    now = now or T._now()
    zone = db.get(TableZone, table.zone_id) if table.zone_id is not None else None
    lock = T.lock_out(db, table, now)
    access = DA.effective_access(db, user)
    can_edit = access.allows("tables", DS.EDIT)
    can_manage = can_edit and access.allows(TA.MANAGE_SECTION, DS.EDIT)
    base = {
        "serverTime": now.isoformat(),
        "table": {**T.table_out(table), "zoneName": zone.name if zone is not None else None},
        "lock": lock,
        "heldBy": TA.holder_text(lock),
        "permissions": {"view": True, "edit": can_edit, "manage": can_manage},
    }
    order = TA.open_order_of(db, table)
    if order is None:
        return {**base, "order": None, "actions": {}}
    route = TA.route_for(db, shop, order)
    extras = F.extras_of(order.extras_json)
    has_cart = order.cart_json is not None
    lines = F.cart_lines(order.cart_json)
    rounds = reprint_rounds(lines, extras)
    courses = courses_of(order.cart_json, extras)
    cloud_in_use = route.mode == TA.CLOUD and lock is not None
    cancel_route = RTC.route_for(db, shop, order)

    def available(action: str) -> Dict[str, Any]:
        if not can_edit:
            return {"allowed": False, "why": "forbidden"}
        if action in ("cancel", "set-waiter") and not can_manage:
            return {"allowed": False, "why": "manage_forbidden"}
        if action == "release":
            return {"allowed": lock is not None, "why": None if lock is not None else "not_locked"}
        if action == "cancel":
            if cancel_route.mode == RTC.BLOCKED:
                return {"allowed": False, "why": f"blocked:{cancel_route.why}"}
            if cloud_in_use:
                return {"allowed": False, "why": "table_in_use"}
            return {"allowed": True, "why": None}
        if route.mode == TA.BLOCKED:
            return {"allowed": False, "why": f"blocked:{route.why}"}
        if cloud_in_use and action in TA.MUTATING:
            return {"allowed": False, "why": "table_in_use"}
        if has_cart:
            if action in ("reprint", "rush") and not rounds:
                return {"allowed": False, "why": "nothing_sent"}
            if action == "fire" and not any(c["waiting"] for c in courses):
                return {"allowed": False, "why": "no_course"}
            if action == "hold" and not any(c["waiting"] or c["paused"] for c in courses):
                return {"allowed": False, "why": "no_course"}
        return {"allowed": True, "why": None}

    seat_names = F.seat_names_of(extras)
    opened = _as_utc(order.opened_at)
    return {
        **base,
        "order": {**T.order_summary(order), "hasCart": has_cart},
        "route": TA.route_out(route),
        "cancel": RTC.route_out(cancel_route),
        "lines": card_lines(order.cart_json, extras, rounds, now) if has_cart else [],
        "rounds": rounds_out(rounds),
        "courses": courses,
        "nextCourse": next_course(db, order, table, now),
        "payments": payments_of(extras),
        "balance": float(T._money(order.total)),
        "note": table_note_of(extras),
        "seatNames": {str(k): v for k, v in seat_names.items()},
        "minutesOpen": int((now - opened).total_seconds() // 60) if opened is not None else None,
        "lastSentAt": _iso(order.sent_at),
        "history": history(db, order, table),
        "actions": {a: available(a) for a in CARD_ACTIONS},
    }
