// Writes code from the repo into native Notion code blocks, as named in
// notion-snippets.json. No dependencies: Node 20+ (global fetch).
//
//   node scripts/sync-snippets.mjs            sync to Notion (needs NOTION_TOKEN)
//   node scripts/sync-snippets.mjs --dry-run  print the code, no API calls
//
// Selectors for a target (one of):
//   { "file": "src/A.cs", "lines": "16-27" }        line range
//   { "file": "src/A.cs" }                          whole file
//   { "file": "src/A.cs", "symbol": "A.Total" }     class, record or method (C#-like)
//   { "snippet": "name" }                           // @snippet: name ... // @end-snippet
// Options: "ref" reads the file at a fixed commit, "maxLines" cuts the code,
// "lineNumbers" puts the real line numbers in the code text.

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

function readLines(path, ref) {
  const text = ref ? execSync(`git show ${ref}:${path}`, { encoding: "utf8" }) : readFileSync(path, "utf8");
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

// Marker regions from all tracked files.
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
// Strings, chars and comments do not count for braces.
function findSymbol(lines, symbol) {
  let from = 1, to = lines.length;
  for (const name of symbol.split(".")) {
    const range = findDeclaration(lines, name, from, to);
    if (!range) throw new Error(`Symbol "${name}" not found.`);
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

function findEnd(lines, start) {
  let depth = 0, opened = false, arrow = false;
  for (let i = start; i < lines.length; i++) {
    const code = stripLiterals(lines[i]);
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

function stripLiterals(line) {
  return line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

// Resolves a target to { path, from, to, lines, label, ref }.
function resolve(target, markers) {
  if (target.snippet) {
    const m = markers.get(target.snippet);
    if (!m) throw new Error(`no @snippet "${target.snippet}" in the code`);
    const all = readLines(m.path);
    return { ...m, all, label: `@snippet ${target.snippet}` };
  }
  const all = readLines(target.file, target.ref);
  let from = 1, to = all.length, label = "file";
  if (target.lines) {
    [from, to] = target.lines.split("-").map(Number);
    if (!(from >= 1 && to >= from && to <= all.length)) throw new Error(`lines ${target.lines} not in ${target.file} (${all.length} lines)`);
    label = `lines ${target.lines}`;
  } else if (target.symbol) {
    [from, to] = findSymbol(all, target.symbol);
    label = `symbol ${target.symbol}`;
  }
  if (target.ref) label += ` @ ${target.ref.slice(0, 7)}`;
  return { path: target.file, from, to, all, label, ref: target.ref };
}

function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

// Makes the code text and the caption for one target.
function render(region, target) {
  const commit = region.ref ?? sha;
  const ext = region.path.split(".").pop();
  const language = target.language ?? LANGUAGES[ext] ?? "plain text";
  // Keep the real line number with each line, and drop the marker comments.
  const body = dedent(region.all.slice(region.from - 1, region.to));
  let rows = body.map((text, i) => ({ n: region.from + i, text })).filter((r) => !START.test(r.text) && !END.test(r.text));
  const hidden = target.maxLines && rows.length > target.maxLines ? rows.length - target.maxLines : 0;
  if (hidden) rows = rows.slice(0, target.maxLines);
  const width = String(rows.at(-1)?.n ?? 0).length;
  let text = rows.map((r) => (target.lineNumbers ? `${String(r.n).padStart(width)}  ${r.text}`.trimEnd() : r.text)).join("\n");
  if (hidden) text += `\n// ... ${hidden} more lines, see the caption link`;

  const anchor = `${region.path}#L${region.from}-L${region.to}`;
  const permalink = `https://github.com/${repo}/blob/${commit}/${anchor}`;
  const caption = [
    { type: "text", text: { content: anchor, link: { url: permalink } } },
    { type: "text", text: { content: ` @ ${commit.slice(0, 7)}` } },
  ];
  return { text, caption, language, permalink, commit };
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

async function syncTarget(name, region, target) {
  const r = render(region, target);
  let block;
  if (target.block) block = await notion("GET", `/blocks/${target.block}`);
  else block = (await codeBlocks(target.page))[target.codeBlockIndex ?? 0];
  if (!block) throw new Error(`no code block on page ${target.page}`);

  // Skip when the code, the line range and the language are the same. The
  // caption keeps the older commit then, and that permalink shows the same code.
  const current = block.code.rich_text.map((t) => t.plain_text).join("");
  const currentAnchor = block.code.caption[0]?.plain_text ?? "";
  if (current === r.text && currentAnchor === r.caption[0].text.content && block.code.language === r.language) {
    console.log(`= ${name} (${block.id}) no change`);
    return false;
  }
  await notion("PATCH", `/blocks/${block.id}`, { code: { rich_text: chunks(r.text), language: r.language, caption: r.caption } });
  console.log(`~ ${name} (${block.id}) updated, ${region.path}#L${region.from}-L${region.to}`);

  // Snippets database row: keep the properties in step with the block.
  if (target.page && target.updateProperties !== false) {
    const text = (content, url) => ({ rich_text: [{ type: "text", text: { content, link: url ? { url } : null } }] });
    await notion("PATCH", `/pages/${target.page}`, {
      properties: {
        Repo: { url: `https://github.com/${repo}` },
        Path: text(region.path),
        Selector: text(region.label),
        Region: text(`L${region.from}-L${region.to}`, r.permalink),
        Language: { select: { name: r.language } },
        Commit: text(r.commit.slice(0, 7), `https://github.com/${repo}/commit/${r.commit}`),
        Updated: { date: { start: new Date().toISOString() } },
      },
    });
  }
  return true;
}

const markers = findMarkers();
console.log(`Found ${markers.size} @snippet regions at ${sha.slice(0, 7)}.`);
if (!dryRun && !token) throw new Error("NOTION_TOKEN is not set.");

let failed = 0, changed = 0;
for (const t of manifest.targets) {
  const name = t.name ?? t.snippet ?? `${t.file} ${t.lines ?? t.symbol ?? ""}`.trim();
  try {
    const region = resolve(t, markers);
    if (dryRun) {
      const r = render(region, t);
      console.log(`--- ${name} -> ${t.block ?? t.page} [${r.language}] ${region.label}: ${region.path}#L${region.from}-L${region.to}\n${r.text}`);
    } else if (await syncTarget(name, region, t)) changed++;
  } catch (e) {
    console.error(`! ${name}: ${e.message}`);
    failed++;
  }
}
if (!dryRun) console.log(`Done: ${changed} updated, ${failed} failed, ${apiCalls} Notion API calls.`);
if (failed) process.exit(1);
