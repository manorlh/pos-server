import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database import Base

#: The kinds of value a parameter holds. The till receives a JSON string, number or
#: boolean accordingly; an enum is a string from `enum_options`.
TILL_PARAMETER_VALUE_TYPES = ("string", "integer", "decimal", "boolean", "enum")

#: Where a value can be set, least specific first. The till resolves the other way
#: round: its own value, then its area's, its shop's, its company's, then the default.
TILL_PARAMETER_SCOPES = ("company", "shop", "area", "machine")


class TillParameter(Base):
    """
    A key/value setting for tills, defined by a super admin (docs: "פרמטרים לקופות").

    Global, not per tenant: the definition is a contract with the till software, which
    every tenant runs. What a tenant's tills actually get is the value set at the most
    specific level that has one (`TillParameterValue`), or `default_value`.
    """

    __tablename__ = "till_parameters"
    __table_args__ = (
        CheckConstraint(
            "value_type IN ('string', 'integer', 'decimal', 'boolean', 'enum')",
            name="ck_till_parameters_value_type",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    #: The name the till reads it by. Unique, a slug (`app.services.till_parameters`).
    key = Column(String(64), nullable=False, unique=True)
    label = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    value_type = Column(String(16), nullable=False)
    #: The allowed strings of an enum; null for every other type.
    enum_options = Column(JSONB(none_as_null=True), nullable=True)
    #: SQL NULL = no default: a till with no value at any level does not get the key.
    default_value = Column(JSONB(none_as_null=True), nullable=True)
    #: An inactive parameter is not sent to any till; its values are kept.
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    #: Part of the tills' parameters watermark. Also touched when one of its values is
    #: removed, so a deletion still moves the watermark of the tills it applied to.
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class TillParameterValue(Base):
    """
    One parameter's value at one level: a company, a shop, an area, or a single till.

    `scope_id` names a row of `companies`, `shops`, `shop_areas` or `pos_machines` by
    `scope_type`, so it carries no foreign key. A value whose entity has since gone is
    never reached by resolution (nothing points at it any more) and is listed as such.
    """

    __tablename__ = "till_parameter_values"
    __table_args__ = (
        UniqueConstraint(
            "parameter_id", "scope_type", "scope_id", name="uq_till_parameter_values_scope"
        ),
        CheckConstraint(
            "scope_type IN ('company', 'shop', 'area', 'machine')",
            name="ck_till_parameter_values_scope_type",
        ),
        # Resolution reads every value of a till's four scopes at once.
        Index("ix_till_parameter_values_scope", "scope_type", "scope_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    parameter_id = Column(
        UUID(as_uuid=True),
        ForeignKey("till_parameters.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    scope_type = Column(String(16), nullable=False)
    scope_id = Column(UUID(as_uuid=True), nullable=False)
    #: Never null: removing a value is deleting the row.
    value = Column(JSONB, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class TillParameterChange(Base):
    """
    Every change made to a parameter on the parameters page — who, when, at which level, from
    what to what (app/services/till_parameter_audit.py). Never updated or deleted, and outlives
    the definition and the person: no foreign keys, the key and the user's email kept as text.

    `action`: "set" / "clear" (a level's value), "default" / "active" (the definition's default
    or activation; `scope_type` "default"), "deleted" (the definition and all its values).
    """

    __tablename__ = "till_parameter_changes"
    __table_args__ = (
        Index("ix_till_parameter_changes_key_at", "parameter_key", "created_at"),
        Index("ix_till_parameter_changes_scope", "scope_type", "scope_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    parameter_id = Column(UUID(as_uuid=True), nullable=True)
    parameter_key = Column(String(64), nullable=False)
    #: "company" | "shop" | "area" | "machine" | "default" (the definition itself).
    scope_type = Column(String(16), nullable=False)
    scope_id = Column(UUID(as_uuid=True), nullable=True)
    action = Column(String(16), nullable=False)
    old_value = Column(JSONB(none_as_null=True), nullable=True)
    new_value = Column(JSONB(none_as_null=True), nullable=True)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    user_email = Column(String(255), nullable=True)
    user_role = Column(String(32), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
