from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

SQLALCHEMY_DATABASE_URL = "sqlite:///./knowledge_base.db"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def init_db():
    """Create all tables and apply migrations."""
    Base.metadata.create_all(bind=engine)
    # Add missing columns (SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS)
    with engine.connect() as conn:
        try:
            conn.exec_driver_sql("ALTER TABLE articles ADD COLUMN entities TEXT")
        except Exception:
            pass  # Column already exists
        conn.commit()
