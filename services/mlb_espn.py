# services/mlb_espn_scoreboard.py
from __future__ import annotations

from typing import Any, Dict, List, Optional
import requests

SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard"

def _safe_int(x: Any) -> Optional[int]:
    try:
        if x is None:
            return None
        if isinstance(x, str) and x.strip() == "":
            return None
        return int(float(x))
    except Exception:
        return None

def get_mlb_games(date_yyyymmdd: str, timeout: int = 12) -> List[Dict[str, Any]]:
    """
    date_yyyymmdd: '20260113'
    Returns a list of games with teams + status + (final/live) scores when present.
    """
    r = requests.get(
        SCOREBOARD_URL,
        params={"dates": date_yyyymmdd},
        timeout=timeout,
        headers={"User-Agent": "cbb-dashboard/1.0"},
    )
    r.raise_for_status()
    data = r.json()

    out: List[Dict[str, Any]] = []
    for ev in data.get("events", []) or []:
        event_id = ev.get("id")
        competitions = ev.get("competitions") or []
        if not competitions:
            continue
        comp = competitions[0]

        status = (comp.get("status") or {})
        st_type = (status.get("type") or {})
        state = st_type.get("state")  # "pre", "in", "post"
        detail = st_type.get("detail") or st_type.get("description") or ""

        # Teams + scores
        home = away = None
        for c in comp.get("competitors", []) or []:
            side = c.get("homeAway")
            team = c.get("team") or {}
            item = {
                "id": team.get("id"),
                "abbr": team.get("abbreviation"),
                "name": team.get("displayName"),
                "score": None if state == "pre" else _safe_int(c.get("score")),
            }
            if side == "home":
                home = item
            elif side == "away":
                away = item

        # Start time
        start_time = comp.get("date")  # ISO string

        out.append({
            "id": event_id,
            "startTime": start_time,
            "state": state,          # pre / in / post
            "status": detail,        # "Final", "Scheduled", etc.
            "home": home,
            "away": away,
        })

    return out
