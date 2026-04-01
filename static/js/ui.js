// =====================================================
// College Basketball Dashboard UI (drop-in replacement)
// Adds: Hi/Mid + per-conference filter that only shows conferences with games that day
// Adds (this change): Future-day tiles render compact (no KP/thrill/score content)
// Adds (this change): Top tabs for CBB / MLB + MLB fetch + MLB card render
// =====================================================

// ---------------------
// DOM helper
// ---------------------
const $ = (id) => document.getElementById(id);
const mlbLogoTemplateCache = new Map();

// ---------------------
// App state (single source of truth)
// ---------------------
const STORAGE_KEY_SPORT = "sportsSlate_sport";
const STORAGE_KEY_DATE = "sportsSlate_date";

const state = {
  sport: "mlb",         // "cbb" | "mlb" | "nfl" | "cfb"
  games: [],            // CBB/CFB/NFL games
  mlbGames: [],         // MLB games
  urlsByEventId: {},

  sort: { key: "time", dir: "asc" }, // default: time asc (thrill tiebreaker desc)

  filters: {
    minThrill: 0,
    // Conference filter:
    // "" = all
    // "hi" = high major
    // "mid" = mid major
    // "conf:<id>" = specific conference id
    confChoice: "",
  },

  timers: {
    livePollTimer: null,
    idlePollTimer: null,
    pollInFlight: false,
    updatedTimer: null,
    lastUpdatedMs: null,
  },
};

// =====================================================
// Tabs (CBB / MLB)
// =====================================================
function persistSport(sport) {
  try {
    localStorage.setItem(STORAGE_KEY_SPORT, sport);
  } catch {
    // ignore if not available
  }
}

function persistDate(yyyymmdd) {
  try {
    localStorage.setItem(STORAGE_KEY_DATE, yyyymmdd);
  } catch {
    // ignore if not available
  }
}

function getPersistedSport() {
  try {
    return localStorage.getItem(STORAGE_KEY_SPORT) || null;
  } catch {
    return null;
  }
}

function getPersistedDate() {
  try {
    return localStorage.getItem(STORAGE_KEY_DATE) || null;
  } catch {
    return null;
  }
}

function setSport(sport) {
  state.sport = sport;
  persistSport(sport);
  document.documentElement.classList.toggle("mlb", sport === "mlb");
  document.documentElement.classList.toggle("nfl", sport === "nfl");
  document.documentElement.classList.toggle("cfb", sport === "cfb");

  const tabCbb = $("tabCbb");
  const tabMlb = $("tabMlb");
  const tabNfl = $("tabNfl");
  const tabCfb = $("tabCfb");
  const isCbb = sport === "cbb";

  if (tabCbb) {
    tabCbb.classList.toggle("active", sport === "cbb");
    tabCbb.setAttribute("aria-selected", String(sport === "cbb"));
  }
  if (tabMlb) {
    tabMlb.classList.toggle("active", sport === "mlb");
    tabMlb.setAttribute("aria-selected", String(sport === "mlb"));
  }
  if (tabNfl) {
    tabNfl.classList.toggle("active", sport === "nfl");
    tabNfl.setAttribute("aria-selected", String(sport === "nfl"));
  }
  if (tabCfb) {
    tabCfb.classList.toggle("active", sport === "cfb");
    tabCfb.setAttribute("aria-selected", String(sport === "cfb"));
  }

  // Control availability by sport
  const minThrillEl = $("minThrill");
  if (minThrillEl) minThrillEl.disabled = !isCbb;

  const confFilterEl = $("confFilter");
  if (confFilterEl) confFilterEl.disabled = !(sport === "cbb" || sport === "cfb");

  const clearFiltersEl = $("clearFilters");
  if (clearFiltersEl) clearFiltersEl.disabled = !(sport === "cbb" || sport === "cfb");

  // Stop active polling while switching sports; loadGames will set mode.
  setPollingMode("off");

  loadGames(null, false);
}

function wireTabs() {
  $("tabMlb")?.addEventListener("click", () => setSport("mlb"));
  $("tabNfl")?.addEventListener("click", () => setSport("nfl"));
  $("tabCfb")?.addEventListener("click", () => setSport("cfb"));
  $("tabCbb")?.addEventListener("click", () => setSport("cbb"));
}

// =====================================================
// Conference tiers (Hi-major / Mid-major)
// =====================================================
// IMPORTANT: backend returns g.away_conf / g.home_conf as objects: {id, name, short}

const HI_MAJOR_SHORTS = new Set(["ACC", "Big 12", "Big East", "Big Ten", "SEC"]);
const CFB_POWER4_CONF_IDS = new Set(["1", "4", "5", "8"]); // ACC, Big 12, Big Ten, SEC
const CFB_CONF_FILTER_ID = {
  acc: "1",
  big12: "4",
  bigten: "5",
  sec: "8",
};

function confShort(g, side) {
  const c = side === "home" ? g.home_conf : g.away_conf;
  return (c && typeof c === "object" ? (c.short || c.name || "") : "") || "";
}

function confId(g, side) {
  const c = side === "home" ? g.home_conf : g.away_conf;
  return (c && typeof c === "object" ? (c.id || "") : "") || "";
}

function isHighMajorConf(confObj) {
  if (!confObj || typeof confObj !== "object") return false;
  const s = (confObj.short || confObj.name || "").trim();
  if (!s) return false;
  return HI_MAJOR_SHORTS.has(s);
}

function gameIsHighMajor(g) {
  return isHighMajorConf(g.home_conf) || isHighMajorConf(g.away_conf);
}

function gameIsMidMajor(g) {
  // Treat unknowns as mid (keeps them visible instead of disappearing)
  const hasAny = !!(confShort(g, "home") || confShort(g, "away") || confId(g, "home") || confId(g, "away"));
  if (!hasAny) return true;
  return !gameIsHighMajor(g);
}

function gameInConferenceId(g, confIdWanted) {
  const hid = confId(g, "home");
  const aid = confId(g, "away");
  return (hid && hid === confIdWanted) || (aid && aid === confIdWanted);
}

function gameIsCfbPower4OrNotreDame(g) {
  const homeConfId = confId(g, "home");
  const awayConfId = confId(g, "away");
  if (CFB_POWER4_CONF_IDS.has(homeConfId) || CFB_POWER4_CONF_IDS.has(awayConfId)) {
    return true;
  }

  const homeName = String(g.home || "").toLowerCase();
  const awayName = String(g.away || "").toLowerCase();
  return homeName.includes("notre dame") || awayName.includes("notre dame");
}

function gameIsCfbConference(g, confIdWanted) {
  const homeConfId = confId(g, "home");
  const awayConfId = confId(g, "away");
  return homeConfId === confIdWanted || awayConfId === confIdWanted;
}

// =====================================================
// UI helpers (error/table)
// =====================================================
function clearError() {
  const el = $("error");
  if (!el) return;
  el.style.display = "none";
  el.textContent = "";
}

function showError(text) {
  const el = $("error");
  if (!el) return;
  el.style.display = "block";
  el.textContent = String(text ?? "");
}

