# Maildock

Chrome MV3 extension. TypeScript, React, WXT. No application backend.

## Start here

- `src/core/model.ts` owns persisted state and validated boundary schemas.
- `src/background/controller.ts` owns commands, polling, and verification lifecycle.
- `src/background/auth.ts` owns OAuth and token rotation. Credentials never reach UI state.
- `src/background/resend.ts` owns provider requests and pagination.
- `src/core/matching.ts` owns code extraction and candidate selection without browser dependencies.
- `src/background/page.ts` owns isolated-world inspection and filling.
- `src/ui/App.tsx` owns the side panel. No provider calls from React.
- `src/ui/Popup.tsx` owns the compact toolbar popup and explicit code actions.
- `src/ui/ParticleWordmark.tsx` owns the bounded monochrome logo animation. It stops rendering at rest.
- `src/ui/tokens.css` owns the monochrome palette. Keep visual assets local.
- `docs/ARCHITECTURE.md` explains the trust boundaries and decisions.

## Invariants

- Only this extension's exact side panel and popup URLs may send privileged commands. Never expose a content-script fetch proxy.
- Keep credentials, bodies, codes, and tokenized URLs out of logs, telemetry, browser sync, and persistent storage.
- Never silently fill or submit. Recheck the target origin and document before releasing a code.
- External JSON is untrusted until parsed. Pure domain functions accept validated types.
- Use explicit imports, descriptive names, and discriminated state. No speculative layers or generic repository patterns.
- Comments only explain a non-obvious constraint. Prefer encoding it in a type or runtime check.
- Do not add tests for getters or framework boilerplate. Test a security boundary or observable failure mode.
- `docs/RESEARCH.md` is background evidence, not required reading for routine edits.

## Commands

`npm ci`, `npm run dev`, `npm run check`, `npm run test:browser`, `npm run zip`.

`check` runs strict types, Biome, Knip unused-code analysis, focused domain tests, and a production manifest/bundle audit.
Browser tests exercise the built extension with intercepted Resend responses. They do not establish live provider compatibility.

## Scope

Resend first. Gmail, automatic submission, cross-frame filling, persistent credentials, and a webhook relay are separate changes. Sign-in links open only from an explicit click in the panel. Never claim live account verification or a security audit unless performed.
