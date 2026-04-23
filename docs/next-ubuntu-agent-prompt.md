# Prompt For Next Ubuntu Code Agent

You are a code agent taking over Oracle browser-control work on a true Ubuntu Linux system. You have no prior chat context. Everything you need is in the repository branch and the docs named below.

## Critical Context

The user wants Oracle to be a robust CLI/API/MCP control layer for ChatGPT browser automation using their browser-based ChatGPT Pro subscription, not OpenAI API keys. The main use cases are:

- persistent browser-authenticated ChatGPT sessions
- fresh/resumed turn-based conversations
- reliable file/image/zip attachments from local paths
- ChatGPT image generation and image editing through the web app
- full-quality image artifact downloads
- automatic sandbox artifact downloads from assistant response buttons
- ChatGPT project creation/list/get/rename/move organization
- guarded destructive deletion
- efficient browser tab cleanup with a default max of 4 live tabs
- terminal-driven login with email/password and interactive OTP

The WSL/Windows Chrome path has already been implemented and live-smoked. Your job is to validate and harden the same implementation on true Ubuntu Linux with Linux Chrome, then prepare/push/finalize the branch on the user's GitHub fork.

## GitHub Access

You are authenticated to the user's GitHub via `git`/`gh`. The user's fork may be private. Use it directly.

Repositories:

- Upstream: `https://github.com/steipete/oracle.git`
- User fork: `https://github.com/kmccleary3301/oracle.git`
- Working branch: `km/browser-control-suite`

Start by cloning or fetching the user's fork and checking out the branch:

```bash
git clone https://github.com/kmccleary3301/oracle.git oracle
cd oracle
git remote add upstream https://github.com/steipete/oracle.git 2>/dev/null || true
git fetch origin
git fetch upstream
git switch km/browser-control-suite
```

If the branch is not present on the fork, fetch from the handoff remote/patch location supplied by the user and recreate `km/browser-control-suite` from that patch. Do not start from scratch.

## Read These Files First

Read these in order:

1. `docs/ubuntu-linux-agent-handoff.md`
2. `docs/fork-rebase-and-linux-validation-plan.md`
3. `docs/chatgpt-browser-control-north-star-plan.md`, especially slices 10-14 near the end
4. `docs/chatgpt-terminal-login-automation-plan.md`

Treat `docs/ubuntu-linux-agent-handoff.md` as the executable checklist.

## Non-Negotiables

- Do not commit credentials, cookies, browser profiles, downloaded live artifacts, screenshots containing private content, `.tmp-*`, or `tmp/`.
- Do not use OpenAI API keys for ChatGPT browser tests.
- Do not run expensive/slow Pro or image-generation requests unless the command is explicitly a short smoke or the user approves.
- For fast text live tests, use exactly: `Say 'yes' to this question. Do nothing else.`
- Image generation/editing can take 10+ minutes. Use long timeouts and do not prematurely kill valid long-running turns.
- Keep ChatGPT browser mode headful. Do not try to make headless the primary path.
- Use a Linux-local Chrome profile on Ubuntu, such as `~/.oracle/browser-profile`. Do not use `/mnt/c`.

## Initial Setup

Verify runtime:

```bash
node --version
pnpm --version || corepack enable
command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser
```

Install and build:

```bash
pnpm install
pnpm run lint
pnpm run build
```

Configure Linux browser path/profile:

```bash
export CHROME_PATH="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser)"
export ORACLE_BROWSER_MANUAL_LOGIN=1
export ORACLE_BROWSER_PROFILE_DIR="$HOME/.oracle/browser-profile"
```

Run doctor:

```bash
node ./dist/bin/oracle-cli.js browser doctor --json
```

Expected on true Ubuntu:

- `isWsl: false`
- `chromeKind: "linux"`
- `requiresWindowsLocalProfile: false`
- `requiresWslDevtoolsBridge: false`
- `profileWritable: true`
- no `problems`

## Login Validation

Create an untracked credentials file locally. The user may supply credentials separately. Never commit it.

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

- Native OpenAI email/password lane, not Google.
- Interactive `OTP code:` prompt when MFA is required.
- Correct OTP reaches `Status: completed` and `Phase: logged_in`.
- Bad OTP keeps a recoverable awaiting/rejected OTP state.
- Bad credentials produce a clear failure without leaking secrets.

Persistence check:

```bash
node ./dist/bin/oracle-cli.js browser login --creds-file ./openai_creds.env --json --timeout 60s
```

Expected: already authenticated without OTP unless ChatGPT expired the browser session.

## Required Ubuntu Gates

Follow the exact gates in `docs/ubuntu-linux-agent-handoff.md`:

1. Browser doctor.
2. Terminal login and profile persistence.
3. Fast text session create/get.
4. Attachment no-send probe and one small real attachment turn.
5. Existing image and sandbox artifact extraction.
6. Image generation and edit smoke, only after cheaper gates pass.
7. Project/list/create/move/rename/delete safety checks using throwaway resources only.
8. MCP schema/list and representative MCP tool calls.

For MCP schema:

```bash
npx -y mcporter list oracle-local --schema --config config/mcporter.json
```

Representative MCP calls should include:

- `chatgpt_browser_status`
- `chatgpt_create_session`
- `chatgpt_extract_images`
- `chatgpt_extract_sandbox_artifacts`

## Expected Tooling Surface

CLI commands that should exist:

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

MCP tools that should exist:

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

## Branch Hygiene

Before every commit:

```bash
git status --short
git diff --check
pnpm run lint
pnpm run build
```

Make sure these remain untracked/ignored:

- `openai_creds.env`
- `.tmp-*`
- `tmp/`
- browser profile directories
- downloaded live artifacts

The branch currently may contain a large WIP commit from the WSL agent. You may split it into coherent commits if needed, but do not lose behavior.

Suggested final commit grouping:

1. Browser/login/doctor/tab lifecycle.
2. Attachments and attachment probes.
3. Image generation/editing artifacts.
4. Sandbox artifact downloads.
5. Projects/conversation management/destructive safety.
6. CLI/MCP schemas and docs.

## Rebase And Push

After Ubuntu gates are green:

```bash
git fetch upstream
git rebase upstream/main
pnpm run lint
pnpm run build
git push --force-with-lease origin km/browser-control-suite
```

If the branch is not yet on the fork:

```bash
git push -u origin km/browser-control-suite
```

Use `gh` to open or update a draft PR if the user asks.

## Final Report To User

Report:

- branch name and commit SHA
- Ubuntu version
- Chrome binary and version
- Node and pnpm versions
- browser doctor summary
- each gate pass/fail
- live throwaway URLs created
- cleanup performed
- remaining risks or unstable selectors
- whether the branch was rebased and pushed

Keep the report concise and specific. Do not include credentials or private screenshot content.
