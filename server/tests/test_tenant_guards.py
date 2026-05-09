import uuid

import pytest
from fastapi import HTTPException

from app.middleware.auth import ensure_same_tenant


def test_ensure_same_tenant_accepts_same_tenant() -> None:
    tenant_id = uuid.uuid4()
    ensure_same_tenant(tenant_id, tenant_id)


def test_ensure_same_tenant_accepts_null_entity_tenant() -> None:
    ensure_same_tenant(None, uuid.uuid4())


def test_ensure_same_tenant_rejects_cross_tenant() -> None:
    with pytest.raises(HTTPException) as exc:
        ensure_same_tenant(uuid.uuid4(), uuid.uuid4())
    assert exc.value.status_code == 403
    assert exc.value.detail == "tenant_forbidden"
