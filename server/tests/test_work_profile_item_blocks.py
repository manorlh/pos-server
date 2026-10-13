"""
"חסימות פריטים" in the shop's work profile (P:/specs/item-block-control.md §5 "הקמת סניף", §7 item 6;
app/services/work_profile_templates.py, app/services/work_profile.py).

The profile's `itemBlocks` — `{managing: main_till | all | none, localScope: machine | area | shop,
localWide: bool}` — is the shop's own POS setting `itemBlocks` (app/services/item_block_control.py) in
three choices. Pinned here:

* the check: optional in what is sent (absent / null: the defaults), always in what is stored and
  returned, never in a template (the golden file stays as it is);
* the mapping both ways (every choice round-trips), the setting's other keys kept;
* applied at once, at set-up (`POST /shops`) and on a save (`PUT`), logged, the tills told to pull —
  and what a till then gets (`parameters.itemBlocks`);
* read back from the shop as it stands (no stored profile; a profile saved before the field), copied
  with "העתק מסניף קיים";
* the company's role outweighing "הקופה הראשית" — said in the status, in Hebrew;
* who may change it: as the profile's fields that are not the Z.
"""
from __future__ import annotations

import itertools

import pytest

from app.models.company import Company
from app.models.shop import Shop
from app.models.user import UserRole
from app.services import item_block_control as C
from app.services import work_profile_templates as T
from test_independent_till import owner_setup, w  # noqa: F401
from test_work_profile import _quiet, changes, create, get, put, refused, seat, template, user_of  # noqa: F401

ALL_CHANNELS = ["pos", "kiosk", "online", "menu"]
QUICK = {"channels": ["kiosk"], "level": "shop", "duration": {"mode": "none"}}


def blocks(managing="main_till", localScope="area", localWide=False):
    return {"managing": managing, "localScope": localScope, "localWide": localWide}


def own(shop):
    return (shop.settings or {}).get("itemBlocks")


# ── The check ────────────────────────────────────────────────────────────────


class TestValidation:
    def test_absent_or_null_is_the_default(self):
        sent = next(t["profile"] for t in T.templates() if t["id"] == "quick_counter")
        assert T.ITEM_BLOCKS not in sent
        assert T.validate(sent)[T.ITEM_BLOCKS] == blocks()
        assert T.validate({**sent, T.ITEM_BLOCKS: None})[T.ITEM_BLOCKS] == blocks()
        assert T.DEFAULT_PROFILE[T.ITEM_BLOCKS] == blocks()

    def test_every_choice_is_taken(self):
        for managing, scope, wide in itertools.product(T.ITEM_BLOCKS_MANAGING, T.ITEM_BLOCKS_SCOPES, (True, False)):
            choice = blocks(managing, scope, wide)
            assert T.validate(template("quick_counter", itemBlocks=choice))[T.ITEM_BLOCKS] == choice

    @pytest.mark.parametrize("value, field, words", [
        (blocks(managing="main"), "itemBlocks.managing", "main_till, all, none"),
        (blocks(localScope="company"), "itemBlocks.localScope", "machine, area, shop"),
        (blocks(localWide="yes"), "itemBlocks.localWide", "true או false"),
        ({"managing": "all", "localScope": "area"}, "itemBlocks.localWide", "חסר"),
        ({**blocks(), "role": "managing"}, "itemBlocks.role", "לא מוכר"),
        ("all", "itemBlocks", "צריך אובייקט"),
    ])
    def test_refused_in_hebrew_with_the_field(self, w, value, field, words):
        profile = template("quick_counter", itemBlocks=value)
        with pytest.raises(T.ProfileInvalid) as err:
            T.validate(profile)
        assert err.value.field == field and words in err.value.message
        assert "חסימות פריטים" in err.value.message
        code, detail = refused(put, w, w.shop, profile)
        assert code == 422 and detail["code"] == "work_profile_invalid" and detail["field"] == field
        assert own(w.db.get(Shop, w.shop.id)) is None

    def test_worded_for_the_status(self):
        assert T.LABELS[T.ITEM_BLOCKS] == "חסימות פריטים"
        assert T.value_label(T.ITEM_BLOCKS, blocks("all", "shop", True)) == (
            "קופה מנהלת: כל הקופות; קופות רגילות: כל הסניף, גם קיוסק, הזמנות ותפריט"
        )
        assert "הקופה הראשית" in T.value_label(T.ITEM_BLOCKS, blocks())


