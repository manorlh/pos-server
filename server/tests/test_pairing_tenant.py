import uuid
from unittest.mock import MagicMock

from app.services.pairing import resolve_tenant_id_for_user


def test_resolve_tenant_id_prefers_user_tenant_id() -> None:
    tenant_id = uuid.uuid4()
    user_id = uuid.uuid4()
    user = MagicMock()
    user.tenant_id = tenant_id
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = user
    assert resolve_tenant_id_for_user(db, user_id) == tenant_id
