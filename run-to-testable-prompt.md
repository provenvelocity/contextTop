# Kickoff prompt — run Phase 1 to a testable app

You are **Claude Haiku** implementing contextTop. Work in **small, tested increments** and
**keep going** through the ordered task list below until the app is **testable end-to-end**
(see "Definition of testable"). The specs are the source of truth and are frozen.

## How to work (read this first — it governs everything)

- Take the **smallest safe step**, then verify, then move to the next step. Never batch
  several increments into one giant edit.
- After **every** file change, run the verify commands (see "Verify after each step").
  If a build or test fails, fix it before doing anything else.
- Prefer **editing existing files** over creating new ones. Do not create markdown docs.
- When you are unsure about a wire shape, a field name, or a rule, **stop and re-read the
  exact spec section** named in the step. Do not guess or invent fields.
- Do **not** refactor or rename the existing engine core APIs (`model.rs`, `protocol.rs`,
  `recommend.rs`, `source_key.rs`, `tokenizer.rs`). Add to them; don't rewrite them.
- Do **not** build on the old prototype UI in `apps/vscode/src/extension.ts`; you will
  **replace** the hard-coded mock as you go.

## The stop rule (important)

- **Do not stop just because an increment finished.** If more work remains in the list and
  you are under ~80% of your token budget, **immediately continue to the next increment.**
- **Only stop when one of these is true:**
  1. The **Definition of testable** is met and verified, **or**
  2. You estimate you have used **~80% of your available token budget**.
- If you stop for the 80% budget, stop at the **next safe point**: make sure
  `cargo test --workspace` and the extension `tsc` compile are **green**, then write an
  **honest checkpoint** in `TASKS.md` (what is Done, what is In Progress, and the exact
  next step) and end. Do **not** stop earlier than 80% while code remains.

## Read first (in this order)

1. `docs/PRODUCT.md` — honesty rules and the user-visible surface (status bar + panel).
2. `docs/IPC.md` — the **normative** wire contract. Especially `request.getTimeline`,
   `request.subscribeMetrics`, `event.metrics`, and `event.streamGap`.
3. `docs/METRICS.md` — the gauge/snapshot model and the view types the panel renders.
4. `docs/SIGNALS.md` — what the editor-selection signal may and may not claim.
5. `docs/ARCHITECTURE.md` — adapter vs. engine responsibilities and the CSP/webview rules.

## What already exists (do not rebuild)

- Rust engine core is built and tested: hello handshake, `ingestObservation`
  (candidate-only, HMAC `sourceKey`, drops raw content), `recordRequestSnapshot`,
  `getRecommendations` (rank-only). 24 lib + 13 engine tests pass.
- The engine binary is `crates/contexttop-core/src/bin/engine.rs` (JSONL over stdin/stdout).
- `apps/vscode/` has `package.json` (contributes panel view, status bar command, config)
  and a **static mock** `src/extension.ts` that you will replace.

## Definition of testable (the finish line)

A developer presses **F5 (Run Extension)**, selects text in an editor, and:

- the **status bar** shows real candidate pressure from the engine, e.g.
  `Candidate 1.2k est. · Fix` (never the forbidden bare string `Context 18.4k`), and
- the **contextTop panel** renders the live candidate breakdown from an engine
  view-model delivered over stdio,

with `cargo test --workspace` green, the extension compiling (`tsc`), and **no raw source
text** crossing `postMessage`. SQLite persistence and redaction are **not** required to be
testable.

## Ordered increments (do them in this order)

### 1. Engine read path (in-memory only — no SQLite yet)
- Implement `request.getTimeline` → one correlated `response.getTimeline` containing the
  current candidate pressure and the per-`source_kind` breakdown from the in-memory gauge,
  exactly per `docs/IPC.md` §`request.getTimeline` and the view types in `docs/METRICS.md`.
- Implement `request.subscribeMetrics` → one correlated `response.subscribeMetrics`, then
  sequenced `event.metrics` pushes as the gauge changes; emit `event.streamGap` on
  backpressure per `docs/IPC.md`. Keep everything in memory.
- Add engine tests for both, following the existing test style in `bin/engine.rs`.

