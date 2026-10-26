import { describe, expect, it } from 'vitest';
import { validateCallback } from '../src/background/auth';
import { isTrustedSender } from '../src/background/controller';
import { selectCandidate, senderAddress } from '../src/core/matching';
import { attemptSchema, commandSchema, messageSchema } from '../src/core/model';

const now = Date.parse('2026-10-25T12:00:00Z');
const attempt = attemptSchema.parse({
  id: 'ec80a649-a05b-4dfe-bf48-d7c78c134a47',
  phase: 'watching',
  target: {
    tabId: 4,
    documentId: 'original-document',
    origin: 'https://example.com',
    title: 'Example',
  },
  inbox: {
    id: '00eac4f6-401a-4429-84cf-c086cab6b68f',
    email_address: 'work@inbox.test',
    name: 'Work',
  },
  knownSender: null,
  startedAt: now - 10_000,
  expiresAt: now + 120_000,
  baseline: [],
  checkedAt: now,
  nextPollAt: now,
  note: null,
});

function email(overrides: Record<string, unknown> = {}) {
  return messageSchema.parse({
    id: 'e4ccdc93-7532-4d2e-b802-d10a5b1caefe',
    direction: 'inbound',
    from: 'Example <accounts@example.com>',
    to: ['work@inbox.test'],
    subject: 'Your sign-in code',
    text: 'Your verification code is 123456.',
    html: null,
    received_at: new Date(now - 5000).toISOString(),
    ...overrides,
  });
}

describe('mailbox-to-website boundary', () => {
  it('offers a fresh matching code and parses HTML without executing or fetching it', () => {
    expect(selectCandidate([email()], attempt, now)).toMatchObject({ code: '123456' });
    expect(selectCandidate([email({ text: 'Your code is Ab12cD' })], attempt, now)).toMatchObject({
      code: 'Ab12cD',
    });
    expect(
      selectCandidate(
        [
          email({
            text: null,
            html: '<style>.x{color:#123456}</style><p>Your verification code: <b>654321</b></p><img src="https://evil.test/track">',
          }),
        ],
        attempt,
        now,
      ),
    ).toMatchObject({ code: '654321' });
  });

  it('detects the code length and prefers the labelled code over years, links and order numbers', () => {
    const cases: [string, string | null][] = [
      ['Your PIN is 4821. Enter it within 10 minutes. © 2026 Example Inc.', '4821'],
      ['Sign-in code\n\nXK7P2M9Q\n\nOrder #10203040 ships Monday.', 'XK7P2M9Q'],
      ['Use code 123456 to verify https://example.com/verify?token=98765432', '123456'],
      ['Your verification code is 2026. Sent October 2026.', '2026'],
      ['Thanks for your order 48213 placed in 2026.', null],
    ];
    for (const [text, code] of cases)
      expect(selectCandidate([email({ subject: null, text })], attempt, now), text).toEqual(
        code ? expect.objectContaining({ code }) : null,
      );
    expect(
      selectCandidate(
        [
          email({
            subject: null,
            text: null,
            html: '<p>Your login code</p><table><tr><td style="font-size:32px">735 918</td></tr></table><p>Code expires at 09:30</p><footer>Example Inc. 2026</footer>',
          }),
        ],
        attempt,
        now,
      ),
    ).toBeNull();
    expect(
      selectCandidate(
        [
          email({
            subject: null,
            text: null,
            html: '<p>Your login code</p><table><tr><td style="font-size:32px">735918</td></tr></table><p>It expires at 09:30</p><footer>Example Inc. 2026</footer>',
          }),
        ],
        attempt,
        now,
      ),
    ).toMatchObject({ code: '735918' });
  });

  it('rejects wrong recipients, unparseable senders, stale mail, outbound mail and expired attempts', () => {
    for (const change of [
      { to: ['someone-else@inbox.test'] },
      { from: 'not an address' },
      { received_at: new Date(now - 60_000).toISOString() },
      { direction: 'outbound' },
    ])
      expect(selectCandidate([email(change)], attempt, now)).toBeNull();
    expect(selectCandidate([email()], attempt, attempt.expiresAt)).toBeNull();
    expect(senderAddress('"accounts@example.com" <attacker@evil.test>')).toBe('attacker@evil.test');
    expect(
      selectCandidate(
        [email({ from: '"accounts@example.com" <attacker@evil.test>' })],
        attempt,
        now,
      ),
    ).toMatchObject({ sender: 'attacker@evil.test' });
  });

  it('uses the remembered sender only to break ties between competing fresh codes', () => {
    const known = { ...attempt, knownSender: 'accounts@example.com' as const };
    const other = email({
      id: 'b1353064-588e-4e55-9c86-2da7d0fb72c8',
      from: 'Other <noreply@other.test>',
      text: 'Your code is 654321',
    });
    expect(selectCandidate([email(), other], attempt, now)).toBe('ambiguous');
    expect(selectCandidate([email(), other], known, now)).toMatchObject({
      code: '123456',
      sender: 'accounts@example.com',
    });
    expect(selectCandidate([other], known, now)).toMatchObject({ sender: 'noreply@other.test' });
  });

  it('does not reuse baseline messages or pick between competing fresh codes', () => {
    const first = email();
    expect(selectCandidate([first], { ...attempt, baseline: [first.id] }, now)).toBeNull();
    expect(
      selectCandidate(
        [first, email({ id: 'b1353064-588e-4e55-9c86-2da7d0fb72c8', text: 'Your code is 654321' })],
        attempt,
        now,
      ),
    ).toBe('ambiguous');
  });

  it('refuses recovery emails and messages containing multiple equally likely codes', () => {
    expect(selectCandidate([email({ subject: 'Password reset code' })], attempt, now)).toBeNull();
    expect(
      selectCandidate(
        [email({ text: 'Your code is 123456. Your second code is 654321.' })],
        attempt,
        now,
      ),
    ).toBeNull();
  });
});

describe('extension authorization boundary', () => {
  it('accepts only the exact extension panel sender', () => {
    const url = 'chrome-extension://maildock/sidepanel.html';
    const trusted = { id: 'maildock', url, origin: 'chrome-extension://maildock' };
    expect(isTrustedSender(trusted, 'maildock', url)).toBe(true);
    for (const sender of [
      { ...trusted, id: 'other' },
      { ...trusted, url: 'https://evil.test' },
      { ...trusted, origin: 'https://evil.test' },
      { ...trusted, url: `${url}?spoof=1` },
      { ...trusted, frameId: 1 },
    ]) {
      expect(isTrustedSender(sender as chrome.runtime.MessageSender, 'maildock', url)).toBe(false);
    }
    expect(commandSchema.safeParse({ type: 'fetch', url: 'https://evil.test' }).success).toBe(
      false,
    );
    expect(commandSchema.safeParse({ type: 'watch.fill', attemptId: attempt.id }).success).toBe(
      false,
    );
  });

  it('requires the original OAuth state and exact callback without ambiguous parameters', () => {
    const redirect = 'https://maildock.chromiumapp.org/resend';
    expect(validateCallback(`${redirect}?state=random&code=issued`, redirect, 'random')).toBe(
      'issued',
    );
    for (const callback of [
      `${redirect}?state=wrong&code=issued`,
      `${redirect}?state=random&state=wrong&code=issued`,
      `${redirect}?state=random&code=issued&code=other`,
      `${redirect}?state=random&error=access_denied`,
      'https://evil.test/resend?state=random&code=issued',
      `${redirect}/else?state=random&code=issued`,
    ])
      expect(() => validateCallback(callback, redirect, 'random')).toThrow();
  });
});
