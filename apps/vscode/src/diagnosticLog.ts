import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EngineClient } from './engineClient';
import { CopilotAnalyticsAccumulator, CopilotAnalyticsSnapshot } from './copilotAnalytics';

/** Observed per-request metrics parsed from a Copilot `llm_request` span. */
export interface CopilotRequestMetrics {
  inputTokens: number;
  outputTokens?: number;
  cachedTokens?: number;
  maxTokens?: number;
  model?: string;
  latencyMs?: number;
  ts: number;
  /** Time to first token (ms), observed from the span. */
  ttftMs?: number;
  /** Number of messages in the request payload (`requestShape.messageCount`). */
  messageCount?: number;
  /** Internal operation name (`debugName`), e.g. `summarizeVirtualTools`. */
  debugName?: string;
  /** Estimated tokens for the system prompt sidecar (`systemPromptFile`). */
  systemPromptTokens?: number;
  /** Estimated tokens for the tool-schema sidecar (`toolsFile`). */
  toolsTokens?: number;
  /** Estimated tokens for the user prompt (`userRequest`). */
  userPromptTokens?: number;
  /** Model's full context window from `models.json` capabilities. */
  contextWindowTokens?: number;
  /** Model's usable prompt budget from `models.json` capabilities. */
  promptBudgetTokens?: number;
  /** Sampling temperature requested (`attrs.temperature`). */
  temperature?: number;
  /** Nucleus sampling parameter (`attrs.topP`). */
  topP?: number;
  /** Copilot billing units for the request (`attrs.copilotUsageNanoAiu`). */
  usageNanoAiu?: number;
  /** Provider response id (`attrs.responseId`) — request correlation key. */
  responseId?: string;
}

/** Rough token estimate matching the engine's ~4 bytes/token fallback. */
function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/**
 * Tails the current window's GitHub Copilot Chat logs and turns real agent activity into
 * candidate observations, so the dashboard moves as Copilot works.
 *
 * Two signals are parsed:
 *  - `GitHub Copilot Chat Hooks.log` — one `PostToolUse` event per agent tool call;
 *    the returned `tool_response` bytes are ingested as `tool_results` (estimated).
 *  - `GitHub Copilot Chat.log` — `Summarization usage: prompt=…, completion=…` lines,
 *    which are provider-reported (observed) token counts, ingested as `history`.
 *
 * This is the opt-in diagnostic tier (`contextTop.enableDiagnosticLogs`). The adapter
 * never persists raw log content; it derives sizes/counts and sends bounded observations.
 */
export class DiagnosticLogTailer {
  private timer?: NodeJS.Timeout;
  private offsets = new Map<string, number>();
  private carry = new Map<string, string>();
  private copilotDir: string;
  private hooksLog: string;
  private chatLog: string;
  private otlpSeen = new Map<string, number>();
  private debugLogsDir: string;
  private activeMainLog?: string;
  private activeSessionDir?: string;
  /** Estimated tokens per sidecar file, keyed by `absolutePath:size`. */
  private sidecarTokenCache = new Map<string, number>();
  /** Model id → context/budget limits, keyed per session dir. */
  private modelLimits = new Map<string, { contextWindowTokens?: number; promptBudgetTokens?: number }>();
  private modelLimitsDir?: string;
  private analytics = new CopilotAnalyticsAccumulator();

  constructor(
    private engine: EngineClient,
    logDir: string,
    globalStorageDir: string,
    private output: vscode.OutputChannel,
    private onRequest?: (r: CopilotRequestMetrics) => void,
    private onAnalytics?: (stats: CopilotAnalyticsSnapshot) => void
  ) {
    // contextTop's own log dir sits under `.../exthost/<ext-id>`; Copilot's is a sibling.
    const exthost = path.dirname(logDir);
    this.copilotDir = path.join(exthost, 'GitHub.copilot-chat');
    this.hooksLog = path.join(this.copilotDir, 'GitHub Copilot Chat Hooks.log');
    this.chatLog = path.join(this.copilotDir, 'GitHub Copilot Chat.log');
    // Structured per-session debug logs live in a sibling of contextTop's globalStorage.
    this.debugLogsDir = path.join(path.dirname(globalStorageDir), 'github.copilot-chat', 'debug-logs');
  }