# ── The mapping ──────────────────────────────────────────────────────────────


class TestMapping:
    def test_each_choice_onto_the_setting(self):
        assert T.item_blocks_own({}, blocks()) == {"localMaxLevel": "area", "localChannels": ["pos"]}
        assert T.item_blocks_own({}, blocks("all", "shop", True)) == {
            "role": "managing", "localMaxLevel": "shop", "localChannels": ALL_CHANNELS,
        }
        assert T.item_blocks_own({}, blocks("none", "machine"))["role"] == "local"

    def test_the_settings_other_keys_are_kept(self):
        before = {"role": "managing", "releaseMode": "any_in_shop", "localRelease": False,
                  "managingMaxLevel": "area", "quickDefaults": QUICK}
        out = T.item_blocks_own(before, blocks())
        assert "role" not in out  # the main till: the setting's default
        assert out == {"releaseMode": "any_in_shop", "localRelease": False, "managingMaxLevel": "area",
                       "quickDefaults": QUICK, "localMaxLevel": "area", "localChannels": ["pos"]}
        assert before["role"] == "managing"  # not changed in place

    def test_read_back(self):
        of = T.item_blocks_of_values
        assert of({}) == blocks()
        assert of({"role": "managing"})["managing"] == "all"
        assert of({"role": "local"})["managing"] == of({"role": "none"})["managing"] == "none"
        assert of({"localMaxLevel": "machine"})["localScope"] == "machine"
        assert of({"localChannels": ["pos", "kiosk"]})["localWide"] is True
        assert of({"localChannels": ["pos"]})["localWide"] is False
        assert T.item_blocks_of({"itemBlocks": {"role": "managing", "localMaxLevel": "bogus"}}) == blocks("all")

    def test_every_choice_round_trips(self):
        for managing, scope, wide in itertools.product(T.ITEM_BLOCKS_MANAGING, T.ITEM_BLOCKS_SCOPES, (True, False)):
            choice = blocks(managing, scope, wide)
            assert T.item_blocks_of_values(T.item_blocks_own({"quickDefaults": QUICK}, choice)) == choice
            assert C.clean(T.item_blocks_own({}, choice)) == T.item_blocks_own({}, choice)  # the setting's own check


# ── Set up a shop with it (§7 item 6) ────────────────────────────────────────


class TestSetUp:
    def test_chosen_at_set_up_applied_at_once(self, w):
        choice = blocks("all", "shop", True)
        shop = create(w, workProfile=template("quick_counter", itemBlocks=choice))
        out = shop.work_profile_status
        assert out["applied"] is True and out["profile"][T.ITEM_BLOCKS] == choice
        assert out["status"][T.ITEM_BLOCKS] == {"state": "applied"} and out["canEdit"][T.ITEM_BLOCKS] is True
        shop = w.db.get(Shop, shop.id)
        assert own(shop) == {"role": "managing", "localMaxLevel": "shop", "localChannels": ALL_CHANNELS}
        assert T.stored(shop.settings)[T.ITEM_BLOCKS] == choice
        assert {(c.parameter_key, c.scope_type) for c in changes(w, "itemBlocks")} == {("itemBlocks", "shop")}
        # "הגדרות ניהול המלאי" reads it as the shop's own.
        assert C.own_of(shop.settings)["role"] == "managing"

    def test_left_out_it_is_the_default_and_nothing_is_written(self, w):
        sent = next(t["profile"] for t in T.templates() if t["id"] == "restaurant_tables")
        shop = create(w, workProfile=sent)
        out = shop.work_profile_status
        assert out["applied"] is True and out["profile"][T.ITEM_BLOCKS] == blocks()
        assert out["status"][T.ITEM_BLOCKS] == {"state": "applied"}
        assert own(w.db.get(Shop, shop.id)) is None and not changes(w, "itemBlocks")

    def test_no_till_is_managing_until_one_is_marked(self, w):
        shop = create(w, workProfile=template("quick_counter", itemBlocks=blocks("none", "machine")))
        assert own(w.db.get(Shop, shop.id)) == {"role": "local", "localMaxLevel": "machine", "localChannels": ["pos"]}
        assert get(w, shop)["status"][T.ITEM_BLOCKS] == {"state": "applied"}


