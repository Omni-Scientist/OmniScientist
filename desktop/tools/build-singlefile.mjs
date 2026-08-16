// Bundle the Vite build into ONE self-contained HTML fragment that can be
// published as a claude.ai Artifact (strict CSP: no external requests at all).
//
// Usage:
//   npx vite build
//   node tools/build-singlefile.mjs        -> dist-single/omnisci-workspace.html
//
// Fonts: the four public/assets/fonts/*.ttf files are re-compressed to woff2
// first (see tools/ttf2woff2.py), which cuts 2.2 MB down to ~0.8 MB.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const outDir = join(root, "dist-single");
const fontCache = join(root, ".cache-fonts");

const MIME = {
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

function dataUri(file) {
  const ext = file.slice(file.lastIndexOf("."));
  const mime = MIME[ext] ?? "application/octet-stream";
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

const assetFiles = readdirSync(join(dist, "assets"));
const jsName = assetFiles.find((f) => f.endsWith(".js"));
const cssName = assetFiles.find((f) => f.endsWith(".css"));
if (!jsName || !cssName) throw new Error("dist/assets is missing the built js/css - run `npx vite build` first");

// The host page owns <head>, so this fragment cannot declare its own charset.
// Re-emit the bundles as pure ASCII (\uXXXX escapes) so the Chinese copy survives
// no matter which encoding the host assumes.
const toAscii = (code, loader) =>
  transformSync(code, { loader, charset: "ascii", minify: true, legalComments: "none" }).code;

let css = toAscii(readFileSync(join(dist, "assets", cssName), "utf8"), "css");
let js = toAscii(readFileSync(join(dist, "assets", jsName), "utf8"), "js");

// 1. Drop the Inter subsets nobody in this demo needs (cyrillic / greek / vietnamese).
const dropped = [];
css = css.replace(/@font-face\{[^}]*\}/g, (block) => {
  const m = /url\(\/assets\/(inter-[a-z-]+)-wght/.exec(block);
  if (m && !/^inter-latin(-ext)?$/.test(m[1])) {
    dropped.push(m[1]);
    return "";
  }
  return block;
});

// 2. Inline every url(/assets/...) in the CSS, preferring the woff2 rebuild of the TTFs.
const inlined = [];
css = css.replace(/url\(\/assets\/([^)]+)\)(\s*format\(["']?([a-z2]+)["']?\))?/g, (all, rel, fmtPart, fmt) => {
  let file = join(dist, "assets", rel);
  let format = fmt;
  if (rel.endsWith(".ttf")) {
    const woff2 = join(fontCache, rel.split("/").pop().replace(/\.ttf$/, ".woff2"));
    if (!existsSync(woff2)) throw new Error(`missing ${woff2} - run tools/ttf2woff2.py first`);
    file = woff2;
    format = "woff2";
  }
  if (!existsSync(file)) throw new Error(`missing asset referenced by CSS: ${file}`);
  inlined.push(rel);
  return `url(${dataUri(file)})${format ? ` format("${format}")` : ""}`;
});

// 3. Inline the runtime assets the JS points at by absolute path.
for (const rel of ["omni-logo.svg", "eval-heatmap.png", "demo-paper.pdf"]) {
  const file = join(dist, "assets", rel);
  if (!existsSync(file)) throw new Error(`missing asset referenced by JS: ${file}`);
  const before = js.length;
  js = js.split(`/assets/${rel}`).join(dataUri(file));
  if (js.length === before) throw new Error(`/assets/${rel} was never referenced by the bundle`);
  inlined.push(rel);
}

if (/\/assets\//.test(js) || /\/assets\//.test(css)) throw new Error("an /assets/ reference survived inlining");

// 4. The paper artifact opens/downloads a PDF. Chrome refuses to navigate to a
//    data: URL, so hand those clicks a same-page blob URL instead.
const pdfShim = `
(function () {
  var cache = new Map();
  function toBlobUrl(href) {
    if (cache.has(href)) return cache.get(href);
    var bytes = atob(href.slice(href.indexOf(",") + 1));
    var buf = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
    cache.set(href, url);
    return url;
  }
  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a[href^='data:application/pdf']") : null;
    if (!link) return;
    event.preventDefault();
    var url = toBlobUrl(link.getAttribute("href"));
    if (link.hasAttribute("download")) {
      var a = document.createElement("a");
      a.href = url;
      a.download = link.getAttribute("download") || "paper.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      window.open(url, "_blank", "noopener");
    }
  });
})();
`.trim();

const esc = (code) => code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

const html = `<title>OmniScientist Research Workspace</title>
<style>
${css.replace(/<\/style/gi, "<\\/style")}
</style>
<div id="root"></div>
<script>${esc(pdfShim)}</script>
<script type="module">${esc(js)}</script>
`;

const nonAscii = html.match(/[^\x00-\x7F]/g);
if (nonAscii) throw new Error(`output is not pure ASCII (${nonAscii.length} chars, e.g. ${nonAscii[0]})`);

mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "omnisci-workspace.html");
writeFileSync(outFile, html);

console.log(`dropped font subsets : ${dropped.join(", ") || "none"}`);
console.log(`inlined assets       : ${inlined.length}`);
console.log(`output               : ${outFile} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
