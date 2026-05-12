import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EventStore, ShardedEventStore } from '../src/storage/event-store.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'event-store-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('EventStore.appendEvent', () => {
  it('writes a single event and reads it back', async () => {
    const store = new EventStore(path.join(tmpDir, 'events.jsonl'));
    await store.init();
    await store.appendEvent({ timestamp: new Date('2025-01-01T00:00:00Z'), type: 'foo', data: { x: 1 } });
    const events = await store.loadEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('foo');
    expect(events[0].data).toEqual({ x: 1 });
    await store.close();
  });

  it('serializes concurrent large appends without corrupting the JSONL', async () => {
    // Regression test for the JSONL race: writes larger than PIPE_BUF (4KB)
    // can interleave on platforms where O_APPEND atomicity is only guaranteed
    // for small writes. The fix is a per-handle promise chain.
    const store = new EventStore(path.join(tmpDir, 'events.jsonl'));
    await store.init();

    const big = 'a'.repeat(8 * 1024); // 8 KB payload, well above PIPE_BUF
    const N = 50;
    const writes = Array.from({ length: N }, (_, i) =>
      store.appendEvent({ timestamp: new Date(), type: 'big', data: { i, big } })
    );
    await Promise.all(writes);

    const events = await store.loadEvents();
    expect(events).toHaveLength(N);
    // Each event's data.i should appear exactly once; data.big should be intact
    const seen = new Set<number>();
    for (const e of events) {
      expect(e.type).toBe('big');
      expect(e.data.big).toBe(big);
      expect(seen.has(e.data.i)).toBe(false);
      seen.add(e.data.i);
    }
    expect(seen.size).toBe(N);
    await store.close();
  });

  it('does not poison the chain when one write fails', async () => {
    // After closing the handle, subsequent appends fail. But the chain should
    // still accept new appends once we reopen.
    const filePath = path.join(tmpDir, 'events.jsonl');
    const store = new EventStore(filePath);
    await store.init();
    await store.appendEvent({ timestamp: new Date(), type: 'ok', data: {} });
    await store.close();

    // Force an error: appending after close
    await expect(
      store.appendEvent({ timestamp: new Date(), type: 'fail', data: {} })
    ).rejects.toThrow();

    // Reinit and write again — should not be blocked by the prior failure
    await store.init();
    await store.appendEvent({ timestamp: new Date(), type: 'recovered', data: {} });
    const events = await store.loadEvents();
    expect(events.map(e => e.type)).toEqual(['ok', 'recovered']);
    await store.close();
  });
});

describe('ShardedEventStore.removeShard', () => {
  it('closes handles and deletes the shard directory', async () => {
    const sharded = new ShardedEventStore(tmpDir);
    const id = 'abcdef01-2345-6789-abcd-ef0123456789';
    await sharded.appendEvent(id, 'metadata.jsonl', { timestamp: new Date(), type: 'x', data: {} });

    const shardDir = path.join(tmpDir, id.substring(0, 2), id);
    await expect(fs.access(shardDir)).resolves.toBeUndefined();

    await sharded.removeShard(id);

    await expect(fs.access(shardDir)).rejects.toThrow();
  });

  it('is safe to call when the shard does not exist', async () => {
    const sharded = new ShardedEventStore(tmpDir);
    await expect(sharded.removeShard('does-not-exist')).resolves.toBeUndefined();
  });
});
