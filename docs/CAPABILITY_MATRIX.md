# Capability Matrix

This is the Phase 0 observation contract. Entries are evidence-based and must be updated with recorded probe output rather than assumed from product intent.

| Signal | macOS | Windows | Linux | Confidence when available | v1 fallback |
|---|---|---|---|---|---|
| Active editor and selection | Probe required | Probe required | Probe required | observed by VS Code adapter | unknown |
| Workspace file metadata | Probe required | Probe required | Probe required | observed by VS Code adapter | unknown |
| Terminal command and eligible output | Probe required | Probe required | Probe required | observed or partial | unknown |
| Chat participant request | Supported API to verify | Supported API to verify | Supported API to verify | observed for `@contexttop` | unavailable for built-in chat |
| Tool inventory and schemas | Probe required | Probe required | Probe required | observed or partial | unknown |
| Tool results | Probe required | Probe required | Probe required | observed or partial | unknown |
| Copilot request lifecycle diagnostics | Optional trace setting to verify | Optional trace setting to verify | Optional trace setting to verify | observed only when directly reported | unknown |
| Model identity and usable context budget | Probe required | Probe required | Probe required | observed only when reported | show estimate without percentage |

## Evidence rules

- `observed` means a supported active signal directly reported the value to contextTop.
- `estimated` means contextTop calculated it from locally available content.
- `partial` means only a subset of the source or lifecycle was available.
- `unknown` means the product knows the class may exist but cannot quantify it.
- No opaque Copilot context is promoted from unknown to observed through heuristics.

## Phase 0 fixture

The first redacted event fixture is [sample-events.jsonl](fixtures/sample-events.jsonl). It contains no prompt, source text, terminal output, or secret material.
