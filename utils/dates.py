# utils/dates.py
import re
from datetime import datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/New_York")

def today_yyyymmdd_eastern() -> str:
    return datetime.now(TZ).strftime("%Y%m%d")

def kp_date(d: str) -> str:
    """KenPom expects YYYY-MM-DD. Accepts YYYYMMDD or YYYY-MM-DD."""
    d = (d or "").strip()
    if re.fullmatch(r"\d{8}", d):
        return f"{d[:4]}-{d[4:6]}-{d[6:8]}"
    return d

def is_future_yyyymmdd_eastern(date_espn: str) -> bool:
    try:
        d = datetime.strptime(date_espn, "%Y%m%d").date()
    except Exception:
        return False
    return d > datetime.now(TZ).date()
