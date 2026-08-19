from __future__ import annotations
import gc
import json
import logging
import os
from datetime import datetime, date
from io import BytesIO

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from sqlalchemy.orm import Session

import re
from analyzer import analyze_report, analyze_image_file
from models import DriveFile, Report

logger = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]


def extract_date_from_filename(filename: str) -> date | None:
    """從檔名嘗試解析日期，支援民國年（6-7碼）與西元年（8碼）"""
    name = filename.replace(".pdf", "").replace(".PDF", "")

    # 西元年：20251124 或 2025-11-24 或 2025_11_24
    m = re.search(r"(20\d{2})[-_]?(\d{2})[-_]?(\d{2})", name)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass

    # 民國年：1141124（7碼 YYYMMDD）或 1141124
    m = re.search(r"(?<!\d)(1[01]\d)(\d{2})(\d{2})(?!\d)", name)
    if m:
        try:
            roc_year = int(m.group(1))
            month = int(m.group(2))
            day = int(m.group(3))
            return date(1911 + roc_year, month, day)
        except ValueError:
            pass

    # 民國年 6 碼：141124（YY=14x → 判斷 >= 100 代表民國）
    m = re.search(r"(?<!\d)(\d{6})(?!\d)", name)
    if m:
        s = m.group(1)
        try:
            # 嘗試民國 YYMMDD（前兩碼 >= 10 視為民國年後兩碼）
            roc_2 = int(s[:2])
            month = int(s[2:4])
            day = int(s[4:6])
            if 1 <= month <= 12 and 1 <= day <= 31:
                return date(1911 + 100 + roc_2, month, day)
        except ValueError:
            pass

    return None


def get_drive_service():
    creds_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
    if creds_json:
        info = json.loads(creds_json)
        credentials = service_account.Credentials.from_service_account_info(
            info, scopes=SCOPES
        )
    else:
        creds_path = os.getenv("GOOGLE_CREDENTIALS_PATH", "./credentials.json")
        credentials = service_account.Credentials.from_service_account_file(
            creds_path, scopes=SCOPES
        )
    return build("drive", "v3", credentials=credentials)


# Claude Vision 支援的圖片 MIME type
IMAGE_MIME_TYPES = {
    "image/jpeg": "image/jpeg",
    "image/jpg":  "image/jpeg",
    "image/png":  "image/png",
    "image/webp": "image/webp",
    "image/gif":  "image/gif",
}

SUPPORTED_MIME_QUERY = (
    "mimeType='application/pdf' or "
    "mimeType='image/jpeg' or "
    "mimeType='image/png' or "
    "mimeType='image/webp' or "
    "mimeType='image/gif'"
)


def _collect_all_folder_ids(service, folder_id: str) -> list[str]:
    """BFS 收集 folder_id 及其所有子資料夾的 ID。"""
    all_ids = [folder_id]
    to_scan = [folder_id]
    while to_scan:
        current = to_scan.pop(0)
        page_token = None
        while True:
            resp = service.files().list(
                q=f"'{current}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
                fields="nextPageToken, files(id)",
                pageSize=1000,
            ).execute()
            for sf in resp.get("files", []):
                all_ids.append(sf["id"])
                to_scan.append(sf["id"])
            page_token = resp.get("nextPageToken")
            if not page_token:
                break
    return all_ids


def list_pdf_files(service, folder_id: str, since: str | None = None) -> list[dict]:
    """掃描資料夾（含所有子資料夾）中的 PDF 與圖片。

    兩階段策略：
    Phase 1 — BFS 收集所有子資料夾 ID（一次 API call per folder）
    Phase 2 — 批次查詢檔案（每批 50 個 folder，用 OR 合併成一個 query）
              100 個子資料夾只需 2 次檔案查詢（舊做法需 100 次）

    Args:
        since: RFC-3339 日期字串（如 "2024-01-01T00:00:00"），只列出此時間之後建立的檔案
    """
    # Phase 1: 收集所有 folder ID
    all_folder_ids = _collect_all_folder_ids(service, folder_id)

    # Phase 2: 批次查詢檔案（每批 50 個 folder，避免 query string 過長）
    results: list[dict] = []
    seen: set[str] = set()
    BATCH = 50
    for i in range(0, len(all_folder_ids), BATCH):
        batch = all_folder_ids[i:i + BATCH]
        parents_clause = " or ".join(f"'{fid}' in parents" for fid in batch)
        query = f"({parents_clause}) and ({SUPPORTED_MIME_QUERY}) and trashed=false"
        if since:
            query += f" and createdTime >= '{since}'"
        page_token = None
        while True:
            resp = service.files().list(
                q=query,
                fields="nextPageToken, files(id, name, mimeType, createdTime)",
                pageToken=page_token,
                pageSize=1000,
            ).execute()
            for f in resp.get("files", []):
                if f["id"] not in seen:
                    results.append(f)
                    seen.add(f["id"])
            page_token = resp.get("nextPageToken")
            if not page_token:
                break

    return results


