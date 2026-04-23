# Codex CLI Permissions Mismatch Investigation Prompt

You are investigating a Codex CLI permissions mismatch. This prompt is standalone; assume no prior context.

## Situation

We are using Codex CLI version `0.124.0` from a WSL environment.

The user reports that `/status` in Codex CLI says:

```text
Permissions: Full Access
```

and that this status has remained unchanged across several requests.

However, the assistant tool environment visible to the coding agent reports a stricter policy:

```text
Filesystem sandboxing: workspace-write
Writable roots:
- /home/skra/.codex/memories
- /home/skra/projects/ql_homepage
- /tmp
Network access: restricted
Approval policy: never
```

The work is happening under:

```text
/home/skra/projects/ql_homepage/docs_tmp/oracle
```

This is a cloned Oracle repo used as scratch work and should not touch the parent repo except under `docs_tmp/oracle`.

## Observed Symptoms

### 1. `/mnt/c` Is Not Writable From The Agent Tool Session

The project needs to launch Windows Chrome from WSL and use a Windows-local Chrome profile directory under:

```text
/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/...
```

This is necessary because Windows Chrome does not reliably accept a WSL/UNC-style profile path. Using Windows `%LOCALAPPDATA%` avoids Chrome profile errors such as:

```text
Something went wrong when opening your profile. Some features may be unavailable.
```

But inside the Codex tool session, this command reports `/mnt/c` as read-only:

```bash
mount | rg '/mnt/c'
```

Observed output:

```text
C:\ on /mnt/c type 9p (ro,nosuid,nodev,noatime,aname=drvfs;path=C:\;uid=1000;gid=1000;symlinkroot=/mnt/,cache=5,access=client,msize=65536,trans=fd,rfd=6,wfd=6)
```

And attempts to write under `/mnt/c/.../Oracle/browser-profiles` fail with errors like:

```text
ENOENT: no such file or directory, mkdir '/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/browser-profile-767990c84b'
```

or:

```text
EROFS: read-only file system, open '/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/.../chrome-out.log'
```

### 2. Network/DNS Appears Restricted Despite `/status` Saying Full Access

The agent tried:

```bash
git fetch origin main --dry-run
git fetch kmccleary main --dry-run
```

The remotes are:

```text
origin     https://github.com/steipete/oracle.git
kmccleary https://github.com/kmccleary3301/oracle.git
```

Both fetches failed with:

```text
fatal: unable to access 'https://github.com/steipete/oracle.git/': Could not resolve host: github.com
fatal: unable to access 'https://github.com/kmccleary3301/oracle.git/': Could not resolve host: github.com
```

### 3. Outbound Local TCP To Windows Chrome DevTools Is Blocked

A Windows Chrome instance was previously launched and exposed through a WSL-accessible host/port such as:

```text
172.25.16.1:42339
```

The built Oracle CLI tried to attach:

```bash
node ./dist/bin/oracle-cli.js browser login \
  --creds-file ./openai_creds.env \
  --remote-chrome 172.25.16.1:42339 \
  --timeout 30s \
  --json
```

After fixing CLI parsing so it correctly chose remote attach mode, it failed with:

```text
connect EPERM 172.25.16.1:42339 - Local (undefined:undefined)
```

This suggests outbound TCP is blocked by the Codex tool sandbox/network policy, despite `/status` saying Full Access.

## What We Need To Understand

Please inspect Codex CLI `0.124.0` docs, changelog, source code, issue tracker, and relevant configuration behavior to answer the following.

### Core Questions

1. What exactly does `/status` `Permissions: Full Access` mean in Codex CLI `0.124.0`?
2. Is `/status` reporting the UI/session permission mode while individual tool calls may still receive stricter sandbox metadata?
3. Are there now separate permission layers for:
   - the Codex CLI UI status,
   - MCP/tool execution,
   - shell command sandboxing,
   - network access,
   - filesystem writable roots?
4. Did Codex CLI `0.124.0` change the mapping between `/status` and the actual tool sandbox passed to the model?
5. Is there a known bug where `/status` says Full Access but tool metadata says `workspace-write` and `network restricted`?
6. Is there a known WSL-specific behavior where `/mnt/c` is remounted read-only for tool execution even under Full Access?
7. Is network access supposed to be implied by Full Access, or is it separately controlled?
8. Why would `git fetch` fail with DNS resolution errors while `/status` says Full Access?
9. Why would local TCP to a Windows host gateway fail with `connect EPERM` while `/status` says Full Access?
10. How can a user definitively confirm the actual effective sandbox for a specific tool call?

