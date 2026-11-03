import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from snippet_range import snippet_range

API = "https://api.notion.com/v1"
VERSION = "2022-06-28"
LANGUAGES = {"cs": "c#", "js": "javascript", "mjs": "javascript", "ts": "typescript", "py": "python", "sql": "sql", "json": "json"}
FILE = re.compile(r"https://github\.com/([^/]+/[^/]+)/blob/([^/]+)/([^?#]+)")
COMMIT = re.compile(r"[0-9a-f]{7,40}")
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@", re.M)


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", check=True).stdout


class Notion:
    def __init__(self, token):
        self.token = token
        self.calls = 0

    def __call__(self, method, path, body=None):
        for attempt in range(4):
            self.calls += 1
            request = urllib.request.Request(
                API + path,
                method=method,
                data=None if body is None else json.dumps(body).encode(),
                headers={"Authorization": f"Bearer {self.token}", "Notion-Version": VERSION, "Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(request) as response:
                    return json.load(response)
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 3:
                    time.sleep(attempt + 1)
                    continue
                error = json.load(e)
                raise RuntimeError(f"{method} {path} -> {e.code} {error.get('code')}: {error.get('message')}") from None


def texts(prop):
    prop = prop or {}
    return prop.get("rich_text") or prop.get("title") or []


def plain(prop):
    return "".join(t["plain_text"] for t in texts(prop))


def number(prop):
    value = (prop or {}).get("number")
    return None if value is None else int(value)


def rich(content, url=None):
    return {"rich_text": [{"type": "text", "text": {"content": content, "link": {"url": url} if url else None}}] if content else []}


def read_rows(notion, database):
    rows, cursor = [], None
    while True:
        page = notion("POST", f"/databases/{database}/query", {"page_size": 100, **({"start_cursor": cursor} if cursor else {})})
        for p in page["results"]:
            pr = p["properties"]
            region = texts(pr.get("Region"))
            since = FILE.match(region[0].get("href") or "") if region else None
            rows.append({
                "id": p["id"],
                "name": plain(pr.get("Name")),
                "file": (pr.get("File") or {}).get("url"),
                "method": plain(pr.get("Method")).strip(),
                "overload": number(pr.get("Overload")) or 1,
                "start": number(pr.get("Start line")),
                "end": number(pr.get("End line")),
                "before": number(pr.get("Lines before")) or 0,
                "after": number(pr.get("Lines after")) or 0,
                "since": since and since.group(2),
                "hash": plain(pr.get("Hash")),
                "status": ((pr.get("Status") or {}).get("select") or {}).get("name"),
                "message": plain(pr.get("Message")),
            })
        if not page["has_more"]:
            return rows
        cursor = page["next_cursor"]


def follow_range(path, start, end, since, head):
    try:
        diff = git("diff", "-U0", since, head, "--", path)
    except subprocess.CalledProcessError:
        return None
    shift = grow = 0
    edited = False
    for m in HUNK.finditer(diff):
        old_start, old_count = int(m[1]), 1 if m[2] is None else int(m[2])
        delta = (1 if m[3] is None else int(m[3])) - old_count
        old_end = old_start if old_count == 0 else old_start + old_count - 1
        if old_end < start:
            shift += delta
        elif old_start <= end:
            grow += delta
            edited = True
    return start + shift, end + shift + grow, edited


def dedent(lines):
    indents = [len(line) - len(line.lstrip()) for line in lines if line.strip()]
    cut = min(indents, default=0)
    return [line[cut:] for line in lines]


def resolve(row, head):
    m = FILE.fullmatch(row["file"])
    if not m:
        raise ValueError(f'File must be a GitHub file link, not "{row["file"]}".')
    repo, ref, path = m[1], m[2], urllib.parse.unquote(m[3])
    pinned = bool(COMMIT.fullmatch(ref))
    if pinned:
        source = git("show", f"{ref}:{path}")
    else:
        with open(path, encoding="utf-8") as f:
            source = f.read()
    lines = source.replace("\r", "").removesuffix("\n").split("\n")
    start, end, moved = row["start"], row["end"], None
    if not row["method"] and start and not pinned and row["since"]:
        new = follow_range(path, start, end or len(lines), row["since"], head)
        if new and (new[:2] != (start, end or len(lines)) or new[2]):
            moved = f"{'edited' if new[2] else 'moved'}, was {start}-{end or len(lines)}"
            start, end = new[:2]
    first, last = snippet_range(source, row["method"], row["overload"], start, end, row["before"], row["after"])
    commit = ref if pinned else head
    code = "\n".join(dedent(lines[first - 1 : last]))
    language = LANGUAGES.get(path.rsplit(".", 1)[-1], "plain text")
    anchor = f"{path}#L{first}-L{last}"
    permalink = f"https://github.com/{repo}/blob/{commit}/{anchor}"
    return {
        "repo": repo,
        "code": code,
        "language": language,
        "anchor": anchor,
        "permalink": permalink,
        "commit": commit,
        "region": f"L{first}-L{last}",
        "hash": hashlib.sha256(f"{language}\n{anchor}\n{code}".encode()).hexdigest()[:16],
        "moved": moved,
        "start": start,
        "end": end,
    }


def find_code_block(notion, block_id, depth=0):
    cursor = None
    while True:
        page = notion("GET", f"/blocks/{block_id}/children?page_size=100" + (f"&start_cursor={cursor}" if cursor else ""))
        for b in page["results"]:
            if b["type"] == "code":
                return b["id"]
            if b["has_children"] and depth < 2 and b["type"] not in ("child_page", "child_database"):
                inner = find_code_block(notion, b["id"], depth + 1)
                if inner:
                    return inner
        if not page["has_more"]:
            return None
        cursor = page["next_cursor"]


def write(notion, row, r):
    block = find_code_block(notion, row["id"])
    if not block:
        raise ValueError("No code block on the row page.")
    parts = [{"type": "text", "text": {"content": r["code"][i : i + 2000]}} for i in range(0, max(len(r["code"]), 1), 2000)]
    caption = [
        {"type": "text", "text": {"content": r["anchor"], "link": {"url": r["permalink"]}}},
        {"type": "text", "text": {"content": f" @ {r['commit'][:7]}"}},
    ]
    notion("PATCH", f"/blocks/{block}", {"code": {"rich_text": parts, "language": r["language"], "caption": caption}})
    properties = {
        "Region": rich(r["region"], r["permalink"]),
        "Hash": rich(r["hash"]),
        "Status": {"select": {"name": "In sync"}},
        "Message": rich(""),
    }
    if r["moved"]:
        properties.update({"Start line": {"number": r["start"]}, "End line": {"number": r["end"]}})
    notion("PATCH", f"/pages/{row['id']}", {"properties": properties})


def sync(notion, rows, repo, head, mode):
    results = []
    for row in rows:
        source = row["method"] or (f"L{row['start']}-L{row['end'] or 'end'}" if row["start"] else "file")
        report = lambda result, note: results.append((row["name"], source, result, note))
        if not row["file"]:
            report("skipped", "File is empty")
            continue
        other = FILE.match(row["file"])
        if other and other[1].lower() != repo.lower():
            report("skipped", f"File is in {other[1]}")
            continue
        try:
            r = resolve(row, head)
        except (ValueError, OSError, subprocess.CalledProcessError) as e:
            error = str(e)
            known = row["status"] == "Error" and row["message"] == error
            if mode != "plan" and not known:
                notion("PATCH", f"/pages/{row['id']}", {"properties": {"Status": {"select": {"name": "Error"}}, "Message": rich(error)}})
            report("error (known)" if known else "error", error)
            continue
        note = f"{r['anchor']} ({r['moved']})" if r["moved"] else r["anchor"]
        if mode != "force" and r["hash"] == row["hash"] and row["status"] == "In sync" and not r["moved"]:
            report("unchanged", note)
        elif mode == "plan":
            report("will update" if row["hash"] else "new", note)
        else:
            try:
                write(notion, row, r)
                report("updated" if row["hash"] else "new", note)
            except (ValueError, RuntimeError) as e:
                report("error", str(e))
    return results


def current_repo():
    if os.environ.get("GITHUB_REPOSITORY"):
        return os.environ["GITHUB_REPOSITORY"]
    return re.search(r"github\.com[:/](.+?)(?:\.git)?$", git("remote", "get-url", "origin").strip())[1]


def main():
    parser = argparse.ArgumentParser(description="Write code from this repo into the Notion code blocks of a Snippets database.")
    parser.add_argument("mode", nargs="?", choices=["plan", "apply", "force"], default="plan")
    parser.add_argument("--database", default=os.environ.get("NOTION_SNIPPETS_DATABASE"))
    args = parser.parse_args()
    token = os.environ.get("NOTION_TOKEN")
    if not token or not args.database:
        sys.exit("Set NOTION_TOKEN, and NOTION_SNIPPETS_DATABASE or --database.")
    notion = Notion(token)
    head = os.environ.get("GITHUB_SHA") or git("rev-parse", "HEAD").strip()
    results = sync(notion, read_rows(notion, args.database), current_repo(), head, args.mode)

    counts = {}
    for _, _, result, _ in results:
        counts[result] = counts.get(result, 0) + 1
    summary = "\n".join([
        f"### Notion snippets: {args.mode} at `{head[:7]}`",
        "",
        ", ".join(f"{v} {k}" for k, v in counts.items()) + f", {notion.calls} Notion API calls",
        "",
        "| Snippet | Source | Result | Region or error |",
        "|---|---|---|---|",
        *(f"| {name} | `{source}` | {result} | {note.replace('|', '\\|')} |" for name, source, result, note in results),
    ])
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(summary + "\n")
    return 1 if any(result == "error" for _, _, result, _ in results) else 0


if __name__ == "__main__":
    sys.exit(main())
