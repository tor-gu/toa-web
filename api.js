/* Tournament of Albums — API base URL resolution.

   Loaded as a blocking script from the <head> of index.html and viz.html, after
   config.js (which it reads) and before any page script (which read the value it
   sets).

   The base URL is set by config.js, which Terraform generates per environment. The
   ?api= override is allowlisted so a crafted link can't point the page at an
   arbitrary host and render someone else's data under this domain. */
window.TOA_API_BASE_URL = (() => {
  const override = new URLSearchParams(location.search).get("api");
  if (override && /^(https:\/\/[\w-]+\.tor-gu\.com|http:\/\/localhost:\d+)$/.test(override)) return override;
  return window.TOA_CONFIG?.apiBaseUrl ?? "https://toa-api.tor-gu.com";
})();
