# Daemon-Backed Async Jobs Plan

## North Star

Oracle should make long ChatGPT browser work feel boring for coding agents.
An agent should be able to start a Pro or Images turn, receive a durable job id
within seconds, poll or attach later, recover after MCP/client restarts, and
always get a clear final result with logs, conversation URL, generated image
artifacts, sandbox artifacts, and actionable failure state.

The agent should not need to know whether it is talking through Codex MCP,
Claude Code MCP, mcporter, the CLI, or a remote browser bridge. Long work should
be owned by one durable Oracle daemon, not by the short-lived process that
submitted the request.

## Design Principles

- **One owner for browser work.** A single local or remote daemon owns the
  browser profile, tab budget, job queue, locks, and job state.
- **Submit returns fast.** Any operation that can exceed a normal MCP timeout
  returns a job handle immediately.
- **Polling is stable.** `oracle_job_status` must work across MCP process
  restarts and one-shot `mcporter call` invocations.
- **Attach is first-class.** Agents need `status`, `tail`, `events`, and final
  result reads, not just a blind polling loop.
- **Results are complete.** Text, conversation metadata, generated images,
  sandbox artifacts, warnings, failure diagnostics, and downloaded paths all
  belong in the job record.
- **Failure is inspectable.** A failed job should still preserve the browser
  URL, phase, logs, screenshots/DOM summaries when available, and whether user
  action is required.
- **Browser resources are bounded.** The daemon enforces concurrency, queue
  order, per-profile locks, max tabs, idle tab cleanup, and cancellation.
- **No agent-specific ceremony.** Codex, Claude Code, Cursor, OpenCode, Amp,
  Droid, and shell users should all use the same small conceptual model:
  submit, poll/attach, collect.

## Current State

Oracle already has these useful pieces:

- `oracle serve` exposes a browser automation HTTP service.
- `src/remote/server.ts` owns remote browser execution and serializes `/runs`.
- `src/remote/client.ts` is already a drop-in browser executor client.
- MCP exposes async tools through `src/mcp/jobs.ts`, but jobs are in-memory and
  owned by the current `oracle-mcp` process.
- CLI/browser mode already persists normal session records under Oracle's
  session store.
- Image generation/editing now performs unconditional post-turn image extraction
  from the completed conversation URL.
- Sandbox artifact extraction is implemented for assistant-emitted artifact
  buttons.

The key gap: current MCP async jobs are not durable. They solve long calls for a
persistent MCP server, but not for one-shot MCP launchers or client restarts.

## Target UX

### MCP

Agents should prefer async tools for long ChatGPT browser work:

```json
{
  "tool": "chatgpt_generate_images_async",
  "arguments": {
    "prompt": "Create four homepage design directions...",
    "files": ["/abs/ref.png"],
    "outputDir": "/abs/out",
    "browserThinkingTime": "heavy"
  }
}
```

Immediate response:

```json
{
  "jobId": "job_20260424_abc123",
  "status": "queued",
  "kind": "chatgpt_generate_images",
  "pollTool": "oracle_job_status",
  "attachTool": "oracle_job_events",
  "resultTool": "oracle_job_result",
  "estimatedQueuePosition": 0
}
```

Polling:

```json
{
  "tool": "oracle_job_status",
  "arguments": { "jobId": "job_20260424_abc123" }
}
```

Completion:

```json
{
  "found": true,
  "job": {
    "id": "job_20260424_abc123",
    "status": "completed",
    "phase": "completed",
    "conversationUrl": "https://chatgpt.com/c/...",
    "resultReady": true,
    "resultSummary": {
      "answerChars": 18,
      "imageArtifacts": 4,
      "sandboxArtifacts": 0,
      "warnings": 0
    }
  }
}
```

The full result should be fetched separately when it may be large:

```json
{
  "tool": "oracle_job_result",
  "arguments": { "jobId": "job_20260424_abc123" }
}
```

### CLI

The same flow should be available from the terminal:

```bash
oracle job start image-generate \
  --turn-message "Say yes with a tiny blue icon" \
  --browser-thinking-time heavy \
  --output-dir ./out \
  --json
```

Then:

```bash
oracle job status job_20260424_abc123 --json
oracle job tail job_20260424_abc123
oracle job result job_20260424_abc123 --json
oracle job cancel job_20260424_abc123
oracle jobs --active
```

Existing direct commands can remain, but should print a clear hint when a long
timeout is likely:

```text
This operation may exceed client timeouts. For agents, prefer:
oracle job start image-generate ...
```

## Architecture

### Process Model

Add an Oracle job daemon mode:

```bash
oracle daemon start
oracle daemon status
oracle daemon stop
oracle daemon logs
```

