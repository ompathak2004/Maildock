import { resolve } from 'node:path';
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
  type Worker,
} from '@playwright/test';
import { authSchema, type Command, responseSchema, watchSchema } from '../../src/core/model';

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
let revokedUpstream: boolean;
let authentication: { spf: string; dkim: string; dmarc: string } | null;
let mail: 'code' | 'link';
let mailboxRequests: number;
let rateLimited: boolean;
const linkId = 'f5ddee04-8643-4e3f-9c13-e21b6c2dbfff';

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

async function tick(at: number) {
  await worker.evaluate(async (time) => {
    Date.now = () => time;
    await chrome.alarms.create('watch-inbox', {
      delayInMinutes: 0.001,
      periodInMinutes: 0.5,
    });
  }, at);
  await expect
    .poll(() =>
      worker.evaluate(async () => (await chrome.alarms.get('watch-inbox'))?.scheduledTime),
    )
    .toBeGreaterThan(Date.now() + 5000);
  await worker.evaluate(() => navigator.locks.request('maildock-state', () => undefined));
}

async function watch() {
  return watchSchema.parse(
    await worker.evaluate(async () => (await chrome.storage.session.get('watch')).watch),
  );
}

test.beforeEach(async () => {
  deliveredAt = null;
  revoked = false;
  refreshes = 0;
  revokedUpstream = false;
  authentication = { spf: 'pass', dkim: 'pass', dmarc: 'pass' };
  mail = 'code';
  mailboxRequests = 0;
  rateLimited = false;
  const extension = resolve('.output/chrome-mv3');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    ...(process.env.MAILDOCK_TEST_BROWSER
      ? { executablePath: process.env.MAILDOCK_TEST_BROWSER }
      : {}),
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
    viewport: null,
  });
  const loader = await context.browser()?.newBrowserCDPSession();
  if (!loader) throw new Error('The browser does not expose an extension loading session');
  await loader.send('Extensions.loadUnpacked', { path: extension });
  await loader.detach();
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  id = new URL(worker.url()).host;
  await context.route('https://api.resend.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/inboxes/${inbox.id}/threads`) {
      mailboxRequests++;
      if (rateLimited) {
        await route.fulfill({
          status: 429,
          headers: { 'Retry-After': '60' },
          json: { message: 'Too many requests' },
        });
        return;
      }
    }
    if (revokedUpstream && path.startsWith('/inboxes/')) {
      await route.fulfill({ status: 401, json: { message: 'Unauthorized' } });
      return;
    }
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
                mail === 'code'
                  ? {
                      id: emailId,
                      direction: 'inbound',
                      from: 'Example <accounts@example.com>',
                      to: [inbox.email_address],
                      subject: 'Your sign-in code',
                      text: 'Your verification code is 123456.',
                      html: null,
                      received_at: deliveredAt,
                    }
                  : {
                      id: linkId,
                      direction: 'inbound',
                      from: 'Example <accounts@example.com>',
                      to: [inbox.email_address],
                      subject: 'Sign in to Example',
                      text: null,
                      html: '<p>Use the link below.</p><a href="https://login.example.test/magic?token=secret-token-value">Sign in to Example</a>',
                      received_at: deliveredAt,
                    },
              ]
            : [],
          has_more: false,
        };
        break;
      case `/emails/receiving/${emailId}`:
      case `/emails/receiving/${linkId}`:
        json = { authentication };
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
  await expect(panel.getByText('Verified sender')).toBeVisible();
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
  await expect(panel.getByRole('button', { name: 'Copy code' })).toBeEnabled();
  await grantTab();
  const polled = await command({ type: 'watch.poll' });
  if (!polled.ok || !polled.target) throw new Error('Target capture failed');
  expect(polled.target.origin).toBe('https://login.example.test');
  const code = polled.state.watch.items[0];
  if (code?.kind !== 'code') throw new Error('Code not listed');
  expect(code.check).toBe('pass');
  await expect(website.locator('#otp')).toHaveValue('');
  const filled = await command({
    type: 'watch.fill',
    messageId: code.messageId,
    target: polled.target,
  });
  expect(filled.ok).toBe(true);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  await expect(website.locator('#otp')).toHaveValue('123456');
  await expect(website.locator('body')).not.toHaveAttribute('data-submitted', 'true');
  const again = await command({ type: 'watch.poll' });
  expect(again.ok && again.state.watch.items).toEqual([]);
  // Optional per-site permission is offered only after a fill, from the panel, as a user gesture.
  await expect(
    panel.getByRole('button', { name: 'Always allow login.example.test' }),
  ).toBeVisible();
  expect((await worker.evaluate(() => chrome.permissions.getAll())).origins).toEqual([
    'https://api.resend.com/*',
  ]);
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
  expect(JSON.stringify(storage.local)).not.toContain('secret-token-value');
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
      return response.ok ? response.state.watch.items.length : response.error;
    })
    .toBe(1);
  const after = await command({ type: 'watch.poll' });
  if (!after.ok || !after.target || !after.state.watch.items[0]) throw new Error('Poll failed');
  expect(after.target.documentId).not.toBe(before.target.documentId);
  const stale = await command({
    type: 'watch.fill',
    messageId: after.state.watch.items[0].messageId,
    target: before.target,
  });
  expect(stale).toMatchObject({ ok: false, code: 'page-changed' });
  await expect(website.locator('#otp')).toHaveValue('');
  const fresh = await command({
    type: 'watch.fill',
    messageId: after.state.watch.items[0].messageId,
    target: after.target,
  });
  expect(fresh.ok).toBe(true);
  await expect(website.locator('#otp')).toHaveValue('123456');
  expect(await website.evaluate(() => typeof chrome.runtime?.sendMessage)).toBe('undefined');
  // Upstream revocation during polling must reach the panel as a disconnected view, not as a loop
  // of errors over stale cards.
  deliveredAt = new Date().toISOString();
  revokedUpstream = true;
  await expect
    .poll(async () => {
      const response = await command({ type: 'watch.poll' });
      return response.ok ? response.state : response.code;
    })
    .toMatchObject({ connected: false, watch: { items: [] } });
  await expect(panel.getByRole('button', { name: 'Continue with Resend' })).toBeVisible();
});

