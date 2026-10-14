/**
 * Dev harness for the Work tab's editor. NOT part of the app build — index.html never loads it.
 * It mounts the REAL Work pane against an in-memory project, so the jump bar, Open Quickly, the
 * gutter, the minimap and the Xcode palette can be looked at, and screenshotted headless, without
 * Tauri. The backend is a small fake `invoke`. Nothing here touches disk.
 *
 * Query: ?theme=light  ?file=<path>  ?line=<n>
 */
import "./style.css";
import sessionStore from "./dev_editor_fixtures/SessionStore.swift?raw";
import user from "./dev_editor_fixtures/User.swift?raw";
import coreSource from "./features/editor/core.ts?raw";
import outlineText from "./features/editor/outline.ts?raw";
import filesSource from "./features/files.ts?raw";
import { outline } from "./features/editor/outline";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { languageFor } from "./features/editor/languages";
import { highlightActiveLine, highlightSpecialChars, highlightTrailingWhitespace, drawSelection } from "@codemirror/view";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search } from "@codemirror/search";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { history } from "@codemirror/commands";
import { semanticHighlight, symbolSource } from "./features/editor/semantic";
import { minimap, outlineSource } from "./features/editor/minimap";
import { stickyScroll } from "./features/editor/sticky_scroll";
import { indentGuides } from "./features/editor/indent_guides";
import { themePacks } from "./features/editor/theme";
import { changeGutter } from "./features/editor/change_hunks";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";

const FILES: Record<string, string> = {
  "Sources/App/SessionStore.swift": sessionStore,
  "Sources/App/Models/User.swift": user,
  "ui/editor/core.ts": coreSource,
  "ui/editor/outline.ts": outlineText,
  "ui/files.ts": filesSource,
  "README.md": "# Kelimelik\n\nA word game.\n\n## Build\n\nOpen the package in Xcode.\n",
  "Package.swift": "// swift-tools-version: 5.9\nimport PackageDescription\n\nlet package = Package(name: \"Kelimelik\")\n",
};

/** HEAD differs from the working copy, so the change bars and minimap strip have something to show. */
const HEAD: Record<string, string> = {
  "Sources/App/SessionStore.swift": sessionStore
    .replace("    static let refreshMargin: TimeInterval = 5 * 60\n", "    static let refreshMargin: TimeInterval = 60\n")
    .replace("        // TODO: tell the server, so the refresh token dies too.\n", "")
    .replace("    deinit {\n        refreshTask?.cancel()\n    }\n\n", "")
    + "\n// Removed at the end.\n",
};

type Entry = { name: string; is_dir: boolean };

function readDir(dir: string): Entry[] {
  const prefix = dir ? `${dir}/` : "";
  const seen = new Map<string, boolean>();
  for (const path of Object.keys(FILES)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const [head, ...tail] = rest.split("/");
    seen.set(head, (seen.get(head) ?? false) || tail.length > 0);
  }
  return [...seen.entries()]
    .map(([name, is_dir]) => ({ name, is_dir }))
    .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
}

const KINDS: Record<string, string> = {
  class: "class", struct: "struct", enum: "enum", protocol: "protocol", type: "type",
  function: "function", method: "function", constant: "constant",
};

function projectSymbols(): { name: string; path: string; line: number; kind: string }[] {
  const found: { name: string; path: string; line: number; kind: string }[] = [];
  for (const [path, text] of Object.entries(FILES)) {
    const extension = path.split(".").pop() ?? "";
    for (const item of outline(text, extension)) {
      const kind = KINDS[item.kind];
      if (kind) found.push({ name: item.name, path, line: item.line, kind });
    }
  }
  return found;
}

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  read_dir: (args) => readDir(String(args.path ?? "")),
  project_files: () => Object.keys(FILES),
  read_file: (args) => {
    const text = FILES[String(args.path)];
    if (text === undefined) throw new Error("No such file");
    return text;
  },
  write_file: (args) => {
    FILES[String(args.path)] = String(args.contents);
    return null;
  },
  git_head_file: (args) => HEAD[String(args.path)] ?? FILES[String(args.path)] ?? null,
  git_file_states: () => ({ "Sources/App/SessionStore.swift": "modified" }),
  file_relationships: (args) =>
    args.path === "Sources/App/SessionStore.swift"
      ? [
          { path: "Sources/App/Models/User.swift", line: 3, direction: "outgoing", detail: "User" },
          { path: "Package.swift", line: 1, direction: "incoming", detail: "target App" },
        ]
      : [],
  project_symbols: projectSymbols,
  symbol_locations: (args) =>
    projectSymbols()
      .filter((symbol) => symbol.name === args.symbol)
      .map((symbol) => ({ path: symbol.path, line: symbol.line, detail: symbol.kind })),
  debug_breakpoints: () => ({ "Sources/App/SessionStore.swift": [86, 101] }),
  debug_set_breakpoints: () => null,
  module_request: () => ({}),
  search_project: () => [],
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`harness: no fake for ${command}`);
    return handler(args);
  },
  transformCallback: () => 0,
};

const { mountFiles } = await import("./features/files");
const host = document.getElementById("work")!;
const work = mountFiles(host);
work.setProject("demo", "/Users/demo/Kelimelik");
await work.open(params.get("file") ?? "Sources/App/SessionStore.swift", Number(params.get("line") ?? 0) || undefined);
(window as unknown as { __work: unknown }).__work = work;
// The live view, for timing keystrokes from a headless script.
(window as unknown as { __cm: () => EditorView | null }).__cm = () =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>("#work .cm-editor")!);
document.body.dataset.ready = "1";

// A bare editor over the same text, for a baseline: what CodeMirror alone costs per keystroke.
(window as unknown as { __bare: (extra?: Extension[]) => EditorView }).__bare = (extra = []) => {
  const parent = document.createElement("div");
  parent.style.cssText = "position:fixed;inset:0;z-index:999;background:#1f1f24";
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({ doc: filesSource, extensions: [lineNumbers(), ...languageFor("x.ts"), ...extra] }),
  });
};

// The pieces of the shared editor, one at a time, for bisecting keystroke cost.
const staticOutline = {
  items: (state: EditorState) => outline(state.doc.toString(), "ts"),
  refresh: () => undefined,
};
(window as unknown as { __parts: Record<string, () => Extension> }).__parts = {
  none: () => [],
  theme: () => themePacks.dark,
  semantic: () => [symbolSource.of(() => ({ types: new Set(["EditorState"]), others: new Set() })), semanticHighlight()],
  minimap: () => [outlineSource.of(staticOutline), minimap()],
  sticky: () => [outlineSource.of(staticOutline), stickyScroll()],
  guides: () => indentGuides(),
  matches: () => highlightSelectionMatches({ minSelectionLength: 2, maxMatches: 500 }),
  basics: () => [history(), drawSelection(), highlightActiveLine(), highlightSpecialChars(), highlightTrailingWhitespace(), bracketMatching(), indentOnInput(), closeBrackets(), autocompletion(), search({ top: true })],
  fold: () => foldGutter(),
  changes: () => changeGutter("x.ts", {}),
};
