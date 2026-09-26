"""A distributor pairs tills in whichever organization it has switched into.

Entry to the tenant is `get_active_tenant_id`'s decision (membership, or super admin),
pinned in tests/test_tenant_switch.py. These pin what happens after that: the code is
created in the *active* tenant, and the account's home tenant plays no part.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.user import UserRole
from app.routers.pairing import generate_pairing_code
from app.schemas.pairing_code import PairingCodeGenerateRequest

HOME = uuid.uuid4()
OTHER = uuid.uuid4()


def _distributor(home=HOME):
    return SimpleNamespace(id=uuid.uuid4(), role=UserRole.DISTRIBUTOR, tenant_id=home)


def _generate(user, active, body=None, company=None):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = company
    with patch(
        "app.routers.pairing.resolve_pairing_assignment",
        return_value=((company.id if company else None), None),
    ), patch("app.routers.pairing.create_pairing_code", return_value="CODE") as create:
        out = generate_pairing_code(
            body=body or PairingCodeGenerateRequest(),
            current_user=user,
            active_tenant_id=active,
            db=db,
        )
    return out, create


def test_a_distributor_pairs_in_an_organization_it_switched_into() -> None:
    out, create = _generate(_distributor(home=HOME), active=OTHER)
    assert out == "CODE"
    assert create.call_args.kwargs["tenant_id"] == OTHER


def test_a_distributor_still_pairs_in_its_home_organization() -> None:
    _, create = _generate(_distributor(home=HOME), active=HOME)
    assert create.call_args.kwargs["tenant_id"] == HOME


def test_a_pre_assigned_company_must_belong_to_the_active_organization() -> None:
    # Dropping the home-tenant check must not open this one: a company from another
    # organization is still refused, whichever tenant the distributor came from.
    foreign = SimpleNamespace(id=uuid.uuid4(), tenant_id=HOME)
    with pytest.raises(HTTPException) as exc:
        _generate(_distributor(home=HOME), active=OTHER, company=foreign)
    assert exc.value.status_code == 403
