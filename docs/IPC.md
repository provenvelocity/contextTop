# Local IPC protocol (v1)

The VS Code adapter (TypeScript) and the contextTop engine (Rust) communicate over a
versioned, local child-process channel. This document is the v1 contract. It is the
single source of truth for message shapes; the Rust `protocol` module and the TypeScript
bridge must both conform to it.

## Transport

- **v1 transport:** newline-delimited JSON (JSONL) over the engine process's `stdin`/`stdout`.
  One JSON object per line. `stderr` is reserved for engine diagnostics and is never part
  of the protocol.
- Messages are serialized as strict JSON; embedded line breaks are escaped by the JSON
  serializer. A message is rejected before allocation if it exceeds 1 MiB. That envelope
  limit is not the content policy: `transientContent` is at most 64 KiB decoded.
- **No network port.** The engine never opens a listening socket in v1.
- **Future transport:** a local domain socket may be added for a shared Tauri observer.
  The message schema below is transport-independent so it can move without a rewrite.

## Process lifecycle

1. The adapter resolves the signed bundled engine binary for the extension-host
  platform. Packaging, signing, and the host-arch matrix are a Phase 1 work item; they
  are not an existing artifact.
2. The adapter generates a random startup nonce and spawns one engine for that extension
  host/window with private stdin/stdout pipes. It also allocates a `sessionId` ULID for
  that host/window.
3. The adapter immediately sends `request.hello` with the nonce, protocol version, and
  adapter capabilities. No other request is accepted before the handshake completes.
4. The engine echoes the nonce and reports its version and capabilities. The adapter
  rejects a mismatch and kills the child.
5. The adapter sends validated configuration before any observation.
6. On shutdown, it sends `request.shutdown`, waits up to two seconds, then terminates the
  child if necessary.

The nonce detects accidental stream/process mismatch; it is not an authentication
boundary against another process running as the same OS user. Child stdio and OS file
permissions provide the v1 isolation boundary. Remote SSH, WSL, and dev-container engines
run beside the extension host; their SQLite and credential service live on that host and
the UI is a projection. VS Code Web is unsupported in v1.

## Version support matrix

