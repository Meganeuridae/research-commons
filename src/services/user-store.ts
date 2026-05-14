import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { EventStore } from '../storage/event-store.js';
import { User } from '../types/research.js';

interface PasswordResetToken {
  userId: string;
  email: string;
  expiresAt: Date;
}

/**
 * Hash a password-reset token before persisting it. The raw token has 256 bits
 * of entropy from crypto.randomBytes, so a plain SHA-256 (no salt, no HMAC) is
 * fine here — rainbow tables are infeasible for that keyspace, and any
 * stretching is wasted on a value used once and expired in 24h.
 *
 * We hash so that the on-disk event log (a permanent record) doesn't act as a
 * collection of valid bearer tokens for whoever can read it. Previously the
 * raw token was persisted in plaintext to the JSONL log.
 */
function hashResetToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Manages user data (event-sourced)
 */
export class UserStore {
  private usersFile: EventStore;
  private users: Map<string, User> = new Map();
  private usersByEmail: Map<string, string> = new Map();
  private usersByName: Map<string, string> = new Map(); // Track names for uniqueness
  private passwordHashes: Map<string, string> = new Map();
  private passwordResetTokens: Map<string, PasswordResetToken> = new Map(); // token -> info

  constructor(dataPath: string) {
    this.usersFile = new EventStore(`${dataPath}/users.jsonl`);
  }

  async init(): Promise<void> {
    await this.usersFile.init();
    
    // Load all users
    const events = await this.usersFile.loadEvents();
    for (const event of events) {
      await this.replayEvent(event);
    }
  }

  private async replayEvent(event: any): Promise<void> {
    switch (event.type) {
      case 'user_created': {
        const { user, passwordHash } = event.data;
        const userWithDates = {
          ...user,
          created_at: new Date(user.created_at),
          updated_at: user.updated_at ? new Date(user.updated_at) : undefined
        };
        this.users.set(user.id, userWithDates);
        this.usersByEmail.set(user.email, user.id);
        
        // Track name (case-insensitive) - handle legacy duplicates gracefully
        const nameLower = user.name.toLowerCase();
        if (this.usersByName.has(nameLower)) {
          console.warn(`[UserStore] Duplicate username detected during replay: "${user.name}" (${user.id}). This will be allowed for existing users but prevented for new registrations.`);
        }
        this.usersByName.set(nameLower, user.id);
        
        if (passwordHash) {
          this.passwordHashes.set(user.email, passwordHash);
        }
        break;
      }
      case 'user_roles_updated': {
        const { userId, roles } = event.data;
        const user = this.users.get(userId);
        if (user) {
          this.users.set(userId, {
            ...user,
            roles,
            updated_at: event.timestamp,
            roles_updated_at: event.timestamp,
          });
        }
        break;
      }
      case 'user_profile_updated': {
        const { userId, name, email, oldEmail } = event.data;
        const user = this.users.get(userId);
        if (user) {
          const updated = { ...user, updated_at: event.timestamp };
          
          // Update name mapping if name changed
          if (name !== undefined && name !== user.name) {
            const oldNameLower = user.name.toLowerCase();
            const newNameLower = name.toLowerCase();
            
            // Only delete old name mapping if it points to this user
            if (this.usersByName.get(oldNameLower) === userId) {
              this.usersByName.delete(oldNameLower);
            }
            
            // Warn if new name is already taken (legacy data)
            if (this.usersByName.has(newNameLower) && this.usersByName.get(newNameLower) !== userId) {
              console.warn(`[UserStore] Duplicate username detected during replay: "${name}" (${userId}). This will be allowed for existing data but prevented for new updates.`);
            }
            
            this.usersByName.set(newNameLower, userId);
            updated.name = name;
          }
          
          // Update email mapping if email changed
          if (email !== undefined) {
            updated.email = email;
            if (oldEmail) {
              this.usersByEmail.delete(oldEmail);
              // Move password hash to new email
              const passwordHash = this.passwordHashes.get(oldEmail);
              if (passwordHash) {
                this.passwordHashes.delete(oldEmail);
                this.passwordHashes.set(email, passwordHash);
              }
            }
            this.usersByEmail.set(email, userId);
          }
          
          this.users.set(userId, updated);
        }
        break;
      }
      case 'password_reset_token_created': {
        // Modern events persist `tokenHash` (SHA-256 hex of the raw token);
        // legacy events from the first version of this code persisted the raw
        // `token`. Accept either, but always store by hash so validation can
        // compare without ever holding the raw token in memory.
        const { tokenHash, token, userId, email, expiresAt } = event.data;
        const hashKey = tokenHash ?? (token ? hashResetToken(token) : null);
        if (!hashKey) break;
        const expires = new Date(expiresAt);
        // Skip tokens that already expired before the server came up.
        if (expires.getTime() > Date.now()) {
          this.passwordResetTokens.set(hashKey, { userId, email, expiresAt: expires });
        }
        break;
      }
      case 'password_reset_token_consumed': {
        const { tokenHash, token } = event.data;
        const hashKey = tokenHash ?? (token ? hashResetToken(token) : null);
        if (hashKey) this.passwordResetTokens.delete(hashKey);
        break;
      }
      case 'user_password_updated': {
        const { email, passwordHash, userId } = event.data;
        this.passwordHashes.set(email, passwordHash);
        if (userId) {
          const user = this.users.get(userId);
          if (user) {
            this.users.set(userId, {
              ...user,
              updated_at: event.timestamp,
              password_changed_at: event.timestamp,
            });
          }
        }
        break;
      }
    }
  }

