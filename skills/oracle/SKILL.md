---
name: oracle
description: Use the @steipete/oracle CLI to bundle a prompt plus the right files and get a second-model review (API or browser) for debugging, refactors, design checks, or cross-validation.
---

# Oracle (CLI) — best use

Oracle bundles your prompt + selected files into one “one-shot” request so another model can answer with real repo context (API or browser automation). Treat outputs as advisory: verify against the codebase + tests.

## Main use case (browser, current Pro models)

Default workflow here: `--engine browser` with the current ChatGPT Pro browser model in ChatGPT. This is the “human in the loop” path: it can take ~10 minutes to ~1 hour; expect a stored session you can reattach to.

Recommended defaults:

- Engine: browser (`--engine browser`)
- Model: the current ChatGPT Pro browser model, including newer labels such as GPT‑5.5 where available
- Attachments: directories/globs + excludes; avoid secrets.

## Golden path (fast + reliable)

1. Pick a tight file set (fewest files that still contain the truth).
2. Preview what you’re about to send (`--dry-run` + `--files-report` when needed).
3. Run in browser mode for the usual ChatGPT Pro browser workflow; use API only when you explicitly want it.
4. If the run detaches/timeouts: reattach to the stored session (don’t re-run).

## Commands (preferred)

- Show help (once/session):
  - `npx -y @steipete/oracle --help`

- Preview (no tokens):
  - `npx -y @steipete/oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `npx -y @steipete/oracle --dry-run full -p "<task>" --file "src/**"`

- Token/cost sanity:
  - `npx -y @steipete/oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- Browser run (main path; long-running is normal):
  - `npx -y @steipete/oracle --engine browser --model gpt-5.5 -p "<task>" --file "src/**"`

- Manual paste fallback (assemble bundle, copy to clipboard):
  - `npx -y @steipete/oracle --render --copy -p "<task>" --file "src/**"`
  - Note: `--copy` is a hidden alias for `--copy-markdown`.

## Attaching files (`--file`)

`--file` accepts files, directories, and globs. You can pass it multiple times; entries can be comma-separated.

- Include:
  - `--file "src/**"` (directory glob)
  - `--file src/index.ts` (literal file)
  - `--file docs --file README.md` (literal directory + file)

- Exclude (prefix with `!`):
  - `--file "src/**" --file "!src/**/*.test.ts" --file "!**/*.snap"`

- Defaults (important behavior from the implementation):
  - Default-ignored dirs: `node_modules`, `dist`, `coverage`, `.git`, `.turbo`, `.next`, `build`, `tmp` (skipped unless you explicitly pass them as literal dirs/files).
  - Honors `.gitignore` when expanding globs.
  - Does not follow symlinks (glob expansion uses `followSymbolicLinks: false`).
  - Dotfiles are filtered unless you explicitly opt in with a pattern that includes a dot-segment (e.g. `--file ".github/**"`).
  - Default cap: files > 1 MB are rejected unless you raise `ORACLE_MAX_FILE_SIZE_BYTES` or `maxFileSizeBytes` in `~/.oracle/config.json`.

## Budget + observability

- Target: keep total input under ~196k tokens.
- Use `--files-report` (and/or `--dry-run json`) to spot the token hogs before spending.
- If you need hidden/advanced knobs: `npx -y @steipete/oracle --help --verbose`.

## Engines (API vs browser)

- Auto-pick: uses `api` when `OPENAI_API_KEY` is set, otherwise `browser`.
- Browser engine supports GPT browser models, including current Pro labels such as GPT‑5.5, plus Gemini; use `--engine api` for Claude/Grok/Codex or multi-model runs.
- **API runs require explicit user consent** before starting because they incur usage costs.
- Browser attachments:
  - `--browser-attachments auto|never|always` (auto pastes inline up to ~60k chars then uploads).
  - Oracle preserves multiline request bodies; write the prompt exactly as you want it sent, including blank lines and bullets.
- Remote browser host (signed-in machine runs automation):
  - Host: `oracle serve --host 0.0.0.0 --port 9473 --token <secret>`
  - Client: `oracle --engine browser --remote-host <host:port> --remote-token <secret> -p "<task>" --file "src/**"`

## Sessions + slugs (don’t lose work)

- Stored under `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).
- Runs may detach or take a long time (browser Pro sessions often do). If the CLI times out: don’t re-run; reattach.
  - List: `oracle status --hours 72`
  - Attach: `oracle session <id> --render`
- Use `--slug "<3-5 words>"` to keep session IDs readable.
- Duplicate prompt guard exists; use `--force` only when you truly want a fresh run.

## Durable ChatGPT Jobs

This machine runs the durable Oracle daemon via the user service
`oracle-daemon.service`. Codex MCP is configured with
`ORACLE_DAEMON_CONNECTION=/home/kmccleary/.oracle/daemon/connection.json`, so
async ChatGPT/Image MCP jobs should persist in `~/.oracle/jobs` instead of
living only inside one MCP server process.

Useful CLI checks:

- Daemon: `oracle daemon status --json`
- Jobs: `oracle job list --json`
- Start durable ChatGPT session: `oracle job start chatgpt_create_session --prompt "<task>" --file "src/**" --browser-model-label "5.5" --browser-thinking-time heavy --return-after-submit --json`
- Poll: `oracle job status <jobId> --json`
- Events: `oracle job tail <jobId>`
- Result: `oracle job result <jobId> --json`
- Recover stale artifacts before cancelling: `oracle job recover <jobId> --artifact-types images,sandbox --output-dir ./oracle-recovered --json`
- When you need the conversation URL immediately after submit, add `--return-after-submit`.
- Use `--browser-model-label` when the ChatGPT UI exposes a Pro label you want to pin exactly.
- Do not pass `--thinking-fallback` or `--return-after-submit` to `oracle chat turn`; those flags belong to durable `oracle job start ...` paths. For existing-conversation follow-ups, check `oracle chat turn --help` and use supported flags such as `--turn-message`, `--file`, `--browser-model-label`, `--timeout`, `--include-snapshot`, and `--json`.

For Pro/browser runs, prefer durable jobs when the request may outlive a single
agent turn, when attachments are large, or when the conversation URL needs to be
preserved immediately after submit.

## Prompt template (high signal)

Oracle starts with **zero** project knowledge. Assume the model cannot infer your stack, build tooling, conventions, or “obvious” paths. Include:

- Project briefing (stack + build/test commands + platform constraints).
- “Where things live” (key directories, entrypoints, config files, dependency boundaries).
- Exact question + what you tried + the error text (verbatim).
- Constraints (“don’t change X”, “must keep public API”, “perf budget”, etc).
- Desired output (“return patch plan + tests”, “list risky assumptions”, “give 3 options with tradeoffs”).

### “Exhaustive prompt” pattern (for later restoration)

When you know this will be a long investigation, write a prompt that can stand alone later:

- Top: 6–30 sentence project briefing + current goal.
- Middle: concrete repro steps + exact errors + what you already tried.
- Bottom: attach _all_ context files needed so a fresh model can fully understand (entrypoints, configs, key modules, docs).

If you need to reproduce the same context later, re-run with the same prompt + `--file …` set (Oracle runs are one-shot; the model doesn’t remember prior runs).

## Safety

- Don’t attach secrets by default (`.env`, key files, auth tokens). Redact aggressively; share only what’s required.
- Prefer “just enough context”: fewer files + better prompt beats whole-repo dumps.
