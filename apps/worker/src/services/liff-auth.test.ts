import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const accounts = vi.hoisted(() => vi.fn());
vi.mock('@line-crm/db', () => ({ getLineAccounts: accounts }));
import { verifyCallerLineIdentity, verifyCallerLineUserId } from './liff-auth.js';

const env = { DB: {} as D1Database, LINE_LOGIN_CHANNEL_ID: 'default-login' };
const account = { id: 'a', login_channel_id: 'account-login', is_active: 1 };
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  accounts.mockReset().mockResolvedValue([account]);
  fetchMock.mockReset().mockImplementation(async (_url, init) => {
    const values = new URLSearchParams(init?.body as URLSearchParams);
    return values.get('id_token') === 'valid' && values.get('client_id') === 'account-login'
      ? Response.json({ sub: 'U-verified' }) : new Response(null, { status: 400 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
it('resolves the account only from the LINE-verified token audience', async () => {
  expect(await verifyCallerLineIdentity('Bearer valid', env)).toEqual({ lineUserId: 'U-verified', account });
  expect(await verifyCallerLineUserId('Bearer valid', env)).toBe('U-verified');
});
it('rejects invalid, expired or missing tokens', async () => {
  expect(await verifyCallerLineIdentity('Bearer invalid', env)).toBeNull();
  expect(await verifyCallerLineIdentity(undefined, env)).toBeNull();
  expect(await verifyCallerLineIdentity('Bearer ', env)).toBeNull();
});
