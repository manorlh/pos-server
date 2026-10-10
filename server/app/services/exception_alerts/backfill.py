"""
Filling the exceptions log from what was detected before it existed.

Read-only on every source: it reads `audit_exceptions`, `failed_payment_attempts`,
`document_refusals`, `kiosk_alerts`, `device_battery_alerts`, `training_audit_log`,
`till_parameter_changes` and the flagged documents / Zs / shifts, and only writes
`exception_log` rows marked `backfilled` — idempotent (the same `dedupe_key` as live
recording) and never alerted (no SMS about the past).

The migration that creates the log copies `audit_exceptions` by itself (one INSERT …
SELECT); this module covers every source, for `python -m scripts.backfill_exception_log`.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.services.exception_alerts import hooks
from app.services.exception_alerts import sources as SRC

#: Per source per run.
MAX_ROWS = 50_000
BATCH = 500

#: source name → (time column, extra filter) for the read query.
_WINDOWS = {
    "audit_exception": ("occurred_at", None),
    "failed_payment": ("occurred_at", None),
    "document_refusal": ("first_seen_at", None),
    "transaction": ("created_at", "flagged"),
    "z_report": ("created_at", "totals_mismatch"),
    "shift": ("opened_at", "totals_mismatch"),
    "kiosk_alert": ("raised_at", None),
    "battery": ("raised_at", None),
    "training": ("created_at", None),
    "till_parameter": ("created_at", None),
}


def backfill(db: Session, *, since: Optional[datetime] = None, tenant_id: Any = None) -> Dict[str, int]:
    """Log what the sources hold since `since` (default 90 days). Commits per batch. Returns counts per source."""
    since = since or datetime.now(timezone.utc) - timedelta(days=90)
    counts: Dict[str, int] = {}
    for source in SRC.SOURCES:
        model = source.model()
        column_name, extra = _WINDOWS.get(source.name, ("created_at", None))
        q = db.query(model).filter(getattr(model, column_name) >= since)
        if tenant_id is not None and hasattr(model, "tenant_id"):
            q = q.filter(model.tenant_id == tenant_id)
        if extra == "flagged":
            q = q.filter((model.number_conflict_of.isnot(None)) | (model.over_credited.is_(True)))
        elif extra == "totals_mismatch":
            q = q.filter(model.totals_mismatch.is_(True))
        keys = []
        for row in q.order_by(getattr(model, column_name)).limit(MAX_ROWS).all():
            if source.wants(row):
                keys.append((source.name, row.id))
        created = 0
        for start in range(0, len(keys), BATCH):
            created += len(hooks.record_rows(db, keys[start:start + BATCH], backfilled=True))
            db.commit()
        counts[source.name] = created
    return counts
