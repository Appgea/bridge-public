/**
 * Path in, glyph out — the icon vocabulary shared by everything that lists files.
 *
 * The file tree draws them, and so does quick open. One table means a file wears the same mark
 * wherever it is listed.
 */

import { fileExtension } from "./languages";

export type FileVisual = { className: string; label: string; svg: string };

/** Just enough of a file to choose its look. The tree passes a node; quick open a bare path. */
export type VisualSubject = { name: string; isDir?: boolean };

/* Small navigator glyphs. Shape carries the category; colour only reinforces it. */
const FOLDER_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h2.9c.39 0 .76.18 1 .49l.83 1.06h5.52c.69 0 1.25.56 1.25 1.25v6.45c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z"/></svg>';
const FILE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5l3 3v8.5c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V2.75c0-.55.45-1 1-1Z"/><path d="M9 1.75v3h3"/></svg>';
const CODE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.25 4.25-3.5 3.5 3.5 3.5M9.75 4.25l3.5 3.5-3.5 3.5"/></svg>';
const DATA_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5H4.75c-.7 0-1.25.55-1.25 1.25V6c0 1-.5 1.5-1.25 1.75C3 8 3.5 8.5 3.5 9.5v2.75c0 .7.55 1.25 1.25 1.25H6M10 2.5h1.25c.7 0 1.25.55 1.25 1.25V6c0 1 .5 1.5 1.25 1.75C13 8 12.5 8.5 12.5 9.5v2.75c0 .7-.55 1.25-1.25 1.25H10"/></svg>';
const DOC_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5l3 3v8.5c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V2.75c0-.55.45-1 1-1Z"/><path d="M9 1.75v3h3M5.25 7.25h5.5M5.25 9.5h5.5M5.25 11.75h3.5"/></svg>';
const CONFIG_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.25"/><circle cx="10.5" cy="8" r="1.25"/><circle cx="5" cy="12" r="1.25"/></svg>';
const IMAGE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.25" cy="5.75" r="1.15"/><path d="m3.5 11 3-3 2.25 2 1.5-1.5 2.25 2.5"/></svg>';
const AUDIO_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h1M5 5.5v5M7.5 3.5v9M10 5v6M12.5 6.5v3"/></svg>';
const VIDEO_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m6.5 5.75 4 2.25-4 2.25Z"/></svg>';
const DATABASE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="3.75" rx="5" ry="2"/><path d="M3 3.75v4c0 1.1 2.25 2 5 2s5-.9 5-2v-4M3 7.75v4c0 1.1 2.25 2 5 2s5-.9 5-2v-4"/></svg>';
const TERMINAL_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.5" width="12.5" height="11" rx="1.5"/><path d="m4.25 5.5 2.25 2-2.25 2M8 10h3.5"/></svg>';
const PACKAGE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 1.75 5.25 3v6.5L8 14.25l-5.25-3v-6.5Z"/><path d="m2.75 4.75 5.25 3 5.25-3M8 7.75v6.5"/></svg>';
const GIT_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="3.25" r="1.35"/><circle cx="11" cy="5.75" r="1.35"/><circle cx="5" cy="12.75" r="1.35"/><path d="M5 4.6v6.8M6.35 6.5H8c1.65 0 3-1.35 3-3"/></svg>';
const PDF_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5l3 3v8.5c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V2.75c0-.55.45-1 1-1Z"/><path d="M9 1.75v3h3M4.75 10.75c2.3-.25 4.45-1.35 5.75-3.75M6.25 6.5c.25 2.05 1.6 4.25 4.5 5"/></svg>';

const visual = (className: string, label: string, svg = CODE_SVG): FileVisual => ({
  className,
  label,
  svg,
});

