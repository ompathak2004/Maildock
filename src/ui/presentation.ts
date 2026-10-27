import type { SenderCheck } from '../core/model';

export const checkLabel: Record<SenderCheck, { text: string; tone: string }> = {
  pass: { text: 'Verified sender', tone: 'ok' },
  gray: { text: 'Sender not verified', tone: 'warn' },
  fail: { text: 'Sender check failed', tone: 'bad' },
  unknown: { text: 'Sender check unavailable', tone: 'warn' },
};
