#!/usr/bin/env tsx
/**
 * Promote an existing user to admin + researcher roles.
 *
 * Usage:
 *   tsx scripts/promote-admin.ts user@example.com
 *
 * Replaces the old make-admin.sh, which (a) interpolated the email directly
 * into a SQL string and (b) targeted a user_roles SQLite table that does not
 * exist — roles are stored in the JSONL user store.
 */
import 'dotenv/config';
import { UserStore } from '../src/services/user-store.js';

const DATA_PATH = process.env.DATA_PATH || './data';

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: tsx scripts/promote-admin.ts <email>');
    process.exit(1);
  }

  const userStore = new UserStore(DATA_PATH);
  await userStore.init();

  const user = await userStore.getUserByEmail(email);
  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  await userStore.addUserRole(user.id, 'admin');
  await userStore.addUserRole(user.id, 'researcher');

  console.log(`Promoted ${user.name} <${user.email}> to admin + researcher.`);
  await userStore.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
