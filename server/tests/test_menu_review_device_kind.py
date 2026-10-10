"""
"סקירה לפני שידור" and the device kind: a shop in review mode serves each device the
published catalog as ITS kind reads it — exactly as the live pull does.

The publication is made once per shop, with no device of its own, so the `salesChannel` it
stores is a till's. "מופיע ב" (`appearsIn`) decides per kind: a product on neither the tills
nor the kiosks is sent to a till as "kiosk_only" and to a kiosk as "pos_only", so both hide it
(app/services/product_channels.py `device_sales_channel`). Served as stored, a kiosk would get
the till's "kiosk_only" — and show a product the merchant took off the kiosks.

What each test pins, and how it could look fine while doing damage:

* **Each kind gets what it got live** — switching review mode on changes no device's catalog:
  a kiosk, a till, a till in kiosk mode (`home_role` "till" — a till everywhere a role is asked),
  and a kiosk switched off (a till again), for every "מופיע ב" a product can have.
* **The kiosks' part waits for the broadcast** — the projection is of the published
  `appearsIn`, not the live product: a product added to (or taken off) the kiosks reaches the
  kiosk only after "אישור ושידור", and never moves a till.
* **Locked rows** — a product the broadcast dropped is sent locked as the kiosk reads it.
* **Older publications** — a row published before "מופיע ב" (no `appearsIn`) keeps its stored code.

Runs on the in-memory SQLite world of tests/shift_world.py (every table, foreign keys on).
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy.orm.attributes import flag_modified

from app.models.kiosk import KioskDevice
from app.models.shop_product_override import ShopProductOverride
from app.services import menu_broadcast as B
from app.services import product_channels
from app.services import sales_channel as SC
from test_menu_broadcast import (  # noqa: F401
    _now,
    age_publications,
    broadcast,
    by_global,
    by_id,
    live_payload,
    m,
    publications,
    pull,
    tables_on,
)
from test_shop_areas import w  # noqa: F401

#: Every "מופיע ב" a product can have that matters to a device (None: never set — `sales_channel`).
APPEARS = [None, [], ["pos"], ["kiosk"], ["pos", "kiosk"], ["online"], ["online", "menu"], ["kiosk", "online"]]


def make_kiosk(m, till, *, home_role=None, enabled=True):
    """`till` converted to a kiosk (`home_role` "till": a till whose kiosk mode is allowed)."""
    m.db.add(KioskDevice(
        machine_id=till.id, tenant_id=m.tenant.id, shop_id=m.shop.id, company_id=m.company.id,
        name="Kiosk", enabled=enabled, home_role=home_role,
    ))
    m.db.commit()


def set_appears(m, product, channels):
    """"מופיע ב" as the dashboard saves it."""
    product_channels.apply(product, appears=channels)
    product.updated_at = _now()
    m.db.commit()


def sold_as(payload, product):
    return by_global(payload)[str(product.id)]["salesChannel"]


# ── Each device kind gets what it got live ───────────────────────────────────


class TestEachKindGetsWhatItGotLive:
    @pytest.mark.parametrize("appears", APPEARS, ids=lambda a: "null" if a is None else ("+".join(a) or "none"))
    @pytest.mark.parametrize("kind", ["kiosk", "till_in_kiosk_mode", "disabled_kiosk"])
    def test_switching_review_on_changes_no_device(self, m, kind, appears):
        make_kiosk(
            m, m.t2,
            home_role="till" if kind == "till_in_kiosk_mode" else None,
            enabled=kind != "disabled_kiosk",
        )
        if appears is not None:
            set_appears(m, m.burger, appears)
        before = {t.id: live_payload(m, t) for t in (m.t1, m.t2)}
        tables_on(m)
        for till in (m.t1, m.t2):
            got = pull(m, till)
            assert by_id(got["products"]) == by_id(before[till.id]["products"])
        assert len(publications(m)) == 1

    def test_a_product_on_neither_is_hidden_on_both_kinds(self, m):
        """The case that went wrong: the published "kiosk_only" of a till reached the kiosk."""
        make_kiosk(m, m.t2)
        set_appears(m, m.burger, ["online"])
        tables_on(m)
        assert sold_as(pull(m, m.t1), m.burger) == SC.KIOSK_ONLY
        assert sold_as(pull(m, m.t2), m.burger) == SC.POS_ONLY
        # The publication itself stays device-free: one row, a till's code and the channels.
        row = publications(m)[0].snapshot["products"][str(m.burger.id)]
        assert row["salesChannel"] == SC.KIOSK_ONLY and row["appearsIn"] == ["online"]

    def test_a_delta_pull_after_switching_is_projected_too(self, m):
        make_kiosk(m, m.t2)
        set_appears(m, m.burger, ["online"])
        since = _now() - timedelta(seconds=5)
        tables_on(m)
        got = pull(m, m.t2, since)
        assert sold_as(got, m.burger) == SC.POS_ONLY
        assert by_id(got["products"]) == by_id(live_payload(m, m.t2)["products"])


# ── The kiosks' part waits for the broadcast ─────────────────────────────────


class TestTheKiosksPartWaitsForTheBroadcast:
    def test_a_product_added_to_the_kiosks_reaches_them_on_the_broadcast(self, m):
        make_kiosk(m, m.t2)
        set_appears(m, m.burger, ["online"])
        tables_on(m)
        pull(m, m.t2)
        set_appears(m, m.burger, ["kiosk", "online"])
        # Live, the kiosk would show it now; in review mode it waits — and the till never moves.
        assert sold_as(live_payload(m, m.t2), m.burger) == SC.KIOSK_ONLY
        assert sold_as(pull(m, m.t2), m.burger) == SC.POS_ONLY
        assert sold_as(pull(m, m.t1), m.burger) == SC.KIOSK_ONLY
        assert B.preview(m.db, m.shop)["hasChanges"] is True
        broadcast(m)
        assert sold_as(pull(m, m.t2), m.burger) == SC.KIOSK_ONLY
        assert sold_as(pull(m, m.t1), m.burger) == SC.KIOSK_ONLY

    def test_a_product_taken_off_the_kiosks_stays_there_until_the_broadcast(self, m):
        make_kiosk(m, m.t2)
        tables_on(m)
        assert sold_as(pull(m, m.t2), m.burger) == SC.ALL
        set_appears(m, m.burger, ["pos"])
        assert sold_as(pull(m, m.t2), m.burger) == SC.ALL
        assert sold_as(pull(m, m.t1), m.burger) == SC.ALL
        broadcast(m)
        assert sold_as(pull(m, m.t2), m.burger) == SC.POS_ONLY
        assert sold_as(pull(m, m.t1), m.burger) == SC.POS_ONLY
        assert by_id(pull(m, m.t2)["products"]) == by_id(live_payload(m, m.t2)["products"])


# ── Locked rows and older publications ───────────────────────────────────────


class TestLockedRowsAndOlderPublications:
    def test_a_product_the_broadcast_dropped_is_sent_locked_as_the_kiosk_reads_it(self, m):
        make_kiosk(m, m.t2)
        set_appears(m, m.burger, ["online"])
        tables_on(m)
        pull(m, m.t2)
        age_publications(m)
        since = _now() - timedelta(minutes=5)
        m.db.query(ShopProductOverride).filter_by(shop_id=m.shop.id, global_product_id=m.burger.id).delete()
        m.db.commit()
        broadcast(m)
        dropped = by_global(pull(m, m.t2, since))[str(m.burger.id)]
        assert (dropped["isAvailable"], dropped["shopListed"]) == (False, False)
        assert dropped["salesChannel"] == SC.POS_ONLY
        assert by_global(pull(m, m.t1, since))[str(m.burger.id)]["salesChannel"] == SC.KIOSK_ONLY

    def test_a_row_published_before_appears_in_keeps_its_stored_code(self, m):
        make_kiosk(m, m.t2)
        tables_on(m)
        pull(m, m.t2)
        publication = publications(m)[0]
        snapshot = dict(publication.snapshot)
        products = dict(snapshot["products"])
        row = dict(products[str(m.burger.id)])
        row.pop("appearsIn", None)
        row["salesChannel"] = SC.KIOSK_ONLY
        products[str(m.burger.id)] = row
        snapshot["products"] = products
        publication.snapshot = snapshot
        flag_modified(publication, "snapshot")
        m.db.commit()
        assert sold_as(pull(m, m.t2), m.burger) == SC.KIOSK_ONLY
        assert sold_as(pull(m, m.t1), m.burger) == SC.KIOSK_ONLY
