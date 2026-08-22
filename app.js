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
function formatScore(score) {
  return score == null ? "–" : score.toFixed(3);
}
function rankColor(rank) {
  if (rank == null) return "var(--ink-soft)";
  return RANK_COLORS[Math.floor(rank - 1) % RANK_COLORS.length];
}
/* The match view's own badge colour, returning the same entry its chart line
   uses so the two can never drift apart — which is what lets the table stand in
   for the chart's legend. It is a 6-cycle rather than rankColor's 4 because
   matches are 4-5 albums, so within one match no colour repeats. The landing
   table keeps rankColor: 100+ rows make any cycle decoration, not identity. */
function matchRankColor(rank) {
  return COLORS[(Math.max(1, Math.floor(rank || 1)) - 1) % COLORS.length];
}
const API_BASE_URL = window.TOA_API_BASE_URL;
const BASE_TITLE = "Tournament of Albums";
const pageTitle = (subtitle) => (subtitle ? `${BASE_TITLE} — ${subtitle}` : BASE_TITLE);
const COLORS = [
  { border: "#FF3D7F", bg: "rgba(255,61,127,0.12)" },
  { border: "#1EC8E0", bg: "rgba(30,200,224,0.12)" },
  { border: "#7C3AED", bg: "rgba(124,58,237,0.12)" },
  { border: "#FFB400", bg: "rgba(255,180,0,0.14)" },
  { border: "#34D399", bg: "rgba(52,211,153,0.12)" },
  { border: "#F2552C", bg: "rgba(242,85,44,0.12)" },
];

// Cached across navigations. matchResultCache holds whole /results/{id} bodies
// ({match_id, date, ranking}) — the accordions want the ranking, the match view
// also wants the date, and both share the fetch. matchFetches holds the in-flight
// promises: the chart tooltip re-fires on every mousemove over one match marker,
// so without it a slow hover would open a request per frame.
let allScores = [], scoresById = {}, albumDataCache = {}, albumNames = {}, matchResultCache = {}, matchFetches = {};
// Whole /score-history/{id} bodies ({album, history}), shared by the album chart
// and the match view — hopping from a match to one of its albums reuses the
// fetch. Deliberately separate from albumDataCache, whose entries are expected
// to carry matchByDate/matchList too; a half-populated one there would make
// renderMatchPane report "No matches on record." for an album that has them.
let scoreHistoryCache = {}, historyFetches = {};
// Landing view state
let currentFilter = "", currentSort = { col: null, dir: "asc" };
// Album view state — reset when the focal album changes
let focalAlbumId = null, activeAlbumIds = new Set(), albumColorMap = {};
let usedColorIndices = new Set(), pendingFetches = 0, activeChart = null;
// Identifies the point the chart tooltip is currently describing, so a /results
// fetch that lands after the cursor has moved on doesn't overwrite it.
let chartHoverKey = null;
// Startup sequencing. route() runs before /scores lands, so an album deep link
// can be dispatched with nothing to name the album yet: it shows a placeholder
// and sets routeDeferred, and load() re-dispatches once. 
// scoresState can be 'ready', 'loading', or 'error'
let scoresState = "loading", routeDeferred = false;

function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function albumHref(id) { return `/album/${encodeURIComponent(id)}`; }
function matchHref(id) { return `/match/${encodeURIComponent(id)}`; }

/* ── Router ─────────────────────────────────────────────────
   Real paths, not a #fragment: these URLs are shared, linked from the Atom
   feed, and crawled, so they have to mean something to anything that doesn't
   run JS. CloudFront serves index.html for them — see
   toa-terraform/modules/toa-web/router.js, which must know the same prefixes
   this table does.*/

const ROUTES = [
  [/^\/album\/([0-9a-f]+)\/?$/i, id => showAlbumView(id)],
  [/^\/match\/([0-9a-f]+)\/?$/i, id => showMatchView(id)],
];

function route() {
  dispatch();
  /* The nav tabs are rendered by theme.js, which has no way to observe a
     pushState. Optional call because theme.js is deferred and this classic
     script runs first on a cold load — theme.js sets the initial state itself. */
  window.TOA_updateActiveTab?.();
}

