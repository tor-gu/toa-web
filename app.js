/* Tournament of Albums — the standings app.
   Loaded at the end of <body> in index.html (not deferred: it runs before
   theme.js, as it did when it was inline). Reads window.TOA_API_BASE_URL from
   api.js and expects Chart.js on the page. */
"use strict";

const RANK_COLORS = ['#FF3D7F', '#1EC8E0', '#7C3AED', '#FFB400'];
function formatRank(rank) {
  if (rank == null) return "–";
  return Number.isInteger(rank) ? String(rank) : rank.toFixed(1);
}
function rankColor(rank) {
  if (rank == null) return "var(--ink-soft)";
  return RANK_COLORS[Math.floor(rank - 1) % RANK_COLORS.length];
}
const API_BASE_URL = window.TOA_API_BASE_URL;
const BASE_TITLE = "Tournament of Albums — Official Standings";
const COLORS = [
  { border: "#FF3D7F", bg: "rgba(255,61,127,0.12)" },
  { border: "#1EC8E0", bg: "rgba(30,200,224,0.12)" },
  { border: "#7C3AED", bg: "rgba(124,58,237,0.12)" },
  { border: "#FFB400", bg: "rgba(255,180,0,0.14)" },
  { border: "#34D399", bg: "rgba(52,211,153,0.12)" },
  { border: "#F2552C", bg: "rgba(242,85,44,0.12)" },
];

// Cached across navigations
let allScores = [], scoresById = {}, albumDataCache = {}, albumNames = {}, matchResultCache = {};
// Landing view state
let currentFilter = "", currentSort = { col: null, dir: "asc" };
// Album view state — reset when the focal album changes
let focalAlbumId = null, activeAlbumIds = new Set(), albumColorMap = {};
let usedColorIndices = new Set(), pendingFetches = 0, activeChart = null;

function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function albumHref(id) { return `/album/${encodeURIComponent(id)}`; }

/* ── Router ─────────────────────────────────────────────────
   Real paths, not a #fragment: these URLs are shared, linked from the Atom
   feed, and crawled, so they have to mean something to anything that doesn't
   run JS. CloudFront serves index.html for them — see
   toa-terraform/modules/toa-web/router.js, which must know the same prefixes
   this table does. */

const ROUTES = [
  [/^\/album\/([0-9a-f]+)\/?$/i, id => showAlbumView(id)],
];

function route() {
  for (const [re, handler] of ROUTES) {
    const m = location.pathname.match(re);
    if (m) { handler(m[1]); return; }
  }
  showLanding();
}

/* Keeps the query string: the ?api= override lives there, and dropping it on
   the first in-app navigation would quietly send a test session back to the
   prod API with no visible sign. */
function navigate(href) {
  history.pushState({}, "", href + location.search);
  route();
}

function isRoutedPath(pathname) {
  return pathname === "/" || ROUTES.some(([re]) => re.test(pathname));
}

/* Bailing out on modifier keys, non-primary buttons and target/download is
   what keeps cmd-click, middle-click and "open in new tab" behaving like
   ordinary links. Anything not in the route table (e.g. /viz.html) is left
   alone and does a real page load. */
