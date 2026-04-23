# ChatGPT Terminal Login Automation Plan

Draft date: 2026-04-23

Workspace: `/home/skra/projects/ql_homepage/docs_tmp/oracle`

## Goal

Make ChatGPT browser login drivable from the terminal on a remote machine while preserving the existing persistent browser-profile model.

North star:

1. Start from a persistent Oracle browser profile.
2. Open the ChatGPT login flow in that profile.
3. Drive email/username and password entry from the terminal.
4. Pause only for the one-time verification code.
5. Persist the resulting authenticated cookies and local storage back into the same profile.
6. Return a clear machine-readable status so CLI, MCP, and service wrappers know whether the session is usable.

## Constraints

- This must stay browser-backed. No API-key substitution.
- Headless is not the target path; ChatGPT login and Cloudflare are materially less reliable there.
- OTP is expected and should remain an explicit human handoff.
- Credentials are sensitive and must never be written to logs, screenshots, session transcripts, or exception text.
- Login automation should reuse the same persistent profile that Oracle already uses for browser mode.

## Proposed Surface

CLI:

- `oracle browser login`
- `oracle browser login --creds-file <path>`
- `oracle browser login --remote-chrome <host:port>`
- `oracle browser login --otp-stdin`
- `oracle browser login --json`

MCP:

- `chatgpt_begin_login`
- `chatgpt_submit_login_otp`
- `chatgpt_check_login`

Internal states:

- `not_started`
- `navigating`
- `awaiting_identifier`
- `awaiting_password`
- `awaiting_otp`
- `verifying`
- `logged_in`
- `failed`
- `manual_action_required`

## Flow Design

### Phase 1: Session bootstrap

- Resolve the same browser profile directory Oracle already uses.
- Launch or attach to the persistent browser.
- Open exactly one dedicated login tab.
- Validate whether the user is already logged in before attempting any form entry.
- Prefer a safe authenticated check such as `/backend-api/me` or a reliable in-page signed-in signal.

### Phase 2: Identifier and password

- Read credentials from:
  1. explicit `--creds-file`
  2. environment variables
  3. interactive terminal prompt fallback
- Treat the credential file as input only; do not mutate it.
- Enter identifier/email.
- Advance the Auth0/OpenAI login flow.
- Enter password.
- Detect intermediate redirects, captcha/Cloudflare, or alternate auth screens.

### Phase 3: OTP handoff

- Stop on the verification screen with a structured `awaiting_otp` result.
- Print a minimal prompt in CLI mode.
- In MCP mode, return a continuation token bound to the browser target and profile.
- Accept OTP through:
  - terminal prompt
  - `--otp-stdin`
  - MCP continuation call
- Submit OTP and wait for authenticated redirect completion.

### Phase 4: Persistence validation

- After redirect, verify:
  - ChatGPT root loads
  - composer or authenticated shell appears
  - `/backend-api/me` succeeds, if the endpoint remains safe and stable
- Persist a success marker in Oracle profile metadata.
- Close the temporary login tab unless the caller asked to keep it open.

## Required Building Blocks

### 1. Login state probe

Add a read-only probe that answers:

- current URL
- whether the page is inside the auth flow
- whether credentials are requested
- whether OTP is requested
- whether the ChatGPT authenticated shell is visible
- whether login is already complete

### 2. Secret-safe input helpers

- Reuse existing DOM input primitives where possible.
- Add secret-redacted logging wrappers.
- Ensure screenshots and DOM dumps are either suppressed or redacted during secret entry.

### 3. Continuation state

Persist only minimal continuation metadata:

- Chrome host/port
- target id
- profile path
- login phase
- timestamp

Do not persist:

- password
- OTP
- full credential payload

### 4. Auth-flow selectors

Build selector sets with fallbacks for:

- identifier/email field
- password field
- continue/next buttons
- OTP field
- verification submit button
- signed-in shell markers

These selectors should be probed live and versioned in one place.

## Failure Model

Return explicit failure classes:

- `needs_otp`
- `already_logged_in`
- `bad_credentials`
- `cloudflare_or_captcha`
- `login_ui_changed`
- `auth_provider_unavailable`
- `timeout`

Each failure should include:

- current URL
- current phase
- last successful phase
- safe diagnostic message

## Test Strategy

### Unit

- probe normalization
- continuation token serialization
- secret redaction helpers
- selector fallback ordering

### Live manual-assisted

1. Begin login from a clean signed-out profile.
2. Enter credentials from the env file.
3. Pause on OTP.
4. Submit OTP interactively.
5. Verify authenticated ChatGPT shell.
6. Restart the browser bridge and verify the session remains logged in.

### Regression

- detect already-logged-in state without re-running the auth flow
- detect expired session and re-enter login flow
- preserve profile if login fails midway

## Implementation Order

1. Add read-only login-state probe.
2. Add secret-safe field entry helpers.
3. Add CLI `browser login` begin flow.
4. Add OTP pause/continue mechanism.
5. Add post-login verification and tab cleanup.
6. Add MCP begin/continue/check tools.
7. Add live manual-assisted validation against the persistent profile.

## Current Status

- Implemented for the CLI in `src/browser/chatgpt/login.ts` and `bin/oracle-cli.ts`.
- Native OpenAI email/password is the default lane. Google sign-in is only a provider branch when the login UI requires it; it is not used for the supplied credential file.
- Credentials can be read from `OPENAI_EMAIL` and `OPENAI_PWD` in a dotenv-style file. Quoted values are supported.
- Inline OTP is supported with interactive terminal prompting, `--otp`, or `--otp-stdin`.
- `oracle browser submit-otp --code <digits>` remains available as an escape hatch for a saved continuation.
- Bad credentials, rejected OTPs, manual-action states, and already-logged-in states return explicit structured results.
- Login state persists through the configured browser profile. In WSL with Windows Chrome, Oracle maps the profile to a Windows-local path to avoid Chrome profile corruption warnings. On true Linux, the profile should remain Linux-local.
- Live WSL validation completed for email/password/OTP through logged-in state. True Ubuntu validation is delegated in `docs/ubuntu-linux-agent-handoff.md`.

Remaining work:

- MCP login tools are not yet first-class. Add them only if remote agents need login orchestration through MCP rather than CLI.
- True Ubuntu validation must prove Linux Chrome profile persistence and OTP retry behavior.