# ── A save on the shop page ──────────────────────────────────────────────────


class TestSave:
    def test_the_tills_get_it(self, w, _quiet):
        owner_setup(w)  # till 1 is the main till
        rules = C.till_out(w.db, w.six[0]), C.till_out(w.db, w.six[1])
        assert [r["role"] for r in rules] == ["managing", "local"]
        sent = len(_quiet)
        out = put(w, w.shop, template("restaurant_tables", itemBlocks=blocks("none", "shop", True)))
        assert out["status"][T.ITEM_BLOCKS] == {"state": "applied"} and T.ITEM_BLOCKS in out["changes"]
        assert len(_quiet) > sent  # the shop's tills pull their parameters
        w.db.expire_all()
        for machine in (w.six[0], w.six[1]):
            got = C.till_out(w.db, machine)
            assert (got["role"], got["localMaxLevel"], got["localChannels"]) == ("local", "shop", ALL_CHANNELS)
        # "כל הקופות": every till managing.
        put(w, w.shop, template("restaurant_tables", itemBlocks=blocks("all")))
        w.db.expire_all()
        assert {C.till_out(w.db, m)["role"] for m in w.six} == {"managing"}
        # Back to "הקופה הראשית": the main till only.
        put(w, w.shop, template("restaurant_tables"))
        w.db.expire_all()
        assert [C.till_out(w.db, m)["role"] for m in w.six[:2]] == ["managing", "local"]

    def test_the_settings_other_keys_stay_and_the_same_again_writes_nothing(self, w):
        w.shop.local_network = False
        w.shop.settings = {**(w.shop.settings or {}), "itemBlocks": {
            "role": "managing", "releaseMode": "any_in_shop", "quickDefaults": QUICK,
        }}
        w.db.commit()
        view = get(w, w.shop)
        assert view["stored"] is False and view["profile"][T.ITEM_BLOCKS] == blocks("all")
        assert view["status"][T.ITEM_BLOCKS] == {"state": "applied"}
        profile = template("quick_counter", itemBlocks=blocks(localScope="machine"))
        put(w, w.shop, profile)
        shop = w.db.get(Shop, w.shop.id)
        assert own(shop) == {"releaseMode": "any_in_shop", "quickDefaults": QUICK,
                             "localMaxLevel": "machine", "localChannels": ["pos"]}
        row = changes(w, "itemBlocks")
        assert len(row) == 1 and row[0].scope_type == "shop" and row[0].user_role == "super_admin"
        out = put(w, w.shop, profile)
        assert T.ITEM_BLOCKS not in out["changes"] and len(changes(w, "itemBlocks")) == 1

    def test_changed_in_the_stock_settings_after(self, w):
        w.shop.local_network = False
        w.db.commit()
        put(w, w.shop, template("quick_counter"))
        shop = w.db.get(Shop, w.shop.id)
        shop.settings = {**shop.settings, "itemBlocks": {"role": "managing"}}
        w.db.commit()
        entry = get(w, w.shop)["status"][T.ITEM_BLOCKS]
        assert entry["state"] == "blocked" and "כל הקופות" in entry["reason"]

    def test_a_profile_saved_before_the_field_reads_the_shop_as_it_stands(self, w):
        old = next(t["profile"] for t in T.templates() if t["id"] == "quick_counter")
        w.shop.local_network = False
        w.shop.settings = {**(w.shop.settings or {}), "workProfile": old,
                           "itemBlocks": {"role": "managing", "localChannels": ["pos", "kiosk"]}}
        w.db.commit()
        view = get(w, w.shop)
        assert view["stored"] is True and view["profile"][T.ITEM_BLOCKS] == blocks("all", "area", True)
        assert view["status"][T.ITEM_BLOCKS] == {"state": "applied"}
        # Saved again as read: what "הגדרות ניהול המלאי" set is left as it is.
        out = put(w, w.shop, view["profile"])
        assert T.ITEM_BLOCKS not in out["changes"]
        assert own(w.db.get(Shop, w.shop.id)) == {"role": "managing", "localChannels": ["pos", "kiosk"]}

    def test_copied_from_a_shop(self, w):
        choice = blocks("none", "shop", True)
        source = create(w, workProfile=template("event", itemBlocks=choice))
        copied = create(w, copyWorkProfileFromShopId=str(source.id))
        assert copied.work_profile_status["applied"] is True
        assert get(w, copied)["profile"][T.ITEM_BLOCKS] == choice
        assert own(w.db.get(Shop, copied.id)) == {"role": "local", "localMaxLevel": "shop", "localChannels": ALL_CHANNELS}
        # A shop with no profile: as it stands.
        owner_setup(w)
        w.shop.settings = {**(w.shop.settings or {}), "itemBlocks": {"role": "managing"}}
        w.db.commit()
        other = create(w, copyWorkProfileFromShopId=str(w.shop.id))
        assert get(w, other)["profile"][T.ITEM_BLOCKS] == blocks("all")


