/** One human-only Markdown notebook backed by `~/.appgea/notes.md`. */

import { invoke } from "@tauri-apps/api/core";
import { Compartment } from "@codemirror/state";
import { icon } from "../icons";
import { errorText } from "../errors";
import { createCodeEditor } from "./editor";
import { notebookLivePreview } from "./notebook_live_preview";
import "./notebook.css";

export type NotebookHandle = {
  open(): Promise<void>;
  clear(): void;
  isOpen(): boolean;
};

const message = (error: unknown): string => errorText(error, "Panel hit a bug here. The details are in the console.");

export function mountNotebook(host: HTMLElement): NotebookHandle {
  host.classList.add("notebook");
  host.innerHTML = `
    <header class="note-head">
      <span class="note-title">${icon("work")}<b>Notes</b></span>
      <span class="note-path">~/.appgea/notes.md</span>
      <span class="note-privacy">Local only · never shared with agents</span>
      <button class="note-mode" type="button" role="switch" disabled>
        <span>Markdown</span><i></i><span>Preview</span>
      </button>
      <span class="note-status" aria-live="polite">Stored only on this Mac</span>
    </header>
    <div class="note-editor"></div>`;

  const status = host.querySelector<HTMLElement>(".note-status")!;
  const editorHost = host.querySelector<HTMLElement>(".note-editor")!;
  const modeButton = host.querySelector<HTMLButtonElement>(".note-mode")!;
  let openState = false;
  let loaded = false;
  let loading = false;
  let saved = "";
  let saveTimer = 0;
  let saving: Promise<boolean> | null = null;
  let previewMode = localStorage.getItem("panel.notebook.preview") === "1";
  const previewCompartment = new Compartment();

  const paintMode = (): void => {
    modeButton.classList.toggle("is-preview", previewMode);
    modeButton.setAttribute("aria-checked", String(previewMode));
    modeButton.title = previewMode ? "Show Markdown marks" : "Hide Markdown marks";
  };
  paintMode();

  const setStatus = (text: string, failed = false): void => {
    status.textContent = text;
    status.classList.toggle("is-error", failed);
  };

  let code: ReturnType<typeof createCodeEditor>;
  code = createCodeEditor({
    parent: editorHost,
    visibilityHost: host,
    extra: [previewCompartment.of(notebookLivePreview(previewMode))],
    onSave: () => void saveNow(),
    onUpdate: (update) => {
      if (loading || !update.docChanged) return;
      const dirty = code.doc() !== saved;
      setStatus(dirty ? "Unsaved" : "Saved locally");
      window.clearTimeout(saveTimer);
      if (dirty) saveTimer = window.setTimeout(() => void saveNow(), 500);
    },
  });
  code.blank();

  modeButton.addEventListener("click", () => {
    if (!loaded) return;
    previewMode = !previewMode;
    code.view.dispatch({
      effects: previewCompartment.reconfigure(notebookLivePreview(previewMode)),
    });
    localStorage.setItem("panel.notebook.preview", previewMode ? "1" : "0");
    paintMode();
    code.view.focus();
  });

  async function saveNow(): Promise<boolean> {
    window.clearTimeout(saveTimer);
    if (saving) {
      const okay = await saving;
      return okay ? saveNow() : false;
    }
    if (loading || !loaded || code.doc() === saved) return true;
    const text = code.doc();
    setStatus("Saving…");
    const task = invoke("save_notebook", { text })
      .then(() => {
        if (code.doc() === text) {
          saved = text;
          setStatus("Saved locally");
        }
        return true;
      })
      .catch((error) => {
        setStatus(message(error), true);
        return false;
      });
    saving = task;
    const okay = await task;
    if (saving === task) saving = null;
    if (!okay) return false;
    return code.doc() === saved ? true : saveNow();
  }

  return {
    async open() {
      openState = true;
      if (!loaded) {
        loading = true;
        setStatus("Opening…");
        try {
          const text = await invoke<string>("read_notebook");
          saved = text;
          code.load("notes.md", text);
          loaded = true;
          modeButton.disabled = false;
          setStatus("Saved locally");
        } catch (error) {
          setStatus(message(error), true);
        } finally {
          loading = false;
        }
      }
      code.view.requestMeasure();
      code.view.focus();
    },
    clear() {
      if (!openState) return;
      openState = false;
      void saveNow();
    },
    isOpen: () => openState,
  };
}
