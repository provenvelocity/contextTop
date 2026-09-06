export interface Distribution {
  count: number;
  min: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  stdDev: number;
}

export interface BreakdownRow {
  name: string;
  count: number;
  errorCount: number;
  p50LatencyMs?: number;
}

export interface CoverageItem {
  metric: string;
  state: 'observed' | 'unknown';
  reason: string;
}

/** Counts of context sources Copilot resolved during discovery (hidden context pressure). */
export interface DiscoveryCounts {
  agents?: number;
  instructions?: number;
  slashCommands?: number;
  skills?: number;
  hooks?: number;
  /** Resolve latency (ms) per category, parsed from the discovery span text. */
  latencyMs?: { agents?: number; instructions?: number; slashCommands?: number; skills?: number; hooks?: number };
}

/** Environment reported by the `session_start` span. */
export interface EnvironmentInfo {
  copilotVersion?: string;
  vscodeVersion?: string;
}

export interface CopilotAnalyticsSnapshot {
  scope: 'current_session';
  sampleLimit: number;
  eventCount: number;
  sessionCount: number;
  turnCount: number;
  requestCount: number;
  requestSuccesses: number;
  requestFailures: number;
  requestCancellations: number;
  requestUnknownOutcomes: number;
  explicitRetries: number;
  toolCallCount: number;
  toolFailureCount: number;
  sessionDurationMs: number;
  requestLatencyMs?: Distribution;
  ttftMs?: Distribution;
  inputTokens?: Distribution;
  outputTokens?: Distribution;
  cachedTokens?: Distribution;
  uncachedTokens?: Distribution;
  cacheHitRatio?: Distribution;
  contextChangeTokens?: Distribution;
  turnDurationMs?: Distribution;
  requestsPerTurn?: Distribution;
  toolCallsPerTurn?: Distribution;
  environment: EnvironmentInfo;
  discovery: DiscoveryCounts;
  models: BreakdownRow[];
  operations: BreakdownRow[];
  tools: BreakdownRow[];
  errors: Array<{ category: string; count: number }>;
  inputLatencyCorrelation?: { sampleSize: number; pearsonR: number };
  anomalies: string[];
  coverage: CoverageItem[];
}

interface SpanLike {
  ts?: unknown;
  dur?: unknown;
  type?: unknown;
  name?: unknown;
  status?: unknown;
  attrs?: unknown;
}

interface NamedSamples {
  count: number;
  errors: number;
  latencies: number[];
}

const SAMPLE_LIMIT = 500;

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function appendBounded(values: number[], value: number): void {
  values.push(value);
  if (values.length > SAMPLE_LIMIT) {
    values.shift();
  }
}

function percentile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function distribution(values: readonly number[]): Distribution | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean,
    stdDev: Math.sqrt(variance),
  };
}

function pearson(xs: readonly number[], ys: readonly number[]): number | undefined {
  if (xs.length < 3 || xs.length !== ys.length) {
    return undefined;
  }
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (let i = 0; i < xs.length; i++) {
    const xd = xs[i] - xMean;
    const yd = ys[i] - yMean;
    covariance += xd * yd;
    xVariance += xd * xd;
    yVariance += yd * yd;
  }
  if (xVariance === 0 || yVariance === 0) {
    return undefined;
  }
  return covariance / Math.sqrt(xVariance * yVariance);
}

function outcome(span: SpanLike): 'success' | 'failure' | 'cancelled' | 'unknown' {
  const status = typeof span.status === 'string' ? span.status.toLowerCase() : '';
  const attrs = span.attrs && typeof span.attrs === 'object' ? span.attrs as Record<string, unknown> : {};
  const code = [attrs.errorType, attrs.errorCode, attrs.finishReason]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (status.includes('cancel') || code.includes('cancel')) {
    return 'cancelled';
  }
  if (status === 'ok' || status === 'success') {
    return 'success';
  }
  if (status === 'error' || status === 'failed' || status === 'failure') {
    return 'failure';
  }
  return 'unknown';
}

function errorCategory(span: SpanLike): string {
  const attrs = span.attrs && typeof span.attrs === 'object' ? span.attrs as Record<string, unknown> : {};
  const text = [attrs.errorType, attrs.errorCode, attrs.finishReason]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (text.includes('cancel')) return 'cancelled';
  if (text.includes('timeout') || text.includes('deadline')) return 'timeout';
  if (text.includes('429') || text.includes('rate') || text.includes('quota')) return 'rate_limit';
  if (text.includes('401') || text.includes('403') || text.includes('auth')) return 'authentication';
  if (text.includes('network') || text.includes('socket') || text.includes('connect')) return 'network';
  if (text.includes('context') || text.includes('token') || text.includes('length')) return 'context_limit';
  if (span.type === 'tool_call') return 'tool';
  if (span.type === 'llm_request') return 'model';
  return 'other';
}

