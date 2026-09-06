# contextTop

contextTop is an early-stage, local-first context observability project for GitHub
Copilot in VS Code. It distinguishes locally visible candidate pressure from confirmed
request context, estimates token pressure in real time, and proposes reversible fixes
before context becomes expensive or ineffective.

The first surface is a VS Code bottom-panel view, beside Terminal. The durable product core is Rust so the same engine can later power a standalone macOS, Windows, and Linux application.

## Repository map

- [`docs/PRODUCT.md`](docs/PRODUCT.md) — user experience and product boundaries.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Rust-first architecture and trust model.
- [`docs/SIGNALS.md`](docs/SIGNALS.md) — signal capability matrix, tokenizer strategy, and opt-in tiers.
- [`docs/IPC.md`](docs/IPC.md) — versioned local IPC protocol between the VS Code adapter and the Rust engine.
- [`docs/METRICS.md`](docs/METRICS.md) — snapshot semantics, collection pipeline, bounded retention, streaming, and chart behavior.
- [`docs/DASHBOARD.md`](docs/DASHBOARD.md) — dashboard metrics, sidecar decomposition, and the extensible card model.
- [`docs/TOOL_STORY.md`](docs/TOOL_STORY.md) — the tool-efficiency story and per-call tool-toggling feasibility.
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — milestones, proof points, and acceptance criteria.
- [`docs/TESTING.md`](docs/TESTING.md) — build, run (F5), and try contextTop end to end.

## Build, run, and test

Prerequisites: Rust stable (1.85+, edition 2024), Node.js 20+, VS Code 1.96+, and GitHub
Copilot Chat signed in. Full instructions are in [`docs/TESTING.md`](docs/TESTING.md).

```bash
cargo build --bin engine                 # build the engine the extension spawns
cd apps/vscode && npm ci && npm run compile   # build the extension
```

Then open the repo in VS Code and press **F5** to launch the Extension Development Host,
and open the **contextTop** panel.

Continuous integration ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the
same checks on every push and pull request:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd apps/vscode && npm ci && npm run compile
python scripts/check-docs.py
```


## Product rule

Every metric reports three orthogonal labels:

- **Measurement:** Observed, Estimated, or Unknown — how the size/token value was obtained.
- **Inclusion:** Confirmed, Candidate, or Unknown — whether the source entered a request.
- **Coverage:** Complete, Partial, or Unknown — whether evidence covers the whole source.

`Partial` is coverage only, never a measurement. contextTop must not represent locally
visible or inferred material as provider-reported request context. A budget percentage
is shown only when a usable token budget was observed; otherwise the UI shows absolute
candidate or request tokens. Raw source content is never persisted or exported; retained
metrics and rollups are bounded by age and storage size.
