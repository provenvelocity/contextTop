# Architecture specification

## Current status

The trusted Rust core is built: the child-stdio engine, versioned IPC + hello handshake,
HMAC `sourceKey` minting, the candidate-pressure gauge, immutable request snapshots, a
fallback tokenizer, and rank-only recommendations all exist and are tested.

The VS Code adapter is partly built: the stdio `EngineClient` (JSONL framing, hello
handshake, session-id-bound requests, multi-handler event dispatch, single restart), the
status bar, ambient collectors (debounced selection, open files, instruction/prompt
files, and `vscode.lm.tools` — which includes MCP-registered tools), and the **live
streaming dashboard** — a CSP-nonce webview that renders a multi-line time series
(total + per-source), gauges (peak, rate, tools/MCP, instruction files, open files,
terminals), and a `top`-style source table. The engine pushes an `event.metrics` after
each `ingestObservation`, so the dashboard streams instantly.

Not yet implemented: bounded SQLite storage and rollups, the redaction module, the
sequenced/replayable metric stream with `event.streamGap` recovery, `setConfig`,
diagnostic-log ingestion, the `@contexttop` participant confirmed-snapshot path, and
engine packaging/signing.

The product framing is **"`top`, but for context"**: a live, always-on view of Copilot
candidate context pressure, broken down by source, refreshing as you work.

## Principle

Rust owns trusted product logic. TypeScript is the thin VS Code adapter. Phase 1 ships
a webview that consumes a frozen JSON view-model from the engine. A shared React UI
package is a later split, not a Phase 1 engine dependency.

```text
VS Code extension host (TypeScript)
  ├─ read-only signal collectors
  ├─ panel/status/chat adapters
  └─ child stdio IPC
          │
          ▼
contextTop engine (Rust, one per extension host)
  ├─ bounded ingress + normalization
  ├─ tokenizer + redaction + policy
  ├─ candidate state + request snapshots
  ├─ bounded SQLite metrics store + rollups
  ├─ sequenced live metric stream
  └─ optional aggregate-only export sinks

Future Tauri app ── local transport ──> same Rust engine modules
```

## Rust engine responsibilities

- Normalize raw extension signals into privacy-safe context events.
- Maintain ambient candidate state, immutable per-request source-composition snapshots,
  and separate lifecycle projections over append-only events.
- Tokenize transient content, derive five-second/hourly rollups, and rank context sources.
- Drop raw buffers after processing; persist only allowed measurements and optional
  redacted detail.
- Generate deterministic recommendation candidates and expected savings.
- Enforce age and size retention limits on local metrics, detail, and export spools.
- Serve a versioned local IPC protocol to the VS Code extension and future Tauri app.

## VS Code adapter responsibilities

- Contribute the bottom-panel view, status bar item, commands, and configuration.
- Read editor, workspace, terminal shell-execution, tool, and optional diagnostic-log
  signals permitted by VS Code without mutating their source.
- Truncate, ANSI-strip, and coalesce noisy candidate updates **before** content crosses
  IPC. Mint no source keys; send a `sourceIdentity` string for the engine to HMAC.
- Render the panel from engine view-models over versioned child-process IPC. The webview
  is untrusted: CSP on, no raw source in `postMessage`, metrics-only payloads.
- Implement `@contexttop` chat participant requests.
- Package and spawn the signed, host-arch engine binary; supervise one process per
  extension host. Packaging is a Phase 1 work item, not an implied existing artifact.

## Signal policy

The engine receives evidence, not claims. Each adapter reports provenance, measurement
confidence, coverage, and request-inclusion evidence. Unsupported or opaque Copilot
internals are recorded as unknown; they are never fabricated from heuristics.

Local visibility does not imply request inclusion. Active files, selections, terminal
executions, and available tools are candidate context until a participant or validated
diagnostic signal confirms that a request included them. The metric model and aggregation
rules are defined in [`METRICS.md`](METRICS.md).

The full per-signal detection tiers, confidence mapping, and opt-in gates are defined in [`SIGNALS.md`](SIGNALS.md). In summary:

- **Direct VS Code APIs** observe local state and `@contexttop` requests; most ambient
  state has candidate, not confirmed, inclusion.
- **Experimental diagnostic-log signals** are opt-in, version-gated, strictly allowlisted,
  and disabled unless their schema has been validated for the installed Copilot version.