  async createUser(email: string, password: string, name: string): Promise<User> {
    if (this.usersByEmail.has(email)) {
      throw new Error('Email already in use');
    }

    // Check for duplicate name (case-insensitive)
    if (this.usersByName.has(name.toLowerCase())) {
      throw new Error('Username already taken');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user: User = {
      id: uuidv4(),
      email,
      name,
      roles: ['contributor'], // Default role
      created_at: new Date()
    };

    await this.usersFile.appendEvent({
      timestamp: new Date(),
      type: 'user_created',
      data: { user, passwordHash }
    });

    this.users.set(user.id, user);
    this.usersByEmail.set(email, user.id);
    this.usersByName.set(name.toLowerCase(), user.id);
    this.passwordHashes.set(email, passwordHash);

    return user;
  }

  // A pre-computed bcrypt hash used when the email doesn't exist. Compared
  // against the submitted password so the response time matches the
  // user-exists path — closing the timing-attack vector for email
  // enumeration via login. The plaintext is never accepted.
  private static readonly DUMMY_HASH =
    '$2b$10$CwTycUXWue0Thq9StjUM0uJ8mO1234567890abcdefghijklmnopqrs';

  async validatePassword(email: string, password: string): Promise<boolean> {
    const passwordHash = this.passwordHashes.get(email);
    if (!passwordHash) {
      // Burn the same ~bcrypt-cost amount of CPU as the real-user path so
      // attackers can't distinguish "user exists, wrong password" from
      // "no such user" by timing.
      await bcrypt.compare(password, UserStore.DUMMY_HASH);
      return false;
    }
    return bcrypt.compare(password, passwordHash);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const userId = this.usersByEmail.get(email);
    if (!userId) return null;
    return this.users.get(userId) || null;
  }

  async getUserById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async updateUserRoles(userId: string, roles: User['roles']): Promise<User | null> {
    const user = this.users.get(userId);
    if (!user) return null;

    const now = new Date();
    await this.usersFile.appendEvent({
      timestamp: now,
      type: 'user_roles_updated',
      data: { userId, roles }
    });

    const updated = { ...user, roles, updated_at: now, roles_updated_at: now };
    this.users.set(userId, updated);
    return updated;
  }

  async addUserRole(userId: string, role: User['roles'][number]): Promise<User | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    
    if (!user.roles.includes(role)) {
      const newRoles = [...user.roles, role] as User['roles'];
      return this.updateUserRoles(userId, newRoles);
    }
    
    return user;
  }

