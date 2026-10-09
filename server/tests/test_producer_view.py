"""
"עמדת מפיק" — the producer's read-only portal and its scoping (app/services/report_events/producer.py,
production.py, app/routers/producer.py, app/routers/event_producers.py, the PRODUCER_VIEW gate in
app/services/dashboard_access.py).

What is pinned:

* **Every endpoint** — walked from `app.routes` through the real app with a producer's token:
  every dashboard route that is not the producer's (nor one of the few GETs about themselves)
  is refused (403 `producer_only`), before the route does anything.
* **Only their events** — each producer route answers for a granted event only; another event
  of the same shop, another shop's event, another organization's, a revoked grant, a random id:
  the same 404. Staff are refused the producer routes.
* **What they see** — the sales (totals, by the hour, items) as the event's documents say; the
  vouchers of the linked batches only (another batch, a reversed redemption, another shop's
  redemption left out); the settlement only when the owner opened it, at the production price.
* **The owner's side** — inviting by e-mail (a staff e-mail is refused), the organization
  membership, revoking (the account is deactivated when no event is left), the settings
  (a batch of another company refused).

Runs on an in-memory SQLite database (one connection), through the real app with legacy tokens.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from shift_world import accept_str_uuids  # (and JSONB on SQLite)
from app.database import Base, get_db
from app.main import app
from app.middleware import auth as auth_mw
from app.models.company import Company
from app.models.dashboard_access import DashboardAccessProfile
from app.models.pos_machine import PairingStatus, POSMachine
from app.models.prepaid_voucher import PrepaidVoucher, PrepaidVoucherBatch, PrepaidVoucherRedemption, PrepaidVoucherType
from app.models.report_event import ProducerEventGrant, ReportEvent, ReportEventMachine
from app.models.shop import Shop
from app.models.tenant import Tenant
from app.models.tenant_membership import TenantMembership, TenantMembershipRole
from app.models.transaction import Transaction, TransactionStatus
from app.models.transaction_item import TransactionItem
from app.models.user import User, UserRole
from app.routers import producer as producer_router
from app.services import dashboard_access as DA
from app.services.auth import create_access_token
from app.services.report_events import producer as PR
from app.services.report_events import production as PROD

START = datetime(2026, 9, 27, 15, 0, tzinfo=timezone.utc)  # 18:00 local
END = datetime(2026, 9, 27, 20, 0, tzinfo=timezone.utc)
NOW = START + timedelta(hours=2)
USER_DEPENDENCIES = {auth_mw.get_current_user, auth_mw.get_current_user_flexible, auth_mw.get_pos_machine_for_sync_path}


# ── The world ────────────────────────────────────────────────────────────────


def _user(db, username, role, tenant, *, company=None, shop=None):
    u = User(id=uuid.uuid4(), username=username, email=f"{username}@example.com", role=role, tenant_id=tenant.id,
             company_id=company.id if company else None, shop_id=shop.id if shop else None, is_active=True)
    db.add(u)
    db.flush()
    if role != UserRole.SUPER_ADMIN:
        db.add(TenantMembership(tenant_id=tenant.id, user_id=u.id, role=TenantMembershipRole.TENANT_MEMBER, is_default=True))
        db.flush()
    return u


def _make_world():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    for table in Base.metadata.sorted_tables:
        table.create(engine)
    db = sessionmaker(bind=engine)()
    w = SimpleNamespace(db=db)
    w.tenant = Tenant(id=uuid.uuid4(), name="Fest", slug="fest", timezone="Asia/Jerusalem")
    w.other_tenant = Tenant(id=uuid.uuid4(), name="Other", slug="other", timezone="Asia/Jerusalem")
    db.add_all([w.tenant, w.other_tenant])
    db.flush()
    w.company = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Festivals")
    w.other_company = Company(id=uuid.uuid4(), tenant_id=w.tenant.id, name="Cafe")
    w.foreign_company = Company(id=uuid.uuid4(), tenant_id=w.other_tenant.id, name="Foreign")
    db.add_all([w.company, w.other_company, w.foreign_company])
    db.flush()
    w.shop = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="Park", settings={})
    w.other_shop = Shop(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=w.company.id, name="Beach", settings={})
    w.foreign_shop = Shop(id=uuid.uuid4(), tenant_id=w.other_tenant.id, company_id=w.foreign_company.id, name="F", settings={})
    db.add_all([w.shop, w.other_shop, w.foreign_shop])
    db.flush()
    w.admin = _user(db, "admin", UserRole.SUPER_ADMIN, w.tenant)
    w.manager = _user(db, "manager", UserRole.COMPANY_MANAGER, w.tenant, company=w.company)
    db.add(DashboardAccessProfile(user_id=w.manager.id, full_access=True, sections={}))  # as every existing user

    def till(name, shop, tenant):
        m = POSMachine(id=uuid.uuid4(), tenant_id=tenant.id, shop_id=shop.id, distributor_id=w.admin.id, name=name,
                       machine_code=f"M-{name}", pos_number=name[-1], is_active=True, pairing_status=PairingStatus.ASSIGNED)
        db.add(m)
        return m

    w.t1, w.t2 = till("Stage 1", w.shop, w.tenant), till("Stage 2", w.shop, w.tenant)
    w.beach_till = till("Beach 1", w.other_shop, w.tenant)
    w.foreign_till = till("Foreign 1", w.foreign_shop, w.other_tenant)
    db.flush()

    def event(name, shop, tills, tenant=None, company=None):
        e = ReportEvent(id=uuid.uuid4(), tenant_id=(tenant or w.tenant).id, company_id=(company or w.company).id,
                        shop_id=shop.id, name=name, starts_at=START, ends_at=END, timezone="Asia/Jerusalem", status="draft")
        db.add(e)
        db.flush()
        for t in tills:
            db.add(ReportEventMachine(id=uuid.uuid4(), event_id=e.id, machine_id=t.id))
        db.flush()
        return e

    w.event = event("Main stage", w.shop, [w.t1])
    w.sibling = event("Side stage", w.shop, [w.t2])
    w.beach = event("Beach party", w.other_shop, [w.beach_till])
    w.foreign = event("Foreign", w.foreign_shop, [w.foreign_till], tenant=w.other_tenant, company=w.foreign_company)
    db.commit()
    return w


@pytest.fixture
def w(monkeypatch):
    accept_str_uuids(monkeypatch)
    world = _make_world()
    monkeypatch.setattr(auth_mw, "verify_clerk_token", lambda _token: None)
    monkeypatch.setattr(PR, "send_clerk_invitation", lambda email, url: "sent")
    monkeypatch.setattr(producer_router, "_now", lambda: NOW)

    def _db():
        yield world.db

    app.dependency_overrides[get_db] = _db
    world.client = TestClient(app, raise_server_exceptions=False)
    _grant, world.producer, _ = PR.invite(world.db, world.admin, world.event, email="Producer@Example.com", name="Dana")
    world.db.commit()
    yield world
    app.dependency_overrides.pop(get_db, None)
    world.db.close()


def _headers(user, tenant=None) -> dict:
    out = {"Authorization": f"Bearer {create_access_token({'sub': user.username})}"}
    if tenant is not None:
        out["X-Tenant-Id"] = str(tenant.id)
    return out


def _doc(w, till, minutes, total, *, refund=False, items=()):
    tx = Transaction(
        id=uuid.uuid4(), tenant_id=till.tenant_id, machine_id=till.id, shop_id=till.shop_id,
        transaction_number=str(uuid.uuid4().int)[:8], status=TransactionStatus.COMPLETED,
        document_type=330 if refund else 320, payment_method="cash", total_amount=Decimal(total),
        document_discount=Decimal("0"), tip_amount=Decimal("0"), created_at=START + timedelta(minutes=minutes),
        updated_at=START, server_received_at=START,
    )
    w.db.add(tx)
    w.db.flush()
    for name, qty, price in items:
        w.db.add(TransactionItem(id=uuid.uuid4(), transaction_id=tx.id, product_id=None, product_name=name,
                                 quantity=Decimal(qty), unit_price=Decimal(price), total_price=Decimal(price) * Decimal(qty)))
    w.db.flush()
    return tx


def _batch(w, name, *, company=None, event_name=None, **cols):
    """A batch of its own type (the vouchers core: every batch has one); [cols] e.g. production_price (agorot)."""
    owner = (company or w.company).id
    vtype = PrepaidVoucherType(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=owner, name=name)
    w.db.add(vtype)
    w.db.flush()
    b = PrepaidVoucherBatch(id=uuid.uuid4(), tenant_id=w.tenant.id, company_id=owner, name=name,
                            event_name=event_name, type_id=vtype.id, type_name=name, **cols)
    w.db.add(b)
    w.db.flush()
    return b


def _redeem(w, batch, till, minutes, *, qty=1, reversed_=False, voucher=None, serial=None):
    v = voucher or PrepaidVoucher(id=uuid.uuid4(), tenant_id=w.tenant.id, batch_id=batch.id,
                                  serial=serial if serial is not None else int(uuid.uuid4().int % 100000),
                                  code=uuid.uuid4().hex[:12].upper(), remaining=[])
    if voucher is None:
        w.db.add(v)
        w.db.flush()
    w.db.add(PrepaidVoucherRedemption(
        id=uuid.uuid4(), tenant_id=w.tenant.id, voucher_id=v.id, batch_id=batch.id, machine_id=till.id, shop_id=till.shop_id,
        client_request_id=uuid.uuid4().hex, items=[{"name": "x", "quantity": qty}], redeemed_at=START + timedelta(minutes=minutes),
        reversed_at=START + timedelta(minutes=minutes + 1) if reversed_ else None,
    ))
    w.db.flush()
    return v


# ── Every endpoint ───────────────────────────────────────────────────────────


def _accepts_user(route: APIRoute) -> bool:
    stack = list(route.dependant.dependencies)
    while stack:
        dep = stack.pop()
        if dep.call in USER_DEPENDENCIES:
            return True
        stack.extend(dep.dependencies)
    return False


def _routes():
    for route in app.routes:
        if isinstance(route, APIRoute) and _accepts_user(route):
            for method in sorted(route.methods):
                yield method, route


def test_a_producer_reaches_nothing_but_their_own_routes(w):
    headers = _headers(w.producer, w.tenant)
    leaked, allowed = [], []
    for method, route in _routes():
        path = DA._api_path(route.path)
        rule = DA.classify(route, method)
        if rule.kind == "producer" or (method == "GET" and path in DA.PRODUCER_SELF_PATHS):
            allowed.append(f"{method} {path}")
            continue
        url = re.sub(r"\{[^}]+\}", lambda _m: str(uuid.uuid4()), route.path)
        response = w.client.request(method, url, headers=headers, json={} if method not in ("GET", "HEAD", "DELETE") else None)
        detail = response.json().get("detail") if response.headers.get("content-type", "").startswith("application/json") else None
        # A till's own path may refuse a dashboard token outright (`machine_token_required`) first.
        refused_as_till = rule.kind == "till" and response.status_code == 403
        if not refused_as_till and not (
            response.status_code == 403 and isinstance(detail, dict) and detail.get("code") == DA.PRODUCER_ONLY
        ):
            leaked.append(f"{method} {route.path} → {response.status_code} {response.text[:100]}")
    assert not leaked, "A producer reached:\n" + "\n".join(leaked)
    assert sorted(allowed) == sorted([
        "GET /auth/me", "GET /dashboard-access/me", "GET /producer/events", "GET /producer/events/{event_id}",
        "GET /producer/events/{event_id}/settlement", "GET /producer/events/{event_id}/vouchers", "GET /tenants/mine",
        "GET /users/me",
    ])


def test_a_producer_signs_in_and_reads_only_about_themselves(w):
    me = w.client.get("/api/v1/users/me", headers=_headers(w.producer, w.tenant))
    assert me.status_code == 200, me.text
    body = me.json()
    assert body["role"] == "producer_view" and body["dashboardAccess"]["restricted"] is True
    assert body["dashboardAccess"]["sections"] == {}
    mine = w.client.get("/api/v1/tenants/mine", headers=_headers(w.producer))
    assert mine.status_code == 200 and [t["id"] for t in mine.json()] == [str(w.tenant.id)]


# ── Only their events ────────────────────────────────────────────────────────

PRODUCER_PATHS = ("", "/vouchers", "/settlement")


def _get(w, user, event_id, suffix="", tenant=None):
    return w.client.get(f"/api/v1/producer/events/{event_id}{suffix}", headers=_headers(user, tenant or w.tenant))


def test_each_producer_route_answers_for_a_granted_event_only(w):
    w.event.producer_settings = {"settlementEnabled": True}
    w.db.commit()
    for suffix in PRODUCER_PATHS:
        assert _get(w, w.producer, w.event.id, suffix).status_code == 200, suffix
        for other in (w.sibling.id, w.beach.id, w.foreign.id, uuid.uuid4()):
            response = _get(w, w.producer, other, suffix)
            assert response.status_code == 404, (suffix, other, response.text)
            assert response.json()["detail"]["code"] == "event_not_found"
    # Another organization's header: not a member → refused before anything.
    assert _get(w, w.producer, w.foreign.id, "", tenant=w.other_tenant).status_code == 403
    listed = w.client.get("/api/v1/producer/events", headers=_headers(w.producer, w.tenant)).json()["events"]
    assert [e["id"] for e in listed] == [str(w.event.id)]


def test_a_revoked_grant_closes_everything(w):
    grant = w.db.query(ProducerEventGrant).filter(ProducerEventGrant.user_id == w.producer.id).one()
    PR.revoke(w.db, w.admin, w.event, grant.id)
    w.db.commit()
    assert w.db.get(User, w.producer.id).is_active is False
    # Deactivated: the token no longer signs in at all.
    assert _get(w, w.producer, w.event.id).status_code in (401, 403)
    # Invited again: back.
    PR.invite(w.db, w.admin, w.event, email="producer@example.com")
    w.db.commit()
    assert _get(w, w.producer, w.event.id).status_code == 200


def test_staff_are_refused_the_producer_routes(w):
    for user in (w.manager,):
        response = w.client.get("/api/v1/producer/events", headers=_headers(user, w.tenant))
        assert response.status_code == 403 and response.json()["detail"]["code"] == "producer_only"
    restricted = _user(w.db, "restricted", UserRole.COMPANY_MANAGER, w.tenant, company=w.company)  # the default profile
    w.db.commit()
    response = w.client.get("/api/v1/producer/events", headers=_headers(restricted, w.tenant))
    assert response.status_code == 403 and response.json()["detail"]["code"] == DA.SECTION_FORBIDDEN
    assert _get(w, w.manager, w.event.id).status_code == 403
    # The super admin may look, to check what a producer sees.
    assert _get(w, w.admin, w.event.id).status_code == 200


def test_the_settlement_opens_only_when_the_owner_says(w):
    response = _get(w, w.producer, w.event.id, "/settlement")
    assert response.status_code == 403 and response.json()["detail"]["code"] == "settlement_closed"


# ── What they see ────────────────────────────────────────────────────────────


def test_the_sales_totals_hourly_and_items(w):
    _doc(w, w.t1, 10, "100", items=[("בירה", "2", "50")])
    _doc(w, w.t1, 70, "60", items=[("צ'יפס", "3", "20")])
    _doc(w, w.t1, 80, "20", refund=True, items=[("צ'יפס", "1", "20")])
    _doc(w, w.t2, 30, "999")          # the sibling event's till
    _doc(w, w.t1, -30, "500")         # before the window
    w.db.commit()
    body = _get(w, w.producer, w.event.id).json()
    assert body["totals"]["net"] == 140 and body["totals"]["sales"] == 2 and body["totals"]["refunds"] == 1
    assert body["totals"]["avgTicket"] == 80
    assert [(h["hour"], h["net"]) for h in body["hourly"]] == [("18:00", 100.0), ("19:00", 40.0)]
    assert {i["name"]: i["quantity"] for i in body["items"]} == {"בירה": 2.0, "צ'יפס": 2.0}
    assert "tills" not in body and body["event"]["name"] == "Main stage"


def test_the_vouchers_of_their_production_only(w):
    linked = _batch(w, "צוות במה")                                 # linked by the owner
    chosen = _batch(w, "VIP")                                      # linked by the owner
    named = _batch(w, "שנה שעברה", event_name="Main stage")        # same name: only suggested
    stranger = _batch(w, "שובר אחר")                               # not theirs
    w.event.producer_settings = {"batchIds": [str(linked.id), str(chosen.id)], "settlementEnabled": True,
                                 "productionPrices": {str(linked.id): 28}}
    w.db.flush()
    v = _redeem(w, linked, w.t1, 20, qty=2)
    _redeem(w, linked, w.t1, 40, voucher=v)                        # the same voucher again
    _redeem(w, linked, w.t1, 50, reversed_=True)                   # undone: nowhere
    _redeem(w, linked, w.beach_till, 30)                           # another shop
    _redeem(w, linked, w.t1, -60)                                  # before the event
    _redeem(w, chosen, w.t2, 35)                                   # the sibling event's till: not this event
    _redeem(w, chosen, w.t1, 45)
    _redeem(w, named, w.t1, 25)
    _redeem(w, stranger, w.t1, 25)
    w.db.commit()
    body = _get(w, w.producer, w.event.id, "/vouchers").json()
    rows = {b["name"]: b for b in body["batches"]}
    assert set(rows) == {"צוות במה", "VIP"}
    assert (rows["צוות במה"]["redemptions"], rows["צוות במה"]["redeemedVouchers"], rows["צוות במה"]["units"]) == (2, 1, 3.0)
    assert rows["VIP"]["redemptions"] == 1 and body["totals"]["redemptions"] == 3
    owner = PR.owner_view(w.db, w.event, w.manager)
    suggested = {b["name"]: b for b in owner["batches"]}
    assert suggested["שנה שעברה"]["suggested"] is True and suggested["שנה שעברה"]["linked"] is False

    settle = _get(w, w.producer, w.event.id, "/settlement").json()
    by = {r["name"]: r for r in settle["rows"]}
    assert by["צוות במה"]["productionPrice"] == 28 and by["צוות במה"]["amount"] == 28
    assert by["VIP"]["productionPrice"] is None and settle["missingPrices"] is True
    assert settle["totalAmount"] == 28


# ── The owner's side ─────────────────────────────────────────────────────────


def test_inviting_makes_a_scoped_account_and_refuses_staff_emails(w):
    assert w.producer.role == UserRole.PRODUCER_VIEW and w.producer.email == "producer@example.com"
    assert w.producer.company_id is None and w.producer.shop_id is None
    member = w.db.query(TenantMembership).filter(TenantMembership.user_id == w.producer.id).one()
    assert member.tenant_id == w.tenant.id
    with pytest.raises(PR.ProducerError) as err:
        PR.invite(w.db, w.admin, w.event, email="manager@example.com")
    assert err.value.code == "email_in_use" and err.value.status == 409
    with pytest.raises(PR.ProducerError) as err:
        PR.invite(w.db, w.admin, w.event, email="not-an-email")
    assert err.value.code == "email_invalid"
    # The same producer on a second event: one account, two grants.
    again, user, created = PR.invite(w.db, w.admin, w.sibling, email="producer@example.com")
    assert user.id == w.producer.id and created is False
    assert {g.event_id for g in PR.active_grants(w.db, w.producer.id, w.tenant.id)} == {w.event.id, w.sibling.id}


def test_the_owner_routes(w):
    headers = _headers(w.manager, w.tenant)
    view = w.client.get(f"/api/v1/report-events/{w.event.id}/producers", headers=headers)
    assert view.status_code == 200, view.text
    assert [g["email"] for g in view.json()["grants"]] == ["producer@example.com"]
    invited = w.client.post(f"/api/v1/report-events/{w.event.id}/producers", headers=headers,
                            json={"email": "second@example.com", "name": "Avi", "sendInvite": True})
    assert invited.status_code == 201 and invited.json()["invitation"] == "sent"
    other = _batch(w, "Cafe batch", company=w.other_company)
    refused = w.client.put(f"/api/v1/report-events/{w.event.id}/producer-settings", headers=headers,
                           json={"batchIds": [str(other.id)]})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "batch_not_in_company"
    mine = _batch(w, "Stage crew")
    saved = w.client.put(f"/api/v1/report-events/{w.event.id}/producer-settings", headers=headers,
                         json={"settlementEnabled": True, "batchIds": [str(mine.id)], "productionPrices": {str(mine.id): "12.5"}})
    assert saved.status_code == 200, saved.text
    row = next(b for b in saved.json()["batches"] if b["id"] == str(mine.id))
    assert row["linked"] is True and row["productionPrice"] == 12.5
    grant_id = invited.json()["grants"][-1]["id"]
    assert w.client.delete(f"/api/v1/report-events/{w.event.id}/producers/{grant_id}", headers=headers).status_code == 204
    # A cashier of the shop may not manage producers; a producer may not either.
    cashier = _user(w.db, "cashier", UserRole.CASHIER, w.tenant, company=w.company, shop=w.shop)
    w.db.commit()
    assert w.client.get(f"/api/v1/report-events/{w.event.id}/producers", headers=_headers(cashier, w.tenant)).status_code == 403
    assert w.client.get(f"/api/v1/report-events/{w.event.id}/producers", headers=_headers(w.producer, w.tenant)).status_code == 403


def test_batches_are_the_prepaid_vouchers_section(w):
    restricted = _user(w.db, "restricted2", UserRole.COMPANY_MANAGER, w.tenant, company=w.company)
    w.db.add(DashboardAccessProfile(user_id=restricted.id, full_access=False, sections={"reports": "edit"}))
    mine = _batch(w, "Stage crew")
    w.event.producer_settings = {"batchIds": [str(mine.id)]}
    w.db.commit()
    headers = _headers(restricted, w.tenant)
    view = w.client.get(f"/api/v1/report-events/{w.event.id}/producers", headers=headers).json()
    assert view["batches"] == [] and view["canSeeBatches"] is False and view["settings"]["batchIds"] == []
    other = _batch(w, "Other crew")
    w.db.commit()
    saved = w.client.put(f"/api/v1/report-events/{w.event.id}/producer-settings", headers=headers,
                         json={"settlementEnabled": True, "batchIds": [str(other.id)]})
    assert saved.status_code == 200
    w.db.refresh(w.event)
    assert w.event.producer_settings["batchIds"] == [str(mine.id)]   # the links were not this user's to change
    assert w.event.producer_settings["settlementEnabled"] is True


def test_production_batches_and_prices():
    event = SimpleNamespace(producer_settings={"productionPrices": {"b1": "30"}})
    batch = SimpleNamespace(id="b1")
    assert PROD.production_price(event, batch) == Decimal("30.00")
    none = SimpleNamespace(producer_settings=None)
    # The vouchers core keeps a batch's production price in agorot.
    assert PROD.production_price(none, SimpleNamespace(id="b2", production_price=1200)) == Decimal("12.00")
    assert PROD.production_price(none, SimpleNamespace(id="b3", production_price=2550)) == Decimal("25.50")
    assert PROD.production_price(none, SimpleNamespace(id="b4")) is None
    assert PROD.production_price(none, SimpleNamespace(id="b5", production_price=-1)) is None
    assert PROD.production_price(none, SimpleNamespace(id="b6", production_price=1200), include_own=False) is None
    assert PROD.production_price(event, SimpleNamespace(id="b1", production_price=1200), include_own=False) == Decimal("30.00")
    assert PROD.settings_of(SimpleNamespace(producer_settings=None)) == {"settlementEnabled": False, "batchIds": [], "productionPrices": {}}


def test_the_settlement_prices_each_voucher_by_its_serial():
    """The core's "ערוך סדרה": serials 1-10 issued at ₪20, from 11 at ₪25 (agorot in the batch)."""
    history = [{"fromSerial": 1, "priceAgorot": 2000}, {"fromSerial": 11, "priceAgorot": 2500}]
    b = SimpleNamespace(id="b1", production_price=2500, production_price_history=history)
    none = SimpleNamespace(producer_settings=None)
    assert PROD.own_price(b, 3) == Decimal("20.00") and PROD.own_price(b, 11) == Decimal("25.00")
    assert PROD.own_price(b) is None                                    # changed along the series: serial needed
    assert PROD.production_price(none, b) == Decimal("25.00")           # the current price (the owner's tab)
    assert PROD.settle(none, b, [3, 4]) == (Decimal("20.00"), Decimal("40.00"))
    assert PROD.settle(none, b, [3, 12]) == (None, Decimal("45.00"))    # two prices: the amount stands
    assert PROD.settle(none, b, [3, None]) == (None, None)              # a voucher of unknown price
    assert PROD.settle(none, b, []) == (Decimal("25.00"), Decimal("0.00"))
    typed = SimpleNamespace(producer_settings={"productionPrices": {"b1": "30"}})
    assert PROD.settle(typed, b, [3, 12]) == (Decimal("30.00"), Decimal("60.00"))  # the event's price wins
    flat = SimpleNamespace(id="b2", production_price=1250)
    assert PROD.own_price(flat) == Decimal("12.50")
    assert PROD.settle(none, flat, [7, 8]) == (Decimal("12.50"), Decimal("25.00"))
    assert PROD.settle(none, SimpleNamespace(id="b3"), [1]) == (None, None)
    assert PROD.settle(none, SimpleNamespace(id="b3"), []) == (None, None)


