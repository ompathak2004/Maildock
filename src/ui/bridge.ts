import { AppError } from '../core/errors';
import { type Command, responseSchema } from '../core/model';

export async function send(command: Command) {
  let raw: unknown;
  try {
    raw = await chrome.runtime.sendMessage(command);
  } catch {
    throw new AppError('worker-unavailable', 'Maildock restarted. Reopen the panel and try again.');
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      'invalid-response',
      'Maildock could not read its session. Reload the extension.',
    );
  if (!parsed.data.ok) throw new AppError(parsed.data.code, parsed.data.error);
  return parsed.data;
}
