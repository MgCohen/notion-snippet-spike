// Reads the blocks of a Notion page through the public API and prints what a
// program gets back for each block: the code text, or only a URL or a file.
// Follows synced block references to the original block.
//
//   NOTION_TOKEN=... node scripts/read-blocks.mjs <pageId>

const [pageId] = process.argv.slice(2);
const H = { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, "Notion-Version": "2026-03-11" };

async function get(path) {
  const res = await fetch(`https://api.notion.com/v1${path}`, { headers: H });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${json.code}: ${json.message}`);
  return json;
}
const text = (rt = []) => rt.map((t) => t.plain_text).join("");
const short = (s, n = 400) => (s.length > n ? s.slice(0, n) + ` ... (${s.length} chars)` : s);

async function walk(blockId, indent = "") {
  const { results } = await get(`/blocks/${blockId}/children?page_size=100`);
  for (const b of results) {
    const v = b[b.type];
    switch (b.type) {
      case "heading_2": case "heading_3":
        console.log(`\n${indent}## ${text(v.rich_text)}`); break;
      case "code":
        console.log(`${indent}[code] language=${v.language} caption="${text(v.caption)}"`);
        console.log(short(text(v.rich_text)).replace(/^/gm, `${indent}  | `)); break;
      case "embed": {
        console.log(`${indent}[embed] caption="${text(v.caption)}"`);
        console.log(`${indent}  url: ${short(v.url ?? "(none)", 160)}`);
        if (v.file_upload || v.file || v.type === "file") console.log(`${indent}  file: ${JSON.stringify(v.file ?? v.file_upload).slice(0, 160)}`);
        // An HTML block holds a file: download it to see if the code is readable.
        const fileUrl = v.file?.url ?? (v.url?.startsWith("https://prod-files") ? v.url : null);
        if (fileUrl) {
          const html = await (await fetch(fileUrl)).text();
          const code = html.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1] ?? "";
          console.log(`${indent}  file content (code part, HTML entities decoded):`);
          console.log(short(code.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), 300).replace(/^/gm, `${indent}  | `));
        }
        break;
      }
      case "bookmark":
        console.log(`${indent}[bookmark] url: ${v.url} caption="${text(v.caption)}"`); break;
      case "synced_block": {
        const from = v.synced_from?.block_id;
        console.log(`${indent}[synced_block] ${from ? `reference to ${from}` : "original"}`);
        await walk(from ?? b.id, indent + "  ");
        break;
      }
      default:
        if (["paragraph"].includes(b.type) && text(v.rich_text)) console.log(`${indent}[${b.type}] ${short(text(v.rich_text), 120)}`);
    }
  }
}

await walk(pageId);
