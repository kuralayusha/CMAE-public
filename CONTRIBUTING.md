# Contributing to CMAE

Thanks for your interest! Issues and pull requests are welcome.

## Getting started

Follow the setup in [README.md](README.md) (`npm install`, copy `.env.example`
to `.env`, `npm run dev` or `npm run desktop:dev`).

## Before opening a pull request

- Keep changes focused; describe the problem and the approach in the PR.
- Run `npm run lint`, `npx tsc --noEmit` and the test scripts
  (`npm run test:ai-usage`, `npm run test:tracker-state`, `npm run test:i18n-guard`).
  Tests must use explicit temp dirs/DB handles and never call `getAppRoot()`.
- Schema changes are hand-written migrations in `lib/db/migrations/` registered
  in `migrations/index.ts`.
- Every model call must go through `promptWithUsage` (`lib/ai-usage/call.ts`).
- Add user-visible strings to `locales/en.json` and use `t()` / the i18n hooks.
- Before changing sync, derive or draft logic, read the relevant section of
  [docs/tracker-sync-architecture.md](docs/tracker-sync-architecture.md).
- Never commit secrets or `.env` files.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
