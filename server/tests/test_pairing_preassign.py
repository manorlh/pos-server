import uuid
from unittest.mock import MagicMock

import pytest

from app.services.pairing import PairingAssignmentError, resolve_pairing_assignment


def _mock_shop(shop_id, company_id, tenant_id):
    shop = MagicMock()
    shop.id = shop_id
    shop.company_id = company_id
    shop.tenant_id = tenant_id
    return shop


def _mock_company(company_id, tenant_id):
    company = MagicMock()
    company.id = company_id
    company.tenant_id = tenant_id
    return company


def test_resolve_pairing_assignment_empty() -> None:
    db = MagicMock()
    tenant_id = uuid.uuid4()
    assert resolve_pairing_assignment(db, tenant_id) == (None, None)


def test_resolve_pairing_assignment_company_only() -> None:
    db = MagicMock()
    tenant_id = uuid.uuid4()
    company_id = uuid.uuid4()
    company = _mock_company(company_id, tenant_id)

    db.query.return_value.filter.return_value.first.return_value = company

    cid, sid = resolve_pairing_assignment(db, tenant_id, company_id=company_id)
    assert cid == company_id
    assert sid is None


def test_resolve_pairing_assignment_company_and_shop() -> None:
    db = MagicMock()
    tenant_id = uuid.uuid4()
    company_id = uuid.uuid4()
    shop_id = uuid.uuid4()
    shop = _mock_shop(shop_id, company_id, tenant_id)
    company = _mock_company(company_id, tenant_id)

    db.query.return_value.filter.return_value.first.side_effect = [shop, company]

    cid, sid = resolve_pairing_assignment(db, tenant_id, company_id=company_id, shop_id=shop_id)
    assert cid == company_id
    assert sid == shop_id


def test_resolve_pairing_assignment_shop_company_mismatch() -> None:
    db = MagicMock()
    tenant_id = uuid.uuid4()
    company_id = uuid.uuid4()
    other_company_id = uuid.uuid4()
    shop_id = uuid.uuid4()
    shop = _mock_shop(shop_id, other_company_id, tenant_id)
    company = _mock_company(company_id, tenant_id)

    db.query.return_value.filter.return_value.first.side_effect = [shop, company]

    with pytest.raises(PairingAssignmentError, match="does not belong"):
        resolve_pairing_assignment(db, tenant_id, company_id=company_id, shop_id=shop_id)
