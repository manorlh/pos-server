from typing import Generic, List, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class PaginatedResponse(BaseModel, Generic[T]):
    page: int
    page_size: int = Field(serialization_alias="pageSize")
    total: int
    items: List[T]

    model_config = ConfigDict(populate_by_name=True)