test('blocks a sender that failed authentication and opens a sign-in link only on request', async () => {
  await panel.getByLabel('I understand the account access').check();
  await panel.getByRole('button', { name: 'Continue with Resend' }).click();
  await expect(panel.getByText('Resend connected', { exact: true })).toBeVisible();
  await grantTab();
  authentication = { spf: 'fail', dkim: 'fail', dmarc: 'fail' };
  deliveredAt = new Date(Date.now() - 2000).toISOString();
  await expect.poll(async () => (await command({ type: 'watch.poll' })).ok).toBe(true);
  const polled = await command({ type: 'watch.poll' });
  if (!polled.ok || !polled.target) throw new Error('Target capture failed');
  const blocked = polled.state.watch.items[0];
  if (blocked?.kind !== 'code') throw new Error('Code not listed');
  expect(blocked.check).toBe('fail');
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  const refused = await command({
    type: 'watch.fill',
    messageId: blocked.messageId,
    target: polled.target,
  });
  expect(!refused.ok && refused.code).toBe('sender-check');
  await expect(website.locator('#otp')).toHaveValue('');
  await expect(panel.getByText('Sender check failed')).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Fill 123456/ })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Copy code' })).toBeDisabled();

  const dismissed = await command({ type: 'watch.dismiss', messageId: blocked.messageId });
  expect(dismissed.ok).toBe(true);
  authentication = null;
  mail = 'link';
  deliveredAt = new Date().toISOString();
  await context.route('https://login.example.test/magic**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Signed in</title>' }),
  );
  await expect
    .poll(async () => {
      const result = await command({ type: 'watch.poll' });
      return result.ok ? result.state.watch.items[0] : null;
    })
    .toMatchObject({ kind: 'link', check: 'unknown' });
  await expect(panel.getByText('Sender check unavailable')).toBeVisible();
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  await expect(panel.getByText('login.example.test', { exact: true })).toBeVisible();
  const pagesBefore = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
  // A tab created by the worker can start loading before Playwright attaches its route, so the
  // navigation is observed through the request log rather than the final document.
  const requested: string[] = [];
  context.on('request', (request) => requested.push(request.url()));
  const [opened] = await Promise.all([
    context.waitForEvent('page'),
    panel.getByRole('button', { name: 'Open link on login.example.test' }).click(),
  ]);
  await opened.waitForLoadState();
  await expect
    .poll(() => requested)
    .toContain('https://login.example.test/magic?token=secret-token-value');
  expect(await worker.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(
    pagesBefore + 1,
  );
  const after = await command({ type: 'watch.poll' });
  expect(after.ok && after.state.watch.items).toEqual([]);
});

