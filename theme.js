/* Tournament of Albums — shared page chrome.
   On load: fills any .header-deco with the doodle SVGs, animates the header
   <h1> into hopping, multi-colored characters, and inserts the site-wide
   navigation tabs after the header. Included by index.html, viz.html and
   404.html; all they need is a `.page-header` with an <h1> and (optionally) an
   empty `<div class="header-deco"></div>`.
   Also renders the non-prod environment banner from window.TOA_CONFIG. */
(function () {
  "use strict";

  const TITLE_COLORS = ["#FF3D7F", "#1EC8E0", "#FFD23F", "#7C3AED"];

  const HEADER_DECO_SVG = `
    <svg width="48" height="20" viewBox="0 0 48 20" style="left:4%;top:18%"><path d="M2 12 Q8 2 14 12 T26 12 T38 12" fill="none" stroke="#FF3D7F" stroke-width="3" stroke-linecap="round"/></svg>
    <svg width="40" height="16" viewBox="0 0 40 16" style="right:5%;top:14%"><path d="M2 14 L8 2 L14 14 L20 2 L26 14 L32 2 L38 14" fill="none" stroke="#1EC8E0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <svg width="22" height="22" viewBox="0 0 22 22" style="left:16%;bottom:6%"><circle cx="5" cy="5" r="3" fill="#7C3AED"/><circle cx="14" cy="6" r="3" fill="#FFD23F"/><circle cx="9" cy="15" r="3" fill="#1EC8E0"/></svg>
    <svg width="20" height="20" viewBox="0 0 20 20" style="right:14%;bottom:8%"><path d="M10 2 L18 18 L2 18 Z" fill="none" stroke="#FFD23F" stroke-width="3" stroke-linejoin="round"/></svg>`;

  function renderHeaderDeco() {
    document.querySelectorAll(".header-deco").forEach((el) => {
      el.innerHTML = HEADER_DECO_SVG;
    });
  }

  function animateTitle() {
    const h1 = document.querySelector(".page-header h1");
    if (!h1) return;
    const text = h1.textContent;
    let ci = 0;
    h1.innerHTML = [...text]
      .map((ch, i) => {
        if (ch === " ") return " ";
        const safe = ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
        const color = TITLE_COLORS[ci++ % TITLE_COLORS.length];
        return `<span class="title-ch" style="--i:${i};color:${color}">${safe}</span>`;
      })
      .join("");
  }

  /* ── Navigation tabs ──────────────────────────────────────────
     Generated here rather than written into each document: there is no
     templating step, and the alternative is three copies to keep in sync —
     one of which would inevitably forget to carry the query string below. */

  const TABS = [
    { href: "/", label: "Current Rankings" },
    { href: "/viz", label: "Visualization" },
    { href: "/about", label: "About" },
  ];

  /* /album/<id> and /match/<id> are sub-views of the standings, so they light
     up the Rankings tab. 404.html is served for arbitrary paths and matches
     nothing — no tab is active, which is the honest answer.

     The extensionless /viz and /about are the canonical URLs, but the underlying
     /viz.html and /about.html are real bucket keys and still serve, so both forms
     match — otherwise those URLs would render with no tab active at all. */
  function activeTab(pathname) {
    if (/^\/viz(\.html)?\/?$/.test(pathname)) return "/viz";
    if (/^\/about(\.html)?\/?$/.test(pathname)) return "/about";
    if (pathname === "/" || /^\/(album|match)\//.test(pathname)) return "/";
    return null;
  }

  function renderNav() {
    const header = document.querySelector(".page-header");
    if (!header) return;
    const nav = document.createElement("nav");
    nav.className = "tab-nav";
    nav.setAttribute("aria-label", "Site sections");
    for (const t of TABS) {
      const a = document.createElement("a");
      a.className = "tab-link";
      /* Carrying location.search is the point: the ?api= override lives in the
         query string, and a tab that dropped it would quietly return a test
         session to the prod API. app.js's navigate() does the same.
         Set as a property rather than interpolated into innerHTML — the query
         string is attacker-controlled and must never reach an HTML parser. */
      a.href = t.href + location.search;
      a.textContent = t.label;
      nav.append(a);
    }
    header.after(nav);
    updateActiveTab();
  }

  /* Exported because index.html navigates by pushState, which fires no event
     this file could listen for — app.js's route() calls this after each hop. */
  function updateActiveTab() {
    const current = activeTab(location.pathname);
    document.querySelectorAll(".tab-nav .tab-link").forEach((a) => {
      if (a.pathname === current) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  window.TOA_updateActiveTab = updateActiveTab;

  /* Flags any environment that isn't prod, so a test tab is never mistaken
     for the real standings. Driven by config.js, which Terraform generates
     per environment. */
  function renderEnvBanner() {
    const env = window.TOA_CONFIG?.environment;
    if (!env || env === "prod") return;
    const banner = document.createElement("div");
    banner.className = "env-banner";
    banner.textContent = `${env.toUpperCase()} — not the real standings`;
    document.body.prepend(banner);
    document.documentElement.classList.add("has-env-banner");
  }

  function init() {
    renderEnvBanner();
    renderHeaderDeco();
    animateTitle();
    renderNav();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
