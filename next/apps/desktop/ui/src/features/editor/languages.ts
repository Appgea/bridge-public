/**
 * Which grammar lights up which file. Path in, CodeMirror language extension out.
 *
 * One table for the whole app: a file highlights identically wherever it is shown, because every
 * editor asks this function.
 */

import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { dart, c, cpp, java, kotlin, objectiveC } from "@codemirror/legacy-modes/mode/clike";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { swift } from "@codemirror/legacy-modes/mode/swift";

export function fileExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

export function languageFor(path: string): Extension[] {
  const ext = fileExtension(path);
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "jsx":
      return [javascript({ jsx: true })];
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "rs":
      return [rust()];
    case "py":
    case "pyi":
      return [python()];
    case "dart":
      return [StreamLanguage.define(dart)];
    case "swift":
      return [StreamLanguage.define(swift)];
    case "kt":
    case "kts":
      return [StreamLanguage.define(kotlin)];
    case "java":
      return [StreamLanguage.define(java)];
    case "c":
    case "h":
      return [StreamLanguage.define(c)];
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
    case "hxx":
      return [StreamLanguage.define(cpp)];
    case "m":
    case "mm":
      return [StreamLanguage.define(objectiveC)];
    case "yml":
    case "yaml":
      return [StreamLanguage.define(yaml)];
    case "sh":
    case "bash":
    case "zsh":
      return [StreamLanguage.define(shell)];
    case "sql":
      return [StreamLanguage.define(standardSQL)];
    case "toml":
      return [StreamLanguage.define(toml)];
    case "properties":
    case "env":
    case "ini":
    case "cfg":
    case "conf":
    case "xcconfig":
    case "strings":
      return [StreamLanguage.define(properties)];
    case "arb":
      return [json()];
    case "json":
    case "jsonc":
      return [json()];
    case "md":
    case "markdown":
      return [markdown()];
    case "css":
      return [css()];
    case "html":
    case "htm":
    case "svg":
    case "xml":
    case "plist":
    case "entitlements":
    case "storyboard":
    case "xib":
    case "xcscheme":
    case "xcworkspacedata":
    case "xcsettings":
    case "pbxproj":
      return [html()];
    default:
      return [];
  }
}
