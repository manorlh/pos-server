"""
The pieces a catalog import plan is made of (app/services/catalog_import.py and its
add-on layer, app/services/catalog_import_menu.py): a message on a row or on the file, and
one field's change. Kept apart so both planners share them without importing each other.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Dict, Optional

from app.services import catalog_sheet as S


@dataclass
class Issue:
    level: str  # "error" | "warning" | "info"
    #: As a list of messages shows it: "שורה 7: מחיר חסר".
    text: str
    sheet: Optional[str] = None
    row: Optional[int] = None
    #: The same without the row ("מחיר חסר"), for a view that shows the row by itself.
    message: str = ""

    def out(self) -> Dict[str, Any]:
        return {"level": self.level, "text": self.text, "message": self.message or self.text,
                "sheet": self.sheet, "row": self.row}


def display(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return S.YES if value else S.NO
    if isinstance(value, Decimal):
        return f"{value:.2f}"
    return value


@dataclass
class Change:
    field: str
    label: str
    before: Any
    after: Any

    def out(self) -> Dict[str, Any]:
        return {"field": self.field, "label": self.label, "before": display(self.before), "after": display(self.after)}


def row_issue(level: str, sheet: str, row: Optional[int], message: str) -> Issue:
    prefix = f"שורה {row}: " if row else ""
    return Issue(level, prefix + message, sheet, row, message)
