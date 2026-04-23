## 1. Concise diagnosis

The effective tool session is **not full access**, regardless of what `/status` is printing. The command sandbox actually applied to the agent is:

```text
Filesystem sandboxing: workspace-write
Writable roots:
- /home/skra/.codex/memories
- /home/skra/projects/ql_homepage
- /tmp
Network access: restricted
Approval policy: never
```

That exact policy explains all three symptoms:

* `/mnt/c` is read-only because it is outside the writable roots and is being exposed to the sandbox as read-only.
* `git fetch` fails because `workspace-write` does **not** imply network access; network is off unless explicitly enabled.
* `connect EPERM 172.25.16.1:42339` is the expected shape of an outbound socket blocked by the sandbox/network policy.

Codex docs define the sandbox as the technical boundary for file and network access, while approval policy only controls when Codex asks before crossing that boundary. So `approval_policy = "never"` does **not** grant more access; it means “do not ask,” which makes restricted actions fail closed. ([OpenAI Developers][1])

The likely root cause is a **permission-state propagation/status mismatch** in or around Codex CLI/app-server/tool execution. Codex `0.124.0` explicitly shipped fixes for “permission-mode drift” and MCP permission policy sync, which strongly suggests this class of issue existed around this release line. ([OpenAI Developers][2])

---

## 2. What `/status` “Permissions: Full Access” should mean

In Codex terminology, **Full Access** should correspond to:

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
```

The docs state that `danger-full-access` removes filesystem and network boundaries, and that “Full access” means `danger-full-access` plus `never`. By contrast, `--full-auto` is **not** full access; it is `workspace-write` plus `on-request`. ([OpenAI Developers][3])

So, if `/status` says:

```text
Permissions: Full Access
```

but the tool metadata says:

```text
Filesystem sandboxing: workspace-write
Network access: restricted
Approval policy: never
```

then the tool metadata is the stronger evidence. It is the actual effective policy being injected into the command/tool environment.

Codex’s own slash-command docs say `/status` is intended to display the active model, approval policy, writable roots, and token usage, and `/debug-config` is the intended way to debug config layers and policy sources. ([OpenAI Developers][4]) If `/status` and the per-turn tool metadata disagree, treat the per-turn metadata and live probes as authoritative.

---

## 3. Permission architecture relevant to this mismatch

There are several separate layers:

| Layer                    | What it controls                                        | Relevant evidence                                                                                                                              |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| UI/session mode          | What `/permissions` or app UI thinks the thread mode is | `/permissions` should affect future actions, but 0.124.0 fixed stale permission-state drift after side conversations. ([OpenAI Developers][4]) |
| Approval policy          | Whether Codex asks before actions                       | `never` means no approval prompts; it does not expand sandbox access. ([OpenAI Developers][1])                                                 |
| Filesystem sandbox       | Which paths are readable/writable                       | `workspace-write` writes only inside workspace/writable roots; `danger-full-access` removes this boundary. ([OpenAI Developers][3])            |
| Network sandbox          | Whether spawned commands can use sockets/DNS            | `workspace-write` keeps network off unless `[sandbox_workspace_write].network_access = true`. ([OpenAI Developers][1])                         |
| Writable roots           | Extra directories writable under `workspace-write`      | `sandbox_workspace_write.writable_roots` and `--add-dir` add writable roots. ([OpenAI Developers][5])                                          |
| MCP/app tool policy      | App/MCP tool calls can have separate approval semantics | Codex can elicit approval for app/MCP tools with side effects, and 0.124.0 fixed MCP permission policy sync. ([OpenAI Developers][1])          |
| Platform sandbox backend | How enforcement is implemented on WSL/Linux/Windows     | WSL2 uses the Linux sandbox implementation; Linux/WSL2 use bubblewrap. ([OpenAI Developers][3])                                                |

The practical conclusion: **“Full Access” is not a single universal bit unless it reaches the exact tool executor for the turn.** The observed executor did not receive it.

---

## 4. Exact configuration for the desired Oracle state

Your stated needs include:

* write under `/home/skra/projects/ql_homepage/docs_tmp/oracle`
* write Windows-local Chrome profiles under `/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles`
* connect to Windows Chrome DevTools at `172.25.16.1:<port>`
* fetch/push GitHub
* no approval prompts

Because actual `git fetch`/`push` modifies `.git`, and Codex notes `.git/` may remain read-only in `workspace-write`, the **only configuration that cleanly satisfies all of this without prompts is true full access**. ([OpenAI Developers][6])

### Recommended launch command for this job

Run this from WSL, before starting the Codex session:

```bash
mkdir -p /mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles

