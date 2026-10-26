import { Parser } from 'htmlparser2';
import {
  type Candidate,
  emailAddress,
  type Inbox,
  type MailMessage,
  type SenderCheck,
} from './model';

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

interface Anchor {
  href: string;
  label: string;
}

function parseHtml(html: string): { text: string; anchors: Anchor[] } {
  let text = '';
  let hidden = 0;
  let anchor: Anchor | null = null;
  const anchors: Anchor[] = [];
  const excluded = new Set(['script', 'style', 'head', 'blockquote']);
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (excluded.has(name)) hidden++;
        else if (name === 'br' && !hidden) text += '\n';
        else if (name === 'a' && !hidden) anchor = { href: attributes.href ?? '', label: '' };
      },
      onclosetag(name) {
        if (excluded.has(name)) hidden--;
        if (!hidden) text += blocks.has(name) ? '\n' : ' ';
        if (name === 'a' && anchor) {
          anchors.push(anchor);
          anchor = null;
        }
      },
      ontext(value) {
        if (hidden) return;
        text += value;
        if (anchor) anchor.label += value;
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return { text, anchors };
}

type Parsed = { subject: string; text: string; html: { text: string; anchors: Anchor[] } };

function parseMessage(message: MailMessage): Parsed {
  return {
    subject: message.subject ?? '',
    text: message.text?.trim() ? message.text : '',
    html: message.html ? parseHtml(message.html) : { text: '', anchors: [] },
  };
}

// Codes are often typeset in groups ("735 918", "4821-7730") that the token scan would treat as
// separate numbers. Groups are joined only when no further digits sit on either side, however
// much horizontal space separates them, so phone numbers and account numbers keep their shape.
function joinGroups(text: string): string {
  return text
    .replace(
      /(?<![\d-])(?<!\d[ \u00a0\t-]*)(\d{2})[ \u00a0](\d{2})[ \u00a0](\d{2})(?![ \u00a0\t-]*\d)/g,
      '$1$2$3',
    )
    .replace(
      /(?<![\d-])(?<!\d[ \u00a0\t-]*)(\d{3,4})[ \u00a0-](\d{3,4})(?![ \u00a0\t-]*\d)/g,
      '$1$2',
    );
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

// Recovery and payment messages are never candidates, whether they carry a code or a link, and
// whichever of the plain-text or HTML part says so.
function sensitiveMessage({ subject, text, html }: Parsed): boolean {
  return sensitive.test(`${subject} ${text.slice(0, 250)} ${html.text.slice(0, 250)}`);
}

function extractCode({ subject, text: plain, html }: Parsed): string | null {
  const text = joinGroups(`${subject}\n${plain || html.text}`);
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

const signInSubject =
  /sign[- ]?in|log[- ]?in|magic link|verify (?:your )?(?:email|account|address)|confirm (?:your )?(?:email|account|address)/i;
const signInLabel = /^\s*(?:sign[- ]?in|log[- ]?in|verify|confirm|continue)\b/i;

// A sign-in link is offered only when the message carries no code, the subject reads like a
// sign-in request, and exactly one HTTPS link is labelled as the sign-in action. Bare IPs and
// punycode hosts are refused because they are the usual shape of look-alike phishing links.
function extractLink({ subject, html }: Parsed): string | null {
  if (!signInSubject.test(subject)) return null;
  const urls = new Set<string>();
  for (const anchor of html.anchors) {
    if (!signInLabel.test(anchor.label)) continue;
    let url: URL;
    try {
      url = new URL(anchor.href);
    } catch {
      continue;
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      /^\d+(?:\.\d+){3}$/.test(url.hostname) ||
      url.hostname.split('.').some((label) => label.startsWith('xn--')) ||
      url.href.length > 2048
    )
      continue;
    urls.add(url.href);
  }
  return urls.size === 1 ? ([...urls][0] ?? null) : null;
}

export const freshWindowMs = 180_000;

// Hosting suffixes under which unrelated parties own sibling subdomains (a subset of the private
// section of the Public Suffix List). Hosts under these only match when the hostnames are equal,
// because the suffixes nest (`s3.amazonaws.com`) and the list cannot be complete.
const sharedSuffixes = [
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'appspot.com',
  'herokuapp.com',
  'onrender.com',
  'fly.dev',
  'azurewebsites.net',
  'cloudfront.net',
  'amazonaws.com',
  'ngrok.io',
  'ngrok.app',
  'ngrok-free.app',
  'repl.co',
  'replit.app',
  'glitch.me',
  'surge.sh',
  'myshopify.com',
  'wixsite.com',
  'squarespace.com',
  'webflow.io',
  'blogspot.com',
  'wordpress.com',
  'weebly.com',
  'bubbleapps.io',
  'lovable.app',
  'netlify.com',
];

function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.');
  if (sharedSuffixes.some((suffix) => host.toLowerCase().endsWith(`.${suffix}`)))
    return host.toLowerCase();
  const second = labels.at(-2) ?? '';
  const take = labels.length > 2 && second.length <= 3 && (labels.at(-1)?.length ?? 0) <= 2 ? 3 : 2;
  return labels.slice(-take).join('.');
}

// True when the sender's domain and the website share a registrable domain, e.g.
// noreply@tm.openai.com and https://auth.openai.com. A hint, not a proof of legitimacy.
export function senderMatchesSite(sender: string, origin: string): boolean {
  const domain = sender.split('@')[1];
  if (!domain) return false;
  try {
    return registrableDomain(domain) === registrableDomain(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function freshCandidates(
  messages: MailMessage[],
  inbox: Inbox,
  consumed: Set<string>,
  now: number,
  checks: ReadonlyMap<string, SenderCheck> = new Map(),
): Candidate[] {
  // Resends of one code or link collapse into the newest message. Consuming any copy must retire
  // the whole group, so consumption is tracked per value rather than per message.
  const byValue = new Map<string, { candidate: Candidate; consumed: boolean }>();
  for (const message of messages) {
    const receivedAt = Date.parse(message.received_at);
    if (
      message.direction !== 'inbound' ||
      receivedAt < now - freshWindowMs ||
      receivedAt > now + 10_000
    )
      continue;
    const sender = senderAddress(message.from);
    if (!sender || !message.to.some((value) => value.toLowerCase() === inbox.email_address))
      continue;
    const base = {
      messageId: message.id,
      sender,
      subject: (message.subject ?? '(No subject)').slice(0, 200),
      receivedAt,
      check: checks.get(message.id) ?? 'unknown',
    } as const;
    const parsed = parseMessage(message);
    if (sensitiveMessage(parsed)) continue;
    const code = extractCode(parsed);
    const url = code ? null : extractLink(parsed);
    const candidate: Candidate | null = code
      ? { ...base, kind: 'code', code }
      : url
        ? { ...base, kind: 'link', url }
        : null;
    if (!candidate) continue;
    const value = candidate.kind === 'code' ? `code:${candidate.code}` : `link:${candidate.url}`;
    const group = byValue.get(value);
    if (!group) byValue.set(value, { candidate, consumed: consumed.has(message.id) });
    else {
      group.consumed ||= consumed.has(message.id);
      if (group.candidate.receivedAt < receivedAt) group.candidate = candidate;
    }
  }
  return [...byValue.values()]
    .filter((group) => !group.consumed)
    .map((group) => group.candidate)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, 5);
}
