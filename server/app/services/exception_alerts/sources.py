"""
The detection points that feed the exceptions log, and how one of their rows becomes an
entry (`EntrySpec`).

Each `Source` names a model, a cheap test on a flushed row (`wants` — no SQL: it runs
inside every flush) and a builder (`build` — may read names and scopes). The session
hooks (hooks.py) collect the rows `wants` accepts and, after the commit, `capture` writes
the entries. Nothing here changes a source row.

Idempotent per source event: every entry's `dedupe_key` is `<source>:<the source row's
id>` — the row's own identity, not its content — so a re-pushed document, a rescan or
the same alert seen again lands on the same entry.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.services.exception_alerts.log import EntrySpec, as_decimal, as_uuid, aware


class Ctx:
    """Per-capture caches: tills, companies of shops, till users' names."""

    def __init__(self, db: Session):
        self.db = db
        self._machines: Dict[Any, Any] = {}
        self._companies: Dict[Any, Any] = {}
        self._names: Dict[str, Optional[str]] = {}

    def machine(self, machine_id: Any):
        from app.models.pos_machine import POSMachine

        key = as_uuid(machine_id)
        if key not in self._machines:
            self._machines[key] = self.db.get(POSMachine, key) if key else None
        return self._machines[key]

    def company_of_shop(self, shop_id: Any):
        from app.models.shop import Shop

        key = as_uuid(shop_id)
        if key is None:
            return None
        if key not in self._companies:
            row = self.db.query(Shop.company_id).filter(Shop.id == key).first()
            self._companies[key] = row[0] if row else None
        return self._companies[key]

    def pos_user_name(self, pos_user_id: Any) -> Optional[str]:
        from app.models.pos_user import PosUser

        if not pos_user_id:
            return None
        key = str(pos_user_id)
        if key not in self._names:
            ident = as_uuid(key)
            pu = self.db.get(PosUser, ident) if ident else None
            if pu is None:
                self._names[key] = None
            else:
                full = " ".join(p for p in (pu.first_name or "", pu.last_name or "") if p).strip()
                self._names[key] = full or pu.username
        return self._names[key]

    def user_name(self, user_id: Any) -> Optional[str]:
        from app.models.user import User

        key = as_uuid(user_id)
        user = self.db.get(User, key) if key else None
        return (user.username or user.email) if user is not None else None

    def scope_of_machine(self, machine_id: Any) -> Dict[str, Any]:
        m = self.machine(machine_id)
        if m is None:
            return {"machine_id": as_uuid(machine_id)}
        return {
            "tenant_id": m.tenant_id,
            "company_id": self.company_of_shop(m.shop_id),
            "shop_id": m.shop_id,
            "area_id": m.area_id,
            "machine_id": m.id,
        }


@dataclass(frozen=True)
class Source:
    name: str
    model_path: str  # "module:Class" — resolved lazily (no model import at module load)
    wants: Callable[[Any], bool]
    build: Callable[[Ctx, Any], Optional[EntrySpec]]

    def model(self):
        module, cls = self.model_path.split(":")
        mod = __import__(module, fromlist=[cls])
        return getattr(mod, cls)


def _utc(value: Optional[datetime]) -> datetime:
    return aware(value) or datetime.now(timezone.utc)


# ── audit_exceptions ─────────────────────────────────────────────────────────


def _audit(ctx: Ctx, ae) -> Optional[EntrySpec]:
    details = dict(ae.details) if isinstance(ae.details, dict) else {}
    z_id = details.get("zReportId") or details.get("zId") or details.get("shopZId")
    reviewed = ae.status in ("reviewed", "dismissed")
    note = ae.review_note
    if ae.status == "dismissed":
        details.setdefault("reviewStatus", "dismissed")
    return EntrySpec(
        source="audit_exception",
        source_id=str(ae.id),
        dedupe_key=f"audit:{ae.id}",
        kind=ae.exception_type,
        severity=ae.severity or "medium",
        occurred_at=_utc(ae.occurred_at),
        received_at=aware(ae.detected_at),
        tenant_id=ae.tenant_id,
        company_id=ae.company_id,
        shop_id=ae.shop_id,
        area_id=ae.area_id,
        machine_id=ae.machine_id,
        pos_user_id=ae.pos_user_id,
        pos_user_name=ae.pos_user_name or ctx.pos_user_name(ae.pos_user_id),
        amount=ae.amount,
        value=ae.value,
        threshold=ae.threshold,
        summary=details.get("summary") if isinstance(details.get("summary"), str) else None,
        details=details or None,
        transaction_id=ae.transaction_id,
        shift_id=ae.shift_id,
        z_report_id=as_uuid(z_id),
        till_event_id=ae.till_event_id,
        audit_exception_id=ae.id,
        mirror_ack=True,
        ack=(ae.reviewed_at, ae.reviewed_by_user_id, note) if reviewed else None,
    )


