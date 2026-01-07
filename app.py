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

app = FastAPI()


@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/ui")


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


# ---------- Team normalization ----------

def normalize_team(name: str | None) -> str:
    if not name:
        return ""

    s = name.strip().lower()

    # remove accents (san josé -> san jose)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))

    # normalize punctuation/symbols
    s = s.replace("&", "and")
    s = s.replace("-", " ")          # Gardner-Webb -> Gardner Webb
    s = re.sub(r"[.'’]", "", s)      # remove dots/apostrophes

    # collapse whitespace early
    s = re.sub(r"\s+", " ", s).strip()

    # --- exact mappings (highest priority) ---
    exact = {
        "uconn": "connecticut",
        "fau": "florida atlantic",
        "fiu": "florida international",
        "etsu": "east tennessee state",
        "vmi": "vmi",
        "uab": "uab",

        "jax state": "jacksonville state",
        "purdue fw": "purdue fort wayne",
        "charleston so": "charleston southern",
        "s illinois": "southern illinois",

        # directional short forms
        "w michigan": "western michigan",
        "e michigan": "eastern michigan",
        "c michigan": "central michigan",
        "g washington": "george washington",
        "n illinois": "northern illinois",

        # explicit State schools
        "san jose st": "san jose state",
        "youngstown st": "youngstown state",

        # nicknames / common names
        "ole miss": "mississippi",

        # St Thomas variants
        "st thomas (mn)": "st thomas",
        "st thomas mn": "st thomas",

        # ESPN quirks
        "uic": "illinois chicago",
        "boston u": "boston university",
        "miami": "miami fl",
    }
    if s in exact:
        return exact[s]

    # expand common abbreviations at the START of the name
    start_replacements = {
        "w ": "western ",
        "e ": "eastern ",
        "c ": "central ",
        "g ": "george ",
        "n ": "northern ",
        "umass": "massachusetts",
    }
    for prefix, full in start_replacements.items():
        if s.startswith(prefix):
            s = full + s[len(prefix):]
            break

    # convert trailing "... st" -> "... state"
    # safe: does NOT affect "st johns", "st marys", etc.
    if s.endswith(" st"):
        s = re.sub(r"\bst$", "state", s)

    # convert trailing "... u" -> "... university"
    s = re.sub(r"\bu\b$", "university", s)

    # final whitespace cleanup
    s = re.sub(r"\s+", " ", s).strip()
    return s


def matchup_key(away: str | None, home: str | None) -> str:
    return f"{normalize_team(away)} @ {normalize_team(home)}"



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
    """
    Returns merged games for the UI.
    Lenient: does NOT 500 if some games don't match.
    Accepts:
      - date_espn: YYYYMMDD (defaults to today Eastern)
      - date_kp:   YYYYMMDD or YYYY-MM-DD (defaults to today Eastern)
    """
    date_espn = date_espn or today_yyyymmdd_eastern()
    date_kp = date_kp or date_espn  # allow UI to pass only one style; we normalize later

    try:
        result = debug_merge(date_espn=date_espn, date_kp=date_kp)
        return result
    except HTTPException as e:
        # If it’s the strict merge missing error, return partial info instead of crashing the UI
        detail = e.detail if isinstance(e.detail, dict) else {"error": str(e.detail)}

        # If this isn’t our merge-missing case, re-raise it (still loud)
        if detail.get("error") != "Merge missing KenPom for some ESPN games":
            raise

        # Return a "soft" response: UI can still show a message
        return {
            "date_espn": date_espn,
            "date_kp": kp_date(date_kp),
            "count": 0,
            "games": [],
            "missing_count": detail.get("missing_count", 0),
            "missing_sample": detail.get("missing_sample", []),
            "warning": "Some ESPN games did not match KenPom FanMatch for this date.",
        }


