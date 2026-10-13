export { createCodeEditor, indentLabel, wrapsByDefault, type CodeEditor, type CodeEditorOptions } from "./core";
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
