# Architecture

## Runtime and boundaries

```text
Website sends email → Resend inbox
                          ↑ HTTPS + OAuth
                    MV3 service worker
                      ↙           ↘
       trusted session state     selected code + metadata
                                         ↓
                              React popup / side panel
                                         ↓ explicit review
                    worker rechecks origin + tab + document
                                         ↓ one code
                      isolated script in the selected page
```

TypeScript supplies shared domain types, Zod validates network/storage/message boundaries, React renders the popup and side panel, and WXT bundles extension entry points. Native Chrome APIs avoid a browser compatibility layer. HTML parsing uses `htmlparser2` without a DOM or remote resources. No server, database, webhook, provider SDK, or generic plugin abstraction is needed for this polling workflow.

| Module                      | Responsibility                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `core/model.ts`             | Boundary schemas, branded provider IDs, the inbox watch, and discriminated commands            |
| `core/matching.ts`          | Pure extraction and freshness/recipient/sender/ambiguity rules                                 |
| `background/controller.ts`  | Command authorization, inbox polling, fill-time page binding and authorization                 |
| `background/auth.ts`        | Public OAuth registration, PKCE, callback validation, serialized token rotation and revocation |
| `background/http.ts`        | Fixed provider origin, deadlines, response size limits, sanitized errors                       |
| `background/resend.ts`      | Provider schemas, inbox operations, bounded pagination                                         |
| `background/storage.ts`     | Local preferences and trusted session state                                                    |
| `background/page.ts`        | Top-frame inspection and document-bound isolated-world fill                                    |
| `entrypoints/background.ts` | Browser event wiring and inbox polling alarm                                                   |
| `ui/App.tsx`                | Panel interactions and active polling; no provider credentials                                 |
| `ui/Popup.tsx`              | Compact toolbar preview, explicit fill/copy/dismiss, and side-panel entry                      |

Only messages from our exact bundled `sidepanel.html` and `popup.html` URLs, extension ID, extension origin, and top frame are accepted. The same documents may be opened in extension tabs for automation. Browser-supplied sender identity is checked before command parsing. The manifest exposes no web-accessible resources or external message channel.

## State and concurrency

One installation has one inbox watch. It holds at most five fresh codes, the IDs of consumed and announced messages, poll timing, a transient provider note, and the last fill confirmation. Connecting enables inbox checks even while the popup and panel are closed. Codes leave when they fall out of the three-minute window, are filled, or are discarded. A transient network error keeps the last successful list and shows the note. Navigation never changes this state because the page is resolved at fill time, not at watch time.

The `maildock-state` Web Lock serializes commands and expiry work across popup and panel instances. `maildock-auth` serializes authentication and refresh-token rotation. These locks are worker-local coordination primitives, not a distributed lock across devices. Only the worker accesses tokens. A lost response during refresh can require reconnection; stale tokens are never reused after a confirmed invalid grant.

The watch survives worker suspension through session storage, but not a browser restart or extension reload. The popup and panel request polls every three seconds while connected; the worker independently enforces the next permissible poll time. A 30-second alarm also polls the inbox and prunes stale codes without requiring either UI to be open. Worker startup checks for the alarm without resetting an existing schedule, then refreshes the watch. Commands and background polls share the state lock and backoff. Chrome may delay alarms; this is not a real-time delivery guarantee. No short-interval daemon relies on the worker remaining alive.

The toolbar badge is derived from fresh code candidates whose sender check is not `fail`; sign-in links do not increment it. It is a count for review, not a claim that a code belongs to the current website. Badge text and tooltip contain no codes, subjects, senders, or URLs. Commands and background polls reconcile the badge even after errors, so expiration or lost authorization removes stale counts.

New eligible message IDs are recorded in a bounded session-only `announced` list before attempting `chrome.action.openPopup`. Closing the popup, a repeated poll, or worker suspension therefore does not trigger another popup for the same message. Inbox switching preserves this list. Maildock attempts opening only when a normal Chrome window is focused and neither of its UI documents is open. Browser refusal leaves the badge available without repeated attempts. The popup shows code metadata and explicit actions, refreshes while open, and provides a user-gesture button to open the full side panel. Background arrival handling never fills a field or submits a form.

## Mail and page binding

Polls list recent threads across inbox/archive, then paginate thread emails, which Resend returns oldest first. Search indexing and unread state are not used. A bounded request budget fails closed rather than accepting an incomplete mailbox view.

A candidate must be inbound, addressed to the selected inbox, received within the last three minutes, not previously filled or discarded, and unambiguous within its message. The user does not declare a sender or code length. Extraction ranks each 4–8 character token by context: labelled (“code: 123456”), alone on its line, or merely near a verification keyword; year-like tokens need a label. Grouped digits (“735 918”, “4821-7730”) are joined before scanning unless more digits follow, so phone and account numbers keep their shape. Only a unique top-ranked code per message is offered. A message with no code may instead yield one sign-in link: the subject must read like a sign-in request and exactly one HTTPS, non-IP, non-punycode link must be labelled as that action. Several fresh messages are listed newest first with sender and subject, except that a sender whose registrable domain matches the current website moves to the top (under shared hosting suffixes such as `github.io` or `amazonaws.com` only identical hostnames match, so sibling tenants never do); a resend of the same code or link collapses into the newest message. Recovery/payment-like messages are excluded heuristically, from either the text or the HTML part, before a code or a link is considered.