function clearTableForFullLoad() {
  const tbl = $("tbl");
  const tbody = $("tbody");
  const board = $("cardBoard");
  const count = $("countLine");
  if (tbl) tbl.style.display = "none";
  if (tbody) tbody.innerHTML = "";
  if (board) {
    board.innerHTML = "";
    board.style.display = "none";
  }
  if (count) count.textContent = "";
}

// =====================================================
// Polling: live (3s) + idle (60s), silent refresh
// =====================================================
function setPollingMode(mode) {
  // mode: "live" | "idle" | "off"

  // clear everything first
  if (state.timers.livePollTimer) {
    clearInterval(state.timers.livePollTimer);
    state.timers.livePollTimer = null;
  }
  if (state.timers.idlePollTimer) {
    clearInterval(state.timers.idlePollTimer);
    state.timers.idlePollTimer = null;
  }

  const poll = (ms) => {
    return setInterval(async () => {
      if (state.timers.pollInFlight) return;
      state.timers.pollInFlight = true;
      // Heartbeat for auto-refresh visibility even when a poll request fails.
      setLastUpdatedNow();
      const cur = yyyymmddFromDateInput($("datePicker")?.value || "");
      try {
        await loadGames(cur, true); // silent refresh
      } finally {
        state.timers.pollInFlight = false;
      }
    }, ms);
  };

  if (mode === "live") {
    state.timers.livePollTimer = poll(3000);
    return;
  }

  if (mode === "idle") {
    state.timers.idlePollTimer = poll(60000);
    return;
  }

  // "off" → nothing running
}

// =====================================================
// Updated-ago ticker
// =====================================================
function formatAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;

  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;

  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function setLastUpdatedNow() {
  state.timers.lastUpdatedMs = Date.now();

  const el = $("updatedAgo");
  if (!el) return;

  if (state.timers.updatedTimer) clearInterval(state.timers.updatedTimer);
  el.textContent = "0s";

  state.timers.updatedTimer = setInterval(() => {
    el.textContent = formatAgo(Date.now() - state.timers.lastUpdatedMs);
  }, 1000);
}

// =====================================================
// Formatting + date helpers
// =====================================================
function fmtNum(v, digits = 0) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function fmtPct(v, digits = 0) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : "—";
}

function todayParts() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return { yyyy, mm, dd };
}

function todayIsoLocal() {
  const { yyyy, mm, dd } = todayParts();
  return `${yyyy}-${mm}-${dd}`;
}

function yyyymmddFromDateInput(value) {
  return (value || "").replaceAll("-", "");
}

