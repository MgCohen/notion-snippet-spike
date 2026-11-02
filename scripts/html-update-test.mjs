// Test: replace the HTML file of an existing Notion HTML block through the
// public API, as a GitHub Action would do after a merge.
// usage: NOTION_TOKEN=... node html-update.mjs <pageId> <htmlFile>
import { readFileSync } from "node:fs";

const [pageId, file] = process.argv.slice(2);
const token = process.env.NOTION_TOKEN;
const H = { Authorization: `Bearer ${token}`, "Notion-Version": "2026-03-11" };
let calls = 0;
async function api(method, path, body, raw) {
  calls++;
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: raw ? H : { ...H, "Content-Type": "application/json" },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.code}: ${json.message}`);
  return json;
}

const t0 = Date.now();
const children = await api("GET", `/blocks/${pageId}/children`);
const block = children.results.find((b) => b.type === "embed");
console.log("embed block:", block?.id, JSON.stringify(block?.embed).slice(0, 200));

const upload = await api("POST", "/file_uploads", { filename: "order-service.html", content_type: "text/html" });
const form = new FormData();
form.append("file", new Blob([readFileSync(file)], { type: "text/html" }), "order-service.html");
await api("POST", `/file_uploads/${upload.id}/send`, null, form);
const updated = await api("PATCH", `/blocks/${block.id}`, { embed: { file_upload: { id: upload.id } } });
console.log("updated:", JSON.stringify(updated.embed).slice(0, 200));
console.log(`calls: ${calls}, time: ${Date.now() - t0} ms`);
