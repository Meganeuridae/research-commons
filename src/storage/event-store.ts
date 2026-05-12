import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

export interface Event {
  timestamp: Date;
  type: string;
  data: any;
}

/**
 * Append-only JSONL event store
 */
export class EventStore {
  private filePath: string;
  private writeHandle: fs.FileHandle | null = null;
  // Serialize writes through a promise chain so concurrent appends can't
  // interleave. POSIX guarantees atomicity for O_APPEND only under PIPE_BUF
  // (typically 4KB), and submissions can contain image data well above that.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    // Open file for appending
    this.writeHandle = await fs.open(this.filePath, 'a');
  }

  async appendEvent(event: Event): Promise<void> {
    if (!this.writeHandle) {
      throw new Error('EventStore not initialized');
    }

    const line = JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString()
    }) + '\n';

    const handle = this.writeHandle;
    const performWrite = async (): Promise<void> => {
      await handle.write(line);
      await handle.sync();
    };

    // Chain regardless of prior fulfillment/rejection so one failed write
    // does not poison subsequent writes.
    const next = this.writeChain.then(performWrite, performWrite);
    this.writeChain = next.catch(() => {
      // Swallow on the chain reference so the chain itself never holds a
      // rejected state; individual callers still observe their own errors
      // via the `next` they're awaiting below.
    });
    await next;
  }

  async loadEvents(): Promise<Event[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      if (!content.trim()) return [];

      return content
        .trim()
        .split('\n')
        .map(line => {
          const event = JSON.parse(line);
          return {
            ...event,
            timestamp: new Date(event.timestamp)
          };
        });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.writeHandle) {
      await this.writeHandle.close();
      this.writeHandle = null;
    }
  }
}

/**
 * Manages event stores sharded by ID (e.g., by submission)
 */
export class ShardedEventStore {
  private basePath: string;
  private stores: Map<string, EventStore> = new Map();

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private getShardPath(id: string, filename: string): string {
    // Shard by first 2 chars of UUID
    const shard = id.substring(0, 2);
    return path.join(this.basePath, shard, id, filename);
  }

  async getStore(id: string, filename: string): Promise<EventStore> {
    const key = `${id}:${filename}`;
    
    if (!this.stores.has(key)) {
      const store = new EventStore(this.getShardPath(id, filename));
      await store.init();
      this.stores.set(key, store);
    }

    return this.stores.get(key)!;
  }

  async appendEvent(id: string, filename: string, event: Event): Promise<void> {
    const store = await this.getStore(id, filename);
    await store.appendEvent(event);
  }

  async loadEvents(id: string, filename: string): Promise<Event[]> {
    const store = await this.getStore(id, filename);
    return await store.loadEvents();
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.stores.values()).map(store => store.close())
    );
    this.stores.clear();
  }

  /**
   * Close all open handles for a given id and remove its shard directory.
   * Used to clean up orphaned data after a partially-failed create.
   */
  async removeShard(id: string): Promise<void> {
    const shardDir = path.join(this.basePath, id.substring(0, 2), id);

    // Close and forget any open handles under this id
    const toClose: Promise<void>[] = [];
    for (const [key, store] of this.stores.entries()) {
      if (key.startsWith(`${id}:`)) {
        toClose.push(store.close());
        this.stores.delete(key);
      }
    }
    await Promise.all(toClose);

    await fs.rm(shardDir, { recursive: true, force: true });
  }
}

