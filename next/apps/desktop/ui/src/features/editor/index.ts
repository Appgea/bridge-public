export {
  createCodeEditor,
  indentLabel,
  outlineChanged,
  wrapsByDefault,
  type CodeEditor,
  type CodeEditorOptions,
  type ScrollSpot,
} from "./core";
export { outline, scopeAt, markAt, type OutlineItem, type OutlineKind } from "./outline";
export type { SymbolTable } from "./semantic";
export {
  mountJumpBar,
  symbolBadge,
  type JumpBar,
  type JumpCrumb,
  type JumpMenuItem,
  type JumpMenuSpec,
} from "./jump_bar";
export { currentMode, themePacks, type ThemeMode } from "./theme";
export { fileExtension, languageFor } from "./languages";
export { mountQuickOpen, type QuickOpen, type QuickOpenList, type QuickOpenTarget } from "./quick_open";
export { fileVisual, type FileVisual, type VisualSubject } from "./file_icons";
export { mountFindInProject, type FindInProject, type FindInProjectOptions } from "./find_in_project";
export {
  analyzeChanges,
  changedLines,
  lineDiff,
  revertedHunk,
  type DiffAnalysis,
  type DiffHunk,
  type DiffRow,
  type LineChanges,
} from "./diff";