function addDaysToYYYYMMDD(yyyymmdd, deltaDays) {
  const yyyy = Number(yyyymmdd.slice(0, 4));
  const mm = Number(yyyymmdd.slice(4, 6));
  const dd = Number(yyyymmdd.slice(6, 8));
  const d = new Date(yyyy, mm - 1, dd);
  d.setDate(d.getDate() + deltaDays);

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function isoFromYYYYMMDD(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function formatLocalTime(utcIso) {
  if (!utcIso) return "";
  const d = new Date(utcIso);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d);
}

function isFutureMode() {
  return document.documentElement.classList.contains("future");
}

// =====================================================
// Prediction display logic
// =====================================================
function winnerWP(g) {
  if (g.kp_home_wp == null) return null;
  const home = Number(g.kp_home_wp);
  if (!Number.isFinite(home)) return null;
  const away = 100 - home;
  return Math.max(home, away);
}

function fmtPred(g) {
  const st = String(g.status_state || "").toLowerCase();

  // Live or Final: use ESPN scores
  if (st === "in" || st === "post") {
    const a = (g.away_score === null || g.away_score === undefined) ? "—" : String(g.away_score);
    const h = (g.home_score === null || g.home_score === undefined) ? "—" : String(g.home_score);
    const detail = String(g.status_detail || "").trim();
    return detail ? `${a}-${h} (${detail})` : `${a}-${h}`;
  }

  // Pregame: use KenPom prediction if present
  if (g.kp_home_pred == null || g.kp_away_pred == null || g.kp_home_wp == null) return "—";

  const homeWP = Number(g.kp_home_wp);
  const awayWP = 100 - homeWP;

  if (homeWP >= 50) {
    return `${String(g.home)} ${String(g.kp_home_pred)}-${String(g.kp_away_pred)} (${fmtPct(homeWP, 0)})`;
  }
  return `${String(g.away)} ${String(g.kp_away_pred)}-${String(g.kp_home_pred)} (${fmtPct(awayWP, 0)})`;
}

function fmtFinalScoreWithTeams(g) {
  const awayTeam = String(g.away || "Away");
  const homeTeam = String(g.home || "Home");
  const awayScore = g.away_score;
  const homeScore = g.home_score;

  if (awayScore != null && homeScore != null) {
    return `${awayTeam} ${awayScore} - ${homeTeam} ${homeScore}`;
  }

  return g.score || fmtPred(g) || "Final";
}

function buildCfbTeamWithLogo(teamName, logoUrl) {
  const wrap = document.createElement("span");
  wrap.className = "cfb-team-with-logo";

  const logo = String(logoUrl || "").trim();
  if (logo) {
    const img = document.createElement("img");
    img.className = "cfb-team-logo";
    img.src = logo;
    img.alt = teamName ? `${teamName} logo` : "Team logo";
    img.loading = "lazy";
    img.decoding = "async";
    wrap.appendChild(img);
  }

  const txt = document.createElement("span");
  txt.className = "cfb-team-label";
  txt.textContent = teamName || "—";
  wrap.appendChild(txt);

  return wrap;
}

function buildCfbMatchupBlock(g) {
  const container = document.createElement("div");
  container.className = "cfb-matchup-block";

  const awayRow = document.createElement("div");
  awayRow.className = "cfb-matchup-row";
  awayRow.appendChild(buildCfbTeamWithLogo(g.away, g.away_logo));

  const homeRow = document.createElement("div");
  homeRow.className = "cfb-matchup-row";
  homeRow.appendChild(buildCfbTeamWithLogo(g.home, g.home_logo));

  container.appendChild(awayRow);
  container.appendChild(homeRow);
  return container;
}

function buildCbbFinalScoreboard(g) {
  const board = document.createElement("div");
  board.className = "cbb-final-board";

  const awayRow = document.createElement("div");
  awayRow.className = "cbb-final-row";
  const awayLabel = document.createElement("div");
  awayLabel.className = "cbb-final-team";
  awayLabel.textContent = `${g.away || "Away"}`;
  const awayScore = document.createElement("strong");
  awayScore.className = "cbb-final-score";
  awayScore.textContent = String(g.away_score ?? "—");
  awayRow.appendChild(awayLabel);
  awayRow.appendChild(awayScore);

  const homeRow = document.createElement("div");
  homeRow.className = "cbb-final-row";
  const homeLabel = document.createElement("div");
  homeLabel.className = "cbb-final-team";
  homeLabel.textContent = `${g.home || "Home"}`;
  const homeScore = document.createElement("strong");
  homeScore.className = "cbb-final-score";
  homeScore.textContent = String(g.home_score ?? "—");
  homeRow.appendChild(homeLabel);
  homeRow.appendChild(homeScore);

  board.appendChild(awayRow);
  board.appendChild(homeRow);
  return board;
}

// =====================================================
// Live-first sorting helpers
// =====================================================
function isLiveGame(g) {
  return String(g.status_state || "").toLowerCase() === "in" || g.status === "live";
}

function isMlbLiveGame(g) {
  const stateVal = String(g?.state || "").toLowerCase();
  if (stateVal === "in" || stateVal === "live") return true;

  const statusVal = String(g?.status || "").toLowerCase();
  if (statusVal.includes("top") || statusVal.includes("bottom") || statusVal.includes("mid") || statusVal.includes("live")) {
    return true;
  }

  return !!g?.live?.inning_text;
}

function parseClockToSeconds(clockVal) {
  // Backend currently sends numeric seconds (e.g., 597 for 9:57).
  // ESPN-style strings ("9:57") are also supported.
  if (clockVal === null || clockVal === undefined || clockVal === "") return Number.POSITIVE_INFINITY;

  // Numeric seconds
  if (typeof clockVal === "number") {
    return Number.isFinite(clockVal) ? Math.max(0, Math.floor(clockVal)) : Number.POSITIVE_INFINITY;
  }

  // String "m:ss"
  if (typeof clockVal === "string") {
    const parts = clockVal.trim().split(":").map((x) => parseInt(x, 10));
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return Number.POSITIVE_INFINITY;
    const [m, s] = parts;
    return (m * 60) + s;
  }

  return Number.POSITIVE_INFINITY;
}

function liveRemainingSeconds(g) {
  const clockSec = parseClockToSeconds(g.clock);
  if (!Number.isFinite(clockSec)) return Number.POSITIVE_INFINITY;

  const HALF_SEC = 20 * 60;
  const p = Number(g.period || g.status_period || 0);

  if (p <= 1) return HALF_SEC + clockSec;
  if (p === 2) return clockSec;

  const otNumber = Math.max(1, p - 2);
  return clockSec + (otNumber - 1) * 0.001;
}

// =====================================================
// Sorting
// =====================================================
function getSortValue(g, key) {
  if (key === "time") {
    if (!g.start_utc) return null;
    const t = Date.parse(g.start_utc);
    return Number.isFinite(t) ? t : null;
  }
  if (key === "kp") return winnerWP(g);
  if (key === "thrill") {
    const n = Number(g.kp_thrill);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function compareNormal(a, b) {
  const { key: sortKey, dir: sortDir } = state.sort;

  if (sortKey === "time") {
    const at = getSortValue(a, "time");
    const bt = getSortValue(b, "time");

    if (at == null && bt == null) return 0;
    if (at == null) return 1;
    if (bt == null) return -1;

    if (at !== bt) return at - bt;

    const av = getSortValue(a, "thrill");
    const bv = getSortValue(b, "thrill");

    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;

    return bv - av;
  }

  const dir = sortDir === "asc" ? 1 : -1;

  const av = getSortValue(a, sortKey);
  const bv = getSortValue(b, sortKey);

  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;

  if (av < bv) return -1 * dir;
  if (av > bv) return 1 * dir;
  return 0;
}

function compareWithLiveOverride(a, b) {
  const aLive = isLiveGame(a);
  const bLive = isLiveGame(b);

  if (aLive !== bLive) return aLive ? -1 : 1;

  if (aLive && bLive) {
    const ar = liveRemainingSeconds(a);
    const br = liveRemainingSeconds(b);
    if (ar !== br) return ar - br;

    const at = getSortValue(a, "thrill");
    const bt = getSortValue(b, "thrill");
    if (at != null || bt != null) {
      if (at == null) return 1;
      if (bt == null) return -1;
      if (at !== bt) return bt - at;
    }
    return compareNormal(a, b);
  }

  return compareNormal(a, b);
}

function sortGames(games) {
  return [...games].sort(compareWithLiveOverride);
}

function setHeaderLabels() {
  const thTime = document.querySelector('th[data-sort="time"]');
  const thKp = document.querySelector('th[data-sort="kp"]');
  const thThrill = document.querySelector('th[data-sort="thrill"]');

  if (thTime) thTime.textContent = "Start (Local)";
  if (thKp) thKp.textContent = "KenPom";
  if (thThrill) thThrill.textContent = "Thrill";

  const arrow = state.sort.dir === "asc" ? " ▲" : " ▼";
  if (state.sort.key === "time" && thTime) thTime.textContent += arrow;
  if (state.sort.key === "kp" && thKp) thKp.textContent += arrow;
  if (state.sort.key === "thrill" && thThrill) thThrill.textContent += arrow;
}

// =====================================================
// Rendering
// =====================================================
function renderTable(games) {
  const tbody = $("tbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  for (const g of games) {
    const tr = document.createElement("tr");

    const start = document.createElement("td");
    start.className = "nowrap";
    start.textContent = formatLocalTime(g.start_utc);
    tr.appendChild(start);

    const matchup = document.createElement("td");
    matchup.className = "matchup";

    const eventId = String(g.event_id || "");
    const href = state.urlsByEventId[eventId] || "";
    const hasTeamLogos = !!(g.away_logo || g.home_logo);

    if (state.sport === "cfb" && hasTeamLogos) {
      const matchupBlock = buildCfbMatchupBlock(g);
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.appendChild(matchupBlock);
        matchup.appendChild(a);
      } else {
        matchup.appendChild(matchupBlock);
      }
    } else {
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = `${g.away} @ ${g.home}`;
        matchup.appendChild(a);
      } else {
        matchup.textContent = `${g.away} @ ${g.home}`;
      }
    }
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
      thrill.textContent = "—";
      cls += " low";
    }

    thrill.className = cls;
    tr.appendChild(thrill);

    tbody.appendChild(tr);
  }

  const tbl = $("tbl");
  if (tbl) tbl.style.display = "table";
}

