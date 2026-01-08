from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse
import os
import re
import unicodedata
import requests
from datetime import datetime
from zoneinfo import ZoneInfo
from normalize import normalize_team, matchup_key


app = FastAPI()

from fastapi.responses import FileResponse

from fastapi.staticfiles import StaticFiles
from pathlib import Path

STATIC_DIR = Path(__file__).with_name("static")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(STATIC_DIR / "favicon.ico")



@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/ui")

def espn_game_url(event_id: str | None) -> str:
    if not event_id:
        return ""
    # Durable form:
    return f"https://www.espn.com/mens-college-basketball/game?gameId={event_id}"
    # If you prefer the pretty path:
    # return f"https://www.espn.com/mens-college-basketball/game/_/gameId/{event_id}"


@app.get("/urls/espn")
def urls_espn(date_espn: str | None = Query(default=None)):
    """
    Returns ESPN game page URLs keyed by event_id for a given date.
    date_espn: YYYYMMDD (defaults to today Eastern)
    """
    date_espn = date_espn or today_yyyymmdd_eastern()

    url = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard"
    params = {"dates": date_espn, "groups": 50, "limit": 500}

    try:
        r = requests.get(url, params=params, timeout=15)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ESPN request failed: {type(e).__name__}: {e}")

    if r.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail={
                "source": "espn",
                "requested_url": r.url,
                "status_code": r.status_code,
                "body_preview": r.text[:800],
            },
        )

    data = r.json()
    events = data.get("events", [])

    urls_by_event_id: dict[str, str] = {}
    for ev in events:
        event_id = ev.get("id")
        if event_id:
            event_id = str(event_id)
            urls_by_event_id[event_id] = espn_game_url(event_id)

    return {"date_espn": date_espn, "count": len(urls_by_event_id), "urls_by_event_id": urls_by_event_id}

# ---------- Date helpers ----------

def today_yyyymmdd_eastern() -> str:
    return datetime.now(ZoneInfo("America/New_York")).strftime("%Y%m%d")


def kp_date(d: str) -> str:
    """
    KenPom expects YYYY-MM-DD.
    Accepts YYYYMMDD or YYYY-MM-DD and returns YYYY-MM-DD.
    """
    d = (d or "").strip()
    if re.fullmatch(r"\d{8}", d):  # YYYYMMDD
        return f"{d[:4]}-{d[4:6]}-{d[6:8]}"
    return d

# ---------- Health / env ----------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/debug/env")
def debug_env():
    key = os.getenv("KENPOM_API_KEY")
    if not key:
        raise HTTPException(
            status_code=500,
            detail="KENPOM_API_KEY is missing. Check your Render env vars or .env locally.",
        )
    return {"kenpom_key_loaded": True, "key_length": len(key)}


# ---------- ESPN debug ----------

@app.get("/debug/espn")
def debug_espn(date: str):
    # date format: YYYYMMDD (example: 20260106)
    url = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard"
    params = {"dates": date, "groups": 50, "limit": 500}

    r = requests.get(url, params=params, timeout=15)
    if r.status_code != 200:
        return {
            "requested_url": r.url,
            "status_code": r.status_code,
            "body_preview": r.text[:800],
        }

    data = r.json()
    events = data.get("events", [])

    cleaned = []
    for ev in events:
        competitions = ev.get("competitions", [])
        if not competitions:
            continue
        comp = competitions[0]

        home = away = None
        for c in comp.get("competitors", []):
            team = c.get("team", {})
            name = team.get("shortDisplayName") or team.get("displayName") or team.get("name")
            if c.get("homeAway") == "home":
                home = name
            elif c.get("homeAway") == "away":
                away = name

        start_utc = comp.get("startDate") or comp.get("date") or ev.get("date")

        network = ""
        broadcasts = comp.get("broadcasts", [])
        if broadcasts and isinstance(broadcasts, list):
            names = broadcasts[0].get("names", [])
            if names:
                network = names[0]
        if not network:
            network = comp.get("broadcast") or ""
        if not network:
            geo = comp.get("geoBroadcasts", [])
            if geo and isinstance(geo, list):
                media = geo[0].get("media", {})
                network = media.get("shortName") or ""

        cleaned.append(
            {
                "event_id": ev.get("id"),
                "away": away,
                "home": home,
                "start_utc": start_utc,
                "network": network,
            }
        )

    return {"requested_url": r.url, "status_code": 200, "count": len(cleaned), "games": cleaned[:25]}


# ---------- KenPom debug ----------

