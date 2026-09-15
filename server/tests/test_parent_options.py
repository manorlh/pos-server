"""
The candidate-parent list behind the company nesting UI.

Its whole job is that the picker cannot offer something the save would refuse. So the
tests care less about which companies come back than about which come back *disabled*,
and whether the reason is the true one — a picker that drops an impossible parent
silently leaves the operator hunting for a company they can see on the page behind the
dialog.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.user import User, UserRole
from app.routers import companies as C
from app.services.company_hierarchy import MAX_COMPANY_DEPTH


def _co(name, depth=0, cid=None):
    return SimpleNamespace(id=cid or uuid.uuid4(), name=name, tenant_id=None,
                           parent_company_id=None, _depth=depth)


class _Db:
    """Answers the three queries the endpoint makes, by entity."""

    def __init__(self, companies, moving=None, shops=(), machines=0):
        self._companies = companies
        self._moving = moving
        self._shops = list(shops)
        self._machines = machines
        self._entity = None

    def query(self, *entities):
        self._entity = entities[0]
        return self

    def filter(self, *_):
        return self

    def order_by(self, *_):
        return self

    def all(self):
        name = getattr(self._entity, "key", "") or str(self._entity)
        if "Shop" in str(self._entity):
            return [(s,) for s in self._shops]
        return self._companies

    def first(self):
        return self._moving

    def count(self):
        return self._machines


def _options(db, *, company_id=None, depths=None, subtree=(), height=0):
    """Run the endpoint with the hierarchy helpers stubbed to a known shape."""
    user = User(); user.role = UserRole.DISTRIBUTOR
    with patch.object(C, "company_depth", side_effect=lambda _db, cid: (depths or {}).get(str(cid), 0)), \
         patch.object(C, "descendant_company_ids", return_value=list(subtree)), \
         patch.object(C, "subtree_height", return_value=height), \
         patch.object(C, "ensure_same_tenant", lambda *a, **k: None):
        return C.get_parent_options(
            company_id=company_id, current_user=user,
            active_tenant_id=uuid.uuid4(), db=db,
        )


class TestCreatingACompany:
    def test_every_company_is_a_candidate_when_nothing_exists_yet(self):
        a, b = _co("A"), _co("B")

        out = _options(_Db([a, b]))

        assert [o.name for o in out.options] == ["A", "B"]
        assert all(o.allowed for o in out.options)

    def test_nothing_would_move_because_nothing_is_under_it_yet(self):
        """
        The reason a parent picker on the create form is safe and one on an existing
        company is not.
        """
        out = _options(_Db([_co("A")]))

        assert (out.moves_shops, out.moves_machines, out.moves_companies) == (0, 0, 0)

    def test_a_new_company_cannot_be_detached(self):
        assert _options(_Db([_co("A")])).may_detach is False


class TestMovingACompany:
    def test_a_company_cannot_be_its_own_parent(self):
        moving = _co("NORTH")
        out = _options(_Db([moving], moving=moving), company_id=moving.id,
                       subtree=[moving.id])

        opt = next(o for o in out.options if o.id == moving.id)
        assert opt.allowed is False
        assert opt.reason == "itself"

    def test_a_company_cannot_be_adopted_by_its_own_descendant(self):
        """The only other way to build a cycle."""
        moving, child = _co("NORTH"), _co("NORTH kiosks")
        out = _options(_Db([moving, child], moving=moving), company_id=moving.id,
                       subtree=[moving.id, child.id])

        opt = next(o for o in out.options if o.id == child.id)
        assert opt.allowed is False
        assert opt.reason == "already below this company"

    def test_an_unrelated_company_is_offered(self):
        moving, other = _co("NORTH"), _co("SOUTH")
        out = _options(_Db([moving, other], moving=moving), company_id=moving.id,
                       subtree=[moving.id])

        assert next(o for o in out.options if o.id == other.id).allowed is True

    def test_what_would_move_is_counted(self):
        """
        The number the confirmation shows. "This moves 2 shops and 5 tills" is the
        difference between a considered decision and a dropdown.
        """
        moving, child = _co("NORTH"), _co("NORTH kiosks")
        db = _Db([moving, child], moving=moving, shops=[uuid.uuid4(), uuid.uuid4()], machines=5)

        out = _options(db, company_id=moving.id, subtree=[moving.id, child.id])

        assert out.moves_shops == 2
        assert out.moves_machines == 5
        # The company itself is not "moved under itself".
        assert out.moves_companies == 1

    def test_an_unknown_company_is_a_404(self):
        with pytest.raises(HTTPException) as e:
            _options(_Db([], moving=None), company_id=uuid.uuid4())

        assert e.value.status_code == 404


class TestTheDepthCap:
    def test_a_parent_at_the_limit_is_disabled_with_the_reason(self):
        deep = _co("deep")
        out = _options(_Db([deep]), depths={str(deep.id): MAX_COMPANY_DEPTH})

        opt = out.options[0]
        assert opt.allowed is False
        assert str(MAX_COMPANY_DEPTH + 1) in opt.reason

    def test_a_parent_just_inside_the_limit_is_offered(self):
        ok = _co("ok")
        out = _options(_Db([ok]), depths={str(ok.id): MAX_COMPANY_DEPTH - 1})

        assert out.options[0].allowed is True

    def test_the_moving_subtrees_own_height_counts_against_the_cap(self):
        """
        Moving a two-level branch under a company needs two levels of room, not one.
        Ignoring the height is how a picker offers a parent the save then refuses.
        """
        moving, target = _co("branch"), _co("target")
        db = _Db([moving, target], moving=moving)

        flat = _options(db, company_id=moving.id, subtree=[moving.id],
                        depths={str(target.id): MAX_COMPANY_DEPTH - 1}, height=0)
        tall = _options(db, company_id=moving.id, subtree=[moving.id],
                        depths={str(target.id): MAX_COMPANY_DEPTH - 1}, height=1)

        assert next(o for o in flat.options if o.id == target.id).allowed is True
        assert next(o for o in tall.options if o.id == target.id).allowed is False


class TestWhoMayAsk:
    def test_it_is_distributor_only_like_the_write_path(self):
        """
        Re-parenting rearranges who can see whose takings, so even the list of
        possibilities is not a company manager's business.
        """
        from app.middleware.auth import get_current_distributor

        route = next(
            r for r in C.router.routes
            if getattr(r, "path", "") == "/companies/parent-options"
        )

        reachable = set()

        def walk(dependant):
            for sub in dependant.dependencies:
                reachable.add(sub.call)
                walk(sub)

        walk(route.dependant)

        assert get_current_distributor in reachable

    def test_a_company_manager_cannot_reach_it(self):
        """The guard is the dependency; this pins what that dependency actually does."""
        from fastapi import HTTPException

        from app.middleware.auth import get_current_distributor

        manager = User()
        manager.role = UserRole.COMPANY_MANAGER

        with pytest.raises(HTTPException) as e:
            get_current_distributor(current_user=manager)

        assert e.value.status_code == 403
