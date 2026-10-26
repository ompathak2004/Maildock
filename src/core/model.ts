import { z } from 'zod';

export const emailAddress = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
export const inboxId = z.uuid().brand<'InboxId'>();
export const threadId = z.uuid().brand<'ThreadId'>();
const messageId = z.uuid().brand<'MessageId'>();
export const inboxSchema = z.object({
  id: inboxId,
  email_address: emailAddress,
  name: z.string().max(256),
});
export type Inbox = z.infer<typeof inboxSchema>;

export const messageSchema = z.object({
  id: messageId,
  direction: z.enum(['inbound', 'outbound']),
  from: z.string().max(1024),
  to: z.array(z.string().max(320)).max(100),
  subject: z.string().max(2048).nullable(),
  text: z.string().max(250_000).nullable(),
  html: z.string().max(500_000).nullable(),
  received_at: z.iso.datetime({ offset: true }),
});
export type MailMessage = z.infer<typeof messageSchema>;

export const targetSchema = z.object({
  tabId: z.number().int().nonnegative(),
  documentId: z.string().min(1),
  origin: z.url(),
  title: z.string().max(200),
});
export type Target = z.infer<typeof targetSchema>;

const ruleSchema = z.object({
  origin: z.url(),
  sender: emailAddress,
});
export const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  clientId: z.string().max(2048).nullable(),
  selectedInboxId: inboxId.nullable(),
  rules: z.array(ruleSchema).max(100),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  schemaVersion: 1,
  clientId: null,
  selectedInboxId: null,
  rules: [],
};

export const authSchema = z.object({
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
});
export type AuthSession = z.infer<typeof authSchema>;

const candidateSchema = z.object({
  messageId,
  code: z.string().regex(/^[A-Za-z0-9]{4,8}$/),
  sender: emailAddress,
  subject: z.string().max(200),
  receivedAt: z.number(),
});
export type Candidate = z.infer<typeof candidateSchema>;

const attemptBase = {
  id: z.uuid(),
  target: targetSchema,
  inbox: inboxSchema,
  knownSender: emailAddress.nullable(),
  startedAt: z.number(),
  expiresAt: z.number(),
  baseline: z.array(messageId).max(2000),
  checkedAt: z.number(),
  nextPollAt: z.number(),
};
export const attemptSchema = z.discriminatedUnion('phase', [
  z.object({ ...attemptBase, phase: z.literal('watching'), note: z.string().nullable() }),
  z.object({ ...attemptBase, phase: z.literal('ready'), candidate: candidateSchema }),
  z.object({ ...attemptBase, phase: z.literal('filled') }),
  z.object({ ...attemptBase, phase: z.literal('stopped'), reason: z.string() }),
]);
export type Attempt = z.infer<typeof attemptSchema>;

export const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state.get') }),
  z.strictObject({ type: z.literal('auth.connect') }),
  z.strictObject({ type: z.literal('auth.disconnect') }),
  z.strictObject({ type: z.literal('inbox.list') }),
  z.strictObject({ type: z.literal('inbox.select'), inboxId }),
  z.strictObject({
    type: z.literal('inbox.create'),
    email: emailAddress,
    name: z.string().trim().min(1).max(64),
  }),
  z.strictObject({ type: z.literal('target.get') }),
  z.strictObject({
    type: z.literal('watch.start'),
    inboxId,
    target: targetSchema,
  }),
  z.strictObject({ type: z.literal('watch.poll'), attemptId: z.uuid() }),
  z.strictObject({ type: z.literal('watch.stop') }),
  z.strictObject({
    type: z.literal('watch.fill'),
    attemptId: z.uuid(),
    messageId,
    reviewedSender: z.literal(true),
  }),
]);
export type Command = z.infer<typeof commandSchema>;

export type ViewState = {
  connected: boolean;
  inboxes: Inbox[];
  settings: Omit<Settings, 'clientId'>;
  attempt: Attempt | null;
};

export const responseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    state: z.object({
      connected: z.boolean(),
      inboxes: z.array(inboxSchema),
      settings: settingsSchema.omit({ clientId: true }),
      attempt: attemptSchema.nullable(),
    }),
    target: targetSchema.nullable(),
  }),
  z.object({ ok: z.literal(false), error: z.string(), code: z.string() }),
]);
export type Response = z.infer<typeof responseSchema>;
