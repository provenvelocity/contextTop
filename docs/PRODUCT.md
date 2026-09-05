# Product specification

## Problem

GitHub Copilot requests can quietly accumulate costly context: files, selections, terminal output, prior turns, tools, tool schemas, tool results, and retrieval. Developers cannot see the composition, know which source mattered, or make a targeted reduction before sending a request.

## Product promise

For every detectable Copilot request window, contextTop answers:

1. How much context is being used right now?
2. Which sources account for that context?
3. Which values were observed versus estimated?
4. What is the smallest safe action that will reduce the request?

## Surfaces

### contextTop Fix bottom panel

Contributed to the VS Code panel area alongside Problems, Output, Debug Console, and Terminal.

- **Live timeline:** a stacked area/line chart, aggregated into five-second windows by default.
- **Request lane:** vertical markers for detected request start, request sent, response start, and completion.
- **Breakdown:** files, selection, prompt, terminal output, history, tools, tool results, and retrieval.
- **Details on hover:** window time, total estimated tokens, source breakdown, confidence, and request correlation ID.
- **Fix queue:** ranked reversible actions with expected tokens saved.

### Status bar

Shows compact current pressure: `Context 18.4k est. · 74% · Fix`.

It shifts from neutral to warning only at configured thresholds and opens the bottom panel on activation.

### Copilot Chat

contextTop provides `@contexttop /fix` for high-fidelity preflight and streamed guidance on requests routed through the participant. For standard GitHub Copilot conversations, the extension must not claim it can inject arbitrary messages into the built-in Copilot stream; it uses the status bar and bottom panel unless a supported API provides a native in-stream integration.

## contextTop Fix

Fixes are proposed, never silently applied. Every fix states scope, evidence, expected savings, and reversibility.

| Trigger | Fix | Scope |
|---|---|---|
| Large terminal output | Create a redacted focused summary | Current request |
| Long chat history | Generate a concise handoff and start a clean chat | New chat |
| Generated files dominate | Propose context exclusion rules | Workspace settings, preview first |
| Irrelevant tools loaded | Disable or unselect relevant tools | Current agent session where supported |
| Large attachment set | Identify detachable files | Current request |

## Privacy defaults

- Local-only storage.
- Store source metadata and counts; do not store raw prompts, source text, terminal content, or secrets by default.
- Redact secrets before any optional detailed local capture or team export.
- Team export is opt-in and sends aggregate metrics by default.
- Splunk export uses a configurable HTTP Event Collector endpoint and never sends raw context unless enterprise policy explicitly permits it.
