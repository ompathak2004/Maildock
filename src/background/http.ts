import { AppError } from '../core/errors';

export const API_ORIGIN = 'https://api.resend.com';

export async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: globalThis.Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new AppError(
      'network',
      'Resend could not be reached. Check your connection and try again.',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) {
      const retry = Number(response.headers.get('Retry-After'));
      throw new AppError(
        'rate-limit',
        'Resend is temporarily limiting requests. Maildock will wait before checking again.',
        Number.isFinite(retry) && retry > 0 ? Math.min(300, retry) * 1000 : 30_000,
      );
    }
    if (response.status === 401)
      throw new AppError(
        'unauthorized',
        'Your Resend connection expired or was revoked. Reconnect to continue.',
      );
    if (response.status === 403)
      throw new AppError(
        'forbidden',
        'Resend denied this action. Check account permissions and inbox plan limits.',
      );
    if (response.status === 409)
      throw new AppError('conflict', 'That inbox already exists. Refresh your inbox list.');
    if (response.status === 404)
      throw new AppError(
        'not-found',
        'This inbox or message is no longer available. Refresh your inbox list.',
      );
    if (response.status === 422)
      throw new AppError(
        'invalid-request',
        'Resend could not accept this request. Check that the domain is verified and receiving or forwarding is configured.',
      );
    if (response.status === 400 && path === '/oauth/token')
      throw new AppError(
        'invalid-grant',
        'Resend could not authorize this connection. Reconnect and try again.',
      );
    if (response.status === 400)
      throw new AppError(
        'invalid-request',
        'Resend could not accept this request. Check the supplied details.',
      );
    throw new AppError('provider', 'Resend could not complete the request. Try again shortly.');
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4_000_000) {
        await reader.cancel();
        throw new AppError(
          'too-large',
          'This mailbox response is too large to process safely. Open it in Resend.',
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('response', 'Resend returned an incomplete response. Try again.');
  } finally {
    reader.releaseLock();
  }
}
