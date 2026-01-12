# services/espn.py
import requests
from fastapi import HTTPException
from normalize import matchup_key

ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard"

def fetch_scoreboard(date_espn: str) -> dict:
    params = {"dates": date_espn, "groups": 50, "limit": 500}
    try:
        r = requests.get(ESPN_SCOREBOARD_URL, params=params, timeout=15)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ESPN request failed: {type(e).__name__}: {e}")

    if r.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail={"source": "espn", "requested_url": r.url, "status_code": r.status_code, "body_preview": r.text[:800]},
        )
    return r.json()

def parse_games(scoreboard_json: dict) -> list[dict]:
    events = scoreboard_json.get("events", []) or []
    games = []

    for ev in events:
        competitions = ev.get("competitions", []) or []
        if not competitions:
            continue
        comp = competitions[0]

        home = away = None
        home_score = away_score = None

        for c in comp.get("competitors", []) or []:
            team = (c.get("team") or {})
            name = team.get("shortDisplayName") or team.get("displayName") or team.get("name")

            score_raw = c.get("score")
            try:
                score = int(score_raw) if score_raw not in (None, "", " ") else None
            except Exception:
                score = None

            if c.get("homeAway") == "home":
                home = name
                home_score = score
            elif c.get("homeAway") == "away":
                away = name
                away_score = score

        start_utc = comp.get("startDate") or comp.get("date") or ev.get("date")

        # network best-effort
        network = ""
        broadcasts = comp.get("broadcasts", [])
        if isinstance(broadcasts, list) and broadcasts:
            names = broadcasts[0].get("names", []) or []
            if names:
                network = names[0] or ""
        if not network:
            network = comp.get("broadcast") or ""
        if not network:
            geo = comp.get("geoBroadcasts", [])
            if isinstance(geo, list) and geo:
                media = (geo[0].get("media") or {})
                network = media.get("shortName") or ""

        # status fields (UI uses these for live/final display)
        status = (comp.get("status") or {})
        stype = (status.get("type") or {})

        games.append({
            "event_id": ev.get("id"),
            "away": away,
            "home": home,
            "start_utc": start_utc,
            "network": network,
            "key": matchup_key(away, home),

            "status_state": stype.get("state"),          # pre/in/post
            "status_detail": stype.get("shortDetail"),   # Final, 2nd Half - 12:34
            "clock": status.get("clock"),
            "period": status.get("period"),
            "away_score": away_score,
            "home_score": home_score,
        })

    return games

def espn_game_url(event_id: str | None) -> str:
    if not event_id:
        return ""
    return f"https://www.espn.com/mens-college-basketball/game?gameId={event_id}"

def urls_by_event_id(date_espn: str) -> dict[str, str]:
    data = fetch_scoreboard(date_espn)
    out: dict[str, str] = {}
    for ev in (data.get("events") or []):
        event_id = ev.get("id")
        if event_id:
            sid = str(event_id)
            out[sid] = espn_game_url(sid)
    return out