Implementation options:

1. Extend `oracle serve` into the daemon.
2. Add a new `oracle daemon` command that wraps the same HTTP server plus job
   persistence.

Preferred: extend `oracle serve` internally, but expose `oracle daemon` as the
agent-friendly name. `serve` remains valid for compatibility; `daemon` makes the
operational intent clearer.

The daemon should bind to localhost by default:

- Unix/Linux: `127.0.0.1:<configured-or-random-port>`
- WSL bridge: existing host/bridge model remains supported
- Remote: explicit host/token required

The daemon writes a connection artifact:

```json
{
  "version": 1,
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 9473,
  "token": "...",
  "startedAt": "2026-04-24T...",
  "profileDir": "/home/user/.oracle/browser-profile"
}
```

Default path:

```text
~/.oracle/daemon/connection.json
```

### Storage Layout

Durable job records should live outside the repo:

```text
~/.oracle/jobs/
  index.json
  job_20260424_abc123/
    job.json
    input.json
    events.ndjson
    result.json
    error.txt
    artifacts/
    debug/
      screenshot.png
      page-summary.json
      dom-snippet.html
```

`job.json` should be small and frequently updated atomically.
`result.json` may be large and should only appear after successful completion or
partial failure with recoverable artifacts.

### Job State Machine

Use explicit states:

- `queued`
- `starting`
- `running`
- `waiting_for_model`
- `extracting_artifacts`
- `completed`
- `failed`
- `cancel_requested`
- `cancelled`
- `requires_action`

Use explicit phases:

- `accepted`
- `queued`
- `launching_browser`
- `checking_login`
- `selecting_model`
- `setting_thinking_time`
- `uploading_attachments`
- `submitting_prompt`
- `waiting_for_response`
- `extracting_images`
- `extracting_sandbox_artifacts`
- `closing_tabs`
- `completed`
- `failed`

`requires_action` should include a typed reason:

- `login_required`
- `otp_required`
- `cloudflare_required`
- `plan_limit`
- `modal_blocker`
- `manual_confirmation_required`

### Job Schema

Minimum durable record:

```ts
interface OracleJobRecord {
  id: string;
  kind: OracleJobKind;
  status: OracleJobStatus;
  phase: OracleJobPhase;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  queuePosition?: number;
  progress?: {
    label: string;
    percent?: number;
    heartbeatAt?: string;
  };
  inputSummary: {
    promptChars?: number;
    attachmentCount?: number;
    outputDir?: string;
    modelLabel?: string;
    thinkingTime?: string;
    projectUrl?: string;
  };
  runtime?: {
    daemonPid: number;
    browserProfileDir?: string;
    remoteChrome?: string;
    tabId?: string;
    conversationUrl?: string;
    conversationId?: string;
  };
  resultSummary?: {
    answerChars?: number;
    imageArtifacts?: number;
    sandboxArtifacts?: number;
    warnings?: number;
  };
  resultPath?: string;
  eventLogPath: string;
  error?: {
    message: string;
    stack?: string;
    code?: string;
    retryable?: boolean;
    requiresAction?: string;
  };
  debugArtifacts?: string[];
}
```

Kinds:

- `chatgpt_create_session`
- `chatgpt_send_turn`
- `chatgpt_generate_images`
- `chatgpt_edit_image`
- `chatgpt_extract_images`
- `chatgpt_extract_sandbox_artifacts`
- future: project operations if they become long or flaky

### HTTP API

Add daemon endpoints:

- `GET /health`
- `GET /daemon/status`
- `POST /jobs`
- `GET /jobs`
- `GET /jobs/:id`
- `GET /jobs/:id/events?after=<offset>`
- `GET /jobs/:id/result`
- `POST /jobs/:id/cancel`
- `DELETE /jobs/:id`

Keep `/runs` for compatibility. Internally, `/runs` can either remain
streaming/synchronous or become a thin wrapper around job creation plus attach.

The long-term cleanest shape:

- `/runs`: legacy streaming endpoint
- `/jobs`: durable endpoint
- MCP async tools always use `/jobs` when a daemon is configured or auto-started

### MCP Integration

MCP should be daemon-aware:

1. On async tool call, resolve a daemon client.
2. If daemon is running, submit the job there.
3. If no daemon is running:
   - If `autoStartDaemon` is enabled, start it.
   - Otherwise fall back to current in-process jobs and include a warning.
4. `oracle_job_status`, `oracle_jobs`, `oracle_job_events`, and
   `oracle_job_result` should query the daemon first.
5. If the daemon is unavailable, fall back to local in-memory jobs so current
   persistent MCP behavior still works.

New MCP tools:

- `oracle_daemon_status`
- `oracle_job_status`
- `oracle_jobs`
- `oracle_job_events`
- `oracle_job_result`
- `oracle_job_cancel`

Existing async tools keep their current names:

- `chatgpt_create_session_async`
- `chatgpt_send_turn_async`
- `chatgpt_generate_images_async`
- `chatgpt_edit_image_async`

This avoids forcing agents to learn a new per-operation vocabulary.

### CLI Integration

Add:

```bash
oracle daemon start [--background] [--port 9473] [--token auto]
oracle daemon status [--json]
oracle daemon stop
oracle daemon logs [-f]
oracle job start <kind> [kind-specific args]
oracle job status <job-id> [--json]
oracle job events <job-id> [--after <offset>] [--json]
oracle job tail <job-id>
oracle job result <job-id> [--json]
oracle job cancel <job-id>
oracle jobs [--active] [--limit 20] [--json]
```

Also add convenience aliases:

```bash
oracle image generate --async ...
oracle image edit --async ...
oracle chat new --async ...
oracle chat turn --async ...
```

### Agent Defaults

For MCP contexts, default to daemon-backed async jobs automatically when either
condition is true:

- the requested timeout exceeds 120 seconds
- the tool is a known long-running ChatGPT browser operation

The tool response should be short and agent-friendly:

```text
Started Oracle job job_... Poll oracle_job_status, or use oracle_job_events for logs.
```

Avoid requiring agents to keep a streaming call open.

## Browser Resource Management

The daemon should be the tab governor.

Defaults:

- `maxConcurrentJobs`: `1` per browser profile
- `maxOpenChatgptTabs`: `4`
- `closeJobTabOnCompletion`: `true`
- `keepFailedTabForDebug`: `false` by default, `true` only with debug flag
- `idleTabTtlMs`: 5 minutes
- `profileLockTimeoutMs`: existing config default

Queueing should be explicit. If one Pro job is running and another starts, the
second job should become `queued`, not fail with `busy`.

Cancellation should:

1. Mark job `cancel_requested`.
2. Try to stop generation in the active tab.
3. Close the job tab if safe.
4. Mark `cancelled`.
5. Preserve partial logs and conversation URL.

## Result Handling

Every completed browser job should attempt post-turn extraction where relevant:

- generated images
- sandbox artifacts
- conversation snapshot
- final assistant markdown/text
- warnings

For image jobs:

- Always run read-only full-quality image extraction from the conversation URL.
- Download all image artifacts unless `download: false`.
- Return image records even when download fails.
- Save metadata sidecars with SHA-256, dimensions, mime type, source URL, and
  variant index.

For text/pro jobs:

- Always inspect assistant response for sandbox artifact buttons.
- Download sandbox artifacts by default when an output dir is configured.
- Return labels and refs even if downloads fail.

## Configuration

Add config:

```ts
{
  daemon: {
    enabled: true,
    autoStart: true,
    host: "127.0.0.1",
    port: 9473,
    connectionPath: "~/.oracle/daemon/connection.json",
    jobDir: "~/.oracle/jobs",
    maxConcurrentJobs: 1,
    maxOpenChatgptTabs: 4,
    jobRetentionDays: 14,
    completedRetentionDays: 7,
    failedRetentionDays: 30,
    defaultPollIntervalMs: 5000
  }
}
```

Environment overrides:

- `ORACLE_DAEMON_ENABLED`
- `ORACLE_DAEMON_AUTOSTART`
- `ORACLE_DAEMON_HOST`
- `ORACLE_DAEMON_PORT`
- `ORACLE_DAEMON_TOKEN`
- `ORACLE_DAEMON_CONNECTION`
- `ORACLE_JOBS_DIR`

## Autostart

Support three layers:

1. Manual:
   ```bash
   oracle daemon start --background
   ```
2. Agent auto-start:
   MCP async tools start the daemon if configured and absent.
3. System startup:
   Generate service snippets:
   ```bash
   oracle daemon install-systemd --user
   oracle daemon install-wsl
   ```

For WSL, prefer the same practical pattern already used for the browser bridge:

- Start daemon on WSL login.
- Use the persistent profile path already validated by `oracle browser doctor`.
- Write logs under `~/.oracle/daemon/logs`.

## Security

- Bind to localhost by default.
- Require bearer token for all non-public daemon endpoints.
- Store connection artifact with `0600` permissions.
- Never persist credential files into job records.
- Redact secrets in logs and job input summaries.
- Store full prompts only when existing Oracle session policy already allows it.
- Attachments copied into job input directories should obey retention cleanup.

## Weighted Execution Plan

Progress is measured out of **100 points**. A checkbox should only be marked
complete when its acceptance check is satisfied. If an item is partially
implemented but not verified, leave it unchecked and describe the partial state
in current status notes.

