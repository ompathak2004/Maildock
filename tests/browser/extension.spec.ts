import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
  type Worker,
} from '@playwright/test';
import { authSchema, type Command, responseSchema } from '../../src/core/model';

const inbox = {
  id: '00eac4f6-401a-4429-84cf-c086cab6b68f',
  email_address: 'work@inbox.test',
  name: 'Work',
};
const threadId = 'b315530d-1cee-4a97-9646-1961242a8564';
const emailId = 'e4ccdc93-7532-4d2e-b802-d10a5b1caefe';
let context: BrowserContext;
let worker: Worker;
let panel: Page;
let website: Page;
let id: string;
let deliveredAt: string | null;
let revoked: boolean;
let refreshes: number;

async function command(value: Command) {
  const raw: unknown = await panel.evaluate(
    (message) => chrome.runtime.sendMessage(message),
    value,
  );
  return responseSchema.parse(raw);
}

async function grantTab() {
  await website.bringToFront();
  const browser = await context.browser()?.newBrowserCDPSession();
  if (!browser) throw new Error('The browser does not expose extension actions');
  const { targetInfos } = await browser.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const tab = targetInfos.find((target) => target.url === website.url());
  if (!tab) throw new Error('The test website tab could not be found');
  await browser.send('Extensions.triggerAction', { id, targetId: tab.targetId });
  await browser.detach();
}

test.beforeEach(async () => {
  deliveredAt = null;
  revoked = false;
  refreshes = 0;
  const extension = resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    ...(process.env.MAILDOCK_TEST_BROWSER
      ? { executablePath: process.env.MAILDOCK_TEST_BROWSER }
      : {}),
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
    viewport: { width: 390, height: 900 },
  });
  const loader = await context.browser()?.newBrowserCDPSession();
  if (!loader) throw new Error('The browser does not expose an extension loading session');
  await loader.send('Extensions.loadUnpacked', { path: extension });
  await loader.detach();
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  id = new URL(worker.url()).host;
  await context.route('https://api.resend.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown;
    switch (path) {
      case '/oauth/register':
        json = { client_id: 'test-public-client' };
        break;
      case '/oauth/token': {
        const form = new URLSearchParams(route.request().postData() ?? '');
        if (form.get('grant_type') === 'refresh_token') {
          expect(form.get('refresh_token')).toBe('test-refresh-token');
          refreshes++;
        } else {
          expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        }
        json = {
          access_token: refreshes ? 'rotated-access-token' : 'test-access-token',
          refresh_token: refreshes ? 'rotated-refresh-token' : 'test-refresh-token',
          expires_in: 900,
          token_type: 'Bearer',
          scope: 'full_access',
        };
        break;
      }
      case '/oauth/revoke':
        expect(new URLSearchParams(route.request().postData() ?? '').get('token')).toBe(
          refreshes ? 'rotated-refresh-token' : 'test-refresh-token',
        );
        revoked = true;
        await route.fulfill({ status: 200, body: '' });
        return;
      case '/inboxes':
        json = { data: [inbox], has_more: false };
        break;
      case `/inboxes/${inbox.id}/threads`:
        json = {
          data: deliveredAt ? [{ id: threadId, received_at: deliveredAt }] : [],
          has_more: false,
        };
        break;
      case `/inboxes/${inbox.id}/threads/${threadId}/emails`:
        json = {
          data: deliveredAt
            ? [
                {
                  id: emailId,
                  direction: 'inbound',
                  from: 'Example <accounts@example.com>',
                  to: [inbox.email_address],
                  subject: 'Your sign-in code',
                  text: 'Your verification code is 123456.',
                  html: null,
                  received_at: deliveredAt,
                },
              ]
            : [],
          has_more: false,
        };
        break;
      default:
        await route.fulfill({ status: 404, json: { error: 'Unexpected fixture request' } });
        return;
    }
    await route.fulfill({ status: 200, json });
  });
  await worker.evaluate(() => {
    Object.defineProperty(chrome.identity, 'launchWebAuthFlow', {
      value: async (details: chrome.identity.WebAuthFlowDetails) => {
        const authorization = new URL(details.url);
        if (authorization.searchParams.get('code_challenge_method') !== 'S256')
          throw new Error('Missing PKCE');
        const callback = new URL(chrome.identity.getRedirectURL('resend'));
        callback.searchParams.set('state', authorization.searchParams.get('state') ?? '');
        callback.searchParams.set('code', 'test-authorization-code');
        return callback.href;
      },
    });
  });
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await expect(
    panel.getByRole('heading', { name: 'Your code. Right where you need it.' }),
  ).toBeVisible();
  await context.route('https://login.example.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Example login</title></head><body><form><label for="otp">Verification code</label><input id="otp" autocomplete="one-time-code" maxlength="6"><button type="submit">Continue</button></form><script>document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();document.body.dataset.submitted="true"})</script></body></html>',
    }),
  );
  website = await context.newPage();
  await website.goto('https://login.example.test/verify');
});

