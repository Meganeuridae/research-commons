import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { SubmissionStore } from '../src/storage/submission-store.js';
import type { Message } from '../src/types/submission.js';

let tmpDir: string;
let store: SubmissionStore;

const SUBMITTER = '00000000-0000-0000-0000-000000000001';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: uuidv4(),
    submission_id: '00000000-0000-0000-0000-000000000000',
    parent_message_id: null,
    order: 0,
    participant_name: 'Tester',
    participant_type: 'human',
    content_blocks: [{ type: 'text', text: 'hello' }],
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-store-test-'));
  store = new SubmissionStore(tmpDir);
  await store.init();
});

afterEach(async () => {
  await store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('SubmissionStore.createSubmission', () => {
  it('writes and reads back a single-message submission', async () => {
    const submission = await store.createSubmission(
      SUBMITTER,
      'Hello',
      'json-upload',
      [makeMessage()],
      {},
      undefined,
      'public',
      'conversation'
    );
    const fetched = await store.getSubmission(submission.id);
    expect(fetched?.title).toBe('Hello');
    expect(fetched?.visibility).toBe('public');
  });

  it('persists messages and survives a reload', async () => {
    const msg = makeMessage({ content_blocks: [{ type: 'text', text: 'important' }] });
    const submission = await store.createSubmission(
      SUBMITTER, 't', 'json-upload', [msg], {}, undefined, 'public', 'conversation'
    );

    // Reload from disk
    const fresh = new SubmissionStore(tmpDir);
    await fresh.init();
    const messages = await fresh.getMessages(submission.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content_blocks[0]).toEqual({ type: 'text', text: 'important' });
    await fresh.close();
  });

  it('listSubmissions includes new submissions after reload', async () => {
    const a = await store.createSubmission(SUBMITTER, 'A', 'json-upload', [makeMessage()], {}, undefined, 'public', 'conversation');
    const b = await store.createSubmission(SUBMITTER, 'B', 'json-upload', [makeMessage()], {}, undefined, 'public', 'conversation');

    const fresh = new SubmissionStore(tmpDir);
    await fresh.init();
    const all = await fresh.listSubmissions();
    expect(all.map(s => s.id).sort()).toEqual([a.id, b.id].sort());
    await fresh.close();
  });

  it('rejects an empty message list before any writes happen', async () => {
    await expect(
      store.createSubmission(SUBMITTER, 'x', 'json-upload', [], {}, undefined, 'public', 'conversation')
    ).rejects.toThrowError(/at least one message/);

    // Nothing should be visible
    const all = await store.listSubmissions();
    expect(all).toHaveLength(0);
  });

  it('cleans up orphaned shard data when a write fails partway', async () => {
    const id = uuidv4();
    const messages = [
      makeMessage({ id, parent_message_id: null, order: 0 }),
      makeMessage({ parent_message_id: id, order: 1 }),
    ];

    // Force a failure during the second message write by spying on the
    // sharded store. The first message goes through, then we blow up; the
    // catch block should call removeShard and the data dir should not exist.
    const sharded = (store as unknown as { store: { appendEvent: (...a: unknown[]) => Promise<void>; removeShard: (id: string) => Promise<void> } }).store;
    const originalAppend = sharded.appendEvent.bind(sharded);
    let appendCount = 0;
    const spy = vi.spyOn(sharded, 'appendEvent').mockImplementation(async (...args: unknown[]) => {
      appendCount++;
      if (appendCount === 3) throw new Error('simulated disk failure');
      return originalAppend(...(args as Parameters<typeof originalAppend>));
    });

    await expect(
      store.createSubmission(SUBMITTER, 'doomed', 'json-upload', messages, {}, undefined, 'public', 'conversation')
    ).rejects.toThrow(/simulated disk failure/);

    spy.mockRestore();

    // The submission should not be in the listing
    const all = await store.listSubmissions();
    expect(all).toHaveLength(0);

    // And the shard directory should have been removed
    const fresh = new SubmissionStore(tmpDir);
    await fresh.init();
    expect(await fresh.listSubmissions()).toHaveLength(0);
    await fresh.close();
  });
});

describe('SubmissionStore.updateSubmission', () => {
  it('throws on unknown submission ID instead of silently writing under a fake id', async () => {
    const fakeSubmission = {
      id: uuidv4(),
      title: 'ghost',
      submitter_id: SUBMITTER,
      submission_type: 'conversation' as const,
      source_type: 'json-upload' as const,
      visibility: 'public' as const,
      metadata: {},
      submitted_at: new Date(),
    };
    await expect(store.updateSubmission(fakeSubmission.id, fakeSubmission)).rejects.toThrowError(/unknown submission/);
  });

  it('applies updates to a real submission and they survive reload', async () => {
    const submission = await store.createSubmission(
      SUBMITTER, 'before', 'json-upload', [makeMessage()], {}, undefined, 'public', 'conversation'
    );

    submission.title = 'after';
    await store.updateSubmission(submission.id, submission);

    const fresh = new SubmissionStore(tmpDir);
    await fresh.init();
    const reloaded = await fresh.getSubmission(submission.id);
    expect(reloaded?.title).toBe('after');
    await fresh.close();
  });
});

describe('SubmissionStore visibility default', () => {
  it('listSubmissions omits soft-deleted submissions', async () => {
    const submission = await store.createSubmission(
      SUBMITTER, 'temp', 'json-upload', [makeMessage()], {}, undefined, 'public', 'conversation'
    );
    await store.deleteSubmission(submission.id, SUBMITTER);

    const all = await store.listSubmissions();
    expect(all).toHaveLength(0);
  });
});