| Component | v1 requirement |
| --- | --- |
| Protocol `v` | `1` (integer major). Adapter and engine must report the same major. |
| VS Code engine | `^1.96.0` (matches `apps/vscode/package.json` `engines.vscode`). |
| Adapter / engine build | Same semver, shipped together (both `0.1.0` in v1). A mismatched pair is a packaging bug. |
| GitHub Copilot | No minimum in Phase 1; diagnostics stay off. A pinned Copilot version range is recorded per parser only when `diagnostics.copilotTrace` ships (see [`SIGNALS.md`](SIGNALS.md#experimental-diagnostic-logs-opt-in)). |
| Rust toolchain | Edition 2024; MSRV to be pinned via `rust-version` in `Cargo.toml` before Phase 1 ships. |

Protocol version and product version are distinct: `v` gates wire compatibility, while
`adapterVersion` / `engineVersion` identify the build pair. Only `v` participates in
degrade logic.

## Message envelope

Every message shares one envelope:

```jsonc
{
  "v": 1,                    // protocol major version, integer
  "id": "01J00000000000000000000000", // ULID; correlates request/response, omitted for events
  "type": "request.hello",   // dotted message type
  "ts": 1757001600000,       // sender epoch milliseconds
  "payload": { }             // type-specific body
}
```

- An unknown `request.*` receives `error.badRequest` with the same `id`; otherwise the
  caller would wait forever for the required response. Unknown event and response types
  are ignored and logged without payload content.
- A receiver that sees a `v` greater than it supports replies with `error.version` and
  degrades to a read-only "engine unavailable" state rather than guessing.
- `sourceKind` values on the wire are lowercase `snake_case` strings for the source categories in
  [`METRICS.md`](METRICS.md#source-categories): `prompt`, `instructions`, `selection`,
  `files`, `terminal`, `history`, `tools`, `tool_results`, `retrieval`, `unknown`. An
  unknown value yields `error.badRequest`.

## Direction and kinds

| Kind | Direction | Correlation |
| --- | --- | --- |
| `request.*` | adapter → engine | expects one `response.*` or `error.*` with same `id` |
| `response.*` | engine → adapter | echoes request `id` |
| `event.*` | engine → adapter | no `id`; fire-and-forget stream |
| `error.*` | either → other | echoes offending `id` when known |

## Handshake

Adapter → engine:

```jsonc
{ "v": 1, "type": "request.hello", "id": "01H...", "ts": 1757001600000,
  "payload": {
    "nonce": "<random-startup-nonce>",
    "adapterVersion": "0.1.0",
    "sessionId": "01H...",
    "capabilities": ["signals.editor", "signals.terminalShellExecution",
                     "signals.tools", "signals.participant"]
  } }
```

Engine → adapter:

```jsonc
{ "v": 1, "type": "response.hello", "id": "01H...", "ts": 1757001600000,
  "payload": {
    "engineVersion": "0.1.0",
    "nonce": "<random-startup-nonce>",
    "capabilities": ["signals.editor", "signals.terminalShellExecution",
                     "signals.tools", "signals.participant",
                     "tokenizer.registry"]
  } }
```

Effective capabilities are the **intersection** of adapter and engine sets. Missing
caps render `unknown` in the UI. V1 capability names:

| Name | Meaning |
| --- | --- |
| `signals.editor` | Selection and active document candidate observations |
| `signals.terminalShellExecution` | Shell-integration command/output (not raw PTY write) |
| `signals.tools` | `lm.tools` inventory |
| `signals.participant` | `@contexttop` request snapshot evidence |
| `diagnostics.copilotTrace` | Experimental; omitted until the diagnostics validation gate is complete |
| `tokenizer.registry` | Built-in tokenizer registry plus conservative fallback |

Do not advertise `tokenizer.tiktoken` unless that is the only shipped tokenizer. Do not
advertise `diagnostics.copilotTrace` in Phase 1.

After hello, every message carrying `sessionId` must match the hello session. A mismatch
is `error.protocol`; the engine never merges data across sessions.

## Adapter → engine requests

### `request.ingestObservation`

Read-only evidence observed by the adapter. The engine HMAC-SHA-256s `sourceIdentity`
with the in-memory session key and updates **candidate state only**. It never promotes
inclusion from this message. `requestId` is omitted in v1; if sent, it is ignored for
inclusion.

If local content processing is allowed, the adapter may send `transientContent` (max
64 KiB decoded, already ANSI-stripped and truncated). The engine tokenizes/redacts it,
then drops the raw buffer without logging or raw persistence. `captureLevel` controls
what may be stored, not whether local processing is allowed. The adapter coalesces
selection/keystroke storms by `sourceIdentity` before sending.

```jsonc
{ "v": 1, "type": "request.ingestObservation", "id": "01H...", "ts": 1757001600000,
  "payload": {
    "sessionId": "01H...",
    "sourceIdentity": "file:///workspace/src/app.ts#selection",
    "sourceKind": "selection",
    "captureLevel": "metadata",
    "observed": { "byteLen": 6800, "lineCount": 120 },
    "transientContent": null,
    "measurement": "observed",
    "coverage": "partial",
    "provenance": "direct_api"
  } }
```

`observed` contains raw, nonnegative adapter observations such as UTF-8 byte and line
counts. The request's `measurement` describes confidence in those supplied observations;
the response's `measurement` describes the derived `tokenCount`, so an observed byte
count can correctly produce an estimated token count. The engine copies `byteLen` to
`SourceMeasurement.byte_count` and derives tokens from `transientContent` when present,
or from the permitted counts otherwise. It never persists the `observed` object or raw
content as received.

The engine replies with the derived `sourceKey` so the adapter can cite it in a later
snapshot without storing paths:

```jsonc
{ "v": 1, "type": "response.ingestObservation", "id": "01H...", "ts": 1757001600000,
  "payload": { "sourceKey": "<hex hmac>", "tokenCount": 1420, "measurement": "estimated" } }
```

When no token value can be derived, `tokenCount` and `tokenizerId` are omitted and
`measurement` is `unknown`; unknown is never encoded as `0` or `null`.

### `request.recordRequestSnapshot`

Records a detected request boundary and explicit inclusion evidence. Ambient candidates
are not automatically promoted to confirmed sources. `requestId` is a ULID allocated by
the adapter. `confirmedSourceKeys` must be keys previously returned by
`response.ingestObservation`. `candidateSourceKeys` explicitly lists measurements to
copy as request-local candidate evidence; the engine never chooses ambient candidates
implicitly. The arrays are disjoint. `unknownSourceCount` counts evidence-backed source
slots known to exist but not measurable; it is not a guess at hidden provider internals.

```jsonc
{ "v": 1, "type": "request.recordRequestSnapshot", "id": "01H...", "ts": 1757001600000,
  "payload": {
    "sessionId": "01H...",
    "requestId": "01H...",
    "sentAtMs": 1757001600000,
    "modelId": "gpt-4o",
    "confirmedSourceKeys": ["<hex hmac>"],
    "candidateSourceKeys": [],
    "unknownSourceCount": 0,
    "provenance": "participant"
  } }
```

`modelId` is optional. `usableBudgetTokens` is included only with a known
`modelId` and only when the adapter obtained the budget from a validated observed field;
otherwise it is omitted (never `null`) and both the budget and budget percentage remain
unknown. The engine replies:

```jsonc
{ "v": 1, "type": "response.recordRequestSnapshot", "id": "01H...", "ts": 1757001600000,
  "payload": { "requestId": "01H...", "recorded": true, "requestSentSeq": 420 } }
```

Snapshot creation is the canonical `request_sent` transition. The engine appends that
lifecycle event at `sentAtMs` and broadcasts it with `requestSentSeq`; the adapter must
not report a duplicate `request_sent` transition.

See snapshot assembly in [`METRICS.md`](METRICS.md#snapshot-assembly). There is no
`applyFix` / `undoFix` RPC in v1. The engine ranks via `getRecommendations`; the adapter
executes user-visible actions, then reports the outcome with `request.reportLifecycle`.

### `request.reportLifecycle`

The engine only knows what the adapter observes. The adapter reports request-lifecycle
transitions and the adapter-owned fix transitions `fix_accepted` and `fix_applied` here.
The engine stores an append-only `LifecycleEvent`, updates the separate lifecycle
projection, and re-emits the corresponding event to all subscribers with a `seq`.
`fix_proposed` is created by the engine when it first returns a recommendation;
`fix_verified` is created by the engine only after the comparison rules in
[`PRODUCT.md`](PRODUCT.md#contexttop-fix) succeed. The adapter must not report either
engine-owned transition.

```jsonc
{ "v": 1, "type": "request.reportLifecycle", "id": "01H...", "ts": 1757001600000,
  "payload": {
    "sessionId": "01H...",
    "requestId": "01H...",
    "kind": "response_started",
    "tsExactMs": 1757001600500
  } }
```

Adapter-reported request kinds are `request_started`, `response_started`, `tool_started`,
`tool_finished`, and `request_completed`. `request_sent` is engine-owned by
`recordRequestSnapshot`. Tool events additionally require an `operationId` ULID so
multiple invocations in one request can be paired. A fix transition uses the same
request type but a fix-specific payload:

```jsonc
{ "v": 1, "type": "request.reportLifecycle", "id": "01H...", "ts": 1757001600600,
  "payload": {
    "sessionId": "01H...",
    "requestId": "01H...",           // optional request during which the action ran
    "fixId": "01H...",
    "kind": "fix_applied",           // fix_accepted | fix_applied
    "tsExactMs": 1757001600600,
    "removedSourceKeys": ["<hex hmac>"] // allowed only on fix_applied removal actions
  } }
```

The engine validates that the `fixId` and any `removedSourceKeys` belong to the frozen
recommendation scope. `removedSourceKeys` is rejected on `fix_accepted` and on actions
whose declared purpose is not removal. It records an applied outcome, not proof that a
later snapshot omitted the source. Estimates and measured savings are engine-owned and
therefore are not accepted from this request. Every accepted transition receives an
acknowledgement; the returned sequence is the sequence used by the re-broadcast event:

```jsonc
{ "v": 1, "type": "response.reportLifecycle", "id": "01H...", "ts": 1757001600600,
  "payload": { "seq": 421 } }
```

Lifecycle writes are idempotent. Repeating the same entity, kind, `tsExactMs`, and
`operationId` (when applicable) returns the original `seq` without a second event.
Reusing a singleton request kind (`request_started`, `request_sent`, `response_started`,
or `request_completed`) with conflicting data is `error.protocol`. A tool finish requires
a prior start with the same `operationId`; no request event is accepted after
`request_completed`. Before `recordRequestSnapshot`, only `request_started` is accepted
and held as pending lifecycle evidence; response, tool, and completion reports require
the canonical `request_sent` marker to exist. `request_started` is optional but must
timestamp no later than send; `response_started` and tool events must timestamp no
earlier than send; completion must timestamp no earlier than every accepted event for
that request. Late arrival is permitted only while those timestamp constraints and the
nonterminal state hold. Fix transitions must follow `proposed → accepted → applied →
verified`; exact retries return the original sequence, while skips, regressions, or
conflicting repeats are `error.protocol`.

`request.recordRequestSnapshot` is likewise idempotent by `requestId`: an identical
retry returns the original `requestSentSeq` with `recorded: false`; conflicting snapshot
content for an existing ID is `error.protocol`.

### `request.getTimeline`

```jsonc
{ "v": 1, "type": "request.getTimeline", "id": "01H...", "ts": 1757001600000,
  "payload": { "sessionId": "01H...", "rangeMs": 900000, "bucketMs": 5000 } }
```

The correlated reply is `response.timeline`.

### `request.subscribeMetrics`

Starts the sequenced event stream. `afterSeq` resumes a prior subscription; `null`
requests the current cursor and a fresh timeline snapshot. Establishing the stream and
capturing its cursor are atomic, so no event can fall between the response and live
delivery. A connection has exactly one active subscription; another subscribe request
atomically replaces it rather than creating a duplicate stream.

```jsonc
{ "v": 1, "type": "request.subscribeMetrics", "id": "01H...", "ts": 1757001600000,
  "payload": { "sessionId": "01H...", "afterSeq": 418 } }
```

The engine first sends exactly one correlated `response.subscribeMetrics`:

```jsonc
{ "v": 1, "type": "response.subscribeMetrics", "id": "01H...", "ts": 1757001600000,
  "payload": {
    "cursor": 419,
    "mode": "replay",                // replay | snapshot
    "replayFromSeq": 419
  } }
```

When a non-null `afterSeq` is still in the bounded replay buffer, `mode: replay` is used
and events `(afterSeq, cursor]` are emitted in order after the response, followed by live
events. When `afterSeq` is null or too old, `mode: snapshot` is used instead;
`replayFromSeq` is omitted and the payload includes `timeline` with the same
fields as `response.timeline`. With no explicit timeline range on this request, that
snapshot uses the product default of 15 minutes and five-second buckets. It contains
exact lifecycle/fix events and current fix states, not buckets alone. Live events then
begin at `cursor + 1`. An `afterSeq` greater than the current cursor is
`error.badRequest`.

### `request.getRecommendations`

```jsonc
{ "v": 1, "type": "request.getRecommendations", "id": "01H...", "ts": 1757001600000,
  "payload": { "sessionId": "01H...", "requestId": "01H..." } }
```

`requestId` is optional. When absent, recommendations describe current candidate
pressure, have no `basisRequestId`, and cannot later claim verified request savings.

### `request.setConfig`

Pushes relevant settings (thresholds, capture level, retention, diagnostic opt-in) so the
engine holds one authoritative policy copy.

```jsonc
{ "v": 1, "type": "request.setConfig", "id": "01H...", "ts": 1757001600000,
  "payload": {
    "warningThreshold": 0.7,
    "captureLevel": "metadata",
    "allowTransientContentProcessing": true,
    "enableDiagnosticLogs": false,
    "detailRetentionHours": 24,
    "measurementRetentionDays": 7,
    "rollupRetentionDays": 30,
    "maxStorageMiB": 100
  } }
```

The engine validates ranges, persists the effective policy, acknowledges it before
ingestion, and immediately purges data no longer allowed by a stricter policy.

V1 `setConfig` matches the extension settings in `apps/vscode/package.json`. Tokenizer
mappings and user redaction rules are **Phase 2** settings; they are not v1 `setConfig`
fields. `enableDiagnosticLogs` may be stored but the engine must ignore diagnostic
ingestion until `diagnostics.copilotTrace` is in the capability intersection.

### `request.shutdown`

```jsonc
{ "v": 1, "type": "request.shutdown", "id": "01H...", "ts": 1757001600000, "payload": {} }
```

## Engine → adapter responses

### `response.timeline`

Correlated reply to `request.getTimeline`. It contains derived five-second buckets (see
[`METRICS.md`](METRICS.md)). Candidate state and request snapshots remain distinct, and
the response includes the stream cursor used to resume.

```jsonc
{ "v": 1, "type": "response.timeline", "id": "01H...", "ts": 1757001600000,
  "payload": {
    "cursor": 419,
    "bucketMs": 5000,
    "buckets": [
      { "windowStartMs": 1757001595000, "bucketMs": 5000, "sessionId": "01H...",
        "candidateLatestTokens": 18400, "candidatePeakTokens": 19100,
        "candidateBySourceLatest": { "files": 5300, "terminal": 6800, "tools": 2100 },
        "maxRequestConfirmedTokens": 17200,
        "maxRequestId": "01J00000000000000000000001", "requestCount": 1,
        "candidateConfidenceCounts": { "observed": 2, "estimated": 3, "unknown": 1 },
        "lifecycleMarkerIds": [417], "fixIds": [] }
    ],
    "requests": [
      { "requestId": "01J00000000000000000000001", "sentAtMs": 1757001598000,
        "modelId": "gpt-4o", "usableBudgetTokens": 128000,
        "confirmedTokens": 17200, "candidateTokens": 1200,
        "confirmedBySource": { "prompt": 700, "files": 9600, "terminal": 6900 },
        "candidateBySource": { "tools": 1200 }, "unknownSourceCount": 1,
        "sources": [
          { "sourceKey": "<hex hmac>", "sourceKind": "terminal", "tokenCount": 6900,
            "measurement": "observed", "inclusion": "confirmed", "coverage": "complete",
            "provenance": "participant" }
        ] }
    ],
    "lifecycleEvents": [
      { "seq": 417, "sessionId": "01H...",
        "requestId": "01J00000000000000000000001",
        "kind": "request_sent", "tsExactMs": 1757001598000 }
    ],
    "fixEvents": [],
    "fixStates": [],
    "activeBudget": { "modelId": "gpt-4o", "usableTokens": 128000,
              "observedAtMs": 1757001598000, "confidence": "observed" }
  } }
```

`requests` contains the privacy-safe request view models needed by the panel; its
candidate breakdown is request-local and must not be confused with ambient
`candidateBySourceLatest`. `sources` omits raw identity/content and represents unknown
tokens by omitting `tokenCount`. `lifecycleEvents` and `fixEvents` contain exact retained
events in the requested time range. `fixStates` contains the latest state for every fix
referenced by that range, even when its earlier transition occurred before the range.
All response fields reflect one atomic read ending at `cursor`.

Each request carries its own observed `usableBudgetTokens`, when available, so mixed-model
ranges remain attributable. `activeBudget` is only the current selected-model budget as
of `observedAtMs`; it is not applied retroactively to requests in the range. It is
present only when the usable budget was **observed** for that model, and `confidence` is
always `observed`. When unknown, the field is omitted entirely (never `estimated` or
`0`) and the UI shows absolute tokens instead of a percent.

The following are the normative wire shapes used by both timeline responses and events;
fields marked `?` are omitted when unknown or inapplicable:

```text
MetricBucketView
  windowStartMs, bucketMs, sessionId
  candidateLatestTokens?, candidatePeakTokens?, candidateBySourceLatest
  maxRequestConfirmedTokens?, maxRequestId?, requestCount
  candidateConfidenceCounts, lifecycleMarkerIds, fixIds

RequestView
  requestId, sentAtMs, modelId?, usableBudgetTokens?
  confirmedTokens?, candidateTokens?
  confirmedBySource, candidateBySource, unknownSourceCount, sources[]

SourceView
  sourceKey, sourceKind, tokenCount?, tokenizerId?
  measurement, inclusion, coverage, provenance

LifecycleEventView
  seq, sessionId, requestId, operationId?, kind, tsExactMs

FixStateView
  seq, sessionId, fixId, basisRequestId?, basisCandidateRevision?
  verificationRequestId?, state, tsExactMs, sourceKind, targetSourceKeys
  estimatedTokensSavedMin, estimatedTokensSavedMax, actualTokensSaved?

CandidatePressureView
  asOfMs, revision, totalTokens?, bySource, unknownSourceCount, confidenceCounts
```

`fixEvents` contains `FixStateView` entries for every transition in range; `fixStates`
contains one latest `FixStateView` per referenced fix. Map fields keyed by source kind
use the lowercase wire values from [Message envelope](#message-envelope). Empty maps and
arrays are present; optional scalars are omitted, not null.

### `response.recommendations`

```jsonc
{ "v": 1, "type": "response.recommendations", "id": "01H...", "ts": 1757001600000,
  "payload": {
    "items": [
      { "fixId": "01H...", "basisRequestId": "01H...", "policyRevision": 3,
        "actionKind": "summarize_terminal",
        "title": "Summarize terminal output", "sourceKind": "terminal",
        "targetSourceKeys": ["<hex hmac>"],
        "detail": "Keep only the failing command and relevant error block.",
        "estimatedTokensSavedMin": 2500, "estimatedTokensSavedMax": 5100,
        "measurement": "estimated", "reversible": true, "execution": "guided" }
    ]
  } }
```

- `fixId` is an engine-allocated ULID identifying one frozen recommendation and is used
  for all later fix events.
- `basisRequestId` identifies the immutable before-snapshot used to rank the fix and is
  absent for candidate-only recommendations. Candidate-only items instead include
  `basisCandidateRevision`, the `CandidatePressureView.revision` used for ranking.
- `policyRevision` is incremented whenever the effective configuration changes.
- `actionKind` is one of `summarize_terminal`, `start_clean_chat`,
  `propose_exclusion`, `unselect_tools`, or `detach_files`; it tells the adapter which
  supported action contract the recommendation describes.
- `targetSourceKeys` freezes the pseudonymous source scope used for verification.
- `reversible` means the user-visible action can be restored without source-data loss.
  It does not promise automated undo. Automated undo is offered only when the action is
  both `reversible` and `execution: executable` and the adapter retains restoration data.
- `execution: executable` means the adapter can apply the action through a supported API
  after confirmation; `guided` means the user or `@contexttop` must perform it;
  `unsupported` means contextTop can identify the pressure but cannot safely apply or
  guide an action in the current environment.

Exactly one of `basisRequestId` or `basisCandidateRevision` is present. Proposal identity
is the tuple `(sessionId, basis, policyRevision, actionKind, sourceKind,
sorted(targetSourceKeys))`. The engine memoizes that tuple for the retained session:
repeated reads return the same `fixId` and do not emit another `fix_proposed` transition.
A changed tuple is a new proposal with a new `fixId` and one proposed event.

### Other acknowledgements

Successful configuration replies with the complete normalized policy the engine will
enforce:

```jsonc
{ "v": 1, "type": "response.setConfig", "id": "01H...", "ts": 1757001600000,
  "payload": { "policyRevision": 3,
    "effectiveConfig": { "warningThreshold": 0.7, "captureLevel": "metadata",
    "allowTransientContentProcessing": true, "enableDiagnosticLogs": false,
    "detailRetentionHours": 24, "measurementRetentionDays": 7,
    "rollupRetentionDays": 30, "maxStorageMiB": 100 } } }
```

`request.shutdown` receives `response.shutdown` with `{ "accepted": true }`; the engine
flushes permitted data and closes stdout only after writing that response.

## Engine → adapter events

Pushed without a request so the panel updates live. Every data event carries a
monotonically increasing per-engine `seq`. Candidate updates may be coalesced before a
data event is created, but once a `seq` is assigned that event enters the global bounded
replay buffer unchanged. Adapter-owned transitions are re-broadcast after validation;
engine-owned `request_sent`, `proposed`, and `verified` transitions use the same stream.

| Type | Payload summary |
| --- | --- |
| `event.metrics` | Target v1: `{ seq, sessionId, bucket, candidatePressure, latestRequest }` — `bucket` is `MetricBucketView`, `candidatePressure` is `CandidatePressureView`, and `latestRequest` is omitted or a `RequestView`. **Shipped streaming subset:** `{ candidateLatestTokens, candidatePeakTokens, candidateBySourceLatest, windowStartMs }`, pushed after each accepted `ingestObservation`. `candidateBySourceLatest` maps `sourceKind → tokens`. The sequenced/replayable form (with `seq` and `bucket`) lands with the persisted stream. |
| `event.requestLifecycle` | `{ seq, sessionId, requestId, operationId?, kind, tsExactMs }` |
| `event.fixState` | `FixStateView` |
| `event.streamGap` | `{ sessionId, lastDeliveredSeq, earliestAvailableSeq, currentSeq }` — subscriber-specific control event; client must re-fetch timeline |

The **shipped v1 stream is unsequenced**: the engine pushes an `event.metrics` after
every accepted `ingestObservation` so the dashboard updates instantly. The `seq`,
bounded replay buffer, and `event.streamGap` recovery described here are the target
contract for the persisted stream and are not yet emitted.

`event.requestLifecycle.kind` and `tsExactMs` repeat the canonical lifecycle marker,
whether it came from `request.reportLifecycle` or the `request_sent` marker created by
`recordRequestSnapshot`; there is no `phase`/`tsExact` alias.

Valid `event.fixState.state` values are `proposed`, `accepted`, `applied`, and `verified`.
The event always repeats the frozen estimate and target scope. `actualTokensSaved` is a
signed integer and is present only for `verified`; a negative value honestly reports
that the target scope grew. A verified event also includes `verificationRequestId` for
the after-snapshot. Proposed and verified events originate in the engine; accepted and
applied events re-broadcast adapter reports.

```jsonc
{ "v": 1, "type": "event.requestLifecycle", "ts": 1757001600500,
  "payload": { "seq": 421, "sessionId": "01H...", "requestId": "01H...",
    "kind": "response_started", "tsExactMs": 1757001600500 } }
{ "v": 1, "type": "event.fixState", "ts": 1757001600900,
  "payload": { "seq": 422, "sessionId": "01H...", "fixId": "01H...",
    "basisRequestId": "01H...", "verificationRequestId": "01H...",
    "state": "verified", "tsExactMs": 1757001600900, "sourceKind": "terminal",
    "targetSourceKeys": ["<hex hmac>"], "estimatedTokensSavedMin": 2500,
    "estimatedTokensSavedMax": 5100, "actualTokensSaved": 3300 } }
```

## Errors

```jsonc
{ "v": 1, "type": "error.badRequest", "id": "01H...", "ts": 1757001600000,
  "payload": { "code": "badRequest", "message": "unknown sourceKind 'foo'" } }
```

| Code | Meaning |
| --- | --- |
| `version` | Unsupported protocol version; sender should degrade |
| `badRequest` | Malformed or unknown payload |
| `protocol` | Handshake incomplete, nonce mismatch, or invalid message sequence |
| `tooLarge` | Message exceeded the configured limit |
| `busy` | Ingress queue is full; coalesce and retry non-lifecycle observations |
| `internal` | Engine fault; adapter shows "engine unavailable", keeps last good view |

## Versioning rules

- `v` is the protocol **major** version. Breaking changes bump it.
- Additive fields within a major version are allowed; receivers ignore unknown fields.
- The adapter and engine ship together, so a mismatched pair is a bug, not a supported
  configuration; `error.version` exists only as a safe-degrade guard.
- `v` (wire compatibility) is independent of `adapterVersion` / `engineVersion` (build
  identity). The full matrix is in [Version support matrix](#version-support-matrix).

## Backpressure and recovery

- The engine has a bounded ingress queue and bounded queue per subscriber.
- Candidate gauge updates for the same `sourceKey` may be replaced by the newest value
  before an event sequence is assigned.
- The global replay buffer contains every assigned data-event sequence, including metric,
  lifecycle, and fix events. Subscriber queues do not coalesce already-sequenced events.
- If a subscriber queue overflows, the engine discards that subscriber's pending queue,
  suspends its data delivery, and emits one unsequenced `event.streamGap` control event
  when writable. The client replaces its projection from `request.getTimeline` and
  resubscribes after the returned cursor. Other subscribers and the global sequence are
  unaffected.
- Requests time out after five seconds unless a type defines a longer limit.
- On `busy`, the adapter coalesces candidate updates and retries with bounded exponential
  backoff. It does not retry raw content after the originating buffer has been dropped.
- On restart or `event.streamGap`, the adapter calls `request.getTimeline`, adopts its
  cursor, and resumes the subscription. The UI is not a durable store.

## Privacy invariants

- When `allowTransientContentProcessing` is `false`, `transientContent` is always `null`
  and token estimates use permitted sizes/counts only.
- When it is `true`, raw content may cross the private child pipe solely as transient
  processing input, regardless of persistence level. It is tokenized/redacted in memory
  and dropped immediately afterward. Default-on processing means source text still
  enters the child process in metadata mode; the settings UI must say so.
- `sourceIdentity` is transient identity. The engine persists only its HMAC `sourceKey`.
  Absolute paths never appear in SQLite, logs, crash reports, or export.
- `stderr`, panic, and tracing must not include `transientContent` or `sourceIdentity`.
- `captureLevel: metadata` permits only measurements and pseudonymous identifiers in
  storage. `redacted-detail` additionally permits the encrypted, short-lived redacted
  derivative—never the raw input.
- Raw content is never persisted, logged, included in crash reports, or exported.
- Diagnostic records use versioned strict allowlists; unmatched records and unknown
  fields are discarded before normalization.
- Only aggregate metric buckets may enter an export queue. The queue is bounded to 24
  hours and contains no source-level identifiers or optional redacted detail.
- Retention is enforced by both age and size as defined in
  [`METRICS.md`](METRICS.md#storage-and-retention).
