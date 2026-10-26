# Architecture

## Runtime and boundaries

```text
Website sends email → Resend inbox
                          ↑ HTTPS + OAuth
                    MV3 service worker
                      ↙           ↘
       trusted session state     selected code + metadata
                                         ↓
                                   React side panel
                                         ↓ explicit review
                    worker rechecks origin + tab + document
                                         ↓ one code
                      isolated script in the selected page
```

TypeScript supplies shared domain types, Zod validates network/storage/message boundaries, React renders the panel, and WXT bundles extension entry points. Native Chrome APIs avoid a browser compatibility layer. HTML parsing uses `htmlparser2` without a DOM or remote resources. No server, database, webhook, provider SDK, or generic plugin abstraction is needed for this polling workflow.

| Module                      | Responsibility                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `core/model.ts`             | Boundary schemas, branded provider IDs, discriminated attempts and commands                    |
| `core/matching.ts`          | Pure extraction and freshness/recipient/sender/ambiguity rules                                 |
| `background/controller.ts`  | Command authorization, attempt transitions, polling, final fill authorization                  |
| `background/auth.ts`        | Public OAuth registration, PKCE, callback validation, serialized token rotation and revocation |
| `background/http.ts`        | Fixed provider origin, deadlines, response size limits, sanitized errors                       |
| `background/resend.ts`      | Provider schemas, inbox operations, bounded pagination                                         |
| `background/storage.ts`     | Local preferences and trusted session state                                                    |
| `background/page.ts`        | Top-frame inspection and document-bound isolated-world fill                                    |
| `entrypoints/background.ts` | Browser event wiring and expiry alarm                                                          |
| `ui/App.tsx`                | Panel interactions and active polling; no provider credentials                                 |

Only messages from our exact bundled panel URL, extension ID, extension origin, and top frame are accepted. The same document may be opened in an extension tab for automation. Browser-supplied sender identity is checked before command parsing. The manifest exposes no web-accessible resources or external message channel.

## State and concurrency

One installation has one active attempt. `watching → ready → filled` is the success path; expiry, navigation, disconnection, or unsafe data stops it. A transient network error returns to `watching` and discards the offered code until a fresh successful check. Zod strips fields from previous variants when state is persisted, including candidate codes after completion or cancellation.

The `maildock-state` Web Lock serializes commands and expiry work across panels. `maildock-auth` serializes authentication and refresh-token rotation. These locks are worker-local coordination primitives, not a distributed lock across devices. Only the worker accesses tokens. A lost response during refresh can require reconnection; stale tokens are never reused after a confirmed invalid grant.

Attempts survive worker suspension through session storage, but not a browser restart or extension reload. The panel requests polls every three seconds while watching; the worker independently enforces the next permissible poll time. A 30-second alarm expires abandoned attempts. Every read/fill also checks expiry. No short-interval daemon relies on the worker remaining alive.

## Mail and page binding

Starting a watch records recent message IDs before setting its start time. Polls list recent threads across inbox/archive, then paginate thread emails, which Resend returns oldest first. Search indexing and unread state are not used. A bounded request budget fails closed rather than accepting an incomplete mailbox view.

A candidate must be inbound, addressed to the selected inbox, newer than the attempt, absent from its baseline, and unambiguous. The user does not declare a sender or code length. Extraction ranks each 4–8 character token by context: labelled (“code: 123456”), alone on its line, or merely near a verification keyword; year-like tokens need a label. Only a unique top-ranked code is offered. When competing fresh messages carry different codes, the sender remembered from the last reviewed fill on that origin breaks the tie; otherwise the attempt reports ambiguity. Recovery/payment-like messages are excluded heuristically. These checks do not cryptographically bind an email to a login session. Sender authentication is an unresolved provider limitation, so the user must review every fill.

Before filling, the worker refetches mail, checks the reviewed message identity and code, validates the active tab/origin/document, and records the attempt as consumed before injection. Injection targets Chrome's `documentId`; it cannot fall through to a newly navigated document. This favors preventing duplicate disclosure over retrying after an uncertain crash. Only one empty, visible supported input/group is filled. The page receives normal input/change events and can itself submit in response.

The toolbar uses `chrome.action.onClicked` to open the side panel. Browser integration testing found that automatic `openPanelOnActionClick` did not grant `activeTab` in the tested Chrome build. Buttons within the panel do not grant that permission either. Do not replace this with all-site access to simplify page interaction. See [Chrome's side-panel guidance](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/chrome-extensions/references/extensions/side-panel.md).

## Provider decisions

Public OAuth uses `token_endpoint_auth_method: none`, S256 PKCE, random state, and the exact Chromium callback. Dynamic registration supports local installs; a stable distribution should supply its registered public client ID. A metadata-document client cannot assume that its different-host Chromium callback is permitted. Resend's available inbox OAuth scope is `full_access`, despite Maildock using only inbox read/create operations.

OAuth requests and inbox API requests go directly to `api.resend.com`. Redirects, cookies, cache use, oversized responses, and unvalidated provider data are rejected. Rate limits honor bounded `Retry-After`; polling resumes only after the backoff. Message bodies exist only while matching; no attachments or links are downloaded.

Sources: [OAuth](https://resend.com/docs/guides/building-a-resend-oauth-client), [registration](https://resend.com/docs/api-reference/oauth/register), [threads](https://resend.com/docs/api-reference/inboxes/list-threads), [thread emails](https://resend.com/docs/api-reference/inboxes/list-thread-emails), [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage). Detailed evidence and open provider questions are in `RESEARCH.md`.

## Maintenance

The UI uses a neutral black/white/grey palette in `ui/tokens.css`. `ParticleWordmark.tsx` adapts React Bits Particle Text for a single local canvas logo. It stops requesting frames once settled, pauses when hidden, cleans up observers/listeners on unmount, and uses static text for reduced motion. The upstream notice ships in `public/licenses/react-bits.txt`. No remote animation code or fonts load at runtime. The supplied Resend logo is the only provider image. `assets/icon.svg` generates the required browser icon PNGs through `npm run icons`.

`npm run deadcode` checks unused source files, exports, and dependencies through Knip and is included in `npm run check`. TypeScript also rejects unused local declarations and parameters. Generated assets and legal notices have explicit purposes even when they are not JavaScript imports.

The focused Cursor pstack principles used here are domain modeling, boundary validation, type-system discipline, reader load, behavior-focused tests, and comment review. They were installed from commit `99b609a72323b70204eab407c622f436e858e112` of [cursor/plugins](https://github.com/cursor/plugins/tree/99b609a72323b70204eab407c622f436e858e112/pstack/skills). The full Cursor-specific orchestration skill was not copied into this application's runtime.

Keep invariants in schemas, control flow, and focused checks. Avoid introducing a second source of truth or wrappers with one caller. New providers, persistent credentials, background push, magic links, and cross-frame support need explicit threat-model changes. The current build is an evaluation release pending live provider verification and independent security review.