function renderCards(games) {
  const board = $("cardBoard");
  if (!board) return;

  const futureMode = isFutureMode();
  board.innerHTML = "";

  if (!games.length) {
    board.innerHTML = `<div class="muted">No CBB games for this date.</div>`;
    board.style.display = "block";
    const tbl = $("tbl");
    if (tbl) tbl.style.display = "none";
    return;
  }

  for (const g of games) {
    const card = document.createElement("div");
    card.className = "game-card";

    // Default game state classes (used by your existing CSS)
    let stateCls = "upcoming";
    let statusText = formatLocalTime(g.start_utc);
    let mainText = fmtPred(g);

    if (g.status === "final") {
      stateCls = "final";
      statusText = "Final";
      mainText = fmtFinalScoreWithTeams(g);
    } else if (g.status === "live") {
      stateCls = "live";
      statusText = "LIVE";
      mainText = fmtPred(g);
    } else if (String(g.status_state || "").toLowerCase() === "post") {
      stateCls = "final";
      statusText = "Final";
      mainText = fmtFinalScoreWithTeams(g);
    } else if (String(g.status_state || "").toLowerCase() === "in") {
      stateCls = "live";
      statusText = "LIVE";
      mainText = fmtPred(g);
    }

    card.classList.add(stateCls);

    // Matchup (link if available)
    const matchup = document.createElement("div");
    matchup.className = "matchup";

    const eventId = String(g.event_id || "");
    const href = state.urlsByEventId[eventId] || "";
    const hasTeamLogos = !!(g.away_logo || g.home_logo);

    if (state.sport === "cfb" && hasTeamLogos) {
      const matchupBlock = buildCfbMatchupBlock(g);
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.appendChild(matchupBlock);
        matchup.appendChild(a);
      } else {
        matchup.appendChild(matchupBlock);
      }
    } else {
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = `${g.away} @ ${g.home}`;
        matchup.appendChild(a);
      } else {
        matchup.textContent = `${g.away} @ ${g.home}`;
      }
    }

    // FUTURE MODE: schedule tiles only (no KP/thrill/score text)
    if (futureMode) {
      // Optional "Upcoming" badge (matches your accent-style mock)
      const badge = document.createElement("div");
      badge.className = "badge";
      badge.innerHTML = '<span class="dot"></span>Upcoming';

      // Meta row: time + network
      const meta = document.createElement("div");
      meta.className = "meta-row";

      const time = document.createElement("span");
      time.className = "time";
      const statusDetail = String(g.status_detail || "").toLowerCase();
      if (statusDetail.includes("tba") || !g.start_utc) {
        time.textContent = "TBA";
      } else {
        time.textContent = formatLocalTime(g.start_utc) || "TBA";
      }

      const network = document.createElement("span");
      network.className = "network";
      network.textContent = g.network || "";

      meta.appendChild(time);
      meta.appendChild(network);

      card.appendChild(badge);
      card.appendChild(matchup);
      card.appendChild(meta);

      board.appendChild(card);
      continue;
    }

    // NORMAL MODE: your existing content
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = statusText;

    const main = document.createElement("div");
    main.className = "main";
    main.textContent = mainText;

    const footer = document.createElement("div");
    footer.className = "footer";

    const thrill = document.createElement("span");
    const t = Number(g.kp_thrill);
    let thrillCls = "thrill";

    if (Number.isFinite(t)) {
      if (t >= 65) thrillCls += " high";
      else if (t >= 40) thrillCls += " mid";
      else thrillCls += " low";
      thrill.textContent = `Thrill ${t.toFixed(1)}`;
    } else {
      thrill.textContent = "Thrill —";
      thrillCls += " low";
    }

    thrill.className = thrillCls;

    const network = document.createElement("span");
    network.textContent = g.network || "";

    footer.appendChild(thrill);
    footer.appendChild(network);

    if (stateCls !== "final") {
      card.appendChild(matchup);
    }
    card.appendChild(status);

    if (stateCls === "final") {
      main.replaceChildren(buildCbbFinalScoreboard(g));
    }
    card.appendChild(main);

    // Show probable starting pitchers for upcoming games when available
    const probDiv = document.createElement("div");
    probDiv.className = "sub mlb-probables";
    const awayProb = g.away?.probable?.name || g.away_probable?.name || g.away?.probable || "";
    const homeProb = g.home?.probable?.name || g.home_probable?.name || g.home?.probable || "";
    if ((awayProb || homeProb) && g.state !== "in" && g.state !== "post") {
      const awayLabel = awayProb || "TBA";
      const homeLabel = homeProb || "TBA";
      probDiv.textContent = `Probables: ${awayLabel} vs ${homeLabel}`;
      card.appendChild(probDiv);
    }
    card.appendChild(footer);

    board.appendChild(card);
  }

  board.style.display = "grid";

  const tbl = $("tbl");
  if (tbl) tbl.style.display = "none";
}

function mlbHrefFromGame(game) {
  const direct = String(game?.url || "").trim();
  if (direct) return direct;

  const eventId = String(game?.id || "").trim();
  return eventId ? `https://www.espn.com/mlb/game/_/gameId/${eventId}` : "";
}

function channelTextFromGame(game) {
  const channels = Array.isArray(game?.channels)
    ? game.channels
        .filter(Boolean)
        .filter((c) => {
          const raw = String(c).trim().toLowerCase();
          const compact = raw.replace(/[^a-z0-9]/g, "");
          if (compact === "mlbtv") return false;
          if (compact.includes("espnunlimited") || compact.includes("espnunlmtd")) return false;
          return true;
        })
    : [];
  return channels.join(", ");
}

function buildBasesGraphic(live) {
  const wrap = document.createElement("div");
  wrap.className = "bases";

  const diamond = document.createElement("div");
  diamond.className = "diamond";

  const first = document.createElement("span");
  first.className = `base first${live?.on_first ? " on" : ""}`;
  first.setAttribute("aria-label", `1st base ${live?.on_first ? "occupied" : "empty"}`);

  const second = document.createElement("span");
  second.className = `base second${live?.on_second ? " on" : ""}`;
  second.setAttribute("aria-label", `2nd base ${live?.on_second ? "occupied" : "empty"}`);

  const third = document.createElement("span");
  third.className = `base third${live?.on_third ? " on" : ""}`;
  third.setAttribute("aria-label", `3rd base ${live?.on_third ? "occupied" : "empty"}`);

  const plate = document.createElement("span");
  plate.className = "base plate";

  diamond.appendChild(first);
  diamond.appendChild(second);
  diamond.appendChild(third);
  diamond.appendChild(plate);
  wrap.appendChild(diamond);
  return wrap;
}

function demoLiveMlbGame() {
  return {
    id: "demo-live",
    url: "",
    startTime: new Date().toISOString(),
    state: "in",
    status: "Top 7th",
    channels: ["ESPN"],
    away: { abbr: "NYY", name: "Yankees", score: 4 },
    home: { abbr: "BOS", name: "Red Sox", score: 3 },
    live: {
      inning: 7,
      inning_half: "Top",
      inning_text: "Top 7",
      outs: 1,
      balls: 2,
      strikes: 1,
      on_first: true,
      on_second: false,
      on_third: true,
      batter: { id: "demo-batter", name: "Aaron Judge" },
      pitcher: { id: "demo-pitcher", name: "Kenley Jansen" },
    },
  };
}

function shouldShowDemoLiveCard() {
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get("demoLiveCard") === "1";
  } catch {
    return false;
  }
}

function enrichMlbLiveContext(prevGames, nextGames) {
  const prevById = new Map((prevGames || []).map((g) => [String(g?.id || ""), g]));

  return (nextGames || []).map((g) => {
    if (String(g?.state || "").toLowerCase() !== "in") return g;

    const live = { ...(g.live || {}) };
    const prevLive = prevById.get(String(g?.id || ""))?.live || {};
    const isBetween = isBetweenInningsStatus(g?.status);

    const dueUp = Array.isArray(live.due_up) ? live.due_up.filter((p) => p && p.name) : [];
    const prevDueUp = Array.isArray(prevLive.due_up) ? prevLive.due_up.filter((p) => p && p.name) : [];

    if (isBetween && !dueUp.length && prevDueUp.length) {
      live.due_up = prevDueUp;
    }

    if ((!live.batter || !live.batter.name) && dueUp.length) {
      live.batter = dueUp[0];
    }

    if (isBetween && (!live.batter || !live.batter.name)) {
      const currentDue = Array.isArray(live.due_up) ? live.due_up.filter((p) => p && p.name) : [];
      if (currentDue.length) {
        live.batter = currentDue[0];
      } else if (prevLive?.batter?.name) {
        live.batter = prevLive.batter;
      }
    }

    // During inning breaks ESPN can omit pitcher; keep last known live pitcher.
    if ((!live.pitcher || !live.pitcher.name) && prevLive?.pitcher?.name) {
      live.pitcher = prevLive.pitcher;
    }

    return { ...g, live };
  });
}

