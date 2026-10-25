// Loaded before the app bundle. If a script or stylesheet of this build fails to load (a rollout in
// progress, a stale edge), reload the page a few times instead of leaving it blank. The counter is
// cleared by the app once the bundle runs.
window.addEventListener(
  "error",
  function (e) {
    var t = e.target;
    if (!t || (t.tagName !== "SCRIPT" && t.tagName !== "LINK")) return;
    var key = "hx.asset.retry";
    var n = 0;
    try { n = Number(sessionStorage.getItem(key) || "0"); } catch (_) { /* private window */ }
    if (n >= 3) return;
    try { sessionStorage.setItem(key, String(n + 1)); } catch (_) { /* private window */ }
    setTimeout(function () { location.reload(); }, 2000 * (n + 1));
  },
  true
);
