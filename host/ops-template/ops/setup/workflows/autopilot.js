export const meta = {
  name: 'autopilot',
  description:
    'Run delegated multi-step work with an ambiguity × consequence balancer. Clear requests proceed, low-cost ambiguity proceeds under a named assumption, and only ambiguous consequential meaning pauses for a Logic Patch. Then plan, execute, verify, and return a proportionate Delivery Review with proof appropriate to the surface.',
  phases: [
    { title: 'Frame' },
    { title: 'Plan' },
    { title: 'Execute' },
    { title: 'Review' },
  ],
}

// Inputs (args):
//   goal:        string — what to accomplish (required for a new job)
//   workdir:     string — repo/dir to operate in (default '.')
//   resumeDir:   string — existing job dir after a human gate
//   decision:    string — the human's approval/edit/answer that unblocks a gate
//   maxRetries:  number — verify-gate auto-fix attempts per phase (default 2)

const goal = typeof args === 'string' ? args : (args && args.goal) || ''
const workdir = (args && args.workdir) || '.'
const resumeDir = (args && args.resumeDir) || ''
const decision = (args && args.decision) || ''
const MAX_RETRIES = (args && args.maxRetries) != null ? args.maxRetries : 2

if (!goal && !resumeDir) {
  return { status: 'error', error: 'autopilot needs a goal for a new job or resumeDir to continue.' }
}

const FRAME_SCHEMA = {
  type: 'object',
  required: ['jobDir', 'ledgerPath', 'logicPath', 'changesBusinessLogic', 'logicReviewRequired', 'logicApproved', 'reviewMedium', 'reviewArtifacts', 'summary'],
  properties: {
    jobDir: { type: 'string', description: 'absolute job directory' },
    ledgerPath: { type: 'string', description: 'absolute append-only ledger path' },
    logicPath: { type: 'string', description: 'absolute Logic Patch path, including a not-required note when exempt' },
    changesBusinessLogic: { type: 'boolean' },
    logicReviewRequired: { type: 'boolean', description: 'true only when meaning is both ambiguous and consequential' },
    logicApproved: { type: 'boolean', description: 'true only after explicit human approval recorded in the supplied decision' },
    reviewMedium: { type: 'string', description: 'inline | text | scheme | showcase | mixed' },
    reviewArtifacts: { type: 'array', items: { type: 'string' }, description: 'absolute editable/visual artifact paths' },
    summary: { type: 'string', description: '<=5 lines in business language' },
    approvalQuestion: { type: 'string', description: 'one concise question when approval is still needed' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['jobDir', 'briefPath', 'ledgerPath', 'phases'],
  properties: {
    jobDir: { type: 'string' },
    briefPath: { type: 'string' },
    ledgerPath: { type: 'string' },
    summary: { type: 'string', description: '<=5 lines' },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'task', 'verify', 'humanGated', 'done'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          task: { type: 'string' },
          verify: { type: 'string', description: 'objective checks plus mapped L-rule scenarios where applicable' },
          humanGated: { type: 'boolean' },
          gateReason: { type: 'string' },
          done: { type: 'boolean' },
        },
      },
    },
  },
}

