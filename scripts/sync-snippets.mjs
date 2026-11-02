// Keeps native Notion code blocks equal to code in this repo.
// The registry is the Notion "Snippets" database: one row for each code block.
// No dependencies: Node 20+ (global fetch).
//
//   node scripts/sync-snippets.mjs           apply: write the blocks that changed
//   node scripts/sync-snippets.mjs --plan    list what would change, write nothing
//   node scripts/sync-snippets.mjs --force   write all blocks
//   node scripts/sync-snippets.mjs --local   resolve rows from notion-rows.json, no API (test)
//
// Row input (database properties):
//   Selector  lines 16-27 | file | symbol Outer.Inner | snippet name
//             options: @<commit>  max <n>  numbers
//   Path      the file, for lines, file and symbol
// Row output: Status, Message, Hash, Block ID, Path (snippet), Region, Language, Commit, Updated.
// The page of the row holds the code block: the first code block, also inside a synced block.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const NOTION_VERSION = "2022-06-28";
const START = /^\s*(?:\/\/|#|--)\s*@snippet:\s*([\w.-]+)\s*$/;
const END = /^\s*(?:\/\/|#|--)\s*@end-snippet\s*$/;
const LANGUAGES = { cs: "c#", js: "javascript", mjs: "javascript", ts: "typescript", py: "python", sql: "sql", json: "json" };

const args = new Set(process.argv.slice(2));
const mode = args.has("--plan") ? "plan" : args.has("--local") ? "local" : "apply";
const force = args.has("--force");
const config = JSON.parse(readFileSync("notion-snippets.json", "utf8"));
const repo = process.env.GITHUB_REPOSITORY ?? config.repo;
const sha = process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD").toString().trim();
const token = process.env.NOTION_TOKEN;
let apiCalls = 0;

// ---------- Code selection ----------

function readLines(path, ref) {
  const text = ref ? execSync(`git show ${ref}:${path}`, { encoding: "utf8" }) : readFileSync(path, "utf8");
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

function findMarkers() {
  const regions = new Map();
  const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const path of files) {
    if (path.startsWith("scripts/") || path.endsWith(".md")) continue;
    let lines;
    try { lines = readLines(path); } catch { continue; }
    let open = null;
    lines.forEach((line, i) => {
      const start = line.match(START);
      if (start) { open = { name: start[1], from: i + 2 }; return; }
      if (open && END.test(line)) {
        if (regions.has(open.name)) throw new Error(`Snippet "${open.name}" is defined two times.`);
        regions.set(open.name, { path, from: open.from, to: i });
        open = null;
      }
    });
    if (open) throw new Error(`Snippet "${open.name}" in ${path} has no @end-snippet.`);
  }
  return regions;
}

// Finds a C#-like declaration and its end. "Outer.Inner" searches Inner inside Outer.
function findSymbol(lines, symbol) {
  let from = 1, to = lines.length;
  for (const name of symbol.split(".")) {
    const range = findDeclaration(lines, name, from, to);
    if (!range) throw new Error(`symbol "${name}" not found`);
    [from, to] = range;
  }
  // Keep the doc comments and attributes above the declaration.
  while (from > 1 && /^\s*(\/\/\/|\[)/.test(lines[from - 2])) from--;
  return [from, to];
}

function findDeclaration(lines, name, from, to) {
  const type = new RegExp(`\\b(class|record|struct|interface|enum)\\s+${name}\\b`);
  const member = new RegExp(`^\\s*(?:[\\w<>\\[\\],?]+\\s+)+${name}\\s*(?:<[^>]*>)?\\s*\\(`);
  for (let i = from - 1; i < to; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line) || /\bnew\s/.test(line.split(name)[0])) continue;
    if (type.test(line) || member.test(line)) return [i + 1, findEnd(lines, i)];
  }
  return null;
}

// Strings, chars and comments do not count for braces.
function findEnd(lines, start) {
  let depth = 0, opened = false, arrow = false;
  for (let i = start; i < lines.length; i++) {
    const code = lines[i].replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    for (let c = 0; c < code.length; c++) {
      const ch = code[c];
      if (ch === "=" && code[c + 1] === ">" && depth === 0 && !opened) arrow = true;
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") { depth--; if (opened && depth === 0) return i + 1; }
      else if (ch === ";" && depth === 0 && (arrow || !opened)) return i + 1;
    }
  }
  return lines.length;
}

// "symbol OrderService max 12 numbers" -> { kind, arg, ref, maxLines, lineNumbers }
function parseSelector(selector) {
  const words = selector.trim().split(/\s+/);
  const s = { kind: words.shift() };
  if (!["lines", "file", "symbol", "snippet"].includes(s.kind)) throw new Error(`unknown selector "${selector}"`);
  if (s.kind !== "file") s.arg = words.shift();
  while (words.length) {
    const w = words.shift();
    if (w.startsWith("@")) s.ref = w.slice(1);
    else if (w === "max") s.maxLines = Number(words.shift());
    else if (w === "numbers") s.lineNumbers = true;
    else throw new Error(`unknown option "${w}" in "${selector}"`);
  }
  return s;
}

// Moves a line range by the git diff from the last synced commit to now.
// Returns null if the file did not change, else { from, to, edited }.
function followRange(path, from, to, since) {
  if (!since) return null;
  let diff;
  try { diff = execSync(`git diff -U0 ${since} ${sha} -- ${path}`, { encoding: "utf8" }); } catch { return null; }
  if (!diff) return null;
  let shift = 0, grow = 0, edited = false;
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(m[1]), oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const delta = (m[4] === undefined ? 1 : Number(m[4])) - oldCount;
    const oldEnd = oldCount === 0 ? oldStart : oldStart + oldCount - 1; // count 0: insert after oldStart
    if (oldEnd < from) shift += delta;
    else if (oldStart <= to) { grow += delta; edited = true; }
  }
  return { from: from + shift, to: to + shift + grow, edited };
}

