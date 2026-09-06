# Testing contextTop

How to build, run, and try contextTop end to end. contextTop is two parts: a **Rust
engine** (the trusted core) and a **VS Code extension** (the adapter + dashboard) that
spawns the engine over stdio.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Rust | stable, **1.85+** | Workspace uses edition 2024. `rustup update stable`. |
| Node.js | **20+** | For the VS Code extension build. |
| VS Code | **1.96+** | Extension host target. |
| GitHub Copilot Chat | installed & signed in | Source of the diagnostic logs the dashboard reads. |
| Python | 3.x | Only for the docs check. |

## 1. Build

```bash
# From the repo root — build the engine binary the extension will spawn.
cargo build --bin engine

# Build the VS Code extension.
cd apps/vscode
npm ci        # or: npm install
npm run compile
```

The extension spawns `target/debug/engine` relative to the repo, so `cargo build` must
run before launching.

## 2. Run (F5)

1. Open the **repository root** in VS Code.
2. Press **F5** (the "Extension" launch config). This compiles the extension and opens a
   second window — the **Extension Development Host**.
3. In that window, open the **contextTop** panel: `View → Open View…` → search
   "ContextTop Fix", or open the bottom Panel area (beside Terminal) and pick the
   contextTop container.

Diagnostics are **auto-enabled** in the F5 dev host, so the dashboard reads GitHub
Copilot's local debug logs immediately. Outside the dev host, enable them with the
in-panel **Enable diagnostic logs** button or the `contextTop.enableDiagnosticLogs`
setting.

## 3. Generate data

The rich views come from real Copilot activity. In the **dev host** window:

- Send a few **Copilot Chat** requests (any prompt).
- Run agent tasks that call tools, so tool usage is recorded.

Each request appears in the dashboard within ~1 second.

## 4. What to try

- **Chart mode toggle** (`Candidate` vs `Request`). It auto-switches to **Request** on the
  first observed request.
- **Metric selector** (Request mode) — defaults to **All metrics** (every per-request
  metric overlaid, each normalized to its own max). Try `Budget %`, `Cache hit %`,
  `TTFT`, `Context growth`, etc.
- **Request breakdown** — the stacked system-prompt / tools / prompt / other split of the
  opaque `inputTokens`, with a budget line.
- **Story card** — "N tools loaded · Xk tokens", the biggest **unused** tools, and the
  engine-ranked `unselect_tools` recommendation with an estimated savings range. The
  **Manage tools…** button opens VS Code's tool configuration. See
  [`TOOL_STORY.md`](TOOL_STORY.md).
- **Analytics cards** — per-turn, discovery (agents/skills/instructions/hooks loaded),
  latency, cache, correlations.
- **Extensible layout** — reorder or hide cards with the `contextTop.dashboardLayout`
  setting; changes apply live.

## 5. Run the checks (what CI runs)

```bash
# Rust: format, lint, test, build.
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Extension: type-check / compile.
cd apps/vscode && npm ci && npm run compile

# Docs: broken local links + trailing whitespace.
python scripts/check-docs.py
```

These are the same steps enforced by [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Troubleshooting

- **Nothing in the dashboard.** Confirm Copilot Chat is signed in and you've sent a
  request in the **dev host** window. Check the **contextTop Engine** and **contextTop
  Diagnostics** output channels (`View → Output`).
- **Engine errors.** Engine failures are logged to the **contextTop Engine** output
  channel rather than crashing the host. Re-run `cargo build --bin engine` if the binary
  is stale.
- **"There is no data provider registered".** The webview view requires the packaged
  build; re-run `npm run compile` and reload the dev host.

## Privacy while testing

Raw prompts, source text, paths, and terminal content are **never persisted**. The
adapter sends bounded, ANSI-stripped buffers only when local content processing is
enabled; the engine tokenizes then drops them. See
[`SIGNALS.md`](SIGNALS.md#opt-in-capture-levels) and
[`METRICS.md`](METRICS.md#storage-and-retention).
