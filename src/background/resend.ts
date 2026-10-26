import { z } from 'zod';
import { AppError } from '../core/errors';
import { type Inbox, inboxSchema, type MailMessage, messageSchema, threadId } from '../core/model';
import { accessToken } from './auth';
import { requestJson } from './http';
import { saveAuth } from './storage';

async function api<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  try {
    const token = await accessToken();
    const data = await requestJson(path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw new AppError(
        'schema',
        'Resend returned data this version of Maildock cannot safely read.',
      );
    return parsed.data;
  } catch (error) {
    if (error instanceof AppError && error.code === 'unauthorized') await saveAuth(null);
    throw error;
  }
}

export async function listInboxes(): Promise<Inbox[]> {
  const schema = z.object({ data: z.array(inboxSchema), has_more: z.boolean() });
  const inboxes: Inbox[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    const result = await api(`/inboxes?${query}`, schema);
    inboxes.push(...result.data);
    if (!result.has_more) return inboxes;
    const next = result.data.at(-1)?.id;
    if (!next || next === after) break;
    after = next;
  }
  throw new AppError(
    'pagination',
    'This account has too many inboxes to list safely. Use a dedicated account.',
  );
}

export async function createInbox(email: string, name: string): Promise<void> {
  await api('/inboxes', z.object({ id: z.uuid() }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email_address: email, name }),
  });
}

export async function recentMessages(inbox: Inbox, since: number): Promise<MailMessage[]> {
  const threadSchema = z.object({
    data: z.array(z.object({ id: threadId, received_at: z.iso.datetime({ offset: true }) })),
    has_more: z.boolean(),
  });
  const emailSchema = z.object({ data: z.array(messageSchema), has_more: z.boolean() });
  const messages: MailMessage[] = [];
  let afterThread: string | undefined;
  let requests = 0;
  while (requests < 20) {
    const query = new URLSearchParams({ limit: '20', folders: 'inbox,archive' });
    if (afterThread) query.set('after', afterThread);
    const threads = await api(`/inboxes/${inbox.id}/threads?${query}`, threadSchema);
    requests++;
    for (const thread of threads.data) {
      if (Date.parse(thread.received_at) < since) continue;
      if (requests >= 20)
        throw new AppError(
          'mailbox-busy',
          'Too many active threads to check safely. Use a dedicated verification inbox.',
        );
      let afterEmail: string | undefined;
      while (requests < 20) {
        const query = new URLSearchParams({ limit: '20' });
        if (afterEmail) query.set('after', afterEmail);
        const result = await api(
          `/inboxes/${inbox.id}/threads/${thread.id}/emails?${query}`,
          emailSchema,
        );
        requests++;
        messages.push(...result.data.filter((message) => Date.parse(message.received_at) >= since));
        if (messages.length > 2000)
          throw new AppError(
            'mailbox-busy',
            'Too many messages arrived. Try a dedicated verification inbox.',
          );
        if (!result.has_more) break;
        const next = result.data.at(-1)?.id;
        if (!next || next === afterEmail)
          throw new AppError('pagination', 'Resend returned an invalid message cursor. Try again.');
        afterEmail = next;
        if (requests >= 20)
          throw new AppError(
            'mailbox-busy',
            'This thread is too long to check safely. Use a dedicated verification inbox.',
          );
      }
    }
    if (!threads.has_more || threads.data.some((thread) => Date.parse(thread.received_at) < since))
      return messages;
    const next = threads.data.at(-1)?.id;
    if (!next || next === afterThread) break;
    afterThread = next;
  }
  throw new AppError(
    'mailbox-busy',
    'The inbox has too much recent activity. Use a dedicated verification inbox.',
  );
}
