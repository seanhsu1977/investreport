import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = "sqlite:///" + os.getenv("DATABASE_PATH", "./investreport.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False, "timeout": 30},
)

# 啟用 WAL 模式
from sqlalchemy import event
@event.listens_for(engine, "connect")
def set_wal_mode(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=10000")
    cursor.close()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _migrate():
    """補上新欄位（SQLite 不支援 CREATE TABLE 時自動加欄位）"""
    migrations = [
        ("sync_logs",      "no_report",    "INTEGER DEFAULT 0"),
        ("daily_articles", "fb_post_id",   "VARCHAR"),
        ("daily_articles", "fb_posted_at", "DATETIME"),
    ]
    for table, col, col_def in migrations:
        with engine.begin() as conn:
            try:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {col_def}"))
            except Exception:
                pass  # 欄位已存在，忽略


def init_db():
    from models import DriveFile, Report, Watchlist, FuturesChip, Stock, DailyArticle, SyncLog  # noqa: F401
    Base.metadata.create_all(bind=engine)
    _migrate()
