import * as vscode from 'vscode';
import { EngineClient } from './engineClient';
import { DiagnosticLogTailer, CopilotRequestMetrics } from './diagnosticLog';
import { CopilotAnalyticsSnapshot } from './copilotAnalytics';
import { DashboardCardId, DEFAULT_DASHBOARD_LAYOUT } from './dashboardContract';

let engine: EngineClient;

/** Effective diagnostics state (setting OR debug-host auto-on). */
let diagnosticsActive = false;

/** Generate a CSP nonce for the webview's inline script. */
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/** Chart threshold bounds (absolute candidate tokens). */
interface Thresholds {
  warn: number;
  critical: number;
}

function readThresholds(): Thresholds {
  const c = vscode.workspace.getConfiguration('contextTop');
  return {
    warn: c.get<number>('warnTokens', 40000),
    critical: c.get<number>('criticalTokens', 80000),
  };
}

function readWindowMinutes(): number {
  return vscode.workspace.getConfiguration('contextTop').get<number>('timeWindowMinutes', 5);
}

/** Which dashboard cards to show and in what order (validated against the known set). */
function readDashboardLayout(): DashboardCardId[] {
  const raw = vscode.workspace
    .getConfiguration('contextTop')
    .get<string[]>('dashboardLayout', DEFAULT_DASHBOARD_LAYOUT);
  const known = new Set<string>(DEFAULT_DASHBOARD_LAYOUT);
  const seen = new Set<string>();
  const layout = raw.filter((id) => known.has(id) && !seen.has(id) && seen.add(id)) as DashboardCardId[];
  return layout.length > 0 ? layout : DEFAULT_DASHBOARD_LAYOUT;
}

/** Send the effective contextTop settings to the engine as the authoritative policy copy. */
async function sendConfig(engine: EngineClient): Promise<void> {
  const c = vscode.workspace.getConfiguration('contextTop');
  const config = {
    warningThreshold: c.get('warningThreshold', 0.7),
    captureLevel: c.get('captureLevel', 'metadata'),
    allowTransientContentProcessing: c.get('allowTransientContentProcessing', true),
    enableDiagnosticLogs: c.get('enableDiagnosticLogs', false),
    detailRetentionHours: c.get('detailRetentionHours', 24),
    measurementRetentionDays: c.get('measurementRetentionDays', 7),
    rollupRetentionDays: c.get('rollupRetentionDays', 30),
    maxStorageMiB: c.get('maxStorageMiB', 100),
    warnTokens: c.get('warnTokens', 40000),
    criticalTokens: c.get('criticalTokens', 80000),
    timeWindowMinutes: c.get('timeWindowMinutes', 5),
  };
  try {
    await engine.request('request.setConfig', { config });
  } catch (err) {
    console.warn('[contextTop] setConfig failed:', err);
  }
}

/** Current enabled state of the two log sources, for reflecting button state in the panel. */
function readEnabledState(): { diagnostics: boolean; otlp: boolean } {
  return {
    diagnostics: diagnosticsActive,
    otlp: vscode.workspace
      .getConfiguration('github.copilot.chat')
      .get<boolean>('agentDebugLog.fileLogging.enabled', false),
  };
}

/** Fallback: write a dotted setting key into user settings.json when config.update is rejected. */
async function writeUserSettingKey(key: string, value: unknown): Promise<boolean> {
  try {
    const settingsUri = vscode.Uri.joinPath(
      vscode.Uri.file(process.env.HOME || ''),
      'Library',
      'Application Support',
      'Code',
      'User',
      'settings.json'
    );
    let text = '{}';
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(settingsUri)).toString('utf8');
    } catch {
      /* no existing file */
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      return false; // JSONC with comments — don't risk corrupting it.
    }
    json[key] = value;
    await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(json, null, 2), 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/** Once per install, offer to enable Copilot's structured OTLP debug log (buttons, no Settings). */
async function maybePromptAgentDebugLog(context: vscode.ExtensionContext): Promise<void> {
  const alreadyOn = vscode.workspace
    .getConfiguration('github.copilot.chat')
    .get<boolean>('agentDebugLog.fileLogging.enabled', false);
  const asked = context.globalState.get<boolean>('contextTop.askedAgentDebugLog', false);
  if (alreadyOn || asked) {
    return;
  }
  await context.globalState.update('contextTop.askedAgentDebugLog', true);
  const pick = await vscode.window.showInformationMessage(
    'contextTop can read Copilot request composition and token usage if the Agent Debug Log is enabled. Enable it now?',
    'Enable',
    'Not now'
  );
  if (pick === 'Enable') {
    await vscode.commands.executeCommand('contextTop.enableAgentDebugLog');
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[contextTop] Activating extension...');

  // Initialize and start the engine client.
  engine = new EngineClient(context.extensionPath);
  try {
    console.log('[contextTop] Starting engine...');
    await engine.start();
    console.log('[contextTop] Engine started successfully');
  } catch (err) {
    console.error('[contextTop] Failed to start engine:', err);
    vscode.window.showErrorMessage(`contextTop: Failed to start engine: ${err}`);
    return;
  }

  console.log('[contextTop] Registering contextTop.openFix command...');
  context.subscriptions.push(vscode.commands.registerCommand('contextTop.openFix', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.contextTop');
  }));

  // Help the user actually prune tools: open VS Code's tool configuration if available,
  // else guide them to the Chat tools picker. No public API disables tools programmatically.
  context.subscriptions.push(vscode.commands.registerCommand('contextTop.manageTools', async () => {
    // The user acting on the guided tool fix is its acceptance.
    await provider?.acceptToolFix();
    const candidates = [
      'workbench.action.chat.configureTools',
      'github.copilot.chat.configureTools',
      'workbench.action.chat.manageTools',
    ];
    for (const cmd of candidates) {
      try {
        await vscode.commands.executeCommand(cmd);
        return;
      } catch {
        // try next
      }
    }
    const pick = await vscode.window.showInformationMessage(
      'To cut tool context cost, open the Chat view and use the Tools picker (the wrench/tools icon) to turn off tools you are not using. MCP and extension tools you disable stop being sent with every request.',
      'Open Chat',
      'Open Settings'
    );
    if (pick === 'Open Chat') {
      await vscode.commands.executeCommand('workbench.action.chat.open').then(undefined, () => undefined);
    } else if (pick === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'chat.tools');
    }
  }));

  // Send the authoritative policy copy to the engine (drives policyRevision).
  void sendConfig(engine);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('contextTop')) {
        void sendConfig(engine);
      }
    })
  );

  console.log('[contextTop] Registering webview provider...');
  let provider: ContextTopFixProvider | undefined;
  try {
    provider = new ContextTopFixProvider(engine, readThresholds(), readWindowMinutes());    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ContextTopFixProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
    console.log('[contextTop] Provider registered successfully');
  } catch (err) {
    console.error('[contextTop] Failed to register provider:', err);
  }

  // Re-read thresholds when the user changes them.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('contextTop.warnTokens') || e.affectsConfiguration('contextTop.criticalTokens')) {
        provider?.setThresholds(readThresholds());
      }
      if (e.affectsConfiguration('contextTop.timeWindowMinutes')) {
        provider?.setWindowMinutes(readWindowMinutes());
      }
      if (e.affectsConfiguration('contextTop.dashboardLayout')) {
        provider?.refresh();
      }
      if (
        e.affectsConfiguration('contextTop.enableDiagnosticLogs') ||
        e.affectsConfiguration('github.copilot.chat.agentDebugLog.fileLogging.enabled')
      ) {
        if (vscode.workspace.getConfiguration('contextTop').get<boolean>('enableDiagnosticLogs', false)) {
          diagnosticsActive = true;
        }
        provider?.refresh();
      }
    })
  );

  // Toggle commands (also wired to in-panel buttons so users never need the Settings UI).
  context.subscriptions.push(
    vscode.commands.registerCommand('contextTop.enableDiagnostics', async () => {
      console.log('[contextTop] command: enableDiagnostics');
      try {
        await vscode.workspace
          .getConfiguration('contextTop')
          .update('enableDiagnosticLogs', true, vscode.ConfigurationTarget.Global);
        const pick = await vscode.window.showInformationMessage(
          'contextTop diagnostic log ingestion enabled. Reload to start tailing Copilot logs.',
          'Reload Window'
        );
        if (pick === 'Reload Window') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (err) {
        vscode.window.showErrorMessage(`contextTop: could not enable diagnostics: ${err}`);
      }
    }),
    vscode.commands.registerCommand('contextTop.enableAgentDebugLog', async () => {
      console.log('[contextTop] command: enableAgentDebugLog');
      const KEY = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';
      try {
        await vscode.workspace
          .getConfiguration()
          .update(KEY, true, vscode.ConfigurationTarget.Global);
        await vscode.window.showInformationMessage(
          'Copilot Agent Debug Log (OTLP) enabled. Send a chat message, then reload — contextTop will read the structured token-usage records.'
        );
      } catch (err) {
        // The key may not be registered by the installed Copilot version; write it directly.
        console.warn('[contextTop] config.update failed, writing settings.json directly:', err);
        const ok = await writeUserSettingKey(KEY, true);
        if (ok) {
          await vscode.window.showInformationMessage(
            `Wrote "${KEY}": true to your user settings.json. Reload VS Code to apply.`,
            'Reload Window'
          ).then((pick) => {
            if (pick === 'Reload Window') {
              void vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          });
        } else {
          const open = await vscode.window.showWarningMessage(
            `contextTop couldn't set "${KEY}" automatically. Open settings to enable it?`,
            'Open Settings'
          );
          if (open === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'agentDebugLog');
          }
        }
      }
    })
  );

  // Ambient collectors: selection, open files, instruction files, tools/MCP loaded.
  console.log('[contextTop] Setting up ambient collectors...');
  setupAmbientCollectors(engine, context, provider);
  console.log('[contextTop] Ambient collectors setup complete');

  // Diagnostic log ingestion: opt-in via setting, and always on in the debug/dev host.
  const isDev = context.extensionMode === vscode.ExtensionMode.Development;
  const diagSetting = vscode.workspace.getConfiguration('contextTop').get<boolean>('enableDiagnosticLogs', false);
  diagnosticsActive = diagSetting || isDev;
  if (diagnosticsActive) {
    const output = vscode.window.createOutputChannel('contextTop Diagnostics');
    output.appendLine(`[diag] enabled (${isDev ? 'debug host auto-on' : 'setting'})`);
    const tailer = new DiagnosticLogTailer(
      engine,
      context.logUri.fsPath,
      context.globalStorageUri.fsPath,
      output,
      (r) => provider?.updateRequest(r),
      (stats) => provider?.updateAnalytics(stats)
    );
    tailer.start();
    context.subscriptions.push(new vscode.Disposable(() => tailer.dispose()));
    console.log('[contextTop] Diagnostic log tailer started');
  } else {
    console.log('[contextTop] Diagnostic logs disabled (set contextTop.enableDiagnosticLogs to true)');
  }

  // First-run nudge: offer to enable the structured OTLP source (buttons, not Settings).
  void maybePromptAgentDebugLog(context);

  // Graceful shutdown.
  context.subscriptions.push(new vscode.Disposable(async () => {
    console.log('[contextTop] Shutting down engine...');
    await engine.shutdown();
  }));

  console.log('[contextTop] Activation complete');
}

