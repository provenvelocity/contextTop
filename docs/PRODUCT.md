# Product specification

## Problem

GitHub Copilot requests can quietly accumulate costly context: files, selections,
terminal output, prior turns, custom instruction and prompt files, tools, tool schemas,
tool results, and retrieval. Developers
cannot see the composition, know which locally visible sources are merely candidates,
or make a targeted reduction before sending a request.

## Product promise

For ambient local state and every detectable Copilot request window, contextTop answers:

1. How much candidate pressure is visible locally right now?
2. When request evidence exists, how much context was associated with that request?
3. Which sources were confirmed, candidate, or unknown?
4. Which measurements were observed, estimated, or unknown, and whether coverage was complete, partial, or unknown?
5. What is the smallest safe action that could reduce the next request?

## Surfaces

### contextTop Fix bottom panel

Contributed to the VS Code panel area alongside Problems, Output, Debug Console, and Terminal.

The panel is **"`top`, but for context"**: a live, always-on dashboard of Copilot
candidate context pressure that refreshes as you work, streaming each observation
instantly rather than waiting on a fixed window.

- **Live streaming chart:** a multi-line time series showing total candidate pressure
  plus one colored line per source kind, updated on every observation. Each source kind
  has a fixed color with a legend (files, selection, terminal, tools/MCP, instructions,
  history, prompt, tool results, retrieval, unknown).
- **Gauges (the `top` header):** current total, session peak, growth rate (tokens/sec),
  and inventory counts — tools/MCP loaded, instruction files, open files, terminals.
- **Source table (the `top` process list):** every candidate source kind sorted by token
  cost, with its share of the total.
- **Request lane:** vertical markers for detected request start, request sent, response
  start, and completion (when request evidence exists).
- **Details on hover:** window time, source breakdown, measurement confidence, inclusion
  status, coverage, and request correlation ID.
- **Fix queue:** ranked safe actions with an estimated savings range, explicit reversal
  behavior, and an execution capability.

The live chart streams instantly; five-second and hourly windows are the persistence and
historical-zoom granularity, not the live refresh cadence.

### Metric catalog

Like `top` reports CPU, memory, load, and a per-process table, contextTop reports:

| `top` concept | contextTop metric | Source now |
| --- | --- | --- |
| Load average | Token growth rate (tokens/sec); requests/min | Ambient stream |
| %CPU per process | Share of candidate total per source kind | Ambient stream |
| Process list | Source table sorted by token cost | Ambient stream |
| Memory used/free | Candidate tokens vs. observed budget headroom | Budget only when observed |
| Task counts | Tools/MCP loaded, instruction files, open files, terminals | Direct VS Code APIs |
| Real-time refresh | Instant per-observation streaming | `event.metrics` push |

Ambient metrics are **candidate** pressure (locally visible, `estimated`) from Direct
VS Code APIs: editor selection, open documents, instruction/prompt/agent files, and
`vscode.lm.tools` (which includes MCP-registered tools). Per-request metrics — confirmed
composition, model budget, and agent tokens used in the last turn — require the
`@contexttop` participant or the opt-in Agent Debug Log; see [`SIGNALS.md`](arch/SIGNALS.md).

### Status bar

Shows compact current pressure with an explicit mode label, for example
`Candidate 18.4k est. · Fix` or `Request 16.9k est.`. A budget percentage is appended
only when `usable_budget_tokens` was **observed** for the selected model
(`Candidate 18.4k est. · 74% · Fix`). Local file sizes and model window guesses are
never shown as a Copilot budget percent. A `Request` total includes quantifiable
confirmed sources only; candidate-only sources remain a separately labeled breakdown
and are never added into that total.

It shifts from neutral to warning only at configured thresholds and opens the bottom panel on activation. The unlabeled string `Context 18.4k` is not a valid status.

### Copilot Chat

contextTop provides `@contexttop /fix` for high-fidelity preflight and streamed guidance on requests routed through the participant. For standard GitHub Copilot conversations, the extension must not claim it can inject arbitrary messages into the built-in Copilot stream; it uses the status bar and bottom panel unless a supported API provides a native in-stream integration.

## contextTop Fix

Fixes are proposed, never silently applied. Every fix has a stable `fixId`, a frozen
pseudonymous target-source scope, evidence, an estimated savings range, reversibility,
and execution capability. Request-scoped fixes also have a `basisRequestId`;
candidate-only recommendations do not and cannot be verified as request savings.

