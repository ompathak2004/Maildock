# Data and retention

This describes the current Maildock source implementation. It is not a substitute for the publisher identity and contact details required for a store listing.

## Where data goes

Maildock has no application backend, analytics endpoint, advertising integration, or error-reporting service. The extension contacts Resend directly for OAuth and inbox operations. Login uses Resend's authorization page. Resend continues to store and process mail under its own policies.

The chosen website receives only the code you explicitly approve for filling. Maildock does not transmit your tokens, mailbox list, or full message bodies to websites. Opening the external Resend link navigates to Resend normally.

## Browser storage

| Data                                                                                       | Location                                           | Retention                                                                                                   |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Public OAuth client ID, selected inbox ID, up to 100 origin/sender/code-length preferences | Extension local storage                            | Until extension data is cleared or it is uninstalled                                                        |
| Access and refresh tokens                                                                  | Trusted extension session storage                  | Until successful disconnect, invalid authorization, browser restart, extension reload/disable, or uninstall |
| Inbox list and selected attempt metadata                                                   | Trusted extension session storage                  | During the browser session; inbox list cleared on successful disconnect                                     |
| Candidate code and selected subject/sender                                                 | Trusted extension session storage and panel memory | Active attempt only; discarded on completion, cancellation, expiry processing, or disconnection             |
| Full message bodies                                                                        | Worker memory while fetching and matching          | Not deliberately persisted or logged                                                                        |

Session storage is not an encrypted password vault. Credentials remain accessible to trusted code in this extension. The design does not protect against a compromised device, browser, or extension update. Browser/OS memory handling is outside Maildock's control.

Expired attempts are cleared when the worker next processes the expiry alarm or another command; a suspended browser can delay cleanup. The worker never authorizes an expired fill. Removing a code from extension state does not remove the provider's email or a code already entered into a website.

No data is placed in Chrome sync, the clipboard, telemetry, or application console logs. Local preferences reveal the sites and senders you configured; they remain after disconnect so you can reconnect. Uninstalling the extension removes its local preferences.

## Disconnect and revocation

Disconnect stops the current attempt and asks Resend to revoke the refresh token, then clears local session credentials. If the network request fails, Maildock reports the failure and keeps the session credential so revocation can be retried. Revoke the grant in Resend if you cannot reconnect.

Closing the browser or uninstalling clears local credentials but cannot guarantee a network revocation. Existing grants may remain at Resend until revoked or expired. Manage them in your Resend account.

## Permissions

- `identity`: Resend OAuth through Chrome's authorization flow.
- `storage`: Local preferences and session credentials.
- `activeTab` and `scripting`: Inspect and fill the tab explicitly granted by a toolbar click.
- `sidePanel`: Keep the verification workflow beside the website.
- `alarms`: Expire abandoned attempts.
- Host permission for `https://api.resend.com/*`: Direct provider requests.

There are no permanent content scripts, all-site host grants, general browsing-history permission, remote scripts, or attachment downloads. The service worker validates the exact destination document before filling.

## Development artifacts

Automated tests use fake credentials and intercepted provider responses. Screenshots and traces are ignored by Git. Do not run tracing against a real inbox or include real messages, codes, keys, or OAuth responses in bug reports. CI has no Resend account credentials.