### 2. Extension ↔ engine stdio client
- Spawn and supervise **one** engine child per extension host. In dev, spawn the built
  debug binary at `target/debug/engine` (build it with `cargo build --bin engine`).
- Implement JSONL framing, the nonce **hello** handshake with session binding, `id`
  request/response correlation, and the 1 MiB line bound. Dispose the child on
  `deactivate`. Restart once on unexpected exit, then surface an "engine unavailable" state.
- Smoke-test the handshake.

### 3. Editor-selection collector (adapter side)
- On `window.onDidChangeTextEditorSelection`, compute the selection's bounded size. Respect
  `contextTop.allowTransientContentProcessing`: when **off**, send **size only**; when on,
  you may send bounded text. **ANSI-strip and truncate before IPC.**
- Send `request.ingestObservation` with `sourceIdentity` = `<uri>#selection` and
  `sourceKind` = `"selection"`. **Never hash on the adapter side** — the engine mints the
  `sourceKey`.

### 4. Status bar (replace the mock string)
- Subscribe via `subscribeMetrics`; render `Candidate <n>k est. · Fix` (or
  `Request <n>k est.` when a request snapshot is current). Append a budget `%` **only** when
  `usable_budget_tokens` was observed (it will not be yet, so omit it).
- Go neutral → warning at `contextTop.warningThreshold`. Clicking opens the panel.
- **Delete** the forbidden `$(pulse) Context 18.4k est. · 74% · Fix` mock text.

### 5. Panel webview (replace the mock HTML)
- CSP **on**: no remote content, no inline script without a nonce. `postMessage` carries a
  **metrics-only** view-model — **no raw source text, no absolute paths**.
- Render the candidate breakdown and the five-second buckets from
  `getTimeline`/`subscribeMetrics`. On `event.streamGap`, re-fetch `getTimeline` and resume.

### 6. Wire-up and build
- Confirm `apps/vscode/package.json` contributions still match (panel view, status bar,
  commands, config). Ensure `npm run compile` (or `tsc -p ./`) passes.

### 7. Reach the finish line
- Verify the **Definition of testable** by hand-running the extension, then update `TASKS.md`.

### If budget remains after testable (only then, in this order)
`setConfig` (thresholds) → bounded SQLite persistence + hourly rollups + retention →
redaction module → `@contexttop` participant confirmed snapshots. None of these are
required to declare the app testable.

## Non-negotiable rules (carry these through every step)

1. **Status bar is always labeled**: `Candidate …` or `Request …`, never bare `Context …`.
2. **Candidate pressure is a gauge** — replace-on-update per source; never sum source
   changes or multiple requests into one total.
3. **Three axes stay independent**: measurement (observed/estimated/unknown), inclusion
   (confirmed/candidate/unknown), coverage (complete/partial/unknown). Ambient editor
   selection is `candidate`, never `confirmed`.
4. **Propose, don't apply**: no `applyFix` RPC. The adapter only executes UI/settings
   actions after explicit confirmation.
5. **Engine mints `sourceKey`**: the adapter sends `sourceIdentity` and never hashes.
6. **Webview is untrusted**: CSP on, metrics-only `postMessage`, no raw source, no paths.
7. **Adapter truncates/ANSI-strips before IPC.** The engine never re-strips.
8. **Never log or persist raw content**, prompts, paths, or `transientContent`.
9. **Budget percent only when observed** (`usable_budget_tokens`); otherwise absolute
   tokens with `est.`.

## Verify after each step (all must pass before you continue)

```bash
cargo test --workspace          # engine + core tests green
cargo build --bin engine        # engine binary builds
git --no-pager diff --check     # no whitespace errors
# in apps/vscode:
npm run compile                 # TypeScript compiles (tsc -p ./)
```

## Task tracking (required by `.github/copilot-instructions.md`)

- At the **start** of each increment, add its atomic sub-items to `## In Progress` in
  `TASKS.md` (they are already seeded there — keep them current).
- When an increment is **verified**, move each item to the top of `## Completed`, check it
  `[x]`, and stamp today's date.
- Never bundle several distinct items into one vague line. Never delete history.
