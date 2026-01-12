const $ = (id) => document.getElementById(id);

  let currentGames = [];
  let sortKey = "time";   // DEFAULT: time first
  let sortDir = "asc";

  // ESPN URL map, fetched from backend /urls/espn
  let urlsByEventId = {};

  // Live polling (only while any game is live)
  let livePollTimer = null;

  function setLivePolling(enabled) {
    if (enabled) {
      if (livePollTimer) return;
      livePollTimer = setInterval(() => {
        const cur = yyyymmddFromDateInput($("datePicker").value);
        // ✅ silent refresh so table doesn't blank
        loadGames(cur, true);
      }, 5000); // 5 seconds
    } else {
      if (livePollTimer) clearInterval(livePollTimer);
      livePollTimer = null;
    }
  }

  // Filter state
  let qText = "";
  let minThrill = 0;
  let networkChoice = "";
  let hideEspnPlus = false;

  // Updated-ago ticker (frontend-only)
  let lastUpdatedMs = null;
  let updatedTimer = null;

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
    lastUpdatedMs = Date.now();
    const el = $("updatedAgo");
    if (!el) return;

    if (updatedTimer) clearInterval(updatedTimer);
    el.textContent = "0s";

    updatedTimer = setInterval(() => {
      el.textContent = formatAgo(Date.now() - lastUpdatedMs);
    }, 1000);
  }

  // ---- Null-safe formatters ----
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

  function yyyymmddFromDateInput(value) {
    return (value || "").replaceAll("-", "");
  }

  function addDaysToYYYYMMDD(yyyymmdd, deltaDays) {
    const yyyy = Number(yyyymmdd.slice(0,4));
    const mm = Number(yyyymmdd.slice(4,6));
    const dd = Number(yyyymmdd.slice(6,8));
    const d = new Date(yyyy, mm - 1, dd);
    d.setDate(d.getDate() + deltaDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${day}`;
  }

  function isoFromYYYYMMDD(yyyymmdd) {
    return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
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
    const state = String(g.status_state || "").toLowerCase();

    // Live or final: show ESPN score + status detail
    if (state === "in" || state === "post") {
      const a = (g.away_score === null || g.away_score === undefined) ? "—" : String(g.away_score);
      const h = (g.home_score === null || g.home_score === undefined) ? "—" : String(g.home_score);
      const detail = String(g.status_detail || "").trim();
      return detail ? (a + "-" + h + " (" + detail + ")") : (a + "-" + h);
    }

    // KenPom prediction (pregame)
    if (g.kp_home_pred == null || g.kp_away_pred == null || g.kp_home_wp == null) {
      return "—";
    }

    const homeWP = Number(g.kp_home_wp);
    const awayWP = 100 - homeWP;

    if (homeWP >= 50) {
      return String(g.home) + " " + String(g.kp_home_pred) + "-" + String(g.kp_away_pred) + " (" + fmtPct(homeWP, 0) + ")";
    }

    return String(g.away) + " " + String(g.kp_away_pred) + "-" + String(g.kp_home_pred) + " (" + fmtPct(awayWP, 0) + ")";
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

      const eventId = String(g.event_id || "");
      const href = urlsByEventId[eventId] || "";

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

      $("tbody").appendChild(tr);
    }

    $("tbl").style.display = "table";
  }

  function buildNetworkOptions() {
    const sel = $("networkFilter");
    const current = sel.value;

    const set = new Set();
    for (const g of currentGames) {
      const n = (g.network || "").trim();
      if (n) set.add(n);
    }
    const networks = Array.from(set).sort((a,b) => a.localeCompare(b));

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
    const q = qText.trim().toLowerCase();
    const minT = Number(minThrill) || 0;

    return games.filter((g) => {
      if (hideEspnPlus && (g.network || "").toUpperCase().includes("ESPN+")) return false;

      if (networkChoice && (g.network || "") !== networkChoice) return false;

      if (minT > 0) {
        const t = Number(g.kp_thrill);
        if (!Number.isFinite(t) || t < minT) return false;
      }

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

    $("clearFilters").addEventListener("click", () => {
      qText = "";
      minThrill = 0;
      networkChoice = "";
      hideEspnPlus = false;

      $("q").value = "";
      $("minThrill").value = "0";
      $("networkFilter").value = "";
      $("hideEspnPlus").checked = false;

      applySortAndRender();
    });

    // Reload button
    $("reloadBtn").addEventListener("click", () => loadGames());

    // Date picker + prev/next
    $("datePicker").addEventListener("change", (e) => {
      const yyyymmdd = yyyymmddFromDateInput(e.target.value);
      loadGames(yyyymmdd);
    });

    $("prevDayBtn").addEventListener("click", () => {
      const cur = yyyymmddFromDateInput($("datePicker").value);
      loadGames(addDaysToYYYYMMDD(cur, -1));
    });

    $("nextDayBtn").addEventListener("click", () => {
      const cur = yyyymmddFromDateInput($("datePicker").value);
      loadGames(addDaysToYYYYMMDD(cur, 1));
    });
  }

  // ✅ Updated: silent polling support
  async function loadGames(yyyymmdd = null, silent = false) {
    $("error").style.display = "none";
    $("error").textContent = "";

    // ✅ only blank UI on non-silent loads (manual reload/date change)
    if (!silent) {
      $("tbl").style.display = "none";
      $("tbody").innerHTML = "";
      $("countLine").textContent = "";
    }

    // Default to datePicker value; if empty, default to today
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

    // keep UI in sync (date picker still drives the view)
    $("datePicker").value = date_kp;

    // Fetch ESPN urls
    try {
      const urlResp = await fetch(`/urls/espn?date_espn=${date_espn}`);
      const urlData = await urlResp.json();
      urlsByEventId = (urlResp.ok && urlData.urls_by_event_id) ? urlData.urls_by_event_id : {};
    } catch (e) {
      urlsByEventId = {};
    }

    const url = `/games?date_espn=${date_espn}&date_kp=${date_kp}`;

    let resp, data;
    try {
      resp = await fetch(url);
      data = await resp.json();
    } catch (e) {
      $("error").style.display = "block";
      $("error").textContent = `Failed to load games\n${e}`;
      return;
    }

    if (!resp.ok) {
      $("error").style.display = "block";
      $("error").textContent = JSON.stringify(data, null, 2);
      return;
    }

    currentGames = data.games || [];

    const hasLive = currentGames.some(g => String(g.status_state || "").toLowerCase() === "in");
    setLivePolling(hasLive);

    // ---------- Future date UI mode ----------
    const isFuture = (data.mode === "future");
    document.documentElement.classList.toggle("future", isFuture);

    buildNetworkOptions();
    applySortAndRender();

    // IMPORTANT: only after successful render
    setLastUpdatedNow();
  }

  // only calls at bottom
  wireSorting();
  wireFilters();
  loadGames();