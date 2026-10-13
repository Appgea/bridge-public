#!/usr/bin/env python3
"""
Panel session hook forwarder — the single channel between a Claude session and
any panel module that wants to react to what the session is doing.

Claude Code fires this on session lifecycle events (PostToolUse, UserPromptSubmit,
…). It reads the hook JSON from stdin, forwards it to the panel at /hook/<event>,
and the panel fans it out to every module subscribing to that event (see each
module.json "hooks"). Modules can inject a feed card and/or return additionalContext;
we relay that context back to Claude via the hook's structured-output contract.

Design: the module never runs a server. The panel port is the whole integration
surface, so this works for ANY session wired to this hook — not a special launcher.

Fail-open: any error talking to the panel -> exit 0 with no output, so a module
being slow or down can never block or break the turn.
"""
import json, os, sys, urllib.request

BASE = "http://127.0.0.1:%s" % os.environ.get("PANEL_PORT", "7391")


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception:
        sys.exit(0)

    event = payload.get("hook_event_name") or ""
    if not event:
        sys.exit(0)

    body = json.dumps({
        # Panel gives every hosted agent an instance id. Carry it through the hook so two
        # Claude terminals in the same project keep separate turns and file working sets.
        "instance": os.environ.get("PANEL_INSTANCE", ""),
        "cwd": payload.get("cwd") or os.getcwd(),
        "session_id": payload.get("session_id", ""),
        "tool_name": payload.get("tool_name", ""),
        "tool_input": payload.get("tool_input") or {},
        "prompt": payload.get("prompt", ""),
        # Notification only: which kind of wait, and Claude's own sentence for it.
        "notification_type": payload.get("notification_type", ""),
        "message": payload.get("message", ""),
    }).encode()

    try:
        req = urllib.request.Request(BASE + "/hook/" + event, data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            res = json.loads(r.read() or "{}")
    except Exception:
        sys.exit(0)  # panel down / slow -> never touch the turn

    ctx = (res.get("additionalContext") or "").strip()
    if ctx:
        # Structured output is how PostToolUse/UserPromptSubmit feed text back into the
        # model's context; plain stdout would only reach the user, not Claude.
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": event, "additionalContext": ctx}}))
    sys.exit(0)


if __name__ == "__main__":
    main()