function dispatch() {
  /* Recomputed by whichever handler runs below, so navigating away during the
     /scores flight cancels load()'s re-dispatch instead of re-running — and
     re-fetching — whatever view replaced it. */
  routeDeferred = false;
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
   ordinary links. Anything not in the route table (e.g. /viz, /about) is left
   alone and does a real page load. */
document.addEventListener("click", e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a");
  if (!a || a.target || a.hasAttribute("download") || a.origin !== location.origin) return;
  if (!isRoutedPath(a.pathname)) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

/* Every view is a pre-existing sibling div toggled by display. Hiding all of
   them by name here, rather than each show* function hiding the others, is what
   keeps a fourth view from silently leaving a third one on screen. */
const VIEW_IDS = ["view-landing", "view-album", "view-match"];

function showView(id) {
  for (const v of VIEW_IDS) document.getElementById(v).style.display = v === id ? "block" : "none";
}

function showLanding() {
  showView("view-landing");
  document.title = pageTitle();
}

function showAlbumView(albumId) {
  showView("view-album");
  const artistEl = document.getElementById("album-artist");
  const titleEl = document.getElementById("album-title");
  const meta = scoresById[albumId];
  if (!meta) {
    resetComparison();
    focalAlbumId = null;
    artistEl.textContent = "";
    document.getElementById("history-canvas-wrap").style.display = "none";
    const status = document.getElementById("history-status");
    /* A deep link that beat /scores here. The id may well be fine — we just have
       no artist/album to print yet, so don't claim it doesn't exist. No
       document.title write: better to leave the document's own title standing
       than flicker through a placeholder. load() re-dispatches when it lands. */
    if (scoresState === "loading") {
      routeDeferred = true;
      titleEl.textContent = "Loading…";
      return;
    }
    if (scoresState === "error") {
      titleEl.textContent = "Standings unavailable";
      status.textContent = "Couldn't load the standings, so this album can't be looked up.";
      status.className = "error";
      return;
    }
    titleEl.textContent = "Album not found";
    document.title = pageTitle("Album not found");
    status.textContent = "No album with this id is on record.";
    status.className = "error";
    return;
  }
  artistEl.textContent = meta.artist;
  titleEl.textContent = meta.album;
  document.title = pageTitle(`${meta.album} — ${meta.artist}`);
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
  hideChartTooltip();
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
      const [data, matchRes] = await Promise.all([
        fetchScoreHistory(albumId),
        fetch(`${API_BASE_URL}/match-history/${encodeURIComponent(albumId)}`),
      ]);
      const matchList = matchRes.ok ? (await matchRes.json()).matches : [];
      // Keyed by date rather than listing matches, because the chart addresses
      // points by date. The value is the match id so the tooltip can reach the
      // ranking; every read of it is a truthiness test, which an id satisfies.
      const matchByDate = {}; for (const m of matchList) matchByDate[m.date] = m.match_id;
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

/* Shared by the album chart and the match chart so the two can't drift apart
   visually. Fresh objects each call rather than one frozen constant: Chart.js
   merges its defaults into the config it is handed, and two live charts must not
   be sharing the objects it writes into.

   The y range is fixed rather than fitted to the data on purpose — a chart that
   rescales to its contents makes a 0.02 wobble and a 0.9 collapse look the same
   size, which is exactly the comparison these charts exist to support. */
function chartScaleOptions() {
  const label = () => ({ color: '#5A5A72', font: { family: "'Poppins', sans-serif", size: 11 } });
  const rules = () => ({ grid: { color: 'rgba(26,26,46,0.07)' }, border: { color: 'rgba(26,26,46,0.15)' } });
  return {
    x: { ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 10, ...label() }, ...rules() },
    yScore: {
      type: "linear", position: "left", min: -2.0, max: 2.0,
      title: { display: true, text: "Score", ...label() },
      ticks: label(), ...rules(),
    },
  };
}

function rebuildChart() {
  const status = document.getElementById("history-status");
  const wrap = document.getElementById("history-canvas-wrap");
  const canvas = document.getElementById("history-canvas");
  // Chart.js hides the tooltip by firing the external handler with opacity 0 on
  // mouseout, but a destroyed chart never gets there — and this runs on every
  // chip add/remove, so the tooltip has to be cleared by hand.
  hideChartTooltip();
  if (activeChart) { activeChart.destroy(); activeChart = null; }
  if (activeAlbumIds.size === 0) return;
  const ready = [...activeAlbumIds].filter(id => albumDataCache[id]);
  if (ready.length === 0) return;
  const allDates = [...new Set(ready.flatMap(id => albumDataCache[id].history.map(h => h.date)))].sort();
  const datasets = ready.map(id => {
    const { albumName, shortName, history, matchByDate } = albumDataCache[id];
    const scoreByDate = Object.fromEntries(history.map(h => [h.date, h.score]));
    const color = COLORS[albumColorMap[id] ?? 0];
    // pointHitRadius is what makes the radius-0 non-match points hoverable at
    // all: PointElement.inRange tests against hitRadius + radius. 8px is about
    // the spacing between dates, so the line stays continuously hoverable in x
    // while still demanding the cursor be near it in y.
    return { label: shortName||albumName, data: allDates.map(d => scoreByDate[d] ?? null), borderColor: color.border, backgroundColor: color.bg, tension: 0.2, spanGaps: true, pointStyle: ctx => matchByDate[allDates[ctx.dataIndex]] ? 'rectRot' : 'circle', pointBackgroundColor: color.border, pointRadius: ctx => matchByDate[allDates[ctx.dataIndex]] ? 6 : 0, pointHoverRadius: ctx => matchByDate[allDates[ctx.dataIndex]] ? 8 : 4, pointHitRadius: 8, yAxisID: "yScore", _albumId: id };
  });
  if (pendingFetches === 0) { status.textContent = ""; wrap.style.display = "block"; }
  renderChips();
  activeChart = new Chart(canvas, {
    type: "line", data: { labels: allDates, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      /* 'index' + intersect:false named a whole date column, so the tooltip
         fired anywhere in the plot area and listed every charted album — the y
         position, the only thing saying which line you mean, was ignored.
         'nearest' + intersect:true resolves to the one point actually under the
         cursor. getElementsAtEventForMode reads this same config, so a click
         handler added later lands on the point the tooltip is describing. */
      interaction: { mode: "nearest", intersect: true },
      /* options.hover inherits from options.interaction, so `elements` has
         already been resolved the same way the tooltip's was — this is the
         point being described, and needs no second hit test. Empty plot area
         and non-match points both fall through and do nothing. */
      onClick: (e, elements, chart) => {
        const hit = elements[0];
        if (!hit) return;
        const point = chartPointAt(chart, hit.datasetIndex, hit.index);
        if (point?.matchId) navigate(matchHref(point.matchId));
      },
      // Match diamonds are the only clickable thing on the canvas, so the
      // affordance stops there. Guarded to avoid a style write per mousemove.
      onHover: (e, elements, chart) => {
        const hit = elements[0];
        const want = hit && chartPointAt(chart, hit.datasetIndex, hit.index)?.matchId ? "pointer" : "default";
        if (chart.canvas.style.cursor !== want) chart.canvas.style.cursor = want;
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false, external: renderChartTooltip } },
      scales: chartScaleOptions(),
    },
  });
}

/* ── Chart tooltip ──────────────────────────────────────────
   An element rather than Chart.js's canvas-drawn tooltip, because a match's
   ranking wants markup. Resolution is split out from rendering so the answer to
   "which point is this" isn't locked inside the tooltip: onClick and onHover
   above read the same chartPointAt, which is what keeps the click landing on
   the point the tooltip is describing. */

function chartPointAt(chart, datasetIndex, dataIndex) {
  const dataset = chart.data?.datasets?.[datasetIndex];
  const albumId = dataset?._albumId;
  const date = chart.data?.labels?.[dataIndex];
  if (!albumId || !date) return null;
  // dataset.data is a flat array of numbers/nulls indexed by allDates, so the
  // raw value is the score — no need to go through the parsed scale values.
  const score = dataset.data[dataIndex];
  return { albumId, date, score, matchId: albumDataCache[albumId]?.matchByDate?.[date] || null };
}

function chartTooltipHtml({ albumId, date, score, matchId }, failed = false) {
  const { shortName, albumName } = albumNames[albumId] || {};
  const color = COLORS[albumColorMap[albumId] ?? 0].border;
  let html =
    `<div class="tt-date">${esc(date)}</div>` +
    `<div class="tt-album"><span class="tt-dot" style="background:${color}"></span>` +
    `${esc(shortName || albumName || albumId)}` +
    `<span class="tt-score">${score == null ? "–" : score.toFixed(3)}</span></div>`;
  if (!matchId) return html;
  // The pending and failed lines go inside the panel too, so it appears at full
  // width straight away and the label says what is being waited on.
  const result = matchResultCache[matchId];
  const body = result
    ? result.ranking.map(item =>
        `<div class="tt-rank${item.id === albumId ? " focal" : ""}">` +
        `<span class="tt-rank-num">${item.rank}.</span>` +
        `${esc(item["short-name"] || item.album)}</div>`).join("")
    : `<div class="tt-loading">${failed ? "Results unavailable." : "Loading…"}</div>`;
  // The hint goes when the fetch failed: the match view calls the same
  // /results/{id}, so pointing at it there would just promise a second error.
  // The click itself stays live either way.
  return html + `<div class="tt-match">` +
    `<div class="tt-match-label"><span>Match results</span>` +
    `${failed ? "" : `<span class="tt-match-cta">Click →</span>`}</div>` +
    `${body}</div>`;
}

function hideChartTooltip() {
  const el = document.getElementById("chart-tooltip");
  if (el) el.style.display = "none";
  chartHoverKey = null;
}

function renderChartTooltip({ chart, tooltip }) {
  const el = document.getElementById("chart-tooltip");
  if (!el) return;
  const dp = tooltip.opacity === 0 ? null : tooltip.dataPoints?.[0];
  const point = dp ? chartPointAt(chart, dp.datasetIndex, dp.dataIndex) : null;
  if (!point) { hideChartTooltip(); return; }

  const key = `${point.albumId}|${point.date}`;
  chartHoverKey = key;
  // Content and position go together: the clamps below are measured off the
  // rendered box, so a later rewrite that skipped repositioning would leave a
  // "Loading…"-sized placement on a full-height tooltip and overflow the pane.
  const place = html => {
    el.innerHTML = html;
    el.style.display = "block";
    positionChartTooltip(el, chart, tooltip.caretX, tooltip.caretY);
  };
  place(chartTooltipHtml(point));

  // A match marker on a cold cache renders "Loading…" and fills itself in. The
  // key guard is what stops a slow response from redrawing a tooltip the cursor
  // has already left, or one now describing a different point.
  if (point.matchId && !matchResultCache[point.matchId]) {
    const settle = failed => { if (chartHoverKey === key) place(chartTooltipHtml(point, failed)); };
    fetchMatchResult(point.matchId).then(() => settle(false), () => settle(true));
  }
}

/* caretX/Y are canvas-relative and #history-canvas-wrap is the positioned
   ancestor, so the offsets line the two coordinate spaces up. Both axes are then
   kept inside the wrapper: a match tooltip is nine lines tall against a 260px
   chart, so left unclamped it covers the date labels below the plot and runs on
   past the panel. Horizontally it flips to the other side of the cursor, which
   reads better than sliding; vertically it just slides, since flipping a box
   this tall lands it under the cursor as often as not. Must run with the final
   content already in the element — it measures offsetWidth/offsetHeight. */
function positionChartTooltip(el, chart, caretX, caretY) {
  const wrap = el.offsetParent ?? chart.canvas.parentNode;
  const left = chart.canvas.offsetLeft + caretX;
  const top = chart.canvas.offsetTop + caretY + 14;
  el.style.left = `${left + el.offsetWidth + 14 > wrap.clientWidth ? Math.max(0, left - el.offsetWidth - 14) : left + 14}px`;
  el.style.top = `${Math.max(0, Math.min(top, wrap.clientHeight - el.offsetHeight))}px`;
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

/* Shared by both accordions. The permalink is a sibling of the toggle, not a
   child: an <a> inside a <button> is invalid, and the toggle would swallow the
   click. No listener needed — the delegated handler routes /match/ paths once
   they are in ROUTES. */
function matchRowHtml(matchId, date) {
  return `
    <div class="match-row" data-match-id="${esc(matchId)}">
      <div class="match-head">
        <button class="match-toggle"><span>${esc(date)}</span><span class="match-arrow">&#9658;</span></button>
        <a class="match-permalink" href="${matchHref(matchId)}" aria-label="Open match page for ${esc(date)}">&#8599;</a>
      </div>
      <div class="match-detail"></div>
    </div>`;
}

function renderMatchPane() {
  const listEl = document.getElementById("match-list");
  const statusEl = document.getElementById("match-status");
  if (!focalAlbumId || !albumDataCache[focalAlbumId]) { listEl.innerHTML = ""; statusEl.textContent = focalAlbumId ? "Loading…" : ""; return; }
  const { matchList } = albumDataCache[focalAlbumId];
  statusEl.textContent = ""; statusEl.className = "";
  if (!matchList || matchList.length === 0) { listEl.innerHTML = ""; statusEl.textContent = "No matches on record."; return; }
  const sorted = [...matchList].reverse();
  listEl.innerHTML = sorted.map(({ match_id, date }) => matchRowHtml(match_id, date)).join("");
  listEl.querySelectorAll(".match-row").forEach(row => {
    const matchId = row.dataset.matchId; const btn = row.querySelector(".match-toggle"); const det = row.querySelector(".match-detail");
    btn.addEventListener("click", () => toggleMatchRow(matchId, btn, det, { compare: true }));
  });
  const first = listEl.querySelector(".match-row");
  if (first) toggleMatchRow(first.dataset.matchId, first.querySelector(".match-toggle"), first.querySelector(".match-detail"), { compare: true });
}

/* Shared by the accordion and the chart tooltip, which can ask for the same
   match at the same time — and the tooltip asks on every mousemove over a
   marker, so concurrent requests are deduped rather than merely cached. */
function fetchMatchResult(matchId) {
  if (matchResultCache[matchId]) return Promise.resolve(matchResultCache[matchId]);
  if (!matchFetches[matchId]) {
    matchFetches[matchId] = fetch(`${API_BASE_URL}/results/${encodeURIComponent(matchId)}`)
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then(data => { matchResultCache[matchId] = data; return data; })
      .finally(() => { delete matchFetches[matchId]; });
  }
  return matchFetches[matchId];
}

/* Same dedupe as fetchMatchResult, and for the same reason in a different
   shape: the match view asks for every album in the ranking at once, and a
   reader bouncing between a match and its albums would otherwise reopen a
   request the first view has in flight. */
function fetchScoreHistory(albumId) {
  if (scoreHistoryCache[albumId]) return Promise.resolve(scoreHistoryCache[albumId]);
  if (!historyFetches[albumId]) {
    historyFetches[albumId] = fetch(`${API_BASE_URL}/score-history/${encodeURIComponent(albumId)}`)
      .then(res => {
        if (res.status === 404) throw new Error("No history found for this album.");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => { scoreHistoryCache[albumId] = data; return data; })
      .finally(() => { delete historyFetches[albumId]; });
  }
  return historyFetches[albumId];
}

/* The album's most recent scored date — the right-hand end of its line on the
   chart. This is what the match view calls "today", rather than /scores: the
   match view is dispatched before load() and is never re-dispatched, so a
   column sourced from that payload renders empty on a deep link and stays
   empty. That is what removed the previous "Now" column. */
function currentScoreOf(albumId) {
  const h = scoreHistoryCache[albumId]?.history;
  return h && h.length ? h[h.length - 1].score : null;
}

async function toggleMatchRow(matchId, btn, det, opts = {}) {
  const isOpen = btn.classList.contains("open");
  if (isOpen) { btn.classList.remove("open"); det.classList.remove("open"); return; }
  btn.classList.add("open"); det.classList.add("open");
  if (matchResultCache[matchId]) { renderMatchDetail(matchId, det, opts); return; }
  det.textContent = "Loading…";
  try {
    await fetchMatchResult(matchId); renderMatchDetail(matchId, det, opts);
  } catch (e) { det.textContent = `Error: ${e.message}`; }
}

/* Taken by value as well as by ranking item: the match view's "since this
   match" delta is computed client-side and has no item to read is_new off — and
   must never say "New", since an album's drift since a match it played in is
   not a debut. The item wrappers keep the accordions and the chart tooltip
   calling exactly what they always did. */
function formatDeltaValue(delta, isNew = false) {
  if (isNew) return "New";
  if (delta == null) return "–";
  if (delta === 0) return "0.000";
  const icon = delta > 0 ? "▲" : "▼";
  return `${icon} ${Math.abs(delta).toFixed(3)}`;
}

function deltaClassValue(delta, isNew = false) {
  if (isNew) return "new";
  if (delta == null) return "flat";
  return delta > 0 ? "up" : delta < 0 ? "down" : "flat";
}

function formatDelta(item) { return formatDeltaValue(item.score_delta, item.is_new); }

function deltaClass(item) { return deltaClassValue(item.score_delta, item.is_new); }

function renderMatchDetail(matchId, det, opts = {}) {
  det.innerHTML = (matchResultCache[matchId]?.ranking || []).map(item => `
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

/* ── Match view ─────────────────────────────────────────── */

/* The whole page hangs off one fetch, so a fast back/forward could otherwise
   let a slow response repaint a match the user has already navigated away
   from. Every DOM write below is gated on this still matching. */
let currentMatchId = null, matchChart = null;
/* The payload the two renderers below read. renderMatchTable is called twice —
   once when /results lands and again when the score histories do — so the
   ranking has to outlive the call that delivered it. */
let matchView = null;

async function showMatchView(matchId) {
  showView("view-match");
  window.scrollTo(0, 0);
  currentMatchId = matchId;
  if (matchResultCache[matchId]) { renderMatchView(matchResultCache[matchId]); return; }

  const statusEl = document.getElementById("match-view-status");
  document.getElementById("match-title").textContent = "";
  document.getElementById("match-subtitle").textContent = "";
  document.title = pageTitle("Match Results");
  document.getElementById("match-table-wrap").innerHTML = "";
  /* Hidden rather than emptied: an empty .panel still draws its border and hard
     shadow, so a "Match not found" page would carry a bare cyan box under it. */
  document.getElementById("match-chart-panel").style.display = "none";
  statusEl.textContent = "Loading…"; statusEl.className = "";
  try {
    const res = await fetch(`${API_BASE_URL}/results/${encodeURIComponent(matchId)}`);
    if (currentMatchId !== matchId) return;
    if (res.status === 404) {
      document.getElementById("match-title").textContent = "Match not found";
      document.title = pageTitle("Match not found");
      statusEl.textContent = "No match with this id is on record.";
      statusEl.className = "error";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (currentMatchId !== matchId) return;
    matchResultCache[matchId] = data;
    renderMatchView(data);
  } catch (e) {
    if (currentMatchId !== matchId) return;
    statusEl.textContent = `Error: ${e.message}`; statusEl.className = "error";
  }
}

function renderMatchView({ date, ranking }) {
  document.getElementById("match-title").textContent = date;
  document.getElementById("match-subtitle").textContent =
    `${ranking.length} album${ranking.length === 1 ? "" : "s"}`;
  document.title = pageTitle(`Match ${date}`);
  document.getElementById("match-view-status").textContent = "";
  document.getElementById("match-view-status").className = "";
  document.getElementById("match-chart-panel").style.display = "block";
  matchView = { date, ranking };
  /* Started first so the fetches are registered in historyFetches before the
     table reads them — that is what tells "still loading" apart from "we asked
     and there is nothing". The re-render happens in a promise callback, so it
     cannot beat the synchronous first paint below. */
  loadMatchHistories();
  renderMatchTable();
}

/* Written in one pass with the rest of the row even though its data arrives
   later: "…" while that album's /score-history is in flight, "–" once it has
   failed or come back empty. */
function matchRowCells(item) {
  const pending = !scoreHistoryCache[item.id] && !!historyFetches[item.id];
  const current = currentScoreOf(item.id);
  /* Rounded before formatting, not after: float subtraction of two equal scores
     leaves ~1e-16, which formatDeltaValue would dress up as "▲ 0.000". */
  const drift = current == null || item.new_score == null
    ? null : Math.round((current - item.new_score) * 1000) / 1000;
  const todayScore = pending ? "…" : formatScore(current);
  const todayDelta = pending
    ? `<span class="ranking-delta flat">…</span>`
    : `<span class="ranking-delta ${deltaClassValue(drift)}">${formatDeltaValue(drift)}</span>`;
  return `
        <tr data-album-id="${esc(item.id)}">
          <td class="rank col-rank"><span style="background:${matchRankColor(item.rank).border}">${item.rank}</span></td>
          <td class="col-artist">${esc(item.artist)}</td>
          <td class="col-album"><a class="album-link" href="${albumHref(item.id)}">${esc(item.album)}</a></td>
          <td class="score grp-start">${formatScore(item.new_score)}</td>
          <td><span class="ranking-delta ${deltaClass(item)}">${formatDelta(item)}</span></td>
          <td class="score grp-start">${todayScore}</td>
          <td>${todayDelta}</td>
        </tr>`;
}

/* Two header rows. The first three cells of the group row are separate empty
   <th>s rather than one colspan="3": the artist column is display:none under
   600px, and a cell hidden in one row but spanned in the other would leave the
   two rows a column out of step. */
function renderMatchTable() {
  const { ranking } = matchView;
  document.getElementById("match-table-wrap").innerHTML = `
    <table>
      <thead>
        <tr class="grp-row">
          <th class="col-rank"></th><th class="col-artist"></th><th class="col-album"></th>
          <th class="grp grp-start" colspan="2" title="Score and change as of this match's date">At This Match</th>
          <th class="grp grp-start" colspan="2" title="Current score, and change since this match">Today</th>
        </tr>
        <tr>
          <th class="col-rank">Rank</th><th class="col-artist">Artist</th><th class="col-album">Album</th>
          <th class="grp-start">Score</th><th><span class="lbl-long">Change</span><span class="lbl-short">&#916;</span></th>
          <th class="grp-start">Score</th><th><span class="lbl-long">Change</span><span class="lbl-short">&#916;</span></th>
        </tr>
      </thead>
      <tbody>${ranking.map(matchRowCells).join("")}</tbody>
    </table>`;
}

/* One /score-history per album, feeding both the Today columns and the chart.
   Failures are counted rather than thrown: one album with no history should
   cost that album its two cells and its line, not the whole page. */
function loadMatchHistories() {
  const token = currentMatchId, { ranking } = matchView;
  const status = document.getElementById("match-chart-status");
  const wrap = document.getElementById("match-chart-wrap");
  if (matchChart) { matchChart.destroy(); matchChart = null; }
  if (ranking.length === 0) { status.textContent = ""; wrap.style.display = "none"; return; }
  status.textContent = "Loading…"; status.className = "";
  wrap.style.display = "none";
  let failed = 0;
  Promise.all(ranking.map(item => fetchScoreHistory(item.id).catch(() => { failed++; })))
    .then(() => {
      // Same guard as every other write here: a fast back/forward must not let
      // a slow response repaint a match the reader has already left.
      if (currentMatchId !== token) return;
      renderMatchTable();
      renderMatchChart(failed);
    });
}

/* The one date this page is about. An inline plugin rather than
   chartjs-plugin-annotation — a single dashed rule does not earn a second
   <script> on a page with no build step and no fingerprinting. */
function matchDateRule(index) {
  return {
    id: "matchDateRule",
    afterDatasetsDraw(chart) {
      if (index < 0) return;
      const x = chart.scales.x.getPixelForValue(index);
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.setLineDash([4, 4]); ctx.lineWidth = 2; ctx.strokeStyle = "#5A5A72";
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.restore();
    },
  };
}

function renderMatchChart(failed) {
  const { date, ranking } = matchView;
  const status = document.getElementById("match-chart-status");
  const wrap = document.getElementById("match-chart-wrap");
  const charted = ranking.filter(item => scoreHistoryCache[item.id]?.history?.length);
  if (charted.length === 0) {
    status.textContent = "Score history unavailable."; status.className = "error";
    wrap.style.display = "none";
    return;
  }
  status.textContent = failed
    ? `Score history unavailable for ${failed} album${failed === 1 ? "" : "s"}.` : "";
  status.className = "";
  wrap.style.display = "block";

  const dates = [...new Set(charted.flatMap(item =>
    scoreHistoryCache[item.id].history.map(h => h.date)))].sort();
  /* Only this match's date carries a marker. An album's other matches would
     need a /match-history each — twice the requests — and would put clickable
     points for other matches on a page that is about this one. */
  const matchIdx = dates.indexOf(date);
  const datasets = charted.map(item => {
    const color = matchRankColor(item.rank);
    const scoreByDate = Object.fromEntries(
      scoreHistoryCache[item.id].history.map(h => [h.date, h.score]));
    return {
      label: item["short-name"] || item.album,
      data: dates.map(d => scoreByDate[d] ?? null),
      borderColor: color.border, backgroundColor: color.bg,
      tension: 0.2, spanGaps: true,
      pointBackgroundColor: color.border,
      pointStyle: ctx => ctx.dataIndex === matchIdx ? "rectRot" : "circle",
      pointRadius: ctx => ctx.dataIndex === matchIdx ? 6 : 0,
      pointHoverRadius: ctx => ctx.dataIndex === matchIdx ? 8 : 4,
      // Keeps the radius-0 points hoverable at all: PointElement.inRange tests
      // hitRadius + radius. Same 8px the album chart uses.
      pointHitRadius: 8, yAxisID: "yScore",
    };
  });

  matchChart = new Chart(document.getElementById("match-chart-canvas"), {
    type: "line",
    data: { labels: dates, datasets },
    plugins: [matchDateRule(matchIdx)],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: true },
      plugins: {
        legend: { display: false },
        /* Chart.js's own tooltip, not the album view's external one. That one
           exists to show a hovered match's ranking in markup — which on this
           page is the table directly above — and is wired to albumDataCache,
           albumColorMap and albumNames. Reusing it would mean writing album-view
           state from the match view, which is exactly what the separate
           scoreHistoryCache avoids. Naming the line is all this needs. */
        tooltip: {
          backgroundColor: "#FFFFFF", borderColor: "#1A1A2E", borderWidth: 2,
          titleColor: "#7C3AED", bodyColor: "#1A1A2E",
          padding: 8, cornerRadius: 8,
          titleFont: { family: "'Poppins', sans-serif", size: 12, weight: 700 },
          bodyFont: { family: "'Poppins', sans-serif", size: 12 },
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatScore(ctx.parsed.y)}` },
        },
      },
      scales: chartScaleOptions(),
    },
  });
}

/* ── Landing: recent matches ────────────────────────────── */

function renderRecentMatches(matches) {
  const listEl = document.getElementById("recent-matches-list");
  listEl.innerHTML = matches.map(({ match_id, date }) => matchRowHtml(match_id, date)).join("");
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
    scoresState = "ready";
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
    scoresState = "error";
    document.getElementById("content").innerHTML = `<div id="error">Scoreboards Unavailable — ${esc(e.message)}</div>`;
  }
  /* route() already ran at startup. Re-dispatch only for a view that was waiting
     on this payload: re-running the match route would restart its fetch — the
     currentMatchId guard can't help, the id is unchanged, so both responses
     write — and scrollTo(0,0) would yank a reader who had started scrolling. */
  if (routeDeferred) route();
}

window.addEventListener("popstate", route);
initCompareBox();
/* Dispatch before the fetches, not after. If we route() here, every deep link 
   would sit on the landing view until /scoresresolved. The match view needs 
   nothing from that payload; the album view shows a placeholder and 
   load() re-dispatches for it. */
route();
load();
loadRecentMatches();
