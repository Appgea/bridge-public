/**
 * The single source of truth for what can sit in a terminal — one real agent binary per
 * kind, plus the plain shell. `kind` is exactly the executable Panel execs (`kind === "grok"`
 * runs `grok` on PATH), so adding a new coding agent is one entry here, nothing else.
 *
 * `name` is the short label; `sub` is a quiet tag for a variant of an engine that shares its
 * binary (an opencode model) so the row reads even next to the bare engine it comes from.
 */

import type { IconName } from "../icons";

export type SessionKind =
  | "claude"
  | "codex"
  | "grok"
  | "dshline"
  | "kimi"
  | "glm"
  | "opencode"
  | "opencode-kimi-k3"
  | "opencode-deepseek-v4-flash"
  | "shell";

export type EngineDef = { kind: SessionKind; glyph: IconName; name: string; sub?: string };

/** Order here is display order everywhere: the strip, the wall's ＋ picker. Shell sits first. */
export const ENGINES: EngineDef[] = [
  { kind: "shell", glyph: "terminal", name: "Shell" },
  { kind: "claude", glyph: "agent", name: "Claude" },
  { kind: "codex", glyph: "code", name: "Codex" },
  { kind: "grok", glyph: "agent", name: "Grok" },
  { kind: "kimi", glyph: "agent", name: "Kimi" },
  { kind: "glm", glyph: "agent", name: "GLM" },
  { kind: "opencode", glyph: "code", name: "opencode" },
  { kind: "opencode-kimi-k3", glyph: "code", name: "Kimi K3", sub: "opencode" },
  { kind: "opencode-deepseek-v4-flash", glyph: "code", name: "DeepSeek v4 Flash", sub: "opencode" },
  { kind: "dshline", glyph: "code", name: "DeepSeek", sub: "Harness" },
];

/** Every engine except the plain shell — the "is a coding agent" test the dashboard,
 *  Home and the workshop use to decide whether a project counts as "running". */
const AGENT_KINDS = new Set(ENGINES.filter((e) => e.kind !== "shell").map((e) => e.kind));

export const isAgentKind = (kind: string): boolean => AGENT_KINDS.has(kind as SessionKind);
