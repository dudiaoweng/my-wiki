from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base

from app.config import DATABASE_URL

# 数据库路径锚定仓库根 data/（config.py 默认值）；环境变量 DATABASE_URL 仍可覆盖
SQLALCHEMY_DATABASE_URL = DATABASE_URL

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
        # 注意：articles.entities / comments.entities 列（v2.3 前）的 DROP COLUMN
        # 不在这里执行——由 neo4j_store.migrate_and_drop_columns() 在数据加载进
        # Neo4j 之后才删除（启动懒迁移），防止先删列丢失历史实体数据
        for col in ["processing", "created_by", "updated_by"]:
            try:
                conn.exec_driver_sql(f"ALTER TABLE articles ADD COLUMN {col} TEXT")
            except Exception:
                pass  # Column already exists
        for col in ["attachments"]:
            try:
                conn.exec_driver_sql(f"ALTER TABLE comments ADD COLUMN {col} TEXT")
            except Exception:
                pass  # Column already exists
        # v2.2 向量迁移至 Qdrant：删除 article_chunks.embedding 列（向量只存 Qdrant，
        # 需 SQLite ≥ 3.35 支持 DROP COLUMN；失败仅告警，不影响启动——旧列保留无害）
        try:
            conn.exec_driver_sql("ALTER TABLE article_chunks DROP COLUMN embedding")
        except Exception:
            pass  # 列不存在（新库）或 SQLite 版本不支持
        # v2.3 块级实体标注快照列移除：QA 实体 chips 改由 Neo4j 即时派生
        # （快照改名不传播、重切即丢；旧数据无迁移价值，直接删除）
        try:
            conn.exec_driver_sql("ALTER TABLE article_chunks DROP COLUMN entities")
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