function isBetweenInningsStatus(status) {
  const s = String(status || "").toLowerCase();
  return s.includes("middle") || s.includes("end");
}

function lastNameFromFullName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";

  const last = parts[parts.length - 1].replace(/\./g, "").toUpperCase();
  const suffixes = new Set(["JR", "SR", "II", "III", "IV", "V"]);

  if (parts.length >= 2 && suffixes.has(last)) {
    return `${parts[parts.length - 2]} ${parts[parts.length - 1]}`;
  }

  return parts[parts.length - 1];
}

function formatMlbStatusLabel(rawStatus) {
  const txt = String(rawStatus || "").trim();
  if (!txt) return "";

  const m = txt.match(/^(top|bottom)\s+(.+)$/i);
  if (!m) return txt;

  const arrow = m[1].toLowerCase() === "top" ? "↑" : "↓";
  return `${arrow} ${m[2]}`;
}

function buildMlbLiveStatusMeta(game, live) {
  const wrap = document.createElement("div");
  wrap.className = "mlb-live-status-meta";

  if (isMlbLateCloseGame(game)) {
    const closeChip = document.createElement("span");
    closeChip.className = "mlb-live-chip close-game";
    closeChip.textContent = "Close Game";
    wrap.appendChild(closeChip);
  }

  if (isMlbRispGame(game)) {
    const rispChip = document.createElement("span");
    rispChip.className = "mlb-live-chip risp";
    rispChip.textContent = "RISP";
    wrap.appendChild(rispChip);
  }

  const inningChip = document.createElement("span");
  inningChip.className = "mlb-live-chip inning";
  inningChip.textContent = formatMlbStatusLabel(live?.inning_text || game?.status || "LIVE");
  wrap.appendChild(inningChip);

  if (!isBetweenInningsStatus(game?.status)) {
    const balls = Number.isFinite(Number(live?.balls)) ? Number(live.balls) : "-";
    const strikes = Number.isFinite(Number(live?.strikes)) ? Number(live.strikes) : "-";
    const outs = Number.isFinite(Number(live?.outs)) ? Number(live.outs) : "-";

    const countChip = document.createElement("span");
    countChip.className = "mlb-live-chip";
    countChip.textContent = `Count ${balls}-${strikes}`;

    const outsChip = document.createElement("span");
    outsChip.className = "mlb-live-chip outs";
    outsChip.textContent = `Outs ${outs}`;

    wrap.appendChild(countChip);
    wrap.appendChild(outsChip);
  }

  return wrap;
}

function buildMlbLiveScoreboard(game) {
  const board = document.createElement("div");
  board.className = "mlb-live-board";

  const awayRow = document.createElement("div");
  awayRow.className = "mlb-live-row";
  const awayTeam = buildMlbTeamWithLogo(game.away, "mlb-live-team-wrap", "mlb-live-team");
  const awayScore = document.createElement("strong");
  awayScore.className = "mlb-live-score";
  awayScore.textContent = `${game.away?.score ?? "—"}`;
  awayRow.appendChild(awayTeam);
  awayRow.appendChild(awayScore);

  const homeRow = document.createElement("div");
  homeRow.className = "mlb-live-row";
  const homeTeam = buildMlbTeamWithLogo(game.home, "mlb-live-team-wrap", "mlb-live-team");
  const homeScore = document.createElement("strong");
  homeScore.className = "mlb-live-score";
  homeScore.textContent = `${game.home?.score ?? "—"}`;
  homeRow.appendChild(homeTeam);
  homeRow.appendChild(homeScore);

  board.appendChild(awayRow);
  board.appendChild(homeRow);
  return board;
}

function buildMlbTeamWithLogo(team, wrapClass = "mlb-team-with-logo", labelClass = "mlb-team-label") {
  const wrap = document.createElement("span");
  wrap.className = wrapClass;

  const logo = String(team?.logo || "").trim();
  const label = team?.abbr || team?.name || "";

  if (logo) {
    let tmpl = mlbLogoTemplateCache.get(logo);
    if (!tmpl) {
      tmpl = document.createElement("img");
      tmpl.className = "mlb-team-logo";
      tmpl.src = logo;
      tmpl.loading = "eager";
      tmpl.decoding = "sync";
      mlbLogoTemplateCache.set(logo, tmpl);
    }

    const img = tmpl.cloneNode(true);
    img.alt = label ? `${label} logo` : "Team logo";
    wrap.appendChild(img);
  }

  const txt = document.createElement("span");
  txt.className = labelClass;
  txt.textContent = label || "—";
  wrap.appendChild(txt);

  return wrap;
}

function mlbStateSortRank(state) {
  const s = String(state || "").toLowerCase();
  if (s === "in") return 0;
  if (s === "post") return 1;
  if (s === "pre") return 2;
  return 3;
}

function mlbLiveHalfRank(game) {
  const half = String(game?.live?.inning_half || "").toLowerCase();
  if (half === "bottom") return 3;
  if (half === "middle") return 2;
  if (half === "top") return 1;
  if (half === "end") return 0;
  return 0;
}

function mlbLiveProgressScore(game) {
  const inning = mlbInningNumber(game);
  const safeInning = Number.isFinite(inning) ? inning : 0;
  return (safeInning * 10) + mlbLiveHalfRank(game);
}