  start(): void {
    this.output.appendLine(`[diag] tailing ${this.hooksLog}`);
    this.output.appendLine(`[diag] tailing ${this.chatLog}`);
    this.output.appendLine(`[diag] debug-logs dir: ${this.debugLogsDir}`);
    // Start at end-of-file so we only report activity from now on.
    this.offsets.set(this.hooksLog, this.fileSize(this.hooksLog));
    this.offsets.set(this.chatLog, this.fileSize(this.chatLog));
    this.poll();
    this.timer = setInterval(() => this.poll(), 1000);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private fileSize(file: string): number {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  private poll(): void {
    this.readAppended(this.hooksLog, (line) => this.parseHooksLine(line));
    this.readAppended(this.chatLog, (line) => this.parseChatLine(line));
    this.pollDebugMainLog();
    this.discoverOtlp();
  }

  /** Tail the newest debug-logs session's `main.jsonl` for real per-request token usage. */
  private pollDebugMainLog(): void {
    const main = this.newestMainLog();
    if (!main) {
      return;
    }
    if (main !== this.activeMainLog) {
      // A new chat session started. Backfill its bounded, metadata-only statistics,
      // then continue tailing from EOF. Raw messages/tool payloads are never retained.
      this.activeMainLog = main;
      this.activeSessionDir = path.dirname(main);
      this.analytics.reset();
      this.offsets.set(main, 0);
      this.carry.set(main, '');
      this.output.appendLine(`[diag] tailing session log ${main}`);
    }
    this.readAppended(main, (line) => this.parseMainSpan(line));
  }

  /** Newest session folder's main.jsonl, or undefined. */
  private newestMainLog(): string | undefined {
    let sessions: string[];
    try {
      sessions = fs.readdirSync(this.debugLogsDir);
    } catch {
      return undefined;
    }
    let best: { file: string; mtime: number } | undefined;
    for (const s of sessions) {
      const main = path.join(this.debugLogsDir, s, 'main.jsonl');
      try {
        const st = fs.statSync(main);
        if (!best || st.mtimeMs > best.mtime) {
          best = { file: main, mtime: st.mtimeMs };
        }
      } catch {
        /* not a session dir */
      }
    }
    return best?.file;
  }

  /**
   * Parse one OTLP span from `main.jsonl`. The `llm_request` span carries the real
   * observed token usage for a Copilot request: `inputTokens` is the full context sent
   * to the model, `maxTokens` the model's limit, plus `outputTokens`/`cachedTokens`.
   */
  private parseMainSpan(line: string): void {
    let span: any;
    try {
      span = JSON.parse(line);
    } catch {
      return;
    }
    this.analytics.observe(span);
    this.onAnalytics?.(this.analytics.snapshot());
    if (span?.type !== 'llm_request') {
      return;
    }
    const a = span.attrs || {};
    const input = typeof a.inputTokens === 'number' ? a.inputTokens : undefined;
    if (input === undefined || input <= 0) {
      return;
    }
    const model = typeof a.model === 'string' ? a.model : 'model';
    const latencyMs = typeof span.dur === 'number' ? span.dur : undefined;
    this.output.appendLine(
      `[diag] llm_request ${model}: input=${input} output=${a.outputTokens ?? '?'} cached=${a.cachedTokens ?? '?'} max=${a.maxTokens ?? '?'} dur=${latencyMs ?? '?'}ms`
    );

    // Sidecar decomposition: attribute the opaque inputTokens to system prompt, tool
    // schemas, and user prompt using the files the span references. Buffers are read,
    // tokenized, and dropped — never persisted.
    const systemPromptTokens =
      typeof a.systemPromptFile === 'string' ? this.sidecarTokens(a.systemPromptFile) : undefined;
    const toolsTokens = typeof a.toolsFile === 'string' ? this.sidecarTokens(a.toolsFile) : undefined;
    const userPromptTokens = typeof a.userRequest === 'string' ? estimateTokens(a.userRequest) : undefined;
    const limits = this.modelLimitsFor(model);
    const messageCount =
      a.requestShape && typeof a.requestShape === 'object' && typeof a.requestShape.messageCount === 'number'
        ? a.requestShape.messageCount
        : undefined;

    // Surface full request metrics to the panel (cache hit %, latency, model).
    if (this.onRequest) {
      this.onRequest({
        inputTokens: input,
        outputTokens: typeof a.outputTokens === 'number' ? a.outputTokens : undefined,
        cachedTokens: typeof a.cachedTokens === 'number' ? a.cachedTokens : undefined,
        maxTokens: typeof a.maxTokens === 'number' ? a.maxTokens : undefined,
        model: typeof a.model === 'string' ? a.model : undefined,
        latencyMs,
        ts: typeof span.ts === 'number' ? span.ts : Date.now(),
        ttftMs: typeof a.ttft === 'number' ? a.ttft : undefined,
        messageCount,
        debugName: typeof a.debugName === 'string' ? a.debugName : undefined,
        systemPromptTokens,
        toolsTokens,
        userPromptTokens,
        contextWindowTokens: limits?.contextWindowTokens,
        promptBudgetTokens: limits?.promptBudgetTokens,
        temperature: typeof a.temperature === 'number' ? a.temperature : undefined,
        topP: typeof a.topP === 'number' ? a.topP : undefined,
        usageNanoAiu: typeof a.copilotUsageNanoAiu === 'number' ? a.copilotUsageNanoAiu : undefined,
        responseId: typeof a.responseId === 'string' ? a.responseId : undefined,
      });
    }

    // The observed request context — the real number the product exists to show.
    this.engine
      .request('request.ingestObservation', {
        sourceIdentity: 'copilot:observed-request',
        // Mark this as an observed request measurement so it is not treated as a
        // candidate prompt source (avoids inflating candidate pressure charts).
        sourceKind: 'observed_request',
        observed: { tokenCount: input },
        coverage: 'complete',
        provenance: 'diagnostic',
      })
      .catch((err) => this.output.appendLine(`[diag] ingest request context failed: ${err.message}`));
  }

  /**
   * Estimate the token cost of a sidecar file (`system_prompt_N.json`, `tools_0.json`)
   * referenced by an `llm_request` span. The file wraps the real text as `{ content }`.
   * Read, tokenize, drop — the raw buffer is never persisted. Cached by path+size.
   */
  private sidecarTokens(fileName: string): number | undefined {
    if (!this.activeSessionDir) {
      return undefined;
    }
    // Only accept plain sidecar file names within the session dir; never traverse out.
    const base = path.basename(fileName);
    if (base !== fileName) {
      return undefined;
    }
    const file = path.join(this.activeSessionDir, base);
    const size = this.fileSize(file);
    if (size === 0) {
      return undefined;
    }
    const key = `${file}:${size}`;
    const cached = this.sidecarTokenCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let raw: string;
    try {
      const bounded = Math.min(size, 8 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(bounded);
      fs.readSync(fd, buf, 0, bounded, 0);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
    } catch (err) {
      this.output.appendLine(`[diag] sidecar read failed ${base}: ${err}`);
      return undefined;
    }
    let content: unknown;
    try {
      content = JSON.parse(raw)?.content;
    } catch {
      return undefined;
    }
    const text = typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content);
    if (!text) {
      return undefined;
    }
    const tokens = estimateTokens(text);
    this.sidecarTokenCache.set(key, tokens);
    return tokens;
  }

  /** Look up a model's context/prompt limits from the session's `models.json`. */
  private modelLimitsFor(model: string): { contextWindowTokens?: number; promptBudgetTokens?: number } | undefined {
    if (!this.activeSessionDir) {
      return undefined;
    }
    if (this.modelLimitsDir !== this.activeSessionDir) {
      this.modelLimits.clear();
      this.modelLimitsDir = this.activeSessionDir;
      this.loadModelLimits(this.activeSessionDir);
    }
    return this.modelLimits.get(model);
  }

  /** Parse `models.json` once per session into an id → limits map. */
  private loadModelLimits(sessionDir: string): void {
    const file = path.join(sessionDir, 'models.json');
    let models: unknown;
    try {
      models = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(models)) {
      return;
    }
    for (const m of models) {
      const id = m?.id;
      const limits = m?.capabilities?.limits;
      if (typeof id === 'string' && limits && typeof limits === 'object') {
        this.modelLimits.set(id, {
          contextWindowTokens:
            typeof limits.max_context_window_tokens === 'number' ? limits.max_context_window_tokens : undefined,
          promptBudgetTokens: typeof limits.max_prompt_tokens === 'number' ? limits.max_prompt_tokens : undefined,
        });
      }
    }
    this.output.appendLine(`[diag] loaded ${this.modelLimits.size} model limits from models.json`);
  }

  /** Read bytes appended since the last poll and hand each complete line to `onLine`. */
  private readAppended(file: string, onLine: (line: string) => void): void {
    const size = this.fileSize(file);
    const prev = this.offsets.get(file) ?? 0;
    if (size < prev) {
      // File rotated/truncated; restart from the beginning.
      this.offsets.set(file, 0);
      this.carry.set(file, '');
      return;
    }
    if (size === prev) {
      return;
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const len = size - prev;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, prev);
      this.offsets.set(file, size);
      const text = (this.carry.get(file) ?? '') + buf.toString('utf8');
      const lines = text.split('\n');
      this.carry.set(file, lines.pop() ?? '');
      for (const line of lines) {
        if (line) {
          onLine(line);
        }
      }
    } catch (err) {
      this.output.appendLine(`[diag] read failed for ${path.basename(file)}: ${err}`);
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }

  /** `PostToolUse] Input: { … tool_name, tool_response … }` → a `tool_results` observation. */
  private parseHooksLine(line: string): void {
    const marker = 'Input: ';
    const idx = line.indexOf('PostToolUse] ' + marker);
    if (idx === -1) {
      return;
    }
    const jsonStart = line.indexOf('{', idx);
    if (jsonStart === -1) {
      return;
    }
    let evt: any;
    try {
      evt = JSON.parse(line.slice(jsonStart));
    } catch {
      return;
    }
    const toolName = typeof evt.tool_name === 'string' ? evt.tool_name : 'unknown';
    const toolUseId = typeof evt.tool_use_id === 'string' ? evt.tool_use_id : `${toolName}:${Date.now()}`;
    const response = typeof evt.tool_response === 'string' ? evt.tool_response : '';
    const byteLen = Buffer.byteLength(response, 'utf8');
    if (byteLen === 0) {
      return;
    }
    this.engine
      .request('request.ingestObservation', {
        sourceIdentity: `toolresult:${toolUseId}`,
        sourceKind: 'tool_results',
        observed: { byteLen },
        coverage: 'complete',
        provenance: 'diagnostic',
      })
      .catch((err) => this.output.appendLine(`[diag] ingest tool_results failed: ${err.message}`));
  }

  /** `Summarization usage: prompt=N, cached=N, completion=N` → an observed `history` count. */
  private parseChatLine(line: string): void {
    const m = /Summarization usage:\s*prompt=(\d+),\s*cached=(\d+),\s*completion=(\d+)/.exec(line);
    if (!m) {
      return;
    }
    const prompt = parseInt(m[1], 10);
    this.engine
      .request('request.ingestObservation', {
        sourceIdentity: 'history:summarization',
        sourceKind: 'history',
        observed: { tokenCount: prompt },
        coverage: 'complete',
        provenance: 'diagnostic',
      })
      .catch((err) => this.output.appendLine(`[diag] ingest history failed: ${err.message}`));
  }

  /**
   * Discover Copilot Agent Debug Log (OTLP) files that appear once the user enables
   * `github.copilot.chat.agentDebugLog.fileLogging.enabled`, and extract token usage.
   * The exact schema is validated defensively: we walk the JSON for well-known token
   * fields and log unrecognized structure so the parser can be finalized against a real
   * sample. Nothing is ingested unless a clearly-named token count is found.
   */
  private discoverOtlp(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.copilotDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'GitHub Copilot Chat Hooks.log' || name === 'GitHub Copilot Chat.log') {
        continue;
      }
      if (!/\.(json|otlp|log)$/i.test(name)) {
        continue;
      }
      const file = path.join(this.copilotDir, name);
      const size = this.fileSize(file);
      const prev = this.otlpSeen.get(file);
      if (prev === size) {
        continue;
      }
      this.otlpSeen.set(file, size);
      this.handleOtlpFile(file);
    }
  }

