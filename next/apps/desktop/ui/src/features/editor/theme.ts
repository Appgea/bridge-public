/**
 * The editor's LOOK — Xcode's Default (Dark) and Default (Light), value for value.
 *
 * This file used to say "Xcode" and paint One Dark. The difference is not taste: Xcode colours by
 * MEANING, not by token class. A declaration is one hue, a name your project declared is another,
 * and a name the SDK brought is a third — so a glance at a line says what is yours. The token
 * colours below are the `.xccolortheme` values; the identifier roles that need more than a token
 * class (project vs SDK, declaration vs use) are painted by `semantic.ts`, which reads the same
 * palette through the `cm-xc-*` classes defined here.
 *
 * Type is SF Mono. The old stack named "SF Mono" first, but macOS does not expose SF Mono by that
 * name — only through `ui-monospace` — so every buffer was quietly rendering in Menlo. Keywords
 * are bold, as in Xcode; SF Mono's bold has the same advance width, so columns never jitter.
 *
 * Nothing here is per-feature. Every editor mounts the SAME pack through the same Compartment,
 * so a theme toggle moves them all and none can drift.
 */

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export type ThemeMode = "dark" | "light";

/** The family every code surface uses — the buffer, sticky headers, hunk previews, the diff. */
export const CODE_FONT = "var(--font-mono)";

/**
 * One palette per mode. Canvas surfaces (the minimap) read the same object, so a colour cannot
 * mean one thing in the buffer and another in its overview.
 */
export const XCODE = {
  dark: {
    bg: "#1f1f24",
    plain: "#dfdfe0",
    cursor: "#ffffff",
    currentLine: "rgba(120, 140, 170, 0.08)",
    selection: "#515b70",
    selectionBlur: "#3d4250",
    gutter: "#6b6b72",
    gutterActive: "#dfdfe0",
    invisible: "#424d5b",
    comment: "#6c7986",
    docKeyword: "#92a1b1",
    mark: "#92a1b1",
    string: "#fc6a5d",
    number: "#d0bf69",
    keyword: "#fc5fa3",
    preprocessor: "#fd8f3f",
    url: "#5482ff",
    attribute: "#bf8555",
    declType: "#5dd8ff",
    declOther: "#41a1c0",
    projType: "#9ef1dd",
    projOther: "#67b7a4",
    otherType: "#d0a8ff",
    otherOther: "#a167e6",
    regex: "#ff8170",
    invalid: "#ff453a",
    find: "rgba(255, 214, 10, 0.24)",
    findCurrent: "#ffd60a",
    findCurrentInk: "#1f1f24",
    occurrence: "rgba(255, 255, 255, 0.10)",
    bracket: "rgba(255, 255, 255, 0.16)",
  },
  light: {
    bg: "#ffffff",
    plain: "#262626",
    cursor: "#000000",
    currentLine: "rgba(0, 111, 255, 0.075)",
    selection: "#a4cdff",
    selectionBlur: "#dcdcdc",
    gutter: "#a0a0a6",
    gutterActive: "#262626",
    invisible: "#c4c4c8",
    comment: "#5d6c79",
    docKeyword: "#4a5560",
    mark: "#4a5560",
    string: "#c41a16",
    number: "#1c00cf",
    keyword: "#9b2393",
    preprocessor: "#643820",
    url: "#0e0eff",
    attribute: "#815f03",
    declType: "#0b4f79",
    declOther: "#0f68a0",
    projType: "#1c464a",
    projOther: "#326d74",
    otherType: "#3900a0",
    otherOther: "#6c36a9",
    regex: "#d12f1b",
    invalid: "#d70015",
    find: "rgba(255, 204, 0, 0.32)",
    findCurrent: "#ffd60a",
    findCurrentInk: "#000000",
    occurrence: "rgba(0, 0, 0, 0.08)",
    bracket: "rgba(0, 0, 0, 0.12)",
  },
} as const;

export type Palette = (typeof XCODE)[ThemeMode];

