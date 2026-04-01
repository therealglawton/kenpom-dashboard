# services/mlb_espn_scoreboard.py
from __future__ import annotations

from typing import Any, Dict, List, Optional
import requests

SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard"
SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary"
REQUEST_HEADERS = {"User-Agent": "cbb-dashboard/1.0"}

def mlb_game_url(event_id: str | None) -> str:
    if not event_id:
        return ""
    return f"https://www.espn.com/mlb/game/_/gameId/{event_id}"

def _safe_int(x: Any) -> Optional[int]:
    try:
        if x is None:
            return None
        if isinstance(x, str) and x.strip() == "":
            return None
        return int(float(x))
    except Exception:
        return None


def _extract_probable_name_id(athlete_like: Any, fallback_id: Any = None) -> Optional[Dict[str, Any]]:
    if athlete_like is None:
        return None

    if isinstance(athlete_like, dict):
        # ESPN frequently wraps live batter/pitcher data as
        # {"athlete": {...}, "playerId": "..."}. Unwrap first.
        nested = athlete_like.get("athlete") or athlete_like.get("player")
        if isinstance(nested, dict):
            nested_pid = athlete_like.get("playerId") or athlete_like.get("id") or fallback_id
            return _extract_probable_name_id(nested, nested_pid)

        name = (
            athlete_like.get("displayName")
            or athlete_like.get("fullName")
            or athlete_like.get("shortName")
            or athlete_like.get("name")
        )
        pid = athlete_like.get("id") or athlete_like.get("playerId") or fallback_id
        return {"id": pid, "name": name} if (name or pid) else None

    name = str(athlete_like).strip()
    return {"id": fallback_id, "name": name} if (name or fallback_id) else None