# ── failed payments ──────────────────────────────────────────────────────────

FAILED_OUTCOME_LABELS = {
    "declined": "נדחה",
    "cancelled_terminal": "בוטל במסוף",
    "cancelled_cashier": "בוטל ע״י הקופאי",
    "no_answer": "המסוף לא ענה",
    "terminal_error": "שגיאת מסוף",
    "card_locked": "כרטיס נעול",
    "unresolved": "לא הוכרע — ייתכן שהלקוח חויב",
    "approved_late": "אושר בבדיקה",
}
FAILED_OUTCOME_SEVERITY = {
    "no_answer": "medium", "terminal_error": "medium", "card_locked": "high",
    # The card's result unknown: possibly charged, the till's documents wait for a decision.
    "unresolved": "high",
}


def _failed_payment(ctx: Ctx, fp) -> Optional[EntrySpec]:
    scope = ctx.scope_of_machine(fp.machine_id)
    outcome = fp.outcome or ""
    if outcome == "approved_late":
        # Found charged and completed: not a failed payment. Only an entry already written
        # (it was "לא הוכרע" first) is refreshed to say how it ended.
        from app.services.exception_alerts import log as L

        if L.find(ctx.db, f"failed_payment:{fp.id}") is None:
            return None
    card = " ".join(p for p in (fp.card_brand or "", fp.card_last4 or "") if p)
    summary = " · ".join(p for p in (FAILED_OUTCOME_LABELS.get(outcome, outcome), card or None,
                                       "החזר לכרטיס" if fp.kind == "payout" else None) if p)
    return EntrySpec(
        source="failed_payment",
        source_id=str(fp.id),
        dedupe_key=f"failed_payment:{fp.id}",
        kind="failed_payment",
        severity=FAILED_OUTCOME_SEVERITY.get(outcome, "low"),
        occurred_at=_utc(fp.occurred_at),
        received_at=aware(fp.created_at),
        tenant_id=fp.tenant_id or scope.get("tenant_id"),
        company_id=fp.company_id or scope.get("company_id"),
        shop_id=fp.shop_id or scope.get("shop_id"),
        area_id=fp.area_id or scope.get("area_id"),
        machine_id=fp.machine_id,
        pos_user_id=fp.pos_user_id,
        pos_user_name=fp.employee_name or ctx.pos_user_name(fp.pos_user_id),
        amount=Decimal(int(fp.amount_agorot or 0)) / 100,
        summary=summary or None,
        details={
            "outcome": outcome,
            "reasonCode": fp.reason_code,
            "reasonMessage": fp.reason_message,
            "cardBrand": fp.card_brand,
            "cardLast4": fp.card_last4,
            "paymentKind": fp.kind,
            "channel": fp.channel,
            "terminalType": fp.terminal_type,
            "paidByTransactionId": str(fp.paid_by_transaction_id) if fp.paid_by_transaction_id else None,
            "paidAt": aware(fp.paid_at).isoformat() if fp.paid_at else None,
        },
        transaction_id=fp.paid_by_transaction_id or fp.transaction_id,
        shift_id=fp.shift_id,
    )


# ── refused documents ────────────────────────────────────────────────────────


