"""
"קטגוריית אב" — a category's parent through the dashboard API (`POST /categories`, `PUT /categories/{id}`).

Sub-categories used to be made only by the Excel import's "מחלקת אב" column; the dashboard's category dialog now
has a "קטגוריית אב" select (default "ללא"). The API always took `parentId`; this pins what it does with it:
an existing category of the same tenant, never one that would close a loop (itself, or anything beneath it),
`null` clears it, an omitted field leaves it, and the response carries it.

Style matches tests/test_restricted_items.py: the handlers are called with a real (SQLite) session.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.category import CatalogLevel, Category
from app.models.tenant import Tenant
from app.routers import categories as CR
from app.schemas.category import CategoryCreate, CategoryResponse, CategoryUpdate
from shift_world import accept_str_uuids, make_world


@pytest.fixture
def world(monkeypatch):
    accept_str_uuids(monkeypatch)
    monkeypatch.setattr(CR, "_trigger_catalog_notify", lambda *a, **k: None)
    return make_world()


def _ctx(world):
    return dict(current_user=world.admin, active_tenant_id=world.tenant.id, db=world.db)


def _create(world, name, parent=None, **extra):
    body = {"name": name, "companyId": str(world.company.id), **extra}
    if parent is not None:
        body["parentId"] = str(parent.id if hasattr(parent, "id") else parent)
    return CR.create_category(CategoryCreate.model_validate(body), **_ctx(world))


def _update(world, category, body, *, path_id=None):
    return CR.update_category(path_id or str(category.id), CategoryUpdate.model_validate(body), **_ctx(world))


def _parent_of(world, category):
    return world.db.get(Category, category.id).parent_id


def _refused(call, status, detail=None):
    with pytest.raises(HTTPException) as exc:
        call()
    assert exc.value.status_code == status
    if detail is not None:
        assert exc.value.detail == detail


def _foreign_category(world):
    """A category of ANOTHER tenant."""
    other = Tenant(id=uuid.uuid4(), name="Other", slug="other", timezone="Asia/Jerusalem")
    world.db.add(other)
    world.db.flush()
    row = Category(
        id=uuid.uuid4(), tenant_id=other.id, name="של מישהו אחר", catalog_level=CatalogLevel.GLOBAL, is_active=True, sort_order=0
    )
    world.db.add(row)
    world.db.flush()
    return row


# ── Making one ────────────────────────────────────────────────────────────────


def test_a_category_made_with_a_parent_is_filed_under_it(world):
    drinks = _create(world, "שתייה")
    wine = _create(world, "יין", parent=drinks)
    assert _parent_of(world, wine) == drinks.id
    assert _parent_of(world, drinks) is None
    # The response (and the list the dashboard reads) names it, as `parentId`.
    out = CategoryResponse.model_validate(world.db.get(Category, wine.id)).model_dump(by_alias=True, mode="json")
    assert out["parentId"] == str(drinks.id)


def test_without_a_parent_it_is_a_top_category(world):
    assert _parent_of(world, _create(world, "שתייה")) is None


def test_an_unknown_parent_is_refused_when_making_one(world):
    _refused(lambda: _create(world, "יין", parent=uuid.uuid4()), 400, "Parent category not found")


def test_another_tenants_category_is_never_a_parent(world):
    foreign = _foreign_category(world)
    _refused(lambda: _create(world, "יין", parent=foreign), 403, "tenant_forbidden")


# ── Changing it ───────────────────────────────────────────────────────────────


def test_a_parent_is_set_changed_and_cleared(world):
    drinks, food = _create(world, "שתייה"), _create(world, "אוכל")
    wine = _create(world, "יין")
    _update(world, wine, {"parentId": str(drinks.id)})
    assert _parent_of(world, wine) == drinks.id
    # Moved to another parent.
    _update(world, wine, {"parentId": str(food.id)})
    assert _parent_of(world, wine) == food.id
    # An edit that does not name it leaves it where it is.
    _update(world, wine, {"name": "יין אדום"})
    assert _parent_of(world, wine) == food.id
    # "ללא": an explicit null clears it.
    _update(world, wine, {"parentId": None})
    assert _parent_of(world, wine) is None


def test_an_unknown_parent_is_refused_when_changing_one(world):
    wine = _create(world, "יין")
    _refused(lambda: _update(world, wine, {"parentId": str(uuid.uuid4())}), 400, "Parent category not found")
    assert _parent_of(world, wine) is None


def test_another_tenants_category_is_never_a_parent_when_changing_one_either(world):
    wine = _create(world, "יין")
    foreign = _foreign_category(world)
    _refused(lambda: _update(world, wine, {"parentId": str(foreign.id)}), 403, "tenant_forbidden")
    assert _parent_of(world, wine) is None


# ── No category is its own ancestor ───────────────────────────────────────────


def test_a_category_cannot_be_its_own_parent(world):
    a = _create(world, "א")
    _refused(lambda: _update(world, a, {"parentId": str(a.id)}), 400, "Circular reference detected")
    assert _parent_of(world, a) is None


def test_nor_the_child_of_what_is_beneath_it(world):
    # א > ב > ג: ג may not become the parent of ב (a child), nor of א (a grandchild above it).
    a = _create(world, "א")
    b = _create(world, "ב", parent=a)
    c = _create(world, "ג", parent=b)
    _refused(lambda: _update(world, a, {"parentId": str(b.id)}), 400, "Circular reference detected")
    _refused(lambda: _update(world, a, {"parentId": str(c.id)}), 400, "Circular reference detected")
    _refused(lambda: _update(world, b, {"parentId": str(c.id)}), 400, "Circular reference detected")
    assert [_parent_of(world, x) for x in (a, b, c)] == [None, a.id, b.id]


def test_a_legal_move_in_the_same_tree_still_works(world):
    a = _create(world, "א")
    b = _create(world, "ב", parent=a)
    c = _create(world, "ג", parent=b)
    # ג moves up under א (a sibling of ב): no loop.
    _update(world, c, {"parentId": str(a.id)})
    assert _parent_of(world, c) == a.id
    # ב moves under ג: ג is no longer beneath ב.
    _update(world, b, {"parentId": str(c.id)})
    assert _parent_of(world, b) == c.id


def test_the_check_reads_an_id_in_any_spelling(world):
    """`{ID}` in the URL is the same category as `{id}`: it still cannot be its own parent."""
    a = _create(world, "א")
    _refused(
        lambda: _update(world, a, {"parentId": str(a.id)}, path_id=str(a.id).upper()),
        400,
        "Circular reference detected",
    )
    assert _parent_of(world, a) is None


def test_a_loop_already_in_the_data_does_not_hang_the_check(world):
    """Data from before the check: א > ב > א. Walking up it stops instead of going round for ever."""
    a = _create(world, "א")
    b = _create(world, "ב", parent=a)
    world.db.get(Category, a.id).parent_id = b.id
    world.db.flush()
    c = _create(world, "ג")
    assert CR._check_circular(world.db, str(c.id), str(a.id)) is True
    _update(world, c, {"parentId": None})


# ── What it does not break ────────────────────────────────────────────────────


def test_a_parent_with_children_cannot_be_deleted(world):
    a = _create(world, "א")
    _create(world, "ב", parent=a)
    _refused(
        lambda: CR.delete_category(str(a.id), **_ctx(world)),
        422,
        "Category has child categories",
    )