function resolve(row, markers) {
  const s = parseSelector(row.selector);
  let path = row.path, from = 1, to, all;
  if (s.kind === "snippet") {
    const m = markers.get(s.arg);
    if (!m) throw new Error(`no @snippet "${s.arg}" in the code`);
    ({ path, from, to } = m);
    all = readLines(path);
  } else {
    if (!path) throw new Error("Path is empty");
    all = readLines(path, s.ref);
    to = all.length;
    if (s.kind === "lines") {
      [from, to] = s.arg.split("-").map(Number);
      const moved = s.ref ? null : followRange(path, from, to, row.commit);
      if (moved && (moved.from !== from || moved.to !== to || moved.edited)) {
        s.follow = { old: `${from}-${to}`, edited: moved.edited };
        ({ from, to } = moved);
        s.newSelector = row.selector.replace(/^lines\s+\d+-\d+/, `lines ${from}-${to}`);
      }
      if (!(from >= 1 && to >= from && to <= all.length)) throw new Error(`lines ${s.arg} not in ${path} (${all.length} lines)`);
    } else if (s.kind === "symbol") [from, to] = findSymbol(all, s.arg);
  }
  return { ...s, path, from, to, all };
}

function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

// Code text, caption and hash for one region.
function render(r) {
  const commit = r.ref ?? sha;
  const language = LANGUAGES[r.path.split(".").pop()] ?? "plain text";
  // Keep the real line number with each line, and drop the marker comments.
  const body = dedent(r.all.slice(r.from - 1, r.to));
  let rows = body.map((text, i) => ({ n: r.from + i, text })).filter((x) => !START.test(x.text) && !END.test(x.text));
  const hidden = r.maxLines && rows.length > r.maxLines ? rows.length - r.maxLines : 0;
  if (hidden) rows = rows.slice(0, r.maxLines);
  const width = String(rows.at(-1)?.n ?? 0).length;
  let text = rows.map((x) => (r.lineNumbers ? `${String(x.n).padStart(width)}  ${x.text}`.trimEnd() : x.text)).join("\n");
  if (hidden) text += `\n// ... ${hidden} more lines, see the caption link`;

  const anchor = `${r.path}#L${r.from}-L${r.to}`;
  const permalink = `https://github.com/${repo}/blob/${commit}/${anchor}`;
  const caption = [
    { type: "text", text: { content: anchor, link: { url: permalink } } },
    { type: "text", text: { content: ` @ ${commit.slice(0, 7)}` } },
  ];
  // The commit is not in the hash: a push that does not change the code changes nothing.
  const hash = createHash("sha256").update(`${language}\n${anchor}\n${text}`).digest("hex").slice(0, 16);
  return { text, caption, language, permalink, commit, anchor, hash };
}

// ---------- Notion ----------