document.addEventListener("click", e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a");
  if (!a || a.target || a.hasAttribute("download") || a.origin !== location.origin) return;
  if (!isRoutedPath(a.pathname)) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

function showLanding() {
  document.getElementById("view-album").style.display = "none";
  document.getElementById("view-landing").style.display = "block";
  document.title = BASE_TITLE;
}

function showAlbumView(albumId) {
  document.getElementById("view-landing").style.display = "none";
  document.getElementById("view-album").style.display = "block";
  const artistEl = document.getElementById("album-artist");
  const titleEl = document.getElementById("album-title");
  const meta = scoresById[albumId];
  if (!meta) {
    resetComparison();
    focalAlbumId = null;
    artistEl.textContent = "";
    titleEl.textContent = "Album not found";
    document.title = "Album not found · Tournament of Albums";
    document.getElementById("history-status").textContent = "No album with this id is on record.";
    document.getElementById("history-status").className = "error";
    document.getElementById("history-canvas-wrap").style.display = "none";
    return;
  }
  artistEl.textContent = meta.artist;
  titleEl.textContent = meta.album;
  document.title = `${meta.artist} — ${meta.album} · Tournament of Albums`;
  if (focalAlbumId !== albumId) {
    resetComparison();
    focalAlbumId = albumId;
  }
  if (!activeAlbumIds.has(albumId)) {
    albumNames[albumId] = { artist: meta.artist, albumName: meta.album, shortName: meta["short-name"] };
    activeAlbumIds.add(albumId); assignColor(albumId); renderChips();
  }
  if (!albumDataCache[albumId]) renderMatchPane();
  addAlbum(albumId, meta.artist, meta.album, meta["short-name"]);
  window.scrollTo(0, 0);
}

function resetComparison() {
  if (activeChart) { activeChart.destroy(); activeChart = null; }
  activeAlbumIds = new Set(); albumColorMap = {}; usedColorIndices = new Set();
  document.getElementById("history-chips").innerHTML = "";
  document.getElementById("match-list").innerHTML = "";
  document.getElementById("history-status").textContent = "";
  document.getElementById("history-status").className = "";
  document.getElementById("match-status").textContent = "";
  document.getElementById("match-status").className = "";
  document.getElementById("compare-input").value = "";
  closeCompareDropdown();
}

/* ── Landing: rankings table ────────────────────────────── */

function renderTable() {
  const filter = currentFilter.toLowerCase();
  let rows = allScores;
  if (filter) rows = rows.filter(s => s.artist.toLowerCase().includes(filter) || s.album.toLowerCase().includes(filter));
  if (currentSort.col) {
    const { col, dir } = currentSort;
    rows = [...rows].sort((a, b) => {
      if (col === "rank") {
        const av = a.rank ?? Infinity, bv = b.rank ?? Infinity;
        return dir === "asc" ? av - bv : bv - av;
      }
      const av = col === "artist" ? a.artist : a.album; const bv = col === "artist" ? b.artist : b.album;
      return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }
  document.querySelector("#content tbody").innerHTML = rows.map(s => `
    <tr class="clickable-row" data-album-id="${esc(s.id)}">
      <td class="rank"><span style="background:${rankColor(s.rank)}">${formatRank(s.rank)}</span></td>
      <td>${esc(s.artist)}</td>
      <td><a class="album-link" href="${albumHref(s.id)}">${esc(s.album)}</a></td>
      <td class="score">${s.score.toFixed(3)}</td>
    </tr>`).join("");
  document.querySelectorAll("#content th[data-col]").forEach(th => {
    const ind = th.querySelector(".sort-indicator");
    if (th.dataset.col === currentSort.col) { th.classList.add("sort-active"); ind.textContent = currentSort.dir === "asc" ? "↑" : "↓"; }
    else { th.classList.remove("sort-active"); ind.textContent = "↕"; }
  });
}

/* ── Album view: score chart + comparison ───────────────── */

function assignColor(id) {
  if (albumColorMap[id] !== undefined) return;
  for (let i = 0; i < COLORS.length; i++) { if (!usedColorIndices.has(i)) { albumColorMap[id] = i; usedColorIndices.add(i); return; } }
  albumColorMap[id] = Object.keys(albumColorMap).length % COLORS.length;
}
function releaseColor(id) { if (albumColorMap[id] !== undefined) { usedColorIndices.delete(albumColorMap[id]); delete albumColorMap[id]; } }

function renderChips() {
  const c = document.getElementById("history-chips");
  c.innerHTML = [...activeAlbumIds].map(id => {
    const { shortName, albumName, artist } = albumNames[id] || {};
    const color = COLORS[albumColorMap[id] ?? 0].border;
    const ttl = artist && albumName ? `${artist} — ${albumName}` : (albumName || id);
    const remove = id === focalAlbumId ? "" : `<button class="chip-remove" data-album-id="${esc(id)}" aria-label="Remove from chart">×</button>`;
    return `<span class="album-chip" title="${esc(ttl)}"><span class="chip-dot" style="background:${color}"></span>${esc(shortName||albumName||id)}${remove}</span>`;
  }).join("");
  c.querySelectorAll(".chip-remove").forEach(btn => btn.addEventListener("click", () => removeAlbum(btn.dataset.albumId)));
}

function addCompare(id, artist, albumName, shortName) {
  if (activeAlbumIds.has(id)) return;
  const status = document.getElementById("history-status");
  if (activeAlbumIds.size >= COLORS.length) {
    status.textContent = `Chart is full (${COLORS.length} albums max) — remove one first.`;
    status.className = "";
    return;
  }
  albumNames[id] = { artist, albumName, shortName };
  activeAlbumIds.add(id); assignColor(id); renderChips();
  addAlbum(id, artist, albumName, shortName);
}

async function addAlbum(albumId, artist, albumName, shortName) {
  const status = document.getElementById("history-status");
  const wrap = document.getElementById("history-canvas-wrap");
  if (!albumDataCache[albumId]) {
    pendingFetches++; status.textContent = "Loading…"; status.className = ""; wrap.style.display = "none";
    try {
      const [histRes, matchRes] = await Promise.all([
        fetch(`${API_BASE_URL}/score-history/${encodeURIComponent(albumId)}`),
        fetch(`${API_BASE_URL}/match-history/${encodeURIComponent(albumId)}`),
      ]);
      if (histRes.status === 404) throw new Error("No history found for this album.");
      if (!histRes.ok) throw new Error(`HTTP ${histRes.status}`);
      const data = await histRes.json();
      const matchList = matchRes.ok ? (await matchRes.json()).matches : [];
      const matchByDate = {}; for (const m of matchList) matchByDate[m.date] = true;
      const resolvedShortName = data.album?.['short-name'] || shortName || albumName;
      albumNames[albumId] = { artist, albumName, shortName: resolvedShortName };
      albumDataCache[albumId] = { artist, albumName, shortName: resolvedShortName, history: data.history, matchByDate, matchList };
    } catch (e) {
      activeAlbumIds.delete(albumId); releaseColor(albumId);
      status.textContent = `Failed to load history: ${e.message}`; status.className = "error";
      pendingFetches--; renderChips();
      if (albumId === focalAlbumId) {
        const matchStatus = document.getElementById("match-status");
        matchStatus.textContent = "Match history unavailable."; matchStatus.className = "error";
      }
      if (activeAlbumIds.size > 0) rebuildChart();
      return;
    }
    pendingFetches--;
  }
  rebuildChart(); if (albumId === focalAlbumId) renderMatchPane();
}

function removeAlbum(albumId) {
  if (albumId === focalAlbumId) return;
  activeAlbumIds.delete(albumId); releaseColor(albumId);
  renderChips(); rebuildChart();
}

function rebuildChart() {
  const status = document.getElementById("history-status");
  const wrap = document.getElementById("history-canvas-wrap");
  const canvas = document.getElementById("history-canvas");
  if (activeChart) { activeChart.destroy(); activeChart = null; }
  if (activeAlbumIds.size === 0) return;
  const ready = [...activeAlbumIds].filter(id => albumDataCache[id]);
  if (ready.length === 0) return;
  const allDates = [...new Set(ready.flatMap(id => albumDataCache[id].history.map(h => h.date)))].sort();
  const datasets = ready.map(id => {
    const { albumName, shortName, history, matchByDate } = albumDataCache[id];
    const scoreByDate = Object.fromEntries(history.map(h => [h.date, h.score]));
    const color = COLORS[albumColorMap[id] ?? 0];
    return { label: shortName||albumName, data: allDates.map(d => scoreByDate[d] ?? null), borderColor: color.border, backgroundColor: color.bg, tension: 0.2, spanGaps: true, pointStyle: ctx => matchByDate[allDates[ctx.dataIndex]] ? 'rectRot' : 'circle', pointBackgroundColor: color.border, pointRadius: ctx => matchByDate[allDates[ctx.dataIndex]] ? 6 : 0, pointHoverRadius: ctx => matchByDate[allDates[ctx.dataIndex]] ? 8 : 4, yAxisID: "yScore", _matchByDate: matchByDate };
  });
  if (pendingFetches === 0) { status.textContent = ""; wrap.style.display = "block"; }
  renderChips();
  activeChart = new Chart(canvas, {
    type: "line", data: { labels: allDates, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#FFFFFF', borderColor: '#1A1A2E', borderWidth: 2, titleColor: '#7C3AED', bodyColor: '#1A1A2E', padding: 10 } },
      scales: {
        x: { ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 10, color: '#5A5A72', font: { family: "'Poppins', sans-serif", size: 11 } }, grid: { color: 'rgba(26,26,46,0.07)' }, border: { color: 'rgba(26,26,46,0.15)' } },
        yScore: { type: "linear", position: "left", min: -1.5, max: 1.5, title: { display: true, text: "Score", color: '#5A5A72', font: { family: "'Poppins', sans-serif", size: 11 } }, ticks: { color: '#5A5A72', font: { family: "'Poppins', sans-serif", size: 11 } }, grid: { color: 'rgba(26,26,46,0.07)' }, border: { color: 'rgba(26,26,46,0.15)' } },
      },
    },
  });
}

/* ── Compare search box ─────────────────────────────────── */

let compareResults = [], compareActiveIdx = -1;

function closeCompareDropdown() {
  document.getElementById("compare-dropdown").style.display = "none";
  compareResults = []; compareActiveIdx = -1;
}

function renderCompareDropdown() {
  const dd = document.getElementById("compare-dropdown");
  if (compareResults.length === 0) { closeCompareDropdown(); return; }
  dd.innerHTML = compareResults.map((s, i) => `
    <li class="${i === compareActiveIdx ? "active" : ""}" data-idx="${i}">${esc(s.artist)} — ${esc(s.album)}</li>`).join("");
  dd.style.display = "block";
  dd.querySelectorAll("li").forEach(li => {
    li.addEventListener("mousedown", e => { e.preventDefault(); pickCompare(Number(li.dataset.idx)); });
  });
}

function pickCompare(idx) {
  const s = compareResults[idx]; if (!s) return;
  addCompare(s.id, s.artist, s.album, s["short-name"]);
  document.getElementById("compare-input").value = "";
  closeCompareDropdown();
}

function initCompareBox() {
  const input = document.getElementById("compare-input");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { closeCompareDropdown(); return; }
    compareResults = allScores
      .filter(s => !activeAlbumIds.has(s.id) && (s.artist.toLowerCase().includes(q) || s.album.toLowerCase().includes(q)))
      .slice(0, 8);
    compareActiveIdx = compareResults.length ? 0 : -1;
    renderCompareDropdown();
  });
  input.addEventListener("keydown", e => {
    if (compareResults.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); compareActiveIdx = (compareActiveIdx + 1) % compareResults.length; renderCompareDropdown(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); compareActiveIdx = (compareActiveIdx - 1 + compareResults.length) % compareResults.length; renderCompareDropdown(); }
    else if (e.key === "Enter") { e.preventDefault(); pickCompare(compareActiveIdx); }
    else if (e.key === "Escape") { closeCompareDropdown(); }
  });
  input.addEventListener("blur", closeCompareDropdown);
}

