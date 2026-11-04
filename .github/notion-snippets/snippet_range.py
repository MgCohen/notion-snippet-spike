import re

KEYWORDS = set("return await throw yield else case typeof delete in of is as if while for foreach switch catch using lock nameof sizeof".split())
TYPE_WORDS = {"class", "struct", "record", "interface", "enum", "namespace", "module", "function"}
VARIABLE_WORDS = {"const", "let", "var"}
NAME = re.compile(r"[A-Za-z_$][\w$]*")
PREFIX = re.compile(r"[\w$<>\[\]?,.@\s]*")
ATTRIBUTES = re.compile(r"^(?:\[[^\[\]]*\]\s*)+")
NEXT = re.compile(r"\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\s*(\(|=>|\{|=|;|:)")
RAW = re.compile(r'\$*("{3,})')


def snippet_range(text, method=None, overload=1, start=None, end=None, before=0, after=0):
    if overload < 1 or before < 0 or after < 0:
        raise ValueError("Overload must be 1 or more, and Lines before and Lines after must be 0 or more.")
    src = text.replace("\r", "")
    count = src.count("\n") + (not src.endswith("\n"))
    if method:
        first, last = find_declaration(mask(src), method, overload)
    else:
        first, last = start or 1, end or count
        if first > count:
            raise ValueError(f"Line {first} is outside the file ({count} lines).")
        if first < 1 or last < first:
            raise ValueError(f"Bad line range {first}-{last}.")
    return max(1, first - before), min(count, last + after)


def find_declaration(code, method, overload):
    parts = method.split(".")
    if not all(NAME.fullmatch(p) for p in parts):
        raise ValueError(f'Bad method name "{method}".')
    lo, hi = 0, len(code)
    for i, name in enumerate(parts):
        label = ".".join(parts[: i + 1])
        found = declarations(code, name, lo, hi)
        pick = overload if i == len(parts) - 1 else 1
        if not found:
            raise ValueError(f'No declaration named "{label}" in the file.')
        if pick > len(found):
            raise ValueError(f'Only {len(found)} declaration(s) named "{label}" in the file.')
        at, lo, last = found[pick - 1]
        hi = last + 1
    return line_of(code, at), line_of(code, last)


def mask(text):
    out, i, n = [], 0, len(text)
    while i < n:
        pair = text[i : i + 2]
        raw = RAW.match(text, i)
        if pair == "//":
            j = text.find("\n", i)
            j = n if j < 0 else j
        elif pair == "/*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
        elif raw:
            j = text.find(raw[1], raw.end())
            j = n if j < 0 else j + len(raw[1])
        elif text.startswith(('@"', '$@"', '@$"'), i):
            j = verbatim_end(text, text.index('"', i) + 1)
        elif text[i] in "\"'`":
            j = string_end(text, i + 1, text[i])
        else:
            out.append(text[i])
            i += 1
            continue
        out.append(re.sub(r"[^\n]", " ", text[i:j]))
        i = j
    return "".join(out)


def string_end(text, j, quote):
    while j < len(text):
        c = text[j]
        if c == "\\":
            j += 2
        elif c == quote:
            return j + 1
        elif c == "\n" and quote != "`":
            return j
        else:
            j += 1
    return len(text)


def verbatim_end(text, j):
    while j < len(text):
        if text[j] != '"':
            j += 1
        elif text[j + 1 : j + 2] == '"':
            j += 2
        else:
            return j + 1
    return len(text)


def declarations(code, name, lo, hi):
    found = []
    for m in re.compile(rf"(?<![\w$.]){re.escape(name)}(?![\w$])").finditer(code, lo, hi):
        at, after = m.span()
        prefix = ATTRIBUTES.sub("", code[code.rfind("\n", 0, at) + 1 : at].strip())
        words = prefix.split()
        last = words[-1] if words else None
        nxt = NEXT.match(code, after)
        nxt = nxt and nxt.group(1)
        if last in TYPE_WORDS:
            ok = True
        elif last in VARIABLE_WORDS:
            ok = nxt == "="
        elif not nxt or not PREFIX.fullmatch(prefix) or prefix.endswith("."):
            ok = False
        elif last == "new" or any(w in KEYWORDS for w in words):
            ok = False
        else:
            ok = bool(words) or nxt == "("
        if not ok:
            continue
        has_body, end = body_end(code, after)
        if words or has_body:
            found.append((at, after, min(end, hi - 1)))
    return found


def body_end(code, k):
    depth = 0
    while k < len(code):
        c = code[k]
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif depth == 0 and c == "{":
            return True, closing(code, k)
        elif depth == 0 and c == ";":
            return False, k
        elif depth == 0 and code.startswith("=>", k):
            return True, arrow_end(code, k + 2)
        elif depth == 0 and c == "}":
            return False, k - 1
        if depth < 0:
            return False, k - 1
        k += 1
    return False, len(code) - 1


def arrow_end(code, k):
    while k < len(code) and code[k].isspace():
        k += 1
    if code[k : k + 1] == "{":
        return closing(code, k)
    depth = 0
    while k < len(code):
        c = code[k]
        depth += (c in "([{") - (c in ")]}")
        if depth < 0:
            return k - 1
        if depth == 0 and c == ";":
            return k
        k += 1
    return len(code) - 1


def closing(code, k):
    depth = 0
    while k < len(code):
        depth += (code[k] == "{") - (code[k] == "}")
        if depth == 0:
            return k
        k += 1
    return len(code) - 1


def line_of(code, index):
    return code.count("\n", 0, index) + 1
