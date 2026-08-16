/**
 * Shown when the binary was compiled without a frontend build. It is not a
 * stand-in for the workbench; it exists so that a bad build is obvious in the
 * browser instead of showing a bare 404.
 */
export const FALLBACK_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OmniScientist</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 -apple-system, system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; }
  main { max-width: 42rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p { margin: .5rem 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid rgba(128,128,128,.3); }
  .ok { color: #1a7f37; } .bad { color: #c03030; }
</style></head>
<body><main>
  <h1>OmniScientist service is running</h1>
  <p>This binary was built without the web workbench, so only the service is here.
     Build the frontend and rebuild to get the full interface.</p>
  <p id="meta"></p>
  <table><thead><tr><th>Dependency</th><th>Status</th><th>Detail</th></tr></thead>
  <tbody id="checks"><tr><td colspan="3">checking…</td></tr></tbody></table>
</main>
<script>
  fetch("/api/health").then(r => r.json()).then(h => {
    document.getElementById("meta").textContent =
      "version " + h.version + " · port " + h.port + " · workspace " + h.workspace;
  });
  fetch("/api/doctor").then(r => r.json()).then(d => {
    document.getElementById("checks").innerHTML = d.checks.map(c =>
      "<tr><td>" + c.label + "</td><td class=" + (c.status === "ok" ? "ok" : "bad") + ">" +
      c.status + "</td><td>" + c.detail + "</td></tr>").join("");
  }).catch(() => {
    document.getElementById("checks").innerHTML =
      "<tr><td colspan=3>dependency check needs the session token from the URL</td></tr>";
  });
</script></body></html>
`;

/** Shown to a caller that presents no valid session token. */
export const DENIED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OmniScientist</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:0;padding:3rem 1.5rem}
main{max-width:34rem;margin:0 auto}code{font-family:ui-monospace,Menlo,monospace}
:root{color-scheme:light dark}</style></head>
<body><main>
<h1>This session needs its token</h1>
<p>Open the workbench from the OmniScientist menu-bar icon. The address it opens
looks like <code>http://127.0.0.1:PORT/?t=…</code>; the token is generated fresh
on every start and is never reused.</p>
</main></body></html>
`;