export class CopilotAnalyticsAccumulator {
  private eventCount = 0;
  private sessionCount = 0;
  private turnCount = 0;
  private requestCount = 0;
  private requestSuccesses = 0;
  private requestFailures = 0;
  private requestCancellations = 0;
  private requestUnknownOutcomes = 0;
  private explicitRetries = 0;
  private toolCallCount = 0;
  private toolFailureCount = 0;
  private firstTs?: number;
  private lastTs?: number;
  private requestLatencies: number[] = [];
  private ttfts: number[] = [];
  private inputs: number[] = [];
  private outputs: number[] = [];
  private cached: number[] = [];
  private uncached: number[] = [];
  private cacheRatios: number[] = [];
  private contextChanges: number[] = [];
  private previousInput?: number;
  private inputLatencyPairs: Array<[number, number]> = [];
  private models = new Map<string, NamedSamples>();
  private operations = new Map<string, NamedSamples>();
  private tools = new Map<string, NamedSamples>();
  private errors = new Map<string, number>();
  private turnDurations: number[] = [];
  private requestsPerTurn: number[] = [];
  private toolCallsPerTurn: number[] = [];
  private openTurns = new Map<string, number>();
  private currentTurnRequests = 0;
  private currentTurnTools = 0;
  private environment: EnvironmentInfo = {};
  private discovery: DiscoveryCounts = {};

  reset(): void {
    this.eventCount = 0;
    this.sessionCount = 0;
    this.turnCount = 0;
    this.requestCount = 0;
    this.requestSuccesses = 0;
    this.requestFailures = 0;
    this.requestCancellations = 0;
    this.requestUnknownOutcomes = 0;
    this.explicitRetries = 0;
    this.toolCallCount = 0;
    this.toolFailureCount = 0;
    this.firstTs = undefined;
    this.lastTs = undefined;
    this.requestLatencies = [];
    this.ttfts = [];
    this.inputs = [];
    this.outputs = [];
    this.cached = [];
    this.uncached = [];
    this.cacheRatios = [];
    this.contextChanges = [];
    this.previousInput = undefined;
    this.inputLatencyPairs = [];
    this.models.clear();
    this.operations.clear();
    this.tools.clear();
    this.errors.clear();
    this.turnDurations = [];
    this.requestsPerTurn = [];
    this.toolCallsPerTurn = [];
    this.openTurns.clear();
    this.currentTurnRequests = 0;
    this.currentTurnTools = 0;
    this.environment = {};
    this.discovery = {};
  }

  observe(span: SpanLike): void {
    this.eventCount += 1;
    const ts = finite(span.ts);
    if (ts !== undefined) {
      this.firstTs = this.firstTs === undefined ? ts : Math.min(this.firstTs, ts);
      this.lastTs = this.lastTs === undefined ? ts : Math.max(this.lastTs, ts);
    }
    const type = typeof span.type === 'string' ? span.type : '';
    const attrs = span.attrs && typeof span.attrs === 'object' ? (span.attrs as Record<string, unknown>) : {};
    if (type === 'session_start') {
      this.sessionCount += 1;
      if (typeof attrs.copilotVersion === 'string') this.environment.copilotVersion = attrs.copilotVersion;
      if (typeof attrs.vscodeVersion === 'string') this.environment.vscodeVersion = attrs.vscodeVersion;
      return;
    }
    if (type === 'discovery') {
      this.observeDiscovery(attrs);
      return;
    }
    if (type === 'turn_start') {
      this.turnCount += 1;
      this.currentTurnRequests = 0;
      this.currentTurnTools = 0;
      const turnId = typeof attrs.turnId === 'string' ? attrs.turnId : undefined;
      if (turnId !== undefined && ts !== undefined) this.openTurns.set(turnId, ts);
      return;
    }
    if (type === 'turn_end') {
      const turnId = typeof attrs.turnId === 'string' ? attrs.turnId : undefined;
      const start = turnId !== undefined ? this.openTurns.get(turnId) : undefined;
      if (start !== undefined && ts !== undefined && ts >= start) appendBounded(this.turnDurations, ts - start);
      if (turnId !== undefined) this.openTurns.delete(turnId);
      appendBounded(this.requestsPerTurn, this.currentTurnRequests);
      appendBounded(this.toolCallsPerTurn, this.currentTurnTools);
      return;
    }
    if (type === 'llm_request') {
      this.observeRequest(span);
      return;
    }
    if (type === 'tool_call') {
      this.observeTool(span);
    }
  }