cd /home/skra/projects/ql_homepage/docs_tmp/oracle

codex \
  --sandbox danger-full-access \
  --ask-for-approval never
```

Equivalent “yolo” form:

```bash
cd /home/skra/projects/ql_homepage/docs_tmp/oracle

codex --dangerously-bypass-approvals-and-sandbox
```

The CLI reference documents `--sandbox danger-full-access`, `--ask-for-approval never`, and `--dangerously-bypass-approvals-and-sandbox` / `--yolo`; it also warns that the bypass form runs commands without approvals or sandboxing. ([OpenAI Developers][7])

### Persistent config profile

Put this in `~/.codex/config.toml`:

```toml
[profiles.oracle_full_access]
sandbox_mode = "danger-full-access"
approval_policy = "never"

[projects."/home/skra/projects/ql_homepage/docs_tmp/oracle"]
trust_level = "trusted"
```

Then launch with:

```bash
cd /home/skra/projects/ql_homepage/docs_tmp/oracle
codex --profile oracle_full_access
```

Codex stores user config in `~/.codex/config.toml`, loads project-scoped config only for trusted projects, and CLI `--profile` selects a named profile. ([OpenAI Developers][5])

### Safer scoped alternative, but not sufficient for Git push/fetch reliability

This is useful for browser-profile writes plus network, but it may still block `.git` writes:

```toml
sandbox_mode = "workspace-write"
approval_policy = "never"

[sandbox_workspace_write]
network_access = true
writable_roots = [
  "/home/skra/projects/ql_homepage/docs_tmp/oracle",
  "/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles"
]
```

Launch:

```bash
cd /home/skra/projects/ql_homepage/docs_tmp/oracle

codex \
  --sandbox workspace-write \
  --ask-for-approval never \
  --add-dir /mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles \
  -c sandbox_workspace_write.network_access=true
