import { AppError, publicError } from '../core/errors';
import { freshCandidates, freshWindowMs } from '../core/matching';
import {
  type Candidate,
  type Command,
  commandSchema,
  type Inbox,
  type Response,
  type Target,
  type ViewState,
  type Watch,
} from '../core/model';
import { connect, disconnect } from './auth';
import { captureTarget, fillTarget } from './page';
import { createInbox, listInboxes, recentMessages, senderCheck } from './resend';
import {
  getAuth,
  getInboxes,
  getSettings,
  getWatch,
  saveInboxes,
  saveSettings,
  saveWatch,
} from './storage';

const idleWatch: Watch = {
  items: [],
  consumed: [],
  checkedAt: 0,
  nextPollAt: 0,
  note: null,
  lastFill: null,
};

async function selectedInbox(): Promise<Inbox | null> {
  const [inboxes, settings] = await Promise.all([getInboxes(), getSettings()]);
  return inboxes.find((value) => value.id === settings.selectedInboxId) ?? inboxes[0] ?? null;
}

// Codes leave session storage as soon as they fall out of the fresh window, even while the
// panel is closed, because the half-minute alarm calls this.
export async function state(): Promise<ViewState> {
  const [auth, inboxes, settings, stored] = await Promise.all([
    getAuth(),
    getInboxes(),
    getSettings(),
    getWatch(),
  ]);
  const now = Date.now();
  let watch = auth ? (stored ?? idleWatch) : idleWatch;
  const items = watch.items.filter((value) => value.receivedAt >= now - freshWindowMs);
  if (items.length !== watch.items.length || (!auth && stored)) {
    watch = { ...watch, items };
    await saveWatch(auth ? watch : null);
  }
  const { clientId: _, ...preferences } = settings;
  return { connected: !!auth, inboxes: auth ? inboxes : [], settings: preferences, watch };
}

// A forced poll precedes a fill and must not fall back to cached codes: a code that was fresh
// before a slow failed request may be expired by the time the request gives up.
async function poll(force = false): Promise<Watch> {
  const view = await state();
  const watch = view.watch;
  const inbox = view.connected ? await selectedInbox() : null;
  const now = Date.now();
  if (!inbox || (!force && now < watch.nextPollAt)) return watch;
  try {
    const messages = await recentMessages(inbox, now - freshWindowMs);
    // Each message is checked once, in parallel, so an unavailable check costs one request and
    // at most one timeout rather than one per poll.
    const checks = new Map(watch.items.map((value) => [value.messageId, value.check]));
    const consumed = new Set(watch.consumed);
    const unchecked = freshCandidates(messages, inbox, consumed, Date.now(), checks).filter(
      (item) => !checks.has(item.messageId),
    );
    const results = await Promise.all(
      unchecked.map(async (item) => [item.messageId, await senderCheck(item.messageId)] as const),
    );
    for (const [messageId, check] of results) checks.set(messageId, check);
    const next: Watch = {
      ...watch,
      items: freshCandidates(messages, inbox, consumed, Date.now(), checks),
      checkedAt: now,
      nextPollAt: now + 3000,
      note: null,
    };
    await saveWatch(next);
    return next;
  } catch (error) {
    if (
      !force &&
      error instanceof AppError &&
      ['network', 'rate-limit', 'provider', 'response'].includes(error.code)
    ) {
      const next: Watch = {
        ...watch,
        nextPollAt: now + Math.max(5000, error.retryAfterMs),
        note: error.message,
      };
      await saveWatch(next);
      return next;
    }
    throw error;
  }
}

async function rememberSender(origin: string, sender: string): Promise<void> {
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    rules: [...settings.rules.filter((value) => value.origin !== origin), { origin, sender }].slice(
      -100,
    ),
  });
}

