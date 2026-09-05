# Implementation plan

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
