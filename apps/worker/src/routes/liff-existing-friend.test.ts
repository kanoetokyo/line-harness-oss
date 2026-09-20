import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLineAccounts: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  recordRefTracking: vi.fn(),
  createUser: vi.fn(),
  linkFriendToUser: vi.fn(),
  resolveLiffFriend: vi.fn(),
  pushImmediateFirstStep: vi.fn(),
}));
vi.mock('@line-crm/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  getLineAccounts: mocks.getLineAccounts,
  getEntryRouteByRefCode: mocks.getEntryRouteByRefCode,
  recordRefTracking: mocks.recordRefTracking,
  createUser: mocks.createUser,
  linkFriendToUser: mocks.linkFriendToUser,
}));
vi.mock('../services/liff-friend.js', () => ({ resolveLiffFriend: mocks.resolveLiffFriend }));
vi.mock('../services/immediate-first-step.js', () => ({ pushImmediateFirstStep: mocks.pushImmediateFirstStep }));

const { liffRoutes } = await import('./liff.js');
const account = { id: 'account-a', channel_id: 'bot-a', login_channel_id: 'login-a', is_active: 1 };
const DB = {
  prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null }) }),
} as unknown as D1Database;
const env = {
  DB, LINE_LOGIN_CHANNEL_ID: 'login-a', LINE_CHANNEL_ACCESS_TOKEN: 'test-only',
  WORKER_URL: 'https://worker.example.com',
} as unknown as import('../index.js').Env['Bindings'];

function link() {
  return liffRoutes.request('/api/liff/link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: 'test-id-token', ref: 'webinar-test', lineUserId: 'spoofed-id', account: 'spoofed-account' }),
  }, env);
}

describe('existing follower enters a webinar campaign', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getLineAccounts.mockResolvedValue([account]);
    mocks.getEntryRouteByRefCode.mockResolvedValue({ id: 'route-a', scenario_id: 'scenario-a', tag_id: null });
    mocks.resolveLiffFriend.mockResolvedValue({ id: 'friend-a', line_account_id: account.id, user_id: null });
    mocks.createUser.mockResolvedValue({ id: 'user-a' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ sub: 'verified-line-id' }))));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('links an imported follower and triggers the invitation using only verified identity', async () => {
    expect((await link()).status).toBe(200);
    expect(mocks.resolveLiffFriend).toHaveBeenCalledWith(DB, { lineUserId: 'verified-line-id', account });
    expect(mocks.linkFriendToUser).toHaveBeenCalledWith(DB, 'friend-a', 'user-a');
    expect(mocks.recordRefTracking).toHaveBeenCalledWith(DB, expect.objectContaining({ friendId: 'friend-a', refCode: 'webinar-test' }));
    expect(mocks.pushImmediateFirstStep).toHaveBeenCalledTimes(1);
    expect(mocks.pushImmediateFirstStep).toHaveBeenCalledWith(
      DB, 'friend-a', 'scenario-a',
      expect.objectContaining({ accountChannelId: 'bot-a' }),
      { mode: 'every-click', targetLineUserId: 'verified-line-id' },
    );
  });

  it('also invokes the existing cooldown-protected campaign service on reentry', async () => {
    mocks.resolveLiffFriend.mockResolvedValue({ id: 'friend-a', line_account_id: account.id, user_id: 'user-a' });
    expect((await link()).status).toBe(200);
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.pushImmediateFirstStep).toHaveBeenCalledWith(
      DB, 'friend-a', 'scenario-a', expect.anything(),
      { mode: 'every-click', targetLineUserId: 'verified-line-id' },
    );
  });

  it('does not report success or send a campaign when registration cannot be verified', async () => {
    mocks.resolveLiffFriend.mockResolvedValue(null);
    const response = await link();
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toContain('友だち追加');
    expect(mocks.pushImmediateFirstStep).not.toHaveBeenCalled();
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('does not register or send anything for an invalid ID token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })));
    expect((await link()).status).toBe(401);
    expect(mocks.resolveLiffFriend).not.toHaveBeenCalled();
    expect(mocks.pushImmediateFirstStep).not.toHaveBeenCalled();
  });
});
