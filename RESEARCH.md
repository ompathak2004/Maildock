# Maildock feasibility and security research

Research date: 25 October 2026. This report records the documentation research that preceded implementation. The current implementation and validation status are in `README.md`. No live account was connected, and no independent security audit was performed.

Maildock can be a browser extension that reads an authorized mailbox and offers a matching email verification code on the current website. An architecture with no Maildock mail-processing server is feasible. It still needs sensitive credentials and local state, and Resend or Gmail still hosts the mailbox. Security is the hard part, particularly preventing a hostile website from obtaining a code for another website.

The supplied [shared conversation](https://chatgpt.com/s/cx_6adde392ee008191b473aebf055fdf8b) was read for context. Its suggestions were checked against current official documentation. This proposal concerns existing websites that send OTP emails; Chrome's separate Email Verification protocol requires website/provider integration.

## Decisions supported by the research

| Question                                                    | Finding                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can people connect a Resend account?                        | Yes. Resend now documents public OAuth clients with authorization code flow and mandatory PKCE. Do not collect their Resend password.                                                                                                    |
| Is access limited to reading one inbox?                     | Not with the documented OAuth scopes. Inbox operations require `full_access`; the other scope is `emails:send`. A local inbox selector does not narrow the token's provider-enforced authority.                                          |
| Must Maildock have a backend?                               | Not for an on-demand polling design. An extension can call the provider from its privileged context with the appropriate host permission. Actual Resend extension OAuth behavior still needs an integration test.                        |
| Can an extension receive a Resend webhook directly?         | A normal installed extension has no public HTTPS webhook endpoint. Webhooks require a reachable receiver and a relay to the extension.                                                                                                   |
| Must a named inbox exist?                                   | Yes for the structured Inboxes API. Resend's separate Receiving product can accept any local part on a receiving domain without creating an Inbox resource for each address.                                                             |
| Can a consumer Gmail address become a Resend inbox address? | Not under the documented Create Inbox requirements: the address must be on a verified domain the user controls. Gmail can forward copies to a Resend receiving address, or Maildock can access Gmail directly with Google authorization. |

Sources: [OAuth guide](https://resend.com/docs/guides/building-a-resend-oauth-client), [Create Inbox](https://resend.com/docs/api-reference/inboxes/create-inbox), [Receiving](https://resend.com/docs/dashboard/receiving/introduction), [Chrome extension security](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure).

## Recommended initial experience

1. User chooses Connect Resend and approves access on Resend's own login/consent screen.
2. Maildock lists the user's inboxes. They select an existing inbox, or explicitly choose Create inbox. For the first prototype, select an existing dedicated test inbox.
3. Provisioning verifies the chosen domain and receiving setup before displaying the address as ready. A sending-verified domain alone is insufficient. Create the inbox before requesting an OTP; do not rely on historical messages being imported after creation.
4. User starts a short verification attempt from Maildock's trusted extension UI. Record the provider account, inbox, exact website origin, tab, document/frame, baseline message IDs, start time, and expiry.
5. User requests the website's code. While the attempt is active, Maildock polls the mailbox, retrieves candidate messages, and parses them locally.
6. Maildock offers a code only when the recipient, approved website/sender mapping, freshness, message purpose, and current browser target agree. Ambiguity results in no automatic fill.
7. User selects Fill code. Only the selected code crosses into the target page; mailbox tokens and full email bodies never do. Stop watching and clear temporary state. Do not automatically submit initially.

`work@ompathak.dev` matches the stated domain. `work@ompathakd.dev` is a different domain and must not be silently accepted as equivalent.

If the root domain already uses another mail provider, use a dedicated receiving subdomain such as `login.ompathak.dev`, or explicit forwarding. Adding a second provider's MX record does not duplicate delivery and can disrupt existing mail. Copy the actual MX value from the user's Resend dashboard; do not hardcode documentation examples. See [custom receiving domains](https://resend.com/docs/dashboard/receiving/custom-domains).

## API map

| Purpose                       | API                                                             |
| ----------------------------- | --------------------------------------------------------------- |
| Register public OAuth client  | `POST /oauth/register`, `token_endpoint_auth_method: none`      |
| User authorization            | `GET /oauth/authorize`, explicit scope, random state, S256 PKCE |
| Exchange code / rotate tokens | `POST /oauth/token`                                             |
| Disconnect                    | `POST /oauth/revoke` with refresh token                         |
| Discover inboxes              | `GET /inboxes`                                                  |
| Create selected inbox         | `POST /inboxes`                                                 |
| Read inbox configuration      | `GET /inboxes/{inbox_id}`                                       |
| Discover recent activity      | `GET /inboxes/{inbox_id}/threads`                               |
| Read a thread's messages      | `GET /inboxes/{inbox_id}/threads/{thread_id}/emails`            |
| Read an individual message    | `GET /inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}` |
| Optional indexed search       | `GET /inboxes/{inbox_id}/threads/search`                        |
| Optional server notification  | `inbox.email.received` webhook                                  |
| Separate Receiving product    | `GET /emails/receiving` and `GET /emails/receiving/{email_id}`  |

Sources: [documentation index](https://resend.com/docs/llms.txt), [OAuth registration](https://resend.com/docs/api-reference/oauth/register), [token exchange](https://resend.com/docs/api-reference/oauth/token), [revocation](https://resend.com/docs/api-reference/oauth/revoke), [thread listing](https://resend.com/docs/api-reference/inboxes/list-threads), [message listing](https://resend.com/docs/api-reference/inboxes/list-thread-emails), [message retrieval](https://resend.com/docs/api-reference/inboxes/get-thread-email), [search](https://resend.com/docs/api-reference/inboxes/search-threads), [webhook payload](https://resend.com/docs/webhooks/inboxes/email-received).

Thread listing is ordered by latest activity. Messages within a thread are oldest first and paginated, so reading only the first page can miss the latest OTP. Track message IDs, inspect updated existing threads as well as new threads, and handle pagination. Do not rely on unread status: another mail client can read the message first. The [official CLI reference](https://resend.com/docs/cli#inboxes) notes search can lag new email by about a minute; avoid indexed search as the only low-latency discovery method.

A proposed initial poll interval is 3–5 seconds for a bounded attempt, with backoff and jitter. This is a design choice to benchmark, not a provider delivery guarantee. Resend documents a default 10 requests/second per team, shared across its API keys. Respect response limits and `Retry-After`, and coordinate tabs within an installation. [Usage limits](https://resend.com/docs/api-reference/rate-limit).

## OAuth and token design

Use a registered public client with `chrome.identity.launchWebAuthFlow()` and its exact `https://<extension-id>.chromiumapp.org/...` redirect URL. Registration permits HTTPS callbacks, making this a plausible integration; it has not yet been tested against Resend. Use separate, stable development and production extension IDs and register exact callbacks.

A subtle constraint: Resend's Client ID Metadata Documents require HTTPS callbacks on the document's own host. A document hosted on Maildock's domain therefore cannot simply name a Chromium callback on another host. Prefer registering the extension's public client rather than assuming CIMD works unchanged. No client secret belongs in the extension. Validate state and callback URL, keep the verifier private, use one-time authorization state, and fail closed on errors. [Resend OAuth guide](https://resend.com/docs/guides/building-a-resend-oauth-client), [Chrome identity](https://developer.chrome.com/docs/extensions/reference/api/identity).

Access tokens last 900 seconds. Refresh tokens last 60 days from issuance and rotate on use. Serialize refresh operations across all extension contexts and atomically replace the token; concurrent refreshes or replay can revoke the grant. Revoking the refresh token invalidates the grant's access and refresh tokens. [Tokens](https://resend.com/docs/api-reference/oauth/token), [revocation](https://resend.com/docs/api-reference/oauth/revoke).

For an initial security-focused prototype, keep tokens and attempts in trusted extension session storage and reconnect after browser restart. `storage.session` is memory-backed and not exposed to content scripts by default. Keep ordinary preferences separately and restrict local storage access to trusted contexts. Never sync mailbox credentials. A later persistent vault needs a genuine user-held unlock secret or native OS credential storage; storing a ciphertext beside its decryption key is not meaningful protection against extension compromise. [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage).

## Security requirements and unresolved boundaries

- **Provider authority:** Resend currently grants more than this product needs. Use a dedicated test team/account for the prototype. For general release, seek a provider-enforced read-only inbox scope or explicitly accept and disclose the broad authority. Moving the token to a backend does not remove that backend's authority.
- **Origin binding:** A malicious website can label an input “OTP” and request another site's code. Start from approved site mappings, compare exact origins using parsed URLs, and bind each attempt to the tab/document/frame. Cancel on navigation; explicitly model legitimate authentication-domain transitions. Do not derive trust from page text or email links.
- **Sender verification:** Display names and From strings are spoofable. Resend's separate Receiving retrieval endpoint documents a provider-computed `authentication` object containing SPF, DKIM, and DMARC results. The inspected Inbox message schema does not document this field. Verify a supported way to obtain trusted authentication results for Inbox messages before unattended processing; do not assume Receiving IDs and Inbox IDs are interchangeable. [Receiving retrieval](https://resend.com/docs/api-reference/emails/retrieve-received-email), [Inbox retrieval](https://resend.com/docs/api-reference/inboxes/get-thread-email).
- **Attempt matching limits:** Time, recipient, sender, and website matching are heuristics, not a cryptographic link to the originating website session. Allow one outstanding attempt per account/site initially, track baseline IDs and resends, expire attempts, reject ambiguous or delayed candidates, and retain manual fallback. Email OTPs remain phishable.
- **Minimal content-script authority:** The worker owns provider access. Validate all messages and their browser-supplied sender information. Do not expose an arbitrary URL fetcher, arbitrary inbox selector, or generic “get latest OTP” command to webpages. Request site permission on user action or per approved site rather than all-site access by default.
- **Untrusted content:** Parse plain text locally with bounded inputs and deterministic site adapters. Never render raw email HTML in privileged extension pages, load tracking images, execute mail content, or pass messages to an LLM. Do not silently open magic links, password resets, or account recovery links.
- **Credential handling:** No email bodies, tokens, codes, or tokenized URLs in telemetry, console logs, crash reports, clipboard history by default, or browser sync. Clear transient data on completion, timeout, lock, and disconnect. Disconnection must also revoke the provider grant when online, with a retry/manual-revocation path if offline.
- **Release integrity:** Bundle executable code, enforce CSP, minimize dependencies and permissions, protect publisher accounts, review updates, and obtain an independent security review before broad release. A compromised extension update can steal credentials even when no developer backend exists.

These are proposed controls, not an audit result. Chrome's [extension security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure) specifically treats content-script messages as untrusted and recommends keeping sensitive operations in the service worker.

## Local operation versus a server

The recommended first version is: website sends email → Resend stores email → extension polls Resend → extension parses and offers code → approved target page receives code.

Keep rapid polling tied to an active user workflow, ideally an open extension side panel. Manifest V3 service workers may terminate after 30 seconds idle; an ordinary infinite timer is not a reliable daemon. Keep recoverable state in session storage, resume safely, and test browser sleep, worker termination, background throttling, and tab closure. Chrome alarms have a 30-second minimum period; they are not a 3-second scheduler. [Worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

If persistent push becomes necessary, add a webhook receiver and authenticated relay. Verify signatures over the raw request body, deduplicate events, isolate users, and minimize retention. Inbox webhooks omit bodies but include addresses, subjects, and identifiers, so even a relay that never fetches bodies processes sensitive metadata. That design requires infrastructure and routing state and cannot truthfully claim that no mail data reaches Maildock. [Inbox webhook payload](https://resend.com/docs/webhooks/inboxes/email-received).

“No Maildock server stores mail” can be accurate for the polling design. “Nothing is stored anywhere” is inaccurate: providers retain mail, and the browser needs authorization and configuration. Static hosting for a privacy policy or extension distribution is separate from processing users' mail.

## Gmail options

**Direct Gmail adapter, recommended for Gmail users:** Connect through Google authorization and use `gmail.readonly`, `users.messages.list`, and `users.messages.get`. Process matching messages in the extension. This supports the existing Gmail address without routing email through Resend. Ordinary Google sign-in alone does not authorize mailbox reading. `gmail.readonly` permits reading the mailbox, not only OTPs; a query/filter minimizes what the app reads but does not narrow the OAuth grant. Public distribution requires the applicable restricted-scope verification. Google's documentation additionally requires a security assessment when restricted data is stored on or transmitted through servers; a genuinely device-only design can avoid that server path but does not automatically eliminate verification. [Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [list messages](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [get message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

**Forward selected Gmail messages to Resend:** Add an actual receiving address in Gmail forwarding settings, verify the destination, and create narrow forwarding filters with global forwarding disabled. Users continue entering their Gmail address on websites. The matching email first arrives in Gmail, then a copy reaches Resend. This is not importing the Gmail account, does not copy old mail automatically, adds another provider copy, and requires testing forwarding latency and preserved identity/authentication information. [Google forwarding instructions](https://support.google.com/mail/answer/10957?hl=en).

Resend's `forwarding: true` creates a receiving destination for an Inbox associated with a verified custom domain; it does not authorize creating `pathakom890@gmail.com` as a verified Resend-domain inbox. Retrieve `receiving_address` and configure forwarding explicitly. [Creating inboxes](https://resend.com/docs/dashboard/inboxes/create-inboxes).

## Existing products

These are current publisher descriptions, not tested security endorsements or an exhaustive market survey.

| Product                                                                                                                  | Relevant overlap                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Quickfill](https://chromewebstore.google.com/detail/quickfill-%E2%80%93-gmail-otp-2fa/ffpecbofdkbdhkpgfgjjifapmfideeid) | Advertises one-click Gmail OTP filling, multiple Gmail accounts, split inputs, and local processing.                                                                          |
| [InboxKey](https://chromewebstore.google.com/detail/inboxkey-autofill-verific/mioicbneapdjamkppcidooggnmegpocn)          | Advertises automatic email OTP filling, confirmed magic-link opening, and a local InboxBridge companion that connects through IMAP and stores credentials in the OS keychain. |
| [AutoFill Code](https://addons.mozilla.org/en-US/firefox/addon/autofill-code/)                                           | Advertises Gmail read-only access, local processing, and compatible OTP-field filling. Its Firefox listing requests access to all websites.                                   |

The targeted search did not establish an exact Resend-Inboxes-focused equivalent; that is not proof none exists. Resend integration, narrower browser permissions, transparent security design, and reliable account/site matching are potential distinctions. Local processing and OTP autofill alone are already offered by competitors.

Chrome's [October 2026 Email Verification update](https://developer.chrome.com/blog/email-verification-october-2026) describes a separate origin-trial protocol through which participating providers issue proof of address ownership. It needs site/provider support and does not retrofit OTP autofill onto arbitrary existing websites.

## Implementation sequence and acceptance gates

1. **OAuth spike:** Register a public development client; prove Chrome callback, PKCE, scope consent, direct API requests, renewal, disconnection, and account isolation using a dedicated test account. No production credentials are needed in chat.
2. **Receiving spike:** Use one verified receiving domain/subdomain and one pre-created inbox. Send synthetic messages and measure real delivery-to-API latency. Verify pagination, message identity, quotas, trusted authentication evidence, and whether the separate Receiving API is preferable for the OTP use case.
3. **One-site prototype:** Manifest V3 with TypeScript, trusted side panel, worker-owned provider client, explicit attempt state machine, local parser, and a small content script. Implement one known website or a controlled test fixture. Fill only on confirmation.
4. **Adversarial tests:** Wrong origin, spoofed From, hostile iframe, forged worker message, reused/stale OTP, simultaneous accounts/tabs, resends, worker suspension, navigation, rate limits, refresh races, revocation, and network failure must produce safe failure. Check that logs and network traffic contain no unintended mail/credential disclosure.
5. **Expand only after evidence:** Add supported sites and optionally direct Gmail; automatic mode and magic links require additional review. Complete the relevant store/provider verification and an independent security assessment before promoting the product as suitable for sensitive everyday accounts.

Recommendation: proceed with a small Resend OAuth + dedicated-inbox prototype, using an entirely local email-processing path. Treat the broad Resend scope and trustworthy sender/attempt matching as release gates, not minor follow-up tasks.
