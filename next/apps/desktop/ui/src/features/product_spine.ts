/**
 * Product Spine, embedded.
 *
 * One surface: the navigation between the screens that have a taken screenshot, drawn natively
 * on a canvas from the module's `map.json` (see `spine_map.ts`). There is no iframe and no
 * surface switcher any more — the Python-rendered pages (`system`, `business`, `findings`,
 * `delta`, `wire`) still exist and still serve, but reaching the same facts five ways is what
 * made the spine confusing. Panel shows the map; the module keeps the prose for the CLI.
 *
 * What is left here is the chrome: the project -> key mapping the Python panel used to do for
 * us, and the not-registered / module-down notices.
 */

import { moduleGet } from "./modules";
import { describeError } from "../errors";
import { mountSpineMap, type SpineMapHandle } from "./spine_map";
import "./product_spine.css";

const M = "/m/product-spine";

type CatalogEntry = {
  key: string;
  root: string;
  profile?: string;
  profileLabel?: string;
  stack?: string;
};

export type ProductSpineHandle = {
  setProject(projectId: string, path: string): void;
};

/** Trailing slashes and symlink spelling differ between config.json and the registry. */
const normalize = (path: string): string => path.replace(/\/+$/, "");

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function mountProductSpine(host: HTMLElement): ProductSpineHandle {
  host.className = "pane product-spine-pane";
  host.innerHTML = `
    <div class="dm-body">
      <div class="dm-notice"></div>
      <div class="dm-native sm-root" hidden></div>
    </div>`;

  const notice = host.querySelector<HTMLElement>(".dm-notice")!;
  const native = host.querySelector<HTMLElement>(".dm-native")!;
  let map: SpineMapHandle | null = null;
  let mapKey = "";

  let projectPath = "";
  let projectName = "";
  let catalog: Promise<CatalogEntry[]> | null = null;

  function loadCatalog(): Promise<CatalogEntry[]> {
    catalog ??= moduleGet<{ projects?: CatalogEntry[] }>(`${M}/api/catalog`).then(
      (data) => data.projects ?? [],
    );
    return catalog;
  }

  function show(state: "notice" | "native", message = ""): void {
    notice.classList.toggle("show", state === "notice");
    native.hidden = state !== "native";
    if (state === "notice") notice.innerHTML = message;
  }

  async function open(): Promise<void> {
    show("notice", '<span class="mo-pulse">reading the Product Spine registry…</span>');
    let projects: CatalogEntry[];
    try {
      projects = await loadCatalog();
    } catch (error) {
      // The module is broken or missing — a different problem from "not registered".
      // Reset so switching project retries rather than caching the failure.
      catalog = null;
      show(
        "notice",
        `<b>Product Spine unavailable.</b><br>The module did not answer.${(() => {
          const { reason, details } = describeError(error);
          if (details) console.error("Product Spine", details);
          return reason ? `<br><code>${esc(reason).slice(0, 300)}</code>` : "";
        })()}`,
      );
      return;
    }

    const here = normalize(projectPath);
    const entry = projects.find((candidate) => normalize(candidate.root) === here) ?? null;
    if (!entry) {
      show(
        "notice",
        `<b>${esc(projectName)} is not registered.</b><br>Add a row to the spine registry, then reopen this tab.<br>` +
          `<code class="hint">${esc(projectName)}: { path: ${esc(projectPath)}, lib: lib, stack: flutter, profile: app }</code>`,
      );
      return;
    }

    map ??= mountSpineMap(native);
    show("native");
    if (mapKey !== entry.key) {
      mapKey = entry.key;
      void map.load(entry.key);
    }
  }

  return {
    setProject(_projectId, path) {
      if (normalize(path) === normalize(projectPath)) return;
      projectPath = path;
      projectName = path.split("/").pop() ?? path;
      void open();
    },
  };
}
