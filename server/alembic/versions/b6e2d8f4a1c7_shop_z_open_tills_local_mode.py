"""shopZOpenTills: say that local mode is always "חובה לסגור את כל הקופות" — docs/SPEC_INDEPENDENT_TILL.md §8

Revision ID: b6e2d8f4a1c7
Revises: a9d3f7c1e5b8
Create Date: 2026-10-06

Built-in parameters are created once and never overwritten (a super admin may re-word
them), so the new sentence of the description reaches existing databases only here:
appended once to `shopZOpenTills`' description when it does not mention the local network
yet. Data only, nothing structural; the downgrade leaves the text as it is.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b6e2d8f4a1c7'
down_revision: Union[str, Sequence[str], None] = 'a9d3f7c1e5b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SENTENCE = (
    " בסניף שעובד ברשת מקומית (קופה ראשית) — תמיד «חובה לסגור את כל הקופות»: הקופה הראשית סוגרת "
    "את כל הקופות ברשת, ואף קופה לא נשארת בחוץ (קופה עצמאית אינה חלק מה-Z הסניפי בכלל)."
)


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("till_parameters"):
        return
    bind.execute(
        sa.text(
            "UPDATE till_parameters SET description = COALESCE(description, '') || :sentence, "
            "updated_at = now() "
            "WHERE key = 'shopZOpenTills' AND COALESCE(description, '') NOT LIKE '%רשת מקומית%'"
        ),
        {"sentence": SENTENCE},
    )


def downgrade() -> None:
    pass
