import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as readline from 'node:readline';

type CapabilityState = 'observed' | 'estimated' | 'partial' | 'unknown';

interface CapabilityRecord {
  signal: string;
  state: CapabilityState;
  detail: string;
}

interface IpcEnvelope {
  protocol_version: number;
  message_id: string;
  message: {
    type: string;
    payload?: unknown;
  };
}

interface ContextBucket {
  window_start_ms: number;
  session_id: string;
  token_total_estimated: number;
  token_by_source_kind: Record<string, number>;
  confidence_summary: CapabilityState;
  request_ids: string[];
  fix_ids: string[];
}

interface Recommendation {
  id: string;
  kind: string;
  title: string;
  scope: string;
  evidence: string;
  expected_savings: number;
  reversible: boolean;
  disposition: 'advisory' | 'supported';
}

interface FixResult {
  fix_id: string;
  action: 'preview' | 'apply';
  accepted: boolean;
  advisory: boolean;
  message: string;
}

const protocolVersion = 1;

function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function eventForSource(sourceKind: string, tokenCount: number, sessionId: string): object {
  return {
    timestamp_ms: Date.now(),
    session_id: sessionId,
    request_id: null,
    event_kind: 'source_changed',
    source_kind: sourceKind,
    token_count: tokenCount,
    confidence: 'estimated',
    source_fingerprint: null,
    metadata_redacted: {},
  };
}

class ContextTopPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private buckets: ContextBucket[] = [];
  private recommendations: Recommendation[] = [];
  private fixResult?: FixResult;

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((message: { command?: string; fixId?: string }) => {
      if (message.command === 'probe') void vscode.commands.executeCommand('contexttop.probe');
      if (message.command === 'previewFix' || message.command === 'applyFix') {
        void vscode.commands.executeCommand(message.command, message);
      }
    });
    this.render();
  }

  public addBucket(bucket: ContextBucket): void {
    this.buckets = [...this.buckets.filter((item) => item.window_start_ms !== bucket.window_start_ms), bucket]
      .sort((left, right) => left.window_start_ms - right.window_start_ms)
      .slice(-180);
    this.render();
  }

  public addRecommendations(recommendations: Recommendation[]): void {
    this.recommendations = recommendations;
    this.render();
  }

  public addFixResult(result: FixResult): void {
    this.fixResult = result;
    this.render();
  }

  private render(): void {
    this.view?.webview.postMessage({ type: 'state', buckets: this.buckets, recommendations: this.recommendations, fixResult: this.fixResult });
  }

  private html(): string {
    const nonce = `${Date.now()}`;
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
      :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 18%, transparent); --accent: #e0a83b; --muted: color-mix(in srgb, currentColor 62%, transparent); }
      * { box-sizing: border-box; } body { margin: 0; padding: 16px 18px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
      header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
      h1 { margin: 0; font-size: 16px; letter-spacing: .02em; } .subtle { color: var(--muted); font-size: 11px; }
      #total { margin-top: 18px; font-size: 28px; font-weight: 650; } #confidence { color: var(--accent); text-transform: uppercase; font-size: 10px; letter-spacing: .12em; }
      #chart { height: 190px; display: flex; align-items: end; gap: 2px; border-bottom: 1px solid var(--line); padding-top: 22px; margin-top: 14px; }
      .bar { flex: 1; min-width: 3px; display: flex; flex-direction: column-reverse; gap: 1px; } .segment { min-height: 2px; }
      .prompt { background: #e0a83b; } .selection { background: #6fc2b5; } .files { background: #7896d4; } .terminal { background: #d97762; } .history { background: #b58acb; } .tools, .tool_results { background: #93a1a7; } .unknown { background: #66717a; }
      #legend { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 12px 0 18px; } .key { font-size: 11px; color: var(--muted); } .dot { display: inline-block; width: 7px; height: 7px; margin-right: 4px; border-radius: 50%; }
      #rows { display: grid; gap: 6px; } .row { display: flex; justify-content: space-between; border-top: 1px solid var(--line); padding-top: 7px; font-size: 12px; } #fixes { display: grid; gap: 8px; margin-top: 24px; } .fix { border-top: 1px solid var(--line); padding-top: 10px; } .fix-title { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; font-size: 12px; } .fix-copy { color: var(--muted); font-size: 11px; line-height: 1.45; margin-top: 5px; } .fix-actions { display: flex; gap: 6px; margin-top: 8px; } .badge { color: var(--accent); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; } button { color: inherit; background: transparent; border: 1px solid var(--line); padding: 6px 9px; cursor: pointer; } #fix-result { color: var(--accent); font-size: 11px; margin-top: 10px; }
    </style></head><body><header><div><h1>contextTop Fix</h1><div class="subtle">Estimated context composition</div></div><button id="probe">Record probe</button></header><div id="total">Waiting for context</div><div id="confidence">unknown</div><div id="chart" aria-label="Context timeline"></div><div id="legend"></div><div id="rows"></div><section id="fixes" aria-label="Recommended fixes"></section><div id="fix-result" role="status"></div><script nonce="${nonce}">
      const vscode = acquireVsCodeApi(); const names = ['prompt','selection','files','terminal','history','tools','tool_results','retrieval','unknown'];
      document.getElementById('probe').onclick = () => vscode.postMessage({ command: 'probe' });
      window.addEventListener('message', event => { const buckets = event.data.buckets || []; const recommendations = event.data.recommendations || []; const chart = document.getElementById('chart'); const rows = document.getElementById('rows'); const legend = document.getElementById('legend'); const fixes = document.getElementById('fixes'); const result = document.getElementById('fix-result'); chart.innerHTML = ''; rows.innerHTML = ''; legend.innerHTML = ''; fixes.innerHTML = ''; result.textContent = event.data.fixResult ? event.data.fixResult.message : ''; recommendations.forEach(fix => { const item = document.createElement('article'); item.className = 'fix'; item.innerHTML = '<div class="fix-title"><span>' + fix.title + '</span><span class="badge">' + fix.disposition + '</span></div><div class="fix-copy">' + fix.evidence + '. Saves ~' + fix.expected_savings.toLocaleString() + ' tokens. Scope: ' + fix.scope.replaceAll('_', ' ') + '. Reversible: ' + fix.reversible + '.</div><div class="fix-actions"><button data-fix-action="previewFix" data-fix-id="' + fix.id + '">Preview</button><button data-fix-action="applyFix" data-fix-id="' + fix.id + '">Apply</button></div>'; fixes.appendChild(item); }); if (!buckets.length) return;
        const latest = buckets[buckets.length - 1]; document.getElementById('total').textContent = latest.token_total_estimated.toLocaleString() + ' tokens est.'; document.getElementById('confidence').textContent = latest.confidence_summary;
        const max = Math.max(...buckets.map(bucket => bucket.token_total_estimated), 1); buckets.forEach(bucket => { const bar = document.createElement('div'); bar.className = 'bar'; bar.title = new Date(bucket.window_start_ms).toLocaleTimeString(); names.forEach(name => { const value = bucket.token_by_source_kind[name] || 0; if (!value) return; const segment = document.createElement('div'); segment.className = 'segment ' + name; segment.style.height = (value / max * 160) + 'px'; bar.appendChild(segment); }); chart.appendChild(bar); });
        const totals = {}; buckets.forEach(bucket => Object.entries(bucket.token_by_source_kind).forEach(([name, value]) => totals[name] = (totals[name] || 0) + value)); Object.entries(totals).sort((a,b) => b[1]-a[1]).forEach(([name, value]) => { const item = document.createElement('span'); item.className = 'key'; item.innerHTML = '<span class="dot ' + name + '"></span>' + name + ' ' + value.toLocaleString(); legend.appendChild(item); });
        Object.entries(latest.token_by_source_kind).sort((a,b) => b[1]-a[1]).forEach(([name, value]) => { const row = document.createElement('div'); row.className = 'row'; row.innerHTML = '<span>' + name + '</span><strong>' + value.toLocaleString() + '</strong>'; rows.appendChild(row); });
      });
      document.getElementById('fixes').addEventListener('click', event => { const button = event.target.closest('button[data-fix-action]'); if (!button) return; vscode.postMessage({ command: button.dataset.fixAction, fixId: button.dataset.fixId }); });
    </script></body></html>`;
  }
}

class EngineBridge implements vscode.Disposable {
  private process?: ChildProcessWithoutNullStreams;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly onBucket: (bucket: ContextBucket) => void,
    private readonly onRecommendations: (recommendations: Recommendation[]) => void,
    private readonly onFixResult: (result: FixResult) => void,
  ) {}

  public async start(context: vscode.ExtensionContext): Promise<void> {
    const executable = vscode.workspace.getConfiguration('contexttop').get<string>('enginePath', 'contexttop-engine');
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await context.secrets.store('contexttop.handshakeToken', token);
    this.process = spawn(executable, [], {
      env: { ...process.env, CONTEXTTOP_HANDSHAKE_TOKEN: token },
      stdio: 'pipe',
    });
    const reader = readline.createInterface({ input: this.process.stdout });
    reader.on('line', (line: string) => this.handleMessage(line));
    this.process.stderr.on('data', (chunk: Buffer) => this.output.appendLine(`[engine] ${chunk.toString().trimEnd()}`));
    this.process.on('error', (error: Error) => this.output.appendLine(`[engine error] ${error.message}`));
    this.process.on('exit', (code: number | null) => this.output.appendLine(`[engine exit] ${code ?? 'unknown'}`));
    this.process.stdin.write(JSON.stringify({
      protocol_version: protocolVersion,
      message_id: 'hello',
      message: { type: 'hello', payload: { handshake_token: token } },
    }) + '\n');
    this.disposables.push({ dispose: () => reader.close() });
    void context;
  }

  private handleMessage(line: string): void {
    try {
      const envelope = JSON.parse(line) as IpcEnvelope;
      if (envelope.message.type === 'error') {
        this.output.appendLine(`[protocol error] ${JSON.stringify(envelope.message.payload)}`);
      }
      if (envelope.message.type === 'bucket') {
        this.output.appendLine(`[bucket] ${JSON.stringify(envelope.message.payload)}`);
        this.onBucket(envelope.message.payload as ContextBucket);
      }
      if (envelope.message.type === 'recommendations') {
        this.onRecommendations(envelope.message.payload as Recommendation[]);
      }
      if (envelope.message.type === 'fix_result') {
        this.onFixResult(envelope.message.payload as FixResult);
      }
    } catch (error) {
      this.output.appendLine(`[protocol parse error] ${String(error)}`);
    }
  }

  public sendEvent(event: unknown): void {
    if (!this.process || this.process.stdin.destroyed) {
      this.output.appendLine('[engine] event dropped because the engine is unavailable');
      return;
    }
    this.process.stdin.write(JSON.stringify({
      protocol_version: protocolVersion,
      message_id: `event-${Date.now()}`,
      message: { type: 'event', payload: event },
    }) + '\n');
  }

  public sendFixAction(fixId: string, action: 'preview' | 'apply'): void {
    if (!this.process || this.process.stdin.destroyed) {
      this.output.appendLine('[engine] fix action dropped because the engine is unavailable');
      return;
    }
    this.process.stdin.write(JSON.stringify({
      protocol_version: protocolVersion,
      message_id: `fix-${action}-${Date.now()}`,
      message: { type: 'fix_action', payload: { fix_id: fixId, action } },
    }) + '\n');
  }

  public dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.process?.kill();
  }
}

function collectCapabilities(): CapabilityRecord[] {
  const editor = vscode.window.activeTextEditor;
  return [
    {
      signal: 'active_editor',
      state: editor ? 'observed' : 'unknown',
      detail: editor ? editor.document.uri.scheme : 'No active editor',
    },
    {
      signal: 'selection',
      state: editor ? 'observed' : 'unknown',
      detail: editor ? `${editor.selection.start.line}:${editor.selection.start.character}-${editor.selection.end.line}:${editor.selection.end.character}` : 'No selection source',
    },
    {
      signal: 'workspace_files',
      state: vscode.workspace.workspaceFolders ? 'observed' : 'unknown',
      detail: vscode.workspace.workspaceFolders ? `${vscode.workspace.workspaceFolders.length} workspace folder(s)` : 'No workspace folder',
    },
    {
      signal: 'terminals',
      state: vscode.window.terminals.length > 0 ? 'partial' : 'unknown',
      detail: `${vscode.window.terminals.length} terminal(s); command/output contents are not exposed by the stable API`,
    },
    {
      signal: 'builtin_copilot_lifecycle',
      state: 'unknown',
      detail: 'Requires an explicit supported diagnostic signal; no heuristic inference',
    },
    {
      signal: 'contexttop_chat_participant',
      state: 'observed',
      detail: 'This extension can receive requests routed through @contexttop',
    },
    {
      signal: 'model_budget',
      state: 'unknown',
      detail: 'No provider-reported usable context budget available to the probe',
    },
  ];
}

function writeProbe(output: vscode.OutputChannel): void {
  const record = {
    timestamp_ms: Date.now(),
    vscode_version: vscode.version,
    capabilities: collectCapabilities(),
  };
  output.appendLine(JSON.stringify(record));
  output.show(true);
}

function captureEditorContext(engine: EngineBridge, sessionId: string, editor: vscode.TextEditor | undefined): void {
  if (!editor) return;
  const selection = editor.document.getText(editor.selection);
  engine.sendEvent(eventForSource('selection', estimateTokens(selection), sessionId));
  engine.sendEvent(eventForSource('files', estimateTokens(editor.document.getText()), sessionId));
}

function preflightGuidance(bucket: ContextBucket | undefined, recommendations: Recommendation[]): string[] {
  if (!bucket) {
    return [
      '## contextTop preflight',
      'No context bucket is available yet. Open a file or make a selection, then run `/fix` again.',
      'Provider-side Copilot context is currently **Unknown** until a supported diagnostic signal is available.',
    ];
  }

  const sourceSummary = Object.entries(bucket.token_by_source_kind)
    .sort((left, right) => right[1] - left[1])
    .map(([source, tokens]) => `- **${source}**: ${tokens.toLocaleString()} tokens`)
    .join('\n');
  const fixes = recommendations.length === 0
    ? '- No deterministic fix crossed its evidence threshold.'
    : recommendations.map((fix) => `- **${fix.title}**: saves about ${fix.expected_savings.toLocaleString()} tokens; scope is ${fix.scope.replaceAll('_', ' ')}; this is ${fix.disposition}.`).join('\n');

  return [
    '## contextTop preflight',
    `Current estimate: **${bucket.token_total_estimated.toLocaleString()} tokens** (${bucket.confidence_summary} confidence).`,
    '### Sources\n' + sourceSummary,
    '### Recommended next actions\n' + fixes,
    'Opaque provider-side context remains **Unknown**. These estimates do not claim to be Copilot-reported values.',
  ];
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('contextTop Probe');
  const panel = new ContextTopPanel();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'contexttop.open';
  status.text = '$(pulse) Context --';
  status.tooltip = 'Open contextTop Fix';
  status.show();
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let latestBucket: ContextBucket | undefined;
  let latestRecommendations: Recommendation[] = [];
  const engine = new EngineBridge(output, (bucket) => {
    latestBucket = bucket;
    panel.addBucket(bucket);
    status.text = `$(pulse) Context ${bucket.token_total_estimated.toLocaleString()} est.`;
    status.tooltip = `${bucket.confidence_summary} confidence; percentage unavailable without a model budget`;
  }, (recommendations) => {
    latestRecommendations = recommendations;
    panel.addRecommendations(recommendations);
  }, (result) => panel.addFixResult(result));
  void engine.start(context);
  const open = vscode.commands.registerCommand('contexttop.open', () => vscode.commands.executeCommand('workbench.action.focusPanel'));
  const probe = vscode.commands.registerCommand('contexttop.probe', () => writeProbe(output));
  const previewFix = vscode.commands.registerCommand('contexttop.previewFix', (message: { fixId?: string }) => {
    if (message.fixId) engine.sendFixAction(message.fixId, 'preview');
  });
  const applyFix = vscode.commands.registerCommand('contexttop.applyFix', (message: { fixId?: string }) => {
    if (message.fixId) engine.sendFixAction(message.fixId, 'apply');
  });
  const provider = vscode.window.registerWebviewViewProvider('contexttop.fix', panel);
  const participant = vscode.chat.createChatParticipant('contexttop', async (request, _context, response) => {
    if (request.command !== 'fix') {
      response.markdown('Use `@contexttop /fix` for a context preflight. Built-in Copilot context remains observational.');
      return;
    }
    for (const section of preflightGuidance(latestBucket, latestRecommendations)) {
      response.markdown(section + '\n\n');
    }
  });
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'contexttop.svg');
  context.subscriptions.push(
    output,
    status,
    open,
    probe,
    previewFix,
    applyFix,
    provider,
    participant,
    engine,
    vscode.window.onDidChangeActiveTextEditor((editor) => captureEditorContext(engine, sessionId, editor)),
    vscode.window.onDidChangeTextEditorSelection((event) => captureEditorContext(engine, sessionId, event.textEditor)),
  );
  captureEditorContext(engine, sessionId, vscode.window.activeTextEditor);
  writeProbe(output);
}

export function deactivate(): void {}
