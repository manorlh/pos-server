"""
Recording who approved a document, and refusing to record a name that is not true.

The till uploads over a machine token, so "user X approved this" is a claim made by
the same device that could be running a modified build. What can go wrong is narrow
and each one produces an audit trail that reads as evidence and is worth nothing:

* a claimed approver stored as sent, so any id the device invents becomes a name on a
  credit note;
* a cashier — or a supervisor from another shop's payroll — recorded as having
  authorised a refund they could not authorise;
* a manager sacked last month still approving today's discounts;
* a document that quietly loses a false claim and is stored anyway, which turns a lie
  into an ordinary-looking document rather than a rejection;
* the close of the day recording nobody, because elevation was made mandatory and the
  ordinary manager-operated till could no longer close at all.

Style matches the rest of tests/: no database, no client. Services and handlers are
called directly with scripted sessions.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.models.user import UserRole
from app.services import approvals
from app.services.approvals import (
    ApprovalRejected,
    scopes_required_by_document,
    verify_document_approver,
)
from app.services.permissions import Scope

CREDIT_NOTE = 330
TAX_INVOICE = 320


# ── Harness ──────────────────────────────────────────────────────────────────


def _tx(**kw):
    """An incoming document, with the fields the approval rules read."""
    return SimpleNamespace(
        id=kw.get("id", uuid.uuid4()),
        document_type=kw.get("document_type", TAX_INVOICE),
        refund_of_transaction_id=kw.get("refund_of_transaction_id"),
        total_discount=kw.get("total_discount"),
        document_discount=kw.get("document_discount"),
        items=kw.get("items", []),
        approved_by_user_id=kw.get("approved_by_user_id"),
    )


def _item(discount=None, line_discount=None):
    return SimpleNamespace(discount=discount, line_discount=line_discount)


def _user(role=UserRole.SHOP_MANAGER, is_active=True, user_id=None):
    return SimpleNamespace(
        id=user_id or uuid.uuid4(), role=role, is_active=is_active, shop_id=None
    )


class _Db:
    """Answers the one `users` lookup `verify_document_approver` makes."""

    def __init__(self, user=None):
        self.user = user
        self.info: dict = {}

    def query(self, *_entities):
        outer = self

        class _Q:
            def filter(self, *_c):
                return self

            def first(self):
                return outer.user

        return _Q()


def _machine():
    machine = MagicMock()
    machine.id = uuid.uuid4()
    machine.shop_id = uuid.uuid4()
    machine.tenant_id = uuid.uuid4()
    return machine


@pytest.fixture(autouse=True)
def of_this_tenant(monkeypatch):
    """Default the tenant question to yes (tests/test_cross_tenant_links.py asks it)."""
    monkeypatch.setattr(approvals, "_user_in_tenant", lambda *a, **k: True)


@pytest.fixture
def at_this_machine(monkeypatch):
    """Default the machine-permission question to yes, so each test states its own."""
    monkeypatch.setattr(approvals, "user_may_use_machine", lambda *a, **k: True)


# ── What a document needed ───────────────────────────────────────────────────


class TestWhatTheDocumentNeeded:
    def test_an_ordinary_sale_needed_nobody(self):
        assert scopes_required_by_document(_tx()) == frozenset()

    def test_a_credit_note_needed_a_refund_approver(self):
        assert scopes_required_by_document(_tx(document_type=CREDIT_NOTE)) == frozenset(
            {Scope.REFUND}
        )

    def test_a_refund_without_the_document_type_is_still_a_refund(self):
        """
        Both signals, because either alone has a gap: a legacy row carries no
        `document_type`, and a credit note raised outside the refund flow carries no
        back-link. Reading only one would let the other through unapproved.
        """
        assert Scope.REFUND in scopes_required_by_document(
            _tx(document_type=None, refund_of_transaction_id=uuid.uuid4())
        )

    @pytest.mark.parametrize(
        "document",
        [
            _tx(document_discount="5.00"),
            _tx(total_discount="5.00"),
            _tx(items=[_item(discount="2.50")]),
            _tx(items=[_item(line_discount="2.50")]),
            _tx(items=[_item(), _item(line_discount="0.01")]),
        ],
    )
    def test_money_off_at_any_level_needed_a_discount_approver(self, document):
        """
        If only the basket total were checked, the cheapest way around the rule would
        be to discount one line instead of the basket — the document totals then look
        entirely ordinary.
        """
        assert Scope.DISCOUNT in scopes_required_by_document(document)

    def test_a_zero_discount_is_not_a_discount(self):
        """A till that sends 0.00 rather than null has not taken money off anything."""
        assert scopes_required_by_document(
            _tx(document_discount="0.00", total_discount="0", items=[_item(discount="0")])
        ) == frozenset()

    def test_a_discounted_credit_note_needed_both(self):
        assert scopes_required_by_document(
            _tx(document_type=CREDIT_NOTE, document_discount="3.00")
        ) == frozenset({Scope.REFUND, Scope.DISCOUNT})


# ── Verifying the claim ──────────────────────────────────────────────────────


class TestVerifyingTheClaim:
    def test_a_document_claiming_nobody_is_stored_with_nobody(self, at_this_machine):
        assert verify_document_approver(_Db(), _machine(), _tx()) is None

    def test_a_verified_manager_is_recorded(self, at_this_machine):
        approver = _user(role=UserRole.SHOP_MANAGER)
        document = _tx(document_type=CREDIT_NOTE, approved_by_user_id=approver.id)

        assert (
            verify_document_approver(_Db(approver), _machine(), document) == approver.id
        )

    def test_a_shift_supervisor_may_approve_a_refund(self, at_this_machine):
        """The role exists for exactly this; if it were refused it would do nothing."""
        approver = _user(role=UserRole.SHIFT_SUPERVISOR)
        document = _tx(document_type=CREDIT_NOTE, approved_by_user_id=approver.id)

        assert (
            verify_document_approver(_Db(approver), _machine(), document) == approver.id
        )

    def test_an_id_naming_nobody_takes_the_document_down(self, at_this_machine):
        """
        The device is the one making the claim. An unverifiable id must not become a
        name on a credit note.
        """
        document = _tx(document_type=CREDIT_NOTE, approved_by_user_id=uuid.uuid4())

        with pytest.raises(ApprovalRejected):
            verify_document_approver(_Db(None), _machine(), document)

    def test_a_deactivated_user_approves_nothing(self, at_this_machine):
        """
        Somebody who left between approving and the outbox draining. Their standing
        permissions are what the record is checked against, and they have none.
        """
        approver = _user(role=UserRole.SHOP_MANAGER, is_active=False)
        document = _tx(document_type=CREDIT_NOTE, approved_by_user_id=approver.id)

        with pytest.raises(ApprovalRejected):
            verify_document_approver(_Db(approver), _machine(), document)

    def test_a_cashier_cannot_be_recorded_as_having_approved_a_refund(
        self, at_this_machine
    ):
        approver = _user(role=UserRole.CASHIER)
        document = _tx(document_type=CREDIT_NOTE, approved_by_user_id=approver.id)

        with pytest.raises(ApprovalRejected):
            verify_document_approver(_Db(approver), _machine(), document)

    def test_a_supervisor_cannot_approve_a_document_from_another_shop(self, monkeypatch):
        """
        `user_may_use_machine` is the one definition of who belongs at a terminal, so
        the desk's answer and the till's answer cannot diverge. A supervisor who could
        not touch this machine from a dashboard cannot appear on its documents either.
        """
        monkeypatch.setattr(approvals, "user_may_use_machine", lambda *a, **k: False)
        approver = _user(role=UserRole.SHIFT_SUPERVISOR)
        document = _tx(document_type=CREDIT_NOTE, approved_by_user_id=approver.id)

        with pytest.raises(ApprovalRejected):
            verify_document_approver(_Db(approver), _machine(), document)

    def test_the_bar_comes_from_the_document_not_from_the_claim(self, at_this_machine):
        """
        A discounted sale needs a discount approver whatever the device says about it.
        Were the requirement read off the claim, understating the document would be
        enough to get any name onto it.
        """
        approver = _user(role=UserRole.CASHIER)
        document = _tx(items=[_item(line_discount="4.00")], approved_by_user_id=approver.id)

        with pytest.raises(ApprovalRejected):
            verify_document_approver(_Db(approver), _machine(), document)

    def test_the_rejection_names_the_scope_that_was_missing(self, at_this_machine):
        """The reason travels back to the till and into `sync_logs.conflict_note`."""
        approver = _user(role=UserRole.CASHIER)
        document = _tx(document_type=CREDIT_NOTE, approved_by_user_id=approver.id)

        with pytest.raises(ApprovalRejected) as exc:
            verify_document_approver(_Db(approver), _machine(), document)
        assert Scope.REFUND.value in str(exc.value)


# ── The upsert never refuses over an approver (2026-10-07) ───────────────────
#
# The owner: "כרגע אין הרשאות, כולם יכולים לעשות הכל. כל מסמך שבוצע במכשירים חייב לעלות
# לענן". The strict checks above stay (`verify_document_approver`), but the document path
# keeps the claim as sent and goes on; tests/test_document_pos_approver.py and
# tests/test_cross_tenant_links.py push real documents through the router.


class TestTheUpsertNeverRefusesOverAnApprover:
    def _upsert(self, claim):
        import app.services.transactions as T

        machine = _machine()
        document = MagicMock()
        document.id = uuid.uuid4()
        document.shift_id = None
        document.business_date = None

        with patch.object(T, "_tender_rejection_reason", return_value=None), patch.object(
            T, "_refund_of_other_tenant", return_value=False
        ), patch.object(
            T, "verify_document_approvers", side_effect=AssertionError("the strict check is not on the path")
        ) as strict, patch.object(
            T, "resolve_document_approver_claim", return_value=claim
        ), patch.object(T, "resolve_shift_for_document", return_value=None) as opened_day:
            db = MagicMock()
            db.query.return_value.filter.return_value.all.return_value = []
            results = T.upsert_transactions(db, machine, [document])
        return results, opened_day, strict

    def test_a_claim_nobody_here_knows_goes_on_to_be_stored(self):
        claim = approvals.ApproverClaim(
            claimed_user_id=uuid.uuid4(),
            notes=({"code": approvals.APPROVER_NOT_KNOWN, "text": approvals.APPROVER_NOT_KNOWN_TEXT},),
        )
        results, opened_day, strict = self._upsert(claim)

        strict.assert_not_called()
        # Went on to be filed and stored (no shift named: rule 2 of docs/SHIFTS_API.md
        # §1.2c-bis, never `resolve_shift_for_document`) — never refused over the claim.
        assert [r.status for r in results] == ["accepted"]
        assert all(r.reason != "approver_unknown_or_inactive" for r in results)

    def test_the_claim_as_sent_and_its_note_reach_the_stored_row(self):
        import app.services.transactions as T

        claimed = uuid.uuid4()
        note = {"code": approvals.APPROVER_NOT_KNOWN, "text": approvals.APPROVER_NOT_KNOWN_TEXT}
        row = T._serialize_tx_for_upsert(
            MagicMock(), _machine(), uuid.uuid4(),
            claimed_approver_pos_user_id=claimed, ingest_notes=[note],
        )

        assert row["approved_by_pos_user_id"] is None
        assert row["claimed_approver_pos_user_id"] == claimed
        assert row["ingest_notes"] == [note]

    def test_a_linked_approver_reaches_the_stored_row(self):
        import app.services.transactions as T

        approver_id = uuid.uuid4()
        row = T._serialize_tx_for_upsert(
            MagicMock(), _machine(), uuid.uuid4(), approved_by_user_id=approver_id
        )

        assert row["approved_by_user_id"] == approver_id

    def test_a_document_nobody_approved_stores_nobody(self):
        import app.services.transactions as T

        row = T._serialize_tx_for_upsert(MagicMock(), _machine(), uuid.uuid4())

        assert row["approved_by_user_id"] is None
        assert row["claimed_approver_user_id"] is None
        assert row["ingest_notes"] is None


class TestResolvingTheClaim:
    """`resolve_document_approver_claim`: kept as sent, linked only to this business's people."""

    def test_nothing_claimed_is_nothing_stored(self):
        assert approvals.resolve_document_approver_claim(_Db(), _machine(), _tx()) == approvals.ApproverClaim()

    def test_a_person_of_this_business_is_linked_whatever_their_role_or_state(self):
        approver = _user(role=UserRole.CASHIER, is_active=False)
        claim = approvals.resolve_document_approver_claim(
            _Db(approver), _machine(), _tx(document_type=CREDIT_NOTE, approved_by_user_id=approver.id)
        )
        assert (claim.user_id, claim.claimed_user_id, claim.notes) == (approver.id, approver.id, ())

    def test_an_id_naming_nobody_is_kept_unlinked_with_a_quiet_note(self):
        claimed = uuid.uuid4()
        claim = approvals.resolve_document_approver_claim(_Db(None), _machine(), _tx(approved_by_user_id=claimed))
        assert claim.user_id is None and claim.claimed_user_id == claimed
        assert [n["code"] for n in claim.notes] == [approvals.APPROVER_NOT_KNOWN]

    def test_another_tenants_person_is_never_linked(self, monkeypatch):
        monkeypatch.setattr(approvals, "_user_in_tenant", lambda *a, **k: False)
        approver = _user()
        claim = approvals.resolve_document_approver_claim(
            _Db(approver), _machine(), _tx(approved_by_user_id=approver.id)
        )
        assert claim.user_id is None and claim.claimed_user_id == approver.id
        assert [n["code"] for n in claim.notes] == [approvals.APPROVER_NOT_KNOWN]


