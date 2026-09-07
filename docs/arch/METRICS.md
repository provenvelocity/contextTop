# Metrics and timeline contract

## Metric meaning

contextTop exposes two related but different measurements. The UI and API must never
collapse them into one unlabeled number.

- **Candidate pressure** is locally visible material that could contribute to a future
  request: active selection, referenced files, recent terminal execution output,
  available tools, and other ambient state. Visibility does not prove inclusion.
- **Request context** is the composition associated with one detected request. A source
  is `confirmed` only when supported request evidence reports its inclusion; otherwise
  it remains `candidate` or `unknown`.

Token measurement and request inclusion are orthogonal:

| Dimension | Values | Meaning |
| --- | --- | --- |
| Measurement | `observed`, `estimated`, `unknown` | How the size/token value was obtained |
| Inclusion | `confirmed`, `candidate`, `unknown` | Whether the source entered the request |
| Coverage | `complete`, `partial`, `unknown` | Whether evidence covers the whole source |

`partial` is coverage only, never a measurement. An editor selection can therefore have
an observed byte count, an estimated token count, partial coverage if truncated, and
only candidate inclusion in a standard Copilot request.

## Snapshot model

Context pressure is a **gauge**, not a counter. Repeated observations replace prior
state for the same source key; they are not added together. Each request's source
composition is an immutable snapshot taken at send time. Lifecycle timestamps are a
separate mutable projection over append-only events; changing that projection never
changes the snapshot's measurements, model, budget, or send time.

```text
SourceMeasurement
  source_key                 HMAC-SHA-256 of adapter sourceIdentity; never an absolute path
  source_kind
  observed_at_ms
  byte_count?
  token_count?               u64; absent means unknown, never zero
  tokenizer_id?
  measurement: observed | estimated | unknown   confidence of token_count
  inclusion: confirmed | candidate | unknown
  coverage: complete | partial | unknown
  provenance: direct_api | participant | diagnostic | local_estimate

RequestContextSnapshot
  session_id
  request_id
  sent_at_ms
  model_id?                  optional; required when usable_budget_tokens is present
  usable_budget_tokens?      observed validated field only; never a guessed model window
  measurements[]             immutable after snapshot creation
  confirmed_tokens?          sum of quantifiable confirmed measurements only
  candidate_tokens?          separate sum of quantifiable candidate measurements
  unknown_source_count       immutable

RequestLifecycle
  session_id
  request_id
  started_at_ms?
  response_started_at_ms?
  completed_at_ms?

LifecycleEvent
  session_id
  request_id?
  fix_id?
  operation_id?               required for tool_started/tool_finished
  timestamp_ms
  kind: request_started | request_sent | response_started | tool_started |
        tool_finished | request_completed | fix_proposed | fix_accepted |
        fix_applied | fix_verified
```

Ambient measurements without a request ID remain candidate state. When a request is
detected, the engine creates a new snapshot and correlates only evidence allowed by that
signal adapter. It never silently converts ambient candidates into confirmed context.

### Snapshot assembly

`ingestObservation` updates **candidate state** only. Its `requestId` field is omitted
in v1; if present, the engine ignores it for inclusion. Confirmed inclusion is written
only by `recordRequestSnapshot`.

On `recordRequestSnapshot`:

1. The engine freezes an immutable source-composition `RequestContextSnapshot` at
  `sentAtMs`.
2. `confirmedSourceKeys` listed with `provenance: participant` or a validated
   diagnostic field are copied as `inclusion: confirmed` using the latest measurement
  for that key that the engine has accepted when it handles the snapshot and whose
  `observed_at_ms` is no later than `sentAtMs`. A later-arriving observation never
  rewrites the snapshot, even if its source timestamp is older.
3. Only keys explicitly listed in `candidateSourceKeys` are copied as
  `inclusion: candidate`. The engine never selects ambient candidate state on its own.
4. `unknown_source_count` is copied from the adapter's evidence-backed
  `unknownSourceCount`. Unobserved provider internals are not guessed or counted.
