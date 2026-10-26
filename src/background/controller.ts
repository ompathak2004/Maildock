import { AppError, publicError } from '../core/errors';
import { freshCandidates, freshWindowMs } from '../core/matching';
import {
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
import { createInbox, listInboxes, recentMessages } from './resend';
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
  codes: [],
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
  const codes = watch.codes.filter((value) => value.receivedAt >= now - freshWindowMs);
  if (codes.length !== watch.codes.length || (!auth && stored)) {
    watch = { ...watch, codes };
    await saveWatch(auth ? watch : null);
  }
  const { clientId: _, ...preferences } = settings;
  return { connected: !!auth, inboxes: auth ? inboxes : [], settings: preferences, watch };
}

async function poll(force = false): Promise<Watch> {
  const watch = (await state()).watch;
  const inbox = await selectedInbox();
  const now = Date.now();
  if (!inbox || (!force && now < watch.nextPollAt)) return watch;
  try {
    const messages = await recentMessages(inbox, now - freshWindowMs);
    const next: Watch = {
      ...watch,
      codes: freshCandidates(messages, inbox, new Set(watch.consumed), Date.now()),
      checkedAt: now,
      nextPollAt: now + 3000,
      note: null,
    };
    await saveWatch(next);
    return next;
  } catch (error) {
    if (
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

async function fill(command: Extract<Command, { type: 'watch.fill' }>): Promise<void> {
  const target = await captureTarget();
  if (
    target.tabId !== command.target.tabId ||
    target.documentId !== command.target.documentId ||
    target.origin !== command.target.origin
  )
    throw new AppError('page-changed', 'The page changed. Check the website shown and try again.');
  const watch = await poll(true);
  const candidate = watch.codes.find((value) => value.messageId === command.messageId);
  if (!candidate)
    throw new AppError('no-code', 'That code is no longer available. Review the current codes.');
  await fillTarget(target, candidate.code);
  await saveWatch({
    ...watch,
    codes: watch.codes.filter((value) => value.messageId !== candidate.messageId),
    consumed: [...watch.consumed, candidate.messageId].slice(-200),
    lastFill: { origin: target.origin, at: Date.now() },
  });
  await rememberSender(target.origin, candidate.sender);
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
      await saveWatch(null);
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
    case 'watch.dismiss': {
      const watch = (await state()).watch;
      await saveWatch({
        ...watch,
        codes: watch.codes.filter((value) => value.messageId !== command.messageId),
        consumed: [...watch.consumed, command.messageId].slice(-200),
      });
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
