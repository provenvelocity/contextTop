# Implementation plan

## Observation contract (established)

**Goal:** an honest observation contract underpins every product claim. It is settled and
captured in [`SIGNALS.md`](SIGNALS.md); there is no separate prototyping phase, and the
throwaway prototype has been replaced by the tested Rust core. Key decisions:

- Direct VS Code APIs observe ambient editor/tool state and shell-integrated terminal
  executions, but ambient visibility is only candidate inclusion. `@contexttop` exposes
  its own prompt, references, attached tools, and selected model. Standard Copilot Chat
  request bodies are not exposed to extensions.
- Copilot diagnostic logs are an **experimental opt-in** source with two candidates: the
  structured VS Code Agent Debug Log (OTLP export, preferred) and raw trace logs. Nothing
  ships until the diagnostics validation gate in [`SIGNALS.md`](SIGNALS.md#diagnostics-validation-gate)
  is complete.
- The tokenizer is **model-agnostic**: it targets whatever model the user's session reports and falls back to a conservative estimate for unknown models.
- V1 uses built-in tokenizers and built-in redaction rules. User tokenizer mappings
  and custom redaction rules are Phase 2. Executable workspace plugins are deferred
  until a sandbox and approval model exist.
- Context pressure is a gauge and request source composition is immutable; lifecycle
  timestamps live in a separate projection. Source-change events and multiple requests
  are never summed into a misleading total.
- Raw source data is transient and read-only. Durable local storage is limited to
  measurements, snapshots, short-lived optional redacted detail, and aggregate rollups,
  all bounded by age and size.

## Phase 1 — local engine and panel

- Grow `contexttop-core` from a library into an engine: add `protocol`, `tokenizer`, `redaction`, and `storage` modules plus a `src/bin/engine.rs` stdio host. Start as one crate with modules; split into sibling crates only once interfaces stabilize (see [`ARCHITECTURE.md`](ARCHITECTURE.md#crate-and-module-layout)). Replace the prototype additive `u32` event model; do not implement around `bucket_events`.
- Implement the v1 IPC contract in [`IPC.md`](IPC.md): nonce hello with capability
  intersection, `sourceIdentity` ingest, HMAC `sourceKey` responses,
  `recordRequestSnapshot`, timeline queries, metric subscription, rank-only
  recommendations, configuration, and stream-gap recovery. No `applyFix` RPC.
- Package and spawn a host-arch engine binary (explicit Phase 1 work item). One process
  per extension host.
- TypeScript extension with `contextTop Fix` panel, status bar, configuration, and Rust
  stdio bridge. Phase 1 UI is a webview over a frozen JSON view-model (CSP, no raw
  source in `postMessage`). Shared React is not required.
- One observed candidate signal end-to-end: editor selection. Status bar uses
  `Candidate … est.` / `Request … est.`; budget percent only when observed.
- `@contexttop` participant may record confirmed snapshots for its own requests.
- Candidate-pressure and request-context timelines with five-second projections, exact
  request markers, and inclusion/confidence/coverage details.
- Bounded SQLite storage with persist sampling (≤1 candidate row per source per 5s),
  migrations, age/size cleanup, short-lived optional detail, hourly rollups,
  `key_id`-tagged detail encryption, and tests proving raw source content, paths, and
  `transientContent` cannot reach persistence, logs, or export.
- Ranked fixes classified as executable, guided, or unsupported. Adapter executes only
  workspace-setting / UI actions after confirmation; LM summarization is guided or
  `@contexttop`-owned.

**Exit criteria:** a developer can distinguish candidate pressure from request context
for selection + participant snapshots, stream and revisit retained metrics without
unbounded local growth, and follow a reversible fix without contextTop storing raw
source data. Diagnostic logs are still off.

## Phase 2 — Copilot workflow

- `@contexttop /fix` participant for preflight context review.
- Session/handoff summaries.
- Optional Copilot diagnostics adapter, gated behind explicit configuration **and**
  the completed diagnostics validation gate (filename allowlist, pinned Copilot versions).
- Tool inventory and tool-result accounting.
- `contextTop.modelTokenizerMappings` and `contextTop.redactionRules` settings, plus
  matching `setConfig` fields.

**Exit criteria:** preflight guidance streams in the contextTop participant and the bottom panel tracks the request lifecycle with confidence labels.

## Phase 3 — desktop and enterprise

- Tauri desktop companion reusing the Rust engine and React UI.
- Optional team aggregation service, organization policy, and Splunk HEC exporter.
- Signed releases, update mechanism, telemetry opt-in, and enterprise deployment documentation.

**Exit criteria:** local-first workflow works independently of VS Code; organizations can
elect to export aggregate-only metrics through a bounded delivery spool.

## Initial repository structure

Present today (single-crate start):

```text
apps/vscode/                     thin TypeScript extension
crates/contexttop-core/          domain model, recommendations
docs/                            product and technical specifications
```

Target once module interfaces stabilize:

```text
apps/vscode/                     thin TypeScript extension
apps/desktop/                    Tauri desktop companion
crates/contexttop-core/          event and recommendation domain logic
crates/contexttop-protocol/      IPC contracts (see IPC.md)
crates/contexttop-redaction/     secret/path/content redaction
crates/contexttop-tokenizer/     model-aware token estimation
crates/contexttop-storage/       local event and aggregate store
packages/ui/                     shared React chart and panel components
docs/                            product and technical specifications
```
