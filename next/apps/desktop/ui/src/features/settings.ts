/**
 * Settings — a screen, not a sheet. It swaps with the workspace the way a project does, so it
 * gets the whole window and nothing behind it is half-visible and half-clickable.
 *
 * The layout is a card grid that flows into as many columns as the window has room for. Rows
 * are one line each: a name and its chord. The prose that explains a shortcut is its tooltip,
 * not a second line under every row — a settings page you have to scroll to find a chord in is
 * worse at its job than one you can read in a glance.
 *
 * Every change lands the moment you make it; there is no OK button to forget. Preferences are
 * plain localStorage keys plus a `panel-prefs` event — whoever cares listens and repaints.
 *
 * Recording a chord swallows the keystroke so the app never runs the thing you are BINDING,
 * and Escape cancels the recording rather than binding itself.
 */

import { invoke } from "@tauri-apps/api/core";
import { icon } from "../icons";
import {
  ACTIONS,
  IS_MAC,
  KEYMAP_EVENT,
  chordFromEvent,
  chordLabel,
  clashes,
  isCustom,
  isModifierOnly,
  label,
  parseChord,
  resetKeymap,
  setChord,
  type ActionDef,
} from "./keymap";
import "./settings.css";

/* --------------------------------------------------------------- preferences */

/** Fired after any preference changes, so open modules repaint instead of reloading. */
export const PREFS_EVENT = "panel-prefs";

/** The wall's column choice — the same key the toolbar's own picker writes. */
export const COLS_KEY = "panel-wall-cols";
export const COLS = ["1", "2", "3", "auto"] as const;

const prefKey = (id: string): string => `panel-pref-${id}`;

export const prefBool = (id: string, fallback: boolean): boolean => {
  const value = localStorage.getItem(prefKey(id));
  return value === null ? fallback : value === "1";
};

export const setPrefBool = (id: string, value: boolean): void => {
  localStorage.setItem(prefKey(id), value ? "1" : "0");
  window.dispatchEvent(new CustomEvent(PREFS_EVENT));
};

/** Every preference this page owns, so the defaults live in one place. */
export const PREF = {
  /** A tab that has lost its last terminal retires itself. Off puts the × back on every tab. */
  tabAutoClose: () => prefBool("tabs.autoClose", true),
  /** Follow a terminal you moved into the tab it landed in. */
  followMove: () => prefBool("tabs.followMove", true),
  /** Picking a project in the ＋ seat opens a plain shell in its folder instead of asking
   *  which engine. Off by default: the wall is an agent wall first. */
  plusShell: () => prefBool("plus.shell", false),
};

/* ------------------------------------------------------------------ recording */

/** True while a row is armed and waiting for a chord. Global handlers check this and stand
 *  down — a chord being BOUND must not also fire whatever it means today. */
let recording = false;
export const isRecording = (): boolean => recording;

/* --------------------------------------------------------------------- screen */

export type SettingsHandle = {
  open(): void;
  clear(): void;
  isOpen(): boolean;
};

export type SettingsEvents = {
  /** Done / Escape — the caller decides which screen comes back. */
  close(): void;
  skills?(): void;
};

