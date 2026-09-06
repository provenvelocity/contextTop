# First prompt — start Phase 1 coding

Use this as the opening prompt for the implementation session. It assumes the specs in
`docs/*.md` are frozen and correct; your job is to make code match them.

---

You are implementing **Phase 1** of contextTop. The specifications are complete and
frozen. The current `crates/contexttop-core/src/lib.rs`, `apps/vscode/src/extension.ts`,
and `outputs/contextTop/` are throwaway prototypes — **do not build on them or
copy their behavior**. Read the specs, then implement against them.

## Read first (in this order)

1. `docs/PRODUCT.md` — the honesty rules and the user-visible surface.
2. `docs/ARCHITECTURE.md` — frozen v1 decisions, crate/module layout, "Current status".
3. `docs/METRICS.md` — the snapshot model, retention, and snapshot assembly.
4. `docs/IPC.md` — the normative v1 wire contract (source of truth).
5. `docs/SIGNALS.md` — capability matrix; note the unchecked diagnostics validation gate.
6. `docs/IMPLEMENTATION_PLAN.md` — Phase 1 scope and exit criteria.

## Phase 1 scope (build this)

- Grow `contexttop-core` from a library into an engine: add `protocol`, `tokenizer`,
  `redaction`, and `storage` modules plus a `src/bin/engine.rs` stdio host. One crate
  with modules; split into sibling crates only once interfaces stabilize.
- Implement the v1 IPC contract from `docs/IPC.md`: nonce hello with capability
  intersection, `sourceIdentity` ingest, HMAC `sourceKey` responses,
  `recordRequestSnapshot`, timeline queries, metric subscription, rank-only
  recommendations, configuration, and stream-gap recovery.
- Package and spawn a host-arch engine binary; one process per extension host.
- TypeScript extension: `contextTop Fix` panel, status bar, configuration, and the Rust
  stdio bridge. UI is a webview over a frozen JSON view-model.
- One observed candidate signal end-to-end: **editor selection**.
- `@contexttop` participant records confirmed snapshots for its own requests.
- Bounded SQLite storage with persist sampling, migrations, age/size cleanup, and tests
  proving raw source content, paths, and `transientContent` cannot reach persistence,
  logs, or export.
- Ranked fixes classified executable / guided / unsupported. No `applyFix` RPC.

## Out of scope (do not build)

- Copilot diagnostic-log ingestion — blocked until the `SIGNALS.md` diagnostics
  validation gate is proven. Do not advertise `diagnostics.copilotTrace`.
- Terminal and tool collectors are not required to ship Phase 1.
- User tokenizer mappings, custom redaction rules, desktop app, team aggregation.

## Non-negotiable rules (the specs forbid these — the prototype broke them)

1. Status bar is `Candidate … est.` or `Request … est.` Never the unlabeled
   `Context 18.4k`. Show a budget percent **only** when `usable_budget_tokens` was
   observed; otherwise absolute tokens with `est.`
2. Pressure is a **gauge**: repeated observations replace, they are never summed. Do not
   port the additive `bucket_events` model.
3. Three independent axes: **measurement** (`observed | estimated | unknown`),
   **inclusion** (`confirmed | candidate | unknown`), **coverage**
   (`complete | partial | unknown`). `partial` is coverage only, never a measurement.
   Do not merge them into one `Confidence` enum.
4. Fixes are **proposed**, never silently applied. The engine ranks; the adapter executes
   only after user confirmation, then reports the outcome via `request.reportLifecycle`.
5. Mint `sourceKey` (HMAC-SHA-256) **in the engine**, never in TypeScript. Ambient
   editor/terminal/tool inventory is candidate inclusion — never confirmed on ingest.
6. Webview is untrusted: CSP on, nonce required, `acquireVsCodeApi()` required, and only
   metrics-only payloads in `postMessage`. Never put raw source or paths in the view. UI
   labels come from the engine view-model (kind + HMAC `sourceKey`), never raw paths.
7. Truncate / ANSI-strip / coalesce transient content **in the adapter before IPC**
   (64 KiB decoded, UTF-8 boundary, `coverage: partial`). Never retry with raw content
   after a drop.
8. Clocks are extension-host / engine-host unix ms (`ts`, `observedAtMs`, `sentAtMs`,
   `tsExactMs`). The webview never supplies a clock (matters for SSH/WSL/containers).
9. Never log `transientContent` or `sourceIdentity`. Add a tracing filter and a panic
   hook that stringify errors without payload fields; avoid `dbg!` / `{:?}` on payloads.

## Working agreement

- Track work in the root `TASKS.md` (required by repo instructions): add the task under
  **In Progress**, then move it to **Completed** with a date when done.
- The specs are the source of truth. If code and a spec disagree, fix the code. If two
  specs disagree, stop and raise it — do not guess.
- Verify before finishing: `cargo check --workspace`, `cargo test`, `git diff --check`,
  and the extension compiles (`tsc`).

## First task

Start with the engine skeleton and IPC handshake: a `src/bin/engine.rs` stdio host that
performs the nonce hello with capability intersection from `docs/IPC.md`, backed by the
`protocol` module types. Land it with tests before adding collectors or storage.