def test_the_producer_settles_at_the_core_price_in_agorot(w):
    """No price typed on the event: the batch's own (agorot), per voucher by serial — never x100."""
    crew = _batch(w, "צוות במה", production_price=2500,
                  production_price_history=[{"fromSerial": 1, "priceAgorot": 2000}, {"fromSerial": 11, "priceAgorot": 2500}])
    flat = _batch(w, "VIP", production_price=1250)
    w.event.producer_settings = {"batchIds": [str(crew.id), str(flat.id)], "settlementEnabled": True}
    w.db.flush()
    v = _redeem(w, crew, w.t1, 10, serial=3)
    _redeem(w, crew, w.t1, 20, voucher=v)                           # the same voucher again: once
    _redeem(w, crew, w.t1, 30, serial=12)
    _redeem(w, flat, w.t1, 40, serial=1)
    w.db.commit()
    settle = _get(w, w.producer, w.event.id, "/settlement").json()
    by = {r["name"]: r for r in settle["rows"]}
    assert by["צוות במה"]["redeemedVouchers"] == 2
    assert by["צוות במה"]["productionPrice"] is None and by["צוות במה"]["amount"] == 45       # 20 + 25
    assert by["VIP"]["productionPrice"] == 12.5 and by["VIP"]["amount"] == 12.5
    assert settle["totalAmount"] == 57.5 and settle["missingPrices"] is False