def _channels_from_competition(comp: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    for b in comp.get("broadcasts") or []:
        if not isinstance(b, dict):
            continue
        names = b.get("names") or []
        if isinstance(names, list):
            for n in names:
                s = str(n or "").strip()
                if s:
                    out.append(s)
    # de-dupe while preserving order
    dedup: List[str] = []
    seen = set()
    for c in out:
        if c not in seen:
            seen.add(c)
            dedup.append(c)
    return dedup


def _extract_decisions_from_status(status_obj: Any) -> Optional[Dict[str, Dict[str, Any]]]:
    if not isinstance(status_obj, dict):
        return None

    featured = status_obj.get("featuredAthletes") or []
    if not isinstance(featured, list) or not featured:
        return None

    out: Dict[str, Dict[str, Any]] = {}
    for item in featured:
        if not isinstance(item, dict):
            continue

        raw_name = str(item.get("name") or "").strip().lower()
        if raw_name == "winningpitcher":
            key = "winning"
        elif raw_name == "losingpitcher":
            key = "losing"
        elif raw_name in ("savingpitcher", "savepitcher"):
            key = "save"
        else:
            continue

        athlete = item.get("athlete") or {}
        team = item.get("team") or {}
        if not isinstance(athlete, dict):
            athlete = {}
        if not isinstance(team, dict):
            team = {}

        name = athlete.get("displayName") or athlete.get("fullName") or athlete.get("shortName")
        if not name:
            continue

        out[key] = {
            "name": name,
            "record": athlete.get("record"),
            "team_id": team.get("id"),
            "team_name": team.get("name"),
        }

    return out or None


def _player_name_map_from_summary(summary_obj: Any) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not isinstance(summary_obj, dict):
        return out

    box = summary_obj.get("boxscore") or {}
    players = box.get("players") or []
    for team_group in players:
        if not isinstance(team_group, dict):
            continue
        for stat_group in team_group.get("statistics") or []:
            if not isinstance(stat_group, dict):
                continue
            for row in stat_group.get("athletes") or []:
                if not isinstance(row, dict):
                    continue
                athlete = row.get("athlete") or {}
                if not isinstance(athlete, dict):
                    continue
                pid = athlete.get("id")
                name = athlete.get("displayName") or athlete.get("fullName") or athlete.get("shortName")
                if pid and name:
                    out[str(pid)] = str(name)
    return out


def _inning_half_from_text(text: Any) -> Optional[str]:
    s = str(text or "").strip().lower()
    if s.startswith("top"):
        return "Top"
    if s.startswith("bottom"):
        return "Bottom"
    if s.startswith("middle"):
        return "Middle"
    if s.startswith("end"):
        return "End"
    return None


def _infer_pitcher_from_summary(summary_obj: Any, inning_half: Optional[str]) -> Optional[Dict[str, Any]]:
    if not isinstance(summary_obj, dict):
        return None

    header_comp = ((summary_obj.get("header") or {}).get("competitions") or [{}])[0]
    competitors = (header_comp or {}).get("competitors") or []
    if not competitors:
        return None

    home_team_id = None
    away_team_id = None
    for c in competitors:
        if not isinstance(c, dict):
            continue
        side = c.get("homeAway")
        tid = ((c.get("team") or {}).get("id"))
        if side == "home":
            home_team_id = str(tid) if tid is not None else None
        elif side == "away":
            away_team_id = str(tid) if tid is not None else None

    defense_team_id = None
    ih = str(inning_half or "").lower()
    if ih == "top":
        defense_team_id = home_team_id
    elif ih == "bottom":
        defense_team_id = away_team_id

    active_pitcher_by_team: Dict[str, Dict[str, Any]] = {}
    for team_group in ((summary_obj.get("boxscore") or {}).get("players") or []):
        if not isinstance(team_group, dict):
            continue
        team_id = (team_group.get("team") or {}).get("id")
        if team_id is None:
            continue
        team_id = str(team_id)

        for stat_group in team_group.get("statistics") or []:
            if not isinstance(stat_group, dict):
                continue
            if str(stat_group.get("type") or "").lower() != "pitching":
                continue

            for row in stat_group.get("athletes") or []:
                if not isinstance(row, dict):
                    continue
                if not bool(row.get("active")):
                    continue
                athlete = row.get("athlete") or {}
                if not isinstance(athlete, dict):
                    continue
                name = athlete.get("displayName") or athlete.get("fullName") or athlete.get("shortName")
                pid = athlete.get("id")
                if not name:
                    continue
                active_pitcher_by_team[team_id] = {
                    "id": pid,
                    "name": name,
                }
                break

    if defense_team_id and defense_team_id in active_pitcher_by_team:
        return active_pitcher_by_team[defense_team_id]

    # Fallback: if we only found one active pitcher, use it.
    if len(active_pitcher_by_team) == 1:
        return next(iter(active_pitcher_by_team.values()))
    return None


def _live_from_situation(sit: Any, player_name_by_id: Optional[Dict[str, str]] = None) -> Optional[Dict[str, Any]]:
    if not isinstance(sit, dict):
        return None

    player_name_by_id = player_name_by_id or {}

    due_up: List[Dict[str, Any]] = []
    for item in sit.get("dueUp") or []:
        parsed = _extract_probable_name_id(item)
        if parsed and not parsed.get("name") and parsed.get("id") is not None:
            parsed["name"] = player_name_by_id.get(str(parsed.get("id")))
        if parsed:
            due_up.append(parsed)

    batter = _extract_probable_name_id(sit.get("batter") or sit.get("atBat") or sit.get("atBatPlayer"))
    if batter and not batter.get("name") and batter.get("id") is not None:
        batter["name"] = player_name_by_id.get(str(batter.get("id")))
    # During inning breaks ESPN can omit batter and only provide dueUp.
    if not batter and due_up:
        batter = due_up[0]

    pitcher = _extract_probable_name_id(sit.get("pitcher") or sit.get("defendingPitcher"))
    if pitcher and not pitcher.get("name") and pitcher.get("id") is not None:
        pitcher["name"] = player_name_by_id.get(str(pitcher.get("id")))

    inning = _safe_int(sit.get("inning"))
    is_top = sit.get("isTopInning")
    half_raw = sit.get("halfInning")
    inning_half = None
    if isinstance(is_top, bool):
        inning_half = "Top" if is_top else "Bottom"
    elif isinstance(half_raw, str) and half_raw.strip():
        inning_half = half_raw.strip().title()

    inning_text = None
    if inning_half and inning:
        inning_text = f"{inning_half} {inning}"
    elif inning:
        inning_text = f"Inning {inning}"

    return {
        "inning": inning,
        "inning_half": inning_half,
        "inning_text": inning_text,
        "outs": _safe_int(sit.get("outs")),
        "balls": _safe_int(sit.get("balls")),
        "strikes": _safe_int(sit.get("strikes")),
        "on_first": bool(sit.get("onFirst")),
        "on_second": bool(sit.get("onSecond")),
        "on_third": bool(sit.get("onThird")),
        "batter": batter,
        "pitcher": pitcher,
        "due_up": due_up,
    }


def _has_live_essentials(live: Optional[Dict[str, Any]]) -> bool:
    if not live:
        return False
    return any(
        live.get(k) is not None
        for k in ("inning_text", "outs", "balls", "strikes", "batter", "pitcher")
    )


def _has_live_people(live: Optional[Dict[str, Any]]) -> bool:
    if not live:
        return False

    batter = live.get("batter") or {}
    if isinstance(batter, dict) and batter.get("name"):
        return True

    pitcher = live.get("pitcher") or {}
    if isinstance(pitcher, dict) and pitcher.get("name"):
        return True

    due_up = live.get("due_up") or []
    for p in due_up:
        if isinstance(p, dict) and p.get("name"):
            return True

    return False


def _has_due_up_names(live: Optional[Dict[str, Any]]) -> bool:
    if not live:
        return False
    for p in live.get("due_up") or []:
        if isinstance(p, dict) and p.get("name"):
            return True
    return False


def _find_probables_in_obj(obj: Any) -> Dict[str, Optional[Dict[str, Any]]]:
    """Recursively search a JSON-like object for probable/probables entries.

    Returns a dict with optional 'home' and 'away' entries like {"home": {id,name}, "away": ...}
    """
    out = {"home": None, "away": None}

    def _recurse(o: Any, side_ctx: Optional[str] = None) -> None:
        if o is None:
            return
        if isinstance(o, dict):
            next_side_ctx = side_ctx
            o_side = o.get("homeAway") or o.get("homeaway")
            if o_side in ("home", "away"):
                next_side_ctx = o_side

            for k, v in o.items():
                if not k:
                    continue
                key = str(k).lower()
                if key in ("probablepitcher", "probable", "probables", "probablepitchers", "projectedpitcher"):
                    # v can be a dict or list
                    if isinstance(v, dict):
                        side = (v.get("homeAway") or v.get("homeaway") or next_side_ctx)
                        athlete = v.get("athlete") or v.get("player") or v
                        parsed = _extract_probable_name_id(athlete, v.get("playerId"))
                        if side == "home" and not out["home"] and parsed:
                            out["home"] = parsed
                        if side == "away" and not out["away"] and parsed:
                            out["away"] = parsed

                    elif isinstance(v, list):
                        for item in v:
                            if not isinstance(item, dict):
                                continue
                            side = item.get("homeAway") or item.get("homeaway") or next_side_ctx
                            athlete = item.get("athlete") or item.get("player") or item
                            parsed = _extract_probable_name_id(athlete, item.get("playerId"))

                            if side == "home" and not out["home"] and parsed:
                                out["home"] = parsed
                            if side == "away" and not out["away"] and parsed:
                                out["away"] = parsed

                # continue searching deeper
                _recurse(v, next_side_ctx)
        elif isinstance(o, list):
            for i in o:
                _recurse(i, side_ctx)

    _recurse(obj)
    return out


def _fetch_summary_for_event(event_id: str, timeout: int = 12) -> Optional[Dict[str, Any]]:
    """Best-effort fetch of extra event details.

    Returns parsed summary data containing optional probable and live fields.
    """
    try:
        r = requests.get(SUMMARY_URL, params={"event": event_id}, timeout=timeout, headers=REQUEST_HEADERS)
        r.raise_for_status()
        j = r.json()
        player_name_by_id = _player_name_map_from_summary(j)
        found_probables = _find_probables_in_obj(j)
        found_live = _live_from_situation(j.get("situation"), player_name_by_id=player_name_by_id)
        header_comp = ((j.get("header") or {}).get("competitions") or [{}])[0]
        found_decisions = _extract_decisions_from_status((header_comp or {}).get("status") or {})

        # ESPN occasionally omits situation.pitcher mid-inning; infer from active pitching boxscore.
        if found_live is not None and not (found_live.get("pitcher") or {}).get("name"):
            status_detail = ((header_comp or {}).get("status") or {}).get("type", {}).get("detail")
            inning_half = found_live.get("inning_half") or _inning_half_from_text(status_detail)
            inferred_pitcher = _infer_pitcher_from_summary(j, inning_half)
            if inferred_pitcher:
                found_live["pitcher"] = inferred_pitcher

        if found_probables.get("home") or found_probables.get("away") or _has_live_essentials(found_live) or found_decisions:
            return {
                "probables": found_probables,
                "live": found_live,
                "decisions": found_decisions,
            }
    except Exception:
        return None
    return None

def get_mlb_games(date_yyyymmdd: str, timeout: int = 12, use_summary_fallback: bool = True) -> List[Dict[str, Any]]:
    """
    date_yyyymmdd: '20260113'
    Returns a list of games with teams + status + (final/live) scores when present.
    """
    r = requests.get(
        SCOREBOARD_URL,
        params={"dates": date_yyyymmdd},
        timeout=timeout,
        headers=REQUEST_HEADERS,
    )
    r.raise_for_status()
    data = r.json()

    out: List[Dict[str, Any]] = []
    # First pass: parse scoreboard JSON and collect events needing summary fallback
    need_summary: Dict[int, str] = {}
    for ev_idx, ev in enumerate(data.get("events", []) or []):
        event_id = ev.get("id")
        competitions = ev.get("competitions") or []
        if not competitions:
            continue
        comp = competitions[0]

        status = (comp.get("status") or {})
        st_type = (status.get("type") or {})
        state = st_type.get("state")  # "pre", "in", "post"
        detail = st_type.get("detail") or st_type.get("description") or ""
        channels = _channels_from_competition(comp)
        decisions = _extract_decisions_from_status(status)

        # Teams + scores
        home = away = None
        home_probable = None
        away_probable = None
        live = _live_from_situation(comp.get("situation")) if state == "in" else None
        competitors = comp.get("competitors", []) or []
        for c in competitors:
            side = c.get("homeAway")
            team = c.get("team") or {}
            item = {
                "id": team.get("id"),
                "abbr": team.get("abbreviation"),
                "name": team.get("displayName"),
                "logo": team.get("logo"),
                "score": None if state == "pre" else _safe_int(c.get("score")),
            }
            if side == "home":
                home = item
            elif side == "away":
                away = item

            # ESPN commonly stores SP info in competitor.probables[]
            if side in ("home", "away"):
                c_probables = c.get("probables") or []
                for p in c_probables:
                    if not isinstance(p, dict):
                        continue
                    athlete = p.get("athlete") or p.get("player") or p
                    parsed = _extract_probable_name_id(athlete, p.get("playerId"))
                    if side == "home" and not home_probable and parsed:
                        home_probable = parsed
                    if side == "away" and not away_probable and parsed:
                        away_probable = parsed

        # Probable / projected starting pitchers (ESPN sometimes exposes a comp-level 'probables' list)
        probables = comp.get("probables") or comp.get("probablePitchers") or []
        for p in (probables or []):
            try:
                p_side = p.get("homeAway")
                athlete = p.get("athlete") or p.get("player") or {}
                parsed = _extract_probable_name_id(athlete, p.get("playerId"))
            except Exception:
                p_side = None
                parsed = None

            if p_side == "home" and not home_probable:
                home_probable = parsed
            elif p_side == "away" and not away_probable:
                away_probable = parsed

        # Some ESPN variants place the probable pitcher on the competitor object itself
        for c in competitors:
            side = c.get("homeAway")
            pp = c.get("probablePitcher") or c.get("probable")
            if pp and isinstance(pp, dict):
                athlete = pp.get("athlete") or pp.get("player") or pp
                parsed = _extract_probable_name_id(athlete, pp.get("playerId"))

                if side == "home" and not home_probable:
                    home_probable = parsed
                if side == "away" and not away_probable:
                    away_probable = parsed

        # Defer summary lookups to a batched/parallel step to avoid serial network requests
        if state == "pre" and use_summary_fallback and (not home_probable or not away_probable) and event_id:
            need_summary[len(out)] = str(event_id)
        is_between_innings = any(x in str(detail or "").lower() for x in ("middle", "end"))
        missing_pitcher_name = not ((live or {}).get("pitcher") or {}).get("name")
        if state == "in" and event_id and (
            (not _has_live_essentials(live))
            or (not _has_live_people(live))
            or missing_pitcher_name
            or (is_between_innings and not _has_due_up_names(live))
        ):
            need_summary[len(out)] = str(event_id)
        if state == "post" and use_summary_fallback and event_id and not decisions:
            need_summary[len(out)] = str(event_id)

        # If still missing probables for a pregame, we'll fill TBA later after any fallback

        # Start time
        start_time = comp.get("date")  # ISO string

        out.append({
            "id": event_id,
            "url": mlb_game_url(str(event_id) if event_id is not None else None),
            "startTime": start_time,
            "state": state,          # pre / in / post
            "status": detail,        # "Final", "Scheduled", etc.
            "home": home,
            "away": away,
            "channels": channels,
            "live": live,
            "home_probable": home_probable,
            "away_probable": away_probable,
            "decisions": decisions,
        })

    # If we need to enrich some events with summary lookups, do that in parallel
    if use_summary_fallback and need_summary:
        try:
            from concurrent.futures import ThreadPoolExecutor, as_completed

            def _fetch_wrap(idx, eid):
                try:
                    return idx, _fetch_summary_for_event(eid, timeout=timeout)
                except Exception:
                    return idx, None

            max_workers = min(8, max(2, len(need_summary)))
            with ThreadPoolExecutor(max_workers=max_workers) as ex:
                futures = [ex.submit(_fetch_wrap, idx, eid) for idx, eid in need_summary.items()]
                for f in as_completed(futures):
                    try:
                        idx, fb = f.result()
                    except Exception:
                        continue
                    if not fb:
                        continue
                    # Only set values if they were missing originally
                    cur = out[idx]
                    fb_prob = fb.get("probables") or {}
                    if not cur.get("home_probable") and fb_prob.get("home"):
                        cur["home_probable"] = fb_prob.get("home")
                    if not cur.get("away_probable") and fb_prob.get("away"):
                        cur["away_probable"] = fb_prob.get("away")
                    if cur.get("state") == "post" and not cur.get("decisions") and fb.get("decisions"):
                        cur["decisions"] = fb.get("decisions")
                    if cur.get("state") == "in":
                        cur_live = cur.get("live") or {}
                        fb_live = fb.get("live") or {}
                        is_between_innings = any(
                            x in str(cur.get("status") or "").lower() for x in ("middle", "end")
                        )

                        if not cur_live:
                            cur["live"] = fb_live
                            continue

                        if not _has_live_essentials(cur_live):
                            cur["live"] = fb_live
                            continue

                        # Keep live inning/count/bases from scoreboard, but fill missing people fields.
                        merged_live = dict(cur_live)
                        changed = False

                        if (not (cur_live.get("batter") or {}).get("name")) and (fb_live.get("batter") or {}).get("name"):
                            merged_live["batter"] = fb_live.get("batter")
                            changed = True

                        if (not (cur_live.get("pitcher") or {}).get("name")) and (fb_live.get("pitcher") or {}).get("name"):
                            merged_live["pitcher"] = fb_live.get("pitcher")
                            changed = True

                        cur_due = cur_live.get("due_up") or []
                        fb_due = fb_live.get("due_up") or []
                        cur_due_has_names = any(isinstance(p, dict) and p.get("name") for p in cur_due)
                        fb_due_has_names = any(isinstance(p, dict) and p.get("name") for p in fb_due)
                        if ((not cur_due_has_names) and fb_due_has_names) or (is_between_innings and fb_due_has_names):
                            merged_live["due_up"] = fb_due
                            changed = True

                        if changed:
                            cur["live"] = merged_live
        except Exception:
            # Non-fatal: continue with whatever we have
            pass

    # Final pass: ensure pregame games always have some probable placeholder
    for cur in out:
        if cur.get("state") == "pre":
            if not cur.get("home_probable"):
                cur["home_probable"] = {"id": None, "name": "TBA"}
            if not cur.get("away_probable"):
                cur["away_probable"] = {"id": None, "name": "TBA"}

    return out