### Progress Ledger

| Area                                |  Weight | Status      |
| ----------------------------------- | ------: | ----------- |
| Product/API shape                   |       8 | 8/8         |
| Durable job store                   |      14 | 14/14       |
| Daemon HTTP service and queue       |      16 | 16/16       |
| Browser job adapters                |      14 | 14/14       |
| MCP integration                     |      14 | 14/14       |
| CLI integration                     |      10 | 10/10       |
| Browser lifecycle hardening         |       8 | 8/8         |
| Reliability, recovery, and security |       6 | 6/6         |
| Tests and live validation           |       6 | 6/6         |
| Documentation and agent recipes     |       4 | 4/4         |
| **Total**                           | **100** | **100/100** |

Current verified progress notes:

- Durable jobs are backed by `src/jobs/types.ts` and `src/jobs/store.ts`.
- `src/daemon/server.ts` exposes authenticated daemon `/jobs` endpoints with queueing, event reads, result reads, cancellation, connection artifacts, stop, and restart reconciliation.
- `src/daemon/chatgptHandlers.ts` supports image generation/editing, text session create/turn, image extraction, and sandbox artifact extraction.
- MCP async tools submit daemon jobs when a daemon connection is configured or autostart succeeds, and job status/list/events/result/cancel read from the daemon with in-memory fallback.
- CLI supports `oracle daemon start/status/stop`, `oracle job start/status/events/tail/result/cancel/list`, and `oracle jobs`.
- Live text daemon smoke completed with answer `yes` and conversation URL `https://chatgpt.com/c/69ebc503-8740-83ea-8c4f-376bbc1a27bb`.
- Live image daemon smoke completed through the Images project, downloaded one full-quality 1254x1254 PNG plus JSON sidecar, and preserved the artifact at `tmp/live-image-daemon-smoke-1777059262`.
- One-shot `mcporter` polling was verified against a daemon-backed job: separate calls to `oracle_job_status` and `oracle_job_result` returned the durable completed result.
- Verified with focused store/daemon/MCP tests, MCP schema tests, CLI daemon/job smoke, live text/image smokes, `pnpm run lint`, `pnpm run build`, and `git diff --check`.

### 1. Product/API Shape — 8 Points

Strategy: lock the external surface before deep implementation so agents get one
coherent model across MCP, CLI, and daemon HTTP. Avoid exposing internal queue
details unless they help the caller make a decision.

- [x] **1 point** Define canonical job vocabulary.
  - Include `queued`, `running`, `waiting_for_model`, `extracting_artifacts`,
    `completed`, `failed`, `cancel_requested`, `cancelled`, and
    `requires_action`.
  - Acceptance: status values are represented in one exported type and reused
    by daemon, MCP, CLI, and tests.
- [x] **1 point** Define canonical phase vocabulary.
  - Include browser-specific phases like `checking_login`, `selecting_model`,
    `uploading_attachments`, `waiting_for_response`, `extracting_images`, and
    `closing_tabs`.
  - Acceptance: phases are documented and typed; unknown phases cannot appear
    in normal code paths.
- [x] **1 point** Define canonical job kinds.
  - Include `chatgpt_create_session`, `chatgpt_send_turn`,
    `chatgpt_generate_images`, `chatgpt_edit_image`,
    `chatgpt_extract_images`, and `chatgpt_extract_sandbox_artifacts`.
  - Acceptance: kind strings are exported constants or a strict union, not
    repeated ad hoc literals.
- [x] **1 point** Define compact status response shape.
  - Include job id, status, phase, queue position, result readiness,
    conversation URL, result summary, and action-required reason.
  - Acceptance: status response stays compact and does not inline large result
    payloads by default.
- [x] **1 point** Define full result response shape.
  - Include text/markdown, images, downloaded artifacts, sandbox artifacts,
    warnings, logs path, and debug artifact references.
  - Acceptance: large payloads are available through `oracle_job_result` and
    `GET /jobs/:id/result`.
- [x] **1 point** Define event shape.
  - Include monotonic sequence number, timestamp, level, phase, message, and
    optional structured data.
  - Acceptance: events can be tailed incrementally with an offset.
- [x] **1 point** Define cancellation semantics.
  - Include best-effort UI stop, tab close, partial result preservation, and
    final `cancelled` state.
  - Acceptance: cancellation is documented as best-effort and tested with a fake
    long-running handler.
- [x] **1 point** Define action-required semantics.
  - Include `login_required`, `otp_required`, `cloudflare_required`,
    `plan_limit`, `modal_blocker`, and `manual_confirmation_required`.
  - Acceptance: callers receive actionable reason and recommended next command.

