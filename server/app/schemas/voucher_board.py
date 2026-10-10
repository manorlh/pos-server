"""
`GET /reports/prepaid-vouchers` — the control board's "שוברים" card: the prepaid vouchers
redeemed in the scope over a period, by voucher name, against a compared period.
camelCase on the wire; money as float.
"""
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.schemas.period_compare import CompareDelta
from app.schemas.reports import ReportWindowOut


class _Camel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


class VoucherUsage(_Camel):
    #: Distinct vouchers used (a voucher redeemed in parts counts once).
    vouchers: int = 0
    #: Redemptions (a discount voucher's confirmed use is one).
    redemptions: int = 0
    #: Goods units taken (a weighed item's weight); a discount voucher's uses.
    units: float = 0.0
    #: ₪: a discount voucher's discount; goods at the price on their sale document (a sale
    #: not yet synced adds its goods' units but no ₪).
    value: float = 0.0


class VoucherUsageRow(_Camel):
    batch_id: str
    #: The voucher's name as the board shows it (`voucher_display_name`).
    name: str
    #: `items` | `order_discount` | `item_discount`.
    kind: str
    current: VoucherUsage
    previous: Optional[VoucherUsage] = None
    #: Per figure (vouchers, redemptions, units, value); null with no comparison.
    deltas: Optional[Dict[str, CompareDelta]] = None


class VoucherBoardResponse(_Camel):
    window: ReportWindowOut
    compare_window: Optional[ReportWindowOut] = None
    totals: VoucherUsage
    previous: Optional[VoucherUsage] = None
    deltas: Optional[Dict[str, CompareDelta]] = None
    #: Most vouchers first; a voucher used only in the compared period is listed with zeros.
    rows: List[VoucherUsageRow]