def _document_refusal(ctx: Ctx, dr) -> Optional[EntrySpec]:
    scope = ctx.scope_of_machine(dr.machine_id)
    number = dr.document_number or dr.document_ref
    reason = " ".join((dr.reason or "").split())[:120]
    return EntrySpec(
        source="document_refusal",
        source_id=str(dr.id),
        dedupe_key=f"document_refusal:{dr.id}",
        kind="document_refused",
        severity="high",
        occurred_at=_utc(dr.first_seen_at),
        tenant_id=dr.tenant_id or scope.get("tenant_id"),
        company_id=scope.get("company_id"),
        shop_id=scope.get("shop_id"),
        area_id=scope.get("area_id"),
        machine_id=dr.machine_id,
        amount=as_decimal(dr.total_amount),
        summary=f"מסמך {number} נדחה: {reason}" if reason else f"מסמך {number} נדחה",
        details={
            "documentRef": dr.document_ref,
            "documentId": str(dr.document_id) if dr.document_id else None,
            "documentNumber": dr.document_number,
            "documentType": dr.document_type,
            "reason": (dr.reason or "")[:500],
            "attempts": dr.attempts,
            "issuedAt": aware(dr.issued_at).isoformat() if dr.issued_at else None,
            "lastSeenAt": aware(dr.last_seen_at).isoformat() if dr.last_seen_at else None,
            "landedAt": aware(dr.landed_at).isoformat() if dr.landed_at else None,
        },
        # Linked only once the document is stored after all.
        transaction_id=dr.document_id if dr.landed_at else None,
    )


# ── documents: numbering conflicts, over-credited credit notes ───────────────


def _tx_scope(ctx: Ctx, tx) -> Dict[str, Any]:
    scope = ctx.scope_of_machine(tx.machine_id)
    return dict(
        tenant_id=tx.tenant_id or scope.get("tenant_id"),
        company_id=ctx.company_of_shop(tx.shop_id) or scope.get("company_id"),
        shop_id=tx.shop_id or scope.get("shop_id"),
        area_id=scope.get("area_id"),
        machine_id=tx.machine_id,
        pos_user_id=tx.cashier_id,
        pos_user_name=ctx.pos_user_name(tx.cashier_id),
        transaction_id=tx.id,
        shift_id=tx.shift_id,
    )


def loaded(obj: Any, name: str, default: Any = None) -> Any:
    """
    An attribute as it is in memory — never loaded: `wants` runs inside a flush, where a
    lazy load of an expired attribute would be a query in the middle of it.
    """
    return obj.__dict__.get(name, default)


def _transaction_wants(tx) -> bool:
    conflict = loaded(tx, "number_conflict_of") is not None and not loaded(tx, "duplicate_copy", False)
    return conflict or loaded(tx, "over_credited") is True


def _transactions(ctx: Ctx, tx) -> List[EntrySpec]:
    out: List[EntrySpec] = []
    occurred = _utc(tx.created_at)
    if tx.number_conflict_of is not None and not tx.duplicate_copy:
        out.append(EntrySpec(
            source="transaction",
            source_id=str(tx.id),
            dedupe_key=f"transaction_conflict:{tx.id}",
            kind="document_number_conflict",
            severity="high",
            occurred_at=occurred,
            amount=abs(as_decimal(tx.total_amount) or Decimal("0")),
            summary=f"מסמך {tx.transaction_number}: המספר כבר קיים בקופה במסמך אחר",
            details={"transactionNumber": tx.transaction_number, "documentType": tx.document_type,
                     "conflictOf": str(tx.number_conflict_of)},
            **_tx_scope(ctx, tx),
        ))
    if tx.over_credited is True:
        out.append(EntrySpec(
            source="transaction",
            source_id=str(tx.id),
            dedupe_key=f"over_credited:{tx.id}",
            kind="over_credited",
            severity="high",
            occurred_at=occurred,
            amount=abs(as_decimal(tx.total_amount) or Decimal("0")),
            summary=f"זיכוי {tx.transaction_number} עבר את סכום המסמך המקורי",
            details={"transactionNumber": tx.transaction_number,
                     "refundOfTransactionId": str(tx.refund_of_transaction_id) if tx.refund_of_transaction_id else None},
            **_tx_scope(ctx, tx),
        ))
    return out


# ── Z / shift totals that disagree with the cloud ────────────────────────────