### 2. Durable Job Store — 14 Points

Strategy: build this as a small, deterministic storage layer with atomic writes
and simple files. Do not depend on a database unless file-based state proves
insufficient.

- [x] **1 point** Add `src/jobs/types.ts`.
  - Acceptance: all durable job, result, event, and error types live here.
- [x] **2 points** Add `src/jobs/store.ts` with configurable root directory.
  - Acceptance: tests can point it at a temp dir without touching
    `~/.oracle/jobs`.
- [x] **2 points** Implement atomic JSON writes.
  - Write to temp file, `fsync` where practical, then rename.
  - Acceptance: interrupted write test never leaves a malformed final
    `job.json`.
- [x] **1 point** Implement sortable job id generation.
  - Format should be stable and human-readable, e.g.
    `job_20260424T..._<short>`.
  - Acceptance: lexical sort matches creation order for normal use.
- [x] **1 point** Implement `createJob`.
  - Persist `job.json`, `input.json`, and empty `events.ndjson`.
  - Acceptance: job directory is complete immediately after creation.
- [x] **1 point** Implement `updateJob`.
  - Merge updates safely and refresh `updatedAt`.
  - Acceptance: sequential updates preserve prior fields.
- [x] **1 point** Implement `appendEvent`.
  - Append newline-delimited JSON with sequence numbers.
  - Acceptance: event sequence is monotonic and survives process recreation.
- [x] **1 point** Implement `readJob` and `listJobs`.
  - Acceptance: missing/corrupt jobs are reported clearly and do not crash list.
- [x] **1 point** Implement `writeResult` and `readResult`.
  - Acceptance: result path is linked from `job.json` only after the result file
    is durable.
- [x] **1 point** Implement retention/pruning.
  - Respect separate completed, failed, and all-job retention windows.
  - Acceptance: pruning never deletes active jobs.
- [x] **1 point** Implement startup reconciliation helpers.
  - Active jobs left by a dead daemon become `failed` or `requires_action` with
    `daemon_restarted`.
  - Acceptance: restart test marks stale `running` jobs deterministically.
- [x] **1 point** Add store unit tests.
  - Acceptance: tests cover create, update, event tail, result read, corruption,
    and reconciliation.

### 3. Daemon HTTP Service and Queue — 16 Points

Strategy: extend the existing remote service model instead of building a
parallel server stack. Keep `/runs` compatible, add `/jobs`, and make the daemon
the single queue owner.

- [x] **1 point** Decide file placement.
  - Preferred: `src/daemon/server.ts` for job-specific service code, reusing
    helpers from `src/remote/server.ts`.
  - Acceptance: architecture note in code or docs explains the boundary.
- [x] **1 point** Add daemon config resolution.
  - Read config/env for host, port, token, connection path, job dir, queue
    limits, tab limits, and retention.
  - Acceptance: config has tests for defaults and env overrides.
- [x] **1 point** Write daemon connection artifact.
  - Include pid, host, port, token, startedAt, profile dir, and version.
  - Acceptance: artifact is mode `0600` on Unix-like systems.
- [x] **1 point** Implement authenticated `GET /daemon/status`.
  - Acceptance: reports version, uptime, pid, active job count, queued job
    count, job dir, and profile dir.
- [x] **2 points** Implement `POST /jobs`.
  - Validate job kind and payload.
  - Create durable job record.
  - Return immediately with job id and queue metadata.
  - Acceptance: fake long job submission returns in under 1 second.
- [x] **1 point** Implement `GET /jobs`.
  - Support active-only, status filter, kind filter, and limit.
  - Acceptance: listing does not read large result payloads.
- [x] **1 point** Implement `GET /jobs/:id`.
  - Acceptance: returns compact status and clear 404 for missing id.
- [x] **1 point** Implement `GET /jobs/:id/events`.
  - Support `after` sequence offset.
  - Acceptance: clients can tail without receiving duplicate events.
- [x] **1 point** Implement `GET /jobs/:id/result`.
  - Acceptance: returns 202 or structured not-ready response until result
    exists.
- [x] **1 point** Implement `POST /jobs/:id/cancel`.
  - Acceptance: queued jobs cancel immediately; running jobs enter
    `cancel_requested`.
- [x] **1 point** Implement queue scheduler.
  - Enforce `maxConcurrentJobs`, default `1`.
  - Acceptance: second submitted job becomes `queued`, not `busy`.
- [x] **1 point** Implement queue persistence transitions.
  - Acceptance: every state transition is visible in `job.json` and events.
- [x] **1 point** Preserve `/runs` compatibility.
  - Acceptance: existing remote client tests still pass.