# ── The company's setting ─────────────────────────────────────────────────────


class TestAboveTheShop:
    def test_a_company_role_outweighs_the_main_till(self, w):
        company = w.db.get(Company, w.company.id)
        company.settings = {**(company.settings or {}), "itemBlocks": {"role": "local", "localMaxLevel": "shop"}}
        w.shop.local_network = False
        w.db.commit()
        # As the shop stands: what its tills inherit.
        assert get(w, w.shop)["profile"][T.ITEM_BLOCKS] == blocks("none", "shop")
        out = put(w, w.shop, template("quick_counter"))
        entry = out["status"][T.ITEM_BLOCKS]
        assert entry["state"] == "blocked"
        assert "ברמת החברה" in entry["reason"] and "קופה רגילה" in entry["reason"] and "הגדרות ניהול המלאי" in entry["reason"]
        # The scope is the shop's own now; only the role stays the company's.
        assert own(w.db.get(Shop, w.shop.id)) == {"localMaxLevel": "area", "localChannels": ["pos"]}
        # "כל הקופות" is the shop's own role: it wins.
        out = put(w, w.shop, template("quick_counter", itemBlocks=blocks("all")))
        assert out["status"][T.ITEM_BLOCKS] == {"state": "applied"}


# ── Who may ───────────────────────────────────────────────────────────────────


class TestPermissions:
    def test_a_distributor_changes_it_once_there_are_tills(self, w, seat):
        dist = user_of(w, UserRole.DISTRIBUTOR)
        shop = create(w, user=dist, workProfile=template("quick_counter"))
        from test_work_profile import pair

        pair(w, shop, by=dist)
        can = get(w, shop, dist)["canEdit"]
        assert can["zType"] is False and can[T.ITEM_BLOCKS] is True
        out = put(w, shop, template("quick_counter", itemBlocks=blocks("all")), dist)
        assert out["status"][T.ITEM_BLOCKS] == {"state": "applied"}
        assert own(w.db.get(Shop, shop.id))["role"] == "managing"

    def test_a_shop_manager_cannot(self, w):
        boss = user_of(w, UserRole.SHOP_MANAGER, shop_id=w.shop.id)
        view = get(w, w.shop, boss)
        assert view["canEdit"][T.ITEM_BLOCKS] is False
        code, detail = refused(put, w, w.shop, {**view["profile"], T.ITEM_BLOCKS: blocks("all")}, boss)
        assert code == 403 and detail["code"] == "work_profile_forbidden"
        assert own(w.db.get(Shop, w.shop.id)) is None
