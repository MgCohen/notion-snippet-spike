import argparse
import collections
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
LANGUAGES = {"cs": "c#", "js": "javascript", "jsx": "javascript", "mjs": "javascript", "ts": "typescript", "tsx": "typescript", "py": "python", "sql": "sql", "json": "json"}
FILE = re.compile(r"https://github\.com/([^/]+/[^/]+)/blob/([^/]+)/([^?#]+)")
COMMIT = re.compile(r"[0-9a-f]{7,40}")
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", re.M)
CHUNK = 1000
MAX_CHUNKS = 100


def git(*args):
    run = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8")
    if run.returncode:
        raise ValueError(run.stderr.strip() or f"git {args[0]} failed.")
    return run.stdout


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
                with urllib.request.urlopen(request, timeout=30) as response:
                    return json.load(response)
            except urllib.error.HTTPError as e:
                if (e.code == 429 or e.code >= 500) and attempt < 3:
                    wait = e.headers.get("Retry-After") or ""
                    time.sleep(float(wait) if wait.isdigit() else attempt + 1)
                    continue
                try:
                    error = json.load(e)
                except ValueError:
                    error = {}
                raise RuntimeError(f"{method} {path} -> {e.code} {error.get('code')}: {error.get('message')}") from None
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt < 3:
                    time.sleep(attempt + 1)
                    continue
                raise RuntimeError(f"{method} {path} -> {getattr(e, 'reason', e)}") from None


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
            file = (pr.get("File") or {}).get("url") or ""
            link = FILE.match(file)
            region = texts(pr.get("Region"))
            since = FILE.match(region[0].get("href") or "") if region else None
            rows.append({
                "id": p["id"],
                "name": plain(pr.get("Name")),
                "file": file,
                "repo": link and link[1],
                "ref": link and link[2],
                "path": link and urllib.parse.unquote(link[3]),
                "method": plain(pr.get("Method")).strip(),
                "overload": number(pr.get("Overload")) or 1,
                "start": number(pr.get("Start line")),
                "end": number(pr.get("End line")),
                "before": number(pr.get("Lines before")) or 0,
                "after": number(pr.get("Lines after")) or 0,
                "since": since[2] if since and COMMIT.fullmatch(since[2]) else None,
                "hash": plain(pr.get("Hash")),
                "status": ((pr.get("Status") or {}).get("select") or {}).get("name"),
                "message": plain(pr.get("Message")),
            })
        if not page["has_more"]:
            return rows
        cursor = page["next_cursor"]


def follow_range(diff, start, end):
    new_start, new_end, edited = start, end, False
    for m in HUNK.finditer(diff):
        old, old_count = int(m[1]), 1 if m[2] is None else int(m[2])
        new, new_count = int(m[3]), 1 if m[4] is None else int(m[4])
        if old_count == 0:
            new_start += new_count if old < start else 0
            new_end += new_count if old < end else 0
            edited |= start <= old < end
            continue
        old_last, first_new = old + old_count - 1, new if new_count else new + 1
        if old_last < start:
            new_start += new_count - old_count
        elif old <= start:
            new_start = first_new
        if old_last < end:
            new_end += new_count - old_count
        elif old <= end:
            new_end = first_new + new_count - 1
        edited |= old <= end and old_last >= start
    return new_start, new_end, edited


def dedent(lines):
    cut = min((len(line) - len(line.lstrip()) for line in lines if line.strip()), default=0)
    return [line[cut:] for line in lines]


