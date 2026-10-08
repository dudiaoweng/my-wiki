import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, Text, DateTime, ForeignKey, Index
from sqlalchemy.orm import relationship
from app.database import Base


def generate_uuid():
    return str(uuid.uuid4())


def utcnow():
    return datetime.now(timezone.utc)


class Category(Base):
    __tablename__ = "categories"

    id = Column(String, primary_key=True, default=generate_uuid)
    name = Column(String(100), nullable=False, unique=True)
    color = Column(String(7), nullable=False)
    created_by = Column(String(200), nullable=True, default=None)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    articles = relationship("Article", back_populates="category", cascade="save-update")

    def __repr__(self):
        return f"<Category {self.name}>"


class Article(Base):
    __tablename__ = "articles"

    id = Column(String, primary_key=True, default=generate_uuid)
    title = Column(String(200), nullable=False)
    content = Column(Text, nullable=False, default="")
    category_id = Column(String, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True)
    tags = Column(Text, nullable=False, default="[]")
    # 实体/关系已迁移至 Neo4j（v2.3）：实体节点 + 提及边 + 关系边只存 Neo4j，
    # 文章接口的 entities 字段由 neo4j_store 组装后挂在 ORM 实例临时属性上
    processing = Column(Text, nullable=True, default=None)  # "processing" | None(completed)
    created_by = Column(String(200), nullable=True, default=None)   # CN from client cert
    updated_by = Column(String(200), nullable=True, default=None)   # CN from client cert
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False, index=True)
    attachment_path = Column(String, nullable=True)
    attachment_name = Column(String, nullable=True)
    attachment_type = Column(String, nullable=True)

    category = relationship("Category", back_populates="articles")
    chunks = relationship("ArticleChunk", back_populates="article", cascade="all, delete-orphan")
    comments = relationship("Comment", back_populates="article", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<Article {self.title}>"


class Comment(Base):
    __tablename__ = "comments"

    id = Column(String, primary_key=True, default=generate_uuid)
    article_id = Column(String, ForeignKey("articles.id", ondelete="CASCADE"), nullable=False, index=True)
    content = Column(Text, nullable=False, default="")
    tags = Column(Text, nullable=False, default="[]")         # JSON array — LLM 提取的标签
    # 实体/关系已迁移至 Neo4j（v2.3）：评论的贡献以 MENTIONS/RELATES 边的 source='comment:<id>' 标识
    processing = Column(Text, nullable=True, default=None)    # "processing" | None(completed)
    attachments = Column(Text, nullable=True, default=None)   # JSON array: [{path, name, type}, ...]
    attachment_path = Column(String, nullable=True)            # legacy — kept for backward compat
    attachment_name = Column(String, nullable=True)
    attachment_type = Column(String, nullable=True)
    created_by = Column(String(200), nullable=False, default="")  # CN from client cert
    updated_by = Column(String(200), nullable=False, default="")  # CN from client cert
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    article = relationship("Article", back_populates="comments")

    def __repr__(self):
        return f"<Comment {self.id[:8]} on {self.article_id[:8]}>"


class ArticleChunk(Base):
    __tablename__ = "article_chunks"

    id = Column(String, primary_key=True, default=generate_uuid)
    article_id = Column(String, ForeignKey("articles.id", ondelete="CASCADE"), nullable=False, index=True)
    chunk_index = Column(String, nullable=False)  # e.g. "0", "1", "1.2"
    chunk_text = Column(Text, nullable=False)
    # 向量只存 Qdrant（Qdrant 为向量唯一存储）；SQLite 仅保留分块文本。
    # 实体归属唯一存 Neo4j；QA 来源卡片的实体 chips 由 Neo4j 实体名与
    # chunk_text 子串匹配即时派生（v2.3 移除块级实体标注快照列）

    article = relationship("Article", back_populates="chunks")

    def __repr__(self):
        return f"<Chunk {self.article_id}[{self.chunk_index}]>"


class EntityInfo(Base):
    """Additional information entries attached to an entity (知识图谱实体的附加信息)."""
    __tablename__ = "entity_infos"

    id = Column(String, primary_key=True, default=generate_uuid)
    entity_name = Column(String(200), nullable=False, index=True)  # which entity this info belongs to
    name = Column(String(100), nullable=False, default="")          # 名称
    content = Column(Text, nullable=False, default="")              # 内容
    created_by = Column(String(200), nullable=True, default=None)   # CN from client cert
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    def __repr__(self):
        return f"<EntityInfo {self.entity_name} [{self.name}]>"
