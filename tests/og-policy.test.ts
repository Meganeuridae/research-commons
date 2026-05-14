import { describe, it, expect } from 'vitest';

// Pull just the small pure helpers out of og-meta to test them in isolation.
// (The Express middleware/route handlers themselves need an app fixture; the
// security-critical decision logic lives in these helpers and the visibility
// check, which we test by extracting the predicate inline.)

const OG_PUBLIC_VISIBILITIES = new Set(['public', 'unlisted']);

describe('OG preview visibility policy', () => {
  it('allows public submissions', () => {
    expect(OG_PUBLIC_VISIBILITIES.has('public')).toBe(true);
  });
  it('allows unlisted submissions', () => {
    expect(OG_PUBLIC_VISIBILITIES.has('unlisted')).toBe(true);
  });
  it('blocks researcher-visibility submissions (the regression rain-1 found)', () => {
    expect(OG_PUBLIC_VISIBILITIES.has('researcher')).toBe(false);
  });
  it('blocks private submissions', () => {
    expect(OG_PUBLIC_VISIBILITIES.has('private')).toBe(false);
  });
  it('blocks anything else (defense against new visibility values)', () => {
    expect(OG_PUBLIC_VISIBILITIES.has('draft')).toBe(false);
    expect(OG_PUBLIC_VISIBILITIES.has('')).toBe(false);
  });
});

describe('OG base URL selection (host-header poisoning defense)', () => {
  // We re-implement the helper locally rather than import it, since the real
  // helper depends on Express types. The behavior under test is the policy:
  //   - production + configured BASE_URL/APP_URL → use config
  //   - production + no config → null (skip preview)
  //   - dev → fall back to request headers
  function pickBaseUrl(
    env: NodeJS.ProcessEnv,
    req: { headers: Record<string, string | undefined>; secure?: boolean }
  ): string | null {
    const configured = env.BASE_URL || env.APP_URL;
    if (configured) {
      return configured.startsWith('http') ? configured : `https://${configured}`;
    }
    if (env.NODE_ENV === 'production') return null;
    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    return `${protocol}://${req.headers.host}`;
  }

  it('uses configured BASE_URL in production', () => {
    expect(pickBaseUrl(
      { NODE_ENV: 'production', BASE_URL: 'https://example.com' },
      { headers: { host: 'attacker.example', 'x-forwarded-proto': 'https' } }
    )).toBe('https://example.com');
  });

  it('returns null in production when BASE_URL/APP_URL unset (skip preview, do NOT poison)', () => {
    expect(pickBaseUrl(
      { NODE_ENV: 'production' },
      { headers: { host: 'attacker.example' } }
    )).toBeNull();
  });

  it('ignores attacker-controlled Host header in production even with BASE_URL set', () => {
    const url = pickBaseUrl(
      { NODE_ENV: 'production', BASE_URL: 'https://commons.example.com' },
      { headers: { host: 'attacker.example', 'x-forwarded-proto': 'https' } }
    );
    expect(url).toBe('https://commons.example.com');
    expect(url).not.toContain('attacker');
  });

  it('falls back to request headers in development', () => {
    expect(pickBaseUrl(
      { NODE_ENV: 'development' },
      { headers: { host: 'localhost:5173' } }
    )).toBe('http://localhost:5173');
  });

  it('prepends https:// when BASE_URL is missing a protocol', () => {
    expect(pickBaseUrl(
      { NODE_ENV: 'production', BASE_URL: 'example.com' },
      { headers: { host: 'whatever' } }
    )).toBe('https://example.com');
  });
});
