# Metrics and timeline contract

## Five-second display windows

The primary live chart uses fixed **five-second windows**. This is the display aggregation, not the raw event resolution.

- Windows are aligned to Unix epoch boundaries: `[t, t + 5s)`.
- Raw events retain millisecond timestamps.
- If a source reports more precise updates, contextTop stores them and recomputes the affected five-second bucket.
- A request marker is never rounded: its timestamp remains exact in the detail view.
- Chart zoom can reveal one-second buckets when sufficient raw evidence exists; otherwise it remains at five seconds.

## Chart design

The bottom panel has one dominant chart rather than many KPI cards:

- **Stacked area:** estimated token composition by source type.
- **Total line:** total request context estimate.
- **Budget line:** selected-model usable context budget, only when known.
- **Request markers:** Send, response, tool call, and completion events.
- **Fix markers:** shows when a fix was proposed and whether it was accepted.

Default view: last 15 minutes. Time ranges: 1 minute, 15 minutes, 1 hour, and current session.

## Source categories

| Category | Examples |
|---|---|
| Prompt | User prompt and explicit instructions |
| Selection | Selected editor text and open document contribution |
| Files | Attached/referenced workspace files |
| Terminal | Command text and eligible output |
| History | Prior chat turns or generated handoff summary |
| Tools | Tool definitions, schemas, and enabled-tool inventory |
| Tool results | Returned content from tool calls |
| Retrieval | Workspace/search retrieval when evidence is available |
| Unknown | Provider-side or opaque context not observable to contextTop |

## Confidence

Every bucket and source carries one confidence level:

- `observed`: directly reported by a supported VS Code/Copilot diagnostic signal.
- `estimated`: calculated from available local content with the configured tokenizer.
- `partial`: only a subset of the source is observed.
- `unknown`: the product knows a context class may exist but cannot quantify it.

## Event model

```text
ContextEvent
  timestamp_ms
  session_id
  request_id?
  event_kind: source_changed | request_started | request_sent | response_started |
              tool_started | tool_finished | request_completed | fix_proposed | fix_applied
  source_kind?
  token_count?
  confidence
  source_fingerprint?
  metadata_redacted
```

Five-second buckets are derived data:

```text
ContextBucket
  window_start_ms
  session_id
  token_total_estimated
  token_by_source_kind
  confidence_summary
  request_ids
  fix_ids
```

## Token estimation

Use a model-specific tokenizer when the selected model and tokenizer are available. Otherwise use a conservative approximation and expose it as estimated. Token accounting must include source size, tool schemas, and tool results separately: hiding tool definitions inside a generic "other" bucket defeats the product's purpose.
