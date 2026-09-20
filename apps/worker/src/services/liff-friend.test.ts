import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineAccount } from '@line-crm/db';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { resolveLiffFriend } from './liff-friend.js';

const account = { id: 'account-a', is_active: 1, channel_access_token: 'bot-a' } as LineAccount;
let store: ReturnType<typeof sqliteD1>;
const fetchMock = vi.fn<typeof fetch>();
const identity = { lineUserId: 'U-existing', account };

beforeEach(() => {
  store = sqliteD1();
  store.sqlite.exec(`CREATE TABLE friends (
    id TEXT PRIMARY KEY, line_user_id TEXT UNIQUE NOT NULL, display_name TEXT,
    picture_url TEXT, status_message TEXT, line_account_id TEXT, user_id TEXT,
    is_following INTEGER DEFAULT 1, metadata TEXT DEFAULT '{}', ref_code TEXT,
    created_at TEXT, updated_at TEXT
  )`);
  fetchMock.mockReset().mockImplementation(async () => Response.json({
    userId: 'U-existing', displayName: 'LINE確認済みの名前', pictureUrl: 'https://example.test/profile.png',
  }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { store.sqlite.close(); vi.unstubAllGlobals(); });

function insert(accountId: string | null = 'account-a') {
  store.sqlite.prepare(`INSERT INTO friends
    (id, line_user_id, display_name, line_account_id, metadata, ref_code, is_following)
    VALUES ('existing-row', 'U-existing', '元の名前', ?, '{"keep":true}', 'original-ref', 0)`)
    .run(accountId);
}

describe('existing LINE followers first entering Harness', () => {
  it('creates the missing friend from the matched bot profile only', async () => {
    const friend = await resolveLiffFriend(store.db, identity);
    expect(friend).toMatchObject({ line_user_id: 'U-existing', line_account_id: 'account-a', display_name: 'LINE確認済みの名前' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.line.me/v2/bot/profile/U-existing', {
      headers: { Authorization: 'Bearer bot-a' },
    });
  });

  it('does not duplicate a friend when form and link registration race', async () => {
    const [a, b] = await Promise.all([resolveLiffFriend(store.db, identity), resolveLiffFriend(store.db, identity)]);
    expect(a?.id).toBe(b?.id);
    expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 1 });
  });

  it('preserves existing metadata, attribution and follow status', async () => {
    insert();
    expect(await resolveLiffFriend(store.db, identity)).toMatchObject({
      id: 'existing-row', display_name: '元の名前', metadata: '{"keep":true}', is_following: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.sqlite.prepare('SELECT ref_code FROM friends').get()).toEqual({ ref_code: 'original-ref' });
  });

  it('does not use or reassign a different account with the same LINE user', async () => {
    insert('account-b');
    expect(await resolveLiffFriend(store.db, identity)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.sqlite.prepare('SELECT line_account_id FROM friends').get()).toEqual({ line_account_id: 'account-b' });
  });

  it('handles the follow webhook winning the registration race', async () => {
    fetchMock.mockImplementationOnce(async () => { insert(null); return Response.json({ userId: 'U-existing' }); });
    expect(await resolveLiffFriend(store.db, identity)).toMatchObject({
      id: 'existing-row', line_account_id: 'account-a', metadata: '{"keep":true}', display_name: '元の名前', is_following: 0,
    });
  });

  it.each([403, 404])('does not register a user rejected by the bot profile API (%s)', async status => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    expect(await resolveLiffFriend(store.db, identity)).toBeNull();
    expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 0 });
  });

  it('rejects a mismatched profile identity', async () => {
    fetchMock.mockResolvedValue(Response.json({ userId: 'U-someone-else' }));
    expect(await resolveLiffFriend(store.db, identity)).toBeNull();
    expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 0 });
  });

  it('does not guess an account for an unmapped or inactive Login channel', async () => {
    expect(await resolveLiffFriend(store.db, { ...identity, account: null })).toBeNull();
    expect(await resolveLiffFriend(store.db, { ...identity, account: { ...account, is_active: 0 } })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces upstream outages without writing a partial registration', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(resolveLiffFriend(store.db, identity)).rejects.toThrow('LINE profile lookup failed (500)');
    expect(store.sqlite.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 0 });
  });
});
