from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Query
from fastapi.responses import RedirectResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import os

from utils.dates import today_yyyymmdd_eastern
from services.espn import urls_by_event_id
from services.build import build_games_for_date
from services.pga_espn import get_pga_leaderboard

app = FastAPI()

# Version management (read once at startup)
VERSION_PATH = Path(__file__).with_name("version.txt")
APP_VERSION = VERSION_PATH.read_text(encoding="utf-8").strip() if VERSION_PATH.exists() else "unknown"

# static
STATIC_DIR = Path(__file__).with_name("static")
class StaticFilesWithCache(StaticFiles):
    def file_response(self, full_path, stat_result, req_headers=None):
        response = super().file_response(full_path, stat_result, req_headers)
        # Cache static files for 1 day, but allow validation with ETag
        response.headers["Cache-Control"] = "public, max-age=86400, must-revalidate"
        return response

app.mount("/static", StaticFilesWithCache(directory=str(STATIC_DIR)), name="static")

@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(STATIC_DIR / "favicon.ico")

@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/ui")

# UI file
UI_PATH = Path(__file__).with_name("ui.html")
UI_PGA_DEV_PATH = Path(__file__).with_name("ui_pga_dev.html")

@app.get("/ui", response_class=HTMLResponse)
def ui():
    html_content = UI_PATH.read_text(encoding="utf-8")
    # Inject version into asset URLs and meta tag for cache busting
    # Use regex to handle existing version numbers in script tags
    import re
    
    # Replace CSS href
    html_content = re.sub(
        r'href="/static/css/ui\.css(\?v=[^"]*)?',
        f'href="/static/css/ui.css?v={APP_VERSION}',
        html_content
    )
    
    # Replace JS src (handles existing ?v=XX)
    html_content = re.sub(
        r'src="/static/js/ui\.js(\?v=[^"]*)?',
        f'src="/static/js/ui.js?v={APP_VERSION}',
        html_content
    )

    # Replace PGA asset URLs as well so mobile clients don't keep stale leaderboard code
    html_content = re.sub(
        r'href="/static/css/pga_dev\.css(\?v=[^"]*)?',
        f'href="/static/css/pga_dev.css?v={APP_VERSION}',
        html_content,
    )
    html_content = re.sub(
        r'src="/static/js/pga_dev\.js(\?v=[^"]*)?',
        f'src="/static/js/pga_dev.js?v={APP_VERSION}',
        html_content,
    )
    
    # Replace meta tag version attribute
    html_content = html_content.replace(
        'content=""',
        f'content="{APP_VERSION}"'
    )
    
    return HTMLResponse(
        content=html_content,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@app.get("/ui/pga-dev", response_class=HTMLResponse)
def ui_pga_dev():
    html_content = UI_PGA_DEV_PATH.read_text(encoding="utf-8")
    import re

    html_content = re.sub(
        r'href="/static/css/pga_dev\.css(\?v=[^"]*)?',
        f'href="/static/css/pga_dev.css?v={APP_VERSION}',
        html_content,
    )
    html_content = re.sub(
        r'src="/static/js/pga_dev\.js(\?v=[^"]*)?',
        f'src="/static/js/pga_dev.js?v={APP_VERSION}',
        html_content,
    )
    html_content = html_content.replace('content=""', f'content="{APP_VERSION}"')

    return HTMLResponse(
        content=html_content,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )

# Version endpoint (lightweight, for cache invalidation)
@app.get("/api/version")
def get_version():
    return {
        "version": APP_VERSION
    }

# ---- UI contract endpoints ----

@app.get("/urls/espn")
def urls_espn(date_espn: str | None = Query(default=None), sport: str | None = Query(default="cbb")):
    date_espn = date_espn or today_yyyymmdd_eastern()
    sport = (sport or "cbb").lower()
    m = urls_by_event_id(date_espn, sport)
    # Keep extra fields if you want; UI ignores them.
    return {"date_espn": date_espn, "sport": sport, "count": len(m), "urls_by_event_id": m}

@app.get("/games")
def games(
    date_espn: str | None = Query(default=None),
    date_kp: str | None = Query(default=None),
    sport: str | None = Query(default="cbb"),
):
    date_espn = date_espn or today_yyyymmdd_eastern()
    date_kp = date_kp or date_espn
    return build_games_for_date(date_espn, date_kp, sport.lower() if sport else "cbb")

# Optional: mount debug routes only when DEBUG=1
if os.getenv("DEBUG", "0") == "1":
    from routers.debug import router as debug_router
    app.include_router(debug_router)

from services.mlb_espn import get_mlb_games

@app.get("/mlb/games")
def mlb_games(date: str):
    return {
        "date": date,
        "games": get_mlb_games(date)
    }


@app.get("/pga/leaderboard")
def pga_leaderboard(date: str | None = Query(default=None), limit: int = Query(default=0, ge=0, le=500)):
    # limit=0 means no limit (display full field)
    return get_pga_leaderboard(date_yyyymmdd=date, limit=limit)
