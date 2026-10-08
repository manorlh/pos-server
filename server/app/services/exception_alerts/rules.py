"""
An SMS alert rule: validation of what the dashboard sends, and its JSON both ways.

A rule watches a company (and its sub-companies) or one shop of it, and fires on the
exception kinds it lists (none listed = every kind of at least `minSeverity`), when:

* `minAmount` — |amount| ≥ ₪X, for kinds that carry an amount (a refund, a discount, a
  cash difference…); kinds without one are not held back by it;
* `minPercent` — value ≥ X%, for kinds measured in percent (a discount, a tip);
* `countThreshold` + `countWindowMinutes` — the N-th matching exception within M minutes,
  counted per till / employee / shop (`countScope`), e.g. 3 line voids in 10 minutes.

Recipients are Israeli mobile numbers (normalised to E.164), each optionally labelled and
linked to a dashboard user (users have no phone of their own). Quiet hours are local
"HH:MM" (the tenant's timezone; from > to wraps midnight). `rateLimitMinutes` caps the
rule at one message per window; with `digestEnabled` what the limit or the quiet hours
held back is summed up in one message afterwards.
"""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional

from app.models.exception_alerts import ExceptionAlertRule
from app.services.exception_alerts.catalog import COUNT_SCOPES, KINDS_BY_KEY, SEVERITY_RANK
from app.services.notifications.phone import PhoneError, mask_phone, normalize_mobile

MAX_RECIPIENTS = 10
MAX_RATE_LIMIT = 24 * 60
_TIME = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class RuleError(ValueError):
    def __init__(self, code: str, field: Optional[str] = None, detail: Optional[str] = None):
        super().__init__(code)
        self.code = code
        self.field = field
        self.detail = detail

    def as_json(self) -> Dict[str, Any]:
        return {"code": self.code, "field": self.field, "detail": self.detail}


def _number(value: Any, field: str, *, minimum: float, maximum: float, integer: bool = False) -> Optional[Any]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise RuleError("number_invalid", field)
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise RuleError("number_invalid", field) from None
    if number.is_nan() or number < Decimal(str(minimum)) or number > Decimal(str(maximum)):
        raise RuleError("number_out_of_range", field, f"{minimum:g}–{maximum:g}")
    if integer:
        if number != number.to_integral_value():
            raise RuleError("number_not_integer", field)
        return int(number)
    return number.quantize(Decimal("0.01"))


def parse_time(value: Any, field: str) -> Optional[str]:
    if value is None or value == "":
        return None
    text = str(value).strip()
    if not _TIME.match(text):
        raise RuleError("time_invalid", field)
    return text