5. Ambient candidate gauges are not mutated by snapshot creation.

`confirmed_tokens` never includes candidate measurements. `candidate_tokens` remains a
separate labeled subtotal inside the snapshot; the UI must not combine it into a
request-context total. Either subtotal is absent when no quantifiable evidence exists,
rather than using zero for unknown. Bucket fields named `max_request_confirmed_tokens`
therefore compare confirmed subtotals only.

A lifecycle report appends a `LifecycleEvent` and updates `RequestLifecycle`. Before
snapshot creation, only `request_started` may be held as pending evidence by `requestId`;
all other request events require the canonical `request_sent` marker created with the
snapshot. Later events update only the lifecycle projection and never rewrite the frozen
snapshot. The engine owns `fix_proposed` and `fix_verified`; the adapter may report
`fix_accepted` and `fix_applied` as specified in
[`IPC.md`](IPC.md#requestreportlifecycle).

`model_id` may be absent when the adapter cannot observe it. A usable budget may be
stored only when both the model and an explicit validated budget field were observed.
An absent model prevents strict before/after fix verification. An absent budget only
disables budget percentages; neither value is replaced by a guessed default.

The adapter allocates `sessionId` (ULID) at extension-host activation and `requestId`
(ULID) at a detected request boundary. The engine never invents request IDs. One session
per extension host/window; multi-root workspaces share that session.

### Persist sampling

The in-memory gauge always reflects the latest observation. SQLite does **not** store
every keystroke-level candidate update. Durable writes occur:

- on every `RequestContextSnapshot` and lifecycle/fix event;
- at most one candidate measurement per `source_key` per 5 seconds (latest wins);
- on session end / shutdown flush;
- never for raw or `transientContent` buffers.

If this sampling would exceed the storage cap, eviction in
[Storage and retention](#storage-and-retention) runs first.

## Live stream and display windows

The live dashboard is **instant**: the engine emits an `event.metrics` after each
accepted `ingestObservation`, and the adapter plots that event as a point in a rolling
in-memory series. There is no fixed refresh window on the live chart; it streams as fast
as observations arrive (after adapter-side coalescing of selection/keystroke storms).

Five-second windows are the **persistence and historical-zoom** projection, not the live
cadence. Buckets are aligned to Unix epoch boundaries: `[N × 5000, (N + 1) × 5000)`
milliseconds, and are used for durable sampling, rollups, and zoomed-out historical
views. They use the **engine clock**; remote SSH/WSL/dev-container sessions do not use
the laptop clock.

For each window, the engine derives:

- the latest candidate-pressure state at the end of the window;
- peak candidate pressure seen during the window;
- request count and exact request markers;
- the maximum request-context snapshot in the window and its source composition;
- fix counts and exact fix markers.

Multiple requests in one window are never summed. Repeated source updates are never
summed. Request and fix timestamps remain exact in details. One-second zoom is available
only while sufficient short-lived measurements remain; older views use retained
five-second or hourly rollups.

```text
MetricBucket
  window_start_ms
  bucket_ms
  session_id
  candidate_latest_tokens?
  candidate_peak_tokens?
  candidate_by_source_latest
  max_request_confirmed_tokens?
  max_request_id?
  request_count
  candidate_confidence_counts
  lifecycle_marker_ids
  fix_ids
```

## Chart design

The panel is a live, always-on dashboard — **"`top`, but for context"** — with an
explicit mode label. It has four regions:

- **Streaming line chart:** total candidate pressure plus one colored line per source
  kind, updated on every observation. Each source kind has a fixed color and a legend.
  In **request mode**, confirmed-token totals per request are drawn; candidate-only
  measurements stay in a separate labeled breakdown and multiple requests are never
  summed.
- **Gauges (the `top` header):** current total, session peak, growth rate (tokens/sec),
  and inventory counts — tools/MCP loaded, instruction files, open files, terminals.
- **Source table (the `top` process list):** each candidate source kind sorted by token
  cost, with a color swatch and its share of the total.
- **Budget line:** selected-model usable context budget, only when
  `usable_budget_tokens` was **observed**. Estimated local windows are not drawn as a
  budget percent.
- **Request lane / fix lane:** exact send, response, tool-call, completion, and
  proposed/accepted/applied/verified markers when that evidence exists.

The live view streams instantly. Zoomed-out ranges (1 minute, 15 minutes, 1 hour, and
the retained portion of the current session) are served from five-second and hourly
rollups.

## Source categories

Each source kind has a fixed chart color so the streaming lines, legend, and source table
stay consistent.

| Category | Color | Examples |
| --- | --- | --- |
| Prompt | pink `#e57ec9` | User prompt text for the current turn |
| Instructions | teal `#38c5c5` | Custom instruction, prompt, and agent files loaded into the request (e.g. `copilot-instructions.md`, `*.instructions.md`, `AGENTS.md`, `*.prompt.md`) |
| Selection | orange `#e5a44e` | Selected editor text and open document contribution |
| Files | blue `#4f9cff` | Attached/referenced workspace files |
| Terminal | green `#4ec98a` | Command text and eligible execution output |
| History | gray `#9aa0a6` | Prior chat turns or generated handoff summary |
| Tools | purple `#a06cf0` | Tool definitions, schemas, and attached-tool inventory (includes MCP-registered tools from `vscode.lm.tools`) |
| Tool results | gold `#c9a04e` | Returned content from tool calls |
| Retrieval | indigo `#6c7ff0` | Workspace/search retrieval when evidence is available |
| Unknown | neutral `#777777` | Provider-side or opaque context not observable to contextTop |

## Collection pipeline

```text
read-only collectors
        │ adapter coalesces + truncates + ANSI-strips
        ▼
bounded observations over JSONL
        │
        ▼
normalization + strict allowlists
        │
        ├─ metadata only ──────────────────────────────┐
        │                                               │
        └─ transient content (when locally permitted)    │
              ▼                                         │
        tokenizer + redactor                             │
              │ raw buffer dropped after processing     │
              └─────────────────────────────────────────┤
                                                       ▼
                                  measurements + request snapshots
                                         │                 │
                                         ▼                 ▼
                                  bounded SQLite       live metric stream
                                         │
                                         ▼
                                five-second/hourly rollups
```

Collectors read editor, terminal, chat-participant, and opt-in diagnostic signals. They
never mutate source files, selections, terminals, prompts, logs, or Copilot state. The
adapter coalesces noisy candidate updates (selection/keystroke storms) by identity
**before** IPC. The engine ingress queue is bounded; candidate gauge updates for the same
identity may be replaced by the newest value. Request lifecycle and fix events are not
dropped.

Transient processing and persistence are separate controls. With local content
processing enabled, the adapter may send a bounded raw buffer (`transientContent`, max
64 KiB decoded, already ANSI-stripped and truncated with `coverage: partial`). The
engine tokenizes/redacts it in memory and drops it. Metadata persistence still stores
only the resulting metrics. If local content processing is disabled, collectors send
sizes/counts only and the engine uses a conservative estimator with reduced confidence.
The 1 MiB JSON envelope is a transport limit, not the content policy. The adapter
truncates only when one ANSI-stripped observation exceeds 64 KiB, at a valid UTF-8
boundary, and then marks coverage partial. Coalescing decides which observation to send;
it never concatenates observations past the cap. The adapter never retries raw content
after the originating buffer has been dropped.

## Storage and retention

Raw source content is processing input, not telemetry. It is never written to the metric
database, logs, crash reports, or export queues.

| Data class | Default retention | Maximum retention | Notes |
| --- | --- | --- | --- |
| Raw source buffers | In-memory processing only | None persisted | Dropped immediately after tokenization/redaction |
| Optional redacted detail | 24 hours | 7 days | Separate encrypted local store; opt-in only |
| Source measurements and request snapshots | 7 days | 30 days | No raw paths, prompts, terminal text, or source text |
| Five-second buckets | 7 days | 30 days | Recomputed while source measurements exist |
| Hourly aggregate rollups | 30 days | 90 days | No source-level identifiers |
| Pending export batches | Until delivered or 24 hours | 24 hours | Aggregate-only; bounded spool |

Retention is enforced by age and by a default 100 MiB local storage cap. Cleanup runs at
startup, periodically, after configuration changes, and before writes that would cross
the cap. Eviction order is redacted detail, oldest measurements/snapshots, five-second
buckets, then oldest hourly rollups.

The current live session remains in memory even if old persisted data is evicted.
Process death ends that live session; a restarted engine opens a new `sessionId` and
HMAC key. Historical rows remain queryable under their original session ids until
age/size eviction.

SQLite uses WAL mode, restrictive user-only file permissions, schema migrations, and
`secure_delete` where supported. Cleanup checkpoints/truncates the WAL. These controls
provide bounded application retention but cannot promise forensic erasure on SSDs or
backups. Lowering retention or switching capture to `off` triggers immediate best-effort
purge of data that is no longer permitted.

Optional redacted detail is application-layer encrypted with an authenticated key from
the platform credential service. This detail-encryption key is distinct from the
ephemeral source-key HMAC key. Each ciphertext blob stores a `key_id`; one key version is
active for writes, and older versions are retained in the credential service only while
unexpired detail still references them. Rotation is explicit (credential reset or crypto
migration), not an automatic consequence of every engine restart. The key material is
never stored beside the database. If the service is unavailable or locked, detail
persistence is disabled rather than written in plaintext. If a referenced key is lost,
matching blobs are deleted, not left as unreadable residue. Remote SSH/WSL hosts use that
host's credential service; if none exists, detail stays off.

Source keys are HMAC-SHA-256 of adapter-supplied `sourceIdentity` using a random
in-memory session key. They are stable within one engine process and deliberately
unlinkable across restarts. The adapter does not pre-hash. Absolute paths never land in
SQLite, logs, or export. HMAC, rather than an unhashed or plain hash identity, prevents a
reader of the database from recovering likely paths with a precomputed dictionary and
provides session-scoped pseudonymity. It does not protect against a process that can read
the running engine's memory.

## Live streaming

The engine is the source of truth. Clients subscribe with a last-seen sequence number.
Every data event has a monotonically increasing per-engine `seq` and enters one bounded
global replay buffer after any pre-sequence candidate coalescing.

- Each subscriber has a bounded queue.
- Gauge updates for the same bucket/source may be coalesced only before sequence
  assignment. Subscriber queues never coalesce assigned sequences.
- The replay buffer retains metric, lifecycle, and fix data events. V1 has no per-event
  acknowledgement RPC.
- One subscription exists per connection. A new subscribe request atomically replaces
  the old one.
- If a client queue overflows, its stream is suspended and it receives an unsequenced,
  subscriber-specific gap notification. The client replaces its projection with an
  atomic timeline snapshot containing buckets, request view models, exact lifecycle/fix
  events, and current fix states, then resumes after that snapshot's cursor.
- The UI does not persist its own copy of metrics.

Optional team/export streaming is a separate opt-in sink. It receives aggregate buckets
only, never raw content or redacted detail. Its disk spool is bounded by age and size; if
the destination remains unavailable, the oldest batch expires rather than accumulating
forever. There is no source-level debug export, including for support.

## Token estimation

Use a model-specific tokenizer when the selected model and tokenizer are available.
Otherwise use a conservative approximation and label it `estimated`. Token accounting
keeps source size, tool schemas, and tool results separate. Unknown values remain absent
and contribute to `unknown_source_count`; they are not represented as zero.

A status-bar or chart budget **percent** is shown only when `usable_budget_tokens` was
observed from a validated field. Local file sizes and model-window guesses are never
presented as Copilot budget pressure.
