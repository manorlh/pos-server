"""Till parameter payloads: definitions, values per level, and the till's sync answer."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional
import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.services.till_parameters import (
    TillParameterValueError,
    clean_enum_options,
    validate_key,
    validate_scope_type,
    validate_value,
    validate_value_type,
)

LABEL_MAX = 255
DESCRIPTION_MAX = 2000


def _clean_label(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("label must be non-empty text")
    value = value.strip()
    if len(value) > LABEL_MAX:
        raise ValueError(f"label is at most {LABEL_MAX} characters")
    return value


def _clean_description(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("description must be text")
    value = value.strip()
    if len(value) > DESCRIPTION_MAX:
        raise ValueError(f"description is at most {DESCRIPTION_MAX} characters")
    return value or None


class TillParameterCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key: str
    label: str
    description: Optional[str] = None
    value_type: str = Field(..., alias="valueType")
    enum_options: Optional[List[Any]] = Field(None, alias="enumOptions")
    #: null = no default: a till with no value at any level does not get the key.
    default_value: Any = Field(None, alias="defaultValue")
    is_active: bool = Field(True, alias="isActive")

    @field_validator("key", mode="before")
    @classmethod
    def _key(cls, value):
        return validate_key(value)

    @field_validator("label", mode="before")
    @classmethod
    def _label(cls, value):
        return _clean_label(value)

    @field_validator("description", mode="before")
    @classmethod
    def _description(cls, value):
        return _clean_description(value)

    @field_validator("value_type", mode="before")
    @classmethod
    def _value_type(cls, value):
        return validate_value_type(value)

    @model_validator(mode="after")
    def _options_and_default(self):
        self.enum_options = clean_enum_options(self.value_type, self.enum_options)
        if self.default_value is not None:
            try:
                self.default_value = validate_value(
                    self.value_type, self.default_value, self.enum_options
                )
            except TillParameterValueError as exc:
                raise ValueError(f"defaultValue: {exc}") from exc
        return self


class TillParameterUpdate(BaseModel):
    """
    Partial: an omitted field is unchanged. `defaultValue: null` clears the default and
    `description: null` clears the description. The merged result is validated as a
    whole by the router, since a new type can invalidate the old default.
    """

    model_config = ConfigDict(populate_by_name=True)

    key: Optional[str] = None
    label: Optional[str] = None
    description: Optional[str] = None
    value_type: Optional[str] = Field(None, alias="valueType")
    enum_options: Optional[List[Any]] = Field(None, alias="enumOptions")
    default_value: Any = Field(None, alias="defaultValue")
    is_active: Optional[bool] = Field(None, alias="isActive")

    @field_validator("key", mode="before")
    @classmethod
    def _key(cls, value):
        return None if value is None else validate_key(value)

    @field_validator("label", mode="before")
    @classmethod
    def _label(cls, value):
        return None if value is None else _clean_label(value)

    @field_validator("description", mode="before")
    @classmethod
    def _description(cls, value):
        return _clean_description(value)

    @field_validator("value_type", mode="before")
    @classmethod
    def _value_type(cls, value):
        return None if value is None else validate_value_type(value)


class TillParameterOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    id: uuid.UUID
    key: str
    label: str
    description: Optional[str] = None
    value_type: str = Field(..., alias="valueType")
    enum_options: Optional[List[str]] = Field(None, alias="enumOptions")
    default_value: Any = Field(None, alias="defaultValue")
    is_active: bool = Field(True, alias="isActive")
    #: How many levels set a value for it — for the list, and the delete confirmation.
    value_count: int = Field(0, alias="valueCount")
    #: How the dashboard edits it beyond its type: `"image"` = an image URL picked by
    #: upload (`app.services.till_parameters.IMAGE_PARAMETER_KEYS`); null = by type.
    widget: Optional[str] = None
    #: For `widget: "image"`: the `POST /images/branding?kind=` its uploads go through.
    image_kind: Optional[str] = Field(None, alias="imageKind")
    #: The dashboard tab that edits this parameter instead of the till parameters page
    #: ("printers" for the printing settings, `PRINTERS_PAGE_KEYS`); null otherwise.
    managed_on: Optional[str] = Field(None, alias="managedOn")
    created_at: Optional[datetime] = Field(None, alias="createdAt")
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")


class TillParameterValueIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    scope_type: str = Field(..., alias="scopeType")
    scope_id: uuid.UUID = Field(..., alias="scopeId")
    #: Checked against the parameter's type by the router (the schema does not know it).
    value: Any = None

    @field_validator("scope_type", mode="before")
    @classmethod
    def _scope_type(cls, value):
        return validate_scope_type(value)


class TillParameterValueOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: uuid.UUID
    parameter_id: uuid.UUID = Field(..., alias="parameterId")
    scope_type: str = Field(..., alias="scopeType")
    scope_id: uuid.UUID = Field(..., alias="scopeId")
    #: The company, shop, area or till's name; null when that entity no longer exists.
    scope_name: Optional[str] = Field(None, alias="scopeName")
    #: The shop of an area or till, the company of a shop.
    scope_context: Optional[str] = Field(None, alias="scopeContext")
    value: Any = None
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")


class TillParametersSyncResponse(BaseModel):
    """
    `GET /sync/{machine_id}/parameters`. A fixed contract with the till:
    `{"parameters": {key: scalar}, "updatedAt": ISO-8601 UTC | null}`. Always the full
    set — a key that is gone from `parameters` is gone for the till.
    """

    model_config = ConfigDict(populate_by_name=True)

    parameters: Dict[str, Any] = Field(default_factory=dict)
    updated_at: Optional[datetime] = Field(None, alias="updatedAt")
