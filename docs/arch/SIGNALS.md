# Signal capability matrix

This is the honest observation contract. Every source contextTop reports carries its
provenance, measurement confidence, coverage, and request-inclusion status. contextTop
must never present locally visible material as provider-reported request context.

## Detection tiers

- **Direct API** — a supported VS Code extension API reports local or participant state.
- **Diagnostic log** — parsed from a validated GitHub Copilot diagnostic source.
  Experimental and opt-in only. Two candidate sources exist: the structured VS Code
  **Agent Debug Log** export (OTLP JSON, preferred) and raw Copilot trace logs. Both
  stay off until a pinned schema is validated.
- **Local estimate** — computed locally with a tokenizer or filesystem metadata.
- **Not detectable** — occurs inside Copilot/provider internals contextTop cannot see.

## Confidence mapping

`partial` is **coverage**, never a measurement. Diagnostic fields that only cover part
of a source are `measurement: observed` or `estimated` with `coverage: partial`.

| Tier | Measurement | Default inclusion | Default coverage |
| --- | --- | --- | --- |
| Direct ambient API | `observed` or `estimated` | `candidate` | `complete` unless truncated |
| `@contexttop` participant request | `observed` or `estimated` | `confirmed` for explicit references | `complete` unless truncated |
| Validated diagnostic field | `observed` or `estimated` | field-specific | often `partial` |
| Local estimate | `estimated` | inherited from its evidence source | inherited |
| Not detectable | `unknown` | `unknown` | `unknown` |

## Observed — direct VS Code APIs

| Signal | API | What is actually known |
| --- | --- | --- |
| Editor selection | `window.onDidChangeTextEditorSelection` | Exact selected range; candidate inclusion only |
| Active document | `window.activeTextEditor` | URI, language, and readable size; candidate inclusion only |
| Workspace files | `workspace.findFiles` | File inventory when permitted; enumeration does not imply inclusion |
| Instruction/prompt files | `workspace.findFiles` on known instruction paths | Inventory and readable size of `copilot-instructions.md`, `*.instructions.md`, `AGENTS.md`, `*.prompt.md`; candidate inclusion only until a request confirms load |
| Terminal execution | `window.onDidStartTerminalShellExecution` and `TerminalShellExecution.read()` | Command metadata and output written after `read()` starts; shell integration required |
| Terminal completion | `window.onDidEndTerminalShellExecution` | Exit status and final command-line confidence when reported |
| Chat request | chat participant callback | Prompt, references, attached tools, and selected model for `@contexttop` only |
| Available tools | `lm.tools` | Inventory only; availability does not imply inclusion |
| Attached tools | participant `request.toolReferences` | Explicitly attached to the `@contexttop` request |
| Tool invocation/result | `lm.invokeTool` performed by `@contexttop` | Input/result observed only for invocations owned by the participant |
| Configuration | `workspace.getConfiguration` | contextTop settings, subject to workspace trust |

Direct API signals only cover requests routed through the `@contexttop` participant, or
ambient editor/terminal/tool state. Standard Copilot Chat request bodies are not exposed
to extensions.

### Implemented ambient collectors

The adapter currently ingests these as **candidate** (`estimated`, `direct_api`) sources
that stream into the live dashboard:

- **Selection** — `onDidChangeTextEditorSelection`, debounced (~120 ms) to avoid
  drag-select storms; `sourceKind: selection`.
- **Open files** — every non-untitled open document, re-scanned on open/close/save and
  visible-editor changes; `sourceKind: files`.
- **Instruction/prompt/agent files** — `findFiles` on `copilot-instructions.md`,
  `*.instructions.md`, `AGENTS.md`, `*.prompt.md`, sized via `workspace.fs.stat`;
  `sourceKind: instructions`.
- **Tools / MCP** — `vscode.lm.tools`, costed by serialized name + description + input
  schema; `sourceKind: tools`. **MCP-registered tools appear here**, so MCP schema
  overhead is counted as tool pressure. Re-scanned every 5 s so servers that load later
  are picked up.

Inventory counts (tools/MCP, instruction files, open files, terminals) are surfaced as
dashboard gauges. All of these are candidate-only until a request confirms inclusion.

There is no supported `window.onDidWriteTerminalData` API in the extension typings used
by this project. Terminal output collection is limited to integrated terminals with shell
integration and starts when `TerminalShellExecution.read()` is called. External terminals,
earlier scrollback, task terminals without shell integration, and output written before
the stream is opened are unknown. The **adapter** strips ANSI and truncates to 64 KiB
**before** IPC. Truncation occurs only when a single stripped observation exceeds the
cap, stops at a valid UTF-8 boundary, and sets `coverage: partial`. Coalescing replaces
superseded observations by `sourceIdentity`; it does not concatenate them past the cap.
The engine does not re-strip.

The adapter sends `sourceIdentity` (URI, terminal id, tool id). It does not pre-hash.
The engine HMAC-SHA-256s that identity. Confirmed inclusion is written only by
`recordRequestSnapshot` from `@contexttop` or a validated diagnostic field — never by
ambient ingest.

