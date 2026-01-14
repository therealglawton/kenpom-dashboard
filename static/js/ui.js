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

// ---------------------
// App state (single source of truth)
// ---------------------
const state = {
  sport: "cbb",         // "cbb" | "mlb"
  games: [],            // CBB games
  mlbGames: [],         // MLB games
  urlsByEventId: {},

  sort: { key: "time", dir: "asc" }, // default: time asc (thrill tiebreaker desc)

  filters: {
    qText: "",
    minThrill: 0,
    networkChoice: "",
    hideEspnPlus: false,

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
    updatedTimer: null,
    lastUpdatedMs: null,
  },
};

// =====================================================
// Tabs (CBB / MLB)
// =====================================================
function setSport(sport) {
  state.sport = sport;
  document.documentElement.classList.toggle("mlb", sport === "mlb");

  const tabCbb = $("tabCbb");
  const tabMlb = $("tabMlb");
  const isCbb = sport === "cbb";

  if (tabCbb && tabMlb) {
    tabCbb.classList.toggle("active", isCbb);
    tabMlb.classList.toggle("active", !isCbb);
    tabCbb.setAttribute("aria-selected", String(isCbb));
    tabMlb.setAttribute("aria-selected", String(!isCbb));
  }

  // Disable CBB-only controls in MLB mode (prevents weird filtering/UI surprises)
  const cbbOnlyIds = ["minThrill", "confFilter", "networkFilter", "hideEspnPlus", "clearFilters"];
  cbbOnlyIds.forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !isCbb;
  });

  // Search box: keep enabled for CBB, disable for MLB for now (simple + predictable)
  if ($("q")) $("q").disabled = !isCbb;

  // Stop any polling when switching sports (MLB polling can be added later)
  setPollingMode("off");

  loadGames(null, false);
}

function wireTabs() {
  $("tabCbb")?.addEventListener("click", () => setSport("cbb"));
  $("tabMlb")?.addEventListener("click", () => setSport("mlb"));
}

// =====================================================
// Conference tiers (Hi-major / Mid-major)
// =====================================================
// IMPORTANT: backend returns g.away_conf / g.home_conf as objects: {id, name, short}

const HI_MAJOR_SHORTS = new Set(["ACC", "Big 12", "Big East", "Big Ten", "SEC"]);

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
  const count = $("countLine");
  if (tbl) tbl.style.display = "none";
  if (tbody) tbody.innerHTML = "";
  if (count) count.textContent = "";
}

// =====================================================
// Polling: live (5s) + idle (60s), silent refresh
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
    return setInterval(() => {
      const cur = yyyymmddFromDateInput($("datePicker")?.value || "");
      loadGames(cur, true); // silent refresh
    }, ms);
  };

  if (mode === "live") {
    state.timers.livePollTimer = poll(5000);
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

// =====================================================
// Live-first sorting helpers
// =====================================================
function isLiveGame(g) {
  return String(g.status_state || "").toLowerCase() === "in" || g.status === "live";
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
      mainText = g.score || "Final";
    } else if (g.status === "live") {
      stateCls = "live";
      statusText = "LIVE";
      mainText = fmtPred(g);
    } else if (String(g.status_state || "").toLowerCase() === "post") {
      stateCls = "final";
      statusText = "Final";
      mainText = g.score || fmtPred(g);
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
      time.textContent = formatLocalTime(g.start_utc);

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

    const sub = document.createElement("div");
    sub.className = "sub";
    if (stateCls === "upcoming") sub.textContent = "KenPom prediction";
    else if (stateCls === "live") sub.textContent = "Live game";
    else sub.textContent = "";

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

    card.appendChild(matchup);
    card.appendChild(status);
    card.appendChild(main);
    card.appendChild(sub);
    card.appendChild(footer);

    board.appendChild(card);
  }

  board.style.display = "grid";

  const tbl = $("tbl");
  if (tbl) tbl.style.display = "none";
}

