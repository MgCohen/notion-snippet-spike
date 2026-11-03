// Keeps native Notion code blocks equal to code in this repo.
// The registry is the Notion "Snippets" database: one row for each code block.
// No dependencies: Node 22+ (global fetch).
//
//   node scripts/sync-snippets.mjs           apply: write the blocks that changed
//   node scripts/sync-snippets.mjs --plan    list what would change, write nothing
//   node scripts/sync-snippets.mjs --force   write all blocks
//   node scripts/sync-snippets.mjs --local   resolve rows from notion-rows.json, no API (test)
//
// Row input (database properties):
//   File                    GitHub file link: https://github.com/<owner>/<repo>/blob/<ref>/<path>
//                           A commit as <ref> pins the code. Rows of other repos are skipped.
//   Method                  declaration to show, for example Total or OrderService.Total
//   Overload                which declaration, if more than one has the name (default 1)
//   Start line, End line    the range, if Method is empty. All empty: the whole file
//   Lines before, after     lines to add on each side
//   Max lines, Line numbers display options
// Row output: Status, Message, Hash, Block ID, Region, Language, Commit, Updated.
// A line range moves with the git diff, and the run writes the new Start line and End line.
// The page of the row holds the code block: the first code block, also inside a synced block.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { snippetRange } from "./snippet-range.mjs";

const NOTION_VERSION = "2022-06-28";
const LANGUAGES = { cs: "c#", js: "javascript", mjs: "javascript", ts: "typescript", py: "python", sql: "sql", json: "json" };

const args = new Set(process.argv.slice(2));
const mode = args.has("--plan") ? "plan" : args.has("--local") ? "local" : "apply";
const force = args.has("--force");
const config = JSON.parse(readFileSync("notion-snippets.json", "utf8"));
const repo = process.env.GITHUB_REPOSITORY ?? config.repo;
const branch = config.branch ?? "main";
const sha = process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD").toString().trim();
const token = process.env.NOTION_TOKEN;
let apiCalls = 0;

// ---------- Code selection ----------

