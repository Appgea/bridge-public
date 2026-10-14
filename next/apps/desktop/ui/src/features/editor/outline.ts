/**
 * The file's outline — what Xcode's jump bar and ⌃6 menu list: types, functions, properties, and
 * the `// MARK:` sections that divide them.
 *
 * Pure text in, items out, no CodeMirror. Half the languages Panel opens are stream grammars
 * with no real syntax tree (Swift, Dart, Kotlin), and an outline that worked for TypeScript but
 * went blank on Swift would teach the reader not to trust it. So it is one line scan with a small
 * rule set per language family, and scope comes from indentation — which every one of these
 * languages follows in practice, and which is exactly what a reader uses to see nesting.
 *
 * Cheap enough to run on every pause in typing: one regex pass per line, and a forward walk per
 * item that stops at the item's own scope end.
 */

export type OutlineKind =
  | "class"
  | "struct"
  | "enum"
  | "protocol"
  | "extension"
  | "type"
  | "function"
  | "method"
  | "property"
  | "constant"
  | "case"
  | "mark"
  | "todo"
  | "section";

export type OutlineItem = {
  name: string;
  kind: OutlineKind;
  /** 1-indexed line the item is declared on. */
  line: number;
  /** Last line of its scope, inclusive. Equal to `line` for a one-line item or a mark. */
  end: number;
  /** Nesting depth: 0 at the top of the file. */
  depth: number;
  /** A `MARK: -` asks for a rule above it in the menu. */
  separator?: boolean;
};

type Family = "swift" | "ts" | "rust" | "python" | "dart" | "kotlin" | "go" | "clike" | "markdown" | "css" | "shell" | "keys" | "none";

const FAMILY: Record<string, Family> = {
  swift: "swift",
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  rs: "rust",
  py: "python", pyi: "python",
  dart: "dart",
  kt: "kotlin", kts: "kotlin",
  go: "go",
  java: "clike", c: "clike", h: "clike", cc: "clike", cpp: "clike", cxx: "clike", hpp: "clike", hh: "clike", m: "clike", mm: "clike", cs: "clike",
  md: "markdown", markdown: "markdown",
  css: "css", scss: "css", less: "css",
  sh: "shell", bash: "shell", zsh: "shell",
  yml: "keys", yaml: "keys", toml: "keys",
};

/** Words that look like `name(` but are statements, not declarations. */
const CONTROL = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "await", "throw", "super", "this",
  "else", "do", "try", "guard", "when", "with", "elif", "assert", "sizeof", "typeof", "print",
  "function", "async", "yield", "case", "defer", "repeat", "in", "of", "match", "loop", "unless",
  "void", "delete", "not", "and", "or",
]);

const TYPE_KINDS = new Set<OutlineKind>(["class", "struct", "enum", "protocol", "extension", "type"]);
const CALLABLE = new Set<OutlineKind>(["function", "method"]);

const KIND_WORD: Record<string, OutlineKind> = {
  class: "class",
  actor: "class",
  object: "class",
  struct: "struct",
  enum: "enum",
  protocol: "protocol",
  interface: "protocol",
  trait: "protocol",
  mixin: "protocol",
  extension: "extension",
  impl: "extension",
  type: "type",
  typealias: "type",
  typedef: "type",
  mod: "type",
  namespace: "type",
};

function indentOf(text: string): number {
  let columns = 0;
  for (const character of text) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4;
    else break;
  }
  return columns;
}

/** `func load(_ url: URL, force: Bool)` → `load(_:force:)`, the way Xcode names it. */
function swiftSignature(name: string, rest: string): string {
  const open = rest.indexOf("(");
  if (open < 0) return name;
  let depth = 0;
  let close = rest.length;
  for (let index = open; index < rest.length; index++) {
    if (rest[index] === "(") depth += 1;
    else if (rest[index] === ")" && --depth === 0) {
      close = index;
      break;
    }
  }
  const params = rest.slice(open + 1, close).trim();
  if (!params) return `${name}()`;
  const labels: string[] = [];
  let level = 0;
  let piece = "";
  for (const character of params + ",") {
    if (character === "(" || character === "<" || character === "[") level += 1;
    if (character === ")" || character === ">" || character === "]") level -= 1;
    if (character === "," && level === 0) {
      const label = piece.trim().split(/[\s:]/)[0];
      if (label) labels.push(`${label}:`);
      piece = "";
    } else {
      piece += character;
    }
  }
  return `${name}(${labels.join("")})`;
}