```

Use this only if the agent does **not** need to run `git fetch`, `git pull`, `git push`, branch creation, or other `.git`-writing commands. The docs also recommend `--add-dir` over jumping to full access when you only need extra write directories. ([OpenAI Developers][7])

---

## 5. Configuration/settings table

| Behavior                   | Config key                                                                               | CLI flag                                                       | Env var                     | Default / note                                                                                 | Restart needed?                                               | Verify                                                                                                                                   |                                                             |                                              |
| -------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Filesystem sandbox mode    | `sandbox_mode`                                                                           | `--sandbox read-only                                           | workspace-write             | danger-full-access`                                                                            | No documented env var found                                   | Version-controlled folders tend to start in Auto / workspace-write; non-version-controlled may start read-only. ([OpenAI Developers][1]) | For deterministic behavior, restart session                 | `/status`, `/debug-config`, live write tests |
| Approval policy            | `approval_policy`                                                                        | `--ask-for-approval untrusted                                  | on-request                  | never`                                                                                         | No documented env var found                                   | `never` means no prompts, not more access. ([OpenAI Developers][5])                                                                      | Restart safest; `/permissions` should affect future actions | `/status`, `/debug-config`                   |
| Network in workspace-write | `sandbox_workspace_write.network_access = true`                                          | `-c sandbox_workspace_write.network_access=true`               | No documented env var found | Default is off in `workspace-write`. ([OpenAI Developers][1])                                  | Restart safest                                                | `getent hosts github.com`, `git ls-remote`, TCP test                                                                                     |                                                             |                                              |
| Extra writable roots       | `sandbox_workspace_write.writable_roots = [...]`                                         | `--add-dir PATH`                                               | No documented env var found | Adds write roots without disabling sandbox. ([OpenAI Developers][5])                           | Restart safest                                                | `/status`, `test -w`, `touch`                                                                                                            |                                                             |                                              |
| `/tmp` write root          | `sandbox_workspace_write.exclude_slash_tmp`                                              | `-c sandbox_workspace_write.exclude_slash_tmp=true/false`      | No documented env var found | `/tmp` is normally included in workspace-write. ([OpenAI Developers][5])                       | Restart safest                                                | `/status`, `test -w /tmp`                                                                                                                |                                                             |                                              |
| `$TMPDIR` write root       | `sandbox_workspace_write.exclude_tmpdir_env_var`                                         | `-c sandbox_workspace_write.exclude_tmpdir_env_var=true/false` | No documented env var found | `$TMPDIR` can be included unless excluded. ([OpenAI Developers][5])                            | Restart safest                                                | `/status`, `test -w "$TMPDIR"`                                                                                                           |                                                             |                                              |
| Permission profiles        | `default_permissions`, `[permissions.<name>.filesystem]`, `[permissions.<name>.network]` | `-c default_permissions=...`                                   | No documented env var found | Newer reusable profile system. ([OpenAI Developers][3])                                        | Restart safest                                                | `/debug-config`                                                                                                                          |                                                             |                                              |
| Project trust              | `[projects."<path>"].trust_level = "trusted"`                                            | none obvious                                                   | No documented env var found | Untrusted projects skip project `.codex/` layers. ([OpenAI Developers][5])                     | Restart safest                                                | `/debug-config`                                                                                                                          |                                                             |                                              |
| Native Windows sandbox     | `[windows].sandbox = "elevated"                                                          | "unelevated"`                                                  | none obvious                | No documented env var found                                                                    | Applies to native Windows, not WSL2. ([OpenAI Developers][8]) | Restart                                                                                                                                  | Windows sandbox diagnostics                                 |                                              |
| WSL sandbox backend        | N/A                                                                                      | N/A                                                            | N/A                         | WSL2 uses Linux sandbox implementation; WSL1 unsupported since 0.115. ([OpenAI Developers][9]) | N/A                                                           | `echo $WSL_DISTRO_NAME`, `/debug-config`                                                                                                 |                                                             |                                              |

---

## 6. Minimal reproduction / effective-sandbox probe

Use `git ls-remote` instead of `git fetch` for the first probe because it tests GitHub/DNS/TLS without writing `.git`.

Create:

```bash
cat > /tmp/codex-effective-sandbox-probe.sh <<'BASH'
#!/usr/bin/env bash
set -u

PROFILE_ROOT="/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles"
TCP_HOST="${1:-172.25.16.1}"
TCP_PORT="${2:-42339}"

echo "== identity =="
pwd || true
id || true
date -Is || true

echo
echo "== mounts =="
if command -v rg >/dev/null 2>&1; then
  mount | rg '/mnt/c|/home/skra/projects/ql_homepage' || true
else
  mount | grep -E '/mnt/c|/home/skra/projects/ql_homepage' || true
fi

echo
echo "== writable checks =="
for d in \
  /mnt/c \
  /home/skra/projects/ql_homepage \
  /home/skra/projects/ql_homepage/docs_tmp/oracle \
  "$PROFILE_ROOT"
do
  printf "%s: " "$d"
  test -w "$d" && echo writable || echo not_writable
done

