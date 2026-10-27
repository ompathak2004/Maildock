# Maildock

[![Verify](https://github.com/ompathak2004/Maildock/actions/workflows/verify.yml/badge.svg)](https://github.com/ompathak2004/Maildock/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Chrome Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-black.svg)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)

Maildock is a Chrome extension that brings a fresh email verification code from your [Resend](https://resend.com) inbox to the login page you are on. Connect your inbox, close the panel, and review new codes in a compact toolbar popup. No backend, no content scripts, no all-sites permission.

## Demo

https://github.com/user-attachments/assets/b1a29e44-7913-4f11-b7d6-ccba37c2ad20

## How it works

1. You sign in to a website with an address from a Resend inbox you own, for example `me@inbound.yourdomain.com`.
2. Maildock watches that inbox while connected, even with the side panel closed. A compact toolbar popup opens once for each new code, with its sender, subject, and authentication result. The badge keeps a count if you close or miss the popup.
3. You click **Fill code on example.com**. The service worker rechecks the tab, origin, and document, then fills the code. It never clicks Submit.

Everything runs inside the extension. The service worker talks to the Resend API directly. The popup and side panel never see tokens or full message bodies.

## Install

Maildock is not on the Chrome Web Store yet. Build it from source.

Requirements: Node.js 24 or newer, npm, and Chrome 127 or newer.

```sh
git clone https://github.com/ompathak2004/Maildock.git
cd Maildock
npm ci
npm run build
```

Then load it in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `.output/chrome-mv3` folder.
4. Pin Maildock to the toolbar.

No API key or client secret is needed. Maildock registers a public OAuth client with Resend on first connection; login and consent happen on resend.com.

## Set up Resend

1. In the Resend dashboard, enable **Receiving** for a domain or subdomain you control and add the DNS records it shows. Maildock does not change DNS.
2. Create an inbox on that domain, or let Maildock create one from the panel. Inbox creation can affect your Resend bill.
3. Use that inbox address when you sign up or sign in on websites.

Resend currently requires the `full_access` OAuth scope for inbox operations. Use a dedicated Resend account or a dedicated inbox for verification mail.

## Use it

1. Click the Maildock icon, choose **Connect inbox**, and press **Continue with Resend** in the side panel.
2. Select the inbox to watch. You can close the panel and keep browsing.
3. On the website, request a code. Maildock checks every 30 seconds in the background; Chrome may delay checks, especially during sleep. When a new code arrives, the toolbar popup opens if Chrome is focused and Maildock is not already open. Otherwise, the badge remains available. Failed sender checks and sign-in links never trigger the popup.
4. Review the code and sender. On a site without permission, close the popup and click the Maildock toolbar icon on the login page to enable filling. Automatic popup opening does not grant page access. Moving between pages on the same site keeps a toolbar-click grant.
5. Check the site named on the button, then click **Fill code on <site>**. Use **Open Maildock** for the full side panel, sign-in links, and account settings.

More actions:

- **Copy code** puts the code on the clipboard for pages Maildock cannot fill, such as cross-origin frames.
- **Open link on <host>** opens a sign-in link from an email that has no code. Nothing opens until you click.
- **Always allow <site>** appears after a fill. It grants that one site permanently, so the next login there needs no toolbar click. Remove it any time under **Allowed websites**.
- **Disconnect** revokes the Resend grant. Credentials live only for the browser session, so reconnect after a restart.

Supported fields: one identifiable verification input, or one group of single-character inputs. Codes are 4–8 alphanumeric characters with at least one digit. Grouped codes such as `735 918` or `4821-7730` are joined. English verification wording is required today.

## Security model

- **One click per code.** Maildock never fills or submits on its own. The worker rechecks the HTTPS origin, tab, and document at the moment you click.
- **Minimal permissions.** `activeTab`, `scripting`, `sidePanel`, `storage`, `alarms`, `identity`, and a host permission for `https://api.resend.com/*` only. There are no content scripts and no all-sites access at install. Per-site grants are optional and made by you from the panel.
- **Nothing persists that should not.** Tokens and codes live in `chrome.storage.session`. Only preferences and the public OAuth client ID are stored locally. Nothing uses browser sync, telemetry, or remote code.
- **Sender checks.** Each card shows Resend's SPF/DKIM/DMARC result. A sender that fails authentication cannot be filled, copied, or opened.
- **Fresh codes only.** Codes older than three minutes are never offered. A filled or discarded message does not return.
- **Email is data.** HTML is parsed, never rendered or executed. Recovery and payment emails are excluded. Sign-in links must be HTTPS, with no bare IP or punycode host, and only one labelled link per message.

A sender address is not proof of identity, and a compromised browser or device is outside this boundary. Review the card before you fill. No independent security audit has been performed. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Resend API usage

| Endpoint                                    | Purpose                                      |
| ------------------------------------------- | -------------------------------------------- |
| `POST /oauth/register`                      | Register the public OAuth client (once)      |
| `GET /oauth/authorize`, `POST /oauth/token` | Login with PKCE, refresh-token rotation      |
| `POST /oauth/revoke`                        | Disconnect                                   |
| `GET /inboxes`, `POST /inboxes`             | List or create an inbox                      |
| `GET /inboxes/{id}/threads`                 | Find recent threads in the selected inbox    |
| `GET /inboxes/{id}/threads/{thread}/emails` | Read recent messages in a thread             |
| `GET /emails/receiving/{id}`                | Read the SPF/DKIM/DMARC result for a message |

Every response is validated with a schema before the rest of the extension sees it. Polling runs every three seconds while the connected popup or side panel is open. A 30-second background alarm also checks the inbox while both are closed. All checks share the same rate-limit backoff. The badge clears when codes are filled, dismissed, expired, or the connection ends. Resend's documentation: [OAuth](https://resend.com/docs/guides/building-a-resend-oauth-client), [Inboxes](https://resend.com/docs/api-reference/inboxes/list-threads), [Receiving](https://resend.com/docs/dashboard/receiving/introduction).

## Configuration

Optional. Copy `.env.example` to `.env` for a stable distribution build:

| Variable                   | Purpose                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `WXT_RESEND_CLIENT_ID`     | A pre-registered public Resend client with callback `https://<extension-id>.chromiumapp.org/resend` |
| `WXT_EXTENSION_PUBLIC_KEY` | The extension's public manifest key, to keep the development extension ID stable                    |

Both values are public configuration. Never add a client secret, API key, or private signing key.

## Development

```sh
npm run dev           # watch build; reload the extension after worker changes
npm run check         # typecheck, lint, unused code, unit tests, production build, manifest audit
npm run test:browser  # end-to-end tests against the built extension (run `npx playwright install chromium` once)
npm run zip           # .output/maildock-<version>-chrome.zip
```

Browser tests load the production build into a disposable Chrome profile and intercept Resend responses. They do not contact a live account. If the downloaded test browser cannot start, point `MAILDOCK_TEST_BROWSER` at a local Chrome executable.

Project layout:

```
src/core/        state model, schemas, code and link extraction (no browser APIs)
src/background/  service worker: commands, OAuth, Resend client, page filling
src/ui/          toolbar popup and side panel (React)
scripts/         icon rendering and production manifest audit
tests/           unit tests and Playwright browser tests
docs/            architecture, privacy and retention, research notes
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the trust boundaries and [docs/PRIVACY.md](docs/PRIVACY.md) for what is stored and for how long.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the rules every change must keep, and the pull request process. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Scope and roadmap

Resend is the only provider today. Gmail support, automatic submission, cross-frame filling, and credentials that survive a restart are separate changes. Open an issue to discuss one before you start.

## License

[MIT](LICENSE) © Om Pathak. The particle wordmark adapts [React Bits](https://github.com/DavidHDev/react-bits); its notice ships in `public/licenses/react-bits.txt`.