# ── Closing a shift ──────────────────────────────────────────────────────────


class _ZDb:
    """
    A session for the close handler: it adds, commits, refreshes — and serves the
    locked re-read that spending a grant does, so the real consumption runs here
    rather than a stub of it.
    """

    def __init__(self, locked_grant=None):
        self.added: list = []
        self.commits = 0
        self.locked_grant = locked_grant

    def query(self, *_entities):
        outer = self

        class _Q:
            def filter(self, *_c):
                return self

            def populate_existing(self):
                return self

            def with_for_update(self):
                return self

            def first(self):
                return outer.locked_grant

        return _Q()

    def add(self, obj):
        self.added.append(obj)

    def flush(self):
        pass

    def commit(self):
        self.commits += 1

    def refresh(self, _obj):
        pass


def _grant(scopes=("shift:close",), *, by_till_user=False):
    """A grant held by a cloud account, or — `by_till_user` — by a till user."""
    holder = uuid.uuid4()
    return SimpleNamespace(
        id=uuid.uuid4(),
        scopes=list(scopes),
        per_action_consumed_at=None,
        user_id=None if by_till_user else holder,
        pos_user_id=holder if by_till_user else None,
    )


def _shift_row():
    row = MagicMock()
    row.id = uuid.uuid4()
    row.totals_mismatch = False
    row.z_report_id = None
    return row


