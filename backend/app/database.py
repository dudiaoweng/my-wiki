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
        conn.commit()
