import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from app.routers.sync import get_settings_sync


def _ts(y: int, m: int, d: int) -> datetime:
    return datetime(y, m, d, 12, 0, 0, tzinfo=timezone.utc)


def test_get_settings_sync_unchanged_when_since_is_fresh() -> None:
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = uuid.uuid4()

    shop = MagicMock()
    shop.company_id = uuid.uuid4()
    shop.settings = {}
    shop.settings_updated_at = _ts(2026, 5, 1)
    shop.updated_at = _ts(2026, 5, 1)
    shop.branch_id = None
    shop.address = None
    shop.city = None

    company = MagicMock()
    company.tenant_id = None
    company.settings = {}
    company.settings_updated_at = _ts(2026, 5, 1)
    company.updated_at = _ts(2026, 5, 1)
    company.name = "Co"
    company.vat_number = "1"
    company.address = "A"
    company.city = "C"

    db = MagicMock()

    def query_side(model):
        q = MagicMock()
        if model.__name__ == "Shop":
            q.filter.return_value.first.return_value = shop
        elif model.__name__ == "Company":
            q.filter.return_value.first.return_value = company
        return q

    db.query.side_effect = query_side

    with patch("app.routers.sync.update_machine_sync_timestamp"):
        resp = get_settings_sync(
            machine_id=str(machine.id),
            since="2026-05-02T00:00:00+00:00",
            machine=machine,
            db=db,
        )

    assert resp.sync_type == "unchanged"
    assert resp.settings == {}
    assert resp.business_info is None


def test_get_settings_sync_returns_merged_settings() -> None:
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = uuid.uuid4()

    shop = MagicMock()
    shop.company_id = uuid.uuid4()
    shop.settings = {"nayaxDeviceHost": "10.0.0.9"}
    shop.settings_updated_at = _ts(2026, 6, 1)
    shop.updated_at = _ts(2026, 6, 1)
    shop.branch_id = "B1"
    shop.address = None
    shop.city = None

    company = MagicMock()
    company.tenant_id = None
    company.settings = {"globalTaxRate": 18, "language": "he"}
    company.settings_updated_at = _ts(2026, 5, 1)
    company.updated_at = _ts(2026, 5, 1)
    company.name = "Test Co"
    company.vat_number = "999"
    company.address = "Addr"
    company.city = "City"

    db = MagicMock()

    def query_side(model):
        q = MagicMock()
        if model.__name__ == "Shop":
            q.filter.return_value.first.return_value = shop
        elif model.__name__ == "Company":
            q.filter.return_value.first.return_value = company
        return q

    db.query.side_effect = query_side

    with patch("app.routers.sync.update_machine_sync_timestamp"):
        resp = get_settings_sync(
            machine_id=str(machine.id),
            since=None,
            machine=machine,
            db=db,
        )

    assert resp.sync_type == "full"
    assert resp.settings["globalTaxRate"] == 18
    assert resp.settings["nayaxDeviceHost"] == "10.0.0.9"
    assert resp.business_info is not None
    assert resp.business_info.company_name == "Test Co"
    assert resp.business_info.branch_id == "B1"
