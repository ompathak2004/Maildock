import { AppError, publicError } from '../core/errors';
import { selectCandidate } from '../core/matching';
import {
  type Attempt,
  type Command,
  commandSchema,
  type Response,
  type ViewState,
} from '../core/model';
import { connect, disconnect } from './auth';
import { assertTarget, captureTarget, fillTarget } from './page';
import { createInbox, listInboxes, recentMessages } from './resend';
import {
  getAttempt,
  getAuth,
  getInboxes,
  getSettings,
  saveAttempt,
  saveInboxes,
  saveSettings,
} from './storage';

function stopped(attempt: Attempt, reason: string): Attempt {
  return { ...attempt, phase: 'stopped', baseline: [], reason };
}

export async function state(): Promise<ViewState> {
  const [auth, inboxes, settings] = await Promise.all([getAuth(), getInboxes(), getSettings()]);
  let attempt = await getAttempt();
  if (
    attempt &&
    ['watching', 'ready'].includes(attempt.phase) &&
    (!auth || Date.now() >= attempt.expiresAt)
  ) {
    await saveAttempt(
      stopped(
        attempt,
        auth
          ? 'This watch expired. Start again and request a fresh code.'
          : 'Reconnect your Resend account to continue.',
      ),
    );
    attempt = await getAttempt();
  }
  const { clientId: _, ...preferences } = settings;
  return { connected: !!auth, inboxes: auth ? inboxes : [], settings: preferences, attempt };
}

async function start(command: Extract<Command, { type: 'watch.start' }>): Promise<void> {
  const inbox = (await getInboxes()).find((value) => value.id === command.inboxId);
  if (!inbox) throw new AppError('no-inbox', 'Refresh your inbox list and select an inbox.');
  const target = command.target;
  await assertTarget(target);
  const recent = await recentMessages(inbox, Date.now() - 180_000);
  await assertTarget(target);
  const now = Date.now();
  const settings = await getSettings();
  const rule = { origin: target.origin, sender: command.sender, codeLength: command.codeLength };
  await saveSettings({
    ...settings,
    selectedInboxId: inbox.id,
    rules: [...settings.rules.filter((value) => value.origin !== target.origin), rule].slice(-100),
  });
  await saveAttempt({
    id: crypto.randomUUID(),
    phase: 'watching',
    target,
    inbox,
    sender: command.sender,
    codeLength: command.codeLength,
    startedAt: now,
    expiresAt: now + 180_000,
    baseline: recent.map((value) => value.id),
    checkedAt: now,
    nextPollAt: now + 3000,
    note: null,
  });
}

async function poll(attemptId: string, force = false): Promise<Attempt | null> {
  const attempt = (await state()).attempt;
  if (!attempt || attempt.id !== attemptId || !['watching', 'ready'].includes(attempt.phase))
    return attempt;
  if (!force && Date.now() < attempt.nextPollAt) return attempt;
  try {
    await assertTarget(attempt.target);
    const messages = await recentMessages(attempt.inbox, attempt.startedAt);
    const now = Date.now();
    await assertTarget(attempt.target);
    if (now >= attempt.expiresAt) {
      await saveAttempt(stopped(attempt, 'This watch expired. Request a fresh code.'));
      return getAttempt();
    }
    const candidate = selectCandidate(messages, attempt, now);
    const next = { ...attempt, checkedAt: now, nextPollAt: now + 3000 };
    if (candidate && candidate !== 'ambiguous')
      await saveAttempt({ ...next, phase: 'ready', candidate });
    else
      await saveAttempt({
        ...next,
        phase: 'watching',
        note:
          candidate === 'ambiguous'
            ? 'Multiple different codes arrived. Stop this watch and request a fresh code.'
            : null,
      });
  } catch (error) {
    if (
      error instanceof AppError &&
      ['network', 'rate-limit', 'provider', 'response'].includes(error.code)
    ) {
      await saveAttempt({
        ...attempt,
        phase: 'watching',
        nextPollAt: Date.now() + Math.max(5000, error.retryAfterMs),
        note: error.message,
      });
    } else {
      await saveAttempt(stopped(attempt, publicError(error).error));
      throw error;
    }
  }
  return getAttempt();
}

async function execute(command: Command): Promise<Response> {
  let target = null;
  switch (command.type) {
    case 'state.get':
      break;
    case 'auth.connect':
      await saveAttempt(null);
      await connect();
      await saveInboxes(await listInboxes());
      break;
    case 'auth.disconnect':
      await saveAttempt(null);
      await disconnect();
      await saveInboxes([]);
      break;
    case 'inbox.list':
      await saveInboxes(await listInboxes());
      break;
    case 'inbox.select': {
      if (!(await getInboxes()).some((value) => value.id === command.inboxId))
        throw new AppError('no-inbox', 'That inbox is no longer available. Refresh the list.');
      await saveAttempt(null);
      await saveSettings({ ...(await getSettings()), selectedInboxId: command.inboxId });
      break;
    }
    case 'inbox.create':
      await createInbox(command.email, command.name);
      await saveInboxes(await listInboxes());
      break;
    case 'target.get':
      target = await captureTarget();
      break;
    case 'watch.start':
      await start(command);
      break;
    case 'watch.poll':
      await poll(command.attemptId);
      break;
    case 'watch.stop':
      await saveAttempt(null);
      break;
    case 'watch.fill': {
      const original = await getAttempt();
      if (
        !original ||
        original.id !== command.attemptId ||
        original.phase !== 'ready' ||
        original.candidate.messageId !== command.messageId
      )
        throw new AppError('no-code', 'There is no current code to fill.');
      const verified = await poll(command.attemptId, true);
      if (
        !verified ||
        verified.id !== original.id ||
        verified.phase !== 'ready' ||
        verified.candidate.messageId !== original.candidate.messageId ||
        verified.candidate.code !== original.candidate.code
      )
        throw new AppError(
          'code-changed',
          'The matching message changed. Review the current result before filling.',
        );
      await saveAttempt({ ...verified, phase: 'filled', baseline: [] });
      try {
        await fillTarget(verified.target, verified.candidate.code);
      } catch (error) {
        await saveAttempt(stopped(verified, publicError(error).error));
        throw error;
      }
      break;
    }
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
