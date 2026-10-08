"""
"חסימת אשראי כשיש תשלום לא מוכרע" — the till parameter `cardLockOnUnresolved`.

A card payment whose outcome is unknown (the terminal took the card but the till never heard
the result) is "לא מוכרע" until a manager resolves it. The owner's decision is what else it
blocks:

* **off (the default)** — only its own transaction: the till's other sales and the kiosk's other
  orders keep paying by card as usual; the unresolved payment stays an urgent alert until a
  manager handles it;
* **on** — every unresolved payment locks card payment on that till / kiosk until a manager
  handles it.

A built-in boolean parameter (app/services/till_parameters.py `BUILTIN_PARAMETERS`), set like
every parameter per company / shop / point of sale / till (a shop's value for all its tills, a
till's own over it) and synced with the others (`GET /sync/{machine_id}/parameters`). The till
applies it; the cloud only defines and delivers it.
"""
from __future__ import annotations

KEY = "cardLockOnUnresolved"
LABEL = "חסימת אשראי כשיש תשלום לא מוכרע"

DESCRIPTION = (
    "כבוי (ברירת מחדל): תשלום באשראי שתוצאתו לא ידועה חוסם רק את העסקה שלו, ושאר העסקאות "
    "וההזמנות בקיוסק משלמות באשראי כרגיל; התשלום הלא מוכרע נשאר כהתראה דחופה עד שמנהל מטפל בו. "
    "פעיל: כל תשלום לא מוכרע חוסם את האשראי בקופה/בקיוסק עד שמנהל מטפל בו."
)

CARD_LOCK_PARAMETER_SPECS = (
    dict(
        key=KEY,
        label=LABEL,
        value_type="boolean",
        default_value=False,
        description=DESCRIPTION,
    ),
)
