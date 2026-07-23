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
    entities = Column(Text, nullable=True, default=None)  # LLM 提取的实体+关系 JSON
    processing = Column(Text, nullable=True, default=None)  # "processing" | None(completed)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False, index=True)
    attachment_path = Column(String, nullable=True)
    attachment_name = Column(String, nullable=True)
    attachment_type = Column(String, nullable=True)

    category = relationship("Category", back_populates="articles")
    chunks = relationship("ArticleChunk", back_populates="article", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<Article {self.title}>"


class ArticleChunk(Base):
    __tablename__ = "article_chunks"

    id = Column(String, primary_key=True, default=generate_uuid)
    article_id = Column(String, ForeignKey("articles.id", ondelete="CASCADE"), nullable=False, index=True)
    chunk_index = Column(String, nullable=False)  # e.g. "0", "1", "1.2"
    chunk_text = Column(Text, nullable=False)
    embedding = Column(Text, nullable=True)  # JSON array of floats

    article = relationship("Article", back_populates="chunks")

    def __repr__(self):
        return f"<Chunk {self.article_id}[{self.chunk_index}]>"


class EntityInfo(Base):
    """Additional information entries attached to an entity (知识图谱实体的附加信息)."""
    __tablename__ = "entity_infos"

    id = Column(String, primary_key=True, default=generate_uuid)
    entity_name = Column(String(200), nullable=False, index=True)  # which entity this info belongs to
    category = Column(String(100), nullable=False, default="")     # 类别
    content = Column(Text, nullable=False, default="")             # 内容
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    def __repr__(self):
        return f"<EntityInfo {self.entity_name} [{self.category}]>"
