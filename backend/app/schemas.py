import json
from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel, Field, field_validator, field_serializer


# ─── Category ───────────────────────────────────────

class CategoryCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field(..., min_length=7, max_length=7)

    @field_validator("color")
    @classmethod
    def validate_hex_color(cls, v: str) -> str:
        if not v.startswith("#") or len(v) != 7:
            raise ValueError("Color must be a valid hex string like #1E5C8A")
        try:
            int(v[1:], 16)
        except ValueError:
            raise ValueError("Color must be a valid hex string like #1E5C8A")
        return v


class CategoryResponse(BaseModel):
    id: str
    name: str
    color: str

    model_config = {"from_attributes": True}


# ─── Article ────────────────────────────────────────

# Structured entity models (for documentation / future validation)
class EntityItem(BaseModel):
    name: str
    type: str


class EntityRelation(BaseModel):
    source: str
    target: str
    label: str


class ArticleEntities(BaseModel):
    entities: list[EntityItem] = Field(default_factory=list)
    relations: list[EntityRelation] = Field(default_factory=list)


class ArticleBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: str = Field(default="")
    category_id: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    # Kept as dict rather than ArticleEntities to tolerate minor LLM output variations
    entities: Optional[dict] = None


class ArticleCreate(BaseModel):
    title: str = Field(default="", max_length=200)  # 允许为空，后端自动生成
    content: str = Field(default="")
    category_id: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    entities: Optional[dict] = None


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
    processing: Optional[str] = None  # "processing" when background LLM is running

    model_config = {"from_attributes": True}

    @field_validator("tags", mode="before")
    @classmethod
    def parse_tags(cls, v: object) -> list[str]:
        if isinstance(v, str):
            return json.loads(v)
        if isinstance(v, list):
            return v
        return []

    @field_serializer("created_at", "updated_at")
    @classmethod
    def serialize_utc(cls, v: datetime) -> str:
        """Ensure datetime is serialized as UTC — SQLite strips timezone info."""
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()

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
    entity_count: int
