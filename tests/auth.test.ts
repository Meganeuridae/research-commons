import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  generateToken,
  verifyToken,
  parseAuthFromHeaders,
  getJwtSecret,
  authenticateToken,
  type AuthRequest,
} from '../src/middleware/auth.js';
import type { User } from '../src/types/research.js';
import type { Response, NextFunction } from 'express';

const sampleUser: User = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'researcher@example.com',
  name: 'Researcher One',
  roles: ['researcher'],
  created_at: new Date(),
};

describe('JWT secret validation', () => {
  const originalSecret = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = originalSecret;
    vi.resetModules();
  });

  async function freshAuth() {
    vi.resetModules();
    return import('../src/middleware/auth.js');
  }

  it('throws when JWT_SECRET is missing', async () => {
    delete process.env.JWT_SECRET;
    const mod = await freshAuth();
    expect(() => mod.getJwtSecret()).toThrowError(/not set/);
  });

  it('throws when JWT_SECRET is the documented placeholder', async () => {
    process.env.JWT_SECRET = 'change-this-in-production';
    const mod = await freshAuth();
    expect(() => mod.getJwtSecret()).toThrowError(/not set/);
  });

  it('throws when JWT_SECRET is too short', async () => {
    process.env.JWT_SECRET = 'too-short';
    const mod = await freshAuth();
    expect(() => mod.getJwtSecret()).toThrowError(/at least 32/);
  });

  it('accepts a sufficiently long secret', () => {
    expect(() => getJwtSecret()).not.toThrow();
    expect(getJwtSecret().length).toBeGreaterThanOrEqual(32);
  });
});

describe('generateToken / verifyToken', () => {
  it('round-trips user identity through a token', () => {
    const token = generateToken(sampleUser);
    const decoded = verifyToken(token);
    expect(decoded.userId).toBe(sampleUser.id);
    expect(decoded.email).toBe(sampleUser.email);
    expect(decoded.roles).toEqual(['researcher']);
  });

  it('rejects tokens signed with a different secret', () => {
    const forged = jwt.sign({ userId: sampleUser.id, email: sampleUser.email, roles: ['admin'] }, 'wrong-secret');
    expect(() => verifyToken(forged)).toThrow();
  });

  it('rejects malformed tokens', () => {
    expect(() => verifyToken('not.a.token')).toThrow();
  });
});

describe('parseAuthFromHeaders', () => {
  it('returns empty for missing header', () => {
    const result = parseAuthFromHeaders(undefined);
    expect(result.userId).toBeUndefined();
    expect(result.roles).toEqual([]);
  });

  it('returns empty for non-Bearer header', () => {
    const result = parseAuthFromHeaders('Basic abc123');
    expect(result.userId).toBeUndefined();
    expect(result.roles).toEqual([]);
  });

  it('returns empty for malformed token (no throw)', () => {
    const result = parseAuthFromHeaders('Bearer garbage');
    expect(result.userId).toBeUndefined();
    expect(result.roles).toEqual([]);
  });

  it('returns userId and roles for a valid token', () => {
    const token = generateToken(sampleUser);
    const result = parseAuthFromHeaders(`Bearer ${token}`);
    expect(result.userId).toBe(sampleUser.id);
    expect(result.roles).toContain('researcher');
  });

  it('returns empty for token signed with the wrong secret', () => {
    const forged = jwt.sign({ userId: sampleUser.id, email: sampleUser.email, roles: ['admin'] }, 'wrong-secret');
    const result = parseAuthFromHeaders(`Bearer ${forged}`);
    expect(result.userId).toBeUndefined();
    expect(result.roles).toEqual([]);
  });
});

describe('authenticateToken middleware', () => {
  function run(headers: Record<string, string | undefined>): Promise<{ status?: number; body?: unknown; called: boolean; req: AuthRequest }> {
    return new Promise(resolve => {
      const req = { headers } as unknown as AuthRequest;
      let status: number | undefined;
      let body: unknown;
      const res = {
        status(code: number) { status = code; return this; },
        json(payload: unknown) { body = payload; resolve({ status, body, called: false, req }); return this; },
      } as unknown as Response;
      const next: NextFunction = () => resolve({ status, body, called: true, req });
      authenticateToken(req, res, next);
    });
  }

  it('rejects with 401 when no Authorization header', async () => {
    const result = await run({});
    expect(result.status).toBe(401);
    expect(result.called).toBe(false);
  });

  it('rejects with 403 when token is invalid', async () => {
    const result = await run({ authorization: 'Bearer not-a-token' });
    expect(result.status).toBe(403);
    expect(result.called).toBe(false);
  });

  it('rejects with 403 when token is signed with wrong secret', async () => {
    const forged = jwt.sign({ userId: sampleUser.id, email: sampleUser.email, roles: ['admin'] }, 'wrong-secret');
    const result = await run({ authorization: `Bearer ${forged}` });
    expect(result.status).toBe(403);
    expect(result.called).toBe(false);
  });

  it('calls next() and populates req.user for a valid token', async () => {
    const token = generateToken(sampleUser);
    const result = await run({ authorization: `Bearer ${token}` });
    expect(result.called).toBe(true);
    expect(result.req.userId).toBe(sampleUser.id);
    expect(result.req.user?.roles).toContain('researcher');
  });
});