// MLB cards (reuses .game-card styling)
function renderMlbCards(games) {
  const board = $("cardBoard");
  if (!board) return;

  const sorted = [...(games || [])].sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")));
  board.innerHTML = "";

  if (!sorted.length) {
    board.innerHTML = `<div class="muted">No MLB games for this date.</div>`;
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
    matchup.textContent = `${away} @ ${home}`;

    const status = document.createElement("div");
    status.className = "status";

    if (g.state === "post" && g.away?.score != null && g.home?.score != null) {
      status.textContent = "Final";
    } else {
      status.textContent = formatLocalTime(g.startTime) || (g.status || "Scheduled");
    }

    const main = document.createElement("div");
    main.className = "main";
    if (g.state === "post" && g.away?.score != null && g.home?.score != null) {
      main.textContent = `${away} ${g.away.score} – ${home} ${g.home.score}`;
    } else {
      main.textContent = g.status || "Scheduled";
    }

    card.appendChild(matchup);
    card.appendChild(status);
    card.appendChild(main);

    board.appendChild(card);
  }

  board.style.display = "grid";

  const tbl = $("tbl");
  if (tbl) tbl.style.display = "none";
}

function buildNetworkOptions() {
  const sel = $("networkFilter");
  if (!sel) return;

  const current = sel.value;

  const set = new Set();
  for (const g of state.games) {
    const n = (g.network || "").trim();
    if (n) set.add(n);
  }

  const networks = Array.from(set).sort((a, b) => a.localeCompare(b));

  sel.innerHTML = '<option value="">All networks</option>';
  for (const n of networks) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  }

  if (current) sel.value = current;
}