def _close(monkeypatch, *, approval, db=None, missing=(), outcome="accepted"):
    """Run `post_shift_close` with only its shift-writing services stubbed."""
    from app.routers import sync as sync_router

    captured: dict = {}
    shift = _shift_row()

    def _fake_apply(
        _db, _machine, _shift_id, _body, *, approved_by_user_id=None, approved_by_pos_user_id=None
    ):
        captured["approved_by_user_id"] = approved_by_user_id
        captured["approved_by_pos_user_id"] = approved_by_pos_user_id
        return shift, outcome

    monkeypatch.setattr(sync_router, "refuse_foreign_shift", lambda *a, **k: None)
    monkeypatch.setattr(
        sync_router, "check_close_preconditions", lambda *a, **k: (list(missing), [])
    )
    monkeypatch.setattr(sync_router, "apply_shift_close", _fake_apply)
    monkeypatch.setattr(sync_router, "on_shift_close_accepted", lambda *a, **k: None)
    monkeypatch.setattr(sync_router, "shift_totals_out", lambda *a, **k: None)
    monkeypatch.setattr(sync_router, "z_number_of", lambda *a, **k: None)

    machine = _machine()
    body = MagicMock()
    body.transaction_ids = []

    response = sync_router.post_shift_close(
        machine_id=str(machine.id),
        shift_id=shift.id,
        body=body,
        machine=machine,
        approval=approval,
        db=db if db is not None else _ZDb(),
    )
    return response, captured