- [x] **1 point** Add daemon integration tests with fake handlers.
  - Acceptance: independent client calls can submit, poll, tail, cancel, and
    read result.
- [x] **1 point** Add daemon restart test.
  - Acceptance: completed jobs survive; interrupted running jobs are marked with
    a clear restart error.

### 4. Browser Job Adapters — 14 Points

Strategy: adapt existing browser functions into job handlers without duplicating
browser automation logic. The handler layer should own phases, events,
cancellation, result persistence, and final artifact extraction.

- [x] **1 point** Define `OracleJobHandler` interface.
  - Include `kind`, input parser, `run(context, input)`, and optional
    cancellation hook.
  - Acceptance: fake handler tests use the same interface as browser handlers.
- [x] **1 point** Define `OracleJobContext`.
  - Include job id, store, logger/event writer, abort signal, config, artifact
    dir, and phase updater.
  - Acceptance: handlers do not write job files directly except through context.
- [x] **2 points** Implement `chatgpt_generate_images` handler.
  - Reuse current generation flow.
  - Always run post-turn image extraction when conversation URL exists.
  - Acceptance: result matches direct MCP/CLI output shape.
- [x] **2 points** Implement `chatgpt_edit_image` handler.
  - Preserve input attachment metadata.
  - Run same post-turn extraction.
  - Acceptance: reference-image edit produces downloaded artifacts and metadata.
- [x] **2 points** Implement `chatgpt_create_session` and
      `chatgpt_send_turn` handlers.
  - Include text/markdown, conversation URL, snapshots, sandbox artifacts.
  - Acceptance: fast “Say yes” prompt returns completed text through daemon.
- [x] **1 point** Implement `chatgpt_extract_images` handler.
  - Acceptance: read-only extraction against an existing conversation works
    through jobs.
- [x] **1 point** Implement `chatgpt_extract_sandbox_artifacts` handler.
  - Acceptance: sample Pro artifact conversation downloads expected artifacts.
- [x] **1 point** Add phase updates at every major browser step.
  - Acceptance: event log shows enough progress for an agent to know what is
    happening.
- [x] **1 point** Persist conversation URL as soon as known.
  - Acceptance: failed/running job status includes URL when available.
- [x] **1 point** Persist partial diagnostics on failure.
  - Include error, phase, URL, optional screenshot/DOM summary where available.
  - Acceptance: failure tests produce inspectable debug references.
- [x] **1 point** Add handler tests with mocked browser functions.
  - Acceptance: tests cover success, warning, extraction failure, and thrown
    browser error.

### 5. MCP Integration — 14 Points

Strategy: make MCP tools feel unchanged except more reliable. Existing async
tool names remain the entry points; daemon-backed durability is an implementation
detail surfaced only through richer job tools.

- [x] **1 point** Add daemon client module for MCP.
  - Acceptance: client can read connection artifact and call daemon endpoints.
- [x] **1 point** Resolve daemon connection in priority order.
  - Env override, config path, default connection artifact, optional autostart.
  - Acceptance: tests cover all paths and missing-daemon behavior.
- [x] **2 points** Implement daemon autostart for async tools.
  - Start only when enabled and safe.
  - Acceptance: autostart writes connection artifact and returns usable client.
- [x] **1 point** Update `chatgpt_generate_images_async`.
  - Acceptance: returns daemon job id when daemon is available.
- [x] **1 point** Update `chatgpt_edit_image_async`.
  - Acceptance: returns daemon job id when daemon is available.
- [x] **1 point** Update `chatgpt_create_session_async`.
  - Acceptance: text Pro/browser work can use daemon jobs.
- [x] **1 point** Update `chatgpt_send_turn_async`.
  - Acceptance: turn-based work can use daemon jobs.
- [x] **1 point** Update `oracle_job_status`.
  - Query daemon first; fall back to in-memory local jobs.
  - Acceptance: separate MCP process can read daemon job status.
- [x] **1 point** Add `oracle_job_result`.
  - Acceptance: full result is fetched separately from status.
- [x] **1 point** Add `oracle_job_events`.
  - Acceptance: supports incremental event reads.
- [x] **1 point** Add `oracle_job_cancel`.
  - Acceptance: queued fake job cancels through MCP.
- [x] **1 point** Preserve in-memory fallback.
  - Acceptance: no-daemon persistent MCP server still works and warns about
    non-durability.
- [x] **1 point** Add MCP schema and mcporter tests.
  - Acceptance: `mcporter call` submit and a separate `mcporter call` status
    works with daemon-backed jobs.

### 6. CLI Integration — 10 Points

Strategy: give humans and shell scripts the same durable model as MCP. CLI
commands should be obvious, composable, and useful in CI-like handoffs.

