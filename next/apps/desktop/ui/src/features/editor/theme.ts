/**
 * The editor's LOOK — one palette pack, every surface that edits text.
 *
 * The surface sits on the APP's ground — the same near-black the rest of Panel wears — so the
 * buffer is not a grey slab cut into a dark window. The syntax hues are One Dark / One Light,
 * the palette more developers read every day than any other; nothing is bold, because weight
 * that changes with the token makes columns jitter and reads as shouting. The `dark` flag on
 * each theme matches its mode so CodeMirror's own defaults agree with the surface.
 *
 * Nothing here is per-feature. Every editor mounts the SAME pack through the same Compartment,
 * so a theme toggle moves them all and none can drift.
 */

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export type ThemeMode = "dark" | "light";

const ED = {
  dark: {
    bg: "#0b0f19",
    text: "#c9d1e3",
    cursor: "#e6ecff",
    gutterBg: "#0b0f19",
    gutterNum: "#3f4a60",
    gutterBorder: "transparent",
    activeLine: "rgba(255,255,255,0.035)",
    activeGutterBg: "transparent",
    activeGutterNum: "#aeb8cc",
    selection: "#24365e",
    match: "rgba(88,182,255,0.16)",
  },
  light: {
    bg: "#fbfcfe",
    text: "#2b3140",
    cursor: "#1c2333",
    gutterBg: "#fbfcfe",
    gutterNum: "#aab2c2",
    gutterBorder: "transparent",
    activeLine: "rgba(28,35,51,0.045)",
    activeGutterBg: "transparent",
    activeGutterNum: "#4d5a73",
    selection: "#cfe0fb",
    match: "rgba(11,107,203,0.14)",
  },
} as const;

const SYN = {
  dark: {
    comment: "#5f6b80",
    keyword: "#c678dd",
    atom: "#d19a66",
    string: "#98c379",
    escape: "#56b6c2",
    number: "#d19a66",
    fn: "#61afef",
    def: "#e5c07b",
    type: "#e5c07b",
    prop: "#e06c75",
    plain: "#c9d1e3",
    meta: "#56b6c2",
    invalid: "#ff6b81",
  },
  light: {
    comment: "#8a93a6",
    keyword: "#a626a4",
    atom: "#986801",
    string: "#50a14f",
    escape: "#0184bc",
    number: "#986801",
    fn: "#4078f2",
    def: "#c18401",
    type: "#c18401",
    prop: "#e45649",
    plain: "#2b3140",
    meta: "#0184bc",
    invalid: "#c42e44",
  },
} as const;

