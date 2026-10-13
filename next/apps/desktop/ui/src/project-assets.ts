/** Media knowledge shared by every surface that renders files from an open project. */
export type ProjectMediaKind = "image" | "audio" | "video" | "pdf";

const MEDIA_EXTENSIONS: Record<ProjectMediaKind, ReadonlySet<string>> = {
  image: new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]),
  audio: new Set(["mp3", "ogg", "oga", "wav", "m4a", "aac", "flac"]),
  video: new Set(["mp4", "m4v", "mov", "webm"]),
  pdf: new Set(["pdf"]),
};

export function fileExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLocaleLowerCase();
}

export function projectMediaKind(path: string): ProjectMediaKind | null {
  const extension = fileExtension(path);
  for (const [kind, extensions] of Object.entries(MEDIA_EXTENSIONS)) {
    if (extensions.has(extension)) return kind as ProjectMediaKind;
  }
  return null;
}

export function isImagePath(path: string): boolean {
  return projectMediaKind(path) === "image";
}

/**
 * An `<img>` for a path an agent reported.
 *
 * Two things go wrong with agent screenshots, and a bare `<img>` handles neither. The file can
 * land a beat AFTER the report that announces it — so one retry. And when it truly isn't there,
 * the browser draws a broken-image glyph that tells you nothing — so the element replaces itself
 * with the path that failed, which is the only fact worth having.
 */
export function projectImage(projectId: string, path: string, alt: string): HTMLImageElement {
  const image = document.createElement("img");
  image.src = projectAssetUrl(projectId, path);
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  let retried = false;
  image.addEventListener("error", () => {
    if (!retried) {
      retried = true;
      // The query is ignored by the protocol handler; it only defeats the webview's cache.
      window.setTimeout(() => {
        image.src = `${projectAssetUrl(projectId, path)}?retry=1`;
      }, 1200);
      return;
    }
    const card = document.createElement("div");
    card.className = "asset-missing";
    card.title = path;
    const label = document.createElement("b");
    label.textContent = "image not found";
    const where = document.createElement("code");
    where.textContent = path;
    card.append(label, where);
    image.replaceWith(card);
  });
  return image;
}

/** A read-only URL confined by the desktop protocol to the registered project root. */
export function projectAssetUrl(projectId: string, path: string): string {
  const encoded = [projectId, ...path.replaceAll("\\", "/").split("/")]
    .map(encodeURIComponent)
    .join("/");
  return `project-asset://panel/${encoded}`;
}
