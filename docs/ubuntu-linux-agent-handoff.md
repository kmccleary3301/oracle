# Ubuntu Linux Agent Handoff

Date: 2026-04-23

This handoff is intended for a separate code agent running on a true Ubuntu Linux host. It assumes the WSL/Windows Chrome path has already been implemented and live-smoked, and that the remaining work is to validate the same browser-control stack on Linux Chrome, then prepare the branch for the user's fork.

## Mission

Validate and harden the Oracle ChatGPT browser-control implementation on true Ubuntu Linux with a Linux-local Chrome profile. Do not use API keys for ChatGPT browser tests. The intended production path is browser-authenticated ChatGPT Pro access through the user's persistent browser profile.

## Repository

- Upstream: `https://github.com/steipete/oracle.git`
- User fork: `https://github.com/kmccleary3301/oracle.git`
- Working branch recommendation: `km/browser-control-suite`
- Current WSL scratch path: `/home/skra/projects/ql_homepage/docs_tmp/oracle`

## Non-Negotiables

- Do not commit `openai_creds.env`, cookies, browser profiles, downloaded live artifacts, screenshots containing private content, or `.tmp-*` files.
- Do not run slow Pro or image-generation requests unless the command explicitly uses the short smoke prompt or the user approves the run.
- Use the fast text prompt for live text tests: `Say 'yes' to this question. Do nothing else.`
- Image-generation and image-edit tests can take up to 10 minutes or more. Use long timeouts and do not classify them as failed until the configured timeout expires.
- Keep headless disabled for ChatGPT browser mode unless testing a known negative path. The supported path is persistent headful Chrome, potentially hidden/offscreen by the environment.

## Implemented Surfaces To Validate

CLI:

- `oracle browser doctor`
- `oracle browser login`
- `oracle browser submit-otp`
- `oracle browser status`
- `oracle browser probe-attachments`
- `oracle chat create`
- `oracle chat get`
- `oracle chat turn`
- `oracle chat artifacts`
- `oracle chat delete-plan`
- `oracle chat delete`
- `oracle chat move`
- `oracle image download`
- `oracle image generate`
- `oracle image edit`
- `oracle project list`
- `oracle project get`
- `oracle project create`
- `oracle project rename`

MCP:

- `chatgpt_browser_status`
- `chatgpt_create_session`
- `chatgpt_get_conversation`
- `chatgpt_send_turn`
- `chatgpt_extract_images`
- `chatgpt_generate_images`
- `chatgpt_edit_image`
- `chatgpt_extract_sandbox_artifacts`
- `chatgpt_list_projects`
- `chatgpt_get_project`
- `chatgpt_create_project`
- `chatgpt_rename_project`
- `chatgpt_plan_delete_conversation`
- `chatgpt_delete_conversation`
- `chatgpt_move_conversation_to_project`

## Ubuntu Preconditions

- Ubuntu 22.04 or newer.
- Node >= 22.
- pnpm matching `packageManager` from `package.json` or Corepack enabled.
- Git with GitHub access to upstream and the user's fork.
- Linux Chrome or Chromium installed and discoverable as one of:
  - `google-chrome`
  - `google-chrome-stable`
  - `chromium`
  - `chromium-browser`
- A visible desktop/session for login, or an equivalent display server that can show Chrome.
- A Linux-local persistent profile path, for example `~/.oracle/browser-profile`.

## First Commands

```bash
git remote -v
git fetch origin
git fetch kmccleary
pnpm install
pnpm run lint
pnpm run build
```

If starting from a patch bundle rather than this exact working tree, apply the patch first, then run the same commands.

## Linux Environment Configuration

Prefer Linux-local Chrome and profile paths:

```bash
export CHROME_PATH="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser)"
export ORACLE_BROWSER_MANUAL_LOGIN=1
export ORACLE_BROWSER_PROFILE_DIR="$HOME/.oracle/browser-profile"
```

Do not use `/mnt/c` paths on true Ubuntu. The WSL Windows-profile mapping is only for WSL plus Windows Chrome.

## Gate 1: Browser Doctor

Build first, then run:

```bash
node ./dist/bin/oracle-cli.js browser doctor --json
```

Expected:

- `isWsl: false`
- `chromeKind: "linux"`
- `requiresWindowsLocalProfile: false`
- `requiresWslDevtoolsBridge: false`
- `profileWritable: true`
- no `problems`

Warnings are acceptable only if they are actionable and documented in the final handoff.

## Gate 2: Terminal Login

Put credentials in a local untracked file:

```bash
cat > ./openai_creds.env <<'EOF'
OPENAI_EMAIL="..."
OPENAI_PWD="..."
EOF
```

Run:

```bash
node ./dist/bin/oracle-cli.js browser login --creds-file ./openai_creds.env --timeout 3m
```

Expected:

- Native OpenAI email/password lane is used, not Google.
- The command reaches `awaiting_otp` when MFA is required.
- The terminal prompts for `OTP code:`.
- Correct OTP completes with `Status: completed` and `Phase: logged_in`.
- Incorrect OTP returns a clear rejection/awaiting-OTP state and allows retry without restarting the whole login.
- Bad credentials return a clear failure state without logging secrets.

