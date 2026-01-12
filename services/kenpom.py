# services/kenpom.py
import os
import requests
from fastapi import HTTPException
from utils.dates import kp_date

KENPOM_API_URL = "https://kenpom.com/api.php"

def fetch_fanmatch(date_kp: str) -> list[dict]:
    api_key = os.getenv("KENPOM_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="KENPOM_API_KEY is missing")

    params = {"endpoint": "fanmatch", "d": kp_date(date_kp)}
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        r = requests.get(KENPOM_API_URL, params=params, headers=headers, timeout=15)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"KenPom request failed: {type(e).__name__}: {e}")

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
            detail={"source": "kenpom", "error": "KenPom returned non-JSON", "body_preview": r.text[:800], "exception": f"{type(ex).__name__}: {ex}"},
        )

    if not isinstance(data, list):
        raise HTTPException(status_code=500, detail={"source": "kenpom", "error": "KenPom expected list", "type": str(type(data)), "data_preview": data})

    return data
