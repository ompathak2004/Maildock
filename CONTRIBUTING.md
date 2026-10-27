# Contributing to Maildock

Thanks for taking the time to contribute. This guide covers how to set up the project, what a good change looks like, and how to get it merged.

## Ways to contribute

- Report a bug or request a feature with an [issue](https://github.com/ompathak2004/Maildock/issues/new/choose).
- Improve documentation.
- Fix a bug or add a feature with a pull request.
- Report a security problem privately. See [SECURITY.md](SECURITY.md). Do not open a public issue for it.

## Before you start

- Check [open issues](https://github.com/ompathak2004/Maildock/issues) and [pull requests](https://github.com/ompathak2004/Maildock/pulls) so work is not duplicated.
- For a large change (new mail provider, new permission, new storage, new UI flow), open an issue first and describe the design. A short discussion saves a rewrite later.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). It explains the trust boundaries that every change must keep.

## Set up the project

Requirements: Node.js 24 or newer, npm, and Chrome 127 or newer.

```sh
git clone https://github.com/<your-username>/Maildock.git
cd Maildock
npm ci
npm run check
```

Load the extension once:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select `.output/chrome-mv3`.

`npm run dev` rebuilds on every save. Click the reload icon on the extension card after a change to the service worker.

## Make a change

1. Create a branch from `main`:

   ```sh
   git checkout -b fix/short-description
   ```

2. Make the change. Keep it focused: one bug fix or one feature per pull request.

3. Add or update tests when the change touches a security boundary or an observable failure mode. Do not add tests for getters or framework boilerplate.

4. Update the docs that describe the behavior you changed: `README.md`, `docs/ARCHITECTURE.md`, or `docs/PRIVACY.md`.

5. Run the full check before you push:

   ```sh
   npm run format
   npm run check
   npm run test:browser
   ```

   `check` runs strict TypeScript, Biome lint and format, Knip unused-code analysis, the unit tests, a production build, and a manifest audit. `test:browser` loads the built extension into a disposable Chrome profile and runs the end-to-end tests with intercepted Resend responses. Run `npx playwright install chromium` once before the first browser test run.

## Rules every change must follow

These rules protect users. A pull request that breaks one will not be merged.

- **Never fill or submit silently.** The user clicks one labelled button per code. The worker rechecks the tab, origin, and document before it injects.
- **Credentials, message bodies, codes, and tokenized links never reach logs, telemetry, browser sync, or `chrome.storage.local`.** Tokens and fresh codes live only in session storage.
- **Only the exact bundled popup and side panel URLs may send privileged commands.** No content-script fetch proxy, no `externally_connectable`, no webpage bridge.
- **No new permissions without a design discussion.** The build audit (`scripts/check-build.mjs`) fails when the manifest permissions change.
- **External JSON is untrusted until parsed.** Validate every provider response with a zod schema before the domain code sees it.
- **Keep the code direct.** Explicit imports, descriptive names, discriminated unions for state. No speculative abstraction layers. A comment explains a non-obvious constraint; prefer encoding the constraint in a type or runtime check.

## Commit messages

- Write the subject in the imperative: `Fix stale code after inbox switch`, not `Fixed` or `Fixes`.
- Keep the subject under 72 characters. Add a body when the reason for the change is not obvious from the diff.
- Reference an issue when one exists: `Closes #12`.

## Open a pull request

1. Push the branch to your fork and open a pull request against `main`.
2. Fill in the pull request template. Say what changed, why, and how you tested it.
3. Make sure the **Verify** workflow is green. It runs the same checks as `npm run check`, the browser tests, `npm audit`, and a production zip.
4. Respond to review comments with new commits. Do not force-push over a reviewed commit unless a maintainer asks for a rebase.
5. A maintainer squashes or merges the pull request once it is approved.

## Scope

Maildock supports Resend inboxes today. The following are welcome as separate, discussed changes, not as part of an unrelated pull request:

- Another mail provider (for example Gmail through Google's own OAuth and API).
- Automatic submission after a fill.
- Filling inside cross-origin frames.
- Credentials that survive a browser restart.

## Licence

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