Persistence check:

```bash
node ./dist/bin/oracle-cli.js browser login --creds-file ./openai_creds.env --json --timeout 60s
```

Expected: already authenticated without re-entering credentials or OTP, unless ChatGPT has expired the session.

## Gate 3: Fast Text Session

```bash
node ./dist/bin/oracle-cli.js chat create \
  --turn-message "Say 'yes' to this question. Do nothing else." \
  --browser-model-strategy select \
  --browser-model-label Instant \
  --timeout 90s \
  --include-snapshot \
  --json
```

Expected:

- `answerText` is `yes` or equivalent minimal text.
- Result includes `conversationUrl`, `conversationId`, and a snapshot.
- Re-running `chat get <conversationUrl> --json` opens the same conversation and reports the same latest answer.

## Gate 4: Attachments

Create small local fixtures under `/tmp/oracle-attachment-smoke` and run:

```bash
node ./dist/bin/oracle-cli.js browser probe-attachments \
  --file '/tmp/oracle-attachment-smoke/*' \
  --timeout 5m \
  --json
```

Expected:

- Upload completes without sending.
- Composer is cleared before exit.
- No generated image artifacts are reported from uploaded reference images.

Then run a real low-cost text attachment turn with the fast prompt and require the model to echo a token from the file.

## Gate 5: Existing Artifact Extraction

Images sample:

```bash
node ./dist/bin/oracle-cli.js image download \
  'https://chatgpt.com/c/69e9073a-9660-83ea-b480-751914edbc95' \
  --no-download \
  --json
```

Expected: 7 unique generated images from the completed sample conversation.

Sandbox-artifact sample:

```bash
node ./dist/bin/oracle-cli.js chat artifacts \
  'https://chatgpt.com/g/g-p-69a9f36e9c488191a9fbaf2c920c6c4e/c/69e7da3a-8218-83ea-a974-5c2b2d54146a' \
  --output-dir /tmp/oracle-sandbox-artifacts \
  --json
```

Expected: 3 logical artifacts: frontend codebase zip, README, and implementation manifest.

## Gate 6: Image Generation And Edit

Only run this after the fast gates pass. Use the shortest acceptable prompt and long timeout:

```bash
node ./dist/bin/oracle-cli.js image generate \
  --turn-message "Create one simple square icon with the word OK. Do nothing else." \
  --browser-model-strategy current \
  --browser-thinking-time light \
  --timeout 30m \
  --output-dir /tmp/oracle-image-generate \
  --json
```

Expected:

- At least one generated image artifact is detected.
- Downloads include MIME, dimensions, byte size, and SHA-256 sidecar metadata.

For edit, attach the generated image and ask for a trivial change. Allow up to 30 minutes.

## Gate 7: Projects And Destructive Safety

Use a throwaway project/conversation only.

Required checks:

- `project list` returns existing projects.
- `project create` creates a temporary project and verifies the project page opened.
- `chat move` requires exact conversation confirmation and verifies the target project.
- `project rename` requires exact current-name confirmation.
- `chat delete-plan` reports the exact target without deleting.
- `chat delete` refuses missing/wrong confirmation.
- `chat delete` deletes only a throwaway conversation when the exact id is supplied.

Do not delete user conversations or real projects.

## Gate 8: MCP

After build:

```bash
npx -y mcporter list oracle-local --schema --config config/mcporter.json
```

Then call at least:

- `chatgpt_browser_status`
- `chatgpt_create_session` with the fast text prompt
- `chatgpt_extract_images` against the sample image conversation
- `chatgpt_extract_sandbox_artifacts` against the Pro artifact sample

## Failure Artifacts

For any failure, capture:

- exact command
- stdout/stderr with secrets redacted
- current URL
- browser doctor JSON
- whether Chrome remained running
- tab count before/after
- screenshot only if it contains no private data, otherwise a redacted DOM/action summary

## Branch And Fork Preparation

Before committing:

```bash
git status --short
git diff --check
pnpm run lint
pnpm run build
```

Never stage:

- `openai_creds.env`
- `.tmp-*`
- `tmp/`
- browser profile directories
- downloaded live artifacts

Recommended commit slices:

1. Browser/login/doctor/tab lifecycle.
2. Attachments and attachment probes.
3. Image generation/editing artifacts.
4. Sandbox artifact downloads.
5. Projects/conversation management/destructive safety.
6. CLI/MCP schemas and docs.

Then:

```bash
git switch -c km/browser-control-suite
git rebase origin/main
pnpm run lint
pnpm run build
git push -u kmccleary km/browser-control-suite
```

Open a draft PR against the fork or upstream as directed by the user.

## Final Report Format

Report:

- commit SHA and branch
- Ubuntu version
- Chrome binary/version
- Node/pnpm versions
- browser doctor summary
- passed gates
- failed gates with exact blocker
- live conversation/project URLs created for throwaway tests
- cleanup performed
- remaining risk
