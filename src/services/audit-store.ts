import path from 'path';
import { EventStore } from '../storage/event-store.js';

export interface AuditEvent {
  action: string;
  actor_user_id: string;
  target_user_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit log for security-relevant admin actions (user
 * promotion/demotion, etc.). Lives in data/audit.jsonl. Read-only for now;
 * if we ever need querying we can grep the file or load it into SQLite.
 */
export class AuditStore {
  private store: EventStore;

  constructor(dataPath: string) {
    this.store = new EventStore(path.join(dataPath, 'audit.jsonl'));
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  async record(event: AuditEvent): Promise<void> {
    await this.store.appendEvent({
      timestamp: new Date(),
      type: event.action,
      data: {
        actor_user_id: event.actor_user_id,
        target_user_id: event.target_user_id,
        metadata: event.metadata,
      }
    });
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
