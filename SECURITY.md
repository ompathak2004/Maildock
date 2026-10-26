# Security policy

Maildock handles OAuth tokens and one-time codes. Security reports get priority over every other kind of issue.

## Report a vulnerability

Do not open a public issue for a security problem.

Use one of these private channels:

- [Open a private security advisory](https://github.com/ompathak2004/Maildock/security/advisories/new) on GitHub (preferred).
- Email `om2004.pathak@gmail.com` with `Maildock security` in the subject.

Include:

- A description of the problem and its impact.
- Steps to reproduce, or a proof of concept.
- The commit or version you tested.
- Whether the problem needs a malicious website, a malicious email, a malicious Resend response, or local access.

Do not include real codes, tokens, inbox contents, or account identifiers in the report. Use a test inbox.

## What happens next

- You receive an acknowledgement within 3 working days.
- You receive a first assessment within 10 working days.
- A confirmed problem is fixed on `main` and released as a new version. The advisory is published after the fix, with credit to the reporter unless you prefer to stay anonymous.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Scope

In scope:

- A website obtaining a code, token, or inbox data without the user's explicit click.
- An email causing a fill, a copy, or a link to open without the user's explicit click.
- Credentials, codes, or message bodies reaching logs, `chrome.storage.local`, browser sync, or a third party.
- Bypassing the sender-authentication block, the three-minute freshness window, or the tab/origin/document recheck.
- A manifest permission or build change that widens the extension's access.

Out of scope:

- A compromised device, browser, or browser profile.
- Resend's own services and the mail delivery path. Report those to Resend.
- The OAuth `full_access` scope that Resend currently requires for inbox operations. This is documented in the README and is a provider limitation.
- Websites that submit a form automatically after input. Maildock never clicks Submit; the website decides what to do with a filled field.

## Design notes

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the trust boundaries. [docs/PRIVACY.md](docs/PRIVACY.md) lists every piece of data the extension stores and for how long. No independent security audit has been performed. Do not describe Maildock as audited.
