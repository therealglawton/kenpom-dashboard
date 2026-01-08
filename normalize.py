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
        # 1/5 alias fixes (ESPN / KenPom name differences)
        "ar pine bluff": "arkansas pine bluff",
        "prairie view": "prairie view aandm",
        "prairie view aandm": "prairie view aandm",
        "se louisiana": "southeastern louisiana",
        "ut rio grande": "ut rio grande valley",
        "sf austin": "stephen f austin",
        "miss valley st": "mississippi valley state",
        "hou christian": "houston christian",
        "texas aandm cc": "texas aandm corpus christi",
        "texas aandm corpus chris": "texas aandm corpus christi",
        # 1/5 remaining mismatches
        "grambling": "grambling state",
        "nwestern state": "northwestern state",
        "eastern texas aandm": "east texas aandm",
        "pitt": "pittsburgh",
        "ualbany": "albany",
        "ga southern": "georgia southern",
        "sc state": "south carolina state",
        "nc central": "north carolina central",
        "md eastern": "maryland eastern shore",
        "sc upstate": "usc upstate",



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
    post = {
        "fdu": "fairleigh dickinson",
        "fgcu": "florida gulf coast",
        "app state": "appalachian state",
        "coastal": "coastal carolina",
        "nc aandt": "north carolina aandt",
        "long island": "liu",
        "ut martin": "tennessee martin",
        "sam houston": "sam houston state",
        "s dakota state": "south dakota state",
        "northern dakota state": "north dakota state",
        "omaha": "nebraska omaha",
        "ul monroe": "louisiana monroe",
        "mtsu": "middle tennessee",

        "santa barbara": "uc santa barbara",
        "abilene chrstn": "abilene christian",
        "se missouri": "southeast missouri",          # <-- FIXED (one-hop)
        "so indiana": "southern indiana",
        "bakersfield": "cal st bakersfield",
        "csu northridge": "csun",
        "ca baptist": "cal baptist",
        "fullerton": "cal st fullerton",
        "southeast missouri state": "southeast missouri",
        "western ky": "western kentucky",
        "seattle university": "seattle",
        "lmu": "loyola marymount",
        # 1/5 KenPom variants (post-normalization)
        "arkansas pine bluff": "arkansas pine bluff",
        "southeastern louisiana": "southeastern louisiana",
        "ut rio grande valley": "ut rio grande valley",
        "stephen f austin": "stephen f austin",
        "mississippi valley state": "mississippi valley state",
        "houston christian": "houston christian",
        "texas aandm corpus christi": "texas aandm corpus christi",
        # 1/5 remaining mismatches (ESPN abbreviations after rules run)
        "nwestern state": "northwestern state",
        "eastern texas aandm": "east texas aandm",
        "bethune": "bethune cookman",



    }
    return post.get(s, s)


def matchup_key(away: str | None, home: str | None) -> str:
    return f"{normalize_team(away)} @ {normalize_team(home)}"
