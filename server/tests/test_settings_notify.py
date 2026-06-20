import uuid
from unittest.mock import MagicMock, patch

from app.models.pos_machine import POSMachine
from app.models.shop import Shop
from app.services.settings_notify import (
    notify_machines_for_company_settings,
    notify_machines_for_shop_settings,
)


@patch("app.services.settings_notify.mqtt_service")
def test_notify_machines_for_shop_settings_publishes(mock_mqtt) -> None:
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.tenant_id = uuid.uuid4()
    machine.is_active = True

    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = [machine]

    notify_machines_for_shop_settings(db, str(uuid.uuid4()), reason="shop_settings_updated")

    mock_mqtt.publish_settings_notify.assert_called_once()
    args = mock_mqtt.publish_settings_notify.call_args
    assert args[0][0] == str(machine.tenant_id)
    assert args[0][1] == str(machine.id)
    assert args[1]["reason"] == "shop_settings_updated"


@patch("app.services.settings_notify.mqtt_service")
def test_notify_machines_for_company_settings_iterates_shops(mock_mqtt) -> None:
    shop_id = uuid.uuid4()
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.tenant_id = uuid.uuid4()

    db = MagicMock()
    shop_query = MagicMock()
    shop_query.filter.return_value.all.return_value = [(shop_id,)]
    machine_query = MagicMock()
    machine_query.filter.return_value.all.return_value = [machine]

    call_count = {"n": 0}

    def query_side(model):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return shop_query
        return machine_query

    db.query.side_effect = query_side

    notify_machines_for_company_settings(db, str(uuid.uuid4()), reason="company_settings_updated")

    mock_mqtt.publish_settings_notify.assert_called_once()
