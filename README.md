# contextTop

contextTop is a local-first, Rust-powered context observability product for GitHub Copilot in VS Code. It explains what is entering a request's context, estimates token pressure in real time, and offers reversible fixes before context becomes expensive or ineffective.

The first surface is a VS Code bottom-panel view, beside Terminal. The durable product core is Rust so the same engine can later power a standalone macOS, Windows, and Linux application.

## Repository map

- [`docs/PRODUCT.md`](docs/PRODUCT.md) — user experience and product boundaries.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Rust-first architecture and trust model.
- [`docs/METRICS.md`](docs/METRICS.md) — five-second time-series contract and chart behavior.
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — milestones, proof points, and acceptance criteria.

## Product rule

Every metric is marked **Observed**, **Estimated**, or **Unknown**. contextTop must not represent inferred Copilot context as provider-reported fact.
