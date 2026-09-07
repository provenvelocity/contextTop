# Architecture & technical specifications

These documents define contextTop's engine, protocol, data model, and observation
contract. They are the source of truth for how the system behaves; product- and
usage-facing docs live one level up in [`../`](../).

- [ARCHITECTURE.md](ARCHITECTURE.md) — the Rust-first architecture, process model, and
  trust boundaries between the VS Code adapter and the engine.
- [SIGNALS.md](SIGNALS.md) — the signal capability matrix (what is Observed, Estimated, or
  Unknown), the tokenizer strategy, and the opt-in capture tiers.
- [METRICS.md](METRICS.md) — snapshot semantics, the collection pipeline, bounded
  retention, live streaming, and the chart contract.
- [IPC.md](IPC.md) — the versioned local IPC protocol: envelope, requests, responses,
  events, error codes, and privacy invariants.
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — phased milestones, proof points, and
  acceptance criteria.