@app.get("/ui", response_class=HTMLResponse)
def ui():
    return """
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>College Basketball Dashboard</title>
  <style>
    :root{
      --bg: #ffffff;
      --text: #111827;
      --muted: #6b7280;
      --border: #e5e7eb;
      --row: #fafafa;
      --rowHover: #f1f5f9;
      --shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
    }

    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      margin: 0;
      background: var(--bg);
      color: var(--text);
    }

    /* Layout */
    .container{
      max-width: 1100px;
      margin: 0 auto;
      padding: 22px 18px 28px;
    }

    h1 {
      margin: 0 0 6px 0;
      font-size: 34px;
      letter-spacing: -0.02em;
    }

    .muted {
      color: var(--muted);
      font-size: 13px;
    }

    .row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 14px;
    }

    /* Controls */
    .controls {
      margin-top: 14px;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: var(--shadow);
      background: white;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }

    .controls .group {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .controls label {
      font-size: 12px;
      color: #4b5563;
      text-transform: uppercase;
      letter-spacing: .06em;
    }

    input[type="text"], select {
      padding: 9px 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      font-size: 14px;
      background: #fff;
      color: var(--text);
      outline: none;
    }
    input[type="text"] { min-width: 240px; }
    select { min-width: 180px; }

    .pill {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: #fff;
      font-size: 13px;
      color: #374151;
      user-select: none;
    }
    .pill input { transform: translateY(1px); }

    .spacer { flex: 1; }

    /* Button */
    button {
      padding: 9px 12px;
      font-size: 14px;
      cursor: pointer;
      border: 1px solid var(--border);
      background: #111827;
      color: white;
      border-radius: 10px;
      box-shadow: 0 1px 2px rgba(0,0,0,.06);
    }
    button:hover { filter: brightness(1.05); }
    button:active { transform: translateY(1px); }

    .secondary {
      background: #fff;
      color: #111827;
    }

    .error {
      color: #b00020;
      white-space: pre-wrap;
      margin-top: 12px;
      padding: 10px 12px;
      border: 1px solid #fecaca;
      background: #fff1f2;
      border-radius: 10px;
      display: none;
    }

    /* Table wrapper */
    .table-wrap {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      border: 1px solid var(--border);
      border-radius: 14px;
      margin-top: 14px;
      box-shadow: var(--shadow);
      max-height: 70vh;
      overflow: auto;
      background: white;
    }

    table {
      border-collapse: separate;
      border-spacing: 0;
      width: 100%;
      min-width: 900px; /* keeps columns readable */
    }

    th, td {
      border-bottom: 1px solid var(--border);
      padding: 10px 12px;
      text-align: left;
      font-size: 14px;
      vertical-align: middle;
    }

    thead th {
      position: sticky;
      top: 0;
      background: white;
      z-index: 2;
      font-size: 12px;
      color: #4b5563;
      text-transform: uppercase;
      letter-spacing: .06em;
      box-shadow: 0 1px 0 var(--border);
    }

    tbody tr:nth-child(even) { background: var(--row); }
    tbody tr:hover { background: var(--rowHover); }

    .nowrap { white-space: nowrap; }

    /* Column styling */
    td.matchup {
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    td.network {
      color: var(--muted);
      font-size: 13px;
    }

    td.kp {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    td.thrill {
      text-align: right;
      font-variant-numeric: tabular-nums;
      width: 90px;
    }

    /* Visual divider before KP columns */
    th.kp, td.kp {
      border-left: 1px solid var(--border);
    }

    /* Thrill cue */
    td.thrill.low { color: #6b7280; }
    td.thrill.mid { color: #2563eb; }
    td.thrill.high { color: #dc2626; }

    /* Small mobile tweaks */
    @media (max-width: 640px) {
      h1 { font-size: 22px; }
      .container { padding: 14px 12px 18px; }
      th, td { padding: 10px 10px; font-size: 13px; }
      button { width: 100%; justify-content: center; }
      input[type="text"], select { width: 100%; min-width: 0; }
      .controls { gap: 8px; }
      .controls .group { width: 100%; }
      .spacer { display: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>College Basketball Dashboard</h1>
    <div class="muted">ESPN start time & network + KenPom FanMatch predictions</div>

    <div class="row">
      <div class="muted">
        Showing games for <strong><span id="dateLabel"></span></strong>
      </div>
      <button id="reloadBtn">Reload</button>
    </div>

    <!-- Quick filters (no date picker) -->
    <div class="controls" aria-label="Quick filters">
      <div class="group">
        <label for="q">Search</label>
        <input id="q" type="text" placeholder="Team, matchup, network…" />
      </div>

      <div class="group">
        <label for="minThrill">Min thrill</label>
        <select id="minThrill">
          <option value="0">Any</option>
          <option value="40">40+</option>
          <option value="60">60+</option>
          <option value="70">70+</option>
        </select>
      </div>

      <div class="group">
        <label for="networkFilter">Network</label>
        <select id="networkFilter">
          <option value="">All networks</option>
        </select>
      </div>

      <div class="spacer"></div>

      <span class="pill" title="Hide ESPN+ games">
        <input id="hideEspnPlus" type="checkbox" />
        <span>Hide ESPN+</span>
      </span>

      <span class="pill" title="Show only games with KenPom data available">
        <input id="kpOnly" type="checkbox" checked />
        <span>KenPom only</span>
      </span>

      <button id="clearFilters" class="secondary">Clear</button>
    </div>

    <div id="countLine" class="muted" style="margin-top:10px;"></div>

    <div id="error" class="error"></div>

    <div class="table-wrap">
      <table id="tbl" style="display:none;">
        <thead>
          <tr>
            <th data-sort="time">Start (Local)</th>
            <th>Matchup</th>
            <th>Network</th>
            <th class="kp" data-sort="kp">KenPom</th>
            <th data-sort="thrill">Thrill</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>

<script>
  const $ = (id) => document.getElementById(id);

  let currentGames = [];
  let sortKey = "time";   // DEFAULT: time first
  let sortDir = "asc";

  // Filter state
  let qText = "";
  let minThrill = 0;
  let networkChoice = "";
  let hideEspnPlus = false;
  let kpOnly = true;

  function todayParts() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return { yyyy, mm, dd };
  }

  function formatLocalTime(utcIso) {
    if (!utcIso) return "";
    const d = new Date(utcIso);
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(d);
  }

  // Winner WP = max(homeWP, awayWP)
  function winnerWP(g) {
    if (g.kp_home_wp == null) return null;
    const home = Number(g.kp_home_wp);
    if (!Number.isFinite(home)) return null;
    const away = 100 - home;
    return Math.max(home, away);
  }

  function fmtPred(g) {
    if (
      g.kp_home_pred == null ||
      g.kp_away_pred == null ||
      g.kp_home_wp == null
    ) {
      return "";
    }

    const homeWP = Number(g.kp_home_wp);
    const awayWP = 100 - homeWP;

    if (homeWP >= 50) {
      return `${g.home} ${g.kp_home_pred}-${g.kp_away_pred} (${homeWP}%)`;
    }

    return `${g.away} ${g.kp_away_pred}-${g.kp_home_pred} (${awayWP}%)`;
  }

  function getSortValue(g, key) {
    if (key === "time") {
      if (!g.start_utc) return null;
      const t = Date.parse(g.start_utc);
      return Number.isFinite(t) ? t : null;
    }
    if (key === "kp") {
      return winnerWP(g);
    }
    if (key === "thrill") {
      const n = Number(g.kp_thrill);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function sortGames(games) {
    // SPECIAL CASE: time buckets with thrill as tiebreaker
    if (sortKey === "time") {
      return [...games].sort((a, b) => {
        const at = getSortValue(a, "time");
        const bt = getSortValue(b, "time");

        // null times last
        if (at == null && bt == null) return 0;
        if (at == null) return 1;
        if (bt == null) return -1;

        // primary: time asc
        if (at !== bt) return at - bt;

        // secondary: thrill desc
        const av = getSortValue(a, "thrill");
        const bv = getSortValue(b, "thrill");

        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;

        return bv - av;
      });
    }

    // NORMAL SORT for kp / thrill
    const dir = sortDir === "asc" ? 1 : -1;

    return [...games].sort((a, b) => {
      const av = getSortValue(a, sortKey);
      const bv = getSortValue(b, sortKey);

      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;

      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  function setHeaderLabels() {
    const thTime = document.querySelector('th[data-sort="time"]');
    const thKp = document.querySelector('th[data-sort="kp"]');
    const thThrill = document.querySelector('th[data-sort="thrill"]');

    thTime.textContent = "Start (Local)";
    thKp.textContent = "KenPom";
    thThrill.textContent = "Thrill";

    const arrow = sortDir === "asc" ? " ▲" : " ▼";
    if (sortKey === "time") thTime.textContent += arrow;
    if (sortKey === "kp") thKp.textContent += arrow;
    if (sortKey === "thrill") thThrill.textContent += arrow;
  }

  function renderTable(games) {
    $("tbody").innerHTML = "";

    for (const g of games) {
      const tr = document.createElement("tr");

      const start = document.createElement("td");
      start.className = "nowrap";
      start.textContent = formatLocalTime(g.start_utc);
      tr.appendChild(start);

      const matchup = document.createElement("td");
      matchup.className = "matchup";
      matchup.textContent = `${g.away} @ ${g.home}`;
      tr.appendChild(matchup);

      const network = document.createElement("td");
      network.className = "network";
      network.textContent = g.network || "";
      tr.appendChild(network);

      const kp = document.createElement("td");
      kp.className = "kp";
      kp.textContent = fmtPred(g);
      tr.appendChild(kp);

      const thrill = document.createElement("td");
      const t = Number(g.kp_thrill);
      let cls = "thrill";
      if (Number.isFinite(t)) {
        if (t >= 65) cls += " high";
        else if (t >= 40) cls += " mid";
        else cls += " low";
        thrill.textContent = t.toFixed(1);
      } else {
        thrill.textContent = "";
        cls += " low";
      }
      thrill.className = cls;
      tr.appendChild(thrill);

      $("tbody").appendChild(tr);
    }

    $("tbl").style.display = "table";
  }

  function buildNetworkOptions() {
    const sel = $("networkFilter");
    const current = sel.value;

    // collect networks from currentGames
    const set = new Set();
    for (const g of currentGames) {
      const n = (g.network || "").trim();
      if (n) set.add(n);
    }
    const networks = Array.from(set).sort((a,b) => a.localeCompare(b));

    // rebuild options (keep first "All networks")
    sel.innerHTML = '<option value="">All networks</option>';
    for (const n of networks) {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      sel.appendChild(opt);
    }

    // restore selection if still present
    if (current) sel.value = current;
  }

  function applyFilters(games) {
    const q = qText.trim().toLowerCase();
    const minT = Number(minThrill) || 0;

    return games.filter((g) => {
      // KenPom-only toggle: require kp data (thrill is a good proxy here)
      if (kpOnly) {
        const t = Number(g.kp_thrill);
        if (!Number.isFinite(t)) return false;
      }

      // Hide ESPN+
      if (hideEspnPlus && (g.network || "").toUpperCase().includes("ESPN+")) return false;

      // Network dropdown
      if (networkChoice && (g.network || "") !== networkChoice) return false;

      // Min thrill
      if (minT > 0) {
        const t = Number(g.kp_thrill);
        if (!Number.isFinite(t) || t < minT) return false;
      }

      // Search
      if (q) {
        const hay = `${g.away || ""} ${g.home || ""} ${(g.network || "")} ${fmtPred(g)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  }

  function updateCountLine(shown, total) {
    $("countLine").textContent = `Showing ${shown} of ${total} games`;
  }

  function applySortAndRender() {
    setHeaderLabels();
    const filtered = applyFilters(currentGames);
    updateCountLine(filtered.length, currentGames.length);
    renderTable(sortGames(filtered));
  }

  function wireSorting() {
    const headers = document.querySelectorAll("th[data-sort]");
    headers.forEach((th) => {
      th.style.cursor = "pointer";
      th.title = "Click to sort";

      th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort");

        if (sortKey === key) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortKey = key;
          sortDir = key === "time" ? "asc" : "desc";
        }

        applySortAndRender();
      });
    });
  }

  function wireFilters() {
    $("q").addEventListener("input", (e) => {
      qText = e.target.value || "";
      applySortAndRender();
    });

    $("minThrill").addEventListener("change", (e) => {
      minThrill = Number(e.target.value) || 0;
      applySortAndRender();
    });

    $("networkFilter").addEventListener("change", (e) => {
      networkChoice = e.target.value || "";
      applySortAndRender();
    });

    $("hideEspnPlus").addEventListener("change", (e) => {
      hideEspnPlus = !!e.target.checked;
      applySortAndRender();
    });

    $("kpOnly").addEventListener("change", (e) => {
      kpOnly = !!e.target.checked;
      applySortAndRender();
    });

    $("clearFilters").addEventListener("click", () => {
      qText = "";
      minThrill = 0;
      networkChoice = "";
      hideEspnPlus = false;
      kpOnly = true;

      $("q").value = "";
      $("minThrill").value = "0";
      $("networkFilter").value = "";
      $("hideEspnPlus").checked = false;
      $("kpOnly").checked = true;

      applySortAndRender();
    });

    $("reloadBtn").addEventListener("click", loadGames);
  }

  async function loadGames() {
    $("error").style.display = "none";
    $("error").textContent = "";
    $("tbl").style.display = "none";
    $("tbody").innerHTML = "";
    $("countLine").textContent = "";

    const { yyyy, mm, dd } = todayParts();
    const date_kp = `${yyyy}-${mm}-${dd}`;
    const date_espn = `${yyyy}${mm}${dd}`;

    $("dateLabel").textContent = date_kp;

    const url = `/games?date_espn=${date_espn}&date_kp=${date_kp}`;

    let resp, data;
    try {
      resp = await fetch(url);
      data = await resp.json();
    } catch (e) {
      $("error").style.display = "block";
      $("error").textContent = `Failed to load games\\n${e}`;
      return;
    }

    if (!resp.ok) {
      $("error").style.display = "block";
      $("error").textContent = JSON.stringify(data, null, 2);
      return;
    }

    currentGames = data.games || [];
    buildNetworkOptions();
    applySortAndRender();
  }

  wireSorting();
  wireFilters();
  loadGames();
</script>

</body>
</html>
"""
