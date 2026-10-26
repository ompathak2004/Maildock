import { Parser } from 'htmlparser2';
import { type Attempt, type Candidate, emailAddress, type MailMessage } from './model';

export function senderAddress(from: string): string | null {
  const match = /<([^<>]+)>\s*$/.exec(from);
  const parsed = emailAddress.safeParse(match ? match[1] : from.trim());
  return parsed.success ? parsed.data : null;
}

const blocks = new Set([
  'p',
  'div',
  'td',
  'th',
  'tr',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'section',
  'article',
  'header',
  'footer',
  'pre',
  'center',
]);

function messageText(message: MailMessage): string {
  if (message.text?.trim()) return message.text;
  let text = '';
  let hidden = 0;
  const excluded = new Set(['script', 'style', 'head', 'blockquote']);
  const parser = new Parser(
    {
      onopentag(name) {
        if (excluded.has(name)) hidden++;
        else if (name === 'br' && !hidden) text += '\n';
      },
      onclosetag(name) {
        if (excluded.has(name)) hidden--;
        if (!hidden) text += blocks.has(name) ? '\n' : ' ';
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

const keyword =
  /verif(?:y|ication)|one[- ]time|sign[- ]?in|log[- ]?in|security\s+code|authentication\s+code|\bOTP\b|\bcode\b|\bpasscode\b|\bPIN\b/i;
const sensitive =
  /password\s*(?:reset|recovery)|reset\s+(?:your\s+)?password|account\s+recovery|(?:payment|transfer|withdrawal|deletion)\s+(?:code|confirmation)/i;

// Tier 1 binds the token to a label ("code: 123456", "code is G-123456", "123456 is your code"). Tier 2 is a token
// standing alone on its line, which is how most HTML templates render the code. Tier 3 only has a
// keyword nearby. A year-like token needs a label because footers and dates are full of them.
function tier(text: string, index: number, code: string): 1 | 2 | 3 | null {
  const end = index + code.length;
  const before = text.slice(Math.max(0, index - 100), index);
  const after = text.slice(end, end + 80);
  if (/https?:\/\/\S*$/i.test(before) || /[=/&#?]$/.test(before)) return null;
  if (
    /\b(?:code|otp|passcode|pin)\b(?:\s+is)?[^a-z0-9]{0,12}(?:\b[A-Z]{1,2}-)?$/i.test(before) ||
    /^[^a-z0-9]{0,12}is\s+your\b[^.\n]{0,40}\b(?:code|otp|passcode|pin)\b/i.test(after)
  )
    return 1;
  if (/^(?:19|20)\d\d$/.test(code) || !keyword.test(before + after)) return null;
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = text.indexOf('\n', end);
  if (
    text.slice(lineStart, index).trim() === '' &&
    text.slice(end, lineEnd === -1 ? undefined : lineEnd).trim() === ''
  )
    return 2;
  return 3;
}

function extractCode(message: MailMessage): string | null {
  const body = messageText(message);
  if (sensitive.test(`${message.subject ?? ''} ${body.slice(0, 250)}`)) return null;
  const text = `${message.subject ?? ''}\n${body}`;
  const best = new Map<string, number>();
  for (const match of text.matchAll(/(?<![a-z0-9])([A-Z0-9]{4,8})(?![a-z0-9])/gi)) {
    const code = match[1];
    if (!code || !/\d/.test(code)) continue;
    const rank = tier(text, match.index, code);
    if (rank) best.set(code, Math.min(rank, best.get(code) ?? rank));
  }
  const top = Math.min(...best.values());
  const codes = [...best].filter(([, rank]) => rank === top).map(([code]) => code);
  return codes.length === 1 ? (codes[0] ?? null) : null;
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
    if (!sender || !message.to.some((value) => value.toLowerCase() === attempt.inbox.email_address))
      continue;
    const code = extractCode(message);
    if (code)
      candidates.push({
        messageId: message.id,
        code,
        sender,
        subject: (message.subject ?? '(No subject)').slice(0, 200),
        receivedAt,
      });
  }
  const distinct = (values: Candidate[]) => new Set(values.map((value) => value.code)).size;
  let chosen = candidates;
  if (distinct(chosen) > 1 && attempt.knownSender) {
    const known = chosen.filter((value) => value.sender === attempt.knownSender);
    if (known.length) chosen = known;
  }
  if (distinct(chosen) > 1) return 'ambiguous';
  return chosen.sort((a, b) => b.receivedAt - a.receivedAt)[0] ?? null;
}
