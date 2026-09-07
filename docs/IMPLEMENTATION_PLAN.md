# Implementation plan

## Execution status

Phase 0 is implemented as an initial capability contract and probe slice. The
written matrix is in `docs/CAPABILITY_MATRIX.md`, with a redacted event fixture
in `docs/fixtures/sample-events.jsonl`. The first Phase 1 Rust contracts are
also executable: protocol types, five-second aggregation, redaction, token
estimation, and JSONL event storage live under `crates/`.

The authenticated stdio bridge is implemented in the Rust engine binary and
the VS Code adapter. It performs a version check and secret-storage-backed
handshake token exchange, emits recomputed buckets, and reports protocol
errors. The adapter compiles with the nvm-managed Node/npm installation.

The fixture-driven VS Code panel, status bar, and local event capture wiring
are now implemented. The panel renders the latest five-second buckets as a
source-stacked timeline, while the adapter reports estimated editor and
selection counts without sending raw content. Deterministic fix
recommendations are ranked in Rust and displayed with evidence, savings, scope,
and reversibility. Preview/apply controls now use the versioned IPC protocol;
preview is acknowledged and apply reports advisory-only behavior when no
supported mutation API exists. Recommendations do not silently modify
workspaces or Copilot sessions.

The first Phase 2 workflow slice is implemented: `@contexttop /fix` now
streams a preflight summary from the latest observed bucket and recommendations,
including source totals, confidence, expected savings, and the unknown
provider-side boundary. Non-`/fix` participant requests remain observational.
The remaining Phase 2 work is handoff-summary generation, optional diagnostics
gating, and tool inventory/result accounting.

## Phase 0 — capability spike

**Goal:** establish the honest observation contract before building product claims.

- Create a small VS Code extension probe for editor, terminal, tools, and Chat Participant signals.
- Enable GitHub Copilot Trace diagnostics in controlled test profiles and document detectable request lifecycle evidence across VS Code/Copilot versions.
- Define the version support matrix and the exact observed/estimated/unknown labels.

**Exit criteria:** a written capability matrix and sample redacted events from macOS, Windows, and Linux.

## Phase 1 — local engine and panel

- Rust workspace with `core`, `protocol`, `storage`, `redaction`, and `tokenizer` crates.
- TypeScript extension with `contextTop Fix` panel, status bar, configuration, and Rust stdio bridge.
- Five-second timeline with source stacks, request markers, and details.
- Local-only event storage and the first five deterministic fixes.

**Exit criteria:** a developer can see their current estimated context composition and apply a reversible fix without leaving VS Code.

## Phase 2 — Copilot workflow

- `@contexttop /fix` participant for preflight context review.
- Session/handoff summaries.
- Optional Copilot diagnostics adapter, gated behind explicit configuration.
- Tool inventory and tool-result accounting.

**Exit criteria:** preflight guidance streams in the contextTop participant and the bottom panel tracks the request lifecycle with confidence labels.

## Phase 3 — desktop and enterprise

- Tauri desktop companion reusing the Rust engine and React UI.
- Optional team aggregation service, organization policy, and Splunk HEC exporter.
- Signed releases, update mechanism, telemetry opt-in, and enterprise deployment documentation.

**Exit criteria:** local-first workflow works independently of VS Code; organizations can elect to export redacted aggregates.

## Initial repository structure

```text
apps/vscode/              thin TypeScript extension
apps/desktop/             Tauri desktop companion
crates/core/              event and recommendation domain logic
crates/protocol/          IPC contracts
crates/redaction/         secret/path/content redaction
crates/tokenizer/         model-aware token estimation
crates/storage/           local event and aggregate store
packages/ui/              shared React chart and panel components
docs/                     product and technical specifications
```