- **Local estimates** (token counts, unopened file sizes) are labeled `estimated`.
- **Copilot internals** (standard-chat request body, provider retrieval, server-side pressure) are `unknown` and never inferred.

## Tokenizer and redaction extensibility

The tokenizer and redaction engines are model-agnostic. V1 ships a built-in tokenizer
registry and conservative fallback. User tokenizer mappings and custom redaction rules
are Phase 2. Arbitrary workspace-provided executable tokenizer plugins are deferred
until sandboxing, approval, resource limits, and integrity checking are designed.
Declarative redaction rules, when added, use the bounded Rust regex engine with pattern
limits and a match timeout, and are validated before activation. See
[`SIGNALS.md`](SIGNALS.md#extensibility).

## Data ownership and lifecycle

contextTop observes source data but does not own or modify it. Files, selections,
terminal streams, prompts, diagnostic logs, and Copilot state remain under their original
owner. When transient local processing is allowed, the minimum required content may cross
child stdio and exist briefly in engine memory for tokenization and redaction. This is
independent from persistence level: metadata mode may process content but stores only
metrics. Users can disable transient content processing and receive coarser size-based
estimates. Raw content is never persisted, logged, included in crash reports, or exported.

The durable store contains source measurements, request snapshots, lifecycle markers,
fix outcomes, and derived rollups. Source identities are session-scoped pseudonyms.
Optional redacted detail is stored separately with a much shorter retention period.
Age-based retention and a hard storage cap ensure local data cannot grow indefinitely;
see [`METRICS.md`](METRICS.md#storage-and-retention).

## Metrics flow

Collectors send bounded observations to the engine. The engine coalesces noisy candidate
updates, creates immutable source-composition snapshots for detected requests, updates
separate lifecycle projections, stores permitted metrics, and pushes updates to
subscribers.

The **live dashboard streams instantly**: the engine emits an `event.metrics` after each
`ingestObservation`, carrying the current candidate total, peak, and per-source
breakdown. The adapter plots each event as a point in a rolling in-memory series — no
fixed refresh window. Five-second buckets are a **persistence and historical-zoom**
projection of gauge state and request snapshots (never sums of source-change events),
not the cadence of the live chart. Clients recover stream gaps by fetching a fresh
timeline snapshot and resuming from its cursor.

## Local IPC

- The adapter starts one Rust child process per VS Code extension host/window.
- V1 uses the child's private stdin/stdout pipes; no listening network port exists.
- A nonce-echo hello binds protocol startup to the spawned child but is not presented as
  a security boundary against other processes running as the same OS user.
- In remote SSH, WSL, and dev-container workspaces, the engine runs with the extension
  host where source APIs and extension storage live. SQLite and the credential service
  are on that remote side; the UI is a projection. VS Code Web is unsupported in v1.
- Five-second buckets use the **engine clock**, not the laptop clock, in remote sessions.
- `stderr` is captured in a dedicated contextTop output channel and must never contain
  raw source content. Panic and tracing pipelines are subject to the same rule.

The complete v1 message envelope, request/response/event types, error codes, versioning rules, and privacy invariants are specified in [`IPC.md`](IPC.md).

## Storage boundary

SQLite is local to the extension host and is the authoritative durable metric store.
The UI is a disposable projection and holds no independent history. Storage is segmented
into metadata metrics, short-lived optional redacted detail, aggregate rollups, and a
bounded aggregate-only export spool. All segments have explicit age and size limits.

Optional redacted detail is encrypted at the application layer with an authenticated
encryption key held by the platform credential service. This key is distinct from the
ephemeral source-identity HMAC key. Each ciphertext blob stores a `key_id`; one version
is active for writes and older versions remain available only while unexpired detail
references them. Rotation occurs on an explicit credential reset or cryptographic
migration, not on every engine restart. Key material is never stored beside the
database. If a secure credential service is unavailable or locked, detail persistence
is disabled rather than downgraded to plaintext; metadata metrics continue to work. If
a referenced key is lost, matching blobs are deleted, not left as unreadable residue.
Remote SSH/WSL hosts use that host's credential service; if none exists, detail stays
off.

## Identity and sessions

- One engine, and one `sessionId`, per VS Code extension host/window. Multi-root
  workspaces share that session.
- The adapter allocates `sessionId` (ULID) at host activation and `requestId` (ULID) when
  it detects a request boundary. The engine never invents request IDs.
- The adapter sends `sourceIdentity` (URI, terminal id, tool id, or other stable-within-
  session handle). The engine HMAC-SHA-256s it with an in-memory random session key and
  persists only the digest as `source_key`. Absolute paths never appear in SQLite, logs,
  or export. `sourceIdentity` is transient identity, not durable telemetry. The keyed
  digest provides session-scoped pseudonymity and prevents offline path recovery with a
  precomputed dictionary if only the database is exposed; it is not protection from a
  process able to read engine memory.
- Engine crash or restart rotates the HMAC key and starts a **new** session. Persisted
  measurements remain under the old `sessionId` for history views; live candidate state
  is not reconstructed from disk under the old keys. The live in-memory session can
  survive disk eviction of old rows; it does not survive process death.

Optional enterprise export begins after local aggregation. Raw source content and
redacted detail are outside the exporter trust boundary and cannot be selected for
export. Failures never create an unbounded local queue.

## Crate and module layout

The engine begins as a **single crate**, `contexttop-core`, with internal modules rather than many small crates. This keeps refactoring cheap while the boundaries are still being proven. Modules split into their own crates only once their interfaces stabilize.

```text
crates/contexttop-core/
  src/lib.rs        domain model, candidate gauges, snapshots, recommendations
  src/protocol.rs   IPC envelope and message (de)serialization  — see IPC.md
  src/tokenizer.rs  TokenizerProvider trait + registry + fallback
  src/redaction.rs  RedactionRule trait + built-in secret/path rules
  src/storage.rs    local event and aggregate persistence
  src/bin/engine.rs stdio host: handshake, dispatch, event stream
```

Target split once stable (tracked in the plan): `protocol`, `tokenizer`, `redaction`, and `storage` become sibling crates under `crates/`, with `core` depending on them. The public message contract in [`IPC.md`](IPC.md) does not change when this split happens.

## Team architecture

The optional enterprise service receives aggregate metric buckets only. It supports
tenant isolation, retention controls, SSO/SCIM, policy distribution, and a Splunk HEC
exporter. Raw code, prompts, terminal content, absolute paths, and redacted-detail records
never enter the team/export pipeline. There is no source-level debug export for support.

## Frozen v1 decisions

These close the review gaps. Implement against them; do not re-litigate in code.

1. **`sourceKey` minting:** adapter sends `sourceIdentity`; engine HMAC-SHA-256s with an
   in-memory session key; persist digest only. Adapter does not pre-hash.
2. **`partial`:** coverage only. Measurement is `observed | estimated | unknown`.
3. **Snapshot assembly:** ingest never confirms inclusion. Only
  `recordRequestSnapshot` writes inclusion, copying explicit `confirmedSourceKeys` and
  `candidateSourceKeys` plus an evidence-backed `unknownSourceCount`. The engine never
  chooses ambient candidates implicitly. Source composition is immutable; later
  lifecycle events update a separate request-lifecycle projection.
4. **Transient buffers:** adapter ANSI-strips, truncates to 64 KiB, sets
   `coverage: partial`, coalesces before IPC. No raw retry after drop. Persist at most
   one candidate row per `source_key` per 5 seconds.
5. **Session identity:** adapter allocates `sessionId` and `requestId` (ULIDs). One
   session per extension host/window. Engine restart = new session + new HMAC key.
   History remains under old session ids until eviction.
6. **Budget line:** percent only when `usable_budget_tokens` is observed. Otherwise
   absolute tokens + `est.`.
7. **Fixes:** engine ranks only. No `applyFix` RPC in v1. Adapter executes
   workspace/UI actions; LM summarization is guided or `@contexttop`-owned.
8. **Config:** v1 `setConfig` == `package.json`. Tokenizer mappings and user redaction
   rules are Phase 2.
9. **Capabilities:** intersection of adapter and engine sets. Names:
   `signals.editor`, `signals.terminalShellExecution`, `signals.tools`,
   `signals.participant`, `tokenizer.registry`. `diagnostics.copilotTrace` is omitted
   until the diagnostics validation gate is done.
10. **Phase 1 scope:** engine + IPC + storage + editor-selection candidate signal +
    `@contexttop` snapshots. Diagnostics remain blocked. Webview, not shared React.
    Engine packaging is an explicit work item.

Same-user OS processes can read child stdio and the SQLite file. V1 isolation is
private pipes plus file permissions, not a security boundary against the same user.
