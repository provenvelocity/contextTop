import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { randomBytes } from 'crypto';

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB

/** v1 protocol envelope. */
interface Envelope {
  v: number;
  id?: string;
  type: string;
  ts: number;
  payload: unknown;
}

/** Persistent engine client per extension host. Spawns, supervises, and restarts the engine. */
export class EngineClient {
  private child?: cp.ChildProcess;
  private sessionId: string;
  private nonce: string;
  private requestId: number = 0;
  private pending = new Map<string, (envelope: Envelope) => void>();
  private lineBuf = Buffer.alloc(0);
  private eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
  private restartCount = 0;
  private maxRestarts = 1;
  private isShuttingDown = false;
  private output: vscode.OutputChannel;

  constructor(private readonly extensionPath: string) {
    this.sessionId = randomBytes(8).toString('hex').toUpperCase();
    this.nonce = randomBytes(16).toString('hex');
    this.output = vscode.window.createOutputChannel('contextTop Engine');
    this.output.show(true);
  }

  /** Start the engine and perform the hello handshake. */
  async start(): Promise<void> {
    if (this.child && !this.child.killed) {
      return; // Already running.
    }

    this.restartCount = 0;
    await this._start();
  }

  private async _start(): Promise<void> {
    const enginePath = path.join(this.extensionPath, '..', '..', 'target', 'debug', 'engine');
    this.output.appendLine(`[${new Date().toISOString()}] Spawning engine: ${enginePath}`);

    this.child = cp.spawn(enginePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!this.child.stdin || !this.child.stdout) {
      throw new Error('Failed to establish stdio pipes with engine');
    }

    // A spawn failure (ENOENT/EACCES) emits 'error' asynchronously; without a listener
    // Node throws it as an uncaught exception and crashes the extension host.
    this.child.on('error', (err) => {
      this.output.appendLine(`[ERROR] Engine process error: ${err.message}`);
    });
    // Guard the stdio streams too: a dead engine turns the next write into an unhandled
    // EPIPE 'error' on stdin, which would otherwise crash the host.
    this.child.stdin.on('error', (err) => {
      this.output.appendLine(`[ERROR] Engine stdin error: ${err.message}`);
    });
    this.child.stdout.on('error', (err) => {
      this.output.appendLine(`[ERROR] Engine stdout error: ${err.message}`);
    });
    this.child.stderr?.on('error', (err) => {
      this.output.appendLine(`[ERROR] Engine stderr error: ${err.message}`);
    });

    // Attach stdout reader.
    this.child.stdout.on('data', (data: Buffer) => {
      this._onData(data);
    });

    // Attach stderr for diagnostics.
    this.child.stderr?.on('data', (data: Buffer) => {
      this.output.appendLine(`[ENGINE STDERR] ${data.toString().trim()}`);
    });

    // Attach process exit handler.
    this.child.on('exit', (code) => {
      this.output.appendLine(`[${new Date().toISOString()}] Engine exited with code ${code}`);
      if (!this.isShuttingDown && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        this.output.appendLine(`[${new Date().toISOString()}] Restarting engine (attempt ${this.restartCount}/${this.maxRestarts})`);
        this._start().catch(err => {
          this.output.appendLine(`[ERROR] Failed to restart: ${err.message}`);
        });
      }
    });

    // Perform hello handshake.
    await this._hello();
  }

  private async _hello(): Promise<void> {
    const hello: Envelope = {
      v: 1,
      id: this._nextId(),
      type: 'request.hello',
      ts: Date.now(),
      payload: {
        nonce: this.nonce,
        adapterVersion: '0.1.0',
        sessionId: this.sessionId,
        capabilities: ['signals.editor', 'signals.terminalShellExecution', 'signals.tools', 'signals.participant'],
      },
    };

    const response = await this._request(hello);
    if (response.type !== 'response.hello') {
      throw new Error(`Unexpected response to hello: ${response.type}`);
    }
    const payload = response.payload as { nonce?: string; engineVersion?: string };
    if (payload.nonce !== this.nonce) {
      throw new Error('Engine nonce mismatch');
    }
    this.output.appendLine(`[${new Date().toISOString()}] Handshake complete. Engine v${payload.engineVersion}`);
  }