function mlbInningNumber(game) {
  const direct = Number(game?.live?.inning);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const text = String(game?.live?.inning_text || game?.status || "");
  const m = text.match(/(\d{1,2})(?:st|nd|rd|th)?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

function isMlbLateCloseGame(game) {
  if (String(game?.state || "").toLowerCase() !== "in") return false;
  const inning = mlbInningNumber(game);
  if (inning < 7) return false;

  const awayScore = Number(game?.away?.score);
  const homeScore = Number(game?.home?.score);
  if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) return false;

  return Math.abs(awayScore - homeScore) < 3;
}

function isMlbRispGame(game) {
  if (String(game?.state || "").toLowerCase() !== "in") return false;
  return !!(game?.live?.on_second || game?.live?.on_third);
}

function teamAbbrForDecision(game, decision) {
  const teamId = String(decision?.team_id || "");
  if (!teamId) return "";
  if (String(game?.away?.id || "") === teamId) return game?.away?.abbr || game?.away?.name || "";
  if (String(game?.home?.id || "") === teamId) return game?.home?.abbr || game?.home?.name || "";
  return "";
}

function formatDecisionLine(game, label, decision) {
  if (!decision || !decision.name) return "";
  const teamAbbr = teamAbbrForDecision(game, decision);
  const rec = decision.record ? ` (${decision.record})` : "";
  const teamPrefix = teamAbbr ? `${teamAbbr} ` : "";
  return `${label}: ${teamPrefix}${decision.name}${rec}`;
}

// MLB cards (reuses .game-card styling)
function renderMlbCards(games) {
  const board = $("cardBoard");
  if (!board) return;

  const sorted = [...(games || [])].sort((a, b) => {
    const rankDiff = mlbStateSortRank(a?.state) - mlbStateSortRank(b?.state);
    if (rankDiff !== 0) return rankDiff;

    if (String(a?.state || "").toLowerCase() === "in" && String(b?.state || "").toLowerCase() === "in") {
      const aLateClose = isMlbLateCloseGame(a);
      const bLateClose = isMlbLateCloseGame(b);
      if (aLateClose !== bLateClose) return aLateClose ? -1 : 1;

      const aRisp = isMlbRispGame(a);
      const bRisp = isMlbRispGame(b);
      if (aRisp !== bRisp) return aRisp ? -1 : 1;

      const progressDiff = mlbLiveProgressScore(b) - mlbLiveProgressScore(a);
      if (progressDiff !== 0) return progressDiff;
    }

    return String(a?.startTime || "").localeCompare(String(b?.startTime || ""));
  });
  if (shouldShowDemoLiveCard() && !sorted.some((g) => g.state === "in")) {
    sorted.unshift(demoLiveMlbGame());
  }
  board.innerHTML = "";

  if (!sorted.length) {
    board.innerHTML = `<div class="muted">No MLB games for this date.</div>`;
    board.style.display = "block";
    const tbl = $("tbl");
    if (tbl) tbl.style.display = "none";
    return;
  }

  for (const g of sorted) {
    const card = document.createElement("div");
    card.className = "game-card";

    let cls = "upcoming";
    if (g.state === "post") cls = "final";
    else if (g.state === "in") cls = "live";
    card.classList.add(cls);

    const away = g.away?.abbr || g.away?.name || "—";
    const home = g.home?.abbr || g.home?.name || "—";

    const matchup = document.createElement("div");
    matchup.className = "matchup";
    const href = mlbHrefFromGame(g);
    const awayToken = buildMlbTeamWithLogo(g.away, "mlb-team-with-logo", "mlb-team-label");
    const homeToken = buildMlbTeamWithLogo(g.home, "mlb-team-with-logo", "mlb-team-label");
    const sep = document.createElement("span");
    sep.className = "mlb-matchup-sep";
    sep.textContent = " @ ";

    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.appendChild(awayToken);
      a.appendChild(sep);
      a.appendChild(homeToken);
      matchup.appendChild(a);
    } else {
      matchup.appendChild(awayToken);
      matchup.appendChild(sep);
      matchup.appendChild(homeToken);
    }

    const status = document.createElement("div");
    status.className = "status";

    const main = document.createElement("div");
    main.className = "main";
    const channelText = channelTextFromGame(g);

    if (g.state === "post" && g.away?.score != null && g.home?.score != null) {
      // Finished game: show final + scoreboard (logos in line)
      status.textContent = "Final";
      main.replaceChildren(buildMlbLiveScoreboard(g));
    } else if (g.state === "in") {
      // Live game: show score + inning/status details
      status.classList.add("mlb-live-status");
      status.replaceChildren(buildMlbLiveStatusMeta(g, g.live || {}));
      main.replaceChildren(buildMlbLiveScoreboard(g));
    } else {
      // Upcoming: show local start time if available, but do not display "Scheduled"
      status.textContent = formatLocalTime(g.startTime) || "";
      main.textContent = "";
    }

    if (g.state !== "post") {
      card.appendChild(matchup);
    }
    card.appendChild(status);
    card.appendChild(main);

    // Live details block
    if (g.state === "in") {
      const live = g.live || {};
      const liveMeta = document.createElement("div");
      liveMeta.className = "mlb-live-meta";

      const people = document.createElement("div");
      people.className = "mlb-live-people";
      const batterName = live?.batter?.name || "TBA";
      const pitcherName = live?.pitcher?.name || "TBA";
      const dueUpNames = (Array.isArray(live?.due_up) ? live.due_up : [])
        .map((p) => p?.name)
        .filter(Boolean)
        .slice(0, 3);
      const dueUpLastNames = dueUpNames.map(lastNameFromFullName).filter(Boolean);

      if (isBetweenInningsStatus(g.status)) {
        const betweenInningsDue = dueUpLastNames.length
          ? dueUpLastNames.join(", ")
          : (batterName !== "TBA" ? lastNameFromFullName(batterName) : "TBA");
        const dueLine = document.createElement("div");
        dueLine.className = "sub mlb-person-line";
        dueLine.textContent = `Due up: ${betweenInningsDue}`;
        people.appendChild(dueLine);
      } else if (dueUpNames.length) {
        const dueLine = document.createElement("div");
        dueLine.className = "sub mlb-person-line";
        dueLine.textContent = `Due up: ${dueUpLastNames.join(", ")}`;
        people.appendChild(dueLine);

        const batterLine = document.createElement("div");
        batterLine.className = "sub mlb-person-line";
        batterLine.textContent = `Batter: ${batterName}`;
        people.appendChild(batterLine);

        const pitcherLine = document.createElement("div");
        pitcherLine.className = "sub mlb-person-line";
        pitcherLine.textContent = `Pitcher: ${pitcherName}`;
        people.appendChild(pitcherLine);
      } else {
        const batterLine = document.createElement("div");
        batterLine.className = "sub mlb-person-line";
        batterLine.textContent = `Batter: ${batterName}`;
        people.appendChild(batterLine);

        const pitcherLine = document.createElement("div");
        pitcherLine.className = "sub mlb-person-line";
        pitcherLine.textContent = `Pitcher: ${pitcherName}`;
        people.appendChild(pitcherLine);
      }

      liveMeta.appendChild(buildBasesGraphic(live));
      liveMeta.appendChild(people);
      card.appendChild(liveMeta);
    }

    // Show probable starting pitchers for upcoming MLB games when available
    const probDiv = document.createElement("div");
    probDiv.className = "sub mlb-probables";
    const awayProb = g.away_probable?.name || g.away?.probable?.name || g.away?.probable || "";
    const homeProb = g.home_probable?.name || g.home?.probable?.name || g.home?.probable || "";
    if ((awayProb || homeProb) && g.state !== "in" && g.state !== "post") {
      const awayLabel = awayProb || "TBA";
      const homeLabel = homeProb || "TBA";

      const title = document.createElement("div");
      title.className = "mlb-probables-title";
      title.textContent = "Probables";

      const awayLine = document.createElement("div");
      awayLine.className = "mlb-probable-line";
      const awayTeam = document.createElement("span");
      awayTeam.className = "mlb-probable-team";
      awayTeam.textContent = away;
      const awayPitcher = document.createElement("span");
      awayPitcher.className = "mlb-probable-pitcher";
      awayPitcher.textContent = awayLabel;
      awayLine.appendChild(awayTeam);
      awayLine.appendChild(awayPitcher);

      const homeLine = document.createElement("div");
      homeLine.className = "mlb-probable-line";
      const homeTeam = document.createElement("span");
      homeTeam.className = "mlb-probable-team";
      homeTeam.textContent = home;
      const homePitcher = document.createElement("span");
      homePitcher.className = "mlb-probable-pitcher";
      homePitcher.textContent = homeLabel;
      homeLine.appendChild(homeTeam);
      homeLine.appendChild(homePitcher);

      probDiv.appendChild(title);
      probDiv.appendChild(awayLine);
      probDiv.appendChild(homeLine);
      card.appendChild(probDiv);
    }

    // Show winning/losing/save pitcher info for final games when available
    if (g.state === "post" && g.decisions) {
      const decDiv = document.createElement("div");
      decDiv.className = "sub mlb-decisions";

      const wLine = formatDecisionLine(g, "W", g.decisions.winning);
      const lLine = formatDecisionLine(g, "L", g.decisions.losing);
      const sLine = formatDecisionLine(g, "S", g.decisions.save);

      if (wLine) {
        const row = document.createElement("div");
        row.className = "mlb-decision-line";
        row.textContent = wLine;
        decDiv.appendChild(row);
      }
      if (lLine) {
        const row = document.createElement("div");
        row.className = "mlb-decision-line";
        row.textContent = lLine;
        decDiv.appendChild(row);
      }
      if (sLine) {
        const row = document.createElement("div");
        row.className = "mlb-decision-line";
        row.textContent = sLine;
        decDiv.appendChild(row);
      }

      if (decDiv.childElementCount > 0) {
        card.appendChild(decDiv);
      }
    }

    const footer = document.createElement("div");
    footer.className = "footer";
    const channel = document.createElement("span");
    channel.className = "mlb-channel";
    channel.textContent = channelText || "";
    const stateText = document.createElement("span");
    stateText.className = "mlb-state-text";
    stateText.textContent = g.state === "in" ? "LIVE" : "";
    footer.appendChild(channel);
    footer.appendChild(stateText);
    card.appendChild(footer);

    board.appendChild(card);
  }

  board.style.display = "grid";

  const tbl = $("tbl");
  if (tbl) tbl.style.display = "none";
}

