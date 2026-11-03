// Finds the line range of a snippet in the text of a source file, from the
// properties of one Snippets row. Returns { start, end }, 1-based and inclusive.
//
//   { start: 36, end: 42 }                 lines 36 to 42 of the file
//   { method: "Total" }                    the declaration named Total
//   { method: "OrderService.Total" }       Total inside the OrderService declaration
//   { method: "Total", overload: 2 }       the second declaration named Total
//   { method: "Total", before: 3, after: 2 }  plus 3 lines before and 2 lines after
//
// With a method, start and end are not used. Without start and end, the range is the whole file.
// A declaration is a method, constructor, property, field, or type. Works for C-like
// languages: C#, TypeScript, JavaScript, Java. Comments and strings are masked before
// the search, so a name or a brace inside them does not count.
// Known limits: JavaScript regex literals that contain braces, tuple return types,
// and arrow functions that do not end with a semicolon.

const KEYWORDS = new Set(
  "return await throw yield else case typeof delete in of is as if while for foreach switch catch using lock nameof sizeof"
    .split(" "),
);
const TYPE_WORDS = new Set(["class", "struct", "record", "interface", "enum", "namespace", "module", "function"]);
const VARIABLE_WORDS = new Set(["const", "let", "var"]);

export function snippetRange(text, { method, overload = 1, start, end, before = 0, after = 0 } = {}) {
  const src = text.replace(/\r/g, "");
  const count = src.split("\n").length - (src.endsWith("\n") ? 1 : 0);
  const clamp = (n) => Math.min(count, Math.max(1, n));
  for (const [name, n] of Object.entries({ overload, before, after })) {
    if (!Number.isInteger(n) || n < (name === "overload" ? 1 : 0)) throw new Error(`${name} must be a whole number, not ${n}.`);
  }

  if (!method) {
    const from = start ?? 1;
    const to = end ?? count;
    if (from < 1 || to < from) throw new Error(`Bad line range ${from}-${to}.`);
    if (from > count) throw new Error(`Line ${from} is outside the file (${count} lines).`);
    return { start: clamp(from - before), end: clamp(to + after) };
  }

  const decl = findDeclaration(mask(src), method, overload);
  return { start: clamp(decl.start - before), end: clamp(decl.end + after) };
}

// Each part of "Outer.Inner" is searched inside the declaration of the part before it.
function findDeclaration(code, method, overload) {
  const path = method.split(".");
  if (!path.every((p) => /^[A-Za-z_$][\w$]*$/.test(p))) throw new Error(`Bad method name "${method}".`);
  let from = 0;
  let to = code.length;
  let decl;
  path.forEach((name, i) => {
    const label = path.slice(0, i + 1).join(".");
    const found = declarations(code, name, from, to);
    const pick = i === path.length - 1 ? overload : 1;
    if (found.length === 0) throw new Error(`No declaration named "${label}" in the file.`);
    if (pick > found.length) throw new Error(`Only ${found.length} declaration(s) named "${label}" in the file.`);
    decl = found[pick - 1];
    from = decl.after;
    to = decl.end + 1;
  });
  return { start: lineOf(code, decl.at), end: lineOf(code, decl.end) };
}

// Replaces comments and string contents with spaces. Keeps the length and the line breaks.
export function mask(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    let j;
    if (c === "/" && d === "/") j = endOf(text, text.indexOf("\n", i), 0);
    else if (c === "/" && d === "*") j = endOf(text, text.indexOf("*/", i + 2), 2);
    else if (text.startsWith('@"', i) || text.startsWith('$@"', i) || text.startsWith('@$"', i)) j = verbatimEnd(text, text.indexOf('"', i) + 1);
    else if (c === '"' || c === "'" || c === "`") j = stringEnd(text, i + 1, c);
    else {
      out += c;
      i++;
      continue;
    }
    out += text.slice(i, j).replace(/[^\n]/g, " ");
    i = j;
  }
  return out;
}

const endOf = (text, at, length) => (at < 0 ? text.length : at + length);

function stringEnd(text, j, quote) {
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") j += 2;
    else if (c === quote) return j + 1;
    else if (c === "\n" && quote !== "`") return j;
    else j++;
  }
  return text.length;
}

// C# verbatim string: a backslash is a normal character and "" is one quote.
function verbatimEnd(text, j) {
  while (j < text.length) {
    if (text[j] !== '"') j++;
    else if (text[j + 1] === '"') j += 2;
    else return j + 1;
  }
  return text.length;
}

// Finds the declarations of one name in code[from, to). Skips calls and other uses.
function declarations(code, name, from, to) {
  const found = [];
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  re.lastIndex = from;
  for (let m = re.exec(code); m && m.index < to; m = re.exec(code)) {
    const at = m.index;
    const after = at + name.length;
    const prefix = code.slice(code.lastIndexOf("\n", at - 1) + 1, at).trim();
    const words = prefix ? prefix.split(/\s+/) : [];
    const last = words.at(-1);
    const next = code.slice(after).match(/^\s*(?:<[^<>()]*>)?\s*(\(|=>|\{|=|;|:)/)?.[1];

    let ok;
    if (TYPE_WORDS.has(last)) ok = true;
    else if (VARIABLE_WORDS.has(last)) ok = next === "=";
    else if (!next || !/^[\w$<>[\]?,.@\s]*$/.test(prefix) || prefix.endsWith(".")) ok = false;
    else if (words.some((w) => KEYWORDS.has(w)) || last === "new") ok = false;
    else ok = words.length > 0 || next === "(";
    if (!ok) continue;

    const body = bodyEnd(code, after);
    // Without a type or a modifier before it, "Name(...)" is a declaration only if a body follows.
    if (words.length === 0 && body.kind === "statement") continue;
    found.push({ at, after, end: Math.min(body.end, to - 1) });
  }
  return found;
}

// Finds where the declaration that starts at pos ends: a { } block, a => expression or a ;.
function bodyEnd(code, pos) {
  let depth = 0;
  for (let k = pos; k < code.length; k++) {
    const c = code[k];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && c === "{") return { kind: "block", end: closing(code, k) };
    else if (depth === 0 && c === ";") return { kind: "statement", end: k };
    else if (depth === 0 && c === "=" && code[k + 1] === ">") return { kind: "arrow", end: arrowEnd(code, k + 2) };
    else if (depth === 0 && c === "}") return { kind: "statement", end: k - 1 };
    if (depth < 0) return { kind: "statement", end: k - 1 };
  }
  return { kind: "statement", end: code.length - 1 };
}

function arrowEnd(code, k) {
  while (/\s/.test(code[k] ?? "")) k++;
  if (code[k] === "{") return closing(code, k);
  let depth = 0;
  for (; k < code.length; k++) {
    const c = code[k];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (depth < 0) return k - 1;
    if (depth === 0 && c === ";") return k;
  }
  return code.length - 1;
}

function closing(code, open) {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === "{") depth++;
    else if (code[k] === "}" && --depth === 0) return k;
  }
  return code.length - 1;
}

function lineOf(code, index) {
  let line = 1;
  for (let k = code.indexOf("\n"); k !== -1 && k < index; k = code.indexOf("\n", k + 1)) line++;
  return line;
}
