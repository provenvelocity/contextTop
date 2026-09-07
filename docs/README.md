# contextTop documentation

New here? Start with the [project README](../README.md) for install and a quick start.

## Using contextTop

- [PRODUCT.md](PRODUCT.md) — the product experience, what it observes, and where it draws
  the line between visible material and confirmed request context.
- [DASHBOARD.md](DASHBOARD.md) — every metric, the sidecar breakdown, the chart modes, and
  the extensible card model.
- [TOOL_STORY.md](TOOL_STORY.md) — the tool-efficiency story (which tools cost you and go
  unused) and the honest limits of per-call tool toggling.
- [TESTING.md](TESTING.md) — build, run via F5, install a packaged build, and cut a release.

## Architecture & technical specs

Deep specifications live in [`arch/`](arch/):

- [arch/ARCHITECTURE.md](arch/ARCHITECTURE.md) — Rust-first architecture and trust model.
- [arch/SIGNALS.md](arch/SIGNALS.md) — the signal capability matrix, tokenizer strategy, and opt-in tiers.
- [arch/METRICS.md](arch/METRICS.md) — snapshot semantics, collection pipeline, retention, streaming, and the chart contract.
- [arch/IPC.md](arch/IPC.md) — the versioned engine↔adapter protocol.
- [arch/IMPLEMENTATION_PLAN.md](arch/IMPLEMENTATION_PLAN.md) — milestones, proof points, and acceptance criteria.
