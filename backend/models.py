from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, DateTime, Date, Text, ForeignKey, UniqueConstraint, Boolean
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
    price_at_report = Column(Float)   # 報告日收盤價（懶惰填充）
    price_5d_before = Column(Float)   # 報告前 5 日收盤價
    price_10d_before = Column(Float)  # 報告前 10 日收盤價
    price_20d_before = Column(Float)  # 報告前 20 日收盤價


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


class InviteCode(Base):
    __tablename__ = "invite_codes"

    id = Column(Integer, primary_key=True)
    code = Column(String, unique=True, nullable=False, index=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    used_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    used_at = Column(DateTime, nullable=True)
    is_active = Column(Integer, default=1)  # 0 = deactivated by admin


class WatchlistGroup(Base):
    __tablename__ = "watchlist_groups"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class Watchlist(Base):
    __tablename__ = "watchlist"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    stock_code = Column(String, nullable=False)
    stock_name = Column(String)
    group_id = Column(Integer, ForeignKey("watchlist_groups.id"), nullable=True)
    added_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("user_id", "stock_code", name="uq_watchlist_user_stock"),
    )


class FuturesChip(Base):
    """期交所單日籌碼面快照（TXF 法人未平倉 + TMF 散戶多空比 + 加權指數）"""
    __tablename__ = "futures_chips"

    date = Column(String, primary_key=True)   # YYYY-MM-DD
    payload = Column(Text, nullable=False)    # JSON: taifex.build_chip_snapshot 結果
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Stock(Base):
    """股票主檔（中文股名標準來源，從 nstock.tw 同步）"""
    __tablename__ = "stocks"

    code = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class SyncLog(Base):
    """每次 Google Drive 同步的執行記錄"""
    __tablename__ = "sync_logs"

    id = Column(Integer, primary_key=True)
    started_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)
    trigger = Column(String, default="manual")   # "manual" | "scheduled"
    processed = Column(Integer, default=0)
    skipped = Column(Integer, default=0)
    errors = Column(Integer, default=0)
    no_report = Column(Integer, default=0)   # processed but AI returned no result
    new_reports = Column(Integer, default=0)
    status = Column(String, default="running")   # "running" | "done" | "error"
    error_message = Column(Text, nullable=True)


class RecommendationCache(Base):
    """投顧精選預算快取（每天 07:00 Asia/Taipei 更新）"""
    __tablename__ = "recommendation_cache"

    cache_key = Column(String, primary_key=True)   # e.g. "30_1_all_20"
    payload = Column(Text, nullable=False)          # JSON
    computed_at = Column(DateTime, nullable=False)


class TxfCandle(Base):
    """台指期（TX 近月）日K 快取"""
    __tablename__ = "txf_candles"

    date    = Column(String, primary_key=True)  # YYYYMMDD
    open    = Column(Float, nullable=False)
    high    = Column(Float, nullable=False)
    low     = Column(Float, nullable=False)
    close   = Column(Float, nullable=False)
    volume  = Column(Integer, nullable=True)


class StockRecommendationReason(Base):
    """個股推薦理由快取（由 LLM 生成後暫存，附生成時間）"""
    __tablename__ = "stock_recommendation_reasons"

    stock_code = Column(String, primary_key=True)
    content    = Column(Text, nullable=False)
    generated_at = Column(DateTime, nullable=False)


class EtfDailyChange(Base):
    """ETF 每日成份股持股變化紀錄（來源：nstock ETF小百科）。"""
    __tablename__ = "etf_daily_changes"

    id         = Column(Integer, primary_key=True)
    etf_code   = Column(String, nullable=False, index=True)   # "00981A"
    date       = Column(String, nullable=False, index=True)   # "YYYY-MM-DD"
    stock_code = Column(String, nullable=False)
    stock_name = Column(String)
    shares_delta     = Column(Integer, default=0)   # >0 buy, <0 sell, 0 flat
    action           = Column(String, default="flat")  # "buy"|"sell"|"flat"
    price            = Column(Float, nullable=True)
    change_pct       = Column(Float, nullable=True)
    nstock_article_id = Column(Integer, nullable=True)

    __table_args__ = (UniqueConstraint("etf_code", "date", "stock_code"),)


class DailyArticle(Base):
    """每日 00981A × 投顧報告 自動生成的草稿文章。"""
    __tablename__ = "daily_articles"

    id = Column(Integer, primary_key=True)
    date = Column(String, unique=True, nullable=False, index=True)  # YYYY-MM-DD
    topic_stock_code = Column(String, nullable=False)
    topic_stock_name = Column(String)
    title = Column(String, nullable=False)
    content = Column(Text, nullable=False)        # Markdown / 純文字草稿
    raw_context = Column(Text)                    # JSON：餵給 LLM 的全部 context（debug 用）
    generated_at = Column(DateTime, default=datetime.utcnow)
    published_at = Column(DateTime, nullable=True)        # nStock 送出時間（向下相容）
    nstock_article_id = Column(Integer, nullable=True)
    threads_post_id = Column(String, nullable=True)        # Threads 主貼文 id（鏈頭）
    threads_posted_at = Column(DateTime, nullable=True)
    fb_post_id = Column(String, nullable=True)             # Facebook page post id ("PAGE_POST")
    fb_posted_at = Column(DateTime, nullable=True)


class MarketTechnicalSnapshot(Base):
    """大盤技術指標每日快照，供復盤使用。"""
    __tablename__ = "market_technical_snapshots"

    id         = Column(Integer, primary_key=True)
    date       = Column(String, nullable=False, index=True)   # YYYY-MM-DD
    index_key  = Column(String, nullable=False, default="taiex")  # taiex / twoii
    payload    = Column(Text, nullable=False)                  # JSON: KlineTechnical
    saved_at   = Column(DateTime, default=datetime.utcnow)


class KdjScreenCache(Base):
    """KDJ(89,9,12) 選股結果快取，由排程每日收盤後更新。"""
    __tablename__ = "kdj_screen_cache"

    id          = Column(Integer, primary_key=True)
    computed_at = Column(String, nullable=False)   # ISO datetime (Asia/Taipei)
    data_date   = Column(String, nullable=False)   # YYYY-MM-DD 資料日期
    scanned     = Column(Integer, nullable=False, default=0)
    items_json  = Column(Text, nullable=False)     # JSON array of KdjScreenItem