// =====================================================
// Conference dropdown (Hi/Mid + conferences present that day)
// Requires: <select id="confFilter"></select> in HTML (safe no-op if missing)
// =====================================================
function buildConferenceOptions() {
  const sel = $("confFilter");
  if (!sel) return;

  const prev = state.filters.confChoice || "";

  if (state.sport === "cfb") {
    sel.innerHTML = "";
    sel.appendChild(new Option("All games", ""));
    sel.appendChild(new Option("Power 4", "p4"));
    sel.appendChild(new Option("ACC", "p4:acc"));
    sel.appendChild(new Option("Big Ten", "p4:bigten"));
    sel.appendChild(new Option("Big 12", "p4:big12"));
    sel.appendChild(new Option("SEC", "p4:sec"));
    sel.appendChild(new Option("Non Power 4", "nonp4"));

    const allowedValues = new Set(Array.from(sel.options).map((o) => o.value));
    if (prev && allowedValues.has(prev)) {
      sel.value = prev;
    } else {
      sel.value = "";
      state.filters.confChoice = "";
    }
    return;
  }

  // Collect conferences that appear today
  const idToLabel = new Map(); // id -> label (short preferred)
  for (const g of state.games) {
    for (const side of ["away", "home"]) {
      const c = side === "home" ? g.home_conf : g.away_conf;
      if (!c || typeof c !== "object") continue;

      const id = String(c.id || "").trim();
      if (!id) continue;

      const label = (c.short || c.name || "").trim() || id;
      if (!idToLabel.has(id)) idToLabel.set(id, label);
    }
  }

  // Sort conferences alphabetically by label
  const confs = Array.from(idToLabel.entries())
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Build options
  sel.innerHTML = "";
  sel.appendChild(new Option("All games", ""));

  // Only include hi/mid if there are any games in those buckets today
  const hasHi = state.games.some(gameIsHighMajor);
  const hasMid = state.games.some(gameIsMidMajor);

  if (hasHi) sel.appendChild(new Option("High Major", "hi"));
  if (hasMid) sel.appendChild(new Option("Mid Major", "mid"));

  // Conferences that have games today
  if (confs.length) {
    const sep = new Option("──────────", "__sep__");
    sep.disabled = true;
    sel.appendChild(sep);

    for (const c of confs) {
      sel.appendChild(new Option(c.label, `conf:${c.id}`));
    }
  }

  // Restore previous selection if still valid
  const allowedValues = new Set(Array.from(sel.options).map((o) => o.value));
  if (prev && allowedValues.has(prev)) {
    sel.value = prev;
  } else {
    sel.value = "";
    state.filters.confChoice = "";
  }
}

// =====================================================
// Filtering
// =====================================================
function applyFilters(games) {
  const minT = Number(state.filters.minThrill) || 0;
  const confChoice = String(state.filters.confChoice || "");

  return games.filter((g) => {
    if (minT > 0) {
      const t = Number(g.kp_thrill);
      if (!Number.isFinite(t) || t < minT) return false;
    }

    // Conf filter
    if (confChoice) {
      if (confChoice === "p4") {
        if (!gameIsCfbPower4OrNotreDame(g)) return false;
      } else if (confChoice === "nonp4") {
        if (gameIsCfbPower4OrNotreDame(g)) return false;
      } else if (confChoice.startsWith("p4:")) {
        const leagueKey = confChoice.slice(3);
        const confIdWanted = CFB_CONF_FILTER_ID[leagueKey];
        if (!confIdWanted || !gameIsCfbConference(g, confIdWanted)) return false;
      } else if (confChoice === "hi") {
        if (!gameIsHighMajor(g)) return false;
      } else if (confChoice === "mid") {
        if (!gameIsMidMajor(g)) return false;
      } else if (confChoice.startsWith("conf:")) {
        const idWanted = confChoice.slice(5);
        if (!gameInConferenceId(g, idWanted)) return false;
      }
    }

    return true;
  });
}

function updateCountLine(shown, total) {
  const el = $("countLine");
  if (!el) return;
  el.textContent = `Showing ${shown} of ${total} games`;
}

function applySortAndRender() {
  setHeaderLabels();
  const filtered = applyFilters(state.games);
  updateCountLine(filtered.length, state.games.length);
  renderCards(sortGames(filtered));
}

// =====================================================
// Wiring (events)
// =====================================================
function wireSorting() {
  const headers = document.querySelectorAll("th[data-sort]");
  headers.forEach((th) => {
    th.style.cursor = "pointer";
    th.title = "Click to sort";

    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort");

      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = key;
        state.sort.dir = key === "time" ? "asc" : "desc";
      }

      applySortAndRender();
    });
  });
}

function wireFilters() {
  $("minThrill")?.addEventListener("change", (e) => {
    state.filters.minThrill = Number(e.target.value) || 0;
    applySortAndRender();
  });

  $("confFilter")?.addEventListener("change", (e) => {
    const v = e.target.value || "";
    if (v === "__sep__") return;
    state.filters.confChoice = v;
    applySortAndRender();
  });

  $("clearFilters")?.addEventListener("click", () => {
    state.filters.minThrill = 0;
    state.filters.confChoice = "";

    if ($("minThrill")) $("minThrill").value = "0";
    if ($("confFilter")) $("confFilter").value = "";

    applySortAndRender();
  });

  $("datePicker")?.addEventListener("change", (e) => {
    const yyyymmdd = yyyymmddFromDateInput(e.target.value);
    persistDate(e.target.value);
    loadGames(yyyymmdd);
  });

  $("prevDayBtn")?.addEventListener("click", () => {
    const cur = yyyymmddFromDateInput($("datePicker")?.value || "");
    const nextDate = addDaysToYYYYMMDD(cur, -1);
    persistDate(isoFromYYYYMMDD(nextDate));
    loadGames(nextDate);
  });

  $("nextDayBtn")?.addEventListener("click", () => {
    const cur = yyyymmddFromDateInput($("datePicker")?.value || "");
    const nextDate = addDaysToYYYYMMDD(cur, 1);
    persistDate(isoFromYYYYMMDD(nextDate));
    loadGames(nextDate);
  });

  $("todayBtn")?.addEventListener("click", () => {
    const { yyyy, mm, dd } = todayParts();
    const today = `${yyyy}${mm}${dd}`;
    if ($("datePicker")) {
      $("datePicker").value = `${yyyy}-${mm}-${dd}`;
    }
    persistDate(`${yyyy}-${mm}-${dd}`);
    loadGames(today);
  });
}

