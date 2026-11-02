// Saves the unchanged Notion API responses for the blocks of a page, and the
// unchanged files that HTML blocks point to. No parsing, no shortening.
// Follows synced block references, because the code is in the original block.
//
//   NOTION_TOKEN=... node scripts/read-raw.mjs <pageId> <outDir>

import { mkdirSync, writeFileSync } from "node:fs";

const [pageId, outDir] = process.argv.slice(2);
const H = { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, "Notion-Version": "2026-03-11" };
mkdirSync(outDir, { recursive: true });
let n = 0;

async function save(path) {
  const res = await fetch(`https://api.notion.com/v1${path}`, { headers: H });
  const body = await res.text();
  const file = `${outDir}/${String(++n).padStart(2, "0")}-GET${path.replace(/[/?=&]/g, "_")}.json`;
  writeFileSync(file, `// GET https://api.notion.com/v1${path}  status ${res.status}\n${body}`);
  return JSON.parse(body);
}

async function walk(blockId) {
  const page = await save(`/blocks/${blockId}/children?page_size=100`);
  for (const b of page.results) {
    if (b.type === "synced_block") await walk(b.synced_block.synced_from?.block_id ?? b.id);
    const url = b.embed?.url;
    if (url?.startsWith("https://prod-files")) {
      const res = await fetch(url);
      writeFileSync(`${outDir}/${String(++n).padStart(2, "0")}-file-of-block-${b.id}.html`, await res.text());
    }
  }
}

await walk(pageId);
console.log(`saved ${n} files to ${outDir}`);