async function notion(method, path, body) {
  apiCalls++;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${json.code}: ${json.message}`), { status: res.status });
    return json;
  }
}

const plain = (p) => (p?.rich_text ?? p?.title ?? []).map((t) => t.plain_text).join("");
const text = (content, url) => ({ rich_text: content ? [{ type: "text", text: { content, link: url ? { url } : null } }] : [] });

async function readRegistry() {
  const rows = [];
  let cursor;
  do {
    const page = await notion("POST", `/databases/${config.database}/query`, { page_size: 100, start_cursor: cursor });
    for (const p of page.results) {
      const pr = p.properties;
      rows.push({
        id: p.id, name: plain(pr.Name), selector: plain(pr.Selector), path: plain(pr.Path),
        commit: plain(pr.Commit), hash: plain(pr.Hash), blockId: plain(pr["Block ID"]), status: pr.Status?.select?.name, message: plain(pr.Message),
      });
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return rows;
}

// First code block on a page, also inside synced blocks, toggles and columns.
async function findCodeBlock(blockId, depth = 0) {
  let cursor;
  do {
    const page = await notion("GET", `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const b of page.results) {
      if (b.type === "code") return b.id;
      if (b.has_children && depth < 2 && b.type !== "child_page" && b.type !== "child_database") {
        const inner = await findCodeBlock(b.id, depth + 1);
        if (inner) return inner;
      }
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return null;
}

async function writeBlock(row, r) {
  const body = { code: { rich_text: [], language: r.language, caption: r.caption } };
  for (let i = 0; i < r.text.length || i === 0; i += 2000) body.code.rich_text.push({ type: "text", text: { content: r.text.slice(i, i + 2000) } });
  let blockId = row.blockId || (await findCodeBlock(row.id));
  if (!blockId) throw new Error("no code block on the page");
  try { await notion("PATCH", `/blocks/${blockId}`, body); }
  catch (e) {
    // The stored block was deleted or moved: find the code block again.
    if (!row.blockId || (e.status !== 404 && e.status !== 400)) throw e;
    blockId = await findCodeBlock(row.id);
    if (!blockId) throw new Error("no code block on the page");
    await notion("PATCH", `/blocks/${blockId}`, body);
  }
  return blockId;
}

// ---------- Run ----------

const markers = findMarkers();
const rows = mode === "local" ? JSON.parse(readFileSync("notion-rows.json", "utf8")) : (token ? await readRegistry() : null);
if (!rows) throw new Error("NOTION_TOKEN is not set.");

const results = [];
for (const row of rows) {
  if (!row.selector) { results.push({ row, result: "skipped", note: "Selector is empty" }); continue; }
  let r, region;
  try { region = resolve(row, markers); r = render(region); }
  catch (e) { r = null; region = { error: e.message }; }

  if (!r) {
    const result = row.status === "Error" && row.message === region.error ? "error (known)" : "error";
    if (mode === "apply" && result === "error") {
      await notion("PATCH", `/pages/${row.id}`, { properties: { Status: { select: { name: "Error" } }, Message: text(region.error) } });
    }
    results.push({ row, result, note: region.error });
    continue;
  }
  const changed = force || r.hash !== row.hash || row.status !== "In sync";
  const f = region.follow;
  const note = f ? `${r.anchor} (range ${f.edited ? "edited" : "moved"}, was ${f.old})` : r.anchor;
  if (mode === "local") { console.log(`--- ${row.name} [${row.selector}] ${note} ${r.hash}\n${r.text}`); continue; }
  if (!changed) { results.push({ row, result: "unchanged", note }); continue; }
  if (mode === "plan") { results.push({ row, result: row.hash ? "will update" : "new", note }); continue; }

  try {
    const blockId = await writeBlock(row, r);
    await notion("PATCH", `/pages/${row.id}`, {
      properties: {
        Repo: { url: `https://github.com/${repo}` },
        Path: text(region.path),
        Region: text(`L${region.from}-L${region.to}`, r.permalink),
        Language: { select: { name: r.language } },
        Commit: text(r.commit.slice(0, 7), `https://github.com/${repo}/commit/${r.commit}`),
        Updated: { date: { start: new Date().toISOString() } },
        Hash: text(r.hash),
        "Block ID": text(blockId),
        Status: { select: { name: "In sync" } },
        Message: text(""),
        ...(region.newSelector ? { Selector: text(region.newSelector) } : {}),
      },
    });
    results.push({ row, result: row.hash ? "updated" : "new", note });
  } catch (e) {
    results.push({ row, result: "error", note: e.message });
  }
}
if (mode === "local") process.exit(0);

// Report: console and the GitHub job summary.
const counts = {};
for (const x of results) counts[x.result] = (counts[x.result] ?? 0) + 1;
const summary = [
  `### Notion snippets: ${mode}${force ? " (force)" : ""} at \`${sha.slice(0, 7)}\``,
  "",
  Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") + `, ${apiCalls} Notion API calls`,
  "",
  "| Snippet | Selector | Result | Region or error |",
  "|---|---|---|---|",
  ...results.map((x) => `| ${x.row.name} | \`${x.row.selector}\` | ${x.result} | ${x.note.replace(/\|/g, "\\|")} |`),
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
if (results.some((x) => x.result === "error")) process.exit(1);