def _z_report(ctx: Ctx, z) -> Optional[EntrySpec]:
    scope = ctx.scope_of_machine(z.machine_id) if z.machine_id else {}
    number = z.machine_sequence_number or z.shop_sequence_number
    return EntrySpec(
        source="z_report",
        source_id=str(z.id),
        dedupe_key=f"z_totals_mismatch:{z.id}",
        kind="z_totals_mismatch",
        severity="high",
        occurred_at=_utc(z.closed_at or z.created_at),
        tenant_id=z.tenant_id or scope.get("tenant_id"),
        company_id=ctx.company_of_shop(z.shop_id) or scope.get("company_id"),
        shop_id=z.shop_id or scope.get("shop_id"),
        area_id=z.area_id or scope.get("area_id"),
        machine_id=z.machine_id,
        pos_user_id=z.created_by_pos_user_id,
        pos_user_name=z.created_by_name or ctx.pos_user_name(z.created_by_pos_user_id),
        amount=z.total_sales,
        summary=f"Z {number}: נתוני הקופה שונים מהענן" if number else "Z: נתוני הקופה שונים מהענן",
        details={"zNumber": number, "tillTotals": z.till_totals if isinstance(z.till_totals, dict) else None},
        z_report_id=z.id,
    )


def _shift(ctx: Ctx, s) -> Optional[EntrySpec]:
    return EntrySpec(
        source="shift",
        source_id=str(s.id),
        dedupe_key=f"shift_totals_mismatch:{s.id}",
        kind="shift_totals_mismatch",
        severity="medium",
        occurred_at=_utc(s.closed_at or s.close_accepted_at or s.opened_at),
        tenant_id=s.tenant_id,
        company_id=ctx.company_of_shop(s.shop_id),
        shop_id=s.shop_id,
        area_id=s.area_id,
        machine_id=s.machine_id,
        pos_user_id=s.closed_by_pos_user_id,
        pos_user_name=ctx.pos_user_name(s.closed_by_pos_user_id) or s.closed_by,
        summary=f"משמרת {s.sequence_number}: נתוני הקופה שונים מהענן",
        details={"sequenceNumber": s.sequence_number,
                 "tillTotals": s.till_totals if isinstance(s.till_totals, dict) else None},
        shift_id=s.id,
        z_report_id=s.z_report_id,
    )


# ── kiosk alerts ─────────────────────────────────────────────────────────────

_TERMINAL_MISMATCH = {"terminal_mismatch", "terminal_not_configured", "terminal_unknown"}


def kiosk_alert_kind(kind: str, reason: str) -> Optional[str]:
    if kind == "terminal":
        if reason == "card_unknown":
            return "card_unresolved"
        if reason in _TERMINAL_MISMATCH:
            return "terminal_mismatch"
        return "kiosk_terminal"
    if kind == "printer":
        return "kiosk_printer"
    return None  # a customer's help request is service, not an exception


def _kiosk_alert(ctx: Ctx, ka) -> Optional[EntrySpec]:
    kind = kiosk_alert_kind(ka.kind, ka.reason or "")
    if kind is None:
        return None
    from app.services.exception_alerts.catalog import KINDS_BY_KEY

    scope = ctx.scope_of_machine(ka.kiosk_machine_id)
    detail = ka.detail if isinstance(ka.detail, dict) else {}
    agorot = detail.get("amountAgorot")
    amount = Decimal(int(agorot)) / 100 if isinstance(agorot, (int, float)) and not isinstance(agorot, bool) else None
    return EntrySpec(
        source="kiosk_alert",
        source_id=str(ka.id),
        dedupe_key=f"kiosk_alert:{ka.id}",
        kind=kind,
        severity=KINDS_BY_KEY[kind].severity,
        occurred_at=_utc(ka.raised_at),
        tenant_id=ka.tenant_id or scope.get("tenant_id"),
        company_id=scope.get("company_id"),
        shop_id=ka.shop_id or scope.get("shop_id"),
        area_id=scope.get("area_id"),
        machine_id=ka.kiosk_machine_id,
        amount=amount,
        summary=ka.text,
        details={"reason": ka.reason, "key": ka.key, "detail": detail or None,
                 "clearedAt": aware(ka.cleared_at).isoformat() if ka.cleared_at else None,
                 "clearReason": ka.clear_reason},
    )


# ── device health: battery ───────────────────────────────────────────────────


