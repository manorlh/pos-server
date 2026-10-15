"""
"הגדרה מהירה לשלבי הגשה" — the request bodies (app/services/courses_quick_setup.py), camelCase as the
dashboard sends them. The values of the till parameters are checked by their definitions (422).
"""
from __future__ import annotations

import uuid
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.menu import AUTO_FIRE_MINUTES_MAX, AUTO_FIRE_MINUTES_MIN

#: As many as the course list itself takes (`CoursesIn`).
COURSES_MAX = 20
MAPPING_MAX = 2000


class _Body(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class QuickCourseIn(_Body):
    """
    A course of the wizard's first step: `id` — one that already reaches the company (left as it is);
    else a new one, created unless the company already has one of the same name. `ref` is how the
    mapping names a new one (default: its name).
    """

    id: Optional[uuid.UUID] = None
    ref: Optional[str] = Field(None, min_length=1, max_length=60)
    name: str = Field(min_length=1, max_length=60)
    auto_fire_minutes: Optional[int] = Field(
        None, alias="autoFireMinutes", ge=AUTO_FIRE_MINUTES_MIN, le=AUTO_FIRE_MINUTES_MAX,
    )

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, v):
        return v.strip() if isinstance(v, str) else v


class QuickMappingIn(_Body):
    """
    One category: `courseId` — a course id, or a new course's `ref`; null: none (a sub-category then
    follows its parent). `sendSilently` ("יוצא בלי בון"): absent — unchanged; null inherits.
    """

    category_id: uuid.UUID = Field(alias="categoryId")
    course_id: Optional[str] = Field(None, alias="courseId", max_length=60)
    send_silently: Optional[bool] = Field(None, alias="sendSilently")


class QuickEnableIn(_Body):
    """Where the courses go on: one level of the company, with the two FIRE options when sent."""

    level: Literal["company", "shop", "area", "machine"]
    id: uuid.UUID
    courses_enabled: bool = Field(True, alias="coursesEnabled")
    #: "מתי עיקריות?" — `ask` (the default) | `never` | `default:<choice>`.
    fire_ask_on_send: Optional[str] = Field(None, alias="fireAskOnSend", max_length=20)
    #: `off` (the default) | `after_minutes` | `after_ready`.
    auto_fire: Optional[str] = Field(None, alias="autoFire", max_length=20)


class QuickSetupIn(_Body):
    company_id: uuid.UUID = Field(alias="companyId")
    courses: List[QuickCourseIn] = Field(default_factory=list, max_length=COURSES_MAX)
    mapping: List[QuickMappingIn] = Field(default_factory=list, max_length=MAPPING_MAX)
    enable: Optional[QuickEnableIn] = None

    @model_validator(mode="after")
    def _distinct(self):
        names = [c.name.casefold() for c in self.courses if c.id is None]
        if len(set(names)) != len(names):
            raise ValueError("a new course is named twice")
        refs = [c.ref or c.name for c in self.courses if c.id is None]
        if len(set(refs)) != len(refs):
            raise ValueError("a course ref is used twice")
        categories = [str(m.category_id) for m in self.mapping]
        if len(set(categories)) != len(categories):
            raise ValueError("a category is mapped twice")
        return self


class QuickCompanyIn(_Body):
    company_id: uuid.UUID = Field(alias="companyId")


class CoursesSwitchIn(_Body):
    """The status line's switch: off clears `coursesEnabled` where it is on; on puts it back."""

    company_id: uuid.UUID = Field(alias="companyId")
    on: bool
