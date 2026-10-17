"""
"טיפים" — the till parameters a shop's tip setup writes (the shop dialog's "טיפים" step and the
shop page's "טיפים" card, client/src/lib/shopTips.ts), read and written per level as the roles
page's drawer card does (`cash_drawer.level_view` / `save_values` over these keys):

* `tipAutoPrompt` — "שאלת טיפ אוטומטית במעבר לתשלום" (app/services/till_parameters.py);
* `terminalTipPrompt` — "טיפ במסופון": the card terminal asks for the tip (docs/SPEC_TERMINAL_TIP.md);
* `billTipBase` — the printed table bill's suggested tip: on the balance or the total
  (app/services/table_restore.py; checked by its `clean_value`);
* `cashDrawer.cardTipsFromDrawer` — "טיפ באשראי משולם מהמזומן" (app/services/cash_drawer.py).

No new setting: the same parameters, at the same levels, with the same audit rows
(`till_parameter_changes`). The route exists because `tipAutoPrompt` and `terminalTipPrompt` had
none but the super admin's parameters page; whoever may set a shop's drawer parameters may set
these (app/routers/till_roles.py `_level_access`).

The rest of a shop's tips are not till parameters and keep their own routes: the settings layer
(`pay*Tips`, `tipPresets`, `tipDistribution` — `PATCH /shops/{id}/settings`) and the kiosk's
`payment.tipEnabled` / `tipPresets` / `tipOther` / `stepModes.tip` (`PUT /kiosks/settings`).
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

from app.services import table_restore as TR
from app.services.cash_drawer import CARD_TIPS_FROM_DRAWER_KEY
from app.services.till_parameters import TERMINAL_TIP_PROMPT_KEY

TIP_AUTO_PROMPT_KEY = "tipAutoPrompt"

#: The keys, in the order the dashboard lists them.
TIP_PARAM_KEYS: Tuple[str, ...] = (
    TIP_AUTO_PROMPT_KEY,
    TERMINAL_TIP_PROMPT_KEY,
    TR.TIP_BASE_KEY,
    CARD_TIPS_FROM_DRAWER_KEY,
)

ENUM_LABELS: Dict[str, Dict[str, str]] = {TR.TIP_BASE_KEY: dict(TR.TIP_LABELS)}


def _clean(key: str, value: Any) -> Any:
    return TR.clean_value(key, value) if key == TR.TIP_BASE_KEY else value


def level_view(db, scope_type: str, scope_id: Any) -> Dict[str, Any]:
    """`{scopeType, scopeId, own, inherited, inheritedSources, parameters}` of the tip parameters."""
    from app.services import cash_drawer as CD

    return CD.level_view(db, scope_type, scope_id, keys=TIP_PARAM_KEYS, enum_labels=ENUM_LABELS)


def save_values(db, scope_type: str, scope_id: Any, values: Dict[str, Any], *, user: Any) -> List[Tuple[str, str]]:
    """Set (or, with None, clear) the level's own values; the tills to notify. Not committed."""
    from app.services import cash_drawer as CD

    return CD.save_values(db, scope_type, scope_id, values, user=user, keys=TIP_PARAM_KEYS, clean=_clean)