  async updateUserProfile(userId: string, updates: { name?: string; email?: string }): Promise<User | null> {
    const user = this.users.get(userId);
    if (!user) return null;

    // Check if email is being changed and if it conflicts with another user
    if (updates.email && updates.email !== user.email) {
      const existingUserId = this.usersByEmail.get(updates.email);
      if (existingUserId && existingUserId !== userId) {
        throw new Error('Email already in use by another account');
      }
    }

    // Check if name is being changed and if it conflicts with another user (case-insensitive)
    if (updates.name && updates.name.toLowerCase() !== user.name.toLowerCase()) {
      const existingUserId = this.usersByName.get(updates.name.toLowerCase());
      if (existingUserId && existingUserId !== userId) {
        throw new Error('Username already taken by another account');
      }
    }

    await this.usersFile.appendEvent({
      timestamp: new Date(),
      type: 'user_profile_updated',
      data: {
        userId,
        name: updates.name,
        email: updates.email,
        oldEmail: updates.email ? user.email : undefined
      }
    });

    const updated = {
      ...user,
      ...(updates.name !== undefined && { name: updates.name }),
      ...(updates.email !== undefined && { email: updates.email }),
      updated_at: new Date()
    };

    // Update name mapping if name changed
    if (updates.name && updates.name !== user.name) {
      this.usersByName.delete(user.name.toLowerCase());
      this.usersByName.set(updates.name.toLowerCase(), userId);
    }

    // Update email mappings if email changed
    if (updates.email && updates.email !== user.email) {
      this.usersByEmail.delete(user.email);
      this.usersByEmail.set(updates.email, userId);
      
      // Move password hash to new email
      const passwordHash = this.passwordHashes.get(user.email);
      if (passwordHash) {
        this.passwordHashes.delete(user.email);
        this.passwordHashes.set(updates.email, passwordHash);
      }
    }

    this.users.set(userId, updated);
    return updated;
  }

  async updateUserPassword(userId: string, newPassword: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error('User not found');

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const now = new Date();

    await this.usersFile.appendEvent({
      timestamp: now,
      type: 'user_password_updated',
      data: { userId, email: user.email, passwordHash }
    });

    this.passwordHashes.set(user.email, passwordHash);
    this.users.set(userId, { ...user, updated_at: now, password_changed_at: now });
  }

  async getAllUsers(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  async close(): Promise<void> {
    await this.usersFile.close();
  }

  // Password reset token methods

  async createPasswordResetToken(email: string): Promise<{ token: string; user: User } | null> {
    const userId = this.usersByEmail.get(email);
    if (!userId) return null;

    const user = this.users.get(userId);
    if (!user) return null;

    // Raw token: returned to caller for the emailed URL. Never persisted.
    const token = crypto.randomBytes(32).toString('hex');
    // Hash: persisted to the event log and used as the in-memory map key.
    // Knowing the hash isn't enough to redeem the token; an attacker with
    // read access to data/users.jsonl can no longer impersonate password
    // resets.
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await this.usersFile.appendEvent({
      timestamp: new Date(),
      type: 'password_reset_token_created',
      data: { tokenHash, userId, email, expiresAt: expiresAt.toISOString() }
    });

    this.passwordResetTokens.set(tokenHash, { userId, email, expiresAt });

    this.cleanupExpiredTokens();

    return { token, user };
  }

  async validatePasswordResetToken(token: string): Promise<{ userId: string; email: string } | null> {
    const tokenHash = hashResetToken(token);
    const tokenInfo = this.passwordResetTokens.get(tokenHash);
    if (!tokenInfo) return null;

    if (new Date() > tokenInfo.expiresAt) {
      this.passwordResetTokens.delete(tokenHash);
      return null;
    }

    return { userId: tokenInfo.userId, email: tokenInfo.email };
  }

  async consumePasswordResetToken(token: string): Promise<{ userId: string; email: string } | null> {
    const result = await this.validatePasswordResetToken(token);
    if (result) {
      const tokenHash = hashResetToken(token);
      await this.usersFile.appendEvent({
        timestamp: new Date(),
        type: 'password_reset_token_consumed',
        data: { tokenHash }
      });
      this.passwordResetTokens.delete(tokenHash);
    }
    return result;
  }

  private cleanupExpiredTokens(): void {
    const now = new Date();
    for (const [hashKey, info] of this.passwordResetTokens.entries()) {
      if (now > info.expiresAt) {
        this.passwordResetTokens.delete(hashKey);
      }
    }
  }
}

