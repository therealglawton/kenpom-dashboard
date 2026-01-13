import os
import requests
from fastapi import HTTPException
from utils.dates import kp_date
from services.cache_sqlite import init_cache, cached_call

KENPOM_API_URL = "https://kenpom.com/api.php"

# Initialize cache once (safe to call multiple times)
init_cache()

def _ttl_seconds(date_yyyy_mm_dd: str) -> int:
    """
    date_yyyy_mm_dd is whatever you pass into kp_date() (your system's date format).
    Keep it simple: short TTL for "today", long TTL for past dates.
    """
    # If you have a helper like utils.dates.today_kp() use that.
    # Otherwise compare to kp_date of today's date in your app.
    try:
        from datetime import date
        today_str = date.today().isoformat()  # "YYYY-MM-DD"
    except Exception:
        today_str = ""

    if date_yyyy_mm_dd == today_str:
        return 90  # 90s for today
    return 60 * 60 * 24 * 14  # 14 days for past dates

def fetch_fanmatch(date_kp: str) -> list[dict]:
    api_key = os.getenv("KENPOM_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="KENPOM_API_KEY is missing")

    # IMPORTANT: cache by the *normalized* KenPom date param you actually send
    d = kp_date(date_kp)
    cache_key = f"kenpom:fanmatch:d={d}"

    headers = {"Authorization": f"Bearer {api_key}"}
    params = {"endpoint": "fanmatch", "d": d}
    ttl = _ttl_seconds(d)

    def fetch_fn():
        try:
            r = requests.get(KENPOM_API_URL, params=params, headers=headers, timeout=15)
        except Exception as e:
            # Don't cache exceptions; bubble as 500
            raise HTTPException(status_code=500, detail=f"KenPom request failed: {type(e).__name__}: {e}")
        # Only return JSON if 200; otherwise return text for debug
        if r.status_code != 200:
            raise HTTPException(
                status_code=500,
                detail={"source": "kenpom", "requested_url": r.url, "status_code": r.status_code, "body_preview": r.text[:800]},
            )
        try:
            data = r.json()
        except Exception as ex:
            raise HTTPException(
                status_code=500,
                detail={"source": "kenpom", "error": "KenPom returned non-JSON", "body_preview": r.text[:800],
                        "exception": f"{type(ex).__name__}: {ex}"},
            )
        return 200, data

    status_code, data, source = cached_call(cache_key, ttl, fetch_fn)

    # cached_call only caches status==200; still validate shape
    if not isinstance(data, list):
        raise HTTPException(status_code=500, detail={"source": "kenpom", "error": "KenPom expected list", "type": str(type(data)), "data_preview": data})

    return data
