# routers/debug.py
import os
from fastapi import APIRouter, HTTPException
from services.espn import fetch_scoreboard, parse_games
from services.kenpom import fetch_fanmatch

router = APIRouter()

def require_debug():
    if os.getenv("DEBUG", "0") != "1":
        raise HTTPException(status_code=404, detail="Not found")

@router.get("/health")
def health():
    return {"status": "ok"}

@router.get("/debug/env")
def debug_env():
    require_debug()
    key = os.getenv("KENPOM_API_KEY")
    if not key:
        raise HTTPException(status_code=500, detail="KENPOM_API_KEY is missing.")
    return {"kenpom_key_loaded": True, "key_length": len(key)}

@router.get("/debug/espn")
def debug_espn(date: str):
    require_debug()
    games = parse_games(fetch_scoreboard(date))
    return {"count": len(games), "games": games[:25]}

@router.get("/debug/kenpom")
def debug_kenpom(date: str):
    require_debug()
    data = fetch_fanmatch(date)
    return {"count": len(data), "games": data[:25]}