## Experimental diagnostic logs (opt-in)

Requires the user to enable Copilot trace logging and grant contextTop read access to
**specific Copilot log files**, not the entire VS Code log tree. It is gated behind
`contextTop.enableDiagnosticLogs` (default `false`). The adapter remains unavailable
unless the installed Copilot version and log schema have been explicitly validated.

Two diagnostic sources are in scope, both deny-by-default:

- **VS Code Agent Debug Log (preferred).** Enabled by the user via
  `github.copilot.chat.agentDebugLog.fileLogging.enabled`, this emits a structured,
  exportable **OTLP JSON** record per session with the system prompt, resolved context,
  tool payloads, and a token-usage summary. Because it is first-party and structured, it
  is the preferred path to confirm standard-chat composition without a proxy. It is still
  gated, version-pinned, and field-allowlisted like any other diagnostic source.
- **Raw Copilot trace logs (fallback).** Unstructured lines under the VS Code log tree,
  parsed only with a pinned filename / extension-id allowlist when the Agent Debug Log is
  unavailable or insufficient.

Phase 1 ships a **first-cut, opt-in tailer** for the two always-present Copilot logs
(`contextTop.enableDiagnosticLogs`, and always on in the debug/dev host). It reads the
current window's Copilot log directory — resolved as a sibling of contextTop's own
`exthost` log dir — and ingests:

- **Agent tool calls** — each `PostToolUse` line in `GitHub Copilot Chat Hooks.log`
  becomes a `tool_results` observation sized by the returned payload (`estimated`).
- **Summarization usage** — `Summarization usage: prompt=…, completion=…` lines in
  `GitHub Copilot Chat.log` become `history` observations with **observed** token counts.

The structured **OTLP Agent Debug Log** parser is **not yet finalized**: the tailer
discovers OTLP files once the user enables them and logs their structure plus any
well-known token-usage fields, so the parser can be validated against a real record.
`diagnostics.copilotTrace` stays omitted from hello until that validation gate is
complete. A missing or unvalidated parser is `unknown`, never a best-effort scrape.

### Data catalog with the Agent Debug Log enabled

Once `github.copilot.chat.agentDebugLog.fileLogging.enabled` is on, the OTLP record is
expected to expose these data points. Each maps to an existing engine `SourceKind`, so
the pipeline is ready to receive them (validation of exact field names pending a sample):

| OTLP data point | Engine `SourceKind` | Measurement / inclusion |
| --- | --- | --- |
| System prompt text/size | `prompt` | observed/estimated · candidate→confirmed via snapshot |
| Instruction/agent files resolved into the request | `instructions` | observed · confirmed |
| Resolved workspace files | `files` | observed · confirmed |
| Editor selection contribution | `selection` | observed · confirmed |
| Prior-turn / summarized history | `history` | observed/estimated |
| Tool definitions + schemas | `tools` | observed |
| Tool call inputs/results | `tool_results` | observed |
| Retrieval / search results | `retrieval` | estimated · partial |
| Token-usage summary (prompt/completion/total) | request snapshot | **observed** |
| Selected model id | request snapshot `model_id` | observed |
| Usable context budget | request snapshot `usable_budget_tokens` | observed — only source for a UI budget percent |

Candidate fields to validate before enabling diagnostics—not a guaranteed schema:

| Signal | Candidate field pattern | After validation |
| --- | --- | --- |
| Request lifecycle | request start/send/response/completion markers | measurement `observed`, coverage `complete` for the marker |
| Selected model | model identifier | measurement `observed` |
| Chat history | turn count or approved size metadata | measurement `estimated`, coverage `partial` |
| Attached files | attachment metadata | measurement `observed` when explicit |
| Tool schema size | tool-definition count/size | measurement `observed` |
| Retrieval results | retrieval count/size metadata | measurement `estimated`, coverage `partial` |
| Provider budget | context budget when explicitly reported | measurement `observed`; this is the only source for a UI budget percent |

Log roots (not a file allowlist):

```text
macOS:   ~/Library/Application Support/Code/User/logs/<date>/
Windows: %APPDATA%\Code\User\logs\<date>\
Linux:   ~/.config/Code/logs/<date>/
```

Those directories contain **all** VS Code logs. A parser ships only with a pinned
filename / extension-id allowlist for GitHub Copilot traces, plus pinned VS Code and
Copilot version ranges. Workspace trust is required before any log-directory access.

Each parser uses a strict field allowlist. It extracts approved timestamps, identifiers,
counts, sizes, model IDs, and explicit inclusion metadata, then immediately discards the
source line. Unknown fields and whole unmatched records are ignored—not serialized,
persisted, or exported. Raw prompts, responses, request bodies, tool inputs/results,
authorization data, headers, and provider payloads are denied even if a future log
version exposes them.

## Estimated — computed locally

