---
id: <stream-id>               # short slug, e.g. checkout-paywall
ref: [<app-key>]              # app key(s) this touches; [] if cross-cutting
owner: <you|cpo|agent-label>  # who is driving it (human / cpo / a specific agent or background id)
status: active                # active | blocked | review | merging
goal: <one line, the objective>
done-when: <observable, machine-checkable criterion — P-13>
behavior_refs: []             # relevant B-... rules; [] when behavior is unaffected
behavior_delta: none          # observable before -> after; "none" for behavior-preserving work
behavior_authority: none      # none | user-request | existing-contract | decision:D-NNNN | pending-human
logic_status: not-required    # not-required | direct | assumed | draft | approved
logic_approved_on: null       # YYYY-MM-DD after explicit approval
branch: null                  # git branch if this is code work mid-flight
started: YYYY-MM-DD
---

# <stream-id>

## Now
One line: where this stream actually is right now.

## Blockers
- only if status is blocked/review — what's needed and from whom

## Logic Patch
<!-- Fill only for draft/approved Lane-3 review. For `assumed`, put one sentence in Now/Log. -->

**Review artifact.** `inline`, or the editable text/scheme/showcase artifact path. Reread paths from
disk after human edits; do not trust a prior context copy.

**Goal.** Why this change exists.

**Today.** Current observable behavior.

**After.** New observable behavior.

**Rules.**
- L1 — When <event>, if <condition>, then <outcome>.

**Never.**
- Forbidden side effects and explicit non-goals.

**Examples.**
- Given <state>, when <event>, then <result>.

**State sketch.** Only when entities/states/transitions clarify the rules; otherwise `none`.

**Open questions.** `none` before approval.

## Delivery Review
<!-- Fill after implementation; explain behavior before technical detail. -->

**What now happens.** Map each approved L-rule to the observed result.

**Unchanged.** What deliberately did not change.

**Proof.** Real scenarios plus links/paths to visual or interactive artifacts when terminal output
cannot demonstrate the experience.

**Deviations / follow-ups.** `none` or explicit differences from the approved Logic Patch.

**Technical appendix.** Changed surfaces and focused checks, kept short.

## Log
- YYYY-MM-DD — what was done + result (record-as-you-act lands HERE, not in a shared file)
