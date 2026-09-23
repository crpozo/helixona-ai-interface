# Testing

Nothing reaches the clinic untested. Every change goes through four layers, the first three of
them automated and enforced by CI and by the deploy workflow.

| Layer | What it covers | Where | Command |
| --- | --- | --- | --- |
| Typecheck | Every package compiles under strict TypeScript | all packages | `npm run typecheck` |
| Unit and integration | Catalog, router, breaker, quiz grading (core); every API route through Fastify's `inject` with in-memory repos and the fake model (api); components with Testing Library (web); CDK stacks (infra) | `packages/*/test`, `*.test.ts(x)` | `npm test` |
| End-to-end | The built web app served by the real API (dev authentication, in-memory store, fake model that streams a simulated reply), driven in a real Chromium: sign-in, training gate and course, chat with streaming and Stop, model change, attachments, projects, documentation, agreements, administration, phone layout | `packages/e2e/tests` | `npm run build && npm run e2e` |
| Agent QA before a release | Exploratory testing by parallel agents acting as end users, each with a scope (chat and projects; training and documentation; administration, sign-in, phone, accessibility), reporting reproduced defects with steps and screenshots. Defects are fixed and turned into tests before the deploy. | `.claude/skills/release-qa` | see the skill |

`npm run verify` runs the first three layers in order.

## Where it is enforced

- **CI** (`.github/workflows/ci.yml`) runs on every push and pull request: typecheck, tests,
  build, end-to-end tests, CDK synth. The Playwright report and traces are uploaded as an artifact
  when the end-to-end step fails.
- **Deploy** (`.github/workflows/deploy.yml`) has a `verify` job with the same checks; the
  `deploy` job needs it, so a red suite cannot be deployed even with the production approval.

## End-to-end suite

- Config: `packages/e2e/playwright.config.ts`. It starts `packages/api/dist/server.js` on port
  3199 with `AUTH_MODE=dev STORE_MODE=memory LLM_MODE=fake` serving `packages/web/dist`, so build
  first (`npm run build`). Two projects: `desktop` (1400x900) and `mobile` (iPhone 13 emulation,
  `mobile.spec.ts` only).
- Users: each test signs in as a unique dev user (`helpers.ts`, `uniqueUser`), because the store is
  shared by every test in the run. Tests that are not about the training skip it through the API.
- The fake model answers with a fixed Markdown reply that names the model, so tests can check
  which model answered; `FAKE_DELAY_MS` keeps the stream slow enough for the Stop button.
- Every test watches for page errors, console errors, failed requests and 5xx responses
  (`watchErrors`) and fails if any occurred.
- To debug locally: `npm run e2e -- --headed` or `npm run e2e:ui -w @helixona/e2e`; a failed run
  leaves traces in `packages/e2e/test-results` (`npx playwright show-trace <file>`).

## Adding a test

- A bug found by a user or by agent QA gets a failing test first (API test when it is server
  behavior, component test when it is rendering, end-to-end when it is a flow), then the fix.
- Keep selectors on roles, labels and stable class names (`.msg-assistant`, `.training-gate`,
  `.composer-stop`), never on generated text such as conversation titles.
