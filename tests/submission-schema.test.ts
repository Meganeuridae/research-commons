import { describe, it, expect } from 'vitest';
import { CreateSubmissionRequestSchema, UpdateSubmissionRequestSchema } from '../src/types/submission.js';

const validMessage = {
  parent_message_id: null,
  order: 0,
  participant_name: 'Tester',
  participant_type: 'human' as const,
  content_blocks: [{ type: 'text' as const, text: 'hi' }],
};

describe('CreateSubmissionRequestSchema', () => {
  it('accepts a minimal valid submission', () => {
    const parsed = CreateSubmissionRequestSchema.parse({
      title: 'Hello',
      source_type: 'json-upload',
      messages: [validMessage],
    });
    expect(parsed.title).toBe('Hello');
    expect(parsed.messages).toHaveLength(1);
  });

  it('rejects an empty messages array', () => {
    expect(() => CreateSubmissionRequestSchema.parse({
      title: 'x',
      source_type: 'json-upload',
      messages: [],
    })).toThrow();
  });

  it('rejects a messages array longer than the cap', () => {
    const messages = Array.from({ length: 5001 }, () => validMessage);
    expect(() => CreateSubmissionRequestSchema.parse({
      title: 'x',
      source_type: 'json-upload',
      messages,
    })).toThrow();
  });

  it('rejects an empty title', () => {
    expect(() => CreateSubmissionRequestSchema.parse({
      title: '',
      source_type: 'json-upload',
      messages: [validMessage],
    })).toThrow();
  });

  it('rejects an absurdly long title', () => {
    expect(() => CreateSubmissionRequestSchema.parse({
      title: 'x'.repeat(501),
      source_type: 'json-upload',
      messages: [validMessage],
    })).toThrow();
  });
});

describe('UpdateSubmissionRequestSchema', () => {
  it('accepts an empty object (no-op update)', () => {
    expect(() => UpdateSubmissionRequestSchema.parse({})).not.toThrow();
  });

  it('accepts known fields', () => {
    const parsed = UpdateSubmissionRequestSchema.parse({
      title: 'new title',
      visibility: 'public',
      tags: ['a', 'b'],
    });
    expect(parsed.title).toBe('new title');
  });

  it('rejects unknown fields (mass-assignment prevention)', () => {
    expect(() => UpdateSubmissionRequestSchema.parse({
      title: 'ok',
      submitter_id: '00000000-0000-0000-0000-000000000099',
    })).toThrow();
    expect(() => UpdateSubmissionRequestSchema.parse({
      title: 'ok',
      submitted_at: new Date(),
    })).toThrow();
    expect(() => UpdateSubmissionRequestSchema.parse({
      roles: ['admin'],
    })).toThrow();
  });

  it('rejects invalid visibility values', () => {
    expect(() => UpdateSubmissionRequestSchema.parse({
      visibility: 'wide-open',
    })).toThrow();
  });

  it('rejects oversized title', () => {
    expect(() => UpdateSubmissionRequestSchema.parse({
      title: 'x'.repeat(501),
    })).toThrow();
  });
});