| Metric | Method | Confidence |
| --- | --- | --- |
| Token count | Model-specific tokenizer, else conservative BPE fallback | estimated |
| Unopened file size | `fs.stat` | estimated |
| Terminal execution output | Bounded shell-execution stream after ANSI stripping | estimated; coverage `partial` if truncated |
| Tool schema tokens | Tokenized schema JSON | estimated |
| Reconstructed history | Heuristic from visible turns | estimated |

## Not detectable — recorded as unknown

- Exact Copilot request body for standard (non-participant) chat.
- Provider-side retrieval process.
- Copilot internal prompt assembly, dedup, and truncation.
- Server-side token pressure.
- Intermediate streaming chunks not surfaced by the participant API.

## Tokenizer strategy

contextTop targets whatever model the user's session reports; it does not assume one
provider.

1. Resolve the active model from the diagnostic log or VS Code language-model selection.
2. Dispatch to a matching tokenizer via the registry (see below).
3. If no tokenizer matches, use the conservative fallback and label the result
   `estimated`.

Token accounting keeps source size, tool schemas, and tool results in separate buckets.
Hiding tool definitions in a generic bucket defeats the product's purpose.

## Extensibility

V1 uses a built-in tokenizer registry plus a conservative fallback. Arbitrary
workspace-provided executable/WASM tokenizers are explicitly out of scope for v1 because
workspace trust, integrity, sandboxing, memory, CPU, and host-capability boundaries are
not yet specified.

`contextTop.modelTokenizerMappings` and `contextTop.redactionRules` are **Phase 2**
settings. They are not in v1 `package.json` or `request.setConfig`. Until then, only
built-in tokenizers and built-in redaction rules run.

```rust
pub trait TokenizerProvider {
    fn name(&self) -> &str;
    fn matches(&self, model: &str) -> bool;
    fn encode_len(&self, text: &str) -> u64;
}

pub trait RedactionRule {
    fn name(&self) -> &str;
    fn redact(&self, text: &str) -> String;
}
```

Phase 2 declarative redaction additions are permitted through user settings only.
Patterns are compiled with Rust's bounded, non-backtracking regex engine and are
rejected when they exceed configured pattern/input limits **or** a match timeout.
Workspace-defined rules require workspace trust and explicit user approval.

```jsonc
{
  "contextTop.modelTokenizerMappings": [
    { "modelPattern": "company-*", "tokenizer": "cl100k_base" }
  ],
  "contextTop.redactionRules": [
    { "pattern": "AKIA[0-9A-Z]{16}", "label": "AWS access key" },
    { "pattern": "Bearer [A-Za-z0-9._-]+", "label": "Bearer token" }
  ]
}
```

The JSON above is the Phase 2 shape, not a v1 shipping setting.

## Opt-in capture levels

| Level | Collection and storage |
| --- | --- |
| `off` | No collection or persistence; existing data is purged according to policy |
| `metadata` (default) | Raw input may be processed transiently; only counts, measurements, pseudonymous source keys, confidence, inclusion, and lifecycle are stored |
| `redacted-detail` | Same transient processing; redacted derivatives may also be stored for up to 7 days |

Raw prompts, source text, paths, terminal content, and diagnostic lines are never stored.
The adapter sends `sourceIdentity`; the engine persists only an HMAC `sourceKey`.
Diagnostic parsing is a separate opt-in and obeys the same data lifecycle. Retention
and storage caps are defined in [`METRICS.md`](METRICS.md#storage-and-retention).

`contextTop.allowTransientContentProcessing` controls whether bounded raw source buffers
may enter the local Rust process. Default is on: metadata capture may still process
content transiently. Disabling it does not disable metadata collection; it forces
size-based token estimates and may reduce coverage. It never enables persistence. The
settings UI must state that source text can enter the engine process when this is on.

Phase 1 ships one observed candidate signal end-to-end (editor selection) plus
`@contexttop` request snapshots when the participant is invoked. Diagnostic logs remain
blocked.

## Diagnostics validation gate

There is no separate prototyping phase. The honest observation contract above is the
established baseline, and the trusted Rust core (engine, IPC, candidate gauge, request
snapshots, recommendations) is already built. What remains gated is **diagnostic-log
ingestion**, which stays off until every item below is validated by an executable probe
or test in this repository. Documentation of expected behavior does not complete an item.

- [ ] Agent Debug Log **OTLP export** schema validated and field-allowlisted on all target platforms, with pinned VS Code/Copilot versions.
- [ ] Raw Copilot trace-log fallback validated and parser allowlists pinned, where used.
- [ ] Probe run on macOS, Windows, and Linux across 5+ requests.
- [ ] Per-signal Observed / Estimated / Unknown coverage documented.
- [ ] Minimum VS Code and Copilot versions recorded in the [IPC version support matrix](IPC.md#version-support-matrix).
- [ ] Tests prove raw prompts, responses, paths, terminal text, and unknown diagnostic fields never reach persistence or export.

Diagnostic-log ingestion is blocked until this gate is complete. Everything else —
engine, IPC, storage, editor-selection candidate pressure, `@contexttop` snapshots,
tools audit, and instructions audit — proceeds independently.
