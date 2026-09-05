# Architecture specification

## Principle

Rust owns trusted product logic. TypeScript is the thin VS Code adapter and shared UI layer.

```text
VS Code extension (TypeScript) ─┐
                                ├─ local IPC ─> contextTop engine (Rust)
Standalone Tauri app (React/Rust)┘                     │
                                                       ├─ local event store
                                                       ├─ redaction + policy engine
                                                       ├─ tokenizer + metrics aggregator
                                                       └─ optional sync/export adapters
```

## Rust engine responsibilities

- Normalize raw extension signals into privacy-safe context events.
- Tokenize known content, derive five-second buckets, and rank context sources.
- Run redaction before persistence or export.
- Generate deterministic recommendation candidates and expected savings.
- Persist local events and aggregates.
- Serve a versioned local IPC protocol to the VS Code extension and future Tauri app.

## VS Code adapter responsibilities

- Contribute the bottom-panel view, status bar item, commands, and configuration.
- Observe editor, workspace, terminal, tool, and optional diagnostic-log signals permitted by VS Code.
- Render the React panel and communicate with Rust over authenticated local IPC.
- Implement `@contexttop` chat participant requests.

## Signal policy

The engine receives evidence, not claims. Each adapter reports its capability and confidence. Unsupported or opaque Copilot internals are recorded as unknown; they are never fabricated from heuristics.

## Local IPC

- Rust starts per VS Code profile/session and binds to a user-private endpoint.
- The adapter starts it with a random handshake token stored only in VS Code secret storage.
- Protocol: versioned JSON messages over stdio for v1; a local socket may replace it later for a shared Tauri observer.
- No listening network port in v1.

## Team architecture

The optional enterprise service receives redacted aggregate events. It supports tenant isolation, retention controls, SSO/SCIM, policy distribution, and a Splunk HEC exporter. Raw code and prompts are disabled by default.
