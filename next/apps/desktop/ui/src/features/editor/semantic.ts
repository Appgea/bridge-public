/**
 * Xcode's colour rule for names, which no token theme can express on its own.
 *
 * A grammar only knows that `session` is a variable and `Session` a type. Xcode goes further and
 * asks WHOSE name it is: one the project declares wears teal, one the SDK brings wears purple,
 * and the place a name is declared wears its own blue. That is what makes a line readable at a
 * glance — "this is ours, that is Foundation's" — and it is most of why the Xcode buffer feels
 * the way it does.
 *
 * This plugin re-walks only the visible ranges, with a role highlighter that sorts identifier
 * tokens into roles; each role plus the project's symbol table (served by Rust from the same
 * facts cache go-to-definition uses) picks a `cm-xc-*` class, whose colour lives in theme.ts.
 * Stream grammars (Swift, Dart, Kotlin) call every name a "variable", so capitalisation and a
 * following `(` stand in for what their parser cannot say — the same guess a reader makes.
 *
 * The same pass marks MARK/TODO/FIXME comments, links in comments, documentation keywords, and
 * every other use of the symbol under the caret (Xcode's "Highlight instances of selected
 * symbol") — only identifiers, so resting on `return` lights nothing.
 */

import { Facet, RangeSetBuilder, StateEffect, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";

/** The project's own names, split the way Xcode colours them. */
export type SymbolTable = {
  /** Types, classes, structs, protocols, enums — Xcode's "Project Class / Type Names". */
  types: ReadonlySet<string>;
  /** Functions and top-level constants — "Project Function, Constant and Variable Names". */
  others: ReadonlySet<string>;
};

/** Where the plugin asks for the table. A host with no project leaves it returning null. */
export const symbolSource = Facet.define<() => SymbolTable | null, () => SymbolTable | null>({
  combine: (values) => values[0] ?? (() => null),
});

/** The host fetched a fresh table. Repaint the visible names. */
export const refreshSymbols = StateEffect.define<null>();

/**
 * Roles, not colours. `xr-` keeps them apart from the token theme's generated class names when
 * both highlighters run over one span (sticky scroll does exactly that).
 */
export const roleHighlighter = tagHighlighter([
  { tag: [t.definition(t.className), t.definition(t.typeName)], class: "xr-declType" },
  {
    tag: [t.definition(t.variableName), t.definition(t.propertyName), t.function(t.definition(t.variableName))],
    class: "xr-decl",
  },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], class: "xr-type" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "xr-call" },
  { tag: t.propertyName, class: "xr-prop" },
  { tag: [t.variableName, t.special(t.variableName)], class: "xr-var" },
  { tag: t.standard(t.variableName), class: "xr-std" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "xr-comment" },
]);

/** Roles that name a symbol. Only these can light up as "another use of the caret's symbol". */
const NAMING = new Set(["xr-declType", "xr-decl", "xr-type", "xr-call", "xr-prop", "xr-var"]);

/** `Session`, `URLSession` — but not `MAX_ROWS`, which is a constant shouting. */
const typeLike = (name: string): boolean => /^[A-Z]/.test(name) && /[a-z]/.test(name);

/**
 * The colour a name earns. `after` is the next non-blank character on its line, which is how a
 * call is told apart from a reference in grammars that do not say. Null means plain ink.
 */
export function roleClass(role: string, text: string, after: string, table: SymbolTable | null): string | null {
  // Stream grammars hand over `.frame` and `@State` with their sigil attached.
  const name = text.replace(/^[.@$]/, "");
  const ours = (): string | null =>
    table?.types.has(name) ? "cm-xc-projType" : table?.others.has(name) ? "cm-xc-projOther" : null;
  switch (role) {
    case "xr-declType":
      return "cm-xc-declType";
    case "xr-decl":
      return typeLike(name) ? "cm-xc-declType" : "cm-xc-decl";
    case "xr-type":
      return table?.types.has(name) ? "cm-xc-projType" : "cm-xc-type";
    case "xr-call":
    case "xr-prop":
      return ours() ?? (typeLike(name) ? "cm-xc-type" : "cm-xc-other");
    case "xr-var":
      return ours() ?? (typeLike(name) ? "cm-xc-type" : after === "(" ? "cm-xc-other" : null);
    case "xr-std":
      return text.startsWith("#") ? "cm-xc-preproc" : typeLike(name) ? "cm-xc-type" : "cm-xc-other";
    default:
      return null;
  }
}

