import json
from datetime import datetime, timezone
from typing import Optional, Literal
from pydantic import BaseModel, Field, field_validator, field_serializer


# ─── Category ───────────────────────────────────────

class CategoryCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field(..., min_length=7, max_length=7)
    # 上级目录 ID：None = 顶级目录；更新接口 None = 保持不变，空串 = 移到顶级
    parent_id: Optional[str] = None

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


class CategoryMove(BaseModel):
    """目录移动：parent_id 空串 = 移到顶级，否则为目标上级目录 ID。"""

    parent_id: str = Field(default="")


# ─── 高级搜索 ────────────────────────────────────────

class AdvancedSearchCondition(BaseModel):
    """高级搜索条件：类型 + 值 + 与上一条的连接关系（与/或）+ 非（取反）。

    - keyword：关键词（标题+正文模糊匹配，value）
    - person：人员（创建人模糊匹配，value）
    - tag：标签（精确匹配，value）
    - time：时间范围（按更新时间，start/end 为 ISO 日期，可只填一端）
    - category：目录（匹配整个目录子树，value=目录 ID；前端目录筛选用）
    """

    type: Literal["keyword", "person", "tag", "time", "category"] = "keyword"
    value: str = ""
    start: Optional[str] = None
    end: Optional[str] = None
    connector: Literal["and", "or"] = "and"
    negated: bool = False


class AdvancedSearchRequest(BaseModel):
    """高级搜索请求：条件列表按 connector 依次组合（首条的 connector 忽略）。"""

    conditions: list[AdvancedSearchCondition] = Field(default_factory=list)


class ArticleMove(BaseModel):
    """文章移动：category_id None = 目录不变（否则移入该目录的顶级）；
    parent_id None = 不变、空串 = 顶级、否则挂到该文章下（同目录约束）。"""

    category_id: Optional[str] = None
    parent_id: Optional[str] = None


class CategoryResponse(BaseModel):
    id: str
    name: str
    color: str
    parent_id: Optional[str] = None  # 上级目录 ID（空 = 顶级目录）
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

    @field_serializer("created_at", "updated_at")
    @classmethod
    def serialize_utc(cls, v: Optional[datetime]) -> str:
        if v is None:
            return ""
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()


# ─── Article ────────────────────────────────────────

# Structured entity models (for documentation / future validation)
class EntityItem(BaseModel):
    name: str
    type: str


class EntityRelation(BaseModel):
    source: str
    target: str
    label: str
    source_type: Optional[str] = None
    target_type: Optional[str] = None


class ArticleEntities(BaseModel):
    entities: list[EntityItem] = Field(default_factory=list)
    relations: list[EntityRelation] = Field(default_factory=list)


class ArticleBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: str = Field(default="")
    category_id: Optional[str] = None
    parent_id: Optional[str] = None  # 父文章 ID（同目录内嵌套；空 = 顶级文章）
    tags: list[str] = Field(default_factory=list)
    # Kept as dict rather than ArticleEntities to tolerate minor LLM output variations
    entities: Optional[dict] = None


class ArticleCreate(BaseModel):
    title: str = Field(default="", max_length=200)  # 允许为空，后端自动生成
    content: str = Field(default="")
    category_id: Optional[str] = None
    parent_id: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    entities: Optional[dict] = None


class ArticleUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    content: Optional[str] = None
    category_id: Optional[str] = None
    parent_id: Optional[str] = None
    tags: Optional[list[str]] = None
    entities: Optional[dict] = None


class ArticleBreadcrumbItem(BaseModel):
    """面包屑/子文章导航条目。"""

    id: str
    title: str


class ArticleChildNode(BaseModel):
    """子文章树节点（详情页树形展示用，递归嵌套）。"""

    id: str
    title: str
    created_by: Optional[str] = None  # 创建人（证书 CN）
    updated_at: Optional[datetime] = None
    children: list["ArticleChildNode"] = Field(default_factory=list)

    @field_serializer("updated_at")
    @classmethod
    def serialize_utc(cls, v: Optional[datetime]) -> str:
        if v is None:
            return ""
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()


ArticleChildNode.model_rebuild()


class ArticleResponse(BaseModel):
    id: str
    title: str
    content: str
    category_id: Optional[str]
    parent_id: Optional[str] = None  # 父文章 ID（空 = 顶级文章）
    ancestors: list[ArticleBreadcrumbItem] = Field(default_factory=list)  # 祖先链（根→直接父）
    children: list[ArticleBreadcrumbItem] = Field(default_factory=list)    # 直接子文章
    children_tree: list[ArticleChildNode] = Field(default_factory=list)    # 子文章递归树（含全部子孙）
    tags: list[str]
    entities: Optional[dict] = None  # LLM 提取的实体+关系
    created_by: Optional[str] = None  # 创建人（证书 CN）
    updated_by: Optional[str] = None  # 更新人（证书 CN）
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


# ─── Comment ───────────────────────────────────────

class CommentCreate(BaseModel):
    content: str = Field(default="", max_length=2000)


class CommentUpdate(BaseModel):
    content: Optional[str] = Field(default=None, max_length=2000)
    tags: Optional[list[str]] = None


class CommentSummary(BaseModel):
    id: str
    content: str
    created_by: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}

    @field_serializer("created_at")
    @classmethod
    def serialize_utc(cls, v: datetime) -> str:
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()


class CommentResponse(BaseModel):
    id: str
    article_id: str
    content: str
    tags: list[str]
    entities: Optional[dict] = None
    processing: Optional[str] = None
    attachments: Optional[list[dict]] = None    # [{path, name, type}, ...]
    attachment_path: Optional[str] = None
    attachment_name: Optional[str] = None
    attachment_type: Optional[str] = None
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

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

    @field_validator("attachments", mode="before")
    @classmethod
    def parse_attachments(cls, v: object) -> Optional[list[dict]]:
        if v is None:
            return None
        if isinstance(v, str):
            return json.loads(v)
        if isinstance(v, list):
            return v
        return None

    @field_serializer("created_at", "updated_at")
    @classmethod
    def serialize_utc(cls, v: datetime) -> str:
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()


class ArticleListItem(ArticleResponse):
    comment_count: int = 0
    latest_comments: list[CommentSummary] = []


class AdvancedSearchResponse(BaseModel):
    """高级搜索响应：总数 + 分页列表项。"""

    total: int
    items: list[ArticleListItem] = Field(default_factory=list)


# ─── Stats ──────────────────────────────────────────

class StatsResponse(BaseModel):
    article_count: int
    category_count: int
    tag_count: int
    entity_count: int