def minutes_of(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def clean_recipients(raw: Any) -> List[Dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RuleError("recipients_invalid", "recipients")
    out: List[Dict[str, Any]] = []
    seen = set()
    for i, item in enumerate(raw):
        if isinstance(item, str):
            item = {"phone": item}
        if not isinstance(item, dict):
            raise RuleError("recipients_invalid", f"recipients.{i}")
        try:
            phone = normalize_mobile(item.get("phone"))
        except PhoneError as exc:
            raise RuleError(exc.code, f"recipients.{i}.phone") from None
        if phone in seen:
            continue
        seen.add(phone)
        label = " ".join(str(item.get("label") or "").split())[:60] or None
        user_id = str(item.get("userId")) if item.get("userId") else None
        out.append({"phone": phone, "label": label, "userId": user_id})
    if len(out) > MAX_RECIPIENTS:
        raise RuleError("too_many_recipients", "recipients", str(MAX_RECIPIENTS))
    return out


def clean(body: Dict[str, Any], *, partial_of: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    The rule's fields from a request body (camelCase), validated. With `partial_of` (the
    rule's current JSON) a field left out keeps its value.
    """
    src = dict(partial_of or {})
    src.update({k: v for k, v in body.items()})

    name = " ".join(str(src.get("name") or "").split())[:120]
    if not name:
        raise RuleError("name_required", "name")

    kinds_raw = src.get("kinds") or []
    if not isinstance(kinds_raw, list):
        raise RuleError("kinds_invalid", "kinds")
    kinds: List[str] = []
    for k in kinds_raw:
        if k not in KINDS_BY_KEY:
            raise RuleError("kind_unknown", "kinds", str(k))
        if k not in kinds:
            kinds.append(k)

    min_severity = src.get("minSeverity") or None
    if min_severity is not None and min_severity not in SEVERITY_RANK:
        raise RuleError("severity_invalid", "minSeverity")

    count = _number(src.get("countThreshold"), "countThreshold", minimum=2, maximum=100, integer=True)
    window = _number(src.get("countWindowMinutes"), "countWindowMinutes", minimum=1, maximum=24 * 60, integer=True)
    if (count is None) != (window is None):
        raise RuleError("count_needs_both", "countThreshold" if count is None else "countWindowMinutes")
    count_scope = src.get("countScope") or "machine"
    if count_scope not in COUNT_SCOPES:
        raise RuleError("count_scope_invalid", "countScope")

    quiet_from = parse_time(src.get("quietFrom"), "quietFrom")
    quiet_to = parse_time(src.get("quietTo"), "quietTo")
    if (quiet_from is None) != (quiet_to is None):
        raise RuleError("quiet_needs_both", "quietFrom" if quiet_from is None else "quietTo")
    if quiet_from is not None and quiet_from == quiet_to:
        raise RuleError("quiet_empty", "quietTo")

    rate = _number(src.get("rateLimitMinutes", 10), "rateLimitMinutes", minimum=0, maximum=MAX_RATE_LIMIT, integer=True)
    enabled = src.get("enabled", True) is not False
    recipients = clean_recipients(src.get("recipients"))
    if enabled and not recipients:
        raise RuleError("recipients_required", "recipients")
    if not kinds and min_severity is None:
        # "Every exception" must be an explicit choice of a severity floor.
        raise RuleError("kinds_required", "kinds")

    return {
        "name": name,
        "enabled": enabled,
        "kinds": kinds,
        "minSeverity": min_severity,
        "minAmount": _number(src.get("minAmount"), "minAmount", minimum=0, maximum=1_000_000),
        "minPercent": _number(src.get("minPercent"), "minPercent", minimum=0, maximum=1000),
        "countThreshold": count,
        "countWindowMinutes": window,
        "countScope": count_scope,
        "recipients": recipients,
        "quietFrom": quiet_from,
        "quietTo": quiet_to,
        "rateLimitMinutes": 10 if rate is None else rate,
        "digestEnabled": src.get("digestEnabled", True) is not False,
    }


def apply(rule: ExceptionAlertRule, fields: Dict[str, Any]) -> None:
    rule.name = fields["name"]
    rule.enabled = fields["enabled"]
    rule.kinds = list(fields["kinds"])
    rule.min_severity = fields["minSeverity"]
    rule.min_amount = fields["minAmount"]
    rule.min_percent = fields["minPercent"]
    rule.count_threshold = fields["countThreshold"]
    rule.count_window_minutes = fields["countWindowMinutes"]
    rule.count_scope = fields["countScope"]
    rule.recipients = [dict(r) for r in fields["recipients"]]
    rule.quiet_from = fields["quietFrom"]
    rule.quiet_to = fields["quietTo"]
    rule.rate_limit_minutes = fields["rateLimitMinutes"]
    rule.digest_enabled = fields["digestEnabled"]


def _float(value: Any) -> Optional[float]:
    return float(value) if value is not None else None


def as_json(rule: ExceptionAlertRule, *, mask: bool = False) -> Dict[str, Any]:
    """The rule for the dashboard (and the change log). `mask=True`: phones masked."""
    recipients = []
    for r in rule.recipients or []:
        phone = r.get("phone")
        recipients.append({
            "phone": mask_phone(phone) if mask else phone,
            "label": r.get("label"),
            "userId": r.get("userId"),
        })
    return {
        "id": str(rule.id),
        "companyId": str(rule.company_id) if rule.company_id else None,
        "shopId": str(rule.shop_id) if rule.shop_id else None,
        "name": rule.name,
        "enabled": bool(rule.enabled),
        "kinds": list(rule.kinds or []),
        "minSeverity": rule.min_severity,
        "minAmount": _float(rule.min_amount),
        "minPercent": _float(rule.min_percent),
        "countThreshold": rule.count_threshold,
        "countWindowMinutes": rule.count_window_minutes,
        "countScope": rule.count_scope or "machine",
        "recipients": recipients,
        "quietFrom": rule.quiet_from,
        "quietTo": rule.quiet_to,
        "rateLimitMinutes": rule.rate_limit_minutes if rule.rate_limit_minutes is not None else 10,
        "digestEnabled": bool(rule.digest_enabled),
    }


def audit_json(rule: ExceptionAlertRule) -> Dict[str, Any]:
    """What the change log keeps: everything, the phones masked (no personal data in a log)."""
    out = as_json(rule, mask=True)
    out.pop("id", None)
    return out