/* ── Match history ──────────────────────────────────────── */

function renderMatchPane() {
  const listEl = document.getElementById("match-list");
  const statusEl = document.getElementById("match-status");
  if (!focalAlbumId || !albumDataCache[focalAlbumId]) { listEl.innerHTML = ""; statusEl.textContent = focalAlbumId ? "Loading…" : ""; return; }
  const { matchList } = albumDataCache[focalAlbumId];
  statusEl.textContent = ""; statusEl.className = "";
  if (!matchList || matchList.length === 0) { listEl.innerHTML = ""; statusEl.textContent = "No matches on record."; return; }
  const sorted = [...matchList].reverse();
  listEl.innerHTML = sorted.map(({ match_id, date }) => `
    <div class="match-row" data-match-id="${esc(match_id)}">
      <button class="match-toggle"><span>${esc(date)}</span><span class="match-arrow">&#9658;</span></button>
      <div class="match-detail"></div>
    </div>`).join("");
  listEl.querySelectorAll(".match-row").forEach(row => {
    const matchId = row.dataset.matchId; const btn = row.querySelector(".match-toggle"); const det = row.querySelector(".match-detail");
    btn.addEventListener("click", () => toggleMatchRow(matchId, btn, det, { compare: true }));
  });
  const first = listEl.querySelector(".match-row");
  if (first) toggleMatchRow(first.dataset.matchId, first.querySelector(".match-toggle"), first.querySelector(".match-detail"), { compare: true });
}

