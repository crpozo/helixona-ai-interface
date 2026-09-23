---
name: release-qa
description: Run the full test suite and an agent-based exploratory QA pass before deploying the Helixona Assistant, so nothing broken reaches the clinic.
---

# Release QA

Use this before every deploy (and after any change to the web app, the API or the documents).
The goal is that the end user never sees an error: the automated layers catch regressions, the
agents catch what nobody wrote a test for yet.

## 1. Automated layers (must be green)

```bash
npm run typecheck && npm test && npm run build && npm run e2e
```

`npm run e2e` starts the API itself (dev auth, in-memory store, fake model) serving the built web
app and runs `packages/e2e/tests` in Chromium. Read `docs/TESTING.md` for the layout. If a test
fails, fix the product (or the test if the product changed on purpose) before going on.

## 2. Agent QA (exploratory, in parallel)

Start a local instance of the built app and hand it to three agents at once:

```bash
npm run build
cd packages/api && AUTH_MODE=dev STORE_MODE=memory LLM_MODE=fake FAKE_DELAY_MS=80 \
  WEB_DIST=$(pwd)/../web/dist PORT=3016 SESSION_SECRET=<64 hex chars> node dist/server.js
```

Spawn three `general-purpose` agents in the background, each with one scope, a 20-minute budget,
and the same rules: do not modify repository files; write scripts and screenshots under the
scratchpad; use Playwright (`playwright-core` with the pre-installed Chromium, `--proxy-server=direct://`
when a proxy is set); sign in through `/login`'s developer form or `POST /api/auth/dev-login`
(header `x-requested-with: helixona`, body `{username, role}`) with unique usernames; get past
the training gate with "Skip training, I already know this" unless the scope is the training;
collect console errors and failed requests (ignore the 401 from `/api/me` on public pages);
report only reproduced defects, each with severity, exact steps, expected vs. actual and a
screenshot path, plus what was verified working.

Scopes:

1. **Chat and projects**: start screen, sending, streaming, Stop, model change, rename, delete,
   counter and limit, attachments (button, drag-and-drop, unsupported file), projects, shared
   projects (members from the directory, both accounts see the same chats and who wrote what)
   (settings, instructions, knowledge, chats nested in the sidebar, delete), Markdown rendering.
2. **Training and documentation**: gate, course (locks, wrong answers, reset, resume after reload,
   completion), skip attestation, documentation index and the three documents, Word downloads,
   online knowledge check, answer-key visibility, agreements (visitor, staff, administrator
   upload/download/remove), training log statuses and paper completions.
3. **Administration, sign-in, phone, accessibility**: sign-in page states, signed-out deep links,
   sign out, staff opening `/admin`, users table and actions (create, temporary password,
   disable/enable, reset MFA, resend invitation), audit and usage tables, 390x844 layout on every
   screen with `scrollWidth <= innerWidth`, accessible names on buttons and links, labels on
   fields, focus visibility.

The answer key of the knowledge check (Q1 B, Q2 A, Q3 B, Q4 C, Q5-Q12 B; modules: 1→Q1, 2→Q2,
3→Q3-4, 4→Q5-7, 5→Q8-10, 6→Q11, 7→Q12) lets agents complete the course.

## 3. Close the loop

- Reproduce each reported defect yourself before fixing it; agents sometimes misread a screen.
- Every fixed defect gets a regression test in the right layer.
- Re-run step 1, commit, push, then trigger the deploy. The deploy workflow re-runs the automated
  layers before the production approval; do not deploy around a red run.
