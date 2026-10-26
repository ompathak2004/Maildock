import { z } from 'zod';
import {
  type Attempt,
  type AuthSession,
  attemptSchema,
  authSchema,
  defaultSettings,
  type Inbox,
  inboxSchema,
  type Settings,
  settingsSchema,
} from '../core/model';

export async function initializeStorage(): Promise<void> {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]);
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  const parsed = settingsSchema.safeParse(stored.settings);
  return parsed.success ? parsed.data : { ...defaultSettings, rules: [] };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function getAuth(): Promise<AuthSession | null> {
  const stored = await chrome.storage.session.get('auth');
  const parsed = authSchema.safeParse(stored.auth);
  return parsed.success ? parsed.data : null;
}

export async function saveAuth(auth: AuthSession | null): Promise<void> {
  if (auth) await chrome.storage.session.set({ auth });
  else await chrome.storage.session.remove('auth');
}

export async function getAttempt(): Promise<Attempt | null> {
  const stored = await chrome.storage.session.get('attempt');
  const parsed = attemptSchema.safeParse(stored.attempt);
  return parsed.success ? parsed.data : null;
}

export async function saveAttempt(attempt: Attempt | null): Promise<void> {
  if (attempt) await chrome.storage.session.set({ attempt: attemptSchema.parse(attempt) });
  else await chrome.storage.session.remove('attempt');
}

export async function getInboxes(): Promise<Inbox[]> {
  const stored = await chrome.storage.session.get('inboxes');
  const parsed = z.array(inboxSchema).safeParse(stored.inboxes);
  return parsed.success ? parsed.data : [];
}

export async function saveInboxes(inboxes: Inbox[]): Promise<void> {
  await chrome.storage.session.set({ inboxes });
}
