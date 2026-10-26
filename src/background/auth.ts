import { z } from 'zod';
import { AppError } from '../core/errors';
import type { AuthSession } from '../core/model';
import { API_ORIGIN, requestJson } from './http';
import { getAuth, getSettings, saveAuth, saveSettings } from './storage';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().max(86400),
  token_type: z.string().regex(/^bearer$/i),
  scope: z.string().optional(),
});

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function parseTokens(data: unknown, clientId: string): AuthSession {
  const parsed = tokenSchema.safeParse(data);
  if (
    !parsed.success ||
    (parsed.data.scope && !parsed.data.scope.split(' ').includes('full_access'))
  ) {
    throw new AppError(
      'oauth-response',
      'Resend did not grant the access required to read inboxes.',
    );
  }
  return {
    clientId,
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: Date.now() + parsed.data.expires_in * 1000,
  };
}

export function validateCallback(callback: string, redirectUri: string, state: string): string {
  const result = new URL(callback);
  const expected = new URL(redirectUri);
  if (
    result.origin !== expected.origin ||
    result.pathname !== expected.pathname ||
    result.hash ||
    result.searchParams.getAll('state').length !== 1 ||
    result.searchParams.get('state') !== state ||
    result.searchParams.has('error') ||
    result.searchParams.getAll('code').length !== 1
  ) {
    throw new AppError(
      'oauth-state',
      'The authorization response could not be verified. Start a new connection.',
    );
  }
  const code = result.searchParams.get('code');
  if (!code) throw new AppError('oauth-code', 'Resend did not return an authorization code.');
  return code;
}

export async function connect(): Promise<void> {
  return navigator.locks.request('maildock-auth', async () => {
    if (await getAuth())
      throw new AppError(
        'already-connected',
        'Disconnect the current account before connecting another.',
      );
    const redirectUri = chrome.identity.getRedirectURL('resend');
    const settings = await getSettings();
    let clientId = import.meta.env.WXT_RESEND_CLIENT_ID || settings.clientId;
    if (!clientId) {
      const registration = await requestJson('/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Maildock',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: 'full_access',
          token_endpoint_auth_method: 'none',
        }),
      });
      const parsed = z.object({ client_id: z.string().min(1) }).safeParse(registration);
      if (!parsed.success)
        throw new AppError('registration', 'Resend did not return a valid client registration.');
      clientId = parsed.data.client_id;
      await saveSettings({ ...settings, clientId });
    }
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const url = new URL('/oauth/authorize', API_ORIGIN);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'full_access',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    let callback: string | undefined;
    try {
      callback = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
    } catch {
      throw new AppError(
        'oauth-cancelled',
        'Connection was cancelled or could not complete. You can try again.',
      );
    }
    if (!callback) throw new AppError('oauth-cancelled', 'Connection was cancelled.');
    const code = validateCallback(callback, redirectUri, state);
    const data = await requestJson('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    });
    await saveAuth(parseTokens(data, clientId));
  });
}

export async function accessToken(): Promise<string> {
  return navigator.locks.request('maildock-auth', async () => {
    const auth = await getAuth();
    if (!auth) throw new AppError('not-connected', 'Connect your Resend account to continue.');
    if (auth.expiresAt > Date.now() + 60_000) return auth.accessToken;
    try {
      const data = await requestJson('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: auth.clientId,
          refresh_token: auth.refreshToken,
        }),
      });
      const next = parseTokens(data, auth.clientId);
      await saveAuth(next);
      return next.accessToken;
    } catch (error) {
      if (
        error instanceof AppError &&
        ['unauthorized', 'invalid-grant', 'oauth-response'].includes(error.code)
      )
        await saveAuth(null);
      throw error;
    }
  });
}

export async function disconnect(): Promise<void> {
  return navigator.locks.request('maildock-auth', async () => {
    const auth = await getAuth();
    if (!auth) return;
    await requestJson('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: auth.refreshToken,
        client_id: auth.clientId,
        token_type_hint: 'refresh_token',
      }),
    });
    await saveAuth(null);
  });
}