function xcodeTheme(mode: ThemeMode): Extension {
  const c = ED[mode];
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        color: c.text,
        backgroundColor: c.bg,
        "--cm-editor-bg": c.bg,
        "--cm-indent-guide": mode === "dark" ? "rgba(255,255,255,.07)" : "rgba(28,35,51,.10)",
      },
      ".cm-scroller": {
        fontFamily: '"SF Mono", "SFMono-Regular", Menlo, Monaco, ui-monospace, monospace',
        lineHeight: "1.6",
        overscrollBehavior: "contain",
      },
      ".cm-content": { padding: "12px 0 45vh", caretColor: c.cursor },
      "&.cm-focused": { outline: "none" },
      ".cm-line": { padding: "0 14px 0 4px" },

      ".cm-gutters": {
        backgroundColor: c.gutterBg,
        color: c.gutterNum,
        border: "none",
        borderRight: `1px solid ${c.gutterBorder}`,
        paddingRight: "4px",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 8px 0 8px",
        minWidth: "30px",
        fontVariantNumeric: "tabular-nums",
      },
      /* The caret line announces itself by colour only. A bold number is wider than a regular
         one, and a gutter that changes width on every caret move is a gutter that jitters. */
      ".cm-activeLineGutter": {
        backgroundColor: c.activeGutterBg,
        color: c.activeGutterNum,
      },
      ".cm-foldGutter .cm-gutterElement": { color: c.gutterNum, padding: "0 2px" },

      ".cm-activeLine": { backgroundColor: c.activeLine },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
        backgroundColor: c.selection,
      },
      "&.cm-focused .cm-cursor": { borderLeftColor: c.cursor, borderLeftWidth: "2px" },
      ".cm-selectionMatch": { backgroundColor: c.match },
      "&.cm-focused .cm-matchingBracket, .cm-matchingBracket": {
        backgroundColor: c.match,
        color: c.text,
        outline: "none",
      },
      ".cm-nonmatchingBracket": { color: SYN[mode].invalid },
      ".cm-specialChar": { color: SYN[mode].invalid },

      /* Panels are app chrome, not editor surface — they stay on the tokens. The find bar
         sits at the top like Xcode's, so the rule that separates it does too. */
      ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--ink)" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
      ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
      ".cm-panel.cm-search input, .cm-panel.cm-search button": {
        backgroundColor: "var(--bg-sunken)",
        color: "var(--ink)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-sm)",
        fontSize: "11px",
        padding: "3px 6px",
      },
      ".cm-panel.cm-search label": { color: "var(--ink-dim)", fontSize: "11px" },
      ".cm-searchMatch": { backgroundColor: c.match },
      ".cm-searchMatch-selected": { backgroundColor: c.selection },

      /* Every popover the editor raises — the hover value first of all. Without this the base
         tooltip keeps CodeMirror's own white box, which is a hole punched in a dark buffer. */
      ".cm-tooltip": {
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-sm)",
        backgroundColor: "var(--bg-raised)",
        color: "var(--ink)",
        boxShadow: "0 10px 30px color-mix(in oklab, #000 30%, transparent)",
      },
      ".cm-tooltip .cm-tooltip-arrow:before": { borderTopColor: "var(--line)", borderBottomColor: "var(--line)" },
      ".cm-tooltip .cm-tooltip-arrow:after": {
        borderTopColor: "var(--bg-raised)",
        borderBottomColor: "var(--bg-raised)",
      },

      /* Completion. A quiet list on app chrome, so it reads as a popover over the code rather
         than a second editor surface — the matched characters carry the emphasis. */
      ".cm-tooltip.cm-tooltip-autocomplete": {
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-sm)",
        backgroundColor: "var(--bg-raised)",
        boxShadow: "0 10px 30px color-mix(in oklab, #000 30%, transparent)",
        overflow: "hidden",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": {
        maxHeight: "16em",
        fontFamily: '"SF Mono", "SFMono-Regular", Menlo, Monaco, ui-monospace, monospace',
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
        padding: "3px 9px",
        color: "var(--ink)",
        lineHeight: "1.5",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "color-mix(in oklab, var(--accent) 22%, transparent)",
        color: "var(--ink)",
      },
      ".cm-completionMatchedText": {
        color: SYN[mode].fn,
        fontWeight: "700",
        textDecoration: "none",
      },
      ".cm-completionIcon": { color: "var(--ink-faint)", paddingRight: "10px" },
      ".cm-completionDetail": { color: "var(--ink-faint)", fontStyle: "normal" },
    },
    { dark: mode === "dark" },
  );
}

function xcodeHighlight(mode: ThemeMode): HighlightStyle {
  const s = SYN[mode];
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment], color: s.comment, fontStyle: "italic" },
    {
      tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.self],
      color: s.keyword,
    },
    { tag: [t.null, t.atom, t.bool], color: s.atom },
    { tag: [t.string, t.special(t.string), t.regexp], color: s.string },
    { tag: [t.escape], color: s.escape },
    { tag: [t.number, t.integer, t.float, t.unit], color: s.number },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: s.fn },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: s.def },
    { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: s.type },
    { tag: [t.propertyName, t.attributeName], color: s.prop },
    { tag: [t.variableName, t.labelName], color: s.plain },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], color: s.plain },
    { tag: [t.meta, t.processingInstruction, t.annotation], color: s.meta },
    { tag: [t.tagName, t.angleBracket], color: s.keyword },
    { tag: [t.heading], color: s.fn, fontWeight: "600" },
    { tag: [t.link, t.url], color: s.string, textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "700" },
    { tag: [t.strikethrough], textDecoration: "line-through" },
    { tag: [t.invalid], color: s.invalid },
  ]);
}

/** The token styles, one per mode. Sticky scroll paints its headers with the live one. */
export const highlightStyles: Record<ThemeMode, HighlightStyle> = {
  dark: xcodeHighlight("dark"),
  light: xcodeHighlight("light"),
};

/** Built once per mode; every editor state carries one of these inside the Compartment. */
export const themePacks: Record<ThemeMode, Extension> = {
  dark: [xcodeTheme("dark"), syntaxHighlighting(highlightStyles.dark)],
  light: [xcodeTheme("light"), syntaxHighlighting(highlightStyles.light)],
};

export const currentMode = (): ThemeMode =>
  document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
