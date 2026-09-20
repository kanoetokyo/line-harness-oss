// LIFF id_token verification.
// Mirrors the helper in routes/booking.ts but lives in services/ so that new
// route modules (e.g. events.ts) can import & share it. booking.ts keeps its
// own copy for now to avoid touching production-stable code in this PR.

import { getLineAccounts, type LineAccount } from '@line-crm/db';

export interface VerifyEnv {
  LINE_LOGIN_CHANNEL_ID?: string;
  DB: D1Database;
}

export interface VerifiedLiffIdentity {
  lineUserId: string;
  account: LineAccount | null;
}

export async function verifyCallerLineIdentity(
  authHeader: string | undefined,
  env: VerifyEnv,
): Promise<VerifiedLiffIdentity | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) return null;

  const candidates: string[] = [];
  if (env.LINE_LOGIN_CHANNEL_ID) candidates.push(env.LINE_LOGIN_CHANNEL_ID);
  const dbAccounts = await getLineAccounts(env.DB);
  for (const a of dbAccounts) {
    const ch = (a as unknown as { login_channel_id?: string | null }).login_channel_id;
    if (ch && !candidates.includes(ch)) candidates.push(ch);
  }
  for (const channelId of candidates) {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
    if (res.ok) {
      const verified = (await res.json()) as { sub?: string };
      if (verified.sub) {
        return {
          lineUserId: verified.sub,
          account: dbAccounts.find((a) => a.login_channel_id === channelId) ?? null,
        };
      }
    }
  }
  return null;
}

export async function verifyCallerLineUserId(
  authHeader: string | undefined,
  env: VerifyEnv,
): Promise<string | null> {
  return (await verifyCallerLineIdentity(authHeader, env))?.lineUserId ?? null;
}
