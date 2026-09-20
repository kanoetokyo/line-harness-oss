import { getFriendByLineUserIdForAccount, jstNow, type Friend } from '@line-crm/db';
import type { VerifiedLiffIdentity } from './liff-auth.js';

/**
 * Followers who joined before Harness was connected have no follow webhook
 * in our database. Resolve them on LIFF entry, using only the verified token's
 * subject/account and a profile returned by that account's Messaging API.
 * Never accept a browser-supplied user ID, name or account for registration.
 */
export async function resolveLiffFriend(
  db: D1Database,
  identity: VerifiedLiffIdentity,
): Promise<Friend | null> {
  const { lineUserId, account } = identity;
  const find = () => getFriendByLineUserIdForAccount(db, lineUserId, account?.id ?? null);
  const existing = await find();
  // The legacy lookup falls back across accounts. Never reassign another
  // account's friend (the current schema has a global line_user_id UNIQUE).
  if (existing?.line_account_id && account && existing.line_account_id !== account.id) {
    return null;
  }
  if (existing && (!account || existing.line_account_id === account.id)) return existing;
  if (!account || !account.is_active) return null;

  const response = await fetch(
    `https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`,
    { headers: { Authorization: `Bearer ${account.channel_access_token}` } },
  );
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error(`LINE profile lookup failed (${response.status})`);
  const profile = await response.json() as {
    userId?: string; displayName?: string; pictureUrl?: string; statusMessage?: string;
  };
  if (profile.userId !== lineUserId) return null;

  const now = jstNow();
  // Race-safe with the follow webhook and concurrent form/link requests.
  // Existing profile, tags, metadata, follow status and attribution stay intact.
  await db.prepare(
    `INSERT INTO friends
      (id, line_user_id, display_name, picture_url, status_message,
       line_account_id, is_following, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(line_user_id) DO NOTHING`,
  ).bind(
    crypto.randomUUID(), lineUserId, profile.displayName ?? null,
    profile.pictureUrl ?? null, profile.statusMessage ?? null, account.id, now, now,
  ).run();
  // A webhook may have inserted an unscoped row while we fetched the profile.
  await db.prepare(
    `UPDATE friends SET line_account_id = ?, updated_at = ?
     WHERE line_user_id = ? AND line_account_id IS NULL`,
  ).bind(account.id, now, lineUserId).run();
  const friend = await find();
  return friend?.line_account_id === account.id ? friend : null;
}
