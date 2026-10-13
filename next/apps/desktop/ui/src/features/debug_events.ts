/**
 * Browser-local signals that keep Work and Debug looking at the same session.
 *
 * Rust owns the adapter; Debug owns the DAP conversation. Work is a third surface that has to
 * agree with both without duplicating either — so Debug SAYS what happened here, and Work
 * listens. Actions travel the other way, through the debugger handle, never through an event:
 * a command with no answer is a command you cannot report a failure for.
 */

/** One browser-local signal keeps Work's gutter and Debug's list on the same breakpoint set. */
export const BREAKPOINTS_EVENT = "panel-debug-breakpoints";

export type BreakpointsChanged = {
  project: string;
  path: string;
  lines: number[];
};

export function announceBreakpoints(detail: BreakpointsChanged): void {
  window.dispatchEvent(new CustomEvent<BreakpointsChanged>(BREAKPOINTS_EVENT, { detail }));
}

/** Where a session is, said out loud, so Work can wear a debug bar without owning a session. */
export const DEBUG_PHASE_EVENT = "panel-debug-phase";

export type DebugPhase = "idle" | "starting" | "running" | "paused" | "ended" | "error";

/** Every command the Debug toolbar can send. Work's bar sends the same set. */
export type DebugCommand = "continue" | "pause" | "next" | "stepIn" | "stepOut" | "stop";

export type DebugPhaseChanged = {
  project: string;
  phase: DebugPhase;
  /** A profile exists, so Start is a real offer rather than a dead button. */
  canStart: boolean;
  /**
   * Where the program is stopped, project-relative. Null unless paused with a located frame.
   * Work opens this file and marks the line; nothing else needs it.
   */
  at: { path: string; line: number } | null;
  error: string;
};

export function announceDebugPhase(detail: DebugPhaseChanged): void {
  window.dispatchEvent(new CustomEvent<DebugPhaseChanged>(DEBUG_PHASE_EVENT, { detail }));
}
