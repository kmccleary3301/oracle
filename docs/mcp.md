# MCP Server

`oracle-mcp` is a minimal MCP stdio server that mirrors the Oracle CLI. It shares session storage with the CLI (`~/.oracle/sessions` or `ORACLE_HOME_DIR`) so you can mix and match: run with the CLI, inspect or re-run via MCP, or vice versa.

## Tools

### `consult`

- Inputs: `prompt` (required), `files?: string[]` (globs), `model?: string` (defaults to CLI), `engine?: "api" | "browser"` (CLI auto-defaults), `slug?: string`.
- Browser-only extras: `browserAttachments?: "auto"|"never"|"always"`, `browserBundleFiles?: boolean`, `browserThinkingTime?: "light"|"standard"|"extended"|"heavy"`, `browserKeepBrowser?: boolean`, `browserModelLabel?: string`.
- Behavior: starts a session, runs it with the chosen engine, returns final output + metadata. Background/foreground follows the CLI (e.g., GPT‑5 Pro detaches by default).
- Logging: emits MCP logs (`info` per line, `debug` for streamed chunks with byte sizes). If browser prerequisites are missing, returns an error payload instead of running.

### `sessions`

- Inputs: `{id?, hours?, limit?, includeAll?, detail?}` mirroring `oracle status` / `oracle session`.
- Behavior: without `id`, returns a bounded list of recent sessions. With `id`/slug, returns a summary row; set `detail: true` to fetch full metadata, log, and stored request body.

### Long-running ChatGPT browser jobs

Use the async tools for ChatGPT Pro, image generation/editing, or any turn that
may outlive the host MCP client's per-call timeout:

- `chatgpt_create_session_async`
- `chatgpt_send_turn_async`
- `chatgpt_generate_images_async`
- `chatgpt_edit_image_async`

Each async tool validates inputs, starts the same browser operation as its
synchronous counterpart, and returns immediately:

```json
{
  "jobId": "4f6d7b4e-...",
  "kind": "chatgpt_generate_images",
  "status": "running",
  "pollTool": "oracle_job_status"
}
```

Poll with:

```json
{ "jobId": "4f6d7b4e-..." }
```

against `oracle_job_status`. When the job is `completed`, its `result` field is
the same structured result the synchronous tool would have returned, including
conversation URLs, text, generated image records, downloaded artifacts, and
sandbox artifact references where applicable. `oracle_jobs` lists recent jobs in
the current MCP server process.

If browser work completed but status appears stale, call `oracle_job_recover`:

```json
{
  "jobId": "job_...",
  "artifactTypes": ["images", "sandbox"],
  "outputDir": "./oracle-recovered"
}
```

Recovery uses the job's recorded conversation URL when possible, can accept an
explicit `conversationUrl`, and falls back to active ChatGPT conversation tabs on
the configured remote Chrome endpoint. It writes the recovered result to the
job store before marking the job completed.

Important constraints:

- When the Oracle daemon is configured through `ORACLE_DAEMON_CONNECTION` or
  `daemon.connectionPath`, async ChatGPT/Image tools submit durable daemon jobs.
  Those jobs survive MCP client restarts and one-shot `mcporter call` polling.
- If no daemon is reachable, async tools fall back to in-memory records owned by
  the running `oracle-mcp` process. That fallback survives long browser/model
  turns in persistent MCP clients, but not an MCP server restart.
- Async daemon jobs request cancellation, release the daemon queue slot, and
  close managed tabs when the browser operation cooperates. For a possibly
  completed long turn, prefer `oracle_job_recover` before cancelling.
- Keep one long ChatGPT browser job active per browser profile unless you have
  explicitly configured separate profiles/remote Chrome instances. This avoids
  tab contention and model/session confusion.
- Browser tab pressure is bounded by the remote Chrome tab manager. The default
  maximum is four ChatGPT/about:blank tabs; CLI escape hatches are
  `oracle tabs list` and `oracle tabs prune`.

Image-generation note:

- ChatGPT image turns can complete with no normal assistant prose; the visible
  assistant turn may contain only generated image artifacts and placeholder text
  such as `ChatGPT said:`. Oracle treats those image-only assistant turns as
  successful completions when generated image file IDs are present.
- After any image generation or edit turn with a conversation URL, Oracle runs
  the same read-only, full-quality extraction path as `oracle image download`.
  This post-turn pass is unconditional because the finished conversation DOM is
  more reliable than the immediate completion snapshot for image-only and
  delayed-render turns.
- `browserThinkingTime` now reports requested/actual selection metadata in
  results. If the ChatGPT UI does not expose the Thinking control, callers can
  choose `thinkingFallback: "allow"` to continue or `"fail"` to reject the run.

## Resources

- `oracle-session://{id}/{metadata|log|request}` — read-only resources that surface stored session artifacts via MCP resource reads.

## Background / detach behavior

- `consult` follows the CLI: heavy models (e.g., GPT‑5 Pro) detach by default; reattach via `oracle session <id>` / `oracle status`.
- Direct ChatGPT browser tools should use the async variants above for long Pro/Image turns so the MCP client call itself does not need to remain open.

## Launching & usage

- Installed from npm:
  - One-off: `npx @steipete/oracle oracle-mcp`
  - Global: `oracle-mcp`
- From the repo (contributors):
  - `pnpm build`
  - `pnpm mcp` (or `oracle-mcp` in the repo root)
- mcporter example (stdio):
  ```json
  {
    "name": "oracle",
    "type": "stdio",
    "command": "npx",
    "args": ["@steipete/oracle", "oracle-mcp"]
  }
  ```
- Project-scoped Claude (.mcp.json) example:
  ```json
  {
    "mcpServers": {
      "oracle": { "type": "stdio", "command": "npx", "args": ["@steipete/oracle", "oracle-mcp"] }
    }
  }
  ```
- Bridge helper snippets:
  - Codex CLI: `oracle bridge codex-config`
  - Claude Code: `oracle bridge claude-config`
- Tools and resources operate on the same session store as `oracle status|session`.
- Defaults (model/engine/etc.) come from your Oracle CLI config; see `docs/configuration.md` or `~/.oracle/config.json`.