- [x] **1 point** Add `oracle daemon start`.
  - Support foreground/background, port, token, job dir, and JSON output.
  - Acceptance: background start returns connection details.
- [x] **1 point** Add `oracle daemon status`.
  - Acceptance: reports healthy/unhealthy with JSON mode.
- [x] **1 point** Add `oracle daemon stop` and `oracle daemon logs`.
  - Acceptance: stop is token-authenticated and logs can be tailed.
- [x] **1 point** Add `oracle job start <kind>`.
  - Acceptance: supports at least image generate and text session create.
- [x] **1 point** Add `oracle job status <job-id>`.
  - Acceptance: compact human output and full JSON output.
- [x] **1 point** Add `oracle job events` and `oracle job tail`.
  - Acceptance: tail follows new events without duplication.
- [x] **1 point** Add `oracle job result`.
  - Acceptance: prints or writes full result JSON.
- [x] **1 point** Add `oracle job cancel`.
  - Acceptance: returns clear state transition.
- [x] **1 point** Add `--async` convenience flags to long direct commands.
  - Acceptance: `oracle image generate --async ...` delegates to job start.
- [x] **1 point** Add shell-friendly exit codes.
  - Acceptance: documented and covered by tests for not found, running, failed,
    and requires-action.

### 7. Browser Lifecycle Hardening — 8 Points

Strategy: centralize browser resource governance in the daemon so agents do not
leave memory-heavy ChatGPT tabs behind.

- [x] **1 point** Track per-job browser target id and tab URL.
  - Acceptance: status shows active target metadata when available.
- [x] **1 point** Enforce `maxOpenChatgptTabs`.
  - Acceptance: launch path closes stale eligible tabs before opening more.
- [x] **1 point** Enforce `maxConcurrentJobs` per browser profile.
  - Acceptance: concurrent jobs sharing a profile queue.
- [x] **1 point** Close successful job tabs by default.
  - Acceptance: live smoke leaves no extra ChatGPT tabs after completion.
- [x] **1 point** Implement failed-tab policy.
  - Default close; preserve only with debug option.
  - Acceptance: failed jobs do not accumulate tabs unless configured.
- [x] **1 point** Implement idle tab cleanup.
  - Acceptance: stale blank/ChatGPT tabs above budget are closed.
- [x] **1 point** Integrate cancellation with active tab.
  - Acceptance: cancel attempts UI stop then closes tab safely.
- [x] **1 point** Add tab lifecycle tests.
  - Acceptance: tests cover max tabs, success cleanup, failure cleanup, and
    cancellation cleanup.

### 8. Reliability, Recovery, and Security — 6 Points

Strategy: make long jobs safe to run unattended on a developer workstation or
remote Linux host without leaking credentials or hiding actionable failures.

- [x] **1 point** Redact secrets in job inputs, events, and errors.
  - Acceptance: credential-like env names and bearer tokens are redacted in
    tests.
- [x] **1 point** Store connection artifact securely.
  - Acceptance: Unix file mode is `0600`; Windows behavior is documented.
- [x] **1 point** Add login/action-required mapping.
  - Acceptance: login, OTP, Cloudflare, and plan-limit errors map to
    `requires_action` where detectable.
- [x] **1 point** Add daemon crash recovery.
  - Acceptance: stale active jobs are reconciled on startup.
- [x] **1 point** Add result/artifact retention cleanup.
  - Acceptance: pruning respects active jobs and retention windows.
- [x] **1 point** Add partial-result preservation.
  - Acceptance: extraction/download partial failures keep available artifacts
    and warnings.

### 9. Tests and Live Validation — 6 Points

Strategy: prove the daemon solves the actual problem: separate processes can
submit, poll, and collect long-running browser work.

- [x] **1 point** Add unit tests for store and config.
  - Acceptance: pass locally with no browser.
- [x] **1 point** Add daemon integration tests with fake handlers.
  - Acceptance: submit, poll, events, result, cancel, and restart are covered.
- [x] **1 point** Add MCP schema tests.
  - Acceptance: all new/changed tools appear in generated schema.
- [x] **1 point** Add mcporter one-shot smoke.
  - Acceptance: submit in one process and poll/result in separate processes.
- [x] **1 point** Add live text browser smoke.
  - Prompt: `Say "yes" to this message. Do nothing else.`
  - Acceptance: completed result includes `yes` and conversation URL.
- [x] **1 point** Add live image browser smoke.
  - Prompt: `Create one tiny blue square icon. No text.`
  - Acceptance: downloaded artifact exists with JSON sidecar and no excess tabs.

### 10. Documentation and Agent Recipes — 4 Points

Strategy: reduce agent improvisation. The docs should tell a new agent exactly
which command/tool to use, how to recover, and what failure states mean.