@app.get("/debug/kenpom")
def debug_kenpom(date: str):
    # KenPom FanMatch expects YYYY-MM-DD (we also accept YYYYMMDD)
    api_key = os.getenv("KENPOM_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="KENPOM_API_KEY is missing")

    url = "https://kenpom.com/api.php"
    params = {"endpoint": "fanmatch", "d": kp_date(date)}
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        r = requests.get(url, params=params, headers=headers, timeout=15)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"KenPom request failed: {type(e).__name__}: {e}")

    if r.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail={"requested_url": r.url, "status_code": r.status_code, "body_preview": r.text[:800]},
        )

    try:
        data = r.json()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"KenPom returned non-JSON: {type(e).__name__}: {e}. Body preview: {r.text[:800]}",
        )

    if not isinstance(data, list):
        raise HTTPException(
            status_code=500,
            detail={"error": "Expected a list from KenPom FanMatch", "type": str(type(data)), "data_preview": data},
        )

    return {"requested_url": r.url, "status_code": 200, "count": len(data), "games": data[:25]}


# ---------- Strict match debug ----------

@app.get("/debug/match")
def debug_match(date_espn: str, date_kp: str):
    """
    date_espn: YYYYMMDD
    date_kp:   YYYYMMDD or YYYY-MM-DD (we normalize for KenPom)
    """
    url = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard"
    params = {"dates": date_espn, "groups": 50, "limit": 500}

    try:
        r = requests.get(url, params=params, timeout=15)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ESPN request failed: {type(e).__name__}: {e}")

    if r.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail={
                "source": "espn",
                "requested_url": r.url,
                "status_code": r.status_code,
                "body_preview": r.text[:800],
            },
        )

    data = r.json()
    events = data.get("events", [])

    espn_games = []
    for ev in events:
        competitions = ev.get("competitions", [])
        if not competitions:
            continue
        comp = competitions[0]

        home = away = None
        for c in comp.get("competitors", []):
            team = c.get("team", {})
            name = team.get("shortDisplayName") or team.get("displayName") or team.get("name")
            if c.get("homeAway") == "home":
                home = name
            elif c.get("homeAway") == "away":
                away = name

        start_utc = comp.get("startDate") or comp.get("date") or ev.get("date")

        network = ""
        broadcasts = comp.get("broadcasts", [])
        if broadcasts and isinstance(broadcasts, list):
            names = broadcasts[0].get("names", [])
            if names:
                network = names[0]
        if not network:
            network = comp.get("broadcast") or ""
        if not network:
            geo = comp.get("geoBroadcasts", [])
            if geo and isinstance(geo, list):
                media = geo[0].get("media", {})
                network = media.get("shortName") or ""

        espn_games.append(
            {
                "event_id": ev.get("id"),
                "away": away,
                "home": home,
                "start_utc": start_utc,
                "network": network,
                "key": matchup_key(away, home),
            }
        )

    api_key = os.getenv("KENPOM_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="KENPOM_API_KEY is missing")

    kp_url = "https://kenpom.com/api.php"
    kp_params = {"endpoint": "fanmatch", "d": kp_date(date_kp)}
    kp_headers = {"Authorization": f"Bearer {api_key}"}

    try:
        kp_r = requests.get(kp_url, params=kp_params, headers=kp_headers, timeout=15)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"KenPom request failed: {type(e).__name__}: {e}")

    if kp_r.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail={
                "source": "kenpom",
                "requested_url": kp_r.url,
                "status_code": kp_r.status_code,
                "body_preview": kp_r.text[:800],
            },
        )

    kp_data = kp_r.json()
    if not isinstance(kp_data, list):
        raise HTTPException(status_code=500, detail={"error": "KenPom expected list", "type": str(type(kp_data))})

    kp_games = []
    for g in kp_data:
        away = g.get("Visitor")
        home = g.get("Home")
        kp_games.append(
            {
                "GameID": g.get("GameID"),
                "away": away,
                "home": home,
                "key": matchup_key(away, home),
                "HomePred": g.get("HomePred"),
                "VisitorPred": g.get("VisitorPred"),
                "HomeWP": g.get("HomeWP"),
                "ThrillScore": g.get("ThrillScore"),
            }
        )

    kp_by_key = {g["key"]: g for g in kp_games}

    matched = []
    espn_only = []
    for e in espn_games:
        kp = kp_by_key.get(e["key"])
        if kp:
            matched.append({"key": e["key"], "espn": e, "kenpom": kp})
        else:
            espn_only.append(e)

    espn_keys = {g["key"] for g in espn_games}
    kenpom_only = [g for g in kp_games if g["key"] not in espn_keys]

    return {
        "date_espn": date_espn,
        "date_kp": kp_date(date_kp),
        "counts": {
            "espn": len(espn_games),
            "kenpom": len(kp_games),
            "matched": len(matched),
            "espn_only": len(espn_only),
            "kenpom_only": len(kenpom_only),
        },
        "sample": {"matched": matched[:10], "espn_only": espn_only[:10], "kenpom_only": kenpom_only[:10]},
    }

