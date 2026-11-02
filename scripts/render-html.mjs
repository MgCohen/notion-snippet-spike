// Test: renders a line range of a file as a self-contained HTML page for a
// Notion HTML block: real line numbers, a height limit with scroll, and C#
// colors from highlight.js (loaded from a CDN, to test network access).
//
//   node scripts/render-html.mjs src/OrderService.cs 21 32 > out.html

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [path, fromArg, toArg, maxHeight = "320"] = process.argv.slice(2);
const lines = readFileSync(path, "utf8").replace(/\r?\n$/, "").split(/\r?\n/);
const from = Number(fromArg ?? 1), to = Number(toArg ?? lines.length);
const sha = execSync("git rev-parse HEAD").toString().trim();
const repo = "MgCohen/notion-snippet-spike";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const body = lines.slice(from - 1, to);
const link = `https://github.com/${repo}/blob/${sha}/${path}#L${from}-L${to}`;

process.stdout.write(`<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
<style>
  body { margin: 0; font: 13px/1.5 ui-monospace, Consolas, monospace; background: #fff; }
  .frame { border: 1px solid #e3e2e0; border-radius: 6px; overflow: hidden; }
  .code { max-height: ${maxHeight}px; overflow: auto; display: grid; grid-template-columns: auto 1fr; }
  .nums { text-align: right; padding: 8px 10px; color: #9b9a97; user-select: none; background: #f7f6f3; }
  pre { margin: 0; padding: 8px 12px; }
  pre code.hljs { padding: 0; background: none; }
  .bar { display: flex; justify-content: space-between; padding: 6px 10px; background: #f7f6f3; border-top: 1px solid #e3e2e0; font: 12px system-ui, sans-serif; color: #787774; }
  .bar a { color: #787774; }
  #net { font: 11px system-ui, sans-serif; color: #b0aea9; padding: 0 10px 4px; background: #f7f6f3; }
</style></head>
<body><div class="frame">
<div class="code"><div class="nums">${body.map((_, i) => from + i).join("<br>")}</div><pre><code class="language-csharp">${esc(body.join("\n"))}</code></pre></div>
<div class="bar"><span>${esc(path)}#L${from}-L${to} @ ${sha.slice(0, 7)}</span><a href="${link}" target="_blank">GitHub</a></div>
<div id="net">highlight.js: not loaded (no network)</div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
  if (window.hljs) { hljs.highlightAll(); document.getElementById("net").textContent = "highlight.js: loaded from CDN"; }
</script>
</body></html>
`);
