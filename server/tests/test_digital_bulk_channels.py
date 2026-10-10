"""
"מופיע ב — עריכה בכמות" (app/routers/product_channels.py) over item-blocks' "מופיע ב"
(`products.appears_in`, app/services/product_channels.py — the canonical model).

What could look right and still be wrong:

* "all matching" acting only on the loaded page, or a dry run changing anything;
* products the caller may not edit, or ids that do not exist, silently skipped;
* the list's channel filter reading a product that never had a list differently from the model
  (NULL: as `sales_channel` says for the tills and kiosks, never online nor in the menu);
* a bulk change leaving `sales_channel` (what the tills and kiosks read) out of step.

Runs on the availability world (tests/test_product_availability.py), SQLite in memory.
"""
from __future__ import annotations

import uuid

import pytest

from app.models.product import CatalogLevel, Product
from app.routers import product_channels as R
from app.services import product_channels as PC

from test_product_availability import world  # noqa: F401


@pytest.fixture
def bw(world, monkeypatch):  # noqa: F811
    world.woken = []
    monkeypatch.setattr(R, "notify_all_machines_for_tenant", lambda _db, tid, reason: world.woken.append(tid))
    return world


def _bulk(w, user, body):
    return R.bulk_product_channels(R.BulkIn.model_validate(body), current_user=user, active_tenant_id=w.tid, db=w.db)


def _list(w, **kw):
    params = dict(page=1, page_size=200, search=None, category_ids=None, channel_on=None, channel_off=None)
    params.update(kw)
    return R.list_products(**params, current_user=w.users.admin, active_tenant_id=w.tid, db=w.db)


def test_all_matching_runs_on_the_server_and_a_dry_run_changes_nothing(bw):
    for i in range(30):
        bw.db.add(Product(id=uuid.uuid4(), tenant_id=bw.tid, company_id=bw.H.id, category_id=bw.P.category_id,
                          name=f"Extra {i:02d}", price=5, sku=f"X-{i}", catalog_level=CatalogLevel.GLOBAL))
    bw.db.commit()
    body = {"selection": {"allMatching": {"search": "Extra"}}, "set": {"online": True}, "dryRun": True}
    got = _bulk(bw, bw.users.admin, body)
    assert (got["matched"], got["changed"], got["applied"]) == (30, 30, False)
    assert len(got["sample"]) == R.SAMPLE_SIZE
    assert all(p.appears_in is None for p in bw.db.query(Product).filter(Product.name.like("Extra%")))
    got = _bulk(bw, bw.users.admin, {**body, "dryRun": False})
    assert got["applied"] is True and got["changed"] == 30 and bw.woken == [str(bw.tid)]
    extra = bw.db.query(Product).filter(Product.name.like("Extra%")).all()
    assert {tuple(PC.appears_in(p)) for p in extra} == {("pos", "kiosk", "online")}
    assert {p.sales_channel for p in extra} == {"all"}, "what the tills and kiosks read stays in step"
    again = _bulk(bw, bw.users.admin, {**body, "dryRun": False})
    assert (again["changed"], again["unchanged"]) == (0, 30)


def test_taking_pos_off_moves_sales_channel(bw):
    _bulk(bw, bw.users.admin, {"selection": {"ids": [str(bw.P.id)]}, "set": {"pos": False, "menu": True}, "dryRun": False})
    p = bw.db.get(Product, bw.P.id)
    assert PC.appears_in(p) == ("kiosk", "menu") and p.sales_channel == "kiosk_only"


def test_products_the_caller_may_not_edit_are_reported(bw):
    other = Product(id=uuid.uuid4(), tenant_id=bw.tid, company_id=bw.B.id, category_id=bw.P.category_id,
                    name="Beta only", price=5, sku="B-1", catalog_level=CatalogLevel.GLOBAL)
    bw.db.add(other)
    bw.db.commit()
    got = _bulk(bw, bw.users.h_manager, {
        "selection": {"ids": [str(bw.P.id), str(other.id), str(uuid.uuid4())]}, "set": {"menu": True}, "dryRun": False,
    })
    assert (got["changed"], got["refused"]) == (1, 2)
    assert {r["reason"] for r in got["refusedSample"]} == {"not_yours", "not_found"}
    assert "menu" not in PC.appears_in(bw.db.get(Product, other.id))
    assert "menu" in PC.appears_in(bw.db.get(Product, bw.P.id))


def test_the_list_filter_reads_the_model(bw):
    # P never had a list (NULL): pos + kiosk; Q: its own list, online only.
    bw.Q.sales_channel = "kiosk_only"
    PC.apply(bw.Q, appears=["online"])
    bw.db.commit()
    ids = lambda page: {i["id"] for i in page["items"]}  # noqa: E731
    assert ids(_list(bw, channel_on=["online"])) == {str(bw.Q.id)}
    assert str(bw.P.id) in ids(_list(bw, channel_on=["pos"])) and str(bw.Q.id) not in ids(_list(bw, channel_on=["pos"]))
    assert str(bw.Q.id) in ids(_list(bw, channel_off=["kiosk"]))
    row = next(i for i in _list(bw)["items"] if i["id"] == str(bw.P.id))
    assert row["appearsIn"] == ["pos", "kiosk"]
    with pytest.raises(Exception):
        _list(bw, channel_on=["web"])


def test_set_is_validated():
    with pytest.raises(Exception):
        R.BulkIn.model_validate({"selection": {"ids": []}, "set": {"web": True}})
    with pytest.raises(Exception):
        R.BulkIn.model_validate({"selection": {"ids": []}, "set": {}})
