// Finds `// @snippet: name` ... `// @end-snippet` regions in the repo and
// writes each region into a native Notion code block, as named in
// notion-snippets.json. No dependencies: Node 20+ (global fetch).
//
//   node scripts/sync-snippets.mjs            sync to Notion (needs NOTION_TOKEN)
//   node scripts/sync-snippets.mjs --dry-run  print the regions, no API calls

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const NOTION_VERSION = "2022-06-28";
const START = /^\s*(?:\/\/|#|--)\s*@snippet:\s*([\w.-]+)\s*$/;
const END = /^\s*(?:\/\/|#|--)\s*@end-snippet\s*$/;
const LANGUAGES = { cs: "c#", js: "javascript", mjs: "javascript", ts: "typescript", py: "python", sql: "sql", json: "json" };

const dryRun = process.argv.includes("--dry-run");
const manifest = JSON.parse(readFileSync("notion-snippets.json", "utf8"));
const repo = process.env.GITHUB_REPOSITORY ?? manifest.repo;
const sha = process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD").toString().trim();
const token = process.env.NOTION_TOKEN;
let apiCalls = 0;

// 1. Read all regions from tracked files.
function findRegions() {
  const regions = new Map();
  const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const path of files) {
    if (path.startsWith("scripts/") || path.endsWith(".md")) continue;
    let lines;
    try { lines = readFileSync(path, "utf8").split(/\r?\n/); } catch { continue; }
    let open = null;
    lines.forEach((line, i) => {
      const start = line.match(START);
      if (start) { open = { name: start[1], from: i + 2 }; return; }
      if (open && END.test(line)) {
        const body = lines.slice(open.from - 1, i);
        if (regions.has(open.name)) throw new Error(`Snippet "${open.name}" is defined two times.`);
        regions.set(open.name, { name: open.name, path, from: open.from, to: i, lines: dedent(body) });
        open = null;
      }
    });
    if (open) throw new Error(`Snippet "${open.name}" in ${path} has no @end-snippet.`);
  }
  return regions;
}

function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

// 2. Make the code text and the caption for one target.
function render(region, target) {
  let text = region.lines.join("\n");
  if (target.lineNumbers) {
    const width = String(region.to).length;
    text = region.lines.map((l, i) => `${String(region.from + i).padStart(width)}  ${l}`.trimEnd()).join("\n");
  }
  const anchor = `${region.path}#L${region.from}-L${region.to}`;
  const permalink = `https://github.com/${repo}/blob/${sha}/${anchor}`;
  const caption = [
    { type: "text", text: { content: anchor, link: { url: permalink } } },
    { type: "text", text: { content: ` @ ${sha.slice(0, 7)}` } },
  ];
  const ext = region.path.split(".").pop();
  return { text, caption, language: target.language ?? LANGUAGES[ext] ?? "plain text", permalink };
}

function chunks(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 2000) out.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
  return out.length ? out : [{ type: "text", text: { content: "" } }];
}

async function notion(method, path, body) {
  apiCalls++;
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.code}: ${json.message}`);
  return json;
}

// Code blocks on a page, in page order. Looks into synced blocks, toggles
// and columns too, because the code block can sit inside them.
async function codeBlocks(blockId, depth = 0) {
  const found = [];
  let cursor;
  do {
    const page = await notion("GET", `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const b of page.results) {
      if (b.type === "code") found.push(b);
      else if (b.has_children && depth < 2 && b.type !== "child_page" && b.type !== "child_database") {
        found.push(...(await codeBlocks(b.id, depth + 1)));
      }
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return found;
}

async function syncTarget(region, target) {
  const r = render(region, target);
  let block;
  if (target.block) block = await notion("GET", `/blocks/${target.block}`);
  else block = (await codeBlocks(target.page))[target.codeBlockIndex ?? 0];
  if (!block) throw new Error(`No code block for "${target.snippet}" on page ${target.page}.`);

  // Skip when the code, the line range and the language are the same. The
  // caption keeps the older commit then, and that permalink shows the same code.
  const current = block.code.rich_text.map((t) => t.plain_text).join("");
  const currentAnchor = block.code.caption[0]?.plain_text ?? "";
  if (current === r.text && currentAnchor === r.caption[0].text.content && block.code.language === r.language) {
    console.log(`= ${target.snippet} (${block.id}) no change`);
    return false;
  }
  await notion("PATCH", `/blocks/${block.id}`, { code: { rich_text: chunks(r.text), language: r.language, caption: r.caption } });
  console.log(`~ ${target.snippet} (${block.id}) updated, ${region.path}#L${region.from}-L${region.to}`);

  // Snippets database row: keep the properties in step with the block.
  if (target.page && target.updateProperties !== false) {
    await notion("PATCH", `/pages/${target.page}`, {
      properties: {
        Repo: { url: `https://github.com/${repo}` },
        Path: { rich_text: [{ type: "text", text: { content: region.path } }] },
        Region: { rich_text: [{ type: "text", text: { content: `L${region.from}-L${region.to}`, link: { url: r.permalink } } }] },
        Language: { select: { name: r.language } },
        Commit: { rich_text: [{ type: "text", text: { content: sha.slice(0, 7), link: { url: `https://github.com/${repo}/commit/${sha}` } } }] },
        Updated: { date: { start: new Date().toISOString() } },
      },
    });
  }
  return true;
}

const regions = findRegions();
console.log(`Found ${regions.size} snippet regions at ${sha.slice(0, 7)}.`);
if (dryRun) {
  for (const t of manifest.targets) {
    const region = regions.get(t.snippet);
    if (!region) { console.log(`! ${t.snippet}: not in code`); continue; }
    const r = render(region, t);
    console.log(`--- ${t.snippet} -> ${t.block ?? t.page} [${r.language}] ${region.path}#L${region.from}-L${region.to}\n${r.text}`);
  }
  process.exit(0);
}
if (!token) throw new Error("NOTION_TOKEN is not set.");

let failed = 0, changed = 0;
for (const t of manifest.targets) {
  const region = regions.get(t.snippet);
  if (!region) { console.error(`! ${t.snippet}: no region with this name in the code`); failed++; continue; }
  try { if (await syncTarget(region, t)) changed++; }
  catch (e) { console.error(`! ${t.snippet}: ${e.message}`); failed++; }
}
console.log(`Done: ${changed} updated, ${failed} failed, ${apiCalls} Notion API calls.`);
if (failed) process.exit(1);