// =====================================================
// Fetch helpers
// =====================================================
async function fetchEspnUrls(date_espn, sport = "cbb") {
  try {
    const resp = await fetchWithTimeout(`/urls/espn?date_espn=${date_espn}&sport=${encodeURIComponent(sport)}`);
    const data = await resp.json();
    return (resp.ok && data.urls_by_event_id) ? data.urls_by_event_id : {};
  } catch {
    return {};
  }
}

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchGames(date_espn, date_kp, sport = "cbb") {
  const url = `/games?date_espn=${date_espn}&date_kp=${date_kp}&sport=${encodeURIComponent(sport)}`;
  const resp = await fetchWithTimeout(url);
  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  return { resp, data };
}

async function fetchMlbGames(date_yyyymmdd) {
  const resp = await fetchWithTimeout(`/mlb/games?date=${date_yyyymmdd}`);
  const data = await resp.json();
  return { resp, data };
}

// =====================================================
// Main load function (supports silent refresh)
// =====================================================
async function loadGames(yyyymmdd = null, silent = false) {
  clearError();
  if (!silent) clearTableForFullLoad();

  if (!yyyymmdd) {
    let pickerVal = $("datePicker")?.value || "";
    if (!pickerVal) {
      pickerVal = getPersistedDate() || "";
      if (pickerVal && $("datePicker")) $("datePicker").value = pickerVal;
    }
    yyyymmdd = pickerVal ? yyyymmddFromDateInput(pickerVal) : null;
  }
  if (!yyyymmdd) {
    const { yyyy, mm, dd } = todayParts();
    yyyymmdd = `${yyyy}${mm}${dd}`;
    if ($("datePicker")) {
      $("datePicker").value = `${yyyy}-${mm}-${dd}`;
    }
  }
  persistDate(isoFromYYYYMMDD(yyyymmdd));

  const date_kp = isoFromYYYYMMDD(yyyymmdd);
  const date_espn = yyyymmdd;

  if ($("datePicker")) $("datePicker").value = date_kp;

  // ---------------------------
  // MLB
  // ---------------------------
  if (state.sport === "mlb") {
    state.urlsByEventId = {};
    const prevMlbGames = state.mlbGames || [];

    let resp, data;
    try {
      ({ resp, data } = await fetchMlbGames(date_espn));
    } catch (e) {
      if (!silent) showError(`Failed to load MLB games\n${e}`);
      return;
    }

    if (!resp.ok) {
      if (!silent) showError(JSON.stringify(data, null, 2));
      return;
    }

    state.mlbGames = enrichMlbLiveContext(prevMlbGames, data.games || []);

    // MLB doesn't use KP future mode styling, but does share polling behavior.
    document.documentElement.classList.remove("future");
    const hasLive = state.mlbGames.some((g) => isMlbLiveGame(g));
    setPollingMode(hasLive ? "live" : "idle");

    updateCountLine(state.mlbGames.length, state.mlbGames.length);
    renderMlbCards(state.mlbGames);
    setLastUpdatedNow();
    return;
  }

  // ---------------------------
  // CBB/CFB/NFL (ESPN behavior)
  // ---------------------------
  if (state.sport === "cbb" || state.sport === "cfb" || state.sport === "nfl") {
    // URLs for external deep-links via ESPN as available.
    state.urlsByEventId = await fetchEspnUrls(date_espn, state.sport);

    let resp, data;
    try {
      ({ resp, data } = await fetchGames(date_espn, date_kp, state.sport));
    } catch (e) {
      showError(`Failed to load ${state.sport.toUpperCase()} games\n${e}`);
      return;
    }

    if (!resp.ok) {
      showError(JSON.stringify(data, null, 2));
      return;
    }

    state.games = Array.isArray(data.games) ? data.games : [];

    // Future date mode (drives future-day rendering + CSS)
    const isFuture = data.mode === "future";
    document.documentElement.classList.toggle("future", isFuture);

    const hasLive = state.games.some((g) => String(g.status_state || "").toLowerCase() === "in" || g.status === "live");
    const isToday = ($("datePicker")?.value || "") === todayIsoLocal();
    setPollingMode(!isFuture && isToday ? (hasLive ? "live" : "idle") : "off");

    if (state.sport === "cbb" || state.sport === "cfb") {
      buildConferenceOptions();
    }

    applySortAndRender();
    setLastUpdatedNow();
    return;
  }

  // ---------------------------
  // Fallback: treat as CBB
  // ---------------------------
  state.urlsByEventId = await fetchEspnUrls(date_espn);

  let resp, data;
  try {
    ({ resp, data } = await fetchGames(date_espn, date_kp));
  } catch (e) {
    showError(`Failed to load games\n${e}`);
    return;
  }

  if (!resp.ok) {
    showError(JSON.stringify(data, null, 2));
    return;
  }

  state.games = Array.isArray(data.games) ? data.games : [];

  // Future date mode (drives future-day rendering + CSS)
  const isFuture = data.mode === "future";
  document.documentElement.classList.toggle("future", isFuture);

  const hasLive = state.games.some((g) => String(g.status_state || "").toLowerCase() === "in" || g.status === "live");
  const isToday = ($("datePicker")?.value || "") === todayIsoLocal();
  setPollingMode(!isFuture && isToday ? (hasLive ? "live" : "idle") : "off");

  buildConferenceOptions();
  applySortAndRender();
  setLastUpdatedNow();
}

// =====================================================
// Boot
// =====================================================
function boot() {
  wireTabs();
  wireSorting();
  wireFilters();

  const isExistingTab = sessionStorage.getItem("sportsSlate_session_init") === "true";
  if (!isExistingTab) {
    sessionStorage.setItem("sportsSlate_session_init", "true");
  }

  let initialSport = "mlb";
  let initialDate = "";

  if (isExistingTab) {
    const persistedSport = getPersistedSport();
    if (persistedSport && ["mlb", "cbb", "nfl", "cfb"].includes(persistedSport)) {
      initialSport = persistedSport;
    }

    const persistedDate = getPersistedDate();
    if (persistedDate && $("datePicker")) {
      initialDate = persistedDate;
      $("datePicker").value = persistedDate;
    }
  } else {
    // New tab: force current MLB today (don't use persisted values from other tabs)
    initialSport = "mlb";
    const { yyyy, mm, dd } = todayParts();
    initialDate = `${yyyy}-${mm}-${dd}`;
    if ($("datePicker")) {
      $("datePicker").value = initialDate;
    }
    persistDate(initialDate);
  }

  state.sport = initialSport;
  setSport(initialSport);
}

boot();
