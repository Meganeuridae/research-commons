import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import type { Submission } from '../src/types/submission.js';
import type { User } from '../src/types/research.js';
import { checkSubmissionAccess } from '../src/middleware/submission-auth.js';

// Stable test secret so jwt.sign succeeds inside parseAuthFromHeaders.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(64);
const JWT_SECRET = process.env.JWT_SECRET!;

const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const STRANGER_ID = '00000000-0000-0000-0000-000000000002';

function makeSubmission(visibility: Submission['visibility']): Submission {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    title: 't',
    submitter_id: OWNER_ID,
    submission_type: 'conversation',
    source_type: 'json-upload',
    visibility,
    metadata: {},
    submitted_at: new Date(),
  };
}

function mockStore(submission: Submission | null) {
  return {
    submissionStore: {
      // The helper only calls .getSubmission. Cast through unknown so we
      // don't have to mock the full SubmissionStore surface.
      getSubmission: async (_id: string) => submission,
    } as unknown as import('../src/storage/submission-store.js').SubmissionStore,
  };
}

function makeReq(token?: string): Request {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as Request;
}

function tokenFor(userId: string, roles: User['roles']): string {
  return jwt.sign({ userId, email: `${userId}@x`, roles }, JWT_SECRET);
}

const ANON = makeReq();
const CONTRIBUTOR = makeReq(tokenFor(STRANGER_ID, ['contributor']));
const RATER = makeReq(tokenFor(STRANGER_ID, ['rater']));
const RESEARCHER = makeReq(tokenFor(STRANGER_ID, ['researcher']));
const ADMIN = makeReq(tokenFor(STRANGER_ID, ['admin']));
const OWNER = makeReq(tokenFor(OWNER_ID, ['contributor']));

describe('checkSubmissionAccess: 404 / missing submission', () => {
  it('returns 404 when the submission does not exist', async () => {
    const ctx = mockStore(null);
    const r = await checkSubmissionAccess(ctx, ANON, 'whatever', 'read');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.error).toMatch(/not found/i);
    }
  });
});

describe('checkSubmissionAccess: public visibility', () => {
  const ctx = () => mockStore(makeSubmission('public'));

  it('anyone can read', async () => {
    for (const req of [ANON, CONTRIBUTOR, RATER, RESEARCHER, ADMIN, OWNER]) {
      const r = await checkSubmissionAccess(ctx(), req, 'id', 'read');
      expect(r.ok).toBe(true);
    }
  });
  it('anonymous cannot annotate (auth required)', async () => {
    const r = await checkSubmissionAccess(ctx(), ANON, 'id', 'annotate');
    expect(r.ok).toBe(false);
  });
  it('any authenticated user can annotate', async () => {
    const r = await checkSubmissionAccess(ctx(), CONTRIBUTOR, 'id', 'annotate');
    expect(r.ok).toBe(true);
  });
  it('only owner/researcher/admin can modify', async () => {
    expect((await checkSubmissionAccess(ctx(), ANON, 'id', 'modify')).ok).toBe(false);
    expect((await checkSubmissionAccess(ctx(), CONTRIBUTOR, 'id', 'modify')).ok).toBe(false);
    expect((await checkSubmissionAccess(ctx(), RATER, 'id', 'modify')).ok).toBe(false);
    expect((await checkSubmissionAccess(ctx(), RESEARCHER, 'id', 'modify')).ok).toBe(true);
    expect((await checkSubmissionAccess(ctx(), ADMIN, 'id', 'modify')).ok).toBe(true);
    expect((await checkSubmissionAccess(ctx(), OWNER, 'id', 'modify')).ok).toBe(true);
  });
});

describe('checkSubmissionAccess: unlisted visibility (same as public for these decisions)', () => {
  const ctx = () => mockStore(makeSubmission('unlisted'));

  it('anonymous can read', async () => {
    const r = await checkSubmissionAccess(ctx(), ANON, 'id', 'read');
    expect(r.ok).toBe(true);
  });
  it('contributor can annotate', async () => {
    const r = await checkSubmissionAccess(ctx(), CONTRIBUTOR, 'id', 'annotate');
    expect(r.ok).toBe(true);
  });
});