def download_file(service, file_id: str) -> bytes:
    request = service.files().get_media(fileId=file_id)
    buffer = BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buffer.getvalue()


def sync_drive(db: Session, progress: dict | None = None, cancelled=None, since: str | None = None) -> dict:
    """同步 Google Drive 檔案

    Args:
        since: 只同步此日期之後建立的檔案，格式 "YYYY-MM-DD"（會自動補 T00:00:00）
    """
    folder_ids_raw = os.getenv("GOOGLE_DRIVE_FOLDER_ID")
    if not folder_ids_raw:
        raise ValueError("GOOGLE_DRIVE_FOLDER_ID not set")

    folder_ids = [fid.strip() for fid in folder_ids_raw.split(",") if fid.strip()]
    service = get_drive_service()

    # 轉成 RFC-3339 格式（Drive API 要求）
    since_rfc = f"{since}T00:00:00" if since and len(since) == 10 else since

    files = []
    seen_ids = set()
    for fid in folder_ids:
        for f in list_pdf_files(service, fid, since=since_rfc):
            if f["id"] not in seen_ids:
                files.append(f)
                seen_ids.add(f["id"])

    processed = 0
    skipped = 0
    errors = 0
    no_report = 0
    failed: list[dict] = []

    if progress is not None:
        progress["total"] = len(files)

    for file in files:
        # 檢查是否已取消
        if cancelled and cancelled():
            logger.info("Sync cancelled by user")
            if progress is not None:
                progress["running"] = False
            return {
                "processed": processed, "skipped": skipped, "errors": errors,
                "synced_at": datetime.utcnow().isoformat(),
                "warning": "同步已被使用者中止。",
            }

        file_id = file["id"]
        filename = file["name"]

        # 已處理過則跳過
        existing = db.query(DriveFile).filter(DriveFile.drive_file_id == file_id).first()
        if existing:
            skipped += 1
            if progress is not None:
                progress["skipped"] = skipped
            continue

        if progress is not None:
            progress["current"] = filename

        try:
            logger.info(f"Processing: {filename}")
            file_bytes = download_file(service, file_id)
            mime_type = file.get("mimeType", "application/pdf")

            if mime_type in IMAGE_MIME_TYPES:
                result = analyze_image_file(file_bytes, IMAGE_MIME_TYPES[mime_type], filename=filename)
            else:
                result = analyze_report(file_bytes, filename=filename)

            if not result:
                logger.warning("No result for %s (AI returned None or invalid JSON)", filename)
                no_report += 1
                if progress is not None:
                    progress["no_report"] = no_report
            else:
                # 將日期字串轉為 Python date 物件
                report_date = None
                raw_date = result.get("report_date")
                if raw_date:
                    try:
                        report_date = date.fromisoformat(str(raw_date)[:10])
                    except (ValueError, TypeError):
                        pass
                # Claude 沒有提取到日期時，從檔名解析（支援民國年）
                if report_date is None:
                    report_date = extract_date_from_filename(filename)

                stock_code = result.get("stock_code") or "MARKET"
                report = Report(
                    drive_file_id=file_id,
                    stock_code=stock_code,
                    stock_name=result.get("stock_name"),
                    # 市場新聞不套用個股評等
                    recommendation=result.get("recommendation") if stock_code != "MARKET" else None,
                    target_price=result.get("target_price"),
                    analyst=result.get("analyst"),
                    report_date=report_date,
                    summary=result.get("summary"),
                    key_points=json.dumps(result.get("key_points", []), ensure_ascii=False),
                    mentioned_stocks=json.dumps(list(dict.fromkeys(result.get("mentioned_stocks", []))), ensure_ascii=False),
                    source_filename=filename,
                )
                db.add(report)

            drive_file = DriveFile(drive_file_id=file_id, filename=filename)
            db.add(drive_file)
            db.commit()
            processed += 1
            if progress is not None:
                progress["processed"] = processed
            del file_bytes, result

        except Exception as e:
            err_str = str(e)
            logger.error(f"Error processing {filename}: {err_str}")
            db.rollback()
            errors += 1
            failed.append({"filename": filename, "error": err_str[:200]})
            if progress is not None:
                progress["errors"] = errors
            # 餘額不足時立即停止，避免浪費重試次數
            if "credit balance is too low" in err_str:
                return {
                    "processed": processed,
                    "skipped": skipped,
                    "errors": errors,
                    "no_report": no_report,
                    "failed": failed,
                    "synced_at": datetime.utcnow().isoformat(),
                    "warning": "Anthropic API 餘額不足，請至 console.anthropic.com 充值後再同步。",
                }

        # 大量檔案（補歷史缺漏）時，PDF 文字/圖片轉換物件會逐筆累積，
        # 每 10 筆主動 GC 一次，避免長時間批次跑到後段記憶體越疊越高
        if (processed + errors) % 10 == 0:
            gc.collect()

    return {
        "processed": processed,
        "skipped": skipped,
        "errors": errors,
        "no_report": no_report,
        "failed": failed,
        "synced_at": datetime.utcnow().isoformat(),
    }