const WORK_SCHEMA = {
  type: 'object',
  required: ['summary', 'changedFiles', 'selfCheck'],
  properties: {
    summary: { type: 'string', description: '<=5 lines' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    selfCheck: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['pass', 'stuck'],
  properties: {
    pass: { type: 'boolean' },
    stuck: { type: 'boolean' },
    issues: { type: 'string' },
    escalateReason: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['summary', 'reviewPath', 'verified', 'proofType', 'proofArtifacts'],
  properties: {
    summary: { type: 'string', description: '<=180 words, business result first' },
    reviewPath: { type: 'string', description: 'absolute path to delivery-review.md' },
    verified: { type: 'boolean', description: 'false when the required real/visual proof could not be produced' },
    proofType: { type: 'string', description: 'terminal | scenario | visual | interactive | mixed' },
    proofArtifacts: { type: 'array', items: { type: 'string' } },
    verificationGap: { type: 'string' },
  },
}

// Phase 0: FRAME. Balance autonomy against the cost of a wrong interpretation.
phase('Frame')
const frame = await agent(
  `You are the BUSINESS LOGIC FRAMER for a delegated job in ${workdir}.
${resumeDir ? `Resume the job at ${resumeDir}. Read its logic.md and ledger.md. The human's new reply is: "${decision}".`
            : `This is a new job. Create scratch/autopilot-<short-slug>/ with logic.md and ledger.md.`}

REQUEST:
${goal || '(resume the recorded request)'}

First classify whether this changes observable business/domain logic: user-visible rules, entity
meaning or creation, state transitions, progression/unlocks, economy, permissions, or consequential
side effects. Visual-only polish, refactors, exact bug restoration, research, and mechanical ops are
exempt. Then judge TWO separate axes:
1) AMBIGUITY — do multiple reasonable product meanings remain after reading the request?
2) CONSEQUENCE — would choosing wrong cause meaningful behavior change, rework, migration, or hard reversal?

Choose exactly one lane:
- DIRECT: meaning is clear. The explicit request is authority; proceed without asking again.
- ASSUMED: some ambiguity exists, but it is local/reversible/cheap. Record the simplest reasonable
  assumption in one sentence and proceed without waiting.
- REVIEW: BOTH ambiguity and consequence are high. Draft a Logic Patch and wait for approval.
Do not manufacture ambiguity from implementation choices. Irreversible external actions are a later
human gate, not a reason to demand semantic approval when meaning is clear.

Choose the smallest useful review medium:
- INLINE by default.
- TEXT when the human benefits from editing exact wording/rules: use logic.txt with STATUS: DRAFT.
- SCHEME when relationships, branching, or 3+ state transitions are clearer visually: use logic.md
  with a compact Mermaid diagram plus plain-language consequences.
- SHOWCASE when the uncertainty concerns the real visible screen/navigation/interaction/visual state:
  invoke the project showcase skill and return its current image path. Keep semantic rules beside it.
- MIXED only when two media materially answer different parts; never produce all by default.

Do NOT inspect implementation source, choose architecture, name files/classes, or make a technical plan,
except for the minimum existing-screen inspection/rendering required by showcase. You may otherwise read
only relevant ops app state and sparse behavior-contract sections to understand TODAY.

For REVIEW work, write/maintain logic.txt or logic.md as selected, as a concise Logic Patch:
  Goal; Today; After; Rules (L1...: When event, if condition, then outcome); Never; Examples
  (success, boundary, failure); State sketch only when useful; Open questions; Approval.
Use ordinary nouns and verbs and keep it near one screen. Record status DRAFT until the human explicitly
approves this exact patch. On resume, apply requested edits. Set logicApproved:true only when the supplied
human reply explicitly approves the result; STATUS: APPROVED set by the human also counts. On any resume,
ALWAYS reread the current artifact from disk, preserve human edits, and evaluate contradictions, missing
boundary/failure examples, forbidden-side-effect gaps, contract conflicts, and remaining expensive ambiguity.
Never restore an older context copy. Record approval and the evaluation result in the ledger.

For DIRECT work, write a short logic.md saying DIRECT and quote the controlling request. For ASSUMED,
write ASSUMED plus the one-sentence assumption. For exempt work, write NOT REQUIRED and why. Set
logicReviewRequired:true only for REVIEW. Return the chosen medium and artifact paths in the schema; do
no code work.`,
  { phase: 'Frame', schema: FRAME_SCHEMA },
)

if (!frame || !frame.jobDir) {
  return { status: 'error', error: 'business-logic frame returned no job directory', frame }
}

if (frame.logicReviewRequired && !frame.logicApproved) {
  return {
    status: 'escalate',
    reason: 'product meaning is both ambiguous and consequential',
    jobDir: frame.jobDir,
    logicPath: frame.logicPath,
    reviewMedium: frame.reviewMedium,
    reviewArtifacts: frame.reviewArtifacts,
    decisionNeeded: frame.approvalQuestion || 'Review the Logic Patch and approve it or state edits.',
    logicSummary: frame.summary,
    resumeHint: `re-run autopilot with args.resumeDir="${frame.jobDir}" and args.decision="<approval or edits>"`,
  }
}

// Phase 1: PLAN. Use the direct, assumed, or approved semantic envelope.
phase('Plan')
const plan = await agent(
  `You are the TECHNICAL PLANNER for an autonomous job in ${workdir}.
Job dir: ${frame.jobDir}
Logic contract: ${frame.logicPath}
Review evidence: ${(frame.reviewArtifacts || []).join(', ')}
Ledger: ${frame.ledgerPath}
${resumeDir ? `Resume prior technical progress. Human reply at the latest non-logic gate: "${decision}".` : ''}

REQUEST:
${goal || frame.summary}

Read logic.md first. APPROVED L-rules are immutable semantic authority. DIRECT means the explicit
request is authority. ASSUMED means the request plus its one-sentence low-risk assumption is authority.
NOT REQUIRED means preserve requested behavior exactly. Do not turn a direct or assumed lane into a
review merely because implementation offers several technical options.

Inspect relevant code once. Write/refresh brief.md in the existing job dir and use the existing ledger.md.
The brief contains scope, exact interfaces/file map, constraints, a compact discovery digest, and a serial
phase list grouped by file locality. Map REVIEW work to L-rule IDs; map DIRECT/ASSUMED work to the request
and named assumption. A visible screen/flow must include render/run evidence; terminal-only checks are
insufficient. Stop only if code reality creates a NEW ambiguous + consequential product choice. Resolve
reversible implementation details yourself.

Tag only true later human gates: store submit/publish, price, production release, spend, credentials,
subjective taste/final visual approval, or a newly discovered semantic choice. Split buildable work from a
gated tail so the gate does not block unrelated implementation. Return the plan schema; do not execute.`,
  { phase: 'Plan', schema: PLAN_SCHEMA },
)

if (!plan || !plan.phases || !plan.phases.length) {
  return {
    status: 'escalate',
    reason: 'technical planning found no executable plan, usually because a consequential semantic choice remains',
    jobDir: frame.jobDir,
    logicPath: frame.logicPath,
    decisionNeeded: (plan && plan.summary) || 'Review the ledger and clarify the semantic choice.',
  }
}

// Phase 2: EXECUTE and independently verify against both technical criteria and approved meaning.
phase('Execute')
const completed = []
for (const ph of plan.phases) {
  if (ph.done) {
    completed.push({ id: ph.id, title: ph.title, status: 'already-done' })
    continue
  }

  if (ph.humanGated) {
    return {
      status: 'escalate',
      reason: 'human-gated fork reached',
      jobDir: plan.jobDir,
      logicPath: frame.logicPath,
      decisionNeeded: ph.gateReason || ph.task,
      phase: ph.title,
      completed,
      resumeHint: `re-run autopilot with args.resumeDir="${plan.jobDir}" and args.decision="<your call>"`,
    }
  }

  let attempt = 0
  let verdict = null
  let work = null
  do {
    work = await agent(
      `Execute one phase in ${workdir}.
Approved logic: ${frame.logicPath}
Technical brief: ${plan.briefPath}
Ledger: ${plan.ledgerPath}
PHASE: ${ph.title}
TASK: ${ph.task}
ACCEPTANCE: ${ph.verify}
${attempt > 0 ? `RETRY ${attempt}; fix only these verified failures: ${verdict && verdict.issues}` : ''}

Read the semantic envelope and relevant brief digest. Implement the smallest change inside it. Never invent
business behavior. Stop only if implementation exposes a new ambiguous + consequential product choice;
otherwise make the simplest reversible implementation call. Run focused checks and append a short ledger
result. Return compactly; no diff dump.`,
      { phase: 'Execute', label: `do:${ph.id}`, schema: WORK_SCHEMA },
    )

    verdict = await agent(
      `Act as an adversarial verify gate in ${workdir}.
Approved logic: ${frame.logicPath}
Technical brief: ${plan.briefPath}
PHASE: ${ph.title}
ACCEPTANCE: ${ph.verify}
CLAIM: ${work ? work.summary : '(nothing)'}
CHECK: ${work ? work.selfCheck : ''}
FILES: ${work ? (work.changedFiles || []).join(', ') : ''}

Independently verify the changed ranges and rerun focused checks. For REVIEW work, exercise each cited
L-rule and Never constraint. For DIRECT/ASSUMED work, verify against the explicit request and named
assumption. A tailored test cannot overrule that meaning. Set stuck:true only for a new ambiguous +
consequential choice, required human judgment, credential, or missing external input. Otherwise return
concrete fixable issues.`,
      { phase: 'Execute', label: `verify:${ph.id}`, schema: VERDICT_SCHEMA },
    )
    attempt++
  } while (verdict && !verdict.pass && !verdict.stuck && attempt <= MAX_RETRIES)

  if (!verdict || !verdict.pass) {
    return {
      status: 'escalate',
      reason: verdict && verdict.stuck ? 'phase conflicts with approved logic or needs a human' : 'phase failed after retries',
      jobDir: plan.jobDir,
      logicPath: frame.logicPath,
      decisionNeeded: (verdict && verdict.escalateReason) || (verdict && verdict.issues) || 'see ledger',
      phase: ph.title,
      attempts: attempt,
      completed,
      resumeHint: `resolve, then re-run with args.resumeDir="${plan.jobDir}" and args.decision="<resolution>"`,
    }
  }

  completed.push({ id: ph.id, title: ph.title, status: 'passed', attempts: attempt, files: work.changedFiles })
  log(`✓ ${ph.title} (${attempt} attempt${attempt > 1 ? 's' : ''})`)
}

// Phase 3: REVIEW. Explain and demonstrate the result in the language that was approved.
phase('Review')
const review = await agent(
  `Write a proportionate Delivery Review for the completed job in ${workdir}.
Approved logic: ${frame.logicPath}
Technical brief: ${plan.briefPath}
Ledger: ${plan.ledgerPath}

Run one authoritative final check appropriate to the project. Then prove the result at the right level:
- internal/mechanical work: focused terminal evidence may suffice;
- domain/state logic: exercise concrete scenarios through the real path and report state transitions;
- visible UI or flow: render/run it and produce the smallest useful screenshot, contact sheet, recording,
  or explicit interactive checkpoint. Terminal output alone is not visual proof.

Write ${plan.jobDir}/delivery-review.md. For a small/mechanical change, keep it very short: observable result,
proof, and any caveat. For substantial product work include What now happens (map approved L-rules or named
assumptions), Unchanged, State/flow sketch when useful, Proof/how to experience it, Deviations/follow-ups,
and a short Technical appendix. Do not claim done when required real/visual proof is absent. Return <=180
words plus the review path and artifact paths via the schema.`,
  { phase: 'Review', schema: REVIEW_SCHEMA },
)

if (!review || !review.verified) {
  return {
    status: 'review',
    reason: 'implementation completed but delivery proof is incomplete',
    jobDir: plan.jobDir,
    logicPath: frame.logicPath,
    reviewPath: review && review.reviewPath,
    decisionNeeded: (review && review.verificationGap) || 'Inspect the implementation through the real surface.',
    report: review && review.summary,
  }
}

return {
  status: 'done',
  jobDir: plan.jobDir,
  logicPath: frame.logicPath,
  reviewPath: review.reviewPath,
  proofType: review.proofType,
  proofArtifacts: review.proofArtifacts,
  phasesRun: completed.length,
  completed,
  report: review.summary,
}