type Candidate = { name: string; kind: OutlineKind; separator?: boolean };

/* ------------------------------------------------------------- comments */

/** `// MARK: - Networking`, `# TODO: x`, and the dashed comment banners this codebase uses. */
function commentItem(trimmed: string, family: Family): Candidate | null {
  const body = /^(?:\/\/+|\/\*+|#+(?!!)|--|\*)\s*(.*?)\s*(?:\*\/)?$/.exec(trimmed)?.[1];
  if (body === undefined) return null;
  if (family === "python" || family === "shell" || family === "keys") {
    if (!trimmed.startsWith("#")) return null;
  } else if (trimmed.startsWith("#")) {
    if (!/^#pragma\s+mark\b/.test(trimmed)) return null;
    const title = trimmed.replace(/^#pragma\s+mark\s*/, "");
    const separator = title.startsWith("-");
    const name = title.replace(/^-\s*/, "").trim();
    return name ? { name, kind: "mark", separator } : null;
  }
  const mark = /^MARK:\s*(-)?\s*(.*)$/.exec(body);
  if (mark) {
    const name = mark[2].trim();
    return name ? { name, kind: "mark", separator: Boolean(mark[1]) } : null;
  }
  const todo = /^(TODO|FIXME)\b:?\s*(.*)$/.exec(body);
  if (todo) return { name: `${todo[1]}: ${todo[2].trim()}`.trim(), kind: "todo" };
  // A rule of dashes with a label on either side: `---------- the tree` or `-- flash --`.
  const banner = /^-{4,}\s*([^-].*?)\s*-*$/.exec(body) ?? /^(\S.*?)\s*-{4,}$/.exec(body);
  if (banner && banner[1].length <= 48) return { name: banner[1], kind: "mark", separator: true };
  return null;
}

/* ------------------------------------------------------------ declarations */

const SWIFT_DECL = /^(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|final|static|class|override|mutating|nonmutating|nonisolated|lazy|weak|unowned|required|convenience|dynamic|indirect|distributed|package)(?:\([^)]*\))?\s+)*(class|struct|enum|protocol|extension|actor|func|init|deinit|subscript|var|let|typealias|case)\b\s*(.*)$/;

function swiftItem(trimmed: string, parent: OutlineItem | undefined): Candidate | null {
  const match = SWIFT_DECL.exec(trimmed);
  if (!match) return null;
  const [, word, rest] = match;
  // `class func` / `class var` arrive as word "class" with the real keyword in `rest`.
  if (word === "class" && /^(?:func|var|let)\b/.test(rest)) return swiftItem(rest, parent);
  const inType = !parent || TYPE_KINDS.has(parent.kind);
  switch (word) {
    case "func": {
      const name = /^([^\s(<]+)/.exec(rest)?.[1];
      if (!name) return null;
      return { name: swiftSignature(name, rest.slice(name.length)), kind: parent && TYPE_KINDS.has(parent.kind) ? "method" : "function" };
    }
    case "init":
    case "subscript":
      return inType ? { name: swiftSignature(word + (rest.startsWith("?") ? "?" : ""), rest), kind: "method" } : null;
    case "deinit":
      return inType ? { name: "deinit", kind: "method" } : null;
    case "var":
    case "let": {
      if (!inType) return null;
      const name = /^\(?\s*([A-Za-z_]\w*)/.exec(rest)?.[1];
      return name ? { name, kind: word === "let" && !parent ? "constant" : "property" } : null;
    }
    case "case": {
      if (parent?.kind !== "enum") return null;
      const name = /^([A-Za-z_]\w*)/.exec(rest)?.[1];
      return name ? { name, kind: "case" } : null;
    }
    default: {
      const name = /^([A-Za-z_][\w.]*)/.exec(rest)?.[1];
      return name ? { name, kind: KIND_WORD[word] ?? "type" } : null;
    }
  }
}

const TS_TYPE = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:(class|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=)/;
const TS_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const TS_ARROW = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|\($)/;
const TS_CONST = /^export\s+const\s+([A-Za-z_$][\w$]*)|^const\s+([A-Z][A-Z0-9_]+)\s*(?::|=)/;
const TS_FIELD_ARROW = /^(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
const TS_METHOD = /^(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set|declare)\s+)*(\*?\s*#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)?/;

function tsItem(trimmed: string, depth: number, parent: OutlineItem | undefined): Candidate | null {
  let match = TS_TYPE.exec(trimmed);
  if (match) {
    if (match[3]) return { name: match[3], kind: "type" };
    return { name: match[2], kind: match[1] === "interface" ? "protocol" : KIND_WORD[match[1]] ?? "type" };
  }
  match = TS_FUNCTION.exec(trimmed);
  if (match) return { name: match[1], kind: "function" };
  match = TS_ARROW.exec(trimmed);
  if (match) return { name: match[1], kind: "function" };
  if (depth === 0) {
    match = TS_CONST.exec(trimmed);
    if (match) return { name: match[1] ?? match[2], kind: "constant" };
  }
  if (parent && TYPE_KINDS.has(parent.kind)) {
    match = TS_FIELD_ARROW.exec(trimmed);
    if (match) return { name: match[1], kind: "method" };
  }
  match = TS_METHOD.exec(trimmed);
  if (match) {
    const name = match[1].replace(/^\*\s*/, "");
    const args = (match[2] ?? "").trim();
    const ends = /(?:\{|\($)\s*$/.test(trimmed) && !trimmed.endsWith(";");
    // A call that takes a callback (`it("x", () => {`, `setTimeout(() => {`) ends in a brace
    // too. A declaration's parameters never open with a string or a paren, nor hold an arrow.
    if (ends && !CONTROL.has(name) && !/^["'`(]/.test(args) && !/=>|\bfunction\b/.test(args)) {
      return { name, kind: parent && TYPE_KINDS.has(parent.kind) ? "method" : "function" };
    }
  }
  return null;
}

const RUST_DECL = /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|trait|impl|mod|type|const|static|macro_rules!)(?:\b|(?<=!))\s*(?:<[^>]*>\s*)?([A-Za-z_][\w]*)?(.*)$/;

function rustItem(trimmed: string, parent: OutlineItem | undefined): Candidate | null {
  const match = RUST_DECL.exec(trimmed);
  if (!match) return null;
  const [, word, rawName, rest] = match;
  if (word === "impl") {
    // `impl Display for Session` names the type the block belongs to.
    const body = `${rawName ?? ""}${rest}`.replace(/\{.*$/, "").trim();
    const forType = /\bfor\s+([A-Za-z_][\w:<>]*)/.exec(body)?.[1];
    return { name: forType ? `${forType}: ${body.split(/\s+for\s+/)[0]}` : body, kind: "extension" };
  }
  if (!rawName) return null;
  if (word === "fn") return { name: rawName, kind: parent && TYPE_KINDS.has(parent.kind) ? "method" : "function" };
  if (word === "const" || word === "static") return { name: rawName, kind: "constant" };
  if (word === "macro_rules!") return { name: `${rawName}!`, kind: "function" };
  return { name: rawName, kind: KIND_WORD[word] ?? "type" };
}

function pythonItem(trimmed: string, parent: OutlineItem | undefined): Candidate | null {
  const match = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(trimmed);
  if (!match) return null;
  if (match[1] === "class") return { name: match[2], kind: "class" };
  return { name: match[2], kind: parent?.kind === "class" ? "method" : "function" };
}

const CLIKE_TYPE = /^(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|inner|enum|annotation|value|partial|export)\s+)*(class|struct|enum|interface|mixin|extension|object|typedef|trait|namespace)\s+([A-Za-z_]\w*)/;

/** Return type, name, parameters — the shape a Dart, Java, Go or C function line has. */
function clikeFunction(trimmed: string, parent: OutlineItem | undefined): Candidate | null {
  const match = /^(.*?)\b([A-Za-z_~]\w*)\s*(?:<[^<>()]*>)?\s*\((.*)$/.exec(trimmed);
  if (!match) return null;
  const [, prefix, name, rest] = match;
  // `child: Text(` and `vsAi: Stats(` are named arguments; C++'s `Type::name(` keeps its `::`.
  if (CONTROL.has(name) || /[=.(,!]|(?:^|[^:]):(?!:)|\breturn\b|\bawait\b|\bthrow\b|\bnew\b/.test(prefix)) return null;
  if (/^\s*\(|=>\s*\{?\s*$/.test(rest) && !/\)\s*(?:async\*?\s*)?=>/.test(rest)) return null;
  if (/["']/.test(rest.split(")")[0])) return null;
  const tail = trimmed.replace(/\/\/.*$/, "").trim();
  const opens = /\{$/.test(tail) || /\)\s*(?:async\*?|sync\*)?\s*=>/.test(tail) || /\($/.test(tail);
  if (!opens || (tail.endsWith(";") && !tail.includes("=>"))) return null;
  // A bare `Name(` with no return type is a constructor — or, far more often, a widget or a
  // call in an argument list. Only the constructor of the enclosing type is kept.
  if (!prefix.trim()) {
    if (!parent || !TYPE_KINDS.has(parent.kind) || parent.name !== name) return null;
  }
  return { name, kind: parent && TYPE_KINDS.has(parent.kind) ? "method" : "function" };
}

function dartItem(trimmed: string, parent: OutlineItem | undefined): Candidate | null {
  const type = CLIKE_TYPE.exec(trimmed);
  if (type) return { name: type[2], kind: KIND_WORD[type[1]] ?? "type" };
  const getter = /^(?:static\s+)?(?:[\w<>?,\s]+\s+)?(get|set)\s+([A-Za-z_]\w*)/.exec(trimmed);
  if (getter && /(?:=>|\{)/.test(trimmed)) return { name: getter[2], kind: "property" };
  return clikeFunction(trimmed, parent);
}

function kotlinItem(trimmed: string, parent: OutlineItem | undefined): Candidate | null {
  const type = CLIKE_TYPE.exec(trimmed);
  if (type) return { name: type[2], kind: KIND_WORD[type[1]] ?? "type" };
  const fun = /^(?:(?:public|private|protected|internal|override|open|suspend|inline|operator|infix|tailrec|abstract|final)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/.exec(trimmed);
  if (fun) return { name: fun[1], kind: parent && TYPE_KINDS.has(parent.kind) ? "method" : "function" };
  const prop = /^(?:(?:public|private|protected|internal|override|open|lateinit|const)\s+)*(val|var)\s+([A-Za-z_]\w*)/.exec(trimmed);
  if (prop && (!parent || TYPE_KINDS.has(parent.kind))) return { name: prop[2], kind: "property" };
  return null;
}

function goItem(trimmed: string): Candidate | null {
  const fn = /^func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)/.exec(trimmed);
  if (fn) {
    const receiver = fn[1]?.trim().split(/\s+/).pop()?.replace(/^\*/, "");
    return { name: receiver ? `${receiver}.${fn[2]}` : fn[2], kind: receiver ? "method" : "function" };
  }
  const type = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)?/.exec(trimmed);
  if (type) return { name: type[1], kind: type[2] === "interface" ? "protocol" : type[2] === "struct" ? "struct" : "type" };
  return null;
}

function clikeItem(trimmed: string, parent: OutlineItem | undefined): Candidate | null {
  const type = CLIKE_TYPE.exec(trimmed);
  if (type) return { name: type[2], kind: KIND_WORD[type[1]] ?? "type" };
  if (/^[@#]/.test(trimmed)) return null;
  return clikeFunction(trimmed, parent);
}

function declaration(family: Family, trimmed: string, indent: number, parent: OutlineItem | undefined): Candidate | null {
  switch (family) {
    case "swift": return swiftItem(trimmed, parent);
    case "ts": return tsItem(trimmed, indent === 0 ? 0 : 1, parent);
    case "rust": return rustItem(trimmed, parent);
    case "python": return pythonItem(trimmed, parent);
    case "dart": return dartItem(trimmed, parent);
    case "kotlin": return kotlinItem(trimmed, parent);
    case "go": return indent === 0 ? goItem(trimmed) : null;
    case "clike": return clikeItem(trimmed, parent);
    case "css": {
      if (indent > 0) return null;
      const rule = /^([^{}/;][^{};]*?)\s*\{\s*$/.exec(trimmed);
      return rule ? { name: rule[1], kind: rule[1].startsWith("@") ? "section" : "property" } : null;
    }
    case "shell": {
      const fn = /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/.exec(trimmed) ?? /^function\s+([A-Za-z_][\w-]*)/.exec(trimmed);
      return fn ? { name: fn[1], kind: "function" } : null;
    }
    case "keys": {
      if (indent > 0) return null;
      const table = /^\[\[?([^\]]+)\]\]?/.exec(trimmed);
      if (table) return { name: table[1], kind: "section" };
      const key = /^([A-Za-z_][\w.-]*)\s*:(?:\s|$)/.exec(trimmed);
      return key ? { name: key[1], kind: "property" } : null;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ scope */

/**
 * The last line (0-indexed) an item at `indent` owns. A closing bracket back at its own indent belongs to it;
 * any other line at that indent, or shallower, does not. Blank lines never decide.
 */
function scopeEnd(lines: string[], start: number, indent: number): number {
  let last = start;
  for (let index = start + 1; index < lines.length; index++) {
    const text = lines[index];
    if (!text.trim()) continue;
    const here = indentOf(text);
    if (here > indent) {
      last = index;
      continue;
    }
    if (here === indent && /^\s*(?:[}\])]|end\b)/.test(text)) {
      // `) -> Result<T> {` closes a parameter list and opens the body: still this item.
      if (/[{([]\s*$/.test(text)) {
        last = index;
        continue;
      }
      return index;
    }
    return last;
  }
  return last;
}

/** The outline of `text`, read as the language `extension` names. */
export function outline(text: string, extension: string): OutlineItem[] {
  const family = FAMILY[extension] ?? "none";
  const lines = text.split("\n");
  const items: OutlineItem[] = [];
  /** Items whose scope is still open, outermost first. */
  const open: OutlineItem[] = [];

  if (family === "markdown") {
    let fence = false;
    lines.forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) items.push({ name: heading[2], kind: "section", line: index + 1, end: index + 1, depth: heading[1].length - 1 });
    });
    for (let index = 0; index < items.length; index++) {
      const next = items.slice(index + 1).find((item) => item.depth <= items[index].depth);
      items[index].end = next ? next.line - 1 : lines.length;
    }
    return items;
  }
  if (family === "none") return items;

  let blockComment = false;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    const trimmed = text.trim();
    if (!trimmed) continue;
    const line = index + 1;
    while (open.length && open[open.length - 1].end < line) open.pop();
    const parent = open[open.length - 1];

    const commentLine =
      blockComment ||
      /^(?:\/\/|\/\*|\*|--\s)/.test(trimmed) ||
      (trimmed.startsWith("#") && family !== "rust" && family !== "css");
    if (trimmed.includes("/*") && !trimmed.includes("*/")) blockComment = true;
    else if (blockComment && trimmed.includes("*/")) blockComment = false;
    if (commentLine) {
      const mark = commentItem(trimmed, family);
      if (mark) items.push({ ...mark, line, end: line, depth: open.length });
      continue;
    }
    if (parent && CALLABLE.has(parent.kind) && family !== "ts" && family !== "python") {
      // Inside a function body only nested functions count — never its locals.
      if (!/\b(?:func|fun|fn|def)\b/.test(trimmed)) continue;
    }

    const indent = indentOf(text);
    const found = declaration(family, trimmed, indent, parent);
    if (!found) continue;
    const item: OutlineItem = { ...found, line, end: scopeEnd(lines, index, indent) + 1, depth: open.length };
    items.push(item);
    open.push(item);
  }
  return items;
}

/** The items whose scope holds `line`, outermost first — the jump bar's trailing crumbs. */
export function scopeAt(items: readonly OutlineItem[], line: number): OutlineItem[] {
  const chain: OutlineItem[] = [];
  for (const item of items) {
    if (item.line > line) break;
    if (item.kind === "mark" || item.kind === "todo" || item.end < line) continue;
    while (chain.length && chain[chain.length - 1].depth >= item.depth) chain.pop();
    chain.push(item);
  }
  return chain;
}

/** The mark (section) the line sits under, if the file has any. */
export function markAt(items: readonly OutlineItem[], line: number): OutlineItem | null {
  let found: OutlineItem | null = null;
  for (const item of items) {
    if (item.line > line) break;
    if (item.kind === "mark") found = item;
  }
  return found;
}
