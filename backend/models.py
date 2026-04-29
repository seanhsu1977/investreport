from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, DateTime, Date, Text, ForeignKey, UniqueConstraint
from database import Base


class DriveFile(Base):
    __tablename__ = "drive_files"

    id = Column(Integer, primary_key=True)
    drive_file_id = Column(String, unique=True, nullable=False)
    filename = Column(String, nullable=False)
    processed_at = Column(DateTime, default=datetime.utcnow)


class Report(Base):
    __tablename__ = "reports"

    id = Column(Integer, primary_key=True)
    drive_file_id = Column(String, nullable=False)
    stock_code = Column(String, nullable=False, index=True)
    stock_name = Column(String)
    recommendation = Column(String)   # 買進 / 中立 / 賣出
    target_price = Column(Float)
    analyst = Column(String)
    report_date = Column(Date)
    summary = Column(Text)
    key_points = Column(Text)         # JSON array stored as string
    mentioned_stocks = Column(Text)   # JSON array of mentioned stock codes (for MARKET reports)
    source_filename = Column(String)  # 來源檔案名稱
    created_at = Column(DateTime, default=datetime.utcnow)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    google_id = Column(String, unique=True, nullable=False, index=True)
    email = Column(String, nullable=False)
    name = Column(String)
    picture = Column(String)       # Google 頭像 URL
    is_admin = Column(Integer, default=0)  # 1 = admin
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime, default=datetime.utcnow)


class LoginSession(Base):
    __tablename__ = "login_sessions"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    logged_in_at = Column(DateTime, default=datetime.utcnow)
    ip_address = Column(String)
    user_agent = Column(String)


class Watchlist(Base):
    __tablename__ = "watchlist"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    stock_code = Column(String, nullable=False)
    stock_name = Column(String)
    added_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("user_id", "stock_code", name="uq_watchlist_user_stock"),
    )


class Stock(Base):
    """股票主檔（中文股名標準來源，從 nstock.tw 同步）"""
    __tablename__ = "stocks"

    code = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
