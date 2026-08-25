import * as path from 'node:path';
import { ServeClient } from './client';
import type { BinaryInfo } from './binary';

/**
 * Owns one `amxb serve` process per manifest file. The serve server serves a
 * single stdin channel, so every project gets its own process, spawned with
 * cwd = project root (matching how `amxb serve` auto-detects manifests).
 */

export interface ServeManagerDeps {
  /** Resolve the amxb binary (memoized upstream). Throws when not found. */
  readonly getBinary: () => Promise<BinaryInfo>;
  readonly onStderr: (manifestPath: string, line: string) => void;
  readonly onClientCreated?: (client: ServeClient, manifestPath: string) => void;
  readonly onClientExit?: (client: ServeClient, manifestPath: string) => void;
}

export interface ActiveClient {
  readonly manifestPath: string;
  readonly client: ServeClient;
}

export class ServeManager {
  private readonly pending = new Map<string, Promise<ServeClient>>();
  private readonly ready = new Map<string, ServeClient>();

  constructor(private readonly deps: ServeManagerDeps) {}

  /** Return (spawning on first use) the client for the given manifest. */
  async getForManifest(manifestPath: string, cwd: string): Promise<ServeClient> {
    const key = this.normalizeKey(manifestPath);

    const existing = this.ready.get(key);
    if (existing?.running) return existing;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const promise = this.spawn(manifestPath, cwd, key);
    this.pending.set(key, promise);
    try {
      const client = await promise;
      this.ready.set(key, client);
      return client;
    } catch (err) {
      this.pending.delete(key);
      throw err;
    } finally {
      this.pending.delete(key);
    }
  }

  get activeClients(): readonly ActiveClient[] {
    const result: ActiveClient[] = [];
    for (const [key, client] of this.ready) {
      if (client.running) result.push({ manifestPath: key, client });
    }
    return result;
  }

  async stopAll(): Promise<void> {
    const stops: Array<Promise<void>> = [
      ...[...this.ready.values()].map((c) => c.stop()),
      ...[...this.pending.values()].map((p) => p.then((c) => c.stop()).catch(() => undefined)),
    ];
    this.ready.clear();
    this.pending.clear();
    await Promise.allSettled(stops);
  }

  private async spawn(manifestPath: string, cwd: string, key: string): Promise<ServeClient> {
    const binary = await this.deps.getBinary();
    const client = new ServeClient({
      command: binary.command,
      args: binary.args,
      cwd,
      shell: binary.needsShell,
      label: path.basename(cwd),
      onStderr: (line) => this.deps.onStderr(manifestPath, line),
    });

    this.deps.onClientCreated?.(client, manifestPath);
    client.onExit((info) => {
      if (this.ready.get(key) === client) this.ready.delete(key);
      this.deps.onClientExit?.(client, manifestPath);
      void info;
    });

    try {
      await client.start();
      return client;
    } catch (err) {
      await client.stop().catch(() => undefined);
      throw err;
    }
  }

  private normalizeKey(manifestPath: string): string {
    const abs = path.resolve(manifestPath);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }
}