// =====================================================
// Conference dropdown (Hi/Mid + conferences present that day)
// Requires: <select id="confFilter"></select> in HTML (safe no-op if missing)
// =====================================================
function buildConferenceOptions() {
  const sel = $("confFilter");
  if (!sel) return;

  const prev = state.filters.confChoice || "";

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
  const q = state.filters.qText.trim().toLowerCase();
  const minT = Number(state.filters.minThrill) || 0;
  const confChoice = String(state.filters.confChoice || "");

  return games.filter((g) => {
    if (state.filters.hideEspnPlus && (g.network || "").toUpperCase().includes("ESPN+")) return false;
    if (state.filters.networkChoice && (g.network || "") !== state.filters.networkChoice) return false;

    if (minT > 0) {
      const t = Number(g.kp_thrill);
      if (!Number.isFinite(t) || t < minT) return false;
    }

    // Conf filter
    if (confChoice) {
      if (confChoice === "hi") {
        if (!gameIsHighMajor(g)) return false;
      } else if (confChoice === "mid") {
        if (!gameIsMidMajor(g)) return false;
      } else if (confChoice.startsWith("conf:")) {
        const idWanted = confChoice.slice(5);
        if (!gameInConferenceId(g, idWanted)) return false;
      }
    }

    if (q) {
      const hay = `${g.away || ""} ${g.home || ""} ${g.network || ""} ${fmtPred(g)}`.toLowerCase();
      if (!hay.includes(q)) return false;
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
  $("q")?.addEventListener("input", (e) => {
    state.filters.qText = e.target.value || "";
    applySortAndRender();
  });

  $("minThrill")?.addEventListener("change", (e) => {
    state.filters.minThrill = Number(e.target.value) || 0;
    applySortAndRender();
  });

  $("networkFilter")?.addEventListener("change", (e) => {
    state.filters.networkChoice = e.target.value || "";
    applySortAndRender();
  });

  $("hideEspnPlus")?.addEventListener("change", (e) => {
    state.filters.hideEspnPlus = !!e.target.checked;
    applySortAndRender();
  });

  $("confFilter")?.addEventListener("change", (e) => {
    const v = e.target.value || "";
    if (v === "__sep__") return;
    state.filters.confChoice = v;
    applySortAndRender();
  });

  $("clearFilters")?.addEventListener("click", () => {
    state.filters.qText = "";
    state.filters.minThrill = 0;
    state.filters.networkChoice = "";
    state.filters.hideEspnPlus = false;
    state.filters.confChoice = "";

    if ($("q")) $("q").value = "";
    if ($("minThrill")) $("minThrill").value = "0";
    if ($("networkFilter")) $("networkFilter").value = "";
    if ($("hideEspnPlus")) $("hideEspnPlus").checked = false;
    if ($("confFilter")) $("confFilter").value = "";

    applySortAndRender();
  });

  $("reloadBtn")?.addEventListener("click", () => loadGames());

  $("datePicker")?.addEventListener("change", (e) => {
    const yyyymmdd = yyyymmddFromDateInput(e.target.value);
    loadGames(yyyymmdd);
  });

  $("prevDayBtn")?.addEventListener("click", () => {
    const cur = yyyymmddFromDateInput($("datePicker")?.value || "");
    loadGames(addDaysToYYYYMMDD(cur, -1));
  });

  $("nextDayBtn")?.addEventListener("click", () => {
    const cur = yyyymmddFromDateInput($("datePicker")?.value || "");
    loadGames(addDaysToYYYYMMDD(cur, 1));
  });
}

// =====================================================
// Fetch helpers
// =====================================================
async function fetchEspnUrls(date_espn) {
  try {
    const resp = await fetch(`/urls/espn?date_espn=${date_espn}`);
    const data = await resp.json();
    return (resp.ok && data.urls_by_event_id) ? data.urls_by_event_id : {};
  } catch {
    return {};
  }
}

async function fetchGames(date_espn, date_kp) {
  const url = `/games?date_espn=${date_espn}&date_kp=${date_kp}`;
  const resp = await fetch(url);
  const data = await resp.json();
  return { resp, data };
}

async function fetchMlbGames(date_yyyymmdd) {
  const resp = await fetch(`/mlb/games?date=${date_yyyymmdd}`);
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
    const pickerVal = $("datePicker")?.value || "";
    yyyymmdd = pickerVal ? yyyymmddFromDateInput(pickerVal) : null;
  }
  if (!yyyymmdd) {
    const { yyyy, mm, dd } = todayParts();
    yyyymmdd = `${yyyy}${mm}${dd}`;
  }

  const date_kp = isoFromYYYYMMDD(yyyymmdd);
  const date_espn = yyyymmdd;

  if ($("datePicker")) $("datePicker").value = date_kp;

  // ---------------------------
  // MLB
  // ---------------------------
  if (state.sport === "mlb") {
    state.urlsByEventId = {};

    let resp, data;
    try {
      ({ resp, data } = await fetchMlbGames(date_espn));
    } catch (e) {
      showError(`Failed to load MLB games\n${e}`);
      return;
    }

    if (!resp.ok) {
      showError(JSON.stringify(data, null, 2));
      return;
    }

    state.mlbGames = data.games || [];

    // MLB doesn't use your KP-based future mode styling
    document.documentElement.classList.remove("future");
    setPollingMode("off");

    updateCountLine(state.mlbGames.length, state.mlbGames.length);
    renderMlbCards(state.mlbGames);
    setLastUpdatedNow();
    return;
  }

  // ---------------------------
  // CBB (existing behavior)
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

  state.games = data.games || [];

  // Future date mode (drives future-day rendering + CSS)
  const isFuture = data.mode === "future";
  document.documentElement.classList.toggle("future", isFuture);

  const hasLive = state.games.some((g) => String(g.status_state || "").toLowerCase() === "in" || g.status === "live");
  const isToday = ($("datePicker")?.value || "") === todayIsoLocal();
  setPollingMode(!isFuture && isToday ? (hasLive ? "live" : "idle") : "off");

  buildNetworkOptions();
  buildConferenceOptions();
  applySortAndRender();
  setLastUpdatedNow();
}

// =====================================================
// Boot
// =====================================================
wireTabs();
wireSorting();
wireFilters();
loadGames();
