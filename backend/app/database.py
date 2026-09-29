import os
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./knowledge_base.db")

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    """Enable foreign key enforcement for every new SQLite connection."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys = ON")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def init_db():
    """Create all tables and apply migrations."""
    Base.metadata.create_all(bind=engine)
    # Add missing columns (SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS)
    with engine.connect() as conn:
        for col in ["entities", "processing", "created_by", "updated_by"]:
            try:
                conn.exec_driver_sql(f"ALTER TABLE articles ADD COLUMN {col} TEXT")
            except Exception:
                pass  # Column already exists
        for col in ["attachments"]:
            try:
                conn.exec_driver_sql(f"ALTER TABLE comments ADD COLUMN {col} TEXT")
            except Exception:
                pass  # Column already exists
        for col in ["entities"]:
            try:
                conn.exec_driver_sql(f"ALTER TABLE article_chunks ADD COLUMN {col} TEXT")
            except Exception:
                pass  # Column already exists
        # v2.2 向量迁移至 Qdrant：删除 article_chunks.embedding 列（向量只存 Qdrant，
        # 需 SQLite ≥ 3.35 支持 DROP COLUMN；失败仅告警，不影响启动——旧列保留无害）
        try:
            conn.exec_driver_sql("ALTER TABLE article_chunks DROP COLUMN embedding")
        except Exception:
            pass  # 列不存在（新库）或 SQLite 版本不支持
        for col in ["created_by"]:
            try:
                conn.exec_driver_sql(f"ALTER TABLE entity_infos ADD COLUMN {col} TEXT")
            except Exception:
                pass  # Column already exists
        for col in ["created_by", "created_at", "updated_at"]:
            try:
                conn.exec_driver_sql(f"ALTER TABLE categories ADD COLUMN {col} TEXT")
            except Exception:
                pass  # Column already exists
        conn.commit()
