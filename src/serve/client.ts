import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import * as fs from 'node:fs';

/**
 * Line-delimited JSON-RPC 2.0 client over an `amxb serve` child process.
 *
 * - One JSON object per line on stdout; responses are matched to pending
 *   requests by `id`, notifications are dispatched to registered handlers
 *   (never blocking — handlers run without awaiting).
 * - `request()` never blocks the stdout reader, so push notifications
 *   (build.*, watch.changed) keep flowing while a long request like
 *   `build.start` is in flight.
 * - Server logs arrive on stderr and are tailed + forwarded.
 */

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export interface ServeExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
  readonly message?: string;
}

export interface ServeClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  /** Working directory of the serve process (project root). */
  readonly cwd: string;
  readonly shell?: boolean;
  /** Prefix for stderr log lines. */
  readonly label?: string;
  readonly onStderr?: (line: string) => void;
  /** Default request timeout in ms (0 = never). Default: 60_000. */
  readonly requestTimeoutMs?: number;
  /** How many serve.ping attempts before start() fails. Default: 8. */
  readonly spawnRetries?: number;
  readonly spawnRetryDelayMs?: number;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: unknown) => void;
  readonly timer: NodeJS.Timeout | undefined;
  readonly method: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const PING_TIMEOUT_MS = 15_000;
const MAX_STDERR_TAIL = 40;

// allow: SIZE_OK — single cohesive JSON-RPC transport (lifecycle + framing are inseparable).
export class ServeClient {
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private readonly notifyHandlers = new Set<(method: string, params: unknown) => void>();
  private readonly exitListeners = new Set<(info: ServeExitInfo) => void>();
  private readonly stderrTail: string[] = [];
  private stopped = true;

  constructor(private readonly options: ServeClientOptions) {}

  get running(): boolean {
    return !this.stopped && this.child !== null && this.child.exitCode === null;
  }

  get label(): string {
    return this.options.label ?? this.options.cwd;
  }

  /** Spawn the process and wait until it answers serve.ping. */
  async start(): Promise<void> {
    if (this.running) return;

    this.stopped = false;
    this.stderrTail.length = 0;

    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      shell: this.options.shell === true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child = child;

    const rl = readline.createInterface({ input: child.stdout ?? fs.createReadStream('/dev/null'), terminal: false });
    this.rl = rl;
    rl.on('line', (line) => this.handleLine(line));

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.length === 0) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > MAX_STDERR_TAIL) this.stderrTail.shift();
        this.options.onStderr?.(line);
      }
    });

    const onError = (err: Error) => this.handleExit({ code: null, signal: null, message: err.message });
    child.on('error', onError);
    child.on('exit', (code, signal) => this.handleExit({ code, signal }));

    await this.waitReady();
  }

  /** Close stdin (server exits on EOF), kill after a grace period. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const child = this.child;
    this.child = null;
    this.rl?.close();
    this.rl = null;

    this.rejectPending(new RpcError(-32000, `amxb serve stopped (${this.label})`));

    if (!child || child.exitCode !== null) return;

    let settled = false;
    const done = new Promise<void>((resolve) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      child.once('error', finish);
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish();
      }, 2_000).unref();
    });

    try {
      child.stdin?.end();
    } catch {
      /* stdin already closed */
    }
    await done;
  }

  /**
   * Send a request and await its response.
   * @param timeoutMs 0 disables the timeout (use for long requests).
   */
  request<T = unknown>(method: string, params?: unknown, options?: { readonly timeoutMs?: number }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.running || !this.child?.stdin?.writable) {
        reject(new RpcError(-32000, `amxb serve is not running (${this.label})`));
        return;
      }

      const id = this.nextId++;
      const timeoutMs = options?.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(-32000, `Request "${method}" timed out after ${timeoutMs}ms (${this.label})`));
        }, timeoutMs);
      }

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });

      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new RpcError(-32000, `Failed to write request "${method}": ${String(err)}`));
      }
    });
  }

  /** Subscribe to server push notifications. Returns an unsubscribe function. */
  onNotify(handler: (method: string, params: unknown) => void): () => void {
    this.notifyHandlers.add(handler);
    return () => this.notifyHandlers.delete(handler);
  }

  /** Subscribe to process exit (after stop() or a crash). */
  onExit(handler: (info: ServeExitInfo) => void): () => void {
    this.exitListeners.add(handler);
    return () => this.exitListeners.delete(handler);
  }

  /** Last N stderr lines — useful for crash diagnostics. */
  stderrSummary(): string {
    return this.stderrTail.join('\n');
  }

  private async waitReady(): Promise<void> {
    const retries = this.options.spawnRetries ?? 8;
    const delay = this.options.spawnRetryDelayMs ?? 1_000;

    for (let attempt = 0; attempt < retries; attempt++) {
      if (!this.running) {
        throw this.exitError(`amxb serve exited before becoming ready`);
      }
      try {
        await this.request<{ ok: boolean }>('serve.ping', undefined, { timeoutMs: PING_TIMEOUT_MS });
        return;
      } catch (err) {
        if (!this.running) {
          throw this.exitError(`amxb serve exited before becoming ready`);
        }
        if (attempt === retries - 1) {
          throw new Error(`amxb serve did not respond to serve.ping in time (${this.label})`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private exitError(context: string): RpcError {
    const tail = this.stderrSummary();
    const detail = tail ? `\n${tail.slice(-1_500)}` : '';
    return new RpcError(-32000, `${context} (${this.label})${detail}`);
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;

    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore stray non-JSON output (should not happen on a healthy server)
    }
    if (typeof msg !== 'object' || msg === null) return;

    const record = msg as { id?: unknown; method?: unknown; result?: unknown; error?: unknown; params?: unknown };

    if (record.id !== undefined && record.id !== null) {
      const pending = this.pending.get(Number(record.id));
      if (pending) {
        this.pending.delete(Number(record.id));
        if (pending.timer) clearTimeout(pending.timer);
        if (record.error && typeof record.error === 'object') {
          const err = record.error as { code?: unknown; message?: unknown; data?: unknown };
          pending.reject(new RpcError(Number(err.code ?? -32603), String(err.message ?? 'RPC error'), err.data));
        } else {
          pending.resolve(record.result);
        }
      }
      return;
    }

    if (typeof record.method === 'string') {
      const params = record.params;
      for (const handler of [...this.notifyHandlers]) {
        try {
          handler(record.method, params);
        } catch (err) {
          // A broken handler must not break the wire protocol.
          console.error(`[serve-client] notify handler failed: ${String(err)}`);
        }
      }
    }
  }

  private handleExit(info: ServeExitInfo): void {
    if (this.stopped && this.child === null) return;
    this.stopped = true;
    this.child = null;
    this.rl?.close();
    this.rl = null;

    const err = this.exitError(`amxb serve exited (code=${info.code ?? 'null'}, signal=${info.signal ?? 'none'})`);
    this.rejectPending(err);

    for (const handler of [...this.exitListeners]) {
      try {
        handler(info);
      } catch {
        /* listener errors are isolated */
      }
    }
  }

  private rejectPending(err: RpcError): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
