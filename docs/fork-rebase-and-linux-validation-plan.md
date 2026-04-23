# Oracle Fork Rebase And Linux Validation Plan

## Goals

- Validate Oracle's browser automation on a true Ubuntu Linux host with Linux Chrome.
- Preserve the WSL/Windows Chrome path as a supported environment, but stop using it as the only proof point.
- Rebase the working branch on current upstream `steipete/oracle`.
- Push the cleaned implementation to `github.com/kmccleary3301/oracle`.

## Linux Validation

The detailed no-context handoff for a separate Ubuntu code agent is in `docs/ubuntu-linux-agent-handoff.md`. Treat this file as the high-level owner plan and the handoff doc as the executable validation script.

### Preconditions

- Ubuntu host has Node, pnpm, git, and Chrome/Chromium installed.
- `google-chrome`, `google-chrome-stable`, `chromium`, or `chromium-browser` is discoverable on `PATH`, or `CHROME_PATH` is set.
- The profile path is Linux-local, for example `~/.oracle/browser-profile`.
- `openai_creds.env` exists locally but is never committed.

### Doctor Gate

- Run `oracle browser doctor --json`.
- Expected on true Ubuntu:
  - `isWsl: false`
  - `chromeKind: "linux"`
  - `requiresWindowsLocalProfile: false`
  - `requiresWslDevtoolsBridge: false`
  - `profileWritable: true`
  - no `problems`

### Login Gate

- Run `oracle browser login --creds-file ./openai_creds.env`.
- Expected:
  - native OpenAI email/password lane
  - inline `OTP code:` prompt if MFA is required
  - final `Status: completed`
  - final `Phase: logged_in`

### Persistence Gate

- Run `oracle browser login --creds-file ./openai_creds.env --json` again.
- Expected:
  - already authenticated without OTP, unless the ChatGPT session expired
  - persistent profile remains Linux-local

### Feature Smoke

- Run a short text turn with a prompt like `Say "yes" and do nothing else.`
- Run attachment probe with known small files.
- Run image/artifact extraction against known completed sessions.
- Run `pnpm run lint` and `pnpm run build`.

## Fork Rebase Workflow

### 1. Preserve Current Work

- Confirm secrets and throwaway artifacts are not staged:
  - `openai_creds.env`
  - `.tmp-*`
  - `tmp/`
- Create a WIP branch:
  - `git switch -c km/browser-control-suite`
- Stage only source, test, and docs changes intended for the fork.
- Commit in coherent slices:
  - browser/tab/session foundations
  - attachments
  - image artifacts
  - sandbox artifacts
  - projects/conversation management
  - terminal login and browser doctor

### 2. Fetch Upstream And Fork

- `git fetch origin`
- `git fetch kmccleary`
- Confirm remotes:
  - `origin` should be `https://github.com/steipete/oracle.git`
  - `kmccleary` should be `https://github.com/kmccleary3301/oracle.git`

### 3. Rebase

- `git rebase origin/main`
- Resolve conflicts by preserving upstream structure and reapplying the browser-control behavior.
- After each major conflict group:
  - `pnpm run lint`
  - targeted vitest suite for touched area
- Final gate:
  - `pnpm run build`

### 4. Push To Fork

- `git push -u kmccleary km/browser-control-suite`
- Open a draft PR from `kmccleary:km/browser-control-suite`.
- Keep the PR description focused on:
  - terminal/browser login
  - persistent MCP/browser profile behavior
  - attachments
  - image generation artifacts
  - sandbox artifacts
  - projects/conversation management
  - tab limits and cleanup

## Current Blockers In This Session

- Resolved after restarting Codex with `--yolo` on 2026-04-23:
  - GitHub DNS and HTTPS work.
  - `git fetch --dry-run` works for both `origin` and `kmccleary`.
  - `/mnt/c` is writable.
  - the Windows-local Oracle profile directory is writable from WSL.
  - workspace `.git` is writable.
- Remaining deliberate blocker: true Ubuntu validation cannot be completed from this WSL/Windows Chrome environment. Delegate that gate to a separate Ubuntu host using `docs/ubuntu-linux-agent-handoff.md`.
