// =====================================================
// College Basketball Dashboard UI (drop-in replacement)
// Keeps behavior identical; refactored for readability.
// =====================================================

// ---------------------
// DOM helper
// ---------------------
const $ = (id) => document.getElementById(id);

// ---------------------
// App state (single source of truth)
// ---------------------
const state = {
  games: [],
  urlsByEventId: {},

  sort: { key: "time", dir: "asc" }, // default: time asc (thrill tiebreaker desc)

  filters: {
    qText: "",
    minThrill: 0,
    networkChoice: "",
    hideEspnPlus: false,
  },

  timers: {
    livePollTimer: null,
    updatedTimer: null,
    lastUpdatedMs: null,
  },
};

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

function sortGames(games) {
  const { key: sortKey, dir: sortDir } = state.sort;

  // Special: time asc, with thrill desc tiebreaker
  if (sortKey === "time") {
    return [...games].sort((a, b) => {
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
    });
  }

  // Normal: kp/thrill with direction
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

    // Start
    const start = document.createElement("td");
    start.className = "nowrap";
    start.textContent = formatLocalTime(g.start_utc);
    tr.appendChild(start);

    // Matchup (link if we have ESPN URL)
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

    // Network
    const network = document.createElement("td");
    network.className = "network";
    network.textContent = g.network || "";
    tr.appendChild(network);

    // KenPom (or score if live/final)
    const kp = document.createElement("td");
    kp.className = "kp";
    kp.textContent = fmtPred(g);
    tr.appendChild(kp);

    // Thrill
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

function applyFilters(games) {
  const q = state.filters.qText.trim().toLowerCase();
  const minT = Number(state.filters.minThrill) || 0;

  return games.filter((g) => {
    if (state.filters.hideEspnPlus && (g.network || "").toUpperCase().includes("ESPN+")) return false;

    if (state.filters.networkChoice && (g.network || "") !== state.filters.networkChoice) return false;

    if (minT > 0) {
      const t = Number(g.kp_thrill);
      if (!Number.isFinite(t) || t < minT) return false;
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
  renderTable(sortGames(filtered));
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

  $("clearFilters")?.addEventListener("click", () => {
    state.filters.qText = "";
    state.filters.minThrill = 0;
    state.filters.networkChoice = "";
    state.filters.hideEspnPlus = false;

    if ($("q")) $("q").value = "";
    if ($("minThrill")) $("minThrill").value = "0";
    if ($("networkFilter")) $("networkFilter").value = "";
    if ($("hideEspnPlus")) $("hideEspnPlus").checked = false;

    applySortAndRender();
  });

  // Reload
  $("reloadBtn")?.addEventListener("click", () => loadGames());

  // Date picker + prev/next
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

// =====================================================
// Main load function (supports silent refresh)
// =====================================================
async function loadGames(yyyymmdd = null, silent = false) {
  clearError();

  // Only blank UI on non-silent loads (manual reload/date change)
  if (!silent) clearTableForFullLoad();

  // Determine date (fallback to datePicker, then today)
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

  // Keep UI in sync
  if ($("datePicker")) $("datePicker").value = date_kp;

  // URLs + games
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

// Future date mode (hide KP + thrill columns)
const isFuture = data.mode === "future";
document.documentElement.classList.toggle("future", isFuture);

// Poll only when viewing TODAY (local).
// - Live games: 5s
// - No live games: 60s
// - Past / future dates: off
const hasLive = state.games.some(
  (g) => String(g.status_state || "").toLowerCase() === "in"
);

const isToday = ($("datePicker")?.value || "") === todayIsoLocal();

setPollingMode(!isFuture && isToday ? (hasLive ? "live" : "idle") : "off");

buildNetworkOptions();
applySortAndRender();
setLastUpdatedNow();

}

// =====================================================
// Boot
// =====================================================
wireSorting();
wireFilters();
loadGames();
