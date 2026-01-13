from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Query
from fastapi.responses import RedirectResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from utils.dates import today_yyyymmdd_eastern, kp_date, is_future_yyyymmdd_eastern
from services.espn import urls_by_event_id
from services.build import build_games_for_date

app = FastAPI()

# static
STATIC_DIR = Path(__file__).with_name("static")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(STATIC_DIR / "favicon.ico")

@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/ui")

# UI file
UI_PATH = Path(__file__).with_name("ui.html")

@app.get("/ui", response_class=HTMLResponse)
def ui():
    return UI_PATH.read_text(encoding="utf-8")

# ---- UI contract endpoints ----

@app.get("/urls/espn")
def urls_espn(date_espn: str | None = Query(default=None)):
    date_espn = date_espn or today_yyyymmdd_eastern()
    m = urls_by_event_id(date_espn)
    # Keep extra fields if you want; UI ignores them.
    return {"date_espn": date_espn, "count": len(m), "urls_by_event_id": m}

@app.get("/games")
def games(date_espn: str | None = Query(default=None), date_kp: str | None = Query(default=None)):
    date_espn = date_espn or today_yyyymmdd_eastern()
    date_kp = date_kp or date_espn
    return build_games_for_date(date_espn, date_kp)

# Optional: mount debug routes only when DEBUG=1
import os
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