  /** Send a request and wait for the correlated response. */
  async request(msg_type: string, payload: unknown): Promise<Envelope> {
    // Inject the authoritative session ID into every request payload so the
    // engine's post-hello session check passes.
    const enrichedPayload =
      payload && typeof payload === 'object'
        ? { ...(payload as Record<string, unknown>), sessionId: this.sessionId }
        : payload;
    const envelope: Envelope = {
      v: 1,
      id: this._nextId(),
      type: msg_type,
      ts: Date.now(),
      payload: enrichedPayload,
    };
    return this._request(envelope);
  }

  private async _request(envelope: Envelope): Promise<Envelope> {
    if (!this.child?.stdin || !this.child.stdin.writable) {
      throw new Error('Engine is not running');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.pending.delete(envelope.id!);
          reject(new Error(`Request ${envelope.id} timed out`));
        },
        5000
      );

      this.pending.set(envelope.id!, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      const line = JSON.stringify(envelope) + '\n';
      try {
        this.child!.stdin!.write(line, (err) => {
          if (err) {
            clearTimeout(timeout);
            this.pending.delete(envelope.id!);
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(envelope.id!);
        reject(err as Error);
      }
    });
  }

  /** Register a handler for an event type. Multiple handlers per type are supported. */
  onEvent(type: string, handler: (payload: unknown) => void): void {
    const list = this.eventHandlers.get(type) ?? [];
    list.push(handler);
    this.eventHandlers.set(type, list);
  }

  /** Gracefully shut down the engine. */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    if (!this.child?.stdin) {
      return;
    }

    try {
      const shutdown: Envelope = {
        v: 1,
        id: this._nextId(),
        type: 'request.shutdown',
        ts: Date.now(),
        payload: { sessionId: this.sessionId },
      };
      await this._request(shutdown);
    } catch (err) {
      this.output.appendLine(`[WARN] Shutdown request failed: ${err}`);
    }

    this.child?.kill();
  }

  /** Process incoming data from engine stdout. */
  private _onData(data: Buffer): void {
    this.lineBuf = Buffer.concat([this.lineBuf, data]);

    while (this.lineBuf.length > 0) {
      const newlineIdx = this.lineBuf.indexOf('\n');
      if (newlineIdx === -1) {
        // Check for oversized line.
        if (this.lineBuf.length > MAX_MESSAGE_BYTES) {
          this.output.appendLine('[ERROR] Message exceeds 1 MiB; dropping');
          this.lineBuf = Buffer.alloc(0);
        }
        break;
      }

      const line = this.lineBuf.slice(0, newlineIdx);
      this.lineBuf = this.lineBuf.slice(newlineIdx + 1);

      if (line.length === 0) {
        continue; // Skip empty lines.
      }

      try {
        const envelope = JSON.parse(line.toString('utf8')) as Envelope;
        this._onEnvelope(envelope);
      } catch (err) {
        this.output.appendLine(`[ERROR] Failed to parse message: ${err}`);
      }
    }
  }

  private _onEnvelope(envelope: Envelope): void {
    // Match by id (request/response).
    if (envelope.id && this.pending.has(envelope.id)) {
      const handler = this.pending.get(envelope.id)!;
      this.pending.delete(envelope.id);
      handler(envelope);
      return;
    }

    // Dispatch event by type to all registered handlers.
    const handlers = this.eventHandlers.get(envelope.type);
    if (handlers && handlers.length > 0) {
      for (const handler of handlers) {
        handler(envelope.payload);
      }
      return;
    }

    this.output.appendLine(`[WARN] Unhandled message: ${envelope.type}`);
  }

  private _nextId(): string {
    return (++this.requestId).toString(36);
  }
}