/** Familiar project files get product names; extensions cover everything else. */
export function fileVisual(node: VisualSubject): FileVisual {
  if (node.isDir) return visual("is-folder", "", FOLDER_SVG);
  const lower = node.name.toLowerCase();
  if (["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(lower)) {
    return visual("is-package", "Package", PACKAGE_SVG);
  }
  if (lower === "pubspec.yaml" || lower === "pubspec.lock") return visual("is-dart", "Flutter", PACKAGE_SVG);
  if (lower === "cargo.toml" || lower === "cargo.lock") return visual("is-rust", "Rust", PACKAGE_SVG);
  if (lower === "project.godot" || lower === "export_presets.cfg") return visual("is-godot", "Godot", PACKAGE_SVG);
  if (["dockerfile", "makefile", "podfile", "gemfile"].includes(lower)) {
    return visual("is-shell", lower.replace("file", "") || "Build", TERMINAL_SVG);
  }
  if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules") {
    return visual("is-git", "Git", GIT_SVG);
  }
  if (lower === "agents.md" || lower === "claude.md") return visual("is-config", "Instructions", DOC_SVG);
  if (lower === "skill.md") return visual("is-radio", "Skill", DOC_SVG);
  if (lower === "readme" || lower.startsWith("readme.")) return visual("is-doc", "Readme", DOC_SVG);
  if (lower === "license" || lower.startsWith("license.")) return visual("is-doc", "License", DOC_SVG);
  if (lower.startsWith(".env")) return visual("is-config", "Env", CONFIG_SVG);

  switch (fileExtension(lower)) {
    case "ts": return visual("is-ts", "TypeScript");
    case "tsx": return visual("is-ts", "TSX");
    case "js": case "mjs": case "cjs": return visual("is-js", "JavaScript");
    case "jsx": return visual("is-js", "JSX");
    case "dart": return visual("is-dart", "Dart");
    case "gd": return visual("is-godot", "GDScript");
    case "gdshader": case "gdshaderinc": return visual("is-godot", "Godot Shader");
    case "tscn": case "scn": return visual("is-godot", "Godot Scene");
    case "tres": case "res": return visual("is-godot", "Godot Resource");
    case "godot": return visual("is-godot", "Godot");
    case "swift": return visual("is-swift", "Swift");
    case "rs": return visual("is-rust", "Rust");
    case "py": case "pyi": return visual("is-py", "Python");
    case "kt": case "kts": return visual("is-code", "Kotlin");
    case "java": return visual("is-code", "Java");
    case "c": case "h": return visual("is-code", "C");
    case "cc": case "cpp": case "cxx": case "hpp": return visual("is-code", "C++");
    case "go": return visual("is-code", "Go");
    case "rb": return visual("is-code", "Ruby");
    case "php": return visual("is-code", "PHP");
    case "sh": case "bash": case "zsh": case "fish": return visual("is-shell", "Shell", TERMINAL_SVG);
    case "html": case "htm": return visual("is-markup", "HTML", CODE_SVG);
    case "css": case "scss": case "sass": case "less": return visual("is-style", "Styles", CODE_SVG);
    case "json": case "jsonc": return visual("is-data", "JSON", DATA_SVG);
    case "yaml": case "yml": return visual("is-config", "YAML", CONFIG_SVG);
    case "toml": return visual("is-config", "TOML", CONFIG_SVG);
    case "xml": return visual("is-data", "XML", DATA_SVG);
    case "ini": case "cfg": case "conf": case "properties": return visual("is-config", "Config", CONFIG_SVG);
    case "md": case "markdown": case "mdx": return visual("is-doc", "Markdown", DOC_SVG);
    case "txt": case "rtf": return visual("is-doc", "Text", DOC_SVG);
    case "pdf": return visual("is-pdf", "PDF", PDF_SVG);
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "ico": case "avif":
      return visual("is-image", "Image", IMAGE_SVG);
    case "mp3": case "wav": case "m4a": case "aac": case "flac": case "ogg":
      return visual("is-audio", "Audio", AUDIO_SVG);
    case "mp4": case "mov": case "m4v": case "webm":
      return visual("is-video", "Video", VIDEO_SVG);
    case "sql": return visual("is-database", "SQL", DATABASE_SVG);
    case "db": case "sqlite": case "sqlite3": return visual("is-database", "Database", DATABASE_SVG);
    case "lock": return visual("is-lock", "Lock", FILE_SVG);
    default: return visual("is-file", "File", FILE_SVG);
  }
}