def resolve(row, head):
    if not row["path"]:
        raise ValueError(f'File must be a GitHub file link, not "{row["file"]}".')
    path = row["path"]
    commit = row["ref"] if COMMIT.fullmatch(row["ref"]) else head
    source = git("show", f"{commit}:{path}")
    start, end, moved = row["start"], row["end"], None
    if not row["method"] and start and end and commit == head and row["since"]:
        try:
            new_start, new_end, edited = follow_range(git("diff", "-U0", row["since"], head, "--", path), start, end)
        except ValueError:
            new_start, new_end, edited = start, end, False
        if new_end < new_start:
            raise ValueError(f"The lines {start}-{end} were deleted.")
        if (new_start, new_end) != (start, end) or edited:
            moved = f"{'edited' if edited else 'moved'}, was {start}-{end}"
            start, end = new_start, new_end
    first, last = snippet_range(source, row["method"], row["overload"], start, end, row["before"], row["after"])
    lines = source.replace("\r", "").split("\n")
    code = "\n".join(dedent(lines[first - 1 : last]))
    if len(code) > CHUNK * MAX_CHUNKS:
        raise ValueError(f"The code has more than {CHUNK * MAX_CHUNKS} characters.")
    language = LANGUAGES.get(path.rsplit(".", 1)[-1].lower(), "plain text")
    region = f"L{first}-L{last}"
    return {
        "code": code,
        "language": language,
        "anchor": f"{path}#{region}",
        "region": region,
        "commit": commit,
        "permalink": f"https://github.com/{row['repo']}/blob/{commit}/{urllib.parse.quote(path)}#{region}",
        "hash": hashlib.sha256(f"{language}\n{path}#{region}\n{code}".encode()).hexdigest()[:16],
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


def write(notion, row, snippet):
    block = find_code_block(notion, row["id"])
    if not block:
        raise ValueError("No code block on the row page.")
    code = snippet["code"]
    parts = [{"type": "text", "text": {"content": code[i : i + CHUNK]}} for i in range(0, max(len(code), 1), CHUNK)]
    caption = rich(snippet["anchor"], snippet["permalink"])["rich_text"] + rich(f" @ {snippet['commit'][:7]}")["rich_text"]
    notion("PATCH", f"/blocks/{block}", {"code": {"rich_text": parts, "language": snippet["language"], "caption": caption}})
    properties = {
        "Region": rich(snippet["region"], snippet["permalink"]),
        "Hash": rich(snippet["hash"]),
        "Status": {"select": {"name": "In sync"}},
        "Message": rich(""),
    }
    if snippet["moved"]:
        properties.update({"Start line": {"number": snippet["start"]}, "End line": {"number": snippet["end"]}})
    notion("PATCH", f"/pages/{row['id']}", {"properties": properties})


def sync(notion, rows, repo, head, mode):
    results = []
    for row in rows:
        target = row["method"] or (f"L{row['start']}-L{row['end'] or 'end'}" if row["start"] else "file")
        report = lambda result, note: results.append((row["name"], target, result, note))
        if not row["file"]:
            report("skipped", "File is empty")
            continue
        if row["repo"] and row["repo"].lower() != repo.lower():
            report("skipped", f"File is in {row['repo']}")
            continue
        try:
            snippet = resolve(row, head)
            note = f"{snippet['anchor']} ({snippet['moved']})" if snippet["moved"] else snippet["anchor"]
            if mode != "force" and snippet["hash"] == row["hash"] and row["status"] == "In sync" and not snippet["moved"]:
                report("unchanged", note)
            elif mode == "plan":
                report("will update" if row["hash"] else "new", note)
            else:
                write(notion, row, snippet)
                report("updated" if row["hash"] else "new", note)
        except (ValueError, RuntimeError) as e:
            error = str(e)[:2000]
            known = row["status"] == "Error" and row["message"] == error
            if mode != "plan" and not known:
                try:
                    notion("PATCH", f"/pages/{row['id']}", {"properties": {"Status": {"select": {"name": "Error"}}, "Message": rich(error)}})
                except RuntimeError as status_error:
                    error += f" Status not written: {status_error}"
            report("error (known)" if known else "error", error)
    return results


def current_repo():
    return os.environ.get("GITHUB_REPOSITORY") or re.search(r"github\.com[:/](.+?)(?:\.git)?$", git("remote", "get-url", "origin").strip())[1]


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
    counts = collections.Counter(result for _, _, result, _ in results)
    summary = "\n".join([
        f"### Notion snippets: {args.mode} at `{head[:7]}`",
        "",
        ", ".join(f"{v} {k}" for k, v in counts.items()) + f", {notion.calls} Notion API calls",
        "",
        "| Snippet | Target | Result | Region or error |",
        "|---|---|---|---|",
        *(f"| {name} | `{target}` | {result} | {note.replace('|', '\\|')} |" for name, target, result, note in results),
    ])
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(summary + "\n")
    return 1 if counts["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