/** Kill the engine child on host shutdown/reload so F5 cycles don't orphan processes. */
export async function deactivate(): Promise<void> {
  try {
    await engine?.shutdown();
  } catch (err) {
    console.warn('[contextTop] deactivate shutdown failed:', err);
  }
}

/** Format token count as k for thousands or raw number. */
function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

/** Live inventory counts surfaced as gauges (like top's task counts). */
interface AmbientInventory {
  toolsCount: number;
  instructionsCount: number;
  editorsCount: number;
  terminalsCount: number;
  toolsTotalTokens: number;
  topTools: Array<{ name: string; tokens: number }>;
  instrFiles: Array<{ name: string; tokens: number }>;
}

const ambientInventory: AmbientInventory = {
  toolsCount: 0,
  instructionsCount: 0,
  editorsCount: 0,
  terminalsCount: 0,
  toolsTotalTokens: 0,
  topTools: [],
  instrFiles: [],
};

/** Fallback tokenizer estimate (~4 bytes/token), matching the engine's FallbackTokenizer. */
function estTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

/** Fire-and-forget ingest helper. */
function ingest(engine: EngineClient, payload: Record<string, unknown>): void {
  engine.request('request.ingestObservation', payload).catch((err) => {
    console.warn(`[contextTop] ingest failed (${payload.sourceKind}): ${err.message}`);
  });
}

/** Last sent signature + time per sourceIdentity, to suppress redundant re-ingests. */
const lastIngest = new Map<string, { sig: string; ts: number }>();
/** Re-send an unchanged observation at most this often (keeps it under the engine TTL). */
const INGEST_REFRESH_MS = 30_000;

/**
 * Ingest only when the observation changed, or its last send is stale. Rescans (e.g. tools
 * every 5s) otherwise resend dozens of identical observations, flooding the engine pipe.
 * Observations carrying raw `transientContent` always send so content is processed.
 */
function ingestDeduped(engine: EngineClient, payload: Record<string, unknown>): void {
  const identity = String(payload.sourceIdentity ?? '');
  if (!identity || payload.transientContent !== undefined) {
    ingest(engine, payload);
    return;
  }
  const sig = JSON.stringify([payload.sourceKind, payload.observed, payload.coverage, payload.provenance]);
  const prev = lastIngest.get(identity);
  const now = Date.now();
  if (prev && prev.sig === sig && now - prev.ts < INGEST_REFRESH_MS) {
    return;
  }
  lastIngest.set(identity, { sig, ts: now });
  ingest(engine, payload);
}

/**
 * Set up all ambient collectors. Each observation is a candidate — never confirmed
 * request context. Sources: selection, open files, instruction/prompt files, and
 * loaded tools (which includes MCP-registered tools).
 */
function setupAmbientCollectors(
  engine: EngineClient,
  context: vscode.ExtensionContext,
  provider?: ContextTopFixProvider
): void {
  const config = vscode.workspace.getConfiguration('contextTop');
  const allowTransient = config.get<boolean>('allowTransientContentProcessing', false);

  const pushInventory = () => provider?.updateInventory({ ...ambientInventory });

  // --- Selection (debounced to avoid drag-select spam) ---
  let selectionTimer: NodeJS.Timeout | undefined;
  const onSelection = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (selectionTimer) {
      clearTimeout(selectionTimer);
    }
    selectionTimer = setTimeout(() => {
      const editor = event.textEditor;
      const selection = event.selections[0];
      if (!selection) {
        return;
      }
      const doc = editor.document;
      const selectedText = doc.getText(new vscode.Range(selection.start, selection.end));
      const byteLen = Buffer.byteLength(selectedText, 'utf8');
      const sourceIdentity = `selection:${doc.uri.toString()}`;
      const payload: Record<string, unknown> = {
        sourceIdentity,
        sourceKind: 'selection',
        observed: { byteLen },
        coverage: 'complete',
        provenance: 'direct_api',
      };
      if (allowTransient && selectedText.length > 0 && selectedText.length <= 10000) {
        payload.transient_content = selectedText.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 10000);
      }
      ingest(engine, payload);
    }, 120);
  });
  context.subscriptions.push(onSelection);

  // --- Open files (each visible editor = one candidate 'files' source) ---
  const scanEditors = () => {
    const docs = vscode.workspace.textDocuments.filter((d) => !d.isUntitled && d.uri.scheme === 'file');
    ambientInventory.editorsCount = docs.length;
    for (const doc of docs) {
      const byteLen = Buffer.byteLength(doc.getText(), 'utf8');
      ingestDeduped(engine, {
        sourceIdentity: `file:${doc.uri.toString()}`,
        sourceKind: 'files',
        observed: { byteLen },
        coverage: 'complete',
        provenance: 'direct_api',
      });
    }
    pushInventory();
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(scanEditors),
    vscode.workspace.onDidCloseTextDocument(scanEditors),
    vscode.workspace.onDidSaveTextDocument(scanEditors),
    vscode.window.onDidChangeVisibleTextEditors(scanEditors)
  );

  // --- Instruction / prompt files ---
  const scanInstructions = async () => {
    const patterns = [
      '**/copilot-instructions.md',
      '**/*.instructions.md',
      '**/AGENTS.md',
      '**/*.prompt.md',
    ];
    const seen = new Set<string>();
    const detail: Array<{ name: string; tokens: number }> = [];
    for (const pattern of patterns) {
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 50);
      for (const uri of uris) {
        if (seen.has(uri.toString())) {
          continue;
        }
        seen.add(uri.toString());
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          detail.push({ name: uri.path.split('/').pop() || uri.path, tokens: estTokens(stat.size) });
          ingestDeduped(engine, {
            sourceIdentity: `instructions:${uri.toString()}`,
            sourceKind: 'instructions',
            observed: { byteLen: stat.size },
            coverage: 'complete',
            provenance: 'direct_api',
          });
        } catch {
          /* ignore unreadable */
        }
      }
    }
    ambientInventory.instructionsCount = seen.size;
    detail.sort((a, b) => b.tokens - a.tokens);
    ambientInventory.instrFiles = detail.slice(0, 12);
    pushInventory();
  };

  // --- Tools loaded (includes MCP-registered tools) ---
  const scanTools = () => {
    const tools = (vscode.lm?.tools ?? []) as ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>;
    ambientInventory.toolsCount = tools.length;
    const detail: Array<{ name: string; tokens: number }> = [];
    let totalTokens = 0;
    for (const tool of tools) {
      // The token cost of a loaded tool is its name + description + schema.
      const schemaText = JSON.stringify({ n: tool.name, d: tool.description ?? '', s: tool.inputSchema ?? {} });
      const bytes = Buffer.byteLength(schemaText, 'utf8');
      const toolTokens = estTokens(bytes);
      totalTokens += toolTokens;
      detail.push({ name: tool.name, tokens: toolTokens });
      ingestDeduped(engine, {
        sourceIdentity: `tool:${tool.name}`,
        sourceKind: 'tools',
        observed: { byteLen: bytes },
        coverage: 'complete',
        provenance: 'direct_api',
      });
    }
    detail.sort((a, b) => b.tokens - a.tokens);
    ambientInventory.toolsTotalTokens = totalTokens;
    ambientInventory.topTools = detail.slice(0, 60);
    pushInventory();
  };

  // --- Terminal count (inventory only for now) ---
  const scanTerminals = () => {
    ambientInventory.terminalsCount = vscode.window.terminals.length;
    pushInventory();
  };
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(scanTerminals),
    vscode.window.onDidCloseTerminal(scanTerminals)
  );

  // Initial scans.
  scanEditors();
  scanInstructions();
  scanTools();
  scanTerminals();

  // Periodic refresh so tools/MCP servers loading later are picked up.
  const interval = setInterval(() => {
    scanTools();
    scanInstructions();
    void provider?.refreshToolRecommendation();
  }, 5000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(interval)));
}

class ContextTopFixProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'contextTop.fix';
  private view?: vscode.WebviewView;
  private total = 0;
  private peak = 0;
  private bySource: Record<string, number> = {};
  private inventory: AmbientInventory = {
    toolsCount: 0,
    instructionsCount: 0,
    editorsCount: 0,
    terminalsCount: 0,
    toolsTotalTokens: 0,
    topTools: [],
    instrFiles: [],
  };
  private lastRequest?: CopilotRequestMetrics;
  private analytics?: CopilotAnalyticsSnapshot;
  private toolFix?: { fixId: string; savedMin: number; savedMax: number; targetCount: number; execution: string };

  constructor(private engine: EngineClient, private thresholds: Thresholds, private windowMinutes: number) {
    this.engine.onEvent('event.metrics', (event: any) => {
      this.total = event.candidateLatestTokens ?? this.total;
      this.peak = Math.max(this.peak, event.candidatePeakTokens ?? 0, this.total);
      this.bySource = event.candidateBySourceLatest ?? this.bySource;
      this.post();
    });
  }

  /** Update inventory counts (tools, instructions, editors, terminals) and stream to the view. */
  updateInventory(inv: AmbientInventory): void {
    this.inventory = inv;
    this.post();
  }

  /** Update chart threshold bounds and stream to the view. */
  setThresholds(t: Thresholds): void {
    this.thresholds = t;
    this.post();
  }

  /** Update the chart time window (minutes) and stream to the view. */
  setWindowMinutes(minutes: number): void {
    this.windowMinutes = minutes;
    this.post();
  }

  /** Re-push current state (e.g. after enabled-state changes). */
  refresh(): void {
    this.post();
  }

  /** Receive an observed Copilot request (from the debug-log tailer) and stream it. */
  updateRequest(r: CopilotRequestMetrics): void {
    this.lastRequest = r;
    this.post();
  }

  /** Receive bounded, metadata-only statistics derived from the active Copilot session. */
  updateAnalytics(stats: CopilotAnalyticsSnapshot): void {
    this.analytics = stats;
    this.post();
  }

  /** Ask the engine to rank current pressure and keep the `unselect_tools` fix (fixId +
   *  engine-estimated savings) so the Story card renders the ranked recommendation. */
  async refreshToolRecommendation(): Promise<void> {
    try {
      const res = await this.engine.request('request.getRecommendations', {});
      const items = ((res.payload as { items?: unknown[] } | undefined)?.items ?? []) as Array<Record<string, unknown>>;
      const tool = items.find((it) => it.actionKind === 'unselect_tools');
      this.toolFix = tool
        ? {
            fixId: String(tool.fixId ?? ''),
            savedMin: Number(tool.estimatedTokensSavedMin ?? 0),
            savedMax: Number(tool.estimatedTokensSavedMax ?? 0),
            targetCount: Array.isArray(tool.targetSourceKeys) ? tool.targetSourceKeys.length : 0,
            execution: String(tool.execution ?? 'guided'),
          }
        : undefined;
      this.post();
    } catch {
      // Recommendations are best-effort; never let a ranking error affect the UI.
    }
  }

  /** Report the guided tool fix as accepted (proposed → accepted) when the user acts. */
  async acceptToolFix(): Promise<void> {
    const fixId = this.toolFix?.fixId;
    if (!fixId) {
      return;
    }
    try {
      await this.engine.request('request.reportLifecycle', {
        fixId,
        kind: 'fix_accepted',
        timestampMs: Date.now(),
      });
    } catch {
      // Lifecycle reporting is best-effort.
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const nonce = getNonce();
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(nonce, view.webview.cspSource);
    // In-panel buttons dispatch to the toggle commands (no Settings trip required).
    view.webview.onDidReceiveMessage((msg: any) => {
      console.log('[contextTop] webview message:', JSON.stringify(msg));
      try {
        if (msg?.type === 'command' && typeof msg.id === 'string') {
          // Support passing args from the webview. If the special 'openFile' id is used,
          // resolve the workspace-relative path and open the file URI in the editor.
          if (msg.id === 'openFile' && Array.isArray(msg.args) && msg.args.length > 0 && typeof msg.args[0] === 'string') {
            const rel = msg.args[0];
            const wf = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            const full = wf ? vscode.Uri.file(require('path').join(wf.uri.fsPath, rel)) : vscode.Uri.file(rel);
            void vscode.commands.executeCommand('vscode.open', full);
          } else {
            // Forward command and optional args to the command registry.
            const args = Array.isArray(msg.args) ? msg.args : [];
            void vscode.commands.executeCommand(msg.id, ...args);
          }
        } else if (msg?.type === 'setWindow' && typeof msg.minutes === 'number') {
          this.windowMinutes = msg.minutes;
          void vscode.workspace
            .getConfiguration('contextTop')
            .update('timeWindowMinutes', msg.minutes, vscode.ConfigurationTarget.Global);
          this.post();
        }
      } catch (e) {
        console.error('[contextTop] failed to handle webview message', e);
      }
    });
    // Stream current state immediately.
    this.post();
  }

  /** Push the latest metrics snapshot to the webview (instant, no full reload). */
  private post(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({
      type: 'metrics',
      ts: Date.now(),
      total: this.total,
      peak: this.peak,
      bySource: this.bySource,
      inventory: this.inventory,
      thresholds: this.thresholds,
      windowMinutes: this.windowMinutes,
      enabled: readEnabledState(),
      layout: readDashboardLayout(),
      request: this.lastRequest,
      analytics: this.analytics,
      toolFix: this.toolFix,
    });
  }

  private getHtml(nonce: string, cspSource: string): string {
    const csp = [
      "default-src 'none'",
      `img-src ${cspSource} https: data:`,
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 12px; }
  main { display: flex; flex-direction: column; min-height: 100%; padding: 12px 16px 8px; gap: 8px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; flex: 0 0 auto; }
  .eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .5px; color: var(--vscode-descriptionForeground); margin: 0; }
  h2 { font-size: 15px; margin: 3px 0 0; }
  .headline { text-align: right; }
  .headline b { font-size: 22px; }
  .headline small { display: block; font-size: 10px; color: var(--vscode-descriptionForeground); }

  .gauges { display: flex; flex-wrap: wrap; gap: 14px; flex: 0 0 auto; }
  .gauge { min-width: 70px; }
  .gauge .v { font-size: 16px; font-weight: 600; }
  .gauge .l { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: var(--vscode-descriptionForeground); }

  .chartWrap { flex: 0 0 160px; min-height: 90px; position: relative; }
  canvas { width: 100%; height: 100%; display: block; }

  .legend { display: flex; flex-wrap: wrap; gap: 12px; flex: 0 0 auto; font-size: 10px; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); }
  .swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }

  table { width: 100%; border-collapse: collapse; flex: 0 0 auto; font-size: 11px; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: var(--vscode-descriptionForeground); font-weight: 600; padding: 2px 4px; border-bottom: 1px solid var(--vscode-widget-border); }
  td { padding: 3px 4px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 6px; border-radius: 3px; }
  .name { display: inline-flex; align-items: center; gap: 6px; }

  .pill { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; margin-top: 4px; display: inline-block; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; flex: 0 0 auto; }
  .toolbar button { font: inherit; font-size: 10px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 3px 8px; cursor: pointer; }
  .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.15)); }
  .toolbar select { font: inherit; font-size: 10px; color: var(--vscode-foreground); background: var(--vscode-dropdown-background, transparent); border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 3px 6px; cursor: pointer; }
  .toolbar .spacer { flex: 1 1 auto; }
  .wsel { display: inline-flex; gap: 2px; }
  .wsel button.active { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border-color: transparent; }
  .axis { display: flex; justify-content: space-between; font-size: 9px; color: var(--vscode-descriptionForeground); flex: 0 0 auto; padding-top: 2px; }
  .reqstrip { display: none; flex-wrap: wrap; gap: 16px; align-items: baseline; flex: 0 0 auto; padding: 6px 8px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; }
  .reqstrip.on { display: flex; }
  .reqstrip .rk { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: var(--vscode-descriptionForeground); }
  .reqstrip .rv { font-size: 14px; font-weight: 600; margin-left: 4px; }
  .reqstrip .rmodel { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .reqbreak { display: none; flex-direction: column; gap: 6px; flex: 0 0 auto; padding: 8px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; }
  .reqbreak.on { display: flex; }
  .reqbreak-head { display: flex; justify-content: space-between; align-items: baseline; }
  .reqbreak-note { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .stack { display: flex; width: 100%; height: 14px; border-radius: 4px; overflow: hidden; background: rgba(128,128,128,0.15); }
  .stack .seg { height: 100%; }
  .tooltip { position: absolute; display: none; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 6px 8px; font-size: 11px; color: var(--vscode-foreground); pointer-events: none; z-index: 1000; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  .tooltip.on { display: block; }
  .tooltip-row { display: flex; gap: 8px; align-items: baseline; margin: 2px 0; }
  .tooltip-label { color: var(--vscode-descriptionForeground); min-width: 50px; }
  .tooltip-value { font-weight: 600; }
  .analytics { border-top: 1px solid var(--vscode-widget-border); padding-top: 6px; }
  .analytics summary { cursor: pointer; font-weight: 600; font-size: 12px; }
  .analytics-note { color: var(--vscode-descriptionForeground); font-size: 10px; margin: 4px 0 7px; }
  .analytics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 7px; }
  .analytics-card { border: 1px solid var(--vscode-widget-border); border-radius: 5px; padding: 7px; min-width: 0; }
  .analytics-card h3 { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: var(--vscode-descriptionForeground); margin: 0 0 5px; }
  .metric-line { display: flex; justify-content: space-between; gap: 8px; margin: 3px 0; }
  .metric-line b { font-variant-numeric: tabular-nums; }
  .quality { font-size: 9px; border-radius: 8px; padding: 1px 5px; margin-left: 4px; }
  .quality.observed { color: #4ec98a; background: rgba(78,201,138,.12); }
  .quality.unknown { color: var(--vscode-descriptionForeground); background: rgba(128,128,128,.12); }
  .compact-table { margin-top: 7px; }
  .empty { color: var(--vscode-descriptionForeground); }
  .anomaly { color: var(--vscode-editorWarning-foreground, #e6a04d); margin: 3px 0; }
  .story { display: none; flex-direction: column; gap: 6px; flex: 0 0 auto; padding: 10px 12px; border: 1px solid var(--vscode-widget-border); border-left: 3px solid #a06cf0; border-radius: 5px; background: rgba(160,108,240,0.06); }
  .story.on { display: flex; }
  .story-headline { font-size: 13px; font-weight: 600; }
  .story-detail { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
  .story-rec { font-size: 11px; color: var(--vscode-foreground); }
  .story-rec .chip { font-size: 9px; color: #a06cf0; background: rgba(160,108,240,0.14); border-radius: 8px; padding: 1px 6px; margin-left: 6px; }
  .story-actions { display: flex; gap: 6px; }
  .story-actions button { font: inherit; font-size: 11px; color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
  .story-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .story-table td { padding: 2px 4px; }
  .story-badge { font-size: 9px; padding: 1px 6px; border-radius: 8px; }
  .story-badge.used { color: #4ec98a; background: rgba(78,201,138,0.14); }
  .story-badge.unused { color: #e5a44e; background: rgba(229,164,78,0.14); }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <p class="eyebrow" id="eyebrow">LIVE CONTEXT · STREAMING</p>
      <h2 id="modeTitle">Candidate context pressure</h2>
      <span class="pill" id="statusPill">collecting…</span>
    </div>
    <div class="headline"><b id="hlTotal">0</b><small id="hlUnit">tokens</small></div>
  </header>

  <div class="story" id="story" data-card="story">
    <div class="story-headline" id="storyHeadline">Collecting context…</div>
    <div class="story-detail" id="storyDetail"></div>
    <div class="story-rec" id="storyRec"></div>
    <div class="story-actions"><button id="btnManageTools">Manage tools…</button></div>
    <table class="story-table"><tbody id="storyTools"></tbody></table>
  </div>

  <div class="reqstrip" id="reqstrip" data-card="request">
    <span><span class="rk">Request in</span><span class="rv" id="rIn">—</span></span>
    <span><span class="rk">Cache hit</span><span class="rv" id="rCache">—</span></span>
    <span><span class="rk">Out</span><span class="rv" id="rOut">—</span></span>
    <span><span class="rk">Latency</span><span class="rv" id="rLat">—</span></span>
    <span><span class="rk">TTFT</span><span class="rv" id="rTtft">—</span></span>
    <span><span class="rk">Budget</span><span class="rv" id="rBudget">—</span></span>
    <span class="rmodel" id="rModel"></span>
  </div>

  <div class="reqbreak" id="reqbreak" data-card="requestBreakdown">
    <div class="reqbreak-head">
      <span class="rk">Request context breakdown</span>
      <span class="reqbreak-note" id="rBreakNote"></span>
    </div>
    <div class="stack" id="rStack"></div>
    <div class="legend" id="rBreakLegend"></div>
  </div>

  <div class="toolbar">
    <span class="wsel" id="msel">
      <button data-mode="candidate" class="active">Candidate</button>
      <button data-mode="request">Request</button>
    </span>
    <select id="metric" title="What the graph plots in Request mode">
      <option value="all" selected>All metrics</option>
      <option value="composition">Composition</option>
      <option value="input">Input tokens</option>
      <option value="budget">Budget %</option>
      <option value="cacheHit">Cache hit %</option>
      <option value="uncached">Uncached tokens</option>
      <option value="growth">Context growth</option>
      <option value="ttft">TTFT (ms)</option>
      <option value="latency">Latency (ms)</option>
      <option value="output">Output tokens</option>
      <option value="billing">Billing (nAIU)</option>
    </select>
    <span class="wsel" id="wsel">
      <button data-min="1">1m</button>
      <button data-min="5">5m</button>
      <button data-min="15">15m</button>
      <button data-min="30">30m</button>
      <button data-min="60">1h</button>
    </span>
    <span class="spacer"></span>
    <button id="btnDiag">Enable diagnostic logs</button>
    <button id="btnOtlp">Enable Copilot Agent Debug Log</button>
  </div>

  <div class="gauges" data-card="gauges">
    <div class="gauge"><div class="v" id="gPeak">0</div><div class="l">Peak</div></div>
    <div class="gauge"><div class="v" id="gRate">0/s</div><div class="l">Rate</div></div>
    <div class="gauge"><div class="v" id="gTools">0</div><div class="l">Tools/MCP</div></div>
    <div class="gauge"><div class="v" id="gInstr">0</div><div class="l">Instr. files</div></div>
    <div class="gauge"><div class="v" id="gFiles">0</div><div class="l">Open files</div></div>
    <div class="gauge"><div class="v" id="gTerms">0</div><div class="l">Terminals</div></div>
  </div>

  <div data-card="chart">
    <div class="chartWrap"><canvas id="chart"></canvas><div class="tooltip" id="tooltip"></div></div>
    <div class="axis"><span id="axLeft">−5m</span><span>now</span></div>
    <div class="legend" id="legend"></div>
  </div>

  <table data-card="sources">
    <thead><tr><th>Source</th><th style="text-align:right">Tokens</th><th style="width:38%">Share</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>

  <details class="analytics" id="analytics" data-card="analytics" open>
    <summary>Observed request analytics</summary>
    <div class="analytics-note" id="analyticsNote">Waiting for structured diagnostic events…</div>
    <div class="analytics-grid">
      <section class="analytics-card">
        <h3>Request outcomes</h3>
        <div class="metric-line"><span>Requests</span><b id="aRequests">—</b></div>
        <div class="metric-line"><span>Success rate</span><b id="aSuccess">—</b></div>
        <div class="metric-line"><span>Failures / cancelled</span><b id="aFailures">—</b></div>
        <div class="metric-line"><span>Explicit retries</span><b id="aRetries">—</b></div>
        <div class="metric-line"><span>Turns / tool calls</span><b id="aActivity">—</b></div>
      </section>
      <section class="analytics-card">
        <h3>Context tokens</h3>
        <div class="metric-line"><span>Input p50 / p95</span><b id="aInput">—</b></div>
        <div class="metric-line"><span>Input max</span><b id="aInputMax">—</b></div>
        <div class="metric-line"><span>Cache hit mean</span><b id="aCache">—</b></div>
        <div class="metric-line"><span>Uncached p50</span><b id="aUncached">—</b></div>
        <div class="metric-line"><span>Context change p50 / max</span><b id="aChurn">—</b></div>
      </section>
      <section class="analytics-card">
        <h3>Latency</h3>
        <div class="metric-line"><span>Request p50 / p95</span><b id="aLatency">—</b></div>
        <div class="metric-line"><span>Request p99 / max</span><b id="aLatencyTail">—</b></div>
        <div class="metric-line"><span>TTFT p50 / p95</span><b id="aTtft">—</b></div>
        <div class="metric-line"><span>Input↔latency r</span><b id="aCorrelation">—</b></div>
      </section>
      <section class="analytics-card">
        <h3>Errors & anomalies</h3>
        <div class="metric-line"><span>Request / tool errors</span><b id="aErrors">—</b></div>
        <div id="aAnomalies" class="empty">No supported anomalies yet.</div>
      </section>
      <section class="analytics-card">
        <h3>Per-turn</h3>
        <div class="metric-line"><span>Turn duration p50 / max</span><b id="aTurnDur">—</b></div>
        <div class="metric-line"><span>Requests / turn p50</span><b id="aReqPerTurn">—</b></div>
        <div class="metric-line"><span>Tool calls / turn p50</span><b id="aToolsPerTurn">—</b></div>
        <div class="metric-line"><span>Session duration</span><b id="aSessionDur">—</b></div>
      </section>
      <section class="analytics-card">
        <h3>Discovery (hidden context)</h3>
        <div class="metric-line"><span>Agents / skills</span><b id="aDiscAgents">—</b></div>
        <div class="metric-line"><span>Instructions / hooks</span><b id="aDiscInstr">—</b></div>
        <div class="metric-line"><span>Slash commands</span><b id="aDiscSlash">—</b></div>
        <div class="metric-line"><span>Environment</span><b id="aEnv">—</b></div>
      </section>
    </div>
    <table class="compact-table">
      <thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Errors</th><th class="num">p50 latency</th></tr></thead>
      <tbody id="modelRows"><tr><td colspan="4" class="empty">No model requests yet.</td></tr></tbody>
    </table>
    <table class="compact-table">
      <thead><tr><th>Operation</th><th class="num">Requests</th><th class="num">Errors</th><th class="num">p50 latency</th></tr></thead>
      <tbody id="operationRows"><tr><td colspan="4" class="empty">No request operations yet.</td></tr></tbody>
    </table>
    <table class="compact-table">
      <thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">p50 latency</th></tr></thead>
      <tbody id="toolRows"><tr><td colspan="4" class="empty">No tool calls yet.</td></tr></tbody>
    </table>
    <table class="compact-table">
      <thead><tr><th>Instrumentation</th><th>State</th><th>Limitation / evidence</th></tr></thead>
      <tbody id="coverageRows"></tbody>
    </table>
  </details>

  <details id="actions" data-card="actions">
    <summary>Actionable tasks to reduce context cost</summary>
    <div style="padding:8px 0 6px; color:var(--vscode-descriptionForeground); font-size:11px">Quick, high-impact fixes you can open and apply. Click an item to open the relevant file in the editor.</div>
    <ul style="margin:6px 0 12px; padding-left:18px; font-size:12px;">
      <li>Stop treating request aggregates as candidate evidence — <button data-open="apps/vscode/src/diagnosticLog.ts">Open handler</button></li>
      <li>Prefer Copilot's authoritative per-request tokens (main.jsonl) — <button data-open="apps/vscode/src/diagnosticLog.ts">Open tailer</button></li>
      <li>Candidate source lifecycle / tombstones (remove stale sources) — <button data-open="crates/contexttop-core/src/lib.rs">Open engine store</button></li>
      <li>Deduplicate large files / cap per-source bytes — <button data-open="apps/vscode/src/copilotAnalytics.ts">Open analytics</button></li>
      <li>Enforce captureLevel=off (stop collectors & purge) — <button data-open="apps/vscode/src/extension.ts">Open activation</button></li>
    </ul>
  </details>
</main>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  // Data-driven series registry: add a source kind here and the chart, legend, and
  // table pick it up automatically. Order defines draw + table + legend order.
  var SERIES = [
    { key: 'files', label: 'Files', color: '#4f9cff' },
    { key: 'tools', label: 'Tools/MCP', color: '#a06cf0' },
    { key: 'instructions', label: 'Instructions', color: '#38c5c5' },
    { key: 'selection', label: 'Selection', color: '#e5a44e' },
    { key: 'terminal', label: 'Terminal', color: '#4ec98a' },
    { key: 'history', label: 'History', color: '#9aa0a6' },
    { key: 'prompt', label: 'Prompt', color: '#e57ec9' },
    { key: 'tool_results', label: 'Tool results', color: '#c9a04e' },
    { key: 'retrieval', label: 'Retrieval', color: '#6c7ff0' },
    { key: 'unknown', label: 'Unknown', color: '#777777' }
  ];
  var COLORS = {}, LABELS = {}, ORDER = [];
  SERIES.forEach(function (s) { COLORS[s.key] = s.color; LABELS[s.key] = s.label; ORDER.push(s.key); });

  var WARN_COLOR = '#e6a04d';
  var CRIT_COLOR = '#e5484d';

  var history = [];   // { ts, total, bySource }
  var requestHistory = [];  // decomposed per-request composition points
  var mode = 'candidate';   // 'candidate' | 'request'
  var reqMetric = 'all'; // what the request chart plots
  var userChoseMode = false; // once true, stop auto-switching mode
  var lastM = null;         // last metrics event, for re-render on mode toggle
  var lastRequestTs = null; // dedupe: request events repeat on every metrics push
  var MAX_POINTS = 5000;

  // Active dataset for the chart: candidate gauge or per-request composition.
  function series() { return mode === 'request' ? requestHistory : history; }
  var warn = 40000, critical = 80000;
  var windowMs = 5 * 60000;
  var canvas = document.getElementById('chart');
  var ctx = canvas.getContext('2d');

  function fmt(n) {
    n = n || 0;
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function fmtMs(n) {
    if (typeof n !== 'number') return 'Unknown';
    return n >= 1000 ? (n / 1000).toFixed(2) + 's' : Math.round(n) + 'ms';
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function zoneColor(v) {
    if (critical > 0 && v >= critical) return CRIT_COLOR;
    if (warn > 0 && v >= warn) return WARN_COLOR;
    return getComputedStyle(document.body).getPropertyValue('--vscode-foreground') || '#fff';
  }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', function () { resize(); draw(); });

  var tooltip = document.getElementById('tooltip');
  canvas.addEventListener('mousemove', function (e) {
    var H = series();
    if (H.length < 1) { tooltip.classList.remove('on'); return; }
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var now = Date.now();
    var t0 = now - windowMs;
    var w = canvas.clientWidth;
    // Find the nearest point to the mouse x position.
    var bestDist = Infinity, bestIdx = -1;
    for (var i = 0; i < H.length; i++) {
      if (H[i].ts < t0) continue;
      var px_val = w - ((now - H[i].ts) / windowMs) * w;
      var dist = Math.abs(px_val - mx);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestDist < 20) {
      var p = H[bestIdx];
      var html = '<div class="tooltip-row"><span class="tooltip-label">Total:</span><span class="tooltip-value">' + fmt(p.total) + '</span></div>';
      for (var s = 0; s < ORDER.length; s++) {
        var kind = ORDER[s];
        var v = (p.bySource && p.bySource[kind]) || 0;
        if (v > 0) {
          html += '<div class="tooltip-row"><span class="tooltip-label">' + (LABELS[kind] || kind) + ':</span><span class="tooltip-value" style="color:' + COLORS[kind] + '">' + fmt(v) + '</span></div>';
        }
      }
      tooltip.innerHTML = html;
      tooltip.classList.add('on');
      var tipW = 140;
      var x = Math.max(0, Math.min(mx - tipW / 2, rect.width - tipW));
      var y = e.clientY - rect.top - 40;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    } else {
      tooltip.classList.remove('on');
    }
  });
  canvas.addEventListener('mouseleave', function () { tooltip.classList.remove('on'); });

  function draw() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    var H = series();
    if (H.length < 1) return;

    var now = Date.now();
    var t0 = now - windowMs;

    // Request mode scales against the model budget so overflow is visible.
    var budget = 0;
    if (mode === 'request') {
      for (var bi = 0; bi < H.length; bi++) if (H[bi].ts >= t0) budget = Math.max(budget, H[bi].budget || 0);
    }

    var maxV = 1;
    for (var i = 0; i < H.length; i++) if (H[i].ts >= t0 && H[i].total > maxV) maxV = H[i].total;
    if (mode === 'candidate' && critical > maxV) maxV = critical;
    if (mode === 'request' && budget > maxV) maxV = budget;
    maxV *= 1.1;

    // gridlines
    ctx.strokeStyle = 'rgba(128,128,128,0.15)';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 3; g++) {
      var gy = h - (h * g / 3);
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    var n = H.length;
    function px(ts) { return w - ((now - ts) / windowMs) * w; }
    function py(v) { return h - (v / maxV) * h; }

    // threshold guide lines (dashed) — candidate mode only
    function guide(v, color, label) {
      if (!v || v <= 0) return;
      var y = py(v);
      ctx.save();
      ctx.strokeStyle = color; ctx.globalAlpha = 0.55; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 0.9; ctx.fillStyle = color;
      ctx.font = '9px var(--vscode-font-family)';
      ctx.fillText(label + ' ' + fmt(v), 2, Math.max(9, y - 2));
      ctx.restore();
    }

    // Request mode renders per-request data over time; the sub-view is reqMetric.
    if (mode === 'request') {
      var pts = [];
      for (var pi = 0; pi < n; pi++) if (H[pi].ts >= t0) pts.push(H[pi]);

      // Composition: one line per context item + budget line.
      if (reqMetric === 'composition') {
        guide(budget, CRIT_COLOR, 'budget');
        var STACK = ['instructions', 'tools', 'history', 'prompt', 'unknown'];
        for (var si = 0; si < STACK.length; si++) {
          var kind = STACK[si];
          var color = COLORS[kind] || '#777';
          var any = false, started = false;
          ctx.beginPath();
          for (var li = 0; li < pts.length; li++) {
            var vv = (pts[li].bySource && pts[li].bySource[kind]) || 0;
            if (vv > 0) any = true;
            var lx = px(pts[li].ts), ly = py(vv);
            if (!started) { ctx.moveTo(lx, ly); started = true; } else ctx.lineTo(lx, ly);
          }
          if (!any) continue;
          ctx.strokeStyle = color; ctx.lineWidth = 1.75; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1;
          for (var di = 0; di < pts.length; di++) {
            var dv = (pts[di].bySource && pts[di].bySource[kind]) || 0;
            if (dv <= 0) continue;
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(px(pts[di].ts), py(dv), 2.5, 0, Math.PI * 2); ctx.fill();
          }
        }
        ctx.strokeStyle = zoneColor(0); ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
        ctx.beginPath();
        for (var ti = 0; ti < pts.length; ti++) {
          var tx = px(pts[ti].ts), ty = py(pts[ti].total);
          if (ti === 0) ctx.moveTo(tx, ty); else ctx.lineTo(tx, ty);
        }
        ctx.stroke(); ctx.globalAlpha = 1;
        for (var oi = 0; oi < pts.length; oi++) {
          if (budget > 0 && pts[oi].total > budget) {
            ctx.fillStyle = CRIT_COLOR;
            ctx.beginPath(); ctx.arc(px(pts[oi].ts), py(pts[oi].total), 3, 0, Math.PI * 2); ctx.fill();
          }
        }
        return;
      }

      // All metrics: overlay every metric, each normalized to its own visible max so
      // their shapes/trends are comparable despite different units.
      if (reqMetric === 'all') {
        var mkeys = Object.keys(METRIC_META);
        for (var mk = 0; mk < mkeys.length; mk++) {
          var meta = METRIC_META[mkeys[mk]];
          var vals = [], vmax = 0, anyv = false;
          for (var vi = 0; vi < pts.length; vi++) {
            var val = metricValue(pts, vi, mkeys[mk]);
            vals.push(val); if (val > vmax) vmax = val; if (val > 0) anyv = true;
          }
          if (!anyv || vmax <= 0) continue;
          var mstarted = false;
          ctx.beginPath();
          for (var pj = 0; pj < pts.length; pj++) {
            var nx = px(pts[pj].ts), ny = h - (vals[pj] / vmax) * h * 0.95;
            if (!mstarted) { ctx.moveTo(nx, ny); mstarted = true; } else ctx.lineTo(nx, ny);
          }
          ctx.strokeStyle = meta.color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.85; ctx.stroke(); ctx.globalAlpha = 1;
          for (var dj = 0; dj < pts.length; dj++) {
            ctx.fillStyle = meta.color;
            ctx.beginPath(); ctx.arc(px(pts[dj].ts), h - (vals[dj] / vmax) * h * 0.95, 2, 0, Math.PI * 2); ctx.fill();
          }
        }
        ctx.fillStyle = 'rgba(150,150,150,0.9)'; ctx.font = '9px var(--vscode-font-family)';
        ctx.fillText('all metrics · each normalized to its own max', 4, 10);
        return;
      }

      // Single metric in real units.
      var smeta = METRIC_META[reqMetric] || { label: reqMetric, color: '#4f9cff', unit: '' };
      var svals = [], smax = smeta.unit === '%' ? 100 : 1;
      for (var svi = 0; svi < pts.length; svi++) { var sv = metricValue(pts, svi, reqMetric); svals.push(sv); if (sv > smax) smax = sv; }
      smax *= 1.1;
      var sstarted = false;
      ctx.beginPath();
      for (var spj = 0; spj < pts.length; spj++) {
        var sx = px(pts[spj].ts), sy = h - (svals[spj] / smax) * h;
        if (!sstarted) { ctx.moveTo(sx, sy); sstarted = true; } else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = smeta.color; ctx.lineWidth = 2; ctx.globalAlpha = 0.95; ctx.stroke(); ctx.globalAlpha = 1;
      for (var sdj = 0; sdj < pts.length; sdj++) {
        ctx.fillStyle = smeta.color;
        ctx.beginPath(); ctx.arc(px(pts[sdj].ts), h - (svals[sdj] / smax) * h, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      var slatest = svals.length ? svals[svals.length - 1] : 0;
      ctx.fillStyle = smeta.color; ctx.font = '10px var(--vscode-font-family)';
      ctx.fillText(smeta.label + ' — ' + fmtMetric(slatest, smeta.unit), 4, 11);
      return;
    }

    guide(warn, WARN_COLOR, 'warn');
    guide(critical, CRIT_COLOR, 'critical');

    // per-source lines (each keeps its own color)
    for (var s = 0; s < ORDER.length; s++) {
      var kind = ORDER[s];
      var color = COLORS[kind];
      var any = false, started = false;
      ctx.beginPath();
      for (var j = 0; j < n; j++) {
        if (H[j].ts < t0) continue;
        var v = (H[j].bySource && H[j].bySource[kind]) || 0;
        if (v > 0) any = true;
        var x = px(H[j].ts), y = py(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      if (any) { ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.globalAlpha = 0.85; ctx.stroke(); ctx.globalAlpha = 1; }
    }

    // total line — segment color follows the zone (normal → amber → red)
    ctx.lineWidth = 2;
    var prev = null;
    for (var k = 0; k < n; k++) {
      if (H[k].ts < t0) continue;
      var cur = { x: px(H[k].ts), y: py(H[k].total), t: H[k].total };
      if (prev) {
        ctx.strokeStyle = zoneColor(Math.max(prev.t, cur.t));
        ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(cur.x, cur.y); ctx.stroke();
      }
      prev = cur;
    }
  }

  function renderLegend(bySource) {
    var el = document.getElementById('legend');
    var html = '';
    for (var s = 0; s < ORDER.length; s++) {
      var kind = ORDER[s];
      if (!bySource[kind]) continue;
      html += '<span><i class="swatch" style="background:' + COLORS[kind] + '"></i>' + LABELS[kind] + '</span>';
    }
    el.innerHTML = html || '<span>Collecting…</span>';
  }

  function renderTable(bySource, total) {
    var rows = document.getElementById('rows');
    var entries = [];
    for (var kind in bySource) if (bySource[kind]) entries.push([kind, bySource[kind]]);
    entries.sort(function (a, b) { return b[1] - a[1]; });
    var html = '';
    for (var i = 0; i < entries.length; i++) {
      var kind = entries[i][0], v = entries[i][1];
      var pct = total > 0 ? Math.round((v / total) * 100) : 0;
      html += '<tr>'
        + '<td><span class="name"><i class="swatch" style="background:' + (COLORS[kind] || '#777') + '"></i>' + (LABELS[kind] || kind) + '</span></td>'
        + '<td class="num">' + fmt(v) + '</td>'
        + '<td><div class="bar" style="width:' + pct + '%;background:' + (COLORS[kind] || '#777') + '"></div></td>'
        + '</tr>';
    }
    rows.innerHTML = html || '<tr><td colspan="3" style="color:var(--vscode-descriptionForeground)">' + (mode === 'request' ? 'No observed requests yet.' : 'No candidate sources yet.') + '</td></tr>';
  }

  function renderStatus(total, isReq) {
    var pill = document.getElementById('statusPill');
    var label, bg, fg = '#fff';
    if (isReq) {
      label = 'REQUEST'; bg = 'rgba(160,108,240,0.18)'; fg = '#a06cf0';
    } else if (critical > 0 && total >= critical) { label = 'CRITICAL'; bg = CRIT_COLOR; }
    else if (warn > 0 && total >= warn) { label = 'WARNING'; bg = WARN_COLOR; fg = '#1a1a1a'; }
    else { label = 'OK'; bg = 'rgba(78,201,138,0.18)'; fg = '#4ec98a'; }
    pill.textContent = label + ' · ' + fmt(total);
    pill.style.background = bg;
    pill.style.color = fg;
  }

  function setWindow(minutes) {
    windowMs = Math.max(1, minutes) * 60000;
    var label = minutes >= 60 ? (minutes / 60) + 'h' : minutes + 'm';
    document.getElementById('axLeft').textContent = '−' + label;
    var btns = document.querySelectorAll('#wsel button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', Number(btns[i].getAttribute('data-min')) === minutes);
    }
  }

  var currentLayout = '';
  function applyLayout(layout) {
    var key = layout.join(',');
    if (key === currentLayout) return;
    currentLayout = key;
    var main = document.querySelector('main');
    var cards = document.querySelectorAll('[data-card]');
    // Hide every card, then show + reorder the requested ones by appending in order.
    for (var i = 0; i < cards.length; i++) { cards[i].style.display = 'none'; }
    for (var j = 0; j < layout.length; j++) {
      var el = document.querySelector('[data-card="' + layout[j] + '"]');
      if (el) { el.style.display = ''; main.appendChild(el); }
    }
    resize();
  }

  function onMetrics(m) {
    lastM = m;
    if (m.thresholds) { warn = m.thresholds.warn || 0; critical = m.thresholds.critical || 0; }
    if (typeof m.windowMinutes === 'number') setWindow(m.windowMinutes);
    if (m.enabled) reflectEnabled(m.enabled);
    if (m.layout) applyLayout(m.layout);

    history.push({ ts: m.ts, total: m.total || 0, bySource: m.bySource || {} });
    // Record a per-request composition point when a new observed request arrives.
    if (m.request && m.request.ts !== lastRequestTs) {
      lastRequestTs = m.request.ts;
      requestHistory.push(decomposeRequest(m.request));
      // First real request → show the rich per-item view unless the user chose a mode.
      if (!userChoseMode && mode !== 'request') { setMode('request'); }
    }
    // Prune points older than the widest supported window (1h) plus one, cap memory.
    var cutoff = Date.now() - 3700000;
    while (history.length > 1 && history[0].ts < cutoff) history.shift();
    if (history.length > MAX_POINTS) history.shift();
    while (requestHistory.length > 1 && requestHistory[0].ts < cutoff) requestHistory.shift();
    if (requestHistory.length > MAX_POINTS) requestHistory.shift();

    var inv = m.inventory || {};
    document.getElementById('gTools').textContent = inv.toolsCount || 0;
    document.getElementById('gInstr').textContent = inv.instructionsCount || 0;
    document.getElementById('gFiles').textContent = inv.editorsCount || 0;
    document.getElementById('gTerms').textContent = inv.terminalsCount || 0;

    if (m.request) renderRequest(m.request);
    if (m.analytics) renderAnalytics(m.analytics);
    renderView();
  }

  // Turn an observed request into a chart point using the shared source palette.
  function decomposeRequest(r) {
    var input = r.inputTokens || 0;
    var sys = r.systemPromptTokens || 0;
    var tools = r.toolsTokens || 0;
    var prompt = r.userPromptTokens || 0;
    var other = Math.max(0, input - (sys + tools + prompt));
    return {
      ts: r.ts || Date.now(),
      total: input,
      budget: r.promptBudgetTokens || r.contextWindowTokens || 0,
      cached: r.cachedTokens || 0,
      output: r.outputTokens || 0,
      ttft: typeof r.ttftMs === 'number' ? r.ttftMs : null,
      latency: typeof r.latencyMs === 'number' ? r.latencyMs : null,
      billing: typeof r.usageNanoAiu === 'number' ? r.usageNanoAiu : null,
      bySource: { instructions: sys, tools: tools, prompt: prompt, unknown: other }
    };
  }

  // Numeric value of the selected per-request metric at point i (growth needs prev).
  function metricValue(pts, i, kind) {
    var p = pts[i];
    switch (kind) {
      case 'input': return p.total || 0;
      case 'output': return p.output || 0;
      case 'ttft': return p.ttft || 0;
      case 'latency': return p.latency || 0;
      case 'billing': return p.billing || 0;
      case 'uncached': return Math.max(0, (p.total || 0) - (p.cached || 0));
      case 'cacheHit': return p.total > 0 ? ((p.cached || 0) / p.total) * 100 : 0;
      case 'budget': return p.budget > 0 ? (p.total / p.budget) * 100 : 0;
      case 'growth': return i > 0 ? Math.abs((p.total || 0) - (pts[i - 1].total || 0)) : 0;
      default: return 0;
    }
  }

  var METRIC_META = {
    input: { label: 'Input tokens', color: '#4f9cff', unit: 'tok' },
    budget: { label: 'Budget %', color: '#e5484d', unit: '%' },
    cacheHit: { label: 'Cache hit %', color: '#4ec98a', unit: '%' },
    uncached: { label: 'Uncached tokens', color: '#c9a04e', unit: 'tok' },
    growth: { label: 'Context growth', color: '#e5a44e', unit: 'tok' },
    ttft: { label: 'TTFT', color: '#a06cf0', unit: 'ms' },
    latency: { label: 'Latency', color: '#e57ec9', unit: 'ms' },
    output: { label: 'Output tokens', color: '#38c5c5', unit: 'tok' },
    billing: { label: 'Billing', color: '#6c7ff0', unit: 'nAIU' }
  };
  function fmtMetric(v, unit) {
    if (unit === '%') return Math.round(v) + '%';
    if (unit === 'ms') return fmtMs(v);
    if (unit === 'nAIU') return String(Math.round(v));
    return fmt(v);
  }

  // Render headline, gauges, table, legend, and status for the active mode.
  function renderView() {
    var isReq = mode === 'request';
    var H = series();
    var latest = H.length ? H[H.length - 1] : null;
    var total = isReq ? (latest ? latest.total : 0) : (lastM ? lastM.total || 0 : 0);
    var bySource = isReq ? (latest ? latest.bySource : {}) : (lastM ? lastM.bySource || {} : {});

    var peak = 0;
    if (isReq) { for (var i = 0; i < H.length; i++) peak = Math.max(peak, H[i].total); }
    else { peak = lastM ? lastM.peak || 0 : 0; }

    document.getElementById('hlTotal').textContent = fmt(total);
    document.getElementById('gPeak').textContent = fmt(peak);

    var rate = 0;
    if (H.length >= 2) {
      var a = H[H.length - 2], b = H[H.length - 1];
      var dt = (b.ts - a.ts) / 1000;
      if (dt > 0) rate = Math.max(0, (b.total - a.total) / dt);
    }
    document.getElementById('gRate').textContent = fmt(rate) + '/s';

    renderStatus(total, isReq);
    updateChartLegend(bySource);
    renderTable(bySource, total);
    renderStory();
    requestAnimationFrame(draw);
  }

  // Normalize a tool name for matching lm.tools (loaded) against invoked span names.
  function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // The narrative: tools are a large, mostly-unused slice of every request.
  function renderStory() {
    var wrap = document.getElementById('story');
    if (!lastM) { return; }
    var inv = lastM.inventory || {};
    var a = lastM.analytics;
    var toolTokens = inv.toolsTotalTokens || 0;
    var toolCount = inv.toolsCount || 0;
    if (toolCount === 0 && toolTokens === 0) { wrap.classList.remove('on'); return; }

    var latest = requestHistory.length ? requestHistory[requestHistory.length - 1] : null;
    var input = latest ? latest.total : 0;
    var pct = (input > 0 && toolTokens > 0) ? Math.round((toolTokens / input) * 100) : null;

    var usedNames = (a && a.tools) ? a.tools.map(function (t) { return t.name; }) : [];
    var usedSet = {};
    usedNames.forEach(function (nm) { usedSet[normName(nm)] = true; });

    var loaded = inv.topTools || [];
    var unusedCost = 0, unusedCount = 0;
    var rows = loaded.map(function (t) {
      var used = !!usedSet[normName(t.name)];
      if (!used) { unusedCost += t.tokens; unusedCount++; }
      return { name: t.name, tokens: t.tokens, used: used };
    });

    var head = '🧰 ' + toolCount + ' tools loaded · ' + fmt(toolTokens) + ' tokens';
    if (pct !== null) { head += ' (~' + pct + '% of last request)'; }
    document.getElementById('storyHeadline').textContent = head;

    var detail = '';
    if (usedNames.length) {
      detail += 'This session Copilot actually called: ' + esc(usedNames.slice(0, 6).join(', ')) + '. ';
    } else {
      detail += 'No tool calls observed yet this session. ';
    }
    if (unusedCount > 0) {
      detail += unusedCount + ' loaded tool' + (unusedCount === 1 ? '' : 's') + " weren't called — turning them off could save ~"
        + fmt(unusedCost) + ' tokens on every request.';
    }
    document.getElementById('storyDetail').innerHTML = detail;

    // Engine-ranked recommendation (unselect_tools) — the contract-aligned fix path.
    var recEl = document.getElementById('storyRec');
    var fix = lastM.toolFix;
    if (fix && fix.fixId) {
      var shortId = String(fix.fixId).slice(-6);
      recEl.innerHTML = '💡 Engine fix: disable unrelated tools · save ~' + fmt(fix.savedMin) + '–' + fmt(fix.savedMax)
        + ' tokens <span class="chip">' + esc(fix.execution) + '</span> <span class="chip">fix ' + esc(shortId) + '</span>';
    } else {
      recEl.innerHTML = '';
    }
    rows.sort(function (x, y) { return (x.used === y.used) ? y.tokens - x.tokens : (x.used ? 1 : -1); });
    var html = '';
    for (var i = 0; i < Math.min(rows.length, 10); i++) {
      var r = rows[i];
      html += '<tr><td><span class="story-badge ' + (r.used ? 'used' : 'unused') + '">' + (r.used ? 'used' : 'unused')
        + '</span></td><td>' + esc(r.name) + '</td><td class="num" style="text-align:right">' + fmt(r.tokens) + '</td></tr>';
    }
    document.getElementById('storyTools').innerHTML = html;
    wrap.classList.add('on');
  }

  // Chart legend reflects what the graph plots: sources (candidate/composition) or metrics.
  function updateChartLegend(bySource) {
    var el = document.getElementById('legend');
    if (mode === 'request' && reqMetric === 'all') {
      var html = '';
      var keys = Object.keys(METRIC_META);
      for (var i = 0; i < keys.length; i++) {
        var meta = METRIC_META[keys[i]];
        var lv = requestHistory.length ? metricValue(requestHistory, requestHistory.length - 1, keys[i]) : 0;
        html += '<span><i class="swatch" style="background:' + meta.color + '"></i>' + meta.label + ' ' + fmtMetric(lv, meta.unit) + '</span>';
      }
      el.innerHTML = html || '<span>Waiting for requests…</span>';
      return;
    }
    if (mode === 'request' && reqMetric !== 'composition') {
      var m = METRIC_META[reqMetric];
      if (m) { el.innerHTML = '<span><i class="swatch" style="background:' + m.color + '"></i>' + m.label + '</span>'; return; }
    }
    renderLegend(bySource);
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    var btns = document.querySelectorAll('#msel button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === mode);
    }
    var req = mode === 'request';
    document.getElementById('eyebrow').textContent = req ? 'OBSERVED REQUEST · COMPOSITION' : 'LIVE CONTEXT · STREAMING';
    document.getElementById('modeTitle').textContent = req ? 'Request context composition' : 'Candidate context pressure';
    renderView();
  }

  function renderRequest(r) {
    document.getElementById('reqstrip').classList.add('on');
    document.getElementById('rIn').textContent = fmt(r.inputTokens);
    var hit = (r.inputTokens > 0 && typeof r.cachedTokens === 'number')
      ? Math.round((r.cachedTokens / r.inputTokens) * 100) + '%' : '—';
    document.getElementById('rCache').textContent = hit;
    document.getElementById('rOut').textContent = typeof r.outputTokens === 'number' ? fmt(r.outputTokens) : '—';
    document.getElementById('rLat').textContent = typeof r.latencyMs === 'number' ? (r.latencyMs / 1000).toFixed(1) + 's' : '—';
    document.getElementById('rTtft').textContent = typeof r.ttftMs === 'number' ? fmtMs(r.ttftMs) : '—';

    // Budget %: prefer the model's usable prompt budget, else its full context window.
    var budgetBase = (typeof r.promptBudgetTokens === 'number' && r.promptBudgetTokens > 0)
      ? r.promptBudgetTokens
      : (typeof r.contextWindowTokens === 'number' ? r.contextWindowTokens : 0);
    document.getElementById('rBudget').textContent = budgetBase > 0
      ? Math.round((r.inputTokens / budgetBase) * 100) + '% of ' + fmt(budgetBase) : '—';
    document.getElementById('rModel').textContent = r.model || '';

    renderRequestBreakdown(r);
  }

  // Decompose the opaque inputTokens into system prompt / tools / prompt / other,
  // using the sidecar-derived estimates. "Other" = history + files not separately known.
  function renderRequestBreakdown(r) {
    var wrap = document.getElementById('reqbreak');
    var input = r.inputTokens || 0;
    var parts = [
      { kind: 'instructions', label: 'System prompt', tokens: r.systemPromptTokens },
      { kind: 'tools', label: 'Tool schemas', tokens: r.toolsTokens },
      { kind: 'prompt', label: 'User prompt', tokens: r.userPromptTokens }
    ].filter(function (p) { return typeof p.tokens === 'number' && p.tokens > 0; });

    if (input <= 0 || parts.length === 0) {
      wrap.classList.remove('on');
      return;
    }
    var known = parts.reduce(function (sum, p) { return sum + p.tokens; }, 0);
    var other = Math.max(0, input - known);
    // Estimates use a coarse tokenizer, so parts can exceed the model-counted input.
    // Normalize widths against the larger of the two so segments always sum to 100%.
    var denom = Math.max(input, known);
    var segs = parts.slice();
    if (other > 0) {
      segs.push({ kind: 'unknown', label: 'History / files / other', tokens: other });
    }

    var stackHtml = '';
    var legendHtml = '';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var pct = denom > 0 ? (s.tokens / denom) * 100 : 0;
      var color = COLORS[s.kind] || '#777';
      stackHtml += '<div class="seg" title="' + esc(s.label + ': ' + fmt(s.tokens)) + '" style="width:' + pct.toFixed(2) + '%;background:' + color + '"></div>';
      legendHtml += '<span><i class="swatch" style="background:' + color + '"></i>' + esc(s.label) + ' ' + fmt(s.tokens) + ' (' + Math.round(pct) + '%)</span>';
    }
    document.getElementById('rStack').innerHTML = stackHtml;
    document.getElementById('rBreakLegend').innerHTML = legendHtml;
    var note = 'estimated · of ' + fmt(input) + ' input tokens';
    if (typeof r.messageCount === 'number') { note += ' · ' + r.messageCount + ' msgs'; }
    if (r.debugName) { note += ' · ' + esc(r.debugName); }
    if (typeof r.temperature === 'number') { note += ' · temp ' + r.temperature; }
    if (typeof r.topP === 'number') { note += ' · topP ' + r.topP; }
    if (typeof r.usageNanoAiu === 'number' && r.usageNanoAiu > 0) { note += ' · ' + r.usageNanoAiu + ' nAIU'; }
    document.getElementById('rBreakNote').innerHTML = note;
    wrap.classList.add('on');
  }

  function renderBreakdown(rows, targetId, emptyText) {
    var target = document.getElementById(targetId);
    if (!rows || rows.length === 0) {
      target.innerHTML = '<tr><td colspan="4" class="empty">' + esc(emptyText) + '</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      html += '<tr><td>' + esc(row.name) + '</td><td class="num">' + row.count
        + '</td><td class="num">' + row.errorCount + '</td><td class="num">'
        + (typeof row.p50LatencyMs === 'number' ? fmtMs(row.p50LatencyMs) : 'Unknown') + '</td></tr>';
    }
    target.innerHTML = html;
  }

  function renderAnalytics(a) {
    var n = a.requestCount || 0;
    document.getElementById('analyticsNote').textContent =
      'Current session · metadata only · bounded to ' + a.sampleLimit + ' samples · n=' + n + ' requests';
    document.getElementById('aRequests').textContent = String(n);
    document.getElementById('aSuccess').textContent = n > 0
      ? ((a.requestSuccesses / n) * 100).toFixed(1) + '% (' + a.requestSuccesses + '/' + n + ')'
      : 'Unknown';
    document.getElementById('aFailures').textContent = a.requestFailures + ' / ' + a.requestCancellations;
    document.getElementById('aRetries').textContent = String(a.explicitRetries);
    document.getElementById('aActivity').textContent = a.turnCount + ' / ' + a.toolCallCount;

    var input = a.inputTokens;
    document.getElementById('aInput').textContent = input ? fmt(input.p50) + ' / ' + fmt(input.p95) + ' (n=' + input.count + ')' : 'Unknown';
    document.getElementById('aInputMax').textContent = input ? fmt(input.max) : 'Unknown';
    document.getElementById('aCache').textContent = a.cacheHitRatio
      ? (a.cacheHitRatio.mean * 100).toFixed(1) + '% (n=' + a.cacheHitRatio.count + ')' : 'Unknown';
    document.getElementById('aUncached').textContent = a.uncachedTokens ? fmt(a.uncachedTokens.p50) : 'Unknown';
    document.getElementById('aChurn').textContent = a.contextChangeTokens
      ? fmt(a.contextChangeTokens.p50) + ' / ' + fmt(a.contextChangeTokens.max) + ' (n=' + a.contextChangeTokens.count + ')'
      : 'Insufficient data';

    var latency = a.requestLatencyMs;
    document.getElementById('aLatency').textContent = latency
      ? fmtMs(latency.p50) + ' / ' + fmtMs(latency.p95) + ' (n=' + latency.count + ')' : 'Unknown';
    document.getElementById('aLatencyTail').textContent = latency ? fmtMs(latency.p99) + ' / ' + fmtMs(latency.max) : 'Unknown';
    document.getElementById('aTtft').textContent = a.ttftMs
      ? fmtMs(a.ttftMs.p50) + ' / ' + fmtMs(a.ttftMs.p95) + ' (n=' + a.ttftMs.count + ')' : 'Unknown';
    document.getElementById('aCorrelation').textContent = a.inputLatencyCorrelation
      ? a.inputLatencyCorrelation.pearsonR.toFixed(2) + ' (n=' + a.inputLatencyCorrelation.sampleSize + '; association only)'
      : 'Insufficient data';
    document.getElementById('aErrors').textContent = a.requestFailures + ' / ' + a.toolFailureCount;

    document.getElementById('aTurnDur').textContent = a.turnDurationMs
      ? fmtMs(a.turnDurationMs.p50) + ' / ' + fmtMs(a.turnDurationMs.max) + ' (n=' + a.turnDurationMs.count + ')' : 'Unknown';
    document.getElementById('aReqPerTurn').textContent = a.requestsPerTurn ? String(Math.round(a.requestsPerTurn.p50)) : 'Unknown';
    document.getElementById('aToolsPerTurn').textContent = a.toolCallsPerTurn ? String(Math.round(a.toolCallsPerTurn.p50)) : 'Unknown';
    document.getElementById('aSessionDur').textContent = a.sessionDurationMs ? fmtMs(a.sessionDurationMs) : 'Unknown';

    var disc = a.discovery || {};
    var lat = disc.latencyMs || {};
    function dnum(v, ms) { return typeof v === 'number' ? (v + (typeof ms === 'number' ? ' (' + ms + 'ms)' : '')) : '—'; }
    document.getElementById('aDiscAgents').textContent = dnum(disc.agents, lat.agents) + ' / ' + dnum(disc.skills, lat.skills);
    document.getElementById('aDiscInstr').textContent = dnum(disc.instructions, lat.instructions) + ' / ' + dnum(disc.hooks, lat.hooks);
    document.getElementById('aDiscSlash').textContent = dnum(disc.slashCommands, lat.slashCommands);
    var env = a.environment || {};
    document.getElementById('aEnv').textContent = (env.copilotVersion || '?') + ' · VS Code ' + (env.vscodeVersion || '?');

    var anomalyEl = document.getElementById('aAnomalies');
    if (a.anomalies && a.anomalies.length) {
      anomalyEl.className = '';
      anomalyEl.innerHTML = a.anomalies.map(function (text) { return '<div class="anomaly">' + esc(text) + '</div>'; }).join('');
    } else {
      anomalyEl.className = 'empty';
      anomalyEl.textContent = n < 5 ? 'Insufficient sample for anomaly detection.' : 'No supported anomalies detected.';
    }

    renderBreakdown(a.models, 'modelRows', 'No model requests yet.');
    renderBreakdown(a.operations, 'operationRows', 'No request operations yet.');
    renderBreakdown(a.tools, 'toolRows', 'No tool calls yet.');
    var coverage = '';
    for (var i = 0; i < a.coverage.length; i++) {
      var item = a.coverage[i];
      coverage += '<tr><td>' + esc(item.metric) + '</td><td><span class="quality ' + item.state + '">'
        + esc(item.state) + '</span></td><td>' + esc(item.reason) + '</td></tr>';
    }
    document.getElementById('coverageRows').innerHTML = coverage;
  }

  function reflectEnabled(en) {
    var d = document.getElementById('btnDiag');
    var o = document.getElementById('btnOtlp');
    if (en.diagnostics) { d.classList.add('active'); d.textContent = 'Diagnostic logs: ON'; }
    else { d.classList.remove('active'); d.textContent = 'Enable diagnostic logs'; }
    if (en.otlp) { o.classList.add('active'); o.textContent = 'Agent Debug Log: ON'; }
    else { o.classList.remove('active'); o.textContent = 'Enable Copilot Agent Debug Log'; }
  }

  document.getElementById('btnDiag').addEventListener('click', function () {
    vscode.postMessage({ type: 'command', id: 'contextTop.enableDiagnostics' });
  });
  document.getElementById('btnOtlp').addEventListener('click', function () {
    vscode.postMessage({ type: 'command', id: 'contextTop.enableAgentDebugLog' });
  });
  var btnTools = document.getElementById('btnManageTools');
  if (btnTools) {
    btnTools.addEventListener('click', function () {
      vscode.postMessage({ type: 'command', id: 'contextTop.manageTools' });
    });
  }
  var wbtns = document.querySelectorAll('#wsel button');
  for (var wi = 0; wi < wbtns.length; wi++) {
    wbtns[wi].addEventListener('click', function () {
      var mins = Number(this.getAttribute('data-min'));
      setWindow(mins);
      vscode.postMessage({ type: 'setWindow', minutes: mins });
    });
  }
  var mbtns = document.querySelectorAll('#msel button');
  for (var mi = 0; mi < mbtns.length; mi++) {
    mbtns[mi].addEventListener('click', function () {
      userChoseMode = true;
      setMode(this.getAttribute('data-mode'));
    });
  }
  var metricSel = document.getElementById('metric');
  if (metricSel) {
    metricSel.addEventListener('change', function () {
      reqMetric = this.value;
      userChoseMode = true;
      // Picking a metric implies the request view.
      if (mode !== 'request') { setMode('request'); } else { renderView(); }
    });
  }

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'metrics') onMetrics(e.data);
  });

  // Action buttons: open workspace-relative files via the extension message handler.
  document.querySelectorAll('[data-open]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var path = this.getAttribute('data-open');
      vscode.postMessage({ type: 'command', id: 'openFile', args: [path] });
    });
  });

  // Keep the timeline scrolling even when no new events arrive.
  setInterval(function () { if (series().length >= 2) draw(); }, 1000);

  resize();
})();
</script>
</body>
</html>`;
  }
}