/** The first role class in a highlighter's space-separated answer. */
export const roleOf = (classes: string): string | null => {
  for (const part of classes.split(" ")) if (part.startsWith("xr-")) return part;
  return null;
};

/** The next non-blank character after `to`, on the same line. */
function nextChar(state: EditorState, to: number): string {
  const line = state.doc.lineAt(to);
  const rest = line.text.slice(to - line.from, to - line.from + 24);
  const match = /\S/.exec(rest);
  return match ? match[0] : "";
}

/* ------------------------------------------------------------- comments */

const MARK = /\b(?:MARK|TODO|FIXME|WARNING)\s*:/;
const LINK = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;
const DOC_KEYWORD = /(?:-\s*(?:Parameters?|Returns|Throws|Note|Warning|Important|Precondition|Complexity)\b|@(?:param|returns?|throws|example|see|deprecated|type|template)\b)/g;

type Span = { from: number; to: number; cls: string };

/** Marks inside one comment token, in document order. */
function commentSpans(state: EditorState, from: number, to: number, out: Span[]): void {
  const text = state.doc.sliceString(from, to);
  const mark = MARK.exec(text);
  if (mark) {
    out.push({ from: from + mark.index, to, cls: "cm-xc-mark" });
    return;
  }
  const found: Span[] = [];
  for (const match of text.matchAll(LINK)) {
    found.push({ from: from + match.index, to: from + match.index + match[0].length, cls: "cm-xc-url" });
  }
  for (const match of text.matchAll(DOC_KEYWORD)) {
    found.push({ from: from + match.index, to: from + match.index + match[0].length, cls: "cm-xc-docKeyword" });
  }
  found.sort((a, b) => a.from - b.from);
  let end = from;
  for (const span of found) {
    if (span.from < end) continue; // overlapping finds: the first one wins
    out.push(span);
    end = span.to;
  }
}

/* ---------------------------------------------------------- occurrences */

/** The identifier the caret rests in, or null when it is not in one or a range is selected. */
function caretWord(state: EditorState): string | null {
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return null;
  const line = state.doc.lineAt(range.head);
  const offset = range.head - line.from;
  let from = offset;
  let to = offset;
  while (from > 0 && /[\w$]/.test(line.text[from - 1])) from -= 1;
  while (to < line.text.length && /[\w$]/.test(line.text[to])) to += 1;
  const word = line.text.slice(from, to);
  return /^[A-Za-z_$][\w$]*$/.test(word) && word.length > 1 ? word : null;
}

/* -------------------------------------------------------------- the pass */

const markCache = new Map<string, Decoration>();
const markFor = (cls: string): Decoration => {
  let mark = markCache.get(cls);
  if (!mark) {
    mark = Decoration.mark({ class: cls });
    markCache.set(cls, mark);
  }
  return mark;
};

/**
 * Every role-coloured span between `from` and `to`, in order. Shared by the plugin and by sticky
 * scroll, so a pinned header can never colour a name differently from the line it repeats.
 */
export function semanticSpans(state: EditorState, from: number, to: number, word: string | null = null): Span[] {
  const table = state.facet(symbolSource)();
  const out: Span[] = [];
  highlightTree(
    syntaxTree(state),
    roleHighlighter,
    (start, end, classes) => {
      const role = roleOf(classes);
      if (!role) return;
      if (role === "xr-comment") {
        commentSpans(state, start, end, out);
        return;
      }
      const text = state.doc.sliceString(start, end);
      let cls = roleClass(role, text, nextChar(state, end), table);
      if (word && NAMING.has(role) && text.replace(/^[.@$]/, "") === word) {
        cls = cls ? `${cls} cm-xc-occurrence` : "cm-xc-occurrence";
      }
      if (cls) out.push({ from: start, to: end, cls });
    },
    from,
    to,
  );
  return out;
}

function decorate(view: EditorView, word: string | null): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.visibleRanges) {
    for (const span of semanticSpans(view.state, range.from, range.to, word)) {
      builder.add(span.from, span.to, markFor(span.cls));
    }
  }
  return builder.finish();
}

export function semanticHighlight(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private word: string | null;

      constructor(view: EditorView) {
        this.word = caretWord(view.state);
        this.decorations = decorate(view, this.word);
      }

      update(update: ViewUpdate): void {
        const word = update.selectionSet || update.docChanged ? caretWord(update.state) : this.word;
        const refreshed = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshSymbols)));
        if (
          update.docChanged ||
          update.viewportChanged ||
          refreshed ||
          word !== this.word ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.word = word;
          this.decorations = decorate(update.view, word);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
