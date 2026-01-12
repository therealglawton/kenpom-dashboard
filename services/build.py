# services/build.py
from fastapi import HTTPException
from normalize import matchup_key
from utils.dates import kp_date, is_future_yyyymmdd_eastern
from services.espn import fetch_scoreboard, parse_games
from services.kenpom import fetch_fanmatch

def _kp_by_key(kp_rows: list[dict]) -> dict[str, dict]:
    out = {}
    for g in kp_rows:
        key = matchup_key(g.get("Visitor"), g.get("Home"))
        out[key] = g
    return out

def espn_only_games(date_espn: str) -> dict:
    espn_games = parse_games(fetch_scoreboard(date_espn))
    games = []
    for e in espn_games:
        games.append({
            "key": e.get("key"),
            "event_id": e.get("event_id"),
            "away": e.get("away"),
            "home": e.get("home"),
            "start_utc": e.get("start_utc"),
            "network": e.get("network"),

            # live fields still included (UI-safe)
            "status_state": e.get("status_state"),
            "status_detail": e.get("status_detail"),
            "clock": e.get("clock"),
            "period": e.get("period"),
            "away_score": e.get("away_score"),
            "home_score": e.get("home_score"),

            # KP fields empty
            "kp_found": False,
            "kp_game_id": None,
            "kp_home_pred": None,
            "kp_away_pred": None,
            "kp_home_wp": None,
            "kp_thrill": None,
            "kp_pred_tempo": None,
            "kp_home_rank": None,
            "kp_away_rank": None,
        })

    return {
        "date_espn": date_espn,
        "date_kp": kp_date(date_espn),
        "count": len(games),
        "games": games,
        "mode": "future",
        "warning": "Future date: KenPom data is not available until game day.",
    }

def merge_strict(date_espn: str, date_kp: str) -> dict:
    espn_games = parse_games(fetch_scoreboard(date_espn))
    kp_rows = fetch_fanmatch(date_kp)
    kp_by_key = _kp_by_key(kp_rows)

    merged = []
    missing = []
    for e in espn_games:
        kp = kp_by_key.get(e["key"])
        if not kp:
            missing.append(e)
            continue

        merged.append({
            "key": e["key"],
            "event_id": e["event_id"],
            "away": e["away"],
            "home": e["home"],
            "start_utc": e["start_utc"],
            "network": e["network"],

            "status_state": e.get("status_state"),
            "status_detail": e.get("status_detail"),
            "clock": e.get("clock"),
            "period": e.get("period"),
            "away_score": e.get("away_score"),
            "home_score": e.get("home_score"),

            "kp_found": True,
            "kp_game_id": kp.get("GameID"),
            "kp_home_pred": kp.get("HomePred"),
            "kp_away_pred": kp.get("VisitorPred"),
            "kp_home_wp": kp.get("HomeWP"),
            "kp_thrill": kp.get("ThrillScore"),
            "kp_pred_tempo": kp.get("PredTempo"),
            "kp_home_rank": kp.get("HomeRank"),
            "kp_away_rank": kp.get("VisitorRank"),
        })

    if missing:
        raise HTTPException(
            status_code=500,
            detail={"error": "Merge missing KenPom for some ESPN games", "missing_count": len(missing), "missing_sample": missing[:10]},
        )

    return {"date_espn": date_espn, "date_kp": kp_date(date_kp), "count": len(merged), "games": merged}

def merge_lenient(date_espn: str, date_kp: str) -> dict:
    espn_games = parse_games(fetch_scoreboard(date_espn))
    kp_rows = fetch_fanmatch(date_kp)
    kp_by_key = _kp_by_key(kp_rows)

    merged = []
    for e in espn_games:
        kp = kp_by_key.get(e["key"])

        merged.append({
            "key": e["key"],
            "event_id": e["event_id"],
            "away": e["away"],
            "home": e["home"],
            "start_utc": e["start_utc"],
            "network": e["network"],

            "status_state": e.get("status_state"),
            "status_detail": e.get("status_detail"),
            "clock": e.get("clock"),
            "period": e.get("period"),
            "away_score": e.get("away_score"),
            "home_score": e.get("home_score"),

            "kp_found": kp is not None,
            "kp_game_id": kp.get("GameID") if kp else None,
            "kp_home_pred": kp.get("HomePred") if kp else None,
            "kp_away_pred": kp.get("VisitorPred") if kp else None,
            "kp_home_wp": kp.get("HomeWP") if kp else None,
            "kp_thrill": kp.get("ThrillScore") if kp else None,
            "kp_pred_tempo": kp.get("PredTempo") if kp else None,
            "kp_home_rank": kp.get("HomeRank") if kp else None,
            "kp_away_rank": kp.get("VisitorRank") if kp else None,
        })

    return {"date_espn": date_espn, "date_kp": kp_date(date_kp), "count": len(merged), "games": merged}

def build_games_for_date(date_espn: str, date_kp: str) -> dict:
    if is_future_yyyymmdd_eastern(date_espn):
        return espn_only_games(date_espn)

    # strict then fallback to lenient (same as your current behavior)
    try:
        return merge_strict(date_espn, date_kp)
    except HTTPException as e:
        detail = e.detail if isinstance(e.detail, dict) else {"error": str(e.detail)}
        if detail.get("error") != "Merge missing KenPom for some ESPN games":
            raise

        try:
            lenient = merge_lenient(date_espn, date_kp)
        except HTTPException as e2:
            detail2 = e2.detail if isinstance(e2.detail, dict) else {"error": str(e2.detail)}
            return {
                "date_espn": date_espn,
                "date_kp": kp_date(date_kp),
                "count": 0,
                "games": [],
                "warning": "Lenient merge failed; see error for details.",
                "error": detail2,
                "missing_count": detail.get("missing_count", 0),
                "missing_sample": detail.get("missing_sample", []),
            }

        lenient["missing_count"] = detail.get("missing_count", 0)
        lenient["missing_sample"] = detail.get("missing_sample", [])
        lenient["warning"] = "Some ESPN games did not match KenPom FanMatch for this date."
        return lenient