def test_the_owner_sees_a_batch_price_only_with_the_prices_section(w):
    """The batch's own production price is the vouchers core's `prepaid_voucher_prices` section."""
    mine = _batch(w, "Stage crew", production_price=1800)
    typed = _batch(w, "Typed crew", production_price=1800)
    w.event.producer_settings = {"batchIds": [str(mine.id)], "productionPrices": {str(typed.id): 22}}
    vouchers_only = _user(w.db, "vouchers_only", UserRole.COMPANY_MANAGER, w.tenant, company=w.company)
    w.db.add(DashboardAccessProfile(user_id=vouchers_only.id, full_access=False,
                                    sections={"reports": "edit", "prepaid_vouchers": "edit"}))
    with_prices = _user(w.db, "with_prices", UserRole.COMPANY_MANAGER, w.tenant, company=w.company)
    w.db.add(DashboardAccessProfile(user_id=with_prices.id, full_access=False,
                                    sections={"reports": "edit", "prepaid_vouchers": "edit", "prepaid_voucher_prices": "view"}))
    w.db.commit()

    def prices(user):
        view = w.client.get(f"/api/v1/report-events/{w.event.id}/producers", headers=_headers(user, w.tenant))
        assert view.status_code == 200, view.text
        return {b["name"]: b["productionPrice"] for b in view.json()["batches"]}

    assert prices(vouchers_only) == {"Stage crew": None, "Typed crew": 22}     # the event's typed price only
    assert prices(with_prices) == {"Stage crew": 18, "Typed crew": 22}
    assert prices(w.manager)["Stage crew"] == 18                               # full access