  private handleOtlpFile(file: string): void {
    let text: string;
    try {
      // Bounded read; OTLP session records are modest.
      const size = Math.min(this.fileSize(file), 8 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch (err) {
      this.output.appendLine(`[diag][otlp] read failed ${path.basename(file)}: ${err}`);
      return;
    }

    // OTLP may be one JSON object or newline-delimited JSON. Try both.
    const records: any[] = [];
    try {
      records.push(JSON.parse(text));
    } catch {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) {
          continue;
        }
        try {
          records.push(JSON.parse(t));
        } catch {
          /* ignore non-JSON lines */
        }
      }
    }
    if (records.length === 0) {
      return;
    }

    this.output.appendLine(`[diag][otlp] ${path.basename(file)}: ${records.length} record(s); top keys: ${Object.keys(records[0] || {}).join(', ')}`);

    for (const rec of records) {
      const usage = this.findTokenUsage(rec);
      if (usage) {
        this.output.appendLine(`[diag][otlp] usage prompt=${usage.prompt} completion=${usage.completion} total=${usage.total}`);
        if (usage.prompt && usage.prompt > 0) {
          this.engine
            .request('request.ingestObservation', {
              sourceIdentity: `otlp:observed-request:${usage.requestId ?? Date.now()}`,
              sourceKind: 'observed_request',
              observed: { tokenCount: usage.prompt },
              coverage: 'complete',
              provenance: 'diagnostic',
            })
            .catch((err) => this.output.appendLine(`[diag][otlp] ingest failed: ${err.message}`));
        }
      }
    }
  }

  /** Defensively walk an OTLP record for well-known token-usage fields. */
  private findTokenUsage(
    root: any
  ): { prompt?: number; completion?: number; total?: number; requestId?: string } | undefined {
    let found: { prompt?: number; completion?: number; total?: number; requestId?: string } | undefined;
    const visit = (node: any, depth: number) => {
      if (!node || typeof node !== 'object' || depth > 8) {
        return;
      }
      for (const key of Object.keys(node)) {
        const val = node[key];
        const k = key.toLowerCase();
        if (typeof val === 'number') {
          if (/(prompt|input).*tokens?|tokens?.*(prompt|input)/.test(k)) {
            found = found ?? {};
            found.prompt = val;
          } else if (/(completion|output).*tokens?|tokens?.*(completion|output)/.test(k)) {
            found = found ?? {};
            found.completion = val;
          } else if (/total.*tokens?|tokens?.*total/.test(k)) {
            found = found ?? {};
            found.total = val;
          }
        } else if (typeof val === 'string' && /request.?id/.test(k)) {
          found = found ?? {};
          found.requestId = val;
        } else if (val && typeof val === 'object') {
          visit(val, depth + 1);
        }
      }
    };
    visit(root, 0);
    return found;
  }
}