test('opens a native popup for a background code and fills only after a toolbar grant and click', async () => {
  expect((await command({ type: 'auth.connect' })).ok).toBe(true);
  await panel.close();
  await website.bringToFront();
  const arriving = context.waitForEvent('page', { timeout: 35_000 });
  deliveredAt = new Date().toISOString();
  const popup = await arriving;
  await popup.waitForURL(`chrome-extension://${id}/popup.html`);
  await expect(popup.getByRole('heading', { name: 'Your code is ready' })).toBeVisible();
  await expect(popup.getByText('123456', { exact: true })).toBeVisible();
  await expect(popup.getByText('accounts@example.com', { exact: true })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Fill code', exact: true })).toBeDisabled();
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
  expect(await worker.evaluate(() => chrome.action.getTitle({}))).toBe(
    'Maildock: 1 code available',
  );
  await expect(website.locator('#otp')).toHaveValue('');
  await expect(website.locator('body')).not.toHaveAttribute('data-submitted', 'true');

  await popup.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  const nextPoll = Date.now() + 5000;
  await tick(nextPoll);
  await expect.poll(async () => (await watch()).checkedAt).toBe(nextPoll);
  await worker.evaluate(() => navigator.locks.request('maildock-state', () => undefined));
  expect(
    await worker.evaluate(() =>
      chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] }),
    ),
  ).toEqual([]);
  const reopened = context.waitForEvent('page');
  await grantTab();
  const permitted = await reopened;
  await permitted.waitForURL(`chrome-extension://${id}/popup.html`);
  const fill = permitted.getByRole('button', { name: 'Fill code on login.example.test' });
  await expect(fill).toBeEnabled();
  await permitted.screenshot({ path: 'test-results/popup-light.png' });
  await permitted.emulateMedia({ colorScheme: 'dark' });
  await expect(fill).toHaveCSS('background-color', 'rgb(238, 238, 238)');
  await permitted.screenshot({ path: 'test-results/popup-dark.png' });
  await fill.click();
  await expect(permitted.getByRole('heading', { name: 'Code filled' })).toBeVisible();
  await expect(website.locator('#otp')).toHaveValue('123456');
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  await expect(website.locator('body')).not.toHaveAttribute('data-submitted', 'true');
  const openedPanel = context.waitForEvent('page');
  await permitted.getByRole('button', { name: 'Open Maildock' }).click();
  const sidePanel = await openedPanel;
  await sidePanel.waitForURL(`chrome-extension://${id}/sidepanel.html`);
  await expect(sidePanel.getByRole('heading', { name: 'You’re ready to continue.' })).toBeVisible();
  await expect.poll(() => permitted.isClosed()).toBe(true);
});

test('expires a background badge during backoff, recovers, and clears it on revoked access', async () => {
  expect((await command({ type: 'auth.connect' })).ok).toBe(true);
  await panel.close();
  const now = Date.now();
  deliveredAt = new Date(now - 170_000).toISOString();
  await tick(now);
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');

  rateLimited = true;
  await tick(now + 20_000);
  await expect.poll(async () => (await watch()).nextPollAt).toBe(now + 80_000);
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  expect((await watch()).items).toEqual([]);
  const requestsBeforeBackoff = mailboxRequests;
  await tick(now + 50_000);
  await expect
    .poll(() =>
      worker.evaluate(async () => (await chrome.alarms.get('watch-inbox'))?.scheduledTime),
    )
    .toBeGreaterThan(Date.now() + 5000);
  expect(mailboxRequests).toBe(requestsBeforeBackoff);

  rateLimited = false;
  deliveredAt = new Date(now + 81_000).toISOString();
  await tick(now + 81_000);
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
  expect(mailboxRequests).toBe(requestsBeforeBackoff + 1);

  revokedUpstream = true;
  await tick(now + 85_000);
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  expect(await worker.evaluate(() => chrome.action.getTitle({}))).toBe('Open Maildock');
  expect(await worker.evaluate(() => chrome.storage.session.get(['auth', 'watch']))).toEqual({});
  const requestsAfterRevocation = mailboxRequests;
  await tick(now + 115_000);
  await expect
    .poll(() =>
      worker.evaluate(async () => (await chrome.alarms.get('watch-inbox'))?.scheduledTime),
    )
    .toBeGreaterThan(Date.now() + 5000);
  expect(mailboxRequests).toBe(requestsAfterRevocation);
});

test('offers one-click filling in an automatic popup when the page is already allowed', async () => {
  const opened = context.waitForEvent('page');
  await grantTab();
  const initial = await opened;
  await initial.waitForURL(`chrome-extension://${id}/popup.html`);
  const openedPanel = context.waitForEvent('page');
  await initial.getByRole('button', { name: 'Connect inbox' }).click();
  const sidePanel = await openedPanel;
  await sidePanel.waitForURL(`chrome-extension://${id}/sidepanel.html`);
  await sidePanel.getByLabel('I understand the account access').check();
  await sidePanel.getByRole('button', { name: 'Continue with Resend' }).click();
  await expect(sidePanel.getByText('Resend connected', { exact: true })).toBeVisible();
  await panel.close();
  await worker.evaluate(async () => {
    const window = await chrome.windows.getLastFocused();
    if (window.id === undefined) throw new Error('No window to close');
    await chrome.sidePanel.close({ windowId: window.id });
  });
  await expect
    .poll(() =>
      worker.evaluate(() =>
        chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] }),
      ),
    )
    .toEqual([]);
  await website.bringToFront();
  deliveredAt = new Date().toISOString();
  const arriving = context.waitForEvent('page');
  await tick(Date.now() + 5000);
  const popup = await arriving;
  await popup.waitForURL(`chrome-extension://${id}/popup.html`);
  const fill = popup.getByRole('button', { name: 'Fill code on login.example.test' });
  await expect(fill).toBeEnabled();
  await expect(website.locator('#otp')).toHaveValue('');
  await fill.click();
  await expect(website.locator('#otp')).toHaveValue('123456');
  await expect(website.locator('body')).not.toHaveAttribute('data-submitted', 'true');
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
});

