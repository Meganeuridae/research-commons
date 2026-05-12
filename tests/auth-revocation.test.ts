import { describe, it, expect } from 'vitest';
import { isTokenRevoked } from '../src/middleware/auth.js';
import type { DecodedToken } from '../src/middleware/auth.js';
import type { User } from '../src/types/research.js';

function makeToken(iatSec: number, overrides: Partial<DecodedToken> = {}): DecodedToken {
  return {
    userId: '00000000-0000-0000-0000-000000000001',
    email: 'u@example.com',
    roles: ['contributor'],
    iat: iatSec,
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'u@example.com',
    name: 'u',
    roles: ['contributor'],
    created_at: new Date(0),
    ...overrides,
  };
}

describe('isTokenRevoked', () => {
  it('returns false when neither timestamp is set (legacy user)', () => {
    const token = makeToken(1_700_000_000);
    expect(isTokenRevoked(token, makeUser())).toBe(false);
  });

  it('returns false when the token was issued after a password change', () => {
    const token = makeToken(1_700_000_100);
    const user = makeUser({ password_changed_at: new Date(1_700_000_000 * 1000) });
    expect(isTokenRevoked(token, user)).toBe(false);
  });

  it('returns true when password changed after the token was issued', () => {
    const token = makeToken(1_700_000_000);
    const user = makeUser({ password_changed_at: new Date(1_700_000_100 * 1000) });
    expect(isTokenRevoked(token, user)).toBe(true);
  });

  it('returns true when roles updated after the token was issued', () => {
    const token = makeToken(1_700_000_000);
    const user = makeUser({ roles_updated_at: new Date(1_700_000_100 * 1000) });
    expect(isTokenRevoked(token, user)).toBe(true);
  });

  it('returns false when the token has no iat (defensive)', () => {
    const token = makeToken(0, { iat: undefined });
    const user = makeUser({ password_changed_at: new Date() });
    expect(isTokenRevoked(token, user)).toBe(false);
  });

  it('handles exact-second iat boundary correctly (iat is in seconds, timestamp in ms)', () => {
    const iat = 1_700_000_000;
    // password_changed_at is exactly at iat — same instant should not revoke
    const sameTime = new Date(iat * 1000);
    expect(isTokenRevoked(makeToken(iat), makeUser({ password_changed_at: sameTime }))).toBe(false);
    // 1ms later — also still not revoked (iat is seconds-precision)
    const oneMsLater = new Date(iat * 1000 + 1);
    expect(isTokenRevoked(makeToken(iat), makeUser({ password_changed_at: oneMsLater }))).toBe(true);
  });
});
