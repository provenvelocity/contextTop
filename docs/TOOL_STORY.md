# Tool story: prune the tools you don't use

This is the write-up for contextTop's **tool-efficiency story** — the narrative that turns
the tool-schema measurement into an action ("turn off tools you don't need") — and the
honest limits of doing it **per call**. Every claim below is cross-referenced to the
governing spec so the feature stays consistent with the frozen contracts.

## 1. What the feature is

Tool schemas are one of the largest, least-visible slices of every Copilot request. The
**Story card** (shipped, see [`DASHBOARD.md` §5](DASHBOARD.md#5-the-story-prune-tools-you-dont-use))
makes that concrete:

- **Headline** — `N tools loaded · Xk tokens (~Y% of last request)`.
- **Detail** — which tools Copilot actually invoked this session, and how many loaded
  tools weren't — with the token savings from turning the unused ones off.
- **Ranked list** — biggest **unused** tools first (the clearest cut candidates).
- **Action** — *Manage tools…* opens VS Code's tool configuration, else guides the user
  to the Chat Tools picker.

The motivating finding from real logs: the tools Copilot invoked were built-ins
(`file_search`, `list_dir`, `manage_todo_list`), while the ~24k-token schema load is
almost entirely **extension/MCP tools that were never called** — dead weight per request.

## 2. Where the data comes from (SIGNALS.md)

| Data point | Source | Spec reference |
| --- | --- | --- |
| Loaded tool inventory + per-tool schema cost | `vscode.lm.tools`, costed by serialized name + description + input schema | [`SIGNALS.md` — Tools / MCP collector](SIGNALS.md#implemented-ambient-collectors) |
| MCP tools included in that cost | MCP-registered tools appear in `vscode.lm.tools` | [`SIGNALS.md` — Observed APIs](SIGNALS.md#observed--direct-vs-code-apis) |
| Tools actually invoked this session | `tool_call` span names in the debug log | [`SIGNALS.md` — diagnostic data catalog](SIGNALS.md#experimental-diagnostic-logs-opt-in) |

Per `SIGNALS.md`, loaded-tool inventory is a **candidate** signal (`estimated`,
`direct_api`): *"availability does not imply inclusion."* The Story card honours this — it
says a tool "wasn't called **this session**," never "is never useful."

## 3. How it's classified as a fix (PRODUCT.md)

The tool story is not a new concept; it is the pre-specified fix row in
[`PRODUCT.md` — contextTop Fix](PRODUCT.md#contexttop-fix):

> | Irrelevant tools loaded | Identify tools to unselect | Current agent session | **Guided** unless a supported API permits change |

That fixes three rules for this feature:

- **Proposed, never silently applied.** The card recommends; the user disables tools.
- **Guided classification.** contextTop cannot apply the change itself (see §6); it
  explains and routes.
- **Savings are an estimate, not a promise.** `PRODUCT.md` requires that neither
  acceptance nor application proves savings; verified savings need comparable
  before/after snapshots (same `model_id`, unchanged `unknown_source_count`, delta
  limited to the fix's frozen `targetSourceKeys`).

## 4. How it measures cost (METRICS.md)

- Tools are their own source category — **Tools** (purple), separate from **Tool results**
  (gold) — in [`METRICS.md` — Source categories](METRICS.md#source-categories). Token
  accounting *"keeps source size, tool schemas, and tool results in separate buckets."*
- The `~Y% of last request` figure compares tool tokens to an **observed** request
  `inputTokens`, consistent with [`METRICS.md` — Metric meaning](METRICS.md#metric-meaning):
  tool cost is `estimated` (local tokenizer), request input is `observed` (diagnostic).
- No provider budget percentage is claimed here beyond what
  [`METRICS.md` — Token estimation](METRICS.md#token-estimation) allows.

## 5. How it maps to the engine recommendation path (IPC.md + ARCHITECTURE.md)

The engine is the ranking authority; the adapter renders and routes
([`ARCHITECTURE.md`](ARCHITECTURE.md#rust-engine-responsibilities)). The canonical
recommendation contract already covers this exact action:

- [`IPC.md` — `request.getRecommendations`](IPC.md#requestgetrecommendations) and
  [`response.recommendations`](IPC.md#responserecommendations) define
  `actionKind: "unselect_tools"` with `execution: "guided"`,
  `estimatedTokensSavedMin/Max`, `measurement: "estimated"`, and a frozen
  `targetSourceKeys` scope.
- There is **no `applyFix` RPC** (`IPC.md`); the engine ranks, the adapter guides. Fix
  lifecycle is `proposed → accepted → applied → verified`, with the engine owning
  `fix_proposed`/`fix_verified`.

**Current implementation vs target.** The shipped Story card computes the narrative
**adapter-side** (it joins `vscode.lm.tools` cost with `tool_call` usage in the webview).
That is consistent with the guided classification but does not yet flow through the
engine's `unselect_tools` recommendation. The alignment step (future) is to emit the
Story as a `getRecommendations` item so it gains a `fixId`, `targetSourceKeys`, and the
proposed/accepted/applied/verified lifecycle — with the webview still rendering only
engine view-models (metrics-only `postMessage`, per
[`ARCHITECTURE.md`](ARCHITECTURE.md#vs-code-adapter-responsibilities)).

## 6. Per-call tool toggling: what's actually possible

The ambition — *turn tools off when you don't need them and on when you do, per call,
maybe with AI* — is bounded by the platform and the honesty contract:

- **No programmatic per-call toggle.** `vscode.lm.tools` is read-only
  ([`SIGNALS.md`](SIGNALS.md#observed--direct-vs-code-apis)); there is no API to
  enable/disable another extension's tool for standard Copilot chat. This is why the fix
  is **Guided**, not **Executable**, in `PRODUCT.md`.
- **Standard-chat internals are `unknown`.** contextTop cannot see or edit Copilot's
  request assembly for non-participant chat
  ([`SIGNALS.md` — Not detectable](SIGNALS.md#not-detectable--recorded-as-unknown)), and
  it *"must not claim it can inject arbitrary messages into the built-in Copilot stream"*
  ([`PRODUCT.md`](PRODUCT.md#contexttop-fix)). Copilot already reduces tool bloat
  server-side via *virtual tools* grouping (observed as `debugName: summarizeVirtualTools`).
- **What contextTop can do:** measure cost vs. usage, recommend cuts, and route the user
  to the Tools picker / tool sets (a persisted change, not per-call).
- **AI-assisted (future, recommend-only):** for a prompt routed through `@contexttop`, an
  LLM could propose a minimal tool subset from the visible tool list. Per
  [`SIGNALS.md`](SIGNALS.md#observed--direct-vs-code-apis) the participant sees only its
  own request's prompt/tools, and per `PRODUCT.md` the output stays a **recommendation** —
  the user or a tool set applies it. contextTop never silently mutates Copilot state.

## 7. Consistency checklist

- [x] Loaded tools treated as **candidate**, unused = "this session" only — `SIGNALS.md`.
- [x] Tools costed separately from tool results — `METRICS.md#source-categories`.
- [x] Fix is **Guided**, proposed-never-applied — `PRODUCT.md#contexttop-fix`.
- [x] Maps to `actionKind: "unselect_tools"`, `execution: "guided"` — `IPC.md`.
- [x] Webview stays metrics-only; engine is the ranking authority — `ARCHITECTURE.md`.
- [ ] **Open:** migrate the adapter-side Story to an engine `getRecommendations`
      `unselect_tools` item so it gains a `fixId` and the fix lifecycle.