def parse_espn_games(data: dict) -> list[dict]:
    events = data.get("events", [])
    espn_games = []

    for ev in events:
        competitions = ev.get("competitions", [])
        if not competitions:
            continue
        comp = competitions[0]

        home = away = None
        for c in comp.get("competitors", []):
            team = c.get("team", {})
            name = team.get("shortDisplayName") or team.get("displayName") or team.get("name")
            if c.get("homeAway") == "home":
                home = name
            elif c.get("homeAway") == "away":
                away = name

        start_utc = comp.get("startDate") or comp.get("date") or ev.get("date")

        network = ""
        broadcasts = comp.get("broadcasts", [])
        if broadcasts and isinstance(broadcasts, list):
            names = broadcasts[0].get("names", [])
            if names:
                network = names[0]
        if not network:
            network = comp.get("broadcast") or ""
        if not network:
            geo = comp.get("geoBroadcasts", [])
            if geo and isinstance(geo, list):
                media = geo[0].get("media", {})
                network = media.get("shortName") or ""

        espn_games.append(
            {
                "event_id": ev.get("id"),
                "away": away,
                "home": home,
                "start_utc": start_utc,
                "network": network,
                "key": matchup_key(away, home),
            }
        )

    return espn_games

# ---------- Strict merge (raises if any missing) ----------

@app.get("/debug/merge")
def debug_merge(date_espn: str, date_kp: str):
    """
    Returns merged games (ESPN time/network + KenPom FanMatch predictions)
    date_espn: YYYYMMDD
    date_kp:   YYYYMMDD or YYYY-MM-DD (we normalize for KenPom)
    """
    url = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard"
    params = {"dates": date_espn, "groups": 50, "limit": 500}

    r = requests.get(url, params=params, timeout=15)
    if r.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail={"source": "espn", "requested_url": r.url, "status_code": r.status_code, "body_preview": r.text[:800]},
        )

    data = r.json()
    espn_games = parse_espn_games(data)


    api_key = os.getenv("KENPOM_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="KENPOM_API_KEY is missing")

    kp_url = "https://kenpom.com/api.php"
    kp_params = {"endpoint": "fanmatch", "d": kp_date(date_kp)}
    kp_headers = {"Authorization": f"Bearer {api_key}"}

    kp_r = requests.get(kp_url, params=kp_params, headers=kp_headers, timeout=15)
    if kp_r.status_code != 200:
        raise HTTPException(
            status_code=500,
            detail={"source": "kenpom", "requested_url": kp_r.url, "status_code": kp_r.status_code, "body_preview": kp_r.text[:800]},
        )

    kp_data = kp_r.json()
    if not isinstance(kp_data, list):
        raise HTTPException(status_code=500, detail={"error": "KenPom expected list", "type": str(type(kp_data))})

    kp_by_key = {}
    for g in kp_data:
        key = matchup_key(g.get("Visitor"), g.get("Home"))
        kp_by_key[key] = g

    merged = []
    missing = []
    for e in espn_games:
        kp = kp_by_key.get(e["key"])
        if not kp:
            missing.append(e)
            continue

        merged.append(
            {
                "key": e["key"],
                "event_id": e["event_id"],
                "away": e["away"],
                "home": e["home"],
                "start_utc": e["start_utc"],
                "network": e["network"],
                "kp_game_id": kp.get("GameID"),
                "kp_home_pred": kp.get("HomePred"),
                "kp_away_pred": kp.get("VisitorPred"),
                "kp_home_wp": kp.get("HomeWP"),
                "kp_thrill": kp.get("ThrillScore"),
                "kp_pred_tempo": kp.get("PredTempo"),
                "kp_home_rank": kp.get("HomeRank"),
                "kp_away_rank": kp.get("VisitorRank"),
            }
        )

    if missing:
        raise HTTPException(
            status_code=500,
            detail={"error": "Merge missing KenPom for some ESPN games", "missing_count": len(missing), "missing_sample": missing[:10]},
        )

    return {"date_espn": date_espn, "date_kp": kp_date(date_kp), "count": len(merged), "games": merged}


# ---------- UI endpoint ----------

@app.get("/games")
def games(
    date_espn: str | None = Query(default=None),
    date_kp: str | None = Query(default=None),
):
    date_espn = date_espn or today_yyyymmdd_eastern()
    date_kp = date_kp or date_espn
    return build_games_for_date(date_espn, date_kp)


def build_games_for_date(date_espn: str, date_kp: str | None = None) -> dict:
    date_kp = date_kp or date_espn

    # reuse existing strict merge logic
    try:
        return debug_merge(date_espn=date_espn, date_kp=date_kp)
    except HTTPException as e:
        detail = e.detail if isinstance(e.detail, dict) else {"error": str(e.detail)}

        if detail.get("error") != "Merge missing KenPom for some ESPN games":
            raise

        return {
            "date_espn": date_espn,
            "date_kp": kp_date(date_kp),
            "count": 0,
            "games": [],
            "missing_count": detail.get("missing_count", 0),
            "missing_sample": detail.get("missing_sample", []),
            "warning": "Some ESPN games did not match KenPom FanMatch for this date.",
        }


from pathlib import Path
from fastapi.responses import HTMLResponse

UI_PATH = Path(__file__).with_name("ui.html")

@app.get("/ui", response_class=HTMLResponse)
def ui():
    return UI_PATH.read_text(encoding="utf-8")