describe('checkSubmissionAccess: researcher visibility', () => {
  const ctx = () => mockStore(makeSubmission('researcher'));

  it('anonymous cannot read', async () => {
    const r = await checkSubmissionAccess(ctx(), ANON, 'id', 'read');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
  it('plain contributor cannot read', async () => {
    expect((await checkSubmissionAccess(ctx(), CONTRIBUTOR, 'id', 'read')).ok).toBe(false);
  });
  it('rater cannot read (rater is not researcher)', async () => {
    expect((await checkSubmissionAccess(ctx(), RATER, 'id', 'read')).ok).toBe(false);
  });
  it('researcher can read', async () => {
    expect((await checkSubmissionAccess(ctx(), RESEARCHER, 'id', 'read')).ok).toBe(true);
  });
  it('admin can read', async () => {
    expect((await checkSubmissionAccess(ctx(), ADMIN, 'id', 'read')).ok).toBe(true);
  });
  it('owner can read regardless of role', async () => {
    expect((await checkSubmissionAccess(ctx(), OWNER, 'id', 'read')).ok).toBe(true);
  });
  it('contributor cannot annotate (read fails first)', async () => {
    expect((await checkSubmissionAccess(ctx(), CONTRIBUTOR, 'id', 'annotate')).ok).toBe(false);
  });
  it('researcher can annotate', async () => {
    expect((await checkSubmissionAccess(ctx(), RESEARCHER, 'id', 'annotate')).ok).toBe(true);
  });
});

describe('checkSubmissionAccess: private visibility', () => {
  const ctx = () => mockStore(makeSubmission('private'));

  it('anonymous cannot read', async () => {
    expect((await checkSubmissionAccess(ctx(), ANON, 'id', 'read')).ok).toBe(false);
  });
  it('contributor cannot read', async () => {
    expect((await checkSubmissionAccess(ctx(), CONTRIBUTOR, 'id', 'read')).ok).toBe(false);
  });
  it('researcher cannot read (private is admin+owner only)', async () => {
    expect((await checkSubmissionAccess(ctx(), RESEARCHER, 'id', 'read')).ok).toBe(false);
  });
  it('admin can read', async () => {
    expect((await checkSubmissionAccess(ctx(), ADMIN, 'id', 'read')).ok).toBe(true);
  });
  it('owner can read', async () => {
    expect((await checkSubmissionAccess(ctx(), OWNER, 'id', 'read')).ok).toBe(true);
  });
  it('researcher cannot modify a private submission they cannot read', async () => {
    expect((await checkSubmissionAccess(ctx(), RESEARCHER, 'id', 'modify')).ok).toBe(false);
  });
  it('admin can modify', async () => {
    expect((await checkSubmissionAccess(ctx(), ADMIN, 'id', 'modify')).ok).toBe(true);
  });
});

describe('checkSubmissionAccess: legacy submissions with no visibility default to public', () => {
  it('treats missing visibility as public', async () => {
    const submission = { ...makeSubmission('public'), visibility: undefined as unknown as Submission['visibility'] };
    const ctx = mockStore(submission);
    expect((await checkSubmissionAccess(ctx, ANON, 'id', 'read')).ok).toBe(true);
  });
});

describe('checkSubmissionAccess: unknown visibility fails closed', () => {
  it('rejects unknown visibility values rather than silently allowing', async () => {
    const submission = { ...makeSubmission('public'), visibility: 'something-new' as Submission['visibility'] };
    const ctx = mockStore(submission);
    const r = await checkSubmissionAccess(ctx, ADMIN, 'id', 'read');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

describe('checkSubmissionAccess: invalid JWT is treated as anonymous, not error', () => {
  it('a bogus Bearer header does not throw and grants no permissions', async () => {
    const ctx = mockStore(makeSubmission('private'));
    const req = makeReq('not-a-real-jwt-value');
    const r = await checkSubmissionAccess(ctx, req, 'id', 'read');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});
