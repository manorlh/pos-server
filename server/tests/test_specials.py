"""
Specials: the banner on the tills ("באנר מבצעים") and the upsell "חלון בחירה".

What each class pins:

* **Banners** — a till message shown as a slim strip instead of full-screen: listed to
  the till under `banners` (never in `items`, so a till that predates banners shows
  nothing), live whether acknowledged or not, until its end or a cancel; an optional
  product of the tenant's and a colour preset; while it shows its text, product, colour
  and end can change, never when or how it went out. Full-screen stays the default.
* **Upsell rules, compatible** — a body from before options (one `productId`) is stored
  and sent exactly as before; the till payload keeps `productId` only for what a till
  that predates options can honour.
* **Upsell rules, new** — several options (products and/or a category), a prompt, the
  window, where, "every order", skip-if-present and once-per-order; validation.
* **Stats** — declined and the options taken, merged as the larger count like the rest,
  and in the report.

Runs on the worlds of tests/test_shop_areas.py and tests/test_menu.py.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks
from pydantic import ValidationError

from app.models.menu import UpsellRule, UpsellStat
from app.models.till_message import TillMessage
from app.routers import menu as MR
from app.routers import till_messages as R
from app.schemas.menu import UpsellIn, UpsellStatsIn
from app.schemas.till_message import TillMessageCreate, TillMessageUpdate
from app.services import menu as M
from app.services import menu_broadcast as B
from shift_world import TODAY
from test_menu import _window, menu, pull as catalog_pull  # noqa: F401
from test_shop_areas import _ctx, refused, w  # noqa: F401
from test_till_messages import ack, listed

UTC = timezone.utc


def send(w, *, body="מבצע: שתייה ב־5 ₪", level="shop", target=None, **fields):
    tasks = BackgroundTasks()
    return R.send_till_message(
        TillMessageCreate(body=body, targetLevel=level, targetId=(target or w.shop).id, **fields),
        tasks,
        **_ctx(w),
    )


def fetch(w, till):
    return R.get_own_till_messages(str(till.id), machine=till, db=w.db)


def edit(w, message_id, **fields):
    return R.update_till_message(str(message_id), TillMessageUpdate(**fields), **_ctx(w))


def row(w, message_id):
    return next(i for i in listed(w)["items"] if str(i["id"]) == str(message_id))


# ── Banners ───────────────────────────────────────────────────────────────────


class TestBanners:
    def test_full_screen_stays_the_default_and_never_lists_as_a_banner(self, w):
        out = send(w, body="קראו אותי")
        assert out["display"] == "fullscreen" and out["productId"] is None and out["color"] is None
        got = fetch(w, w.tills[0])
        assert [i["body"] for i in got["items"]] == ["קראו אותי"] and got["banners"] == []

    def test_a_banner_is_listed_apart_with_its_product_and_colour(self, menu):
        out = send(menu, display="banner", productId=menu.cola.id, color="green", title="מבצע")
        assert (out["display"], out["productName"], out["color"]) == ("banner", "cola", "green")
        got = fetch(menu, menu.tills[0])
        assert got["items"] == []  # a till that predates banners shows nothing
        [banner] = got["banners"]
        assert banner["id"] == str(out["id"]) and banner["title"] == "מבצע"
        assert (banner["productId"], banner["productName"], banner["color"]) == (str(menu.cola.id), "cola", "green")
        assert banner["expiresAt"] is None and banner["display"] == "banner"
        assert row(menu, out["id"])["counts"]["delivered"] == 1

    def test_closing_it_on_the_till_records_who_and_it_keeps_showing(self, w):
        out = send(w, display="banner")
        ack(w, w.tills[0], out["id"], name="דנה")
        assert [b["id"] for b in fetch(w, w.tills[0])["banners"]] == [str(out["id"])]
        assert row(w, out["id"])["counts"]["acknowledged"] == 1

    def test_it_ends_at_its_end_or_when_cancelled(self, w):
        soon = datetime.now(UTC) + timedelta(hours=2)
        out = send(w, display="banner", expiresAt=soon)
        [banner] = fetch(w, w.tills[0])["banners"]
        assert datetime.fromisoformat(banner["expiresAt"]) == soon
        msg = w.db.get(TillMessage, uuid.UUID(str(out["id"])))
        msg.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        w.db.commit()
        assert fetch(w, w.tills[0])["banners"] == []

        other = send(w, display="banner")
        R.cancel_till_message(str(other["id"]), BackgroundTasks(), **_ctx(w))
        assert fetch(w, w.tills[0])["banners"] == []

    def test_product_and_colour_are_a_banners_only(self):
        with pytest.raises(ValidationError):
            TillMessageCreate(body="x", targetLevel="shop", targetId=uuid.uuid4(), productId=uuid.uuid4())
        with pytest.raises(ValidationError):
            TillMessageCreate(body="x", targetLevel="shop", targetId=uuid.uuid4(), color="green")
        with pytest.raises(ValidationError):
            TillMessageCreate(body="x", targetLevel="shop", targetId=uuid.uuid4(), display="banner", color="pink")
        with pytest.raises(ValidationError):
            TillMessageCreate(body="x", targetLevel="shop", targetId=uuid.uuid4(), display="ticker")
        ok = TillMessageCreate(body="x", targetLevel="shop", targetId=uuid.uuid4(), display="banner", color=" ")
        assert ok.color is None

    def test_a_product_of_another_tenant_or_none_is_refused(self, w):
        assert refused(send, w, display="banner", productId=uuid.uuid4()).detail == "till_message_product_not_found"
        assert w.db.query(TillMessage).count() == 0

    def test_a_banner_that_went_out_changes_its_text_product_colour_and_end(self, menu):
        out = send(menu, display="banner", productId=menu.cola.id, color="amber")
        assert row(menu, out["id"])["canEdit"] is True
        end = datetime.now(UTC) + timedelta(days=1)
        edited = edit(menu, out["id"], body="ספרייט במבצע", productId=menu.fries.id, color="blue", expiresAt=end)
        assert (edited["body"], edited["productName"], edited["color"]) == ("ספרייט במבצע", "fries", "blue")
        [banner] = fetch(menu, menu.tills[0])["banners"]
        assert (banner["body"], banner["productName"]) == ("ספרייט במבצע", "fries")
        # No product; and nothing about when or how it went out.
        assert edit(menu, out["id"], productId=None)["productId"] is None
        assert refused(edit, menu, out["id"], display="fullscreen").status_code == 409
        assert refused(edit, menu, out["id"], sendAt=datetime.now(UTC) + timedelta(hours=1)).status_code == 409
        assert refused(edit, menu, out["id"], expiresAt=datetime.now(UTC) - timedelta(hours=1)).detail == (
            "till_message_expiry_in_past"
        )

    def test_a_full_screen_message_that_went_out_is_still_not_editable(self, w):
        out = send(w)
        assert row(w, out["id"])["canEdit"] is False
        assert refused(edit, w, out["id"], body="x").detail == "till_message_not_editable"

    def test_a_scheduled_banner_goes_out_as_a_banner_and_may_switch_before(self, w, monkeypatch):
        from app.services import till_messages as TM

        now = datetime(2026, 10, 6, 6, 0, tzinfo=UTC)
        monkeypatch.setattr(TM, "_now", lambda: now)
        out = send(w, display="banner", scheduleKind="scheduled", sendAt=now + timedelta(hours=1))
        assert fetch(w, w.tills[0])["banners"] == []
        assert edit(w, out["id"], display="fullscreen")["display"] == "fullscreen"
        assert edit(w, out["id"], display="banner", color="red")["color"] == "red"
        now = now + timedelta(hours=2)
        got = fetch(w, w.tills[0])
        assert got["items"] == [] and [b["color"] for b in got["banners"]] == ["red"]


# ── Upsell rules ──────────────────────────────────────────────────────────────


def create_rule(w, body):
    return MR.create_upsell(UpsellIn.model_validate(body), BackgroundTasks(), **_ctx(w))


def till_rules(w):
    return {u["name"]: u for u in catalog_pull(w, w.tills[0]).menu["upsells"]}


class TestUpsellsCompatible:
    def test_a_body_from_before_options_is_stored_and_sent_as_before(self, menu):
        out = create_rule(menu, {
            "name": "fries?", "triggerType": "product", "triggerIds": [str(menu.burger.id)],
            "action": "add", "productId": str(menu.fries.id),
        })
        rule = menu.db.get(UpsellRule, uuid.UUID(out["id"]))
        assert rule.options is None and rule.product_id == menu.fries.id
        # "both", as stored before the kiosk had a place: every channel it reached then.
        assert (rule.display, rule.place, rule.skip_if_present, rule.once_per_order) == ("card", "quick,tables,kiosk", True, False)
        assert out["options"] == [{"type": "product", "id": str(menu.fries.id), "name": "fries"}]
        sent = till_rules(menu)["fries?"]
        assert sent["productId"] == str(menu.fries.id)
        assert sent["options"] == [{"type": "product", "id": str(menu.fries.id)}]
        assert (sent["display"], sent["where"], sent["skipIfPresent"], sent["oncePerOrder"]) == ("card", "both", True, False)

    def test_a_rule_saved_before_the_columns_existed_reads_the_same(self, menu):
        # As a row read before the columns had values: never added, so nothing is defaulted.
        rule = UpsellRule(
            id=uuid.uuid4(), tenant_id=menu.tenant.id, name="old", trigger_type="product",
            trigger_ids=[str(menu.burger.id)], action="add", product_id=menu.cola.id,
        )
        assert (rule.options, rule.display, rule.place, rule.skip_if_present) == (None, None, None, None)
        sent = M.upsell_out(rule, {str(menu.cola.id): "cola"}, True)
        assert (sent["display"], sent["where"], sent["skipIfPresent"], sent["oncePerOrder"]) == ("card", "both", True, False)
        assert sent["options"] == [{"type": "product", "id": str(menu.cola.id), "name": "cola"}]

    def test_a_till_that_predates_options_gets_only_what_it_can_honour(self, menu):
        base = {"triggerType": "product", "triggerIds": [str(menu.burger.id)], "action": "add"}
        create_rule(menu, {**base, "name": "card", "productId": str(menu.cola.id)})
        create_rule(menu, {**base, "name": "window", "productId": str(menu.cola.id), "display": "popup"})
        create_rule(menu, {**base, "name": "tables", "productId": str(menu.cola.id), "where": "tables"})
        create_rule(menu, {**base, "name": "two", "options": [
            {"type": "product", "id": str(menu.cola.id)}, {"type": "product", "id": str(menu.fries.id)},
        ]})
        sent = till_rules(menu)
        assert sent["card"]["productId"] == str(menu.cola.id)
        assert [sent[n]["productId"] for n in ("window", "tables", "two")] == [None, None, None]
        # The new till reads the options whatever productId says.
        assert [o["id"] for o in sent["two"]["options"]] == [str(menu.cola.id), str(menu.fries.id)]


class TestUpsellsNew:
    def test_the_drink_window(self, menu):
        """נקניקיה → 'האם הצעת שתייה ללקוח?' → the drinks."""
        out = create_rule(menu, {
            "name": "שתייה ליד מנה", "triggerType": "product", "triggerIds": [str(menu.burger.id)],
            "options": [{"type": "category", "id": str(menu.drinks.id)}, {"type": "product", "id": str(menu.fries.id)}],
            "prompt": " האם הצעת שתייה ללקוח? ", "display": "popup", "where": "tables", "oncePerOrder": True,
        })
        rule = menu.db.get(UpsellRule, uuid.UUID(out["id"]))
        assert rule.product_id is None and rule.options[0] == {"type": "category", "id": str(menu.drinks.id)}
        assert out["prompt"] == "האם הצעת שתייה ללקוח?" and out["productId"] is None
        assert [o["name"] for o in out["options"]] == ["Drinks", "fries"]
        assert (out["display"], out["where"], out["oncePerOrder"], out["skipIfPresent"]) == ("popup", "tables", True, True)
        sent = till_rules(menu)["שתייה ליד מנה"]
        assert sent["options"][0] == {"type": "category", "id": str(menu.drinks.id), "categoryIds": [str(menu.drinks.id)]}
        assert sent["options"][1] == {"type": "product", "id": str(menu.fries.id)}
        assert (sent["prompt"], sent["display"], sent["where"]) == ("האם הצעת שתייה ללקוח?", "popup", "tables")

    def test_a_category_option_arrives_with_its_sub_categories(self, menu):
        create_rule(menu, {
            "name": "food", "triggerType": "product", "triggerIds": [str(menu.cola.id)],
            "options": [{"type": "category", "id": str(menu.food.id)}],
        })
        [option] = till_rules(menu)["food"]["options"]
        assert set(option["categoryIds"]) == {str(menu.food.id), str(menu.burgers.id)}

    def test_every_order(self, menu):
        out = create_rule(menu, {
            "name": "קינוח?", "triggerType": "order", "triggerIds": [str(menu.burger.id)],
            "options": [{"type": "product", "id": str(menu.fries.id)}], "display": "card",
        })
        assert (out["triggerType"], out["triggerIds"], out["display"]) == ("order", [], "popup")
        sent = till_rules(menu)["קינוח?"]
        assert (sent["triggerType"], sent["triggerIds"], sent["productId"]) == ("order", [], None)
        with pytest.raises(ValidationError):
            UpsellIn.model_validate({"name": "x", "triggerType": "order", "action": "upgrade",
                                     "productId": str(menu.meal.id)})

    def test_validation(self, menu):
        fries = {"type": "product", "id": str(menu.fries.id)}
        cola = {"type": "product", "id": str(menu.cola.id)}
        bad = [
            # Nothing offered.
            {"name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)]},
            {"name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)], "options": []},
            # A product or category trigger names something.
            {"name": "x", "triggerType": "category", "options": [fries]},
            # An upgrade is one product.
            {"name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)], "action": "upgrade",
             "options": [fries, cola]},
            {"name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)], "action": "upgrade",
             "options": [{"type": "category", "id": str(menu.drinks.id)}]},
            # Itself, through the options.
            {"name": "x", "triggerType": "product", "triggerIds": [str(menu.fries.id)], "options": [cola, fries]},
            {"name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)], "options": [fries],
             "display": "banner"},
            {"name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)], "options": [fries],
             "where": "kiosk"},
        ]
        for body in bad:
            with pytest.raises(ValidationError):
                UpsellIn.model_validate(body)
        twice = UpsellIn.model_validate({"name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)],
                                         "options": [fries, fries]})
        assert len(twice.options) == 1 and twice.product_id == menu.fries.id

    def test_an_option_of_another_tenant_is_refused(self, menu):
        e = refused(create_rule, menu, {
            "name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)],
            "options": [{"type": "category", "id": str(uuid.uuid4())}],
        })
        assert e.status_code == 400

    def test_editing_back_to_one_product_is_a_plain_rule_again(self, menu):
        out = create_rule(menu, {
            "name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)],
            "options": [{"type": "product", "id": str(menu.cola.id)}, {"type": "product", "id": str(menu.fries.id)}],
        })
        MR.update_upsell(out["id"], UpsellIn.model_validate({
            "name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)], "productId": str(menu.cola.id),
        }), BackgroundTasks(), **_ctx(menu))
        rule = menu.db.get(UpsellRule, uuid.UUID(out["id"]))
        assert rule.options is None and rule.product_id == menu.cola.id

    def test_the_broadcast_review_ignores_fields_an_older_snapshot_lacks(self, menu):
        create_rule(menu, {
            "name": "x", "triggerType": "product", "triggerIds": [str(menu.burger.id)], "productId": str(menu.cola.id),
        })
        new = {"menu": catalog_pull(menu, menu.tills[0]).menu}
        old_rule = {k: v for k, v in new["menu"]["upsells"][0].items() if k not in B._UPSELL_NEW_FIELDS}
        old = {"menu": {**new["menu"], "upsells": [old_rule]}}
        assert B.diff(old, new)["menu"] == []
        changed = {"menu": {**new["menu"], "upsells": [{**new["menu"]["upsells"][0], "prompt": "שתייה?"}]}}
        [item] = B.diff(new, changed)["menu"]
        assert item["detail"] == "upsell" and item["changes"][0]["field"] == "prompt"


# ── Stats ─────────────────────────────────────────────────────────────────────


class TestUpsellChannels:
    """
    "הגדלת מכירה" — one feature, three channels (docs/SPEC_KIOSK.md §21): where a rule is
    offered (quick / tables / kiosk), the steps of an order ("transition"), the window's own
    picture; old rules and old tills unchanged.
    """

    base = {"action": "add"}

    def rule(self, menu, **body):
        return create_rule(menu, {"name": "r", "options": [{"type": "product", "id": str(menu.fries.id)}], **body})

    def sent(self, menu):
        menu_pull = catalog_pull(menu, menu.tills[0]).menu
        return {u["name"]: u for u in menu_pull["upsells"]}, {u["name"]: u for u in menu_pull["kioskUpsells"]}

    def test_where_keeps_its_meaning_and_the_kiosk_had_quick_and_both(self, menu):
        trig = {"triggerType": "product", "triggerIds": [str(menu.burger.id)]}
        for where, places in (("both", ["quick", "tables", "kiosk"]), ("quick", ["quick", "kiosk"]), ("tables", ["tables"])):
            out = self.rule(menu, name=where, where=where, **trig)
            assert out["places"] == places and out["where"] == where, where
        assert M.upsell_places_of("both") == ("quick", "tables") and M.upsell_places_of(None) == ("quick", "tables")

    def test_places_choose_the_channels_and_a_kiosk_only_rule_never_reaches_an_old_till(self, menu):
        trig = {"triggerType": "product", "triggerIds": [str(menu.burger.id)]}
        self.rule(menu, name="kiosk", places=["kiosk"], **trig)
        self.rule(menu, name="till", places=["quick", "tables"], **trig)
        self.rule(menu, name="quick+kiosk", places=["kiosk", "quick"], **trig)
        upsells, kiosk = self.sent(menu)
        assert "kiosk" not in upsells and kiosk["kiosk"]["places"] == ["kiosk"]
        assert upsells["till"]["places"] == ["quick", "tables"] and upsells["till"]["where"] == "both"
        assert upsells["quick+kiosk"]["places"] == ["quick", "kiosk"] and upsells["quick+kiosk"]["where"] == "quick"
        stored = menu.db.get(UpsellRule, uuid.UUID(kiosk["kiosk"]["id"]))
        assert stored.place == "kiosk"
        with pytest.raises(ValidationError):
            UpsellIn.model_validate({"name": "x", **trig, "places": [], "productId": str(menu.fries.id)})

    def test_transition_steps_per_channel(self, menu):
        out = self.rule(menu, name="start", triggerType="transition", triggerIds=["order_start", "to_cart"], places=["kiosk"], display="card")
        assert (out["triggerType"], out["triggerIds"], out["display"]) == ("transition", ["order_start", "to_cart"], "popup")
        # A step on one of the chosen places is enough (ignored where it does not exist).
        out = self.rule(menu, name="mixed", triggerType="transition", triggerIds=["before_send", "to_cart"], places=["tables", "kiosk"])
        assert out["triggerIds"] == ["before_send", "to_cart"]
        for bad in (["to_cart"], ["after_pay"], ["nonsense"], ["to_pay:x"], ["enter_category:not-an-id"], []):
            with pytest.raises(ValidationError):
                UpsellIn.model_validate({"name": "x", "triggerType": "transition", "triggerIds": bad, "places": ["quick"],
                                         "productId": str(menu.fries.id)})
        with pytest.raises(ValidationError):
            UpsellIn.model_validate({"name": "x", "triggerType": "transition", "triggerIds": ["to_pay"], "places": ["quick"],
                                     "action": "upgrade", "productId": str(menu.meal.id)})

    def test_entering_a_category_names_it_and_reaches_its_sub_categories(self, menu):
        out = self.rule(menu, name="food", triggerType="transition", places=["kiosk", "quick"],
                        triggerIds=[f"enter_category:{menu.food.id}"])
        assert out["triggerNames"] == ["Food"]
        upsells, _kiosk = self.sent(menu)
        assert set(upsells["food"]["triggerIds"]) == {f"enter_category:{menu.food.id}", f"enter_category:{menu.burgers.id}"}
        assert upsells["food"]["display"] == "popup"
        with pytest.raises(Exception):
            self.rule(menu, name="ghost", triggerType="transition", places=["kiosk"], triggerIds=[f"enter_category:{uuid.uuid4()}"])

    def test_the_special_has_its_own_picture(self, menu):
        out = self.rule(menu, name="special", triggerType="transition", triggerIds=["order_start"], places=["kiosk"],
                        imageUrl=" /media/specials/breakfast.png ", prompt="ארוחת בוקר ב-₪1")
        assert out["imageUrl"] == "/media/specials/breakfast.png"
        _u, kiosk = self.sent(menu)
        # A path on this server reaches a device as an address on it.
        assert kiosk["special"]["imageUrl"].startswith("http") and kiosk["special"]["imageUrl"].endswith("/media/specials/breakfast.png")
        with pytest.raises(ValidationError):
            UpsellIn.model_validate({"name": "x", "triggerType": "order", "productId": str(menu.fries.id), "imageUrl": "javascript:alert(1)"})

    def test_the_editor_gets_the_steps_of_each_channel(self, menu):
        listed_rules = MR.list_upsells(**_ctx(menu))
        assert listed_rules["steps"]["kiosk"] == ["order_start", "to_catalog", "enter_category", "to_cart", "to_pay"]
        assert "before_send" in listed_rules["steps"]["tables"] and "before_send" not in listed_rules["steps"]["quick"]
        assert all("after_pay" not in codes for codes in listed_rules["steps"].values())

    def test_an_old_rule_on_the_till_is_sent_as_before(self, menu):
        # As stored before the kiosk had a place (place "both"): the till's payload unchanged.
        rule = UpsellRule(
            id=uuid.uuid4(), tenant_id=menu.tenant.id, name="legacy", trigger_type="product",
            trigger_ids=[str(menu.burger.id)], action="add", product_id=menu.cola.id, place="both", display="card",
        )
        menu.db.add(rule)
        menu.db.flush()
        upsells, kiosk = self.sent(menu)
        assert "legacy" not in kiosk
        assert (upsells["legacy"]["where"], upsells["legacy"]["places"], upsells["legacy"]["productId"]) == ("both", ["quick", "tables"], str(menu.cola.id))


class TestUpsellStats:
    def test_declined_and_options_taken_merge_as_the_larger_count_and_reach_the_report(self, menu):
        out = create_rule(menu, {
            "name": "שתייה", "triggerType": "order",
            "options": [{"type": "product", "id": str(menu.cola.id)}, {"type": "product", "id": str(menu.fries.id)}],
        })
        till = menu.tills[0]
        day = str(TODAY)

        def report(stats):
            MR.post_upsell_stats(str(till.id), UpsellStatsIn.model_validate({"stats": stats}), till, menu.db)

        report([{"ruleId": out["id"], "day": day, "shown": 5, "accepted": 3, "dismissed": 1, "declined": 1,
                 "acceptedOptions": {str(menu.cola.id): 2, str(menu.fries.id): 1}}])
        # A retry or a late report never counts twice; a till that predates options sends none.
        report([{"ruleId": out["id"], "day": day, "shown": 4, "accepted": 2, "dismissed": 1,
                 "acceptedOptions": {str(menu.cola.id): 1}}])
        report([{"ruleId": out["id"], "day": day, "shown": 5, "accepted": 3, "dismissed": 1}])
        stat = menu.db.query(UpsellStat).one()
        assert (stat.shown, stat.accepted, stat.dismissed, stat.declined) == (5, 3, 1, 1)
        assert stat.accepted_options == {str(menu.cola.id): 2, str(menu.fries.id): 1}

        got = M.build_upsell_report(menu.db, menu.admin, menu.tenant.id, _window(menu))
        [r] = got["rows"]
        assert (r["shown"], r["accepted"], r["dismissed"], r["declined"]) == (5, 3, 1, 1)
        assert r["productName"] == "cola, fries"
        assert [(o["name"], o["count"]) for o in r["optionsTaken"]] == [("cola", 2), ("fries", 1)]
        assert got["totals"]["declined"] == 1

    def test_an_option_count_is_bounded(self):
        with pytest.raises(ValidationError):
            UpsellStatsIn.model_validate({"stats": [{"ruleId": str(uuid.uuid4()), "day": "2026-10-06",
                                                     "acceptedOptions": {"x": -1}}]})
