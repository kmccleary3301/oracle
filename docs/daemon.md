# Oracle Daemon

The Oracle daemon owns long-running ChatGPT browser jobs so MCP clients and
shell callers can submit work, disconnect, and poll later.

## Start

```bash
oracle daemon start --background
```

Useful options:

```bash
oracle daemon start \
  --background \
  --host 127.0.0.1 \
  --port 9473 \
  --job-dir ~/.oracle/jobs \
  --connection-path ~/.oracle/daemon/connection.json
```

The connection artifact contains the daemon host, port, and bearer token. It is
written with restrictive permissions on Unix-like systems.

## Status and Stop

```bash
oracle daemon status --json
oracle daemon stop --json
```

## Jobs

Start a job:

```bash
oracle job start chatgpt_create_session \
  --turn-message 'Say "yes" to this message. Do nothing else.' \
  --timeout 120s \
  --json
```

Poll and read the result:

```bash
oracle job status <job-id> --json
oracle job events <job-id> --json
oracle job result <job-id> --json
```

Image generation:

```bash
oracle job start chatgpt_generate_images \
  --turn-message "Create one tiny blue square icon. No text." \
  --project-url "https://chatgpt.com/g/<image-project-id>" \
  --output-dir ./oracle-images \
  --browser-thinking-time heavy \
  --thinking-fallback allow \
  --artifact-types images,sandbox \
  --timeout 10m \
  --json
```

Recover a stale job whose browser turn completed but whose daemon state did not
write a result:

```bash
oracle job recover <job-id> \
  --artifact-types images,sandbox \
  --output-dir ./oracle-recovered \
  --json
```

You can pass `--conversation-url https://chatgpt.com/c/<id>` when the job record
does not contain a usable runtime URL. Recovery writes `result.json` and marks
the job completed only after artifacts are extracted.

Tab hygiene:

```bash
oracle tabs list --remote-chrome 127.0.0.1:9222
oracle tabs prune --remote-chrome 127.0.0.1:9222 --max-tabs 4
```

The daemon defaults to four open ChatGPT/about:blank tabs per remote Chrome
endpoint. Override with `daemon.maxOpenChatgptTabs` or
`ORACLE_MAX_OPEN_CHATGPT_TABS`.

## MCP

When `ORACLE_DAEMON_CONNECTION` or `daemon.connectionPath` points at a running
daemon, async MCP tools submit daemon-backed jobs:

- `chatgpt_create_session_async`
- `chatgpt_send_turn_async`
- `chatgpt_generate_images_async`
- `chatgpt_edit_image_async`

Poll through:

- `oracle_job_status`
- `oracle_job_events`
- `oracle_job_result`
- `oracle_job_cancel`
- `oracle_job_recover`

If no daemon is reachable, Oracle falls back to the in-process MCP async job
store. That fallback works for persistent MCP clients but does not survive
separate one-shot MCP processes.

## Troubleshooting

- `Oracle daemon connection not found`: start the daemon or set
  `ORACLE_DAEMON_CONNECTION`.
- `unauthorized`: the connection artifact token does not match the running
  daemon.
- job stuck `queued`: another job is running; default concurrency is one job per
  daemon/browser profile.
- `requires_action` or login errors: run `oracle browser status` and
  `oracle browser login`.
- generated image warnings: inspect `oracle job events <job-id>` and run
  `oracle job recover <job-id>` if the turn completed but extraction or daemon
  completion state was interrupted.