- **Executable:** contextTop can apply it through a supported API and can undo it only
  when the action is also marked reversible and restoration data is available.
- **Guided:** contextTop explains the action, but the user applies it.
- **Unsupported:** contextTop reports the pressure but does not claim it can change the source.

| Trigger | Fix | Scope | Capability |
| --- | --- | --- | --- |
| Large terminal output | Create a redacted focused summary | Current request | Executable for `@contexttop`; guided otherwise |
| Long chat history | Generate a concise handoff and start a clean chat | New chat | Guided |
| Generated files dominate | Propose context exclusion rules | Workspace settings, preview first | Executable with confirmation |
| Irrelevant tools loaded | Identify tools to unselect | Current agent session | Guided unless a supported API permits change |
| Large instruction/prompt-file set | Identify high-cost instruction, prompt, or agent files to trim or scope | Workspace + user config | Guided |
| Large attachment set | Identify detachable files | Current request | Guided |

Fix state is tracked as proposed, accepted, applied, and verified. When comparable
before/after snapshots exist, contextTop reports measured savings alongside the original
estimate; neither acceptance nor application proves that savings occurred.

For a given fix, snapshots are **comparable** only when all of these are true:

- The before-snapshot is the fix's immutable `basisRequestId`; the after-snapshot was
  the **first** request snapshot sent after `fix_applied` in the same `sessionId`. That
  one snapshot is the fix's only verification attempt; later absence cannot revive stale
  removal evidence.
- Both snapshots report the same non-null `model_id`, and
  `unknown_source_count` is unchanged.
- The delta is limited to the fix's frozen `targetSourceKeys`, all of the fix's declared
  `source_kind`; unrelated sources are never included to make a fix appear better.
- Every target is `confirmed` and has an `observed` token measurement with `complete`
  coverage in the before-snapshot. In the after-snapshot it must either remain confirmed
  with the same quality and tokenizer, or be absent **and** named in the
  `removedSourceKeys` outcome from the accepted `fix_applied` transition for a declared
  removal action. If a named key is present in the after-snapshot, its measured value is
  used and stale removal evidence cannot override it. Mere absence is unknown, not zero.
- No target key appears without a validated before measurement. Sources added after the
  fix are outside the frozen scope and do not affect this source-scoped delta.

When those conditions hold, `actualTokensSaved` is the sum of each target's before
tokens minus its after tokens, with an explicitly removed target contributing zero after
tokens. The value is signed: growth is reported as a negative saving. This is a measured
delta for the declared source scope, not proof of total provider-side request savings.
If any condition fails, the fix remains applied but unverified and displays only its
estimated range. Applying the action again creates a new proposal/fix lifecycle rather
than reusing the old removal evidence; it therefore requires a new basis request or a
new candidate-pressure revision and receives a new `fixId`.

V1 execution split: the engine **ranks** recommendations only. The adapter may apply
and undo workspace-setting or UI actions after confirmation. Language-model summarization
is guided, or executable only for requests owned by `@contexttop`. contextTop never
silently mutates Copilot chat state. There is no `applyFix` engine RPC in v1; the
adapter performs the user-visible action and reports the outcome to the engine, which
re-emits `event.fixState` to subscribers.

`reversible` means the user-visible action can be restored without source-data loss; it
does not by itself promise an Undo button. Automated undo is available only for an
executable action when the adapter can retain the required restoration data. Guided
actions explain user or `@contexttop` work, while unsupported actions expose pressure
without pretending contextTop can safely change it.

## Privacy defaults

- Local-only storage.
- Source systems are read-only: contextTop never edits source files, selections,
  terminals, prompts, Copilot logs, or Copilot state while collecting metrics.
- Raw prompts, source text, terminal content, paths, and diagnostic records are transient
  processing input and are never persisted or exported.
- Default `allowTransientContentProcessing` is on: bounded source text may enter the
  local engine process for tokenization and redaction even when capture is metadata-only.
  The settings UI must say this; disabling it never enables persistence.
- Users may disable transient local content processing; contextTop then relies on
  size-based estimates with appropriately lower confidence.
- Metadata-only capture is the default. Optional redacted detail is opt-in, separately
  stored, encrypted locally, and retained for no more than seven days.
- Measurements, request snapshots, and rollups have age limits plus a hard local storage
  cap; no local data class is retained indefinitely.
- Team and Splunk export are opt-in and aggregate-only. Raw and redacted-detail content
  are outside the export boundary even when enterprise policy is enabled.
