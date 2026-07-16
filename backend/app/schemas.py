import json
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field, field_validator


# ─── Category ───────────────────────────────────────

class CategoryCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field(..., min_length=7, max_length=7)

    @field_validator("color")
    @classmethod
    def validate_hex_color(cls, v: str) -> str:
        if not v.startswith("#") or len(v) != 7:
            raise ValueError("Color must be a valid hex string like #1E5C8A")
        # validate hex chars
        int(v[1:], 16)
        return v


class CategoryResponse(BaseModel):
    id: str
    name: str
    color: str

    model_config = {"from_attributes": True}


# ─── Article ────────────────────────────────────────

class ArticleBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: str = Field(default="")
    category_id: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    entities: Optional[dict] = None  # LLM 提取的实体+关系 {"entities":[...],"relations":[...]}


class ArticleCreate(ArticleBase):
    pass


class ArticleUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    content: Optional[str] = None
    category_id: Optional[str] = None
    tags: Optional[list[str]] = None
    entities: Optional[dict] = None


class ArticleResponse(BaseModel):
    id: str
    title: str
    content: str
    category_id: Optional[str]
    tags: list[str]
    entities: Optional[dict] = None  # LLM 提取的实体+关系
    created_at: datetime
    updated_at: datetime
    category: Optional[CategoryResponse] = None
    attachment_name: Optional[str] = None
    attachment_type: Optional[str] = None
    attachment_path: Optional[str] = None

    model_config = {"from_attributes": True}

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v: object) -> list[str]:
        if isinstance(v, str):
            return json.loads(v)
        if isinstance(v, list):
            return v
        return []

    @field_validator("entities", mode="before")
    @classmethod
    def parse_entities(cls, v: object) -> Optional[dict]:
        if v is None:
            return None
        if isinstance(v, str):
            return json.loads(v)
        if isinstance(v, dict):
            return v
        return None


# ─── Stats ──────────────────────────────────────────

class StatsResponse(BaseModel):
    article_count: int
    category_count: int
    tag_count: int
