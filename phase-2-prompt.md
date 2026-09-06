# Phase 2 prompt — Copilot workflow

Use this as the opening prompt for the Phase 2 implementation session. It assumes the
specs in `docs/*.md` are frozen and that **Phase 1 is complete and merged**. Your job is
to build the Copilot-facing workflow on top of the Phase 1 engine, without weakening any
Phase 1 honesty or data-safety guarantee.

---

You are implementing **Phase 2** of contextTop: the Copilot workflow. The engine, v1 IPC,
storage, editor-selection candidate signal, and `@contexttop` snapshots already exist and
are green. Build on them; do not fork the model or re-litigate frozen decisions.

## Preconditions (must be true before you start)

- Phase 1 exit criteria met: a developer can distinguish candidate pressure from request
  context for selection + participant snapshots, stream and revisit retained metrics
  without unbounded growth, and follow a reversible fix without contextTop storing raw
  source. If any of these is not true, finish Phase 1 first (see `first-prompt.md`).
- Diagnostics remain **off** until the diagnostics validation gate in
  `docs/SIGNALS.md` is fully checked and its results are
  recorded in the `docs/IPC.md` version support matrix.

## Read first (in this order)

1. `docs/PRODUCT.md` — the honesty rules and the user-visible surface.
2. `docs/SIGNALS.md` — the capability matrix, the diagnostic-log opt-in, and the
   diagnostics validation gate that gates it.
3. `docs/METRICS.md` — snapshot model, retention, and confidence labels.
4. `docs/IPC.md` — the v1 wire contract and the Phase 2 `setConfig` additions.
5. `docs/ARCHITECTURE.md` — frozen decisions and module/crate layout.
6. `docs/IMPLEMENTATION_PLAN.md` — Phase 2 scope and exit criteria.

## Phase 2 scope (build this)

- **`@contexttop /fix` participant** for preflight context review: the participant reads
  its own prompt, references, attached tools, and selected model, records a confirmed
  request snapshot, ranks fixes via `getRecommendations`, and streams preflight guidance
  before the user sends to Copilot.
- **Session / handoff summaries**: a guided or `@contexttop`-owned summary that lets the
  user start a clean chat handoff. contextTop never silently rewrites a chat; it proposes.
- **Optional Copilot diagnostics adapter** — gated behind `contextTop.enableDiagnosticLogs`
  (default `false`) **and** a completed diagnostics validation gate. Ships only with a pinned
  filename / extension-id allowlist and pinned VS Code + Copilot version ranges. Advertises
  `diagnostics.copilotTrace` in hello only when a validated parser is present.
- **Tool inventory and tool-result accounting**: `signals.tools` inventory plus
  tool-result token accounting, labeled with the correct measurement/coverage.
- **New settings** `contextTop.modelTokenizerMappings` and `contextTop.redactionRules`,
  plus matching `request.setConfig` fields (these are explicitly Phase 2 in `docs/IPC.md`).

## Out of scope (do not build)

- Desktop / Tauri app, team aggregation service, org policy, Splunk HEC exporter — those
  are Phase 3.
- Executable workspace plugins (no sandbox/approval model exists yet).
- Any `applyFix` / `undoFix` RPC. The engine still only ranks; the adapter executes after
  confirmation and reports the outcome via `request.reportLifecycle`.

## Non-negotiable rules (Phase 1 guarantees carry forward)

1. All Phase 1 rules still hold: labeled status bar, gauge model (never summed), the three
   independent axes (measurement / inclusion / coverage), propose-don't-apply, engine-side
   `sourceKey` minting, CSP webview, adapter-side truncation, host clocks, no payload
   logging.
2. **Diagnostic parsing is deny-by-default.** A missing or unvalidated parser is `unknown`,
   never a best-effort scrape. Each parser uses a strict field allowlist that extracts only
   approved timestamps, identifiers, counts, sizes, model IDs, and explicit inclusion
   metadata, then immediately discards the source line. Raw prompts, responses, request
   bodies, tool inputs/results, headers, auth data, and provider payloads are denied even
   if a future log version exposes them. Workspace trust is required before any
   log-directory access.
3. **The provider budget percent** may come from a diagnostic field only when the budget is
   explicitly reported and validated — it is the only source for a UI budget percent, and
   it is still `observed`-only. No observed budget → absolute tokens with `est.`
4. **Participant snapshots stay confirmed-only for what the participant actually sees.**
   Ambient tool/terminal inventory is candidate inclusion, never promoted to confirmed by
   the participant path.
5. **Tokenizer mappings and redaction rules are declarative data, not executable plugins.**
   Validate and bound them; a user rule can never widen what leaves the machine or disable
   the built-in secret/path redaction.
6. Diagnostic parsing obeys the same data lifecycle and retention as every other signal;
   unknown fields and unmatched records are ignored, never persisted or exported.

## Working agreement

- Track work in the root `TASKS.md`: decompose each sub-requirement (participant, handoff
  summary, diagnostics adapter, tool accounting, each new setting) into its own line under
  **In Progress**, then move to **Completed** with a date when verified.
- Specs are the source of truth. If code and a spec disagree, fix the code. If two specs
  disagree, stop and raise it.
- Do not ship the diagnostics adapter until the diagnostics validation gate boxes are actually
  checked with recorded probe results on macOS, Windows, and Linux.
- Verify before finishing: `cargo test --workspace`, `cargo build --workspace` clean, the
  extension compiles (`tsc`), and tests prove raw prompts, responses, paths, terminal text,
  and unknown diagnostic fields never reach persistence, logs, or export.

## Exit criteria

Preflight guidance streams in the `@contexttop` participant and the bottom panel tracks the
request lifecycle with confidence labels. Diagnostics are available only when validated and
explicitly enabled, and remain `unknown` otherwise.

## First task

Build the `@contexttop /fix` participant end-to-end against the existing engine: on
invocation, record a confirmed `recordRequestSnapshot` for the participant's own request,
call `getRecommendations`, and stream ranked preflight guidance — with no diagnostics and
no new settings yet. Land it with tests before adding the diagnostics adapter or the
Phase 2 config fields.