  /** Parse a `discovery` span's `details` string, e.g. "Resolved 14 agents in 607ms | …". */
  private observeDiscovery(attrs: Record<string, unknown>): void {
    const details = typeof attrs.details === 'string' ? attrs.details : '';
    const m = /Resolved\s+(\d+)\s+([a-z]+)(?:.*?in\s+([\d.]+)ms)?/i.exec(details);
    if (!m) return;
    const count = parseInt(m[1], 10);
    const noun = m[2].toLowerCase();
    const ms = m[3] !== undefined ? Math.round(parseFloat(m[3])) : undefined;
    const latency = (this.discovery.latencyMs = this.discovery.latencyMs ?? {});
    if (noun.startsWith('agent')) { this.discovery.agents = count; if (ms !== undefined) latency.agents = ms; }
    else if (noun.startsWith('instruction')) { this.discovery.instructions = count; if (ms !== undefined) latency.instructions = ms; }
    else if (noun.startsWith('slash')) { this.discovery.slashCommands = count; if (ms !== undefined) latency.slashCommands = ms; }
    else if (noun.startsWith('skill')) { this.discovery.skills = count; if (ms !== undefined) latency.skills = ms; }
    else if (noun.startsWith('hook')) { this.discovery.hooks = count; if (ms !== undefined) latency.hooks = ms; }
  }

