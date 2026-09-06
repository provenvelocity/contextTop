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
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — milestones, proof points, and acceptance criteria.

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