async function toggleMatchRow(matchId, btn, det, opts = {}) {
  const isOpen = btn.classList.contains("open");
  if (isOpen) { btn.classList.remove("open"); det.classList.remove("open"); return; }
  btn.classList.add("open"); det.classList.add("open");
  if (matchResultCache[matchId]) { renderMatchDetail(matchId, det, opts); return; }
  det.textContent = "Loading…";
  try {
    const res = await fetch(`${API_BASE_URL}/results/${encodeURIComponent(matchId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    matchResultCache[matchId] = (await res.json()).ranking; renderMatchDetail(matchId, det, opts);
  } catch (e) { det.textContent = `Error: ${e.message}`; }
}

function formatDelta(item) {
  if (item.is_new) return "New";
  if (item.score_delta == null) return "–";
  if (item.score_delta === 0) return "0.000";
  const icon = item.score_delta > 0 ? "▲" : "▼";
  return `${icon} ${Math.abs(item.score_delta).toFixed(3)}`;
}

function deltaClass(item) {
  if (item.is_new) return "new";
  if (item.score_delta == null) return "flat";
  return item.score_delta > 0 ? "up" : item.score_delta < 0 ? "down" : "flat";
}

function renderMatchDetail(matchId, det, opts = {}) {
  det.innerHTML = (matchResultCache[matchId] || []).map(item => `
    <div class="ranking-item${opts.compare && item.id === focalAlbumId ? " focal" : ""}">
      <span class="ranking-num">${item.rank}.</span>
      <a class="ranking-album-link" href="${albumHref(item.id)}">${esc(item.artist)} — ${esc(item.album)}</a>
      ${opts.compare && item.id !== focalAlbumId ? `<button class="compare-add" title="Add to chart" aria-label="Add ${esc(item.album)} to chart" data-id="${esc(item.id)}" data-artist="${esc(item.artist)}" data-album="${esc(item.album)}" data-short="${esc(item['short-name']||'')}">+</button>` : ""}
      ${opts.showDelta ? `<span class="ranking-delta ${deltaClass(item)}">${formatDelta(item)}</span>` : ""}
    </div>`).join("");
  det.querySelectorAll(".compare-add").forEach(b => {
    b.addEventListener("click", () => {
      const { id, artist, album: albumName, short: shortName } = b.dataset;
      addCompare(id, artist, albumName, shortName);
    });
  });
}

/* ── Landing: recent matches ────────────────────────────── */

function renderRecentMatches(matches) {
  const listEl = document.getElementById("recent-matches-list");
  listEl.innerHTML = matches.map(({ match_id, date }) => `
    <div class="match-row" data-match-id="${esc(match_id)}">
      <button class="match-toggle"><span>${esc(date)}</span><span class="match-arrow">&#9658;</span></button>
      <div class="match-detail"></div>
    </div>`).join("");
  listEl.querySelectorAll(".match-row").forEach(row => {
    const matchId = row.dataset.matchId; const btn = row.querySelector(".match-toggle"); const det = row.querySelector(".match-detail");
    btn.addEventListener("click", () => toggleMatchRow(matchId, btn, det, { showDelta: true }));
  });
  const first = listEl.querySelector(".match-row");
  if (first) toggleMatchRow(first.dataset.matchId, first.querySelector(".match-toggle"), first.querySelector(".match-detail"), { showDelta: true });
}

async function loadRecentMatches() {
  const statusEl = document.getElementById("recent-matches-status");
  statusEl.textContent = "Loading…";
  try {
    const res = await fetch(`${API_BASE_URL}/results?sort=-date&limit=5`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { matches } = await res.json();
    statusEl.textContent = "";
    if (!matches || matches.length === 0) { statusEl.textContent = "No matches on record."; return; }
    renderRecentMatches(matches);
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
}

/* ── Startup ────────────────────────────────────────────── */

async function load() {
  document.getElementById("content").innerHTML = '<p id="loading">Loading…</p>';
  try {
    const res = await fetch(`${API_BASE_URL}/scores`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    document.getElementById("date").textContent = `MOST RECENT MATCH: ${data.date}`;
    allScores = [...data.scores].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    scoresById = Object.fromEntries(allScores.map(s => [s.id, s]));
    document.getElementById("content").innerHTML = `
      <table>
        <thead><tr>
          <th class="sortable" data-col="rank">Rank <span class="sort-indicator">↕</span></th>
          <th class="sortable" data-col="artist">Artist <span class="sort-indicator">↕</span></th>
          <th class="sortable" data-col="album">Album <span class="sort-indicator">↕</span></th>
          <th>Score</th>
        </tr></thead>
        <tbody></tbody>
      </table>`;
    renderTable();
    document.querySelector("#content tbody").addEventListener("click", e => {
      if (e.target.closest("a")) return;
      const row = e.target.closest("tr[data-album-id]"); if (!row) return;
      navigate(albumHref(row.dataset.albumId));
    });
    document.querySelectorAll("#content th[data-col]").forEach(th => {
      th.addEventListener("click", () => {
        const col = th.dataset.col;
        currentSort = currentSort.col === col ? { col, dir: currentSort.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" };
        renderTable();
      });
    });
    document.getElementById("search").addEventListener("input", e => { currentFilter = e.target.value; renderTable(); });
  } catch (e) {
    document.getElementById("content").innerHTML = `<div id="error">Scoreboards Unavailable — ${esc(e.message)}</div>`;
  }
  route();
}

window.addEventListener("popstate", route);
initCompareBox();
load();
loadRecentMatches();