For each listed message the worker fetches Resend's receiving record once and keeps the SPF/DKIM/DMARC verdict with the item: `pass` when DMARC or DKIM passed, `fail` on a DMARC failure or SPF and DKIM both failing, `gray` otherwise, `unknown` when the record could not be read. A `fail` item cannot be filled, copied, or opened; the worker enforces this in `release`, not only in the panel. These checks still do not bind an email to a login session, so the user reviews every fill.

The panel learns the fillable page on every poll: the worker tries to read the origin, title, and `documentId` of the active tab and returns null when `activeTab` has not been granted there. The fill button names that host, and the command carries the exact target the user saw. Before filling, the worker recaptures the active tab and rejects the command if the tab, origin, or document differs, refetches mail and checks that the message still yields the same code, then injects into that `documentId`; it cannot fall through to a newly navigated document. The message is recorded as consumed and the sender remembered for the origin only after the injection reports success, so a page without a supported field can be retried on the right page without requesting a new code. Only one empty, visible supported input/group is filled. The page receives normal input/change events and can itself submit in response.

The toolbar declares a native action popup. Clicking the icon grants `activeTab`; opening the popup programmatically does not. A popup without page access offers copy and explains the required toolbar click, rather than requesting broader permissions. Chrome keeps a toolbar-click grant across same-origin navigations and drops it when the tab moves to another origin. The manifest declares `optional_host_permissions: ["https://*/*"]` but requests nothing at install; after a successful fill the panel offers `chrome.permissions.request` for that one origin, and lists granted origins with a remove action. Sites already allowed support explicit filling directly from an automatically opened popup. Opening a sign-in link uses `chrome.tabs.create`, which needs no permission, and consumes the message only after the tab is created. Do not replace this with all-site access to simplify page interaction.

The native popup requires Chrome 127+, when `action.openPopup` became available to ordinary extensions. Sources checked with Firecrawl: [Chrome action API](https://developer.chrome.com/docs/extensions/reference/api/action#method-openPopup), [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), and [WebExtensions popup permission behavior](https://github.com/w3c/webextensions/issues/160).

## Provider decisions

Public OAuth uses `token_endpoint_auth_method: none`, S256 PKCE, random state, and the exact Chromium callback. Dynamic registration supports local installs; a stable distribution should supply its registered public client ID. A metadata-document client cannot assume that its different-host Chromium callback is permitted. Resend's available inbox OAuth scope is `full_access`, despite Maildock using only inbox read/create operations.

OAuth requests and inbox API requests go directly to `api.resend.com`. Redirects, cookies, cache use, oversized responses, and unvalidated provider data are rejected. Rate limits honor bounded `Retry-After`; polling resumes only after the backoff. Message bodies exist only while matching; no attachments or links are downloaded.

Sources: [OAuth](https://resend.com/docs/guides/building-a-resend-oauth-client), [registration](https://resend.com/docs/api-reference/oauth/register), [threads](https://resend.com/docs/api-reference/inboxes/list-threads), [thread emails](https://resend.com/docs/api-reference/inboxes/list-thread-emails), [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage). Detailed evidence and open provider questions are in `RESEARCH.md` in this directory.

## Maintenance

The UI uses a neutral black/white/grey palette in `ui/tokens.css`. `ParticleWordmark.tsx` adapts React Bits Particle Text for a single local canvas logo. It stops requesting frames once settled, pauses when hidden, cleans up observers/listeners on unmount, and uses static text for reduced motion. The upstream notice ships in `public/licenses/react-bits.txt`. No remote animation code or fonts load at runtime. The supplied Resend logo is the only provider image. `assets/icon.svg` generates the required browser icon PNGs through `npm run icons`.

`npm run deadcode` checks unused source files, exports, and dependencies through Knip and is included in `npm run check`. TypeScript also rejects unused local declarations and parameters. Generated assets and legal notices have explicit purposes even when they are not JavaScript imports.

The focused Cursor pstack principles used here are domain modeling, boundary validation, type-system discipline, reader load, behavior-focused tests, and comment review. They were installed from commit `99b609a72323b70204eab407c622f436e858e112` of [cursor/plugins](https://github.com/cursor/plugins/tree/99b609a72323b70204eab407c622f436e858e112/pstack/skills). The full Cursor-specific orchestration skill was not copied into this application's runtime.

Keep invariants in schemas, control flow, and focused checks. Avoid introducing a second source of truth or wrappers with one caller. New providers, persistent credentials, background push, and cross-frame support need explicit threat-model changes. The current build is an evaluation release pending live provider verification and independent security review.
