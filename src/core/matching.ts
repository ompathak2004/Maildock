import { Parser } from 'htmlparser2';
import { type Attempt, type Candidate, emailAddress, type MailMessage } from './model';

export function senderAddress(from: string): string | null {
  const match = /<([^<>]+)>\s*$/.exec(from);
  const parsed = emailAddress.safeParse(match ? match[1] : from.trim());
  return parsed.success ? parsed.data : null;
}

function messageText(message: MailMessage): string {
  if (message.text?.trim()) return message.text;
  let text = '';
  let hidden = 0;
  const excluded = new Set(['script', 'style', 'head', 'blockquote']);
  const parser = new Parser(
    {
      onopentag(name) {
        if (excluded.has(name)) hidden++;
      },
      onclosetag(name) {
        if (excluded.has(name)) hidden--;
        if (!hidden) text += ' ';
      },
      ontext(value) {
        if (!hidden) text += value;
      },
    },
    { decodeEntities: true },
  );
  parser.end(message.html ?? '');
  return text;
}

function extractCode(message: MailMessage, length: number): string | null {
  const body = messageText(message);
  if (
    /password\s*(?:reset|recovery)|reset\s+(?:your\s+)?password|account\s+recovery|(?:payment|transfer|withdrawal|deletion)\s+(?:code|confirmation)/i.test(
      `${message.subject ?? ''} ${body.slice(0, 250)}`,
    )
  )
    return null;
  const text = `${message.subject ?? ''}\n${body}`;
  const matches = text.matchAll(new RegExp(`(?<![a-z0-9])([A-Z0-9]{${length}})(?![a-z0-9])`, 'gi'));
  const codes = new Set<string>();
  for (const match of matches) {
    const code = match[1];
    if (!code || !/\d/.test(code)) continue;
    const context = text.slice(Math.max(0, match.index - 100), match.index + code.length + 80);
    if (
      /verif(?:y|ication)|one[- ]time|sign[- ]?in|log[- ]?in|security\s+code|authentication\s+code|\bOTP\b|\bcode\b/i.test(
        context,
      )
    )
      codes.add(code);
  }
  return codes.size === 1 ? ([...codes][0] ?? null) : null;
}

export function selectCandidate(
  messages: MailMessage[],
  attempt: Attempt,
  now: number,
): Candidate | 'ambiguous' | null {
  if (now >= attempt.expiresAt) return null;
  const baseline = new Set(attempt.baseline);
  const candidates: Candidate[] = [];
  for (const message of messages) {
    const receivedAt = Date.parse(message.received_at);
    if (
      message.direction !== 'inbound' ||
      baseline.has(message.id) ||
      receivedAt < attempt.startedAt ||
      receivedAt > now + 10_000
    )
      continue;
    const sender = senderAddress(message.from);
    if (
      sender !== attempt.sender ||
      !message.to.some((value) => value.toLowerCase() === attempt.inbox.email_address)
    )
      continue;
    const code = extractCode(message, attempt.codeLength);
    if (code)
      candidates.push({
        messageId: message.id,
        code,
        sender,
        subject: (message.subject ?? '(No subject)').slice(0, 200),
        receivedAt,
      });
  }
  if (new Set(candidates.map((value) => value.code)).size > 1) return 'ambiguous';
  return candidates.sort((a, b) => b.receivedAt - a.receivedAt)[0] ?? null;
}