def _battery(ctx: Ctx, b) -> Optional[EntrySpec]:
    scope = ctx.scope_of_machine(b.machine_id)
    return EntrySpec(
        source="battery",
        source_id=str(b.id),
        dedupe_key=f"battery:{b.id}",
        kind="device_battery",
        severity="medium" if b.severity == "critical" else "low",
        occurred_at=_utc(b.raised_at),
        tenant_id=b.tenant_id or scope.get("tenant_id"),
        company_id=scope.get("company_id"),
        shop_id=b.shop_id or scope.get("shop_id"),
        area_id=scope.get("area_id"),
        machine_id=b.machine_id,
        value=b.percent,
        threshold=b.level,
        summary=f"סוללה {b.percent}%" + (" (קריטי)" if b.severity == "critical" else ""),
        details={"level": b.level, "percent": b.percent, "lastPercent": b.last_percent,
                 "severity": b.severity, "clearReason": b.clear_reason},
    )


# ── training mode ────────────────────────────────────────────────────────────


def _training(ctx: Ctx, t) -> Optional[EntrySpec]:
    details = dict(t.details) if isinstance(t.details, dict) else {}
    if t.action == "dropped":
        kind, severity = "training_dropped", "high"
        summary = f"{details.get('count') or ''} מסמכי הדרכה ({details.get('kind') or ''}) מקופה בסניף שאינו במצב הדרכה".strip()
        scope = ctx.scope_of_machine(t.machine_id) if t.machine_id else {}
    elif t.action in ("enabled", "disabled"):
        kind, severity = "training_mode", "medium"
        who = ctx.user_name(t.user_id)
        summary = ("מצב הדרכה הופעל" if t.action == "enabled" else "מצב הדרכה כובה") + (f" ע״י {who}" if who else "")
        scope = {}
    else:
        return None
    return EntrySpec(
        source="training",
        source_id=str(t.id),
        dedupe_key=f"training:{t.id}",
        kind=kind,
        severity=severity,
        occurred_at=_utc(t.created_at),
        tenant_id=t.tenant_id or scope.get("tenant_id"),
        company_id=ctx.company_of_shop(t.shop_id),
        shop_id=t.shop_id,
        area_id=scope.get("area_id"),
        machine_id=t.machine_id,
        summary=summary,
        details={"action": t.action, "userId": str(t.user_id) if t.user_id else None,
                 **{k: v for k, v in details.items() if k in ("kind", "count", "ids")}},
    )


# ── till parameters: the terminal-number check bypass turned on ─────────────

BYPASS_KEY = "terminalNumberCheckBypass"


def _truthy(value: Any) -> bool:
    if isinstance(value, dict):
        value = value.get("value", value.get("enabled"))
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return value is True or (isinstance(value, (int, float)) and not isinstance(value, bool) and value != 0)


def _param_wants(c) -> bool:
    return (
        loaded(c, "parameter_key") == BYPASS_KEY and loaded(c, "action") == "set" and _truthy(loaded(c, "new_value"))
    )


def _till_parameter(ctx: Ctx, c) -> Optional[EntrySpec]:
    from app.models.company import Company
    from app.models.shop import Shop

    scope: Dict[str, Any] = {}
    if c.scope_type == "machine":
        scope = ctx.scope_of_machine(c.scope_id)
    elif c.scope_type in ("shop",):
        shop = ctx.db.get(Shop, as_uuid(c.scope_id))
        if shop is not None:
            scope = {"tenant_id": shop.tenant_id, "company_id": shop.company_id, "shop_id": shop.id}
    elif c.scope_type == "area":
        from app.models.shop_area import ShopArea

        area = ctx.db.get(ShopArea, as_uuid(c.scope_id))
        shop = ctx.db.get(Shop, area.shop_id) if area is not None else None
        if shop is not None:
            scope = {"tenant_id": shop.tenant_id, "company_id": shop.company_id, "shop_id": shop.id, "area_id": area.id}
    elif c.scope_type == "company":
        company = ctx.db.get(Company, as_uuid(c.scope_id))
        if company is not None:
            scope = {"tenant_id": company.tenant_id, "company_id": company.id}
    if not scope.get("tenant_id"):
        return None
    who = c.user_email or ctx.user_name(c.user_id)
    return EntrySpec(
        source="till_parameter",
        source_id=str(c.id),
        dedupe_key=f"till_parameter:{c.id}",
        kind="terminal_check_bypass",
        severity="high",
        occurred_at=_utc(c.created_at),
        summary="עקיפת בדיקת מספר מסוף הופעלה" + (f" ע״י {who}" if who else ""),
        details={"parameterKey": c.parameter_key, "scopeType": c.scope_type,
                 "scopeId": str(c.scope_id) if c.scope_id else None, "userEmail": c.user_email,
                 "userRole": c.user_role},
        **scope,
    )