- [x] **1 point** Add `docs/daemon.md`.
  - Acceptance: covers daemon start/status/stop, config, storage, and security.
- [x] **1 point** Update `docs/mcp.md`.
  - Acceptance: async tools explain daemon-backed durability and fallback.
- [x] **1 point** Update handoff/setup docs.
  - Include Ubuntu, WSL, Codex CLI, Claude Code, and mcporter examples.
  - Acceptance: a new agent can set up and run the smoke gates from docs only.
- [x] **1 point** Add troubleshooting guide.
  - Acceptance: covers daemon unavailable, auth failure, stuck queued job,
    login required, extraction warnings, cancellation, and retention cleanup.

## Completion Gates

### 25% Gate: Durable Local Substrate

Required points: at least 25, including:

- Product/API shape complete.
- Durable job store complete.
- Fake daemon job can be submitted, polled, tailed, and completed from separate
  local client calls.

Verification:

```bash
pnpm vitest run tests/jobs tests/daemon
pnpm run lint
```

### 50% Gate: MCP Solves One-Shot Polling

Required points: at least 50, including:

- Daemon `/jobs` endpoints complete enough for fake and image handlers.
- MCP async image tools submit daemon jobs.
- `oracle_job_status` and `oracle_job_result` work from separate MCP processes.

Verification:

```bash
pnpm vitest run tests/jobs tests/daemon tests/mcp.schema.test.ts
npx -y mcporter call oracle-local.chatgpt_generate_images_async ...
npx -y mcporter call oracle-local.oracle_job_status ...
```

### 75% Gate: Browser-Useful and Agent-Friendly

Required points: at least 75, including:

- Image generation/edit handlers complete.
- Text session handlers complete.
- CLI job commands usable.
- Tab cleanup enforced.
- Live text and image smokes pass.

Verification:

```bash
pnpm run lint
pnpm run build
oracle daemon start --background --json
oracle job start chatgpt-create-session --turn-message 'Say "yes" to this message. Do nothing else.' --json
oracle job result <job-id> --json
```

### 100% Gate: Reliable Default Path

Required points: 100.

Required outcomes:

- Durable daemon path is the default for long MCP async work.
- One-shot MCP clients can submit and poll reliably.
- Browser tabs are bounded and cleaned.
- Cancellation and action-required states are usable.
- Docs let a new code agent operate the system without local archaeology.

Verification:

```bash
pnpm run lint
pnpm run build
pnpm vitest run tests/jobs tests/daemon tests/mcp.schema.test.ts tests/mcp
npx -y mcporter list oracle-local --schema --config config/mcporter.json
```

Live verification:

- Fresh daemon start.
- Terminal-driven status check.
- MCP async text job.
- MCP async image job.
- Separate-process status/result polling.
- Artifact download.
- Tab budget inspection.

## Agent-Facing Decision Table

| Need                                 | Preferred Tool                                              |
| ------------------------------------ | ----------------------------------------------------------- |
| Quick text consult through API       | Existing `consult`                                          |
| Long Pro browser request             | `chatgpt_create_session_async` or `chatgpt_send_turn_async` |
| Fresh image generation               | `chatgpt_generate_images_async`                             |
| Image edit with references           | `chatgpt_edit_image_async`                                  |
| Existing image conversation download | `chatgpt_extract_images`                                    |
| Existing sandbox artifacts           | `chatgpt_extract_sandbox_artifacts`                         |
| Follow progress                      | `oracle_job_status` then `oracle_job_events`                |
| Final full payload                   | `oracle_job_result`                                         |
| Stop runaway work                    | `oracle_job_cancel`                                         |

## Open Design Questions

- Should `/runs` remain purely streaming forever, or should it internally create
  daemon jobs and stream attached events?
- Should `oracle-mcp` auto-start the daemon by default, or should default
  auto-start be limited to async tools only?
- Should completed job result payloads be returned inline by `oracle_job_status`
  for small results, or always via `oracle_job_result`?
- Should job prompts be stored by default, or should prompt persistence inherit
  the existing session-store policy exactly?
- How aggressive should retention cleanup be for large downloaded image/sandbox
  artifacts?

## Recommended First Implementation Slice

The fastest high-value slice is:

1. Durable job store.
2. Daemon `/jobs` endpoints with fake handler tests.
3. Daemon client.
4. MCP async tools use daemon for image generation/editing.
5. `oracle_job_status` and `oracle_job_result` read daemon records.
6. mcporter one-shot smoke proves durable polling.

This directly removes the current pain point without forcing a broad rewrite of
all browser commands. After that is stable, migrate text session turns and CLI
job commands onto the same substrate.