// Re-fetches mail and resolves the item right before it is released, so a stale panel can never
// release an expired item or one whose sender check failed in the meantime.
async function release<K extends Candidate['kind']>(
  messageId: string,
  kind: K,
): Promise<{ watch: Watch; item: Extract<Candidate, { kind: K }> }> {
  const watch = await poll(true);
  const item = watch.items.find((value) => value.messageId === messageId);
  if (!item || item.kind !== kind || item.receivedAt < Date.now() - freshWindowMs)
    throw new AppError('no-code', 'That item is no longer available. Review the current list.');
  if (item.check === 'fail')
    throw new AppError('sender-check', 'The sender failed authentication. Do not use this email.');
  return { watch, item: item as Extract<Candidate, { kind: K }> };
}

async function consume(
  watch: Watch,
  messageId: Candidate['messageId'],
  lastFill: Watch['lastFill'],
) {
  await saveWatch({
    ...watch,
    items: watch.items.filter((value) => value.messageId !== messageId),
    consumed: [...watch.consumed, messageId].slice(-200),
    lastFill,
  });
}

async function fill(command: Extract<Command, { type: 'watch.fill' }>): Promise<void> {
  const target = await captureTarget();
  if (
    target.tabId !== command.target.tabId ||
    target.documentId !== command.target.documentId ||
    target.origin !== command.target.origin
  )
    throw new AppError('page-changed', 'The page changed. Check the website shown and try again.');
  const { watch, item } = await release(command.messageId, 'code');
  await fillTarget(target, item.code);
  await consume(watch, item.messageId, { origin: target.origin, at: Date.now() });
  await rememberSender(target.origin, item.sender);
}

async function open(command: Extract<Command, { type: 'watch.open' }>): Promise<void> {
  const { watch, item } = await release(command.messageId, 'link');
  await chrome.tabs.create({ url: item.url, active: true });
  await consume(watch, item.messageId, watch.lastFill);
}

async function execute(command: Command): Promise<Response> {
  let target: Target | null = null;
  switch (command.type) {
    case 'state.get':
      target = await captureTarget().catch(() => null);
      break;
    case 'auth.connect':
      await saveWatch(null);
      await connect();
      await saveInboxes(await listInboxes());
      break;
    case 'auth.disconnect':
      await saveWatch(null);
      await disconnect();
      await saveInboxes([]);
      break;
    case 'inbox.list':
      await saveInboxes(await listInboxes());
      break;
    case 'inbox.select': {
      if (!(await getInboxes()).some((value) => value.id === command.inboxId))
        throw new AppError('no-inbox', 'That inbox is no longer available. Refresh the list.');
      // Message IDs are unique across inboxes, so consumption survives switching inboxes.
      await saveWatch({ ...idleWatch, consumed: (await state()).watch.consumed });
      await saveSettings({ ...(await getSettings()), selectedInboxId: command.inboxId });
      break;
    }
    case 'inbox.create':
      await createInbox(command.email, command.name);
      await saveInboxes(await listInboxes());
      break;
    case 'watch.poll':
      await poll();
      target = await captureTarget().catch(() => null);
      break;
    case 'watch.fill':
      await fill(command);
      break;
    case 'watch.open':
      await open(command);
      break;
    case 'watch.dismiss': {
      const watch = (await state()).watch;
      await consume(watch, command.messageId, watch.lastFill);
      break;
    }
    case 'watch.done':
      await saveWatch({ ...(await state()).watch, lastFill: null });
      break;
  }
  return { ok: true, state: await state(), target };
}

export function isTrustedSender(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
  panelUrl: string,
): boolean {
  return (
    sender.id === extensionId &&
    sender.url === panelUrl &&
    sender.origin === `chrome-extension://${extensionId}` &&
    (sender.frameId === undefined || sender.frameId === 0)
  );
}

export async function handleMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Response> {
  if (!isTrustedSender(sender, chrome.runtime.id, chrome.runtime.getURL('sidepanel.html')))
    return { ok: false, code: 'untrusted-sender', error: 'This request is not permitted.' };
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, code: 'invalid-command', error: 'The extension request was invalid.' };
  try {
    return await navigator.locks.request('maildock-state', () => execute(parsed.data));
  } catch (error) {
    return { ok: false, ...publicError(error) };
  }
}
