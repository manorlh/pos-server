"""events: a target typed on the live screen becomes the event's target in "יעדים ותחרות"

Revision ID: 7f2e55223360
Revises: e4b9d2a7c6f1
Create Date: 2026-10-09

One source for an event's target (the coordinator, 09.10.2026): "יעדים ותחרות"
(`sales_targets`). Every `report_events.live_target` typed on the live screen before this
becomes the event's shop target (`scope = 'shop'`, `period = 'event'`) — unless the event
already has one, which wins — and `live_target` is cleared, so an event never has two targets
and "יעד הושג" comes from one place.

Data only, idempotent (an event with a shop target is skipped; a cleared column has nothing
left to move). Offline (`--sql`): nothing — rows cannot be read there. No downgrade of data:
the targets stay where they are.
"""
from typing import Sequence, Union
import uuid

import sqlalchemy as sa
from alembic import op

revision: str = "7f2e55223360"
down_revision: Union[str, Sequence[str], None] = "e4b9d2a7c6f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if op.get_context().as_sql:
        return
    bind = op.get_bind()
    # Postgres takes the id as text (cast to uuid); SQLite (the tests) stores a uuid as its 32-hex form.
    new_id = (lambda: str(uuid.uuid4())) if bind.dialect.name == "postgresql" else (lambda: uuid.uuid4().hex)
    rows = bind.execute(sa.text(
        "SELECT e.id, e.tenant_id, e.company_id, e.shop_id, e.live_target, e.created_by_user_id, s.company_id "
        "FROM report_events e JOIN shops s ON s.id = e.shop_id WHERE e.live_target IS NOT NULL"
    )).fetchall()
    for event_id, tenant_id, company_id, shop_id, amount, created_by, shop_company in rows:
        has = bind.execute(sa.text(
            "SELECT 1 FROM sales_targets WHERE event_id = :e AND period = 'event' AND scope = 'shop' "
            "AND archived_at IS NULL LIMIT 1"
        ), {"e": event_id}).first()
        if has is None and amount is not None and amount > 0:
            bind.execute(sa.text(
                "INSERT INTO sales_targets (id, tenant_id, company_id, shop_id, scope, period, event_id, amount, "
                "day_start, day_end, created_by_user_id) "
                "VALUES (:id, :t, :c, :s, 'shop', 'event', :e, :a, '08:00', '23:00', :u)"
            ), {"id": new_id(), "t": tenant_id, "c": company_id or shop_company, "s": shop_id, "e": event_id,
                "a": amount, "u": created_by})
        bind.execute(sa.text("UPDATE report_events SET live_target = NULL WHERE id = :e"), {"e": event_id})


def downgrade() -> None:
    # The targets stay in "יעדים ותחרות" (a downgrade never moves data back).
    pass