test.afterEach(async () => {
  await context?.close();
});

test('connects, lists fresh mail, fills the allowed tab on request, and revokes access', async () => {
  await mkdir('artifacts', { recursive: true });
  await panel.screenshot({ path: 'artifacts/welcome.png', fullPage: true });
  await panel.getByLabel('I understand the account access').check();
  await panel.getByRole('button', { name: 'Continue with Resend' }).click();
  await expect(panel.getByText('Resend connected', { exact: true })).toBeVisible();
  const session = authSchema.parse(
    await worker.evaluate(async () => (await chrome.storage.session.get('auth')).auth),
  );
  await worker.evaluate(
    (auth) => chrome.storage.session.set({ auth: { ...auth, expiresAt: 0 } }),
    session,
  );
  const refreshed = await Promise.all([
    command({ type: 'inbox.list' }),
    command({ type: 'inbox.list' }),
  ]);
  expect(refreshed.every((result) => result.ok)).toBe(true);
  expect(refreshes).toBe(1);
  await expect(panel.getByText('Request your code on the website.')).toBeVisible();
  deliveredAt = new Date(Date.now() - 2000).toISOString();
  await expect(panel.getByRole('button', { name: 'Fill code', exact: true })).toBeDisabled({
    timeout: 10_000,
  });
  await expect(panel.getByText('123456', { exact: true })).toBeVisible();
  await panel.screenshot({ path: 'artifacts/code-ready.png', fullPage: true });
  await grantTab();
  const polled = await command({ type: 'watch.poll' });
  if (!polled.ok || !polled.target) throw new Error('Target capture failed');
  expect(polled.target.origin).toBe('https://login.example.test');
  const code = polled.state.watch.codes[0];
  if (!code) throw new Error('Code not listed');
  await expect(website.locator('#otp')).toHaveValue('');
  const filled = await command({
    type: 'watch.fill',
    messageId: code.messageId,
    target: polled.target,
  });
  expect(filled.ok).toBe(true);
  await expect(website.locator('#otp')).toHaveValue('123456');
  await expect(website.locator('body')).not.toHaveAttribute('data-submitted', 'true');
  const again = await command({ type: 'watch.poll' });
  expect(again.ok && again.state.watch.codes).toEqual([]);
  expect(again.ok && again.state.watch.lastFill?.origin).toBe('https://login.example.test');
  const storage = await worker.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null),
  }));
  expect(JSON.stringify(storage.local)).not.toContain('test-access-token');
  expect(JSON.stringify(storage.local)).not.toContain('rotated-access-token');
  expect(JSON.stringify(storage.local)).not.toContain('refresh-token');
  expect(JSON.stringify(storage.local)).not.toContain('123456');
  expect(JSON.stringify(storage.session.watch)).not.toContain('123456');
  expect(storage.local.settings).toMatchObject({
    rules: [{ origin: 'https://login.example.test', sender: 'accounts@example.com' }],
  });
  const disconnected = await command({ type: 'auth.disconnect' });
  expect(disconnected.ok && disconnected.state.connected).toBe(false);
  expect(revoked).toBe(true);
  expect(
    await worker.evaluate(async () => (await chrome.storage.session.get('auth')).auth),
  ).toBeUndefined();
});

test('rejects a stale page, survives navigation, and does not expose a mailbox bridge to websites', async () => {
  const connected = await command({ type: 'auth.connect' });
  expect(connected.ok).toBe(true);
  await grantTab();
  const before = await command({ type: 'watch.poll' });
  if (!before.ok || !before.target) throw new Error('Setup failed');
  deliveredAt = new Date(Date.now() - 2000).toISOString();
  await website.goto('https://login.example.test/new-document');
  await website.bringToFront();
  await expect
    .poll(async () => {
      const response = await command({ type: 'watch.poll' });
      return response.ok ? response.state.watch.codes.length : response.error;
    })
    .toBe(1);
  const after = await command({ type: 'watch.poll' });
  if (!after.ok || !after.target || !after.state.watch.codes[0]) throw new Error('Poll failed');
  expect(after.target.documentId).not.toBe(before.target.documentId);
  const stale = await command({
    type: 'watch.fill',
    messageId: after.state.watch.codes[0].messageId,
    target: before.target,
  });
  expect(stale).toMatchObject({ ok: false, code: 'page-changed' });
  await expect(website.locator('#otp')).toHaveValue('');
  const fresh = await command({
    type: 'watch.fill',
    messageId: after.state.watch.codes[0].messageId,
    target: after.target,
  });
  expect(fresh.ok).toBe(true);
  await expect(website.locator('#otp')).toHaveValue('123456');
  expect(await website.evaluate(() => typeof chrome.runtime?.sendMessage)).toBe('undefined');
});
