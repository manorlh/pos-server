from sqlalchemy import (
    Boolean, Column, String, ForeignKey, Numeric, Integer, Index,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from app.database import Base


class TransactionPayment(Base):
    """
    One tender leg on a document — "₪50 cash, ₪73.40 card" is two rows.

    Why a child table rather than more columns on `transactions`: a document can
    carry any number of legs, and every report that splits takings by tender has to
    be able to attribute *part* of a document to cash and part to card. A single
    `transactions.payment_method` cannot express that at all, and a fixed pair of
    columns would break again the first time someone pays with three tenders.

    Deliberately **not** tenant/shop/machine denormalised, unlike `issued_vouchers`
    and like `transaction_items`. The two child tables differ on purpose: an issued
    שובר is looked up on its own (by serial, from a printed voucher) with no
    document in hand, so it needs its own scope columns. A tender leg is only ever
    read through its document — every aggregation already joins `transactions` for
    the time window and the status gate, so denormalising tenant/shop here would
    add columns that remove no join and can drift from the parent.

    `amount` is the money **applied to the document** on this tender, not the money
    handed over: ₪100 offered for a ₪50 bill is `amount = 50`, with the ₪100 and the
    change staying in `transactions.amount_tendered` / `change_amount` as before.
    """

    __tablename__ = "transaction_payments"
    __table_args__ = (
        Index("ix_transaction_payments_transaction", "transaction_id"),
        Index("ix_transaction_payments_terminal_uid", "terminal_uid"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True)  # client-generated
    transaction_id = Column(
        UUID(as_uuid=True),
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False,
    )

    # Order the tenders were taken in. Not decoration: the OpenFormat export numbers
    # its payment records (D120) per document, and ordering by a random client UUID
    # would renumber the same document differently on every export.
    sequence = Column(Integer, nullable=False, server_default="1")

    # NOT NULL. A leg that cannot say how the money moved is not auditable, so the
    # ingest path substitutes "other" — which is exactly what `normalize_tender`
    # already maps an unrecognised method to, so nothing downstream learns a new case.
    method = Column(String(50), nullable=False)
    amount = Column(Numeric(12, 2), nullable=False)

    # Acquirer reply for a card leg, stored the same way as `transactions.nayax_meta`
    # (JSONB, unvalidated): vuid, terminal uid, authorisation number, masked card.
    # On a split document the reply belongs to the card leg, not to the document —
    # two card legs on one sale have two different authorisation numbers.
    nayax_meta = Column(JSONB, nullable=True)

    # ── Card transmission (docs/SHIFTS_API.md §4) ─────────────────────────────
    #: The terminal's own id of this card sale (Agamento `uid`), read out of `nayax_meta`
    #: on the way in. It is what `doPeriodic` lists in a batch, so it is how a leg is
    #: matched to the transmission that carried it. Null for a non-card leg or a card leg
    #: whose reply carried none — such a leg can never be matched.
    terminal_uid = Column(String(64), nullable=True)
    #: The successful transmission that carried this leg to Shva; null = not (yet) known
    #: to have gone. Set by the report or, for a leg that lands after it, on ingest.
    transmission_id = Column(
        UUID(as_uuid=True),
        ForeignKey("card_transmissions.id", ondelete="SET NULL"),
        nullable=True,
    )
    #: That transmission's batch number (Agamento `ackNumber`), kept on the leg itself.
    transmitted_batch = Column(String(64), nullable=True)

    # ── Card brand / acquirer / issuer (app.services.card_brands) ────────────
    #: מותג: visa | mastercard | amex | diners | isracard | jcb | discover | maestro | other.
    #: What the till sent, else read from the reply's `mutag`, else from the BIN. Null for
    #: a non-card leg, or a card leg whose reply says nothing at all.
    card_brand = Column(String(16), nullable=True)
    #: חברת סליקה (the reply's `solek`): isracard | cal | max | diners | amex | other.
    card_acquirer = Column(String(16), nullable=True)
    #: מנפיק (the reply's `manpik`): as the acquirer, plus foreign.
    card_issuer = Column(String(16), nullable=True)

    #: "ללא החזר כספי — עסקה שלא בוצעה" (docs/SPEC_REMOTE_CREDIT.md): a leg of a credit for a
    #: sale that never really happened. Its method mirrors the original's, but no money
    #: moved: no refund reaches the terminal, nothing leaves the drawer, and the
    #: reconciliation must not expect either.
    no_money_movement = Column(Boolean, nullable=False, default=False, server_default="false")

    transaction = relationship("Transaction", back_populates="payments")