const make = (tag: string, className: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

const button = (className: string, text: string): HTMLButtonElement => {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  return node;
};

/** A card in the grid. Everything on this screen is one of these. */
const card = (title: string): HTMLElement => {
  const box = make("section", "set-card");
  const head = make("h3", "set-card-head");
  head.textContent = title;
  box.append(head);
  return box;
};

/* ------------------------------------------------------------------ extensions */

/** One row of the extensions list, as the Rust side reports it. */
type CatalogEntry = {
  name: string;
  title: string;
  icon: string;
  summary: string;
  installed: boolean;
  /** False for anything the human dropped into `~/.appgeapanel/modules` themselves. */
  bundled: boolean;
  requires: string[];
  /** The subset of `requires` this machine does not have. */
  missing: string[];
};

/** Fired after an install or uninstall, so the project rail repaints without a reload. */
export const EXTENSIONS_EVENT = "panel-extensions";

export function mountSettings(host: HTMLElement, events: SettingsEvents): SettingsHandle {
  let openState = false;
  let grid: HTMLElement;
  let extensions: CatalogEntry[] = [];
  /* The Servers card is built once and re-parented on every paint. `paint()` runs on every
     toggle press, and rebuilding this one would re-fetch the board each time a checkbox moved. */
  let servers: HTMLElement | null = null;

  /* ------------------------------------------------------------------- rows */

  /** One shortcut: name, chord, and a reset only once it differs from the default. */
  const keyRow = (def: ActionDef, clashing: boolean): HTMLElement => {
    const row = make("div", `set-key${clashing ? " is-clash" : ""}`);
    const name = make("span", "set-key-name");
    name.textContent = def.name;
    row.title = clashing ? `${def.note} — this chord is bound twice` : def.note;
    row.append(name);

    const chip = button("set-chord", label(def.id));
    let armed = false;
    const stop = (): void => {
      armed = false;
      recording = false;
      window.removeEventListener("keydown", onKey, true);
    };
    function onKey(event: KeyboardEvent): void {
      if (!armed) return;
      // Nothing in the app may act on the key being BOUND, so swallow everything while armed.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isModifierOnly(event)) return;
      if (event.code === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        stop();
        paint();
        return;
      }
      setChord(def.id, chordFromEvent(event));
      stop();
      paint();
    }
    chip.addEventListener("click", () => {
      if (armed) return;
      armed = true;
      recording = true;
      chip.classList.add("is-recording");
      chip.textContent = "press…";
      window.addEventListener("keydown", onKey, true);
    });
    row.append(chip);

    const reset = button("set-reset", "↺");
    reset.title = `Back to the default — ${chordLabel(parseChord(IS_MAC ? def.mac : def.other), !!def.digits)}`;
    reset.setAttribute("aria-label", `reset ${def.name}`);
    reset.hidden = !isCustom(def.id);
    reset.addEventListener("click", () => {
      setChord(def.id, null);
      paint();
    });
    row.append(reset);
    return row;
  };

  const toggleRow = (
    name: string,
    note: string,
    value: boolean,
    onChange: (next: boolean) => void,
  ): HTMLElement => {
    const row = make("div", "set-key");
    const text = make("span", "set-key-name");
    text.textContent = name;
    row.title = note;
    const toggle = button(`set-toggle${value ? " is-on" : ""}`, "");
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(value));
    toggle.setAttribute("aria-label", name);
    toggle.append(make("i", "set-knob"));
    toggle.addEventListener("click", () => onChange(!value));
    row.append(text, toggle);
    return row;
  };

  const segRow = (
    name: string,
    note: string,
    values: readonly string[],
    current: string,
    onPick: (value: string) => void,
  ): HTMLElement => {
    const row = make("div", "set-key");
    const text = make("span", "set-key-name");
    text.textContent = name;
    row.title = note;
    const group = make("div", "set-seg");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", name);
    for (const value of values) {
      const pick = button(`set-seg-item${value === current ? " is-active" : ""}`, value);
      pick.addEventListener("click", () => onPick(value));
      group.append(pick);
    }
    row.append(text, group);
    return row;
  };

  /** One extension: what it is, what it wants, and a switch.
   *
   *  Nothing is downloaded. Every public extension already rides inside the app, so the switch
   *  only records the choice and the rail repaints. What the row adds is the part a name cannot
   *  carry: what the thing does, and which tools it needs that this machine does not have. */
  const extensionRow = (entry: CatalogEntry): HTMLElement => {
    const row = make("div", "set-ext");

    const glyph = make("span", "set-ext-icon");
    glyph.textContent = entry.icon;
    glyph.setAttribute("aria-hidden", "true");

    const body = make("div", "set-ext-body");
    const name = make("span", "set-ext-name");
    name.textContent = entry.title;
    if (!entry.bundled) {
      const mine = make("em", "set-ext-tag");
      mine.textContent = "yours";
      mine.title = "Found in ~/.appgeapanel/modules — remove that folder to uninstall it.";
      name.append(" ", mine);
    }
    const note = make("small", "set-ext-note");
    note.textContent = entry.summary;
    body.append(name, note);
    if (entry.missing.length) {
      const warn = make("small", "set-ext-missing");
      warn.textContent = `not on this machine: ${entry.missing.join(", ")}`;
      warn.title = "You can still install it. The parts that need these will fail until you have them.";
      body.append(warn);
    }

    const toggle = button(`set-toggle${entry.installed ? " is-on" : ""}`, "");
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(entry.installed));
    toggle.setAttribute("aria-label", entry.title);
    toggle.append(make("i", "set-knob"));
    toggle.addEventListener("click", () => {
      void (async () => {
        toggle.disabled = true;
        try {
          extensions = await invoke<CatalogEntry[]>(
            entry.installed ? "uninstall_module" : "install_module",
            { name: entry.name },
          );
          window.dispatchEvent(new CustomEvent(EXTENSIONS_EVENT));
        } catch (error) {
          // A user-dropped module refuses to be uninstalled from here — say so on the row rather
          // than in a dialog that steals the screen for one sentence.
          const failed = make("small", "set-ext-missing");
          failed.textContent = String(error);
          body.append(failed);
        } finally {
          toggle.disabled = false;
          paint();
        }
      })();
    });

    row.append(glyph, body, toggle);
    return row;
  };

  /* ------------------------------------------------------------------ paint */

  function paint(): void {
    grid.replaceChildren();

    const behaviour = card("Workspace");
    behaviour.append(
      toggleRow(
        "Tabs close themselves",
        "A tab retires when its last terminal is closed or moved away. Off keeps a × on every tab.",
        PREF.tabAutoClose(),
        (next) => {
          setPrefBool("tabs.autoClose", next);
          paint();
        },
      ),
      toggleRow(
        "Straight to a shell",
        "Picking a project in the ＋ seat opens a plain terminal in its folder instead of asking which agent. Hold ⌥ to be asked anyway.",
        PREF.plusShell(),
        (next) => {
          setPrefBool("plus.shell", next);
          paint();
        },
      ),
      toggleRow(
        "Follow a moved terminal",
        "Moving the last terminal out of a tab takes you to the tab it landed in.",
        PREF.followMove(),
        (next) => {
          setPrefBool("tabs.followMove", next);
          paint();
        },
      ),
      segRow(
        "Wall columns",
        "How the terminal wall splits. auto fits the count to the window.",
        COLS,
        localStorage.getItem(COLS_KEY) ?? "auto",
        (value) => {
          localStorage.setItem(COLS_KEY, value);
          window.dispatchEvent(new CustomEvent(PREFS_EVENT));
          paint();
        },
      ),
    );
    grid.append(behaviour);

    if (events.skills) {
      const workflows = card("Skills and workflows");
      const text = make("p", "set-hint");
      text.textContent = "Create shared workflows. Browse Claude and Codex skill files.";
      const manage = button("set-done", "Manage skills");
      manage.addEventListener("click", () => events.skills?.());
      workflows.append(text, manage);
      grid.append(workflows);
    }

    grid.append(serversCard());

    if (extensions.length) {
      const box = card("Extensions");
      box.classList.add("set-card-wide");
      const lead = make("p", "set-card-lead");
      lead.textContent =
        "Every one of these already ships inside Panel. Turning one on costs a restart of nothing — it just starts appearing on projects that can use it.";
      box.append(lead, ...extensions.map(extensionRow));
      grid.append(box);
    }

    const taken = clashes();
    let group: HTMLElement | null = null;
    let groupName = "";
    for (const def of ACTIONS) {
      if (def.group !== groupName) {
        groupName = def.group;
        group = card(`${groupName} shortcuts`);
        grid.append(group);
      }
      group!.append(keyRow(def, taken.has(def.id)));
    }
  }

  /* ------------------------------------------------------------------ servers */

  /**
   * The health check for the servers the human runs. It lives here rather than on a project
   * because a server belongs to the estate: the box serving a static site is usually not
   * described anywhere in that site's repo, so a per-project tab would appear on the wrong
   * screens and hide on the right ones. Settings is also where its list is configured, and the
   * board and the thing that configures it should not be two screens apart.
   *
   * The board itself is a lazy chunk — most sessions open Settings for a shortcut, not for this.
   */
  function serversCard(): HTMLElement {
    if (servers) return servers;
    const box = card("Servers");
    box.classList.add("set-card-wide");
    const lead = make("p", "set-card-lead");
    lead.textContent =
      "Whether the servers you run are answering, and how long until a certificate expires. " +
      "Ships empty — ask an agent to set it up, or edit the list it writes.";
    const body = make("div", "set-servers");
    box.append(lead, body);
    servers = box;
    void import("./server_health")
      .then(({ mountServerHealth }) => mountServerHealth(body))
      .catch(() => {
        body.textContent = "The server-health module is not installed.";
      });
    return box;
  }

  /* ----------------------------------------------------------------- handle */

  const onKey = (event: KeyboardEvent): void => {
    // A recording row swallows its own keys before this; anything here is a plain Escape.
    if (event.key !== "Escape" || recording || document.querySelector(".skills-overlay, .dlg-wrap, dialog[open]")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    events.close();
  };

  return {
    open() {
      openState = true;
      host.hidden = false;

      const inner = make("div", "set-inner is-enter");
      const head = make("header", "set-head");
      const title = make("span", "set-title");
      title.innerHTML = `<i aria-hidden="true">${icon("gear")}</i><b>Settings</b>`;
      const hint = make("small", "set-hint");
      hint.textContent = "Click a chord, then press the keys. Esc cancels.";
      const resetAll = button("set-reset-all", "Reset shortcuts");
      resetAll.title = "Every chord back to its default";
      resetAll.addEventListener("click", () => {
        resetKeymap();
        paint();
      });
      const done = button("set-done", "Done");
      done.title = "Back to the workspace — Esc";
      done.addEventListener("click", () => events.close());
      head.append(title, hint, resetAll, done);

      grid = make("div", "set-grid");
      inner.append(head, grid);
      host.replaceChildren(inner);
      paint();

      // Read on open, not at startup: it shells out a `which` per declared tool, which is cheap
      // here and pure waste on every launch for a screen most sessions never see.
      void invoke<CatalogEntry[]>("module_catalog")
        .then((list) => {
          extensions = list;
          if (openState) paint();
        })
        .catch(() => {
          extensions = [];
        });

      window.addEventListener(KEYMAP_EVENT, paint);
      window.addEventListener("keydown", onKey, true);
    },

    clear() {
      recording = false;
      openState = false;
      window.removeEventListener(KEYMAP_EVENT, paint);
      window.removeEventListener("keydown", onKey, true);
      host.replaceChildren();
      host.hidden = true;
    },

    isOpen: () => openState,
  };
}