### Configuration Questions

Find all relevant config/env/CLI options that control these behaviors in Codex CLI `0.124.0`.

Specifically look for:

- filesystem sandbox mode
- workspace write roots
- read-only mounts
- network enable/disable
- approval policy
- MCP tool sandboxing
- WSL interop behavior
- `/mnt/c` mount handling
- Windows host TCP access from WSL
- any distinction between "Full Access" and "danger-full-access"

For each setting, provide:

- config key
- environment variable, if any
- CLI flag, if any
- default value
- whether changing it requires starting a new Codex session
- how to verify it took effect

### Reproduction We Need

Please propose a minimal reproduction script or command sequence that demonstrates whether the effective tool sandbox matches `/status`.

It should check:

```bash
pwd
id
mount | rg '/mnt/c|/home/skra/projects/ql_homepage'
test -w /mnt/c && echo mnt_c_writable || echo mnt_c_not_writable
test -w /home/skra/projects/ql_homepage && echo workspace_writable || echo workspace_not_writable
getent hosts github.com || true
git ls-remote https://github.com/steipete/oracle.git HEAD
node -e "require('net').connect({host:'172.25.16.1',port:42339}).on('connect',()=>{console.log('tcp ok');process.exit(0)}).on('error',e=>{console.error(e);process.exit(1)})"
```

Also identify any safer alternatives if these commands are inappropriate.

### Desired Working State

For this Oracle browser automation project, the agent needs:

- read/write under `/home/skra/projects/ql_homepage/docs_tmp/oracle`
- ability to create/write Windows-local Chrome profiles under `/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles`
- ability to connect to Windows Chrome DevTools from WSL, e.g. `172.25.16.1:<port>`
- ability to fetch/push GitHub remotes
- no approval prompts during long-running CLI/browser automation work

Please identify the exact Codex CLI configuration needed to guarantee that state.

## Important Context About Oracle Work

This project uses a browser automation package called Oracle.

The user wants to automate ChatGPT browser interactions using a browser-based ChatGPT Pro subscription, not API keys.

The WSL/Windows setup launches Windows Chrome from WSL. For this setup:

- Windows Chrome profile paths must be Windows-local.
- The WSL path view is `/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/...`.
- If a true Linux system is used instead, Chrome should be Linux Chrome and the profile should live in Linux-local paths like `~/.oracle/browser-profile`.

A new `oracle browser doctor` command was added to report:

- OS/WSL detection
- Chrome path
- Chrome kind: Windows/Linux/macOS/unknown
- configured profile dir
- effective profile dir
- profile writability
- whether WSL Windows profile mapping is required
- whether a WSL DevTools bridge is required

On the current tool session, `oracle browser doctor --json` reports:

```json
{
  "platform": "linux",
  "arch": "x64",
  "osRelease": "6.6.87.2-microsoft-standard-WSL2",
  "isWsl": true,
  "chromePath": "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "chromeKind": "windows",
  "remoteChrome": null,
  "manualLogin": true,
  "configuredProfileDir": "/home/skra/.oracle/browser-profile",
  "profileDir": "/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/browser-profile-767990c84b",
  "profileWritable": false,
  "profileError": "ENOENT: no such file or directory, mkdir '/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/browser-profile-767990c84b'",
  "requiresWindowsLocalProfile": true,
  "requiresWslDevtoolsBridge": false,
  "warnings": [
    "WSL is using Windows Chrome; Oracle maps the configured Linux profile path to a Windows-local profile before launch."
  ],
  "problems": [
    "Profile directory is not writable: /mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/browser-profile-767990c84b (ENOENT: no such file or directory, mkdir '/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/browser-profile-767990c84b')"
  ]
}
```

## Output Format Requested

Please produce:

1. A concise diagnosis of the most likely cause.
2. A detailed explanation of the relevant Codex CLI permission architecture in `0.124.0`.
3. Exact commands/config changes to make future Codex tool sessions truly full access.
4. A WSL-specific checklist for `/mnt/c`, GitHub, and Windows Chrome DevTools access.
5. Any known bugs or behavior changes from recent Codex CLI versions.
6. A short "what to tell the coding agent" section with the exact next steps.