test('keeps the badge usable when Chrome refuses the popup without repeatedly trying', async () => {
  expect((await command({ type: 'auth.connect' })).ok).toBe(true);
  await panel.close();
  await website.bringToFront();
  await worker.evaluate(() => {
    let attempts = 0;
    Object.defineProperty(globalThis, 'popupAttempts', { get: () => attempts });
    Object.defineProperty(chrome.action, 'openPopup', {
      value: async () => {
        attempts++;
        throw new Error('Another popup is open');
      },
    });
  });
  const now = Date.now();
  deliveredAt = new Date(now).toISOString();
  await tick(now);
  const attempts = () =>
    worker.evaluate(() => (globalThis as unknown as { popupAttempts: number }).popupAttempts);
  await expect.poll(attempts).toBe(1);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
  await tick(now + 5000);
  await expect.poll(async () => (await watch()).checkedAt).toBe(now + 5000);
  await worker.evaluate(() => navigator.locks.request('maildock-state', () => undefined));
  expect(await attempts()).toBe(1);
  await expect(website.locator('#otp')).toHaveValue('');
  const opened = context.waitForEvent('page');
  await grantTab();
  const popup = await opened;
  await popup.waitForURL(`chrome-extension://${id}/popup.html`);
  await expect(popup.getByText('123456', { exact: true })).toBeVisible();
  await popup.getByRole('button', { name: 'Dismiss code' }).click();
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  await expect(popup.getByText('123456', { exact: true })).toHaveCount(0);
});

test('does not open automatic previews for failed sender checks or sign-in links', async () => {
  expect((await command({ type: 'auth.connect' })).ok).toBe(true);
  await panel.close();
  await website.bringToFront();
  const now = Date.now();
  authentication = { spf: 'fail', dkim: 'fail', dmarc: 'fail' };
  deliveredAt = new Date(now).toISOString();
  await tick(now);
  await expect.poll(async () => (await watch()).items[0]?.check).toBe('fail');
  await worker.evaluate(() => navigator.locks.request('maildock-state', () => undefined));
  expect(
    await worker.evaluate(() =>
      chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] }),
    ),
  ).toEqual([]);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  authentication = { spf: 'pass', dkim: 'pass', dmarc: 'pass' };
  mail = 'link';
  await tick(now + 5000);
  await expect.poll(async () => (await watch()).items[0]?.kind).toBe('link');
  await worker.evaluate(() => navigator.locks.request('maildock-state', () => undefined));
  expect(
    await worker.evaluate(() =>
      chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.POPUP] }),
    ),
  ).toEqual([]);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  await expect(website.locator('#otp')).toHaveValue('');
});

test('clears code badges on dismissal, inbox selection and disconnect', async () => {
  expect((await command({ type: 'auth.connect' })).ok).toBe(true);
  deliveredAt = new Date().toISOString();
  expect((await command({ type: 'watch.poll' })).ok).toBe(true);
  await expect.poll(() => worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
  const polled = await command({ type: 'watch.poll' });
  if (!polled.ok || !polled.state.watch.items[0] || !polled.state.inboxes[0])
    throw new Error('Code not listed');
  const messageId = polled.state.watch.items[0].messageId;
  expect((await command({ type: 'inbox.select', inboxId: polled.state.inboxes[0].id })).ok).toBe(
    true,
  );
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  expect((await command({ type: 'watch.poll' })).ok).toBe(true);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
  expect((await command({ type: 'watch.dismiss', messageId })).ok).toBe(true);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');

  expect((await command({ type: 'auth.disconnect' })).ok).toBe(true);
  expect((await command({ type: 'auth.connect' })).ok).toBe(true);
  expect((await command({ type: 'watch.poll' })).ok).toBe(true);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
  expect((await command({ type: 'auth.disconnect' })).ok).toBe(true);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  expect(await worker.evaluate(() => chrome.action.getTitle({}))).toBe('Open Maildock');
});
