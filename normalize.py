# normalize.py
# ---------- Team normalization ----------
import re
import unicodedata


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

    # --- exact mappings (highest priority; pre-normalization aliases) ---
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

    # --- post-normalization aliases (runs AFTER punctuation/prefix rules) ---
    # These fix ESPN/KenPom naming mismatches found via /debug/match.
    post = {
        "fdu": "fairleigh dickinson",
        "fgcu": "florida gulf coast",
        "app state": "appalachian state",
        "coastal": "coastal carolina",
        "nc aandt": "north carolina aandt",
        "long island": "liu",
    }
    return post.get(s, s)


def matchup_key(away: str | None, home: str | None) -> str:
    return f"{normalize_team(away)} @ {normalize_team(home)}"