# ── stock: low / out at a location ───────────────────────────────────────────


def _stock_alert(ctx: Ctx, a) -> Optional[EntrySpec]:
    where = a.level
    summary = ("אזל מהמלאי" if a.kind == "out" else "מלאי נמוך") + (f": {a.product_name}" if a.product_name else "")
    return EntrySpec(
        source="stock_alert",
        source_id=str(a.id),
        dedupe_key=f"stock_alert:{a.id}",
        kind="stock_out" if a.kind == "out" else "stock_low",
        severity="medium" if a.kind == "out" else "low",
        occurred_at=_utc(a.raised_at),
        tenant_id=a.tenant_id,
        company_id=a.company_id,
        shop_id=a.shop_id,
        area_id=a.area_id,
        machine_id=a.machine_id,
        value=a.quantity,
        threshold=a.threshold,
        summary=summary,
        details={"level": where, "targetId": str(a.target_id), "productId": str(a.product_id),
                 "suggestLevel": a.suggest_level,
                 "suggestTargetId": str(a.suggest_target_id) if a.suggest_target_id else None,
                 "suggestQuantity": float(a.suggest_quantity) if a.suggest_quantity is not None else None},
    )


def _one(fn: Callable[[Ctx, Any], Optional[EntrySpec]]) -> Callable[[Ctx, Any], List[EntrySpec]]:
    def wrapped(ctx: Ctx, row: Any) -> List[EntrySpec]:
        spec = fn(ctx, row)
        return [spec] if spec is not None else []

    return wrapped


SOURCES: Tuple[Source, ...] = (
    Source("audit_exception", "app.models.audit_exception:AuditException", lambda r: True, _one(_audit)),
    Source("failed_payment", "app.models.failed_payment:FailedPaymentAttempt", lambda r: True, _one(_failed_payment)),
    Source("document_refusal", "app.models.document_refusal:DocumentRefusal", lambda r: True, _one(_document_refusal)),
    Source("transaction", "app.models.transaction:Transaction", _transaction_wants, _transactions),
    Source("z_report", "app.models.z_report:ZReport", lambda z: loaded(z, "totals_mismatch") is True, _one(_z_report)),
    Source("shift", "app.models.shift:Shift", lambda s: loaded(s, "totals_mismatch") is True, _one(_shift)),
    Source("kiosk_alert", "app.models.kiosk_ops:KioskAlert",
           lambda a: loaded(a, "kind") in ("printer", "terminal"), _one(_kiosk_alert)),
    Source("battery", "app.models.device_battery:DeviceBatteryAlert", lambda b: True, _one(_battery)),
    Source("training", "app.models.training:TrainingAuditLog",
           lambda t: loaded(t, "action") in ("enabled", "disabled", "dropped"), _one(_training)),
    Source("till_parameter", "app.models.till_parameter:TillParameterChange", _param_wants, _one(_till_parameter)),
    Source("stock_alert", "app.models.stock_setting:StockAlert", lambda a: loaded(a, "cleared_at") is None, _one(_stock_alert)),
)

_BY_NAME = {s.name: s for s in SOURCES}
_BY_TYPE: Optional[Dict[type, Source]] = None


def by_name(name: str) -> Optional[Source]:
    return _BY_NAME.get(name)


def by_type() -> Dict[type, Source]:
    global _BY_TYPE
    if _BY_TYPE is None:
        _BY_TYPE = {s.model(): s for s in SOURCES}
    return _BY_TYPE


def capture(db: Session, source: Source, row: Any, ctx: Optional[Ctx] = None) -> List[EntrySpec]:
    return source.build(ctx or Ctx(db), row)


__all__ = ["SOURCES", "Source", "Ctx", "by_name", "by_type", "capture", "kiosk_alert_kind"]