  snapshot(): CopilotAnalyticsSnapshot {
    const correlation = pearson(
      this.inputLatencyPairs.map(([input]) => input),
      this.inputLatencyPairs.map(([, latency]) => latency)
    );
    const latency = distribution(this.requestLatencies);
    const input = distribution(this.inputs);
    const anomalies: string[] = [];
    if (latency && latency.count >= 20 && latency.max > latency.mean + 2 * latency.stdDev) {
      anomalies.push(`Slowest request was ${Math.round(latency.max)} ms, above mean + 2σ (${Math.round(latency.mean + 2 * latency.stdDev)} ms).`);
    }
    if (this.requestFailures > 0 || this.toolFailureCount > 0) {
      anomalies.push(`${this.requestFailures + this.toolFailureCount} recorded request/tool failures require investigation.`);
    }
    if (this.requestCount > 0 && this.cached.length === this.requestCount) {
      const ratios = distribution(this.cacheRatios);
      if (ratios && ratios.min < 0.2 && ratios.max > 0.9) {
        anomalies.push('Cache-hit ratio varies sharply across requests (below 20% to above 90%).');
      }
    }

    return {
      scope: 'current_session',
      sampleLimit: SAMPLE_LIMIT,
      eventCount: this.eventCount,
      sessionCount: this.sessionCount,
      turnCount: this.turnCount,
      requestCount: this.requestCount,
      requestSuccesses: this.requestSuccesses,
      requestFailures: this.requestFailures,
      requestCancellations: this.requestCancellations,
      requestUnknownOutcomes: this.requestUnknownOutcomes,
      explicitRetries: this.explicitRetries,
      toolCallCount: this.toolCallCount,
      toolFailureCount: this.toolFailureCount,
      sessionDurationMs: this.firstTs === undefined || this.lastTs === undefined ? 0 : this.lastTs - this.firstTs,
      requestLatencyMs: latency,
      ttftMs: distribution(this.ttfts),
      inputTokens: input,
      outputTokens: distribution(this.outputs),
      cachedTokens: distribution(this.cached),
      uncachedTokens: distribution(this.uncached),
      cacheHitRatio: distribution(this.cacheRatios),
      contextChangeTokens: distribution(this.contextChanges),
      turnDurationMs: distribution(this.turnDurations),
      requestsPerTurn: distribution(this.requestsPerTurn),
      toolCallsPerTurn: distribution(this.toolCallsPerTurn),
      environment: { ...this.environment },
      discovery: { ...this.discovery },
      models: this.breakdown(this.models),
      operations: this.breakdown(this.operations),
      tools: this.breakdown(this.tools),
      errors: [...this.errors.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      inputLatencyCorrelation: correlation === undefined ? undefined : {
        sampleSize: this.inputLatencyPairs.length,
        pearsonR: correlation,
      },
      anomalies,
      coverage: [
        { metric: 'Request outcome', state: 'observed', reason: 'Span status' },
        { metric: 'Request latency', state: 'observed', reason: 'Span duration' },
        { metric: 'Time to first token', state: this.ttfts.length ? 'observed' : 'unknown', reason: this.ttfts.length ? 'ttft field' : 'Field absent' },
        { metric: 'Input/output/cache tokens', state: this.inputs.length ? 'observed' : 'unknown', reason: this.inputs.length ? 'Provider token fields' : 'Fields absent' },
        { metric: 'Explicit retries', state: 'observed', reason: 'Only explicit retry metadata; tool-loop calls are not assumed retries' },
        { metric: 'Turn duration & per-turn activity', state: this.turnDurations.length ? 'observed' : 'unknown', reason: this.turnDurations.length ? 'Matched turn_start/turn_end spans' : 'No completed turns yet' },
        { metric: 'Discovery / hidden context', state: (this.discovery.agents ?? this.discovery.skills ?? this.discovery.instructions) !== undefined ? 'observed' : 'unknown', reason: 'Parsed from discovery span details' },
        { metric: 'Context items/sources', state: 'unknown', reason: 'No per-request item inventory' },
        { metric: 'Context selected/used', state: 'unknown', reason: 'No selection or utilization evidence' },
        { metric: 'Truncation/rejection/relevance', state: 'unknown', reason: 'No outcome fields' },
        { metric: 'User/repository dimensions', state: 'unknown', reason: 'Not retained as metrics for privacy/cardinality' },
      ],
    };
  }

  private observeRequest(span: SpanLike): void {
    this.requestCount += 1;
    this.currentTurnRequests += 1;
    const result = outcome(span);
    if (result === 'success') this.requestSuccesses += 1;
    else if (result === 'failure') this.requestFailures += 1;
    else if (result === 'cancelled') this.requestCancellations += 1;
    else this.requestUnknownOutcomes += 1;

    const attrs = span.attrs && typeof span.attrs === 'object' ? span.attrs as Record<string, unknown> : {};
    const retryAttempt = finite(attrs.retryAttempt) ?? finite(attrs.attempt);
    if (attrs.isRetry === true || (retryAttempt !== undefined && retryAttempt > 1)) {
      this.explicitRetries += 1;
    }
    const latency = finite(span.dur);
    const ttft = finite(attrs.ttft);
    const input = finite(attrs.inputTokens);
    const output = finite(attrs.outputTokens);
    const cached = finite(attrs.cachedTokens);
    if (latency !== undefined) appendBounded(this.requestLatencies, latency);
    if (ttft !== undefined) appendBounded(this.ttfts, ttft);
    if (input !== undefined) {
      appendBounded(this.inputs, input);
      if (this.previousInput !== undefined) {
        appendBounded(this.contextChanges, Math.abs(input - this.previousInput));
      }
      this.previousInput = input;
    }
    if (output !== undefined) appendBounded(this.outputs, output);
    if (cached !== undefined) appendBounded(this.cached, cached);
    if (input !== undefined && cached !== undefined && input > 0) {
      appendBounded(this.uncached, Math.max(0, input - cached));
      appendBounded(this.cacheRatios, Math.max(0, Math.min(1, cached / input)));
    }
    if (input !== undefined && latency !== undefined) {
      this.inputLatencyPairs.push([input, latency]);
      if (this.inputLatencyPairs.length > SAMPLE_LIMIT) this.inputLatencyPairs.shift();
    }
    const model = typeof attrs.model === 'string' ? attrs.model : 'unknown';
    this.observeNamed(this.models, model, latency, result === 'failure');
    const operation = typeof attrs.debugName === 'string' ? attrs.debugName : 'unknown';
    this.observeNamed(this.operations, operation, latency, result === 'failure');
    if (result === 'failure' || result === 'cancelled') this.addError(errorCategory(span));
  }

  private observeTool(span: SpanLike): void {
    this.toolCallCount += 1;
    this.currentTurnTools += 1;
    const result = outcome(span);
    const failed = result === 'failure' || result === 'cancelled';
    if (failed) {
      this.toolFailureCount += 1;
      this.addError(errorCategory(span));
    }
    const name = typeof span.name === 'string' ? span.name : 'unknown';
    this.observeNamed(this.tools, name, finite(span.dur), failed);
  }

  private observeNamed(target: Map<string, NamedSamples>, name: string, latency: number | undefined, failed: boolean): void {
    const current = target.get(name) ?? { count: 0, errors: 0, latencies: [] };
    current.count += 1;
    if (failed) current.errors += 1;
    if (latency !== undefined) appendBounded(current.latencies, latency);
    target.set(name, current);
  }

  private addError(category: string): void {
    this.errors.set(category, (this.errors.get(category) ?? 0) + 1);
  }

  private breakdown(source: Map<string, NamedSamples>): BreakdownRow[] {
    return [...source.entries()]
      .map(([name, value]) => ({
        name,
        count: value.count,
        errorCount: value.errors,
        p50LatencyMs: distribution(value.latencies)?.p50,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 12);
  }
}