class TestClosingAShift:
    def test_a_till_that_offers_no_token_still_closes_its_shift(self, monkeypatch):
        """
        A cashier may close a shift alone, and the operator standing at the till is a
        `pos_users` row, which is not the enum elevation grants come from. Requiring a
        token would stop the ordinary close.
        """
        _response, captured = _close(monkeypatch, approval=None)

        assert captured["approved_by_user_id"] is None

    def test_a_live_grant_puts_a_name_on_the_shift(self, monkeypatch):
        grant = _grant()

        _response, captured = _close(
            monkeypatch, approval=grant, db=_ZDb(locked_grant=grant)
        )

        assert captured["approved_by_user_id"] == grant.user_id
        assert captured["approved_by_pos_user_id"] is None

    def test_a_till_user_grant_puts_the_till_user_on_the_shift(self, monkeypatch):
        """
        A manager who approved by typing their till username has no cloud account to
        name. The close must carry *them*, in the till-user column — not silently no
        approver at all, which is what reading `user_id` alone would produce.
        """
        grant = _grant(by_till_user=True)

        _response, captured = _close(
            monkeypatch, approval=grant, db=_ZDb(locked_grant=grant)
        )

        assert captured["approved_by_pos_user_id"] == grant.pos_user_id
        assert captured["approved_by_user_id"] is None

    def test_one_pin_closes_one_shift(self, monkeypatch):
        """The second close needs the manager back at the till, not the same token."""
        from fastapi import HTTPException

        grant = _grant()
        db = _ZDb(locked_grant=grant)

        _close(monkeypatch, approval=grant, db=db)

        with pytest.raises(HTTPException) as exc:
            _close(monkeypatch, approval=grant, db=db)
        assert exc.value.status_code == 401

    def test_a_close_sent_away_to_flush_its_outbox_keeps_its_pin(self, monkeypatch):
        """
        A 409 tells the till to push the documents the close lists and come straight
        back. Spending the grant on the way in would burn the manager's PIN on a close
        that did not happen, and the retry would arrive with nothing to present.
        """
        grant = _grant()
        db = _ZDb(locked_grant=grant)

        response, _captured = _close(
            monkeypatch, approval=grant, db=db, missing=[uuid.uuid4()]
        )

        assert response.status_code == 409
        assert grant.per_action_consumed_at is None

        _response, captured = _close(monkeypatch, approval=grant, db=db)
        assert captured["approved_by_user_id"] == grant.user_id
