import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";
import { confirmDialog } from "../views/dialog";
import "./skills.css";

type Skill = { path: string; name: string; description: string; provider: string; scope: string; editable: boolean; body: string; source: string; archived: boolean; department: string };
type SkillDocument = { entry: Skill; body: string; content: string };
type SessionPolicy = { overrides: Record<string, boolean>; applied: Record<string, boolean> };
type Usage = { supported: boolean; used: string[] };
export type SkillsContext = {
  session?: Session;
  sessions?: Session[];
  onRestart?: (session: Session) => Promise<Session>;
  onInsert?: (session: Session, text: string) => Promise<void>;
};
let dismiss: (() => Promise<void>) | undefined;
const requested = new Map<string, Set<string>>();
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text: string, action: () => void, primary = false) => {
  const node = el("button", `skills-button${primary ? " is-primary" : ""}`, text);
  node.type = "button";
  node.onclick = action;
  return node;
};
const providerNames: Record<string, string> = { claude: "Claude", codex: "Codex", shared: "Shared" };
const providerName = (provider: string) => providerNames[provider] ?? provider;
const departments: Record<string, string> = { company: "Company", legal: "Legal", design: "Design", general: "General" };

/** Skills are disk definitions. Staging a request never claims runtime activation. */
export async function openSkills(context: SkillsContext = {}): Promise<void> {
  if (dismiss) { await dismiss(); if (document.querySelector(".skills-overlay")) return; }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const wrap = el("div", "skills-overlay");
  const card = el("section", "skills-manager");
  card.role = "dialog";
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Skills manager");
  const header = el("header", "skills-header");
  header.append(el("div", "skills-heading", "Skills"));
  const sessions = [...new Map([...(context.sessions ?? []), ...(context.session ? [context.session] : [])].map(s => [s.id, s])).values()];
  let session = context.session;
  let entries: Skill[] = [];
  let policy: SessionPolicy = { overrides: {}, applied: {} };
  let usage: Usage = { supported: false, used: [] };
  let selected: Skill | undefined;
  let dirty = false;
  let busy = false;
  let generation = 0;
  const picker = el("select", "skills-select");
  picker.setAttribute("aria-label", "Skill library or session");
  picker.append(new Option("General library", ""));
  sessions.forEach(s => picker.append(new Option(`${providerName(s.kind)} · ${s.project} · ${s.title}`, s.id)));
  picker.value = session?.id ?? "";
  const status = el("div", "skills-status");
  status.role = "status";
  const note = el("p", "skills-context");
  const body = el("div", "skills-layout");
  const sidebar = el("aside", "skills-sidebar");
  const search = el("input", "skills-search");
  search.type = "search";
  search.placeholder = "Find a skill or workflow";
  search.setAttribute("aria-label", "Search skills");
  const filter = el("select", "skills-select");
  filter.setAttribute("aria-label", "Filter skill source");
  [ ["All sources", ""], ["Shared", "shared"], ["Claude", "claude"], ["Codex", "codex"] ].forEach(([label, value]) => filter.append(new Option(label, value)));
  const departmentFilter = el("select", "skills-select");
  departmentFilter.setAttribute("aria-label", "Filter department");
  departmentFilter.append(new Option("All departments", ""));
  Object.entries(departments).forEach(([value, label]) => departmentFilter.append(new Option(label, value)));
  const list = el("div", "skills-list");
  const detail = el("main", "skills-detail");
  const error = (e: unknown) => { status.textContent = String(e); status.classList.add("is-error"); };
  const message = (text: string) => { status.textContent = text; status.classList.remove("is-error"); };
  const discard = async () => !dirty || await confirmDialog("Discard unsaved skill changes?", { okLabel: "Discard changes", danger: true });
  const close = async (restoreFocus = true) => {
    if (busy || !await discard()) return;
    generation++;
    document.removeEventListener("keydown", onKey, true);
    wrap.remove(); dismiss = undefined;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    if (document.querySelector(".dlg-wrap")) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); void close(); }
    if (event.key === "Tab") {
      const nodes = [...card.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])")];
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  dismiss = close;
  const native = button("Manage session skills", () => { void (async () => {
    if (!session || !context.onInsert || busy || !await discard()) return;
    busy = true;
    try { await context.onInsert(session, "/skills"); dirty = false; busy = false; await close(false); }
    catch (e) { error(e); }
    finally { busy = false; }
  })(); });
  native.title = "Stage /skills. Press Enter in the terminal. Native settings may affect other sessions.";
  header.append(picker, native, button("New workflow", () => { void create(); }, true), button("Done", () => { void close(); }));
  sidebar.append(search, departmentFilter, filter, button("Refresh skills", () => { void (async () => {
    if (busy || !await discard()) return;
    dirty = false; await reload(selected?.path);
  })(); }), list);
  body.append(sidebar, detail);
  card.append(header, note, body, status);
  wrap.append(card);
  document.body.append(wrap);
  document.addEventListener("keydown", onKey, true);
  search.focus();

  function paintList() {
    list.replaceChildren();
    const query = search.value.toLowerCase().trim();
    const visible = entries.filter(skill => (!session || (session.kind !== "claude" && session.kind !== "codex") || skill.provider === "shared" || skill.provider === session.kind) && (!filter.value || skill.provider === filter.value) && (!departmentFilter.value || skill.department === departmentFilter.value) && `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(query));
    let lastDepartment = "";
    visible.forEach(skill => {
      if (skill.department !== lastDepartment) {
        list.append(el("h3", "skills-department-heading", departments[skill.department] ?? "General"));
        lastDepartment = skill.department;
      }
      const row = button("", () => { void select(skill); });
      row.className = `skills-row${selected?.path === skill.path ? " is-selected" : ""}`;
      row.append(el("span", "skills-row-name", skill.name + (skill.archived ? " · Archived" : "")), el("span", `skills-badge source-${skill.provider}`, providerName(skill.provider)), el("span", "skills-row-description", skill.description || "No description"));
      const used = usage.used.includes(skill.name);
      const staged = !!session && requested.get(session.id)?.has(skill.path);
      row.append(el("span", "skills-row-description", used ? "Used this session" : staged ? "Request staged" : skill.archived ? "Archived workflow" : skill.provider === "shared" ? "Shared workflow" : "On disk"));
      list.append(row);
    });
    if (!visible.length) list.append(el("p", "skills-empty", "No matching skills. Create a shared workflow to start."));
  }
  async function reload(path?: string) {
    const request = ++generation;
    message("Loading skills…");
    try {
      const [catalog, observed, settings] = await Promise.all([
        invoke<Skill[]>("skills_catalog", { session: session?.id ?? null }),
        session ? invoke<Usage>("skills_usage", { session: session.id }) : Promise.resolve({ supported: false, used: [] }),
        session && (session.kind === "claude" || session.kind === "codex") ? invoke<SessionPolicy>("skills_session_policy", { session: session.id }) : Promise.resolve({ overrides: {}, applied: {} }),
      ]);
      if (request !== generation || !wrap.isConnected) return;
      entries = catalog; usage = observed; policy = settings;
      native.hidden = !session || !context.onInsert || (session.kind !== "claude" && session.kind !== "codex");
      const supported = !session || session.kind === "claude" || session.kind === "codex";
      note.textContent = !supported ? "This session engine is unsupported. Browse the general library instead." : session ? `${providerName(session.kind)} session · On-disk definitions. ${usage.supported ? "Usage reflects observed skill calls only." : "Usage is not reported by this session."}` : "One shared library for Claude and Codex. Edit instructions and references here.";
      if (usage.used.length) note.textContent += ` Used this session: ${usage.used.join(", ")}.`;
      message(`${entries.length} skills`);
      paintList();
      const next = entries.find(skill => skill.path === path) ?? entries[0];
      if (next) await select(next, true);
      else { selected = undefined; detail.replaceChildren(el("p", "skills-empty", "Create a workflow for work you repeat.")); }
    } catch (e) { if (request === generation) error(e); }
  }
  async function select(skill: Skill, force = false) {
    if (busy || (!force && !await discard())) return;
    const request = ++generation;
    try {
      const current = await invoke<{ entry: Skill; content: string }>("skills_read_document", { path: skill.path });
      const doc: SkillDocument = { ...current, body: current.entry.body };
      if (request !== generation || !wrap.isConnected) return;
      selected = current.entry; dirty = false;
      entries = entries.map(entry => entry.path === skill.path ? current.entry : entry);
      paintList();
      editor(doc);
    } catch (e) { if (request === generation) error(e); }
  }
  function field(label: string, value: string, multiline = false, readonly = false) {
    const holder = el("label", "skills-field");
    const input = multiline ? el("textarea", "skills-input") : el("input", "skills-input");
    input.value = value; input.readOnly = readonly;
    input.oninput = () => { dirty = true; };
    holder.append(el("span", "skills-label", label), input);
    return { holder, input };
  }
  function editor(doc?: SkillDocument) {
    detail.replaceChildren();
    const skill = doc?.entry;
    const editable = !skill || skill.editable;
    const heading = el("div", "skills-detail-heading");
    heading.append(el("h2", "", skill?.name ?? "New shared workflow"), el("span", `skills-badge source-${skill?.provider ?? "shared"}`, providerName(skill?.provider ?? "shared")));
    detail.append(heading);
    if (skill) detail.append(el("p", "skills-path", `${skill.source} · ${skill.scope} · ${skill.path}`));
    else detail.append(el("p", "skills-help", "Define once. Claude and Codex discover the same shared files."));
    if (skill && session && (skill.provider === session.kind || skill.source === "panel" || (session.kind === "codex" && skill.provider === "shared")) && skill.source !== "plugin" && !skill.archived) {
      const control = el("section", "skills-policy");
      const setting = el("select", "skills-select");
      setting.setAttribute("aria-label", "Skill availability for this session");
      [["Default", "default"], ["Enabled", "true"], ["Disabled", "false"]].forEach(([label, value]) => setting.append(new Option(label, value)));
      const settingValue = () => skill.path in policy.overrides ? String(policy.overrides[skill.path]) : "default";
      setting.value = settingValue();
      const pending = el("span", "skills-help");
      const resume = button("Apply and resume…", () => { void (async () => {
        if (busy || !context.onRestart || !session || !await discard()) return;
        busy = true; resume.disabled = true;
        try {
          const previous = session;
          session = await context.onRestart(session);
          if (session.terminal_id === previous.terminal_id) return;
          dirty = false; busy = false; await reload(skill.path);
          await close(false);
        } catch (e) { error(e); }
        finally { busy = false; resume.disabled = false; }
      })(); });
      const paintPolicy = () => {
        const paths = new Set([...Object.keys(policy.overrides), ...Object.keys(policy.applied)]);
        const needsRestart = [...paths].some(path => policy.overrides[path] !== policy.applied[path]);
        pending.textContent = needsRestart ? "Pending restart" : Object.keys(policy.applied).length ? "Session settings applied" : "Using agent defaults";
        resume.hidden = !needsRestart || !context.onRestart;
      };
      setting.onchange = () => { void (async () => {
        if (busy) { setting.value = settingValue(); return; }
        busy = true; setting.disabled = true;
        try {
          policy = await invoke<SessionPolicy>("skills_session_set", { session: session!.id, path: skill.path, enabled: setting.value === "default" ? null : setting.value === "true" });
          paintPolicy();
        } catch (e) { setting.value = settingValue(); error(e); }
        finally { busy = false; setting.disabled = false; }
      })(); };
      paintPolicy();
      control.append(el("span", "skills-label", "This session"), setting, pending, resume, el("p", "skills-help", "Only this session. Restart opens the agent’s conversation picker. Loaded instructions remain in resumed history."));
      detail.append(control);
    }
    const name = field("Name", skill?.name ?? "", false, !editable || skill?.source === "panel");
    const description = field("Description", skill?.description ?? "", false, !editable);
    if (editable) name.holder.append(el("span", "skills-help", "Lowercase letters, numbers, and single hyphens. Up to 64 characters."));
    detail.append(name.holder, description.holder);
    const departmentSelect = el("select", "skills-select");
    Object.entries(departments).forEach(([value, label]) => departmentSelect.append(new Option(label, value)));
    departmentSelect.value = skill?.department ?? (departmentFilter.value || "general");
    departmentSelect.onchange = () => { dirty = true; };
    if (!skill || skill.source === "panel") {
      const holder = el("label", "skills-field");
      holder.append(el("span", "skills-label", "Department"), departmentSelect);
      detail.append(holder);
    }
    const markdown = field("Instructions · Markdown", doc?.body ?? "", true, !editable);
    const trigger = field("When to use", "", true);
    const steps = field("Steps", "", true);
    const output = field("Expected output", "", true);
    if (doc) { markdown.input.classList.add("skills-markdown"); detail.append(markdown.holder); }
    else detail.append(trigger.holder, steps.holder, output.holder);
    if (skill && !editable) detail.append(el("p", "skills-help", "Installed source is read-only. Copy it into a shared workflow."));
    const actions = el("div", "skills-actions");
    const run = async (action: () => Promise<void>) => {
      if (busy) return;
      busy = true;
      detail.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>("button,input,textarea,select").forEach(b => b.disabled = true);
      try { await action(); } catch (e) { error(e); }
      finally { busy = false; detail.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>("button,input,textarea,select").forEach(b => b.disabled = false); }
    };
    if (editable) actions.append(button(skill?.archived ? "Restore workflow" : "Save workflow", () => { void run(async () => {
      if (!name.input.value.trim() || !description.input.value.trim()) throw new Error("Add a name and description.");
      if (!doc && (!trigger.input.value.trim() || !steps.input.value.trim() || !output.input.value.trim())) throw new Error("Add a trigger, steps, and expected output.");
      const bodyText = doc ? markdown.input.value : `## When to use\n\n${trigger.input.value.trim()}\n\n## Steps\n\n${steps.input.value.trim()}\n\n## Expected output\n\n${output.input.value.trim()}\n`;
      const saved = await invoke<Skill>("skills_save", { path: skill?.path ?? null, name: name.input.value.trim(), description: description.input.value.trim(), body: bodyText, expected: doc?.content ?? null, department: departmentSelect.value });
      dirty = false; busy = false;
      await reload(saved.path);
      message("Workflow saved. New sessions discover shared skills automatically.");
    }); }, true));
    if (doc) actions.append(button("Copy to shared", () => { void (async () => {
      if (busy || !await discard()) return;
      selected = undefined; editor(); paintList();
      const inputs = detail.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
      inputs[0].value = `${skill!.name}-copy`; inputs[1].value = skill!.description;
      inputs[2].value = "Use when this workflow fits the current task.";
      inputs[3].value = doc.body; inputs[4].value = "Complete the workflow and report the result.";
      dirty = true;
    })(); }));
    if (doc && !skill?.archived && policy.applied[skill!.path] !== false && session && context.onInsert && (session.kind === "claude" || session.kind === "codex")) {
      actions.append(button("Stage skill request", () => { void run(async () => {
        if (dirty) throw new Error("Save or discard changes before staging this skill.");
        await context.onInsert!(session!, `Use the skill at ${JSON.stringify(skill!.path)} for this task. Read its SKILL.md and follow its workflow.\n`);
        const staged = requested.get(session!.id) ?? new Set<string>();
        staged.add(skill!.path); requested.set(session!.id, staged); paintList(); editor(doc);
        message("Request staged. Submit it in the session to request use.");
        busy = false; await close(false);
      }); }));
    }
    if (skill && session && context.onInsert && (usage.used.includes(skill.name) || requested.get(session.id)?.has(skill.path))) {
      actions.append(button("Stage stop request", () => { void run(async () => {
        if (dirty) throw new Error("Save or discard changes before staging a stop request.");
        await context.onInsert!(session!, `For subsequent tasks, stop using the skill at ${JSON.stringify(skill.path)} unless I request it again. Existing instructions may remain in context.\n`);
        requested.get(session!.id)?.delete(skill.path); paintList(); editor(doc);
        message("Stop request staged. Submit it in the session. Loaded instructions remain in context.");
        busy = false; await close(false);
      }); }));
    }
    if (skill?.editable && !skill.archived && skill.source === "panel") actions.append(button("Archive", () => { void run(async () => {
      if (dirty) throw new Error("Save or discard changes before archiving this workflow.");
      if (!await confirmDialog("Archive this shared workflow? Remove discovery links for new sessions. Keep its files. Loaded instructions remain in existing sessions.", { okLabel: "Archive workflow", danger: true })) return;
      await invoke("skills_archive", { path: skill.path });
      dirty = false; busy = false; await reload(); message("Workflow archived.");
    }); }));
    detail.append(actions);
    if (skill) {
      const references = el("section", "skills-references");
      references.append(el("h3", "", "References"), el("p", "skills-help", "Keep detailed rules, sources, and remembered decisions here."));
      const referenceList = el("div", "skills-actions");
      references.append(referenceList);
      detail.append(references);
      void invoke<string[]>("skills_resources", { path: skill.path }).then(files => {
        if (!references.isConnected) return;
        files.forEach(relative => referenceList.append(button(relative.split("/").pop()!, () => { void openReference(skill, relative); })));
        if (!files.length) referenceList.append(el("span", "skills-help", "No references yet."));
        if (editable) referenceList.append(button("Add reference", () => { void openReference(skill); }));
      }).catch(error);
    }
  }
  async function openReference(skill: Skill, relative?: string) {
    if (busy || !await discard()) return;
    const request = ++generation;
    try {
      const content = relative ? await invoke<string>("skills_resource_read", { path: skill.path, relative }) : "";
      if (request !== generation || !wrap.isConnected) return;
      dirty = false;
      detail.replaceChildren();
      detail.append(button("Back to instructions", () => { void select(skill); }), el("h2", "", relative?.split("/").pop() ?? "New reference"));
      const filename = field("File name", relative ?? "references/topic.md", false, !!relative);
      const text = field("Content · Markdown", content, true, !skill.editable);
      text.input.classList.add("skills-markdown");
      detail.append(filename.holder, text.holder);
      if (skill.editable) {
        let expected: string | null = relative ? content : null;
        const save = button("Save reference", () => { void (async () => {
          if (busy) return;
          busy = true; save.disabled = true;
          const submitted = text.input.value;
          const submittedName = filename.input.value.trim();
          filename.input.disabled = true;
          try {
            await invoke("skills_resource_save", { path: skill.path, relative: submittedName, content: submitted, expected });
            expected = submitted; filename.input.readOnly = true;
            dirty = text.input.value !== submitted;
            message("Reference saved. Link new references from the skill instructions.");
          } catch (e) { error(e); }
          finally { busy = false; save.disabled = false; filename.input.disabled = false; }
        })(); }, true);
        detail.append(save);
      }
    } catch (e) { error(e); }
  }
  async function create() {
    if (busy || !await discard()) return;
    generation++; selected = undefined; dirty = false; paintList(); editor();
    detail.querySelector("input")?.focus();
  }
  picker.onchange = () => { void (async () => {
    if (busy || !await discard()) { picker.value = session?.id ?? ""; return; }
    session = sessions.find(s => s.id === picker.value); filter.value = ""; dirty = false; selected = undefined;
    await reload();
  })(); };
  search.oninput = paintList; filter.onchange = paintList; departmentFilter.onchange = paintList;
  await reload();
}
