"""till parameters: "עובד מחובר בקופה אחת בלבד" v2 — the wording of the two existing definitions

Exclusive login v2 (P:/specs/exclusive-login-v2.md, docs/SPEC_EXCLUSIVE_LOGIN.md): a device that stops
reporting no longer releases its employee by itself unless `exclusiveUserLoginAutoRelease` says
`minutes` (default off), the rule binds only who lacks "עבודה בכמה מכשירים במקביל", and only a manager
releases. New databases get the new wording from the built-in definitions (app/services/
till_parameters.py); an existing one keeps its saved definitions (`ensure_builtin_parameters` never
rewrites one), so the descriptions of `exclusiveUserLogin` and `exclusiveUserLoginStaleMinutes` move
here — each only while it is still the old built-in text word for word (a super admin's own wording
stays). The three new parameters (`exclusiveUserLoginAutoRelease`, `…Offline`, `…Duplicate`) are
created by `ensure_builtin_parameters` at start-up, as every new built-in. No default and no value a
level set is touched.

Data only, no schema. Downgrade puts back the old wording where this moved it.

Revision ID: 7c4e2a9d1b6f
Revises: bb6205ba290c
Create Date: 2026-10-14 16:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "7c4e2a9d1b6f"
down_revision = "bb6205ba290c"
branch_labels = None
depends_on = None

ENABLED_KEY = "exclusiveUserLogin"
STALE_KEY = "exclusiveUserLoginStaleMinutes"

OLD_ENABLED_DESCRIPTION = (
    "כשמופעל: עובד/מלצר שמחובר בקופה אחת לא יכול להתחבר בקופה אחרת עד שיתנתק בה. "
    "בכניסה בקופה אחרת מוצגת הודעה איפה הוא מחובר ומאז מתי, ואפשר \"שחרור באישור מנהל\" "
    "(קוד מנהל; נרשם בחריגות). התנתקות, החלפת עובד ונעילה בחוסר שימוש משחררות. "
    "קופה בלי אינטרנט לא נחסמת: הכניסה מותרת והבדיקה נעשית כשהחיבור חוזר. "
    "קופה שהפסיקה לדווח משתחררת לבד אחרי \"עובד בקופה אחת — שחרור אוטומטי אחרי (דקות)\". "
    "את המחוברים כעת רואים (ומשחררים) בדשבורד בדף \"קופאים (POS)\"."
)
NEW_ENABLED_DESCRIPTION = (
    "כשמופעל: עובד/מלצר שמחובר במכשיר אחד (קופה, מכשיר נייד, טלפון או קופת Windows) לא יכול להתחבר "
    "במכשיר אחר עד שיתנתק בו. חל רק על מי שאין לו את ההרשאה \"עבודה בכמה מכשירים במקביל\" (בתפקידים: "
    "אסור למלצר ולקופאי, מותר לאחמ\"ש ולמנהל). בכניסה במכשיר אחר מוצגת הודעה איפה הוא מחובר ומאז מתי, "
    "ו\"לא מדווח מאז…\" כשהמכשיר ההוא הפסיק לדווח. משחרר רק מנהל שמותר לו: בקוד שלו (\"שחרור באישור "
    "מנהל\"), מהנייד (\"בקשת שחרור ממנהל\", כשבקשות האישור מהנייד מופעלות) או מהדשבורד, וכל שחרור "
    "נרשם בחריגות. התנתקות, החלפת עובד, נעילה בחוסר שימוש וניתוק המכשיר מהענן משחררים תמיד. "
    "שחרור אוטומטי, כניסה בלי אינטרנט ועובד שמחובר בשני מכשירים: בפרמטרים \"עובד בקופה אחת — …\". "
    "את המחוברים כעת רואים (ומשחררים) בדשבורד ובנייד: \"מחוברים כעת במכשירים\"."
)
OLD_STALE_DESCRIPTION = (
    "קופה שמחובר בה עובד ולא דיווחה לענן (נפלה, כבויה, בלי רשת) במשך מספר הדקות הזה — "
    "החיבור שלו בה משתחרר לבד, כך שקופה תקועה לא נועלת עובד לתמיד (2–720; ברירת מחדל 15). "
    "קופה פעילה מדווחת כל דקה."
)
NEW_STALE_DESCRIPTION = (
    "רק כש\"עובד בקופה אחת — שחרור אוטומטי\" הוא «אחרי הדקות שנקבעו»: מכשיר שמחובר בו עובד ולא דיווח "
    "לענן (נפל, כבוי, בלי רשת) במשך מספר הדקות הזה — הכניסה הבאה של העובד במכשיר אחר משחררת את החיבור "
    "הישן (2–720; ברירת מחדל 15). כשהשחרור האוטומטי כבוי, החיבור נשאר עד שמנהל משחרר. מכשיר פעיל "
    "מדווח כל דקה."
)


def _reword(conn, key: str, description_from: str, description_to: str) -> None:
    row = conn.execute(
        sa.text("SELECT id, description FROM till_parameters WHERE key = :key"), {"key": key}
    ).first()
    if row is None:  # not created yet: the built-in definition brings the new wording
        return
    if row[1] == description_from:
        conn.execute(
            sa.text("UPDATE till_parameters SET description = :description WHERE id = :id"),
            {"description": description_to, "id": row[0]},
        )


def upgrade() -> None:
    conn = op.get_bind()
    _reword(conn, ENABLED_KEY, OLD_ENABLED_DESCRIPTION, NEW_ENABLED_DESCRIPTION)
    _reword(conn, STALE_KEY, OLD_STALE_DESCRIPTION, NEW_STALE_DESCRIPTION)


def downgrade() -> None:
    conn = op.get_bind()
    _reword(conn, ENABLED_KEY, NEW_ENABLED_DESCRIPTION, OLD_ENABLED_DESCRIPTION)
    _reword(conn, STALE_KEY, NEW_STALE_DESCRIPTION, OLD_STALE_DESCRIPTION)
