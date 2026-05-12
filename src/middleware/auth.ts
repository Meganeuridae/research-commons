import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../types/research.js';

export interface DecodedToken {
  userId: string;
  email: string;
  roles: User['roles'];
}

export interface AuthRequest extends Request {
  user?: User;
  userId?: string;
}

let _cachedJwtSecret: string | null = null;

/**
 * Read JWT_SECRET lazily so dotenv has a chance to populate process.env first,
 * and so an unset secret fails loudly at first use rather than silently
 * accepting a known default. Call `assertJwtSecret()` at boot to fail fast.
 */
export function getJwtSecret(): string {
  if (_cachedJwtSecret !== null) return _cachedJwtSecret;

  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'change-this-in-production') {
    throw new Error(
      'JWT_SECRET is not set (or is still the placeholder value). ' +
      'Generate a strong value with: openssl rand -hex 64'
    );
  }
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters for security');
  }
  _cachedJwtSecret = secret;
  return _cachedJwtSecret;
}

/** Call at startup so misconfiguration fails the boot, not the first request. */
export function assertJwtSecret(): void {
  getJwtSecret();
}

export function generateToken(user: User): string {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      roles: user.roles
    },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
}

export function verifyToken(token: string): DecodedToken {
  return jwt.verify(token, getJwtSecret()) as DecodedToken;
}

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  jwt.verify(token, getJwtSecret(), (err, decoded) => {
    if (err || !decoded || typeof decoded === 'string') {
      res.status(403).json({ error: 'Invalid or expired token' });
      return;
    }

    const payload = decoded as DecodedToken;
    req.userId = payload.userId;
    req.user = {
      id: payload.userId,
      email: payload.email,
      roles: payload.roles,
      name: '', // Will be filled from DB if needed
      created_at: new Date()
    };
    next();
  });
}

export function requireRole(role: User['roles'][0]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !req.user.roles.includes(role)) {
      res.status(403).json({ error: `Requires ${role} role` });
      return;
    }
    next();
  };
}

export function requireAnyRole(roles: User['roles']) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.some(role => req.user!.roles.includes(role))) {
      res.status(403).json({ error: `Requires one of: ${roles.join(', ')}` });
      return;
    }
    next();
  };
}

export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    next();
    return;
  }

  jwt.verify(token, getJwtSecret(), (err, decoded) => {
    if (!err && decoded && typeof decoded !== 'string') {
      const payload = decoded as DecodedToken;
      req.userId = payload.userId;
      req.user = {
        id: payload.userId,
        email: payload.email,
        roles: payload.roles,
        name: '',
        created_at: new Date()
      };
    }
    next();
  });
}

/**
 * Best-effort auth parse from raw request headers — for routes that conditionally
 * widen results based on identity (guests vs users vs researchers vs admins)
 * without rejecting unauthenticated requests outright.
 */
export function parseAuthFromHeaders(authHeader: string | undefined): {
  userId?: string;
  roles: User['roles'];
} {
  if (!authHeader?.startsWith('Bearer ')) {
    return { roles: [] };
  }
  const token = authHeader.substring(7);
  try {
    const decoded = verifyToken(token);
    return { userId: decoded.userId, roles: decoded.roles || [] };
  } catch {
    return { roles: [] };
  }
}

