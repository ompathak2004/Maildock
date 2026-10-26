# Maildock

A Chrome extension that brings a fresh email verification code from your Resend inbox to the login page you choose. Built with **TypeScript, React, and WXT**, using Manifest V3. There is no Maildock backend.

The implementation is ready for local evaluation. Automated checks use a real browser and simulated Resend responses. Live Resend OAuth, DNS delivery, and account behavior still need verification before release; this is not an independently audited product.

## Run locally

Requires Node.js 24 or newer and Chrome 120 or newer.

```sh
npm ci
npm run check
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `.output/chrome-mv3`. Pin Maildock to the toolbar. `npm run dev` starts WXT's development build; use the production build for account testing.

No API key or client secret is required. The extension registers a public OAuth client for its own callback on first connection. Login and consent happen on Resend. Resend currently requires `full_access` for inbox operations; use a dedicated account for evaluation.

For a stable distribution, register a public Resend client with the exact callback `https://<extension-id>.chromiumapp.org/resend`. Copy `.env.example` to `.env` and set `WXT_RESEND_CLIENT_ID`. Optionally set `WXT_EXTENSION_PUBLIC_KEY` to the extension's public manifest key to keep the development ID stable. These values are public configuration. Never add a client secret, API key, or private signing key.

## Use it

1. Configure receiving for a domain you control in Resend. If another provider handles your domain's mail, use a dedicated receiving subdomain. Copy DNS values from your account; Maildock does not change DNS.
2. Connect Resend in Maildock. Select an existing inbox or explicitly create one. Inbox creation can affect your Resend bill. Create it before requesting a code.
3. Use that inbox's exact address on the website. For example, `work@ompathak.dev` and `work@ompathakd.dev` are different addresses on different domains.
4. Open the Maildock panel and request a code on the website. Maildock watches the selected inbox while the panel is open. Any verification code that arrived in the last three minutes appears in the panel; there is nothing to start, and no sender or code length to type.
5. When the website shows its code field, click the Maildock toolbar button once. That gesture allows Maildock to fill that tab. Navigating between pages on the same site keeps the permission; a new site needs one more click. After a fill, **Always allow <site>** grants that one site permanently so the next login there needs no toolbar click; remove it any time under _Allowed websites_. **Copy code** works everywhere, including pages Maildock cannot fill.
   Emails that sign you in with a link instead of a code show the link's host and an **Open link** button; nothing opens until you press it.
6. Check the sender, subject, and the website named on the button, then choose **Fill … on <site>**. Filling is your confirmation. After the first fill, Maildock remembers the sender for that website and tells you when a later code comes from a different address. Maildock does not click Submit. A website may submit automatically in response to input.
7. **Disconnect** revokes the current Resend grant. Reconnect after a browser restart because credentials are stored only for the browser session.

Supported fields: one identifiable verification input, or one group of single-character inputs. Ambiguous, occupied, hidden, password, cross-frame, and non-HTTPS targets are rejected. Codes contain 4–8 alphanumeric characters with at least one digit; letter case is preserved. English verification wording is currently required. A labelled code (“code: 123456”, “123456 is your code”) wins over a bare number; two equally likely codes fail closed.

## Security model

- The service worker owns OAuth, token rotation, provider access, and the inbox watch. The panel receives selected message metadata and candidate codes, never credentials or full email bodies.
- Tokens and fresh codes use trusted `chrome.storage.session`. Only preferences and the public OAuth client ID persist locally. Nothing uses browser sync.
- Page access uses a toolbar gesture and `activeTab`, or a per-site grant the user makes from the panel. There are no content scripts and no all-site host permission at install time.
- Every card shows Resend's sender authentication result (SPF/DKIM/DMARC, computed by Resend's receiving server). A sender that fails authentication cannot be filled, copied, or opened. A sender whose domain matches the current website is listed first and marked.
- Sign-in links are offered only when the message has no code, the subject reads like a sign-in request, and exactly one HTTPS link is labelled as that action. Bare-IP and punycode hosts are refused.
- Only codes received in the last three minutes are offered, and a filled or discarded message never returns. Each fill binds the exact HTTPS origin, tab, and document shown on the button at the moment of the click; the worker rechecks all three before injecting.
- Only the bundled panel document can issue validated commands. There is no webpage mailbox bridge or generic fetch command.
- Email HTML is parsed as data. It is never rendered, executed, or fetched. There is no telemetry, remote code, or LLM processing.

Sender addresses do not authenticate a sender. Resend's Inbox response does not expose the authentication evidence needed for unattended processing. Review remains mandatory. A compromised browser, extension update, or user device is outside this protection boundary.

See [architecture](docs/ARCHITECTURE.md), [privacy and retention](docs/PRIVACY.md), and [API research, Gmail options, and comparable products](RESEARCH.md).

## Gmail

Direct Gmail access is not implemented. A consumer `@gmail.com` address cannot be provisioned as a Resend inbox on your verified domain. Gmail forwarding is a separate setup and may change the recipient fields Maildock matches, so it is not claimed as supported here. A future Gmail provider should use Google's own OAuth and API.

## Development and verification

```sh
npm run check
npx playwright install chromium
npm run test:browser
npm run zip
```

`check` runs strict TypeScript, Biome, Knip unused-code analysis, six focused security tests, a production build, and permission/CSP checks. Browser tests exercise connection, token refresh, fresh-message matching, fill, navigation rejection, credential cleanup, and revocation against intercepted provider responses. They load the production artifact into a disposable profile, using Chrome's extension debugging protocol. Screenshots go to `artifacts/`; failure traces stay in ignored `test-results/`.

If the downloaded test browser cannot start, set `MAILDOCK_TEST_BROWSER` to a recent Chrome executable. Tests still create a separate temporary profile. On Windows:

```powershell
$env:MAILDOCK_TEST_BROWSER = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm run test:browser
```

`npm run zip` writes `.output/maildock-0.1.0-chrome.zip`. CI runs the checks and simulated browser flows without account secrets. `AGENTS.md` is the short entry point for coding agents; routine changes do not require reading the research report.

## Live verification before release

Use a dedicated Resend account and test inbox. Verify the registered Chromium callback is accepted, a real fresh code arrives, refresh works after access-token expiry, and Disconnect removes access. Check actual provider payloads, quota behavior, DNS routing, browser restart, and offline revocation. Keep credentials out of chat, fixtures, screenshots, and traces. Complete independent security review and store privacy disclosures before public distribution.