echo
echo "== profile mkdir/write test =="
if mkdir -p "$PROFILE_ROOT" 2>/tmp/profile-mkdir.err; then
  test_file="$PROFILE_ROOT/.codex-write-test.$$"
  if printf 'ok\n' > "$test_file" 2>/tmp/profile-write.err; then
    echo "profile_write_ok"
    rm -f "$test_file"
  else
    echo "profile_write_fail"
    cat /tmp/profile-write.err
  fi
else
  echo "profile_mkdir_fail"
  cat /tmp/profile-mkdir.err
fi

echo
echo "== dns/github read-only test =="
getent hosts github.com || true
git ls-remote https://github.com/steipete/oracle.git HEAD || true

echo
echo "== tcp test to Chrome DevTools =="
node - "$TCP_HOST" "$TCP_PORT" <<'NODE'
const net = require("net");
const [host, port] = process.argv.slice(2);
const socket = net.connect({ host, port: Number(port) });
socket.setTimeout(5000);
socket.on("connect", () => {
  console.log("tcp ok");
  socket.destroy();
  process.exit(0);
});
socket.on("timeout", () => {
  console.error("tcp timeout");
  socket.destroy();
  process.exit(2);
});
socket.on("error", (e) => {
  console.error(e);
  process.exit(1);
});
NODE
BASH

chmod +x /tmp/codex-effective-sandbox-probe.sh
```

Run inside the Codex agent session:

```bash
/tmp/codex-effective-sandbox-probe.sh 172.25.16.1 42339
```

Interpretation:

* If `/status` says Full Access but this script shows `/mnt/c` read-only, DNS failure, or `connect EPERM`, `/status` is not reflecting the effective tool sandbox.
* If `mount | rg /mnt/c` shows `ro` inside Codex but `rw` in a normal WSL shell, the read-only state is Codex’s sandbox view, not WSL itself.
* If `git ls-remote` works but `git fetch` fails later, check `.git` write protection under `workspace-write`; use `danger-full-access` for real fetch/push workflows.

You can also use the documented `codex sandbox` helper to run a command under the same internal policies Codex uses, which is useful for isolating CLI config from model behavior. ([OpenAI Developers][7])

---

## 7. WSL-specific checklist

### `/mnt/c`

First verify outside Codex, in a normal WSL shell:

```bash
mount | grep ' /mnt/c '
mkdir -p /mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles
touch /mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/.wsl-write-test
rm /mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/.wsl-write-test
```

Then verify inside Codex with the probe. If normal WSL is writable but Codex shows `/mnt/c` as `ro`, that is the Codex sandbox boundary.

Keep the repository itself under `/home/...`, not `/mnt/c/...`; Codex’s Windows/WSL docs recommend Linux-home repos for fewer performance, symlink, and permission issues. ([OpenAI Developers][9])

### GitHub

Use the safe read-only test first:

```bash
getent hosts github.com
git ls-remote https://github.com/steipete/oracle.git HEAD
```

Then, only after full access is verified:

```bash
git fetch origin main --dry-run
git fetch kmccleary main --dry-run
```

For actual fetch/push, prefer `danger-full-access`; `workspace-write + network_access=true` can still be blocked by `.git` protections. ([OpenAI Developers][6])

### Windows Chrome DevTools from WSL

From normal WSL first:

```bash
curl -fsS http://172.25.16.1:42339/json/version
```

Then from Codex. If the normal shell works but Codex returns `EPERM`, that is network sandboxing.

For Windows Chrome launched from WSL, continue using a Windows-local profile directory under:

```text
/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles
```

The agent must either be full access or have that exact path added as a writable root.

---

## 8. Known bugs / behavior changes relevant to 0.124.0

I did **not** find a public issue that exactly says: “Codex CLI 0.124.0 `/status` says Full Access while WSL tool metadata says workspace-write/network restricted.”

I did find several close matches:

* The 0.124.0 changelog says it fixed “permission-mode drift” so `/permissions` changes survive side conversations and updated Full Access state is reflected in MCP approval handling. ([OpenAI Developers][2])
* PR #18924 explains the bug: `/permissions` updated the active TUI session state, but a cached session snapshot could restore old approval/sandbox settings, causing the next turn to fall back to the old permission mode. ([GitHub][10])
* PR #19033 describes MCP permission sync using stale per-turn config after switching to Full Access. ([GitHub][11])
* A Codex.app issue reports local config enabling network, while effective session instructions still said “Network access is restricted,” causing GitHub CLI/API commands to fail. ([GitHub][12])
* A desktop automation issue reports full-access app state but first-turn metadata showing `workspace-write` and `network_access=false`, breaking Git operations. ([GitHub][13])
* Another issue says setting Full Access after the initiating prompt did not take effect immediately. ([GitHub][14])

So: this looks like a real, documented **class** of permission propagation bugs, even if this exact WSL CLI case is not separately confirmed.

---

## 9. What to tell the coding agent

Paste this to the agent:

```text
Treat the tool metadata as authoritative, not /status. The current effective session is workspace-write, network restricted, approval never. Do not attempt browser attach, GitHub fetch/push, or Windows Chrome profile writes in this session.