function xcodeTheme(mode: ThemeMode): Extension {
  const c = XCODE[mode];
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        color: c.plain,
        backgroundColor: c.bg,
        "--cm-editor-bg": c.bg,
        "--cm-gutter-ink": c.gutter,
        "--cm-indent-guide": mode === "dark" ? "rgba(255,255,255,.055)" : "rgba(0,0,0,.07)",
      },
      ".cm-scroller": {
        fontFamily: CODE_FONT,
        overscrollBehavior: "contain",
        /* Native text rendering, the way AppKit draws Xcode's buffer. The app body asks for
           `antialiased`, which thins every stem; code read for hours wants the real weight. */
        WebkitFontSmoothing: "auto",
      },
      ".cm-content": { padding: "6px 0 45vh", caretColor: c.cursor },
      "&.cm-focused": { outline: "none" },
      ".cm-line": { padding: "0 14px 0 6px" },

      /* Xcode's gutter is the buffer's own ground: no slab, no rule, numbers right-aligned in a
         smaller cut. The caret line's number lights up by colour only — a bold number is wider,
         and a gutter that changes width on every caret move is a gutter that jitters. */
      ".cm-gutters": {
        backgroundColor: c.bg,
        color: c.gutter,
        border: "none",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 6px 0 10px",
        minWidth: "34px",
        fontSize: "0.86em",
        fontVariantNumeric: "tabular-nums",
      },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: c.gutterActive },

      ".cm-activeLine": { backgroundColor: c.currentLine },
      ".cm-selectionBackground": { backgroundColor: c.selectionBlur },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection": {
        backgroundColor: c.selection,
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: c.cursor, borderLeftWidth: "2px" },

      /* Selected text elsewhere in the buffer. Quieter than the symbol highlight below. */
      ".cm-selectionMatch": { backgroundColor: c.occurrence, borderRadius: "2px" },
      ".cm-selectionMatch-main": { backgroundColor: "transparent" },
      "&.cm-focused .cm-matchingBracket, .cm-matchingBracket": {
        backgroundColor: c.bracket,
        borderRadius: "2px",
        color: "inherit",
        outline: "none",
      },
      ".cm-nonmatchingBracket": { color: c.invalid },
      ".cm-specialChar": { color: c.invalid },
      ".cm-trailingSpace": { backgroundColor: mode === "dark" ? "rgba(255,69,58,.18)" : "rgba(215,0,21,.10)" },

      /* Find, the Xcode way: every match a soft yellow box, the current one solid yellow with
         dark ink, so the eye can find "where am I" in a screen full of hits. */
      ".cm-searchMatch": { backgroundColor: c.find, borderRadius: "2px" },
      ".cm-searchMatch.cm-searchMatch-selected, .cm-searchMatch.cm-searchMatch-selected *": {
        backgroundColor: c.findCurrent,
        color: `${c.findCurrentInk} !important`,
      },

      /* Panels are app chrome, not editor surface. The find bar is styled in editor.css. */
      ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--ink)" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
      ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },

      /* Folded code is a capsule you can click, not a mystery ellipsis. */
      ".cm-foldPlaceholder": {
        margin: "0 3px",
        padding: "0 6px",
        border: "none",
        borderRadius: "4px",
        backgroundColor: mode === "dark" ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.08)",
        color: c.gutterActive,
        fontSize: "0.85em",
        cursor: "pointer",
      },

      /* Every popover the editor raises. Without this the base tooltip keeps CodeMirror's own
         white box, which is a hole punched in a dark buffer. */
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

      /* Completion. Xcode's list: code type, the matched letters carrying the emphasis. */
      ".cm-tooltip.cm-tooltip-autocomplete": {
        borderRadius: "7px",
        overflow: "hidden",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": { maxHeight: "16em", fontFamily: CODE_FONT },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
        padding: "2px 9px",
        color: "var(--ink)",
        lineHeight: "1.55",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "color-mix(in oklab, var(--accent) 70%, transparent)",
        color: "#fff",
      },
      ".cm-completionMatchedText": { fontWeight: "700", textDecoration: "none" },
      ".cm-completionIcon": { color: "var(--ink-faint)", paddingRight: "10px" },
      ".cm-completionDetail": { color: "var(--ink-faint)", fontStyle: "normal" },

      /* ---- identifier roles (semantic.ts) ---- */
      ".cm-xc-declType": { color: c.declType },
      ".cm-xc-decl": { color: c.declOther },
      ".cm-xc-projType": { color: c.projType },
      ".cm-xc-projOther": { color: c.projOther },
      ".cm-xc-type": { color: c.otherType },
      ".cm-xc-other": { color: c.otherOther },
      ".cm-xc-preproc": { color: c.preprocessor },
      ".cm-xc-mark": { color: c.mark, fontWeight: "700" },
      ".cm-xc-docKeyword": { color: c.docKeyword, fontWeight: "700" },
      ".cm-xc-url": { color: c.url, textDecoration: "underline", textUnderlineOffset: "2px" },
      /* Every other use of the symbol under the caret — Xcode's "Highlight instances of
         selected symbol". A box, not a colour, so the token keeps its role. */
      ".cm-xc-occurrence": { backgroundColor: c.occurrence, borderRadius: "2px" },
      /* ⌘ held over a name that can jump: it says so before you click. */
      ".cm-xc-link, .cm-xc-link *": {
        color: `${c.url} !important`,
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        cursor: "pointer",
      },
    },
    { dark: mode === "dark" },
  );
}

/**
 * Token colours. Identifiers are deliberately ABSENT: a variable, a property, a type name or a
 * call is coloured by `semantic.ts`, which knows whether the name is a declaration, the
 * project's own, or the SDK's. Colouring them here too would put two rules on one token, and
 * whichever span nested innermost would win.
 */
function xcodeHighlight(mode: ThemeMode): HighlightStyle {
  const c = XCODE[mode];
  return HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c.comment },
    {
      tag: [
        t.keyword,
        t.modifier,
        t.controlKeyword,
        t.definitionKeyword,
        t.moduleKeyword,
        t.operatorKeyword,
        t.self,
        t.null,
        t.bool,
      ],
      color: c.keyword,
      fontWeight: "700",
    },
    { tag: [t.atom], color: c.keyword },
    { tag: [t.string, t.special(t.string), t.docString, t.character, t.attributeValue], color: c.string },
    { tag: [t.regexp], color: c.regex },
    { tag: [t.escape], color: c.string },
    { tag: [t.number, t.integer, t.float, t.unit], color: c.number },
    { tag: [t.macroName, t.meta, t.processingInstruction], color: c.preprocessor },
    { tag: [t.annotation, t.attributeName], color: c.attribute },
    { tag: [t.tagName, t.angleBracket], color: c.keyword },
    { tag: [t.heading], fontWeight: "700" },
    { tag: [t.link, t.url], color: c.url, textDecoration: "underline" },
    { tag: [t.monospace], color: c.declOther },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "700" },
    { tag: [t.strikethrough], textDecoration: "line-through" },
    { tag: [t.invalid], color: c.invalid },
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