function parseFile(url) {
  const m = url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/([^?#]+)$/);
  if (!m) throw new Error(`File must be a GitHub file link, not "${url}"`);
  return { repo: m[1], ref: m[2], path: decodeURIComponent(m[3]), pinned: /^[0-9a-f]{7,40}$/.test(m[2]) };
}

// The default branch is the checkout, so a pull request plan shows the code of the pull request.
function readFile({ ref, path, pinned }) {
  if (ref === branch) return readFileSync(path, "utf8");
  return execSync(`git show ${pinned ? ref : `origin/${ref}`}:${path}`, { encoding: "utf8" });
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

function resolve(row) {
  const file = parseFile(row.file);
  const source = readFile(file);
  const all = source.replace(/\r?\n$/, "").split(/\r?\n/);
  let { start, end } = row;
  let follow;
  if (!row.method && start && file.ref === branch) {
    const to = end ?? all.length;
    const moved = followRange(file.path, start, to, row.commit);
    if (moved && (moved.from !== start || moved.to !== to || moved.edited)) {
      follow = { old: `${start}-${to}`, edited: moved.edited };
      ({ from: start, to: end } = moved);
    }
  }
  const range = snippetRange(source, { method: row.method || undefined, overload: row.overload, start, end, before: row.before, after: row.after });
  return { ...row, ...file, commit: file.pinned ? file.ref : sha, from: range.start, to: range.end, all, follow, start, end };
}

function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

// Code text, caption and hash for one region.
function render(r) {
  const language = LANGUAGES[r.path.split(".").pop()] ?? "plain text";
  // Keep the real line number with each line.
  let rows = dedent(r.all.slice(r.from - 1, r.to)).map((text, i) => ({ n: r.from + i, text }));
  const hidden = r.maxLines && rows.length > r.maxLines ? rows.length - r.maxLines : 0;
  if (hidden) rows = rows.slice(0, r.maxLines);
  const width = String(rows.at(-1)?.n ?? 0).length;
  let text = rows.map((x) => (r.lineNumbers ? `${String(x.n).padStart(width)}  ${x.text}`.trimEnd() : x.text)).join("\n");
  if (hidden) text += `\n// ... ${hidden} more lines, see the caption link`;

  const anchor = `${r.path}#L${r.from}-L${r.to}`;
  const permalink = `https://github.com/${r.repo}/blob/${r.commit}/${anchor}`;
  const caption = [
    { type: "text", text: { content: anchor, link: { url: permalink } } },
    { type: "text", text: { content: ` @ ${r.commit.slice(0, 7)}` } },
  ];
  // The commit is not in the hash: a push that does not change the code changes nothing.
  const hash = createHash("sha256").update(`${language}\n${anchor}\n${text}`).digest("hex").slice(0, 16);
  return { text, caption, language, permalink, anchor, hash };
}

// "OrderService.Total", "L21-L32" or "file", for the report.
function describe(row) {
  const where = row.method
    ? `${row.method}${row.overload > 1 ? ` (${row.overload})` : ""}`
    : row.start ? `L${row.start}-L${row.end ?? "end"}` : "file";
  const pad = [row.before && `B${row.before}`, row.after && `A${row.after}`].filter(Boolean).join(" ");
  return pad ? `${where} ${pad}` : where;
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
const number = (p) => p?.number ?? undefined;
const text = (content, url) => ({ rich_text: content ? [{ type: "text", text: { content, link: url ? { url } : null } }] : [] });

async function readRegistry() {
  const rows = [];
  let cursor;
  do {
    const page = await notion("POST", `/databases/${config.database}/query`, { page_size: 100, start_cursor: cursor });
    for (const p of page.results) {
      const pr = p.properties;
      rows.push({
        id: p.id, name: plain(pr.Name), file: pr.File?.url ?? undefined, method: plain(pr.Method).trim(), overload: number(pr.Overload),
        start: number(pr["Start line"]), end: number(pr["End line"]), before: number(pr["Lines before"]), after: number(pr["Lines after"]),
        maxLines: number(pr["Max lines"]), lineNumbers: pr["Line numbers"]?.checkbox ?? false,
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

const rows = mode === "local" ? JSON.parse(readFileSync("notion-rows.json", "utf8")) : (token ? await readRegistry() : null);
if (!rows) throw new Error("NOTION_TOKEN is not set.");

const results = [];
for (const row of rows) {
  if (!row.file) { results.push({ row, result: "skipped", note: "File is empty" }); continue; }
  const other = row.file.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\//)?.[1];
  if (other && other.toLowerCase() !== repo.toLowerCase()) { results.push({ row, result: "skipped", note: `File is in ${other}` }); continue; }
  let r, region;
  try { region = resolve(row); r = render(region); }
  catch (e) { r = null; region = { error: e.message }; }

  if (!r) {
    const result = row.status === "Error" && row.message === region.error ? "error (known)" : "error";
    if (mode === "apply" && result === "error") {
      await notion("PATCH", `/pages/${row.id}`, { properties: { Status: { select: { name: "Error" } }, Message: text(region.error) } });
    }
    results.push({ row, result, note: region.error });
    continue;
  }
  const changed = force || r.hash !== row.hash || row.status !== "In sync" || region.follow;
  const f = region.follow;
  const note = f ? `${r.anchor} (range ${f.edited ? "edited" : "moved"}, was ${f.old})` : r.anchor;
  if (mode === "local") { console.log(`--- ${row.name} [${describe(row)}] ${note} ${r.hash}\n${r.text}`); continue; }
  if (!changed) { results.push({ row, result: "unchanged", note }); continue; }
  if (mode === "plan") { results.push({ row, result: row.hash ? "will update" : "new", note }); continue; }

  try {
    const blockId = await writeBlock(row, r);
    await notion("PATCH", `/pages/${row.id}`, {
      properties: {
        Region: text(`L${region.from}-L${region.to}`, r.permalink),
        Language: { select: { name: r.language } },
        Commit: text(region.commit.slice(0, 7), `https://github.com/${region.repo}/commit/${region.commit}`),
        Updated: { date: { start: new Date().toISOString() } },
        Hash: text(r.hash),
        "Block ID": text(blockId),
        Status: { select: { name: "In sync" } },
        Message: text(""),
        ...(f ? { "Start line": { number: region.start }, "End line": { number: region.end } } : {}),
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
  "| Snippet | Source | Result | Region or error |",
  "|---|---|---|---|",
  ...results.map((x) => `| ${x.row.name} | \`${describe(x.row)}\` | ${x.result} | ${x.note.replace(/\|/g, "\\|")} |`),
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
if (results.some((x) => x.result === "error")) process.exit(1);