Ask me to restart Codex from WSL with true full access:

cd /home/skra/projects/ql_homepage/docs_tmp/oracle
mkdir -p /mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles
codex --sandbox danger-full-access --ask-for-approval never

After restart, first run:

/status
/debug-config
/tmp/codex-effective-sandbox-probe.sh 172.25.16.1 42339

Proceed only if:
- /mnt/c profile write succeeds
- getent/git ls-remote succeeds
- TCP to Chrome DevTools succeeds
- the tool metadata no longer says workspace-write/network restricted

Then rerun:
node ./dist/bin/oracle-cli.js browser doctor --json
node ./dist/bin/oracle-cli.js browser login --creds-file ./openai_creds.env --remote-chrome 172.25.16.1:42339 --timeout 30s --json
```

For the Oracle workflow as described, the correct deterministic fix is: **start a new Codex session with `--sandbox danger-full-access --ask-for-approval never`, verify with live probes, then continue.**

[1]: https://developers.openai.com/codex/agent-approvals-security "Agent approvals & security – Codex | OpenAI Developers"
[2]: https://developers.openai.com/codex/changelog "Changelog – Codex | OpenAI Developers"
[3]: https://developers.openai.com/codex/concepts/sandboxing "Sandbox – Codex | OpenAI Developers"
[4]: https://developers.openai.com/codex/cli/slash-commands "Slash commands in Codex CLI | OpenAI Developers"
[5]: https://developers.openai.com/codex/config-reference "Configuration Reference – Codex | OpenAI Developers"
[6]: https://developers.openai.com/codex/config-advanced "Advanced Configuration – Codex | OpenAI Developers"
[7]: https://developers.openai.com/codex/cli/reference "Command line options – Codex CLI | OpenAI Developers"
[8]: https://developers.openai.com/codex/config-basic "Config basics – Codex | OpenAI Developers"
[9]: https://developers.openai.com/codex/windows "Windows – Codex | OpenAI Developers"
[10]: https://github.com/openai/codex/pull/18924 "TUI: preserve permission state after side conversations by etraut-openai · Pull Request #18924 · openai/codex · GitHub"
[11]: https://github.com/openai/codex/pull/19033 "Fix MCP permission policy sync by leoshimo-oai · Pull Request #19033 · openai/codex · GitHub"
[12]: https://github.com/openai/codex/issues/12996 "Codex.app injecting restricted network access · Issue #12996 · openai/codex · GitHub"
[13]: https://github.com/openai/codex/issues/14590 "Desktop automations can start in workspace-write and switch to danger-full-access after chat interaction · Issue #14590 · openai/codex · GitHub"
[14]: https://github.com/openai/codex/issues/17653 "[BUG] Not accepting all permissions when setting Full access after doing the first/initiating prompt · Issue #17653 · openai/codex · GitHub"
