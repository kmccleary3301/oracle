import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile) as unknown as (
  file: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

export const PROCESS_TYPES = [
  "browser",
  "renderer",
  "gpu",
  "utility",
  "network",
  "crashpad",
  "other",
] as const;

export type ProcessType = (typeof PROCESS_TYPES)[number];

export interface ProcessSnapshot {
  pid: number;
  ppid: number | null;
  startToken: string | null;
  rssBytes: number | null;
  workingSetBytes: number | null;
  cpuPercent: number | null;
  cpuTimeMs: number | null;
  command: string;
  processType: ProcessType;
  /** Generation is supplied by the owner registry, not inferred from the OS. */
  generation?: string;
}

export interface ProcessSnapshotProvider {
  listProcesses(): Promise<readonly ProcessSnapshot[]>;
}

export interface TargetTelemetryInput {
  count: number;
  types?: Readonly<Record<string, number>>;
}

export interface ProcessTreeSample {
  sampledAt: string;
  sampledAtMs: number;
  rootPid: number;
  rootFound: boolean;
  generation?: string;
  targetCount: number | null;
  targetTypes: Readonly<Record<string, number>>;
  processCount: number;
  processTypeCounts: Readonly<Record<string, number>>;
  rssBytes: number;
  workingSetBytes: number;
  cpuPercent: number;
  cpuTimeMs: number;
  processes: readonly ProcessSnapshot[];
}

export interface SampleOwnedChromeTreeOptions {
  rootPid: number;
  targetCount?: number;
  targetTypes?: Readonly<Record<string, number>>;
  generation?: string;
  provider?: ProcessSnapshotProvider;
  now?: () => Date;
}

export interface PlatformProcessProviderOptions {
  platform?: NodeJS.Platform | string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  execFile?: (
    file: string,
    args: readonly string[],
    options: ExecFileOptions & { encoding: "utf8" },
  ) => Promise<{ stdout: string; stderr: string }>;
}

function asFiniteNumber(value: string | number | undefined): number | null {
  const number = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  return Number.isFinite(number) ? number : null;
}

function parseCpuTime(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const values = parts.map((part) => Number.parseFloat(part));
  if (values.some((part) => !Number.isFinite(part))) return null;
  const seconds =
    values.length === 3
      ? values[0]! * 3600 + values[1]! * 60 + values[2]!
      : values[0]! * 60 + values[1]!;
  return seconds * 1000;
}

function classifyProcess(command: string): ProcessType {
  const lower = command.toLowerCase();
  if (/(?:^|\s)--type=renderer(?:\s|$)/.test(lower)) {
    return "renderer";
  }
  if (/(?:^|\s)--type=(?:gpu-process|gpu)(?:\s|$)/.test(lower)) {
    return "gpu";
  }
  if (/(?:^|\s)--type=utility(?:\s|$)/.test(lower)) {
    if (
      /--utility-sub-type=\S*network|--service-sandbox-type=network|network(?:\.mojom)?\.networkservice/.test(
        lower,
      )
    ) {
      return "network";
    }
    return "utility";
  }
  if (/crashpad|crash-handler/.test(lower)) return "crashpad";
  if (/\b(?:chrome|chromium|msedge)(?:\.exe)?\b/.test(lower)) return "browser";
  return "other";
}

function normalizeProcessSnapshot(
  input: Omit<ProcessSnapshot, "processType"> & { processType?: ProcessType },
): ProcessSnapshot | null {
  if (!Number.isInteger(input.pid) || input.pid <= 0) return null;
  const ppid = input.ppid === null || input.ppid === undefined ? null : Math.trunc(input.ppid);
  return {
    pid: Math.trunc(input.pid),
    ppid: ppid !== null && ppid >= 0 ? ppid : null,
    startToken: input.startToken?.trim() || null,
    rssBytes:
      input.rssBytes !== null && input.rssBytes !== undefined ? Math.max(0, input.rssBytes) : null,
    workingSetBytes:
      input.workingSetBytes !== null && input.workingSetBytes !== undefined
        ? Math.max(0, input.workingSetBytes)
        : null,
    cpuPercent:
      input.cpuPercent !== null && input.cpuPercent !== undefined
        ? Math.max(0, input.cpuPercent)
        : null,
    cpuTimeMs:
      input.cpuTimeMs !== null && input.cpuTimeMs !== undefined
        ? Math.max(0, input.cpuTimeMs)
        : null,
    command: input.command ?? "",
    processType: input.processType ?? classifyProcess(input.command ?? ""),
    ...(input.generation ? { generation: input.generation } : {}),
  };
}

/** Parse the stable, whitespace-delimited fields emitted by macOS and Linux ps. */
export function parsePosixProcessList(output: string): ProcessSnapshot[] {
  const rows: ProcessSnapshot[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim() || /^\s*pid\b/i.test(line)) continue;

    // A tab-separated form is useful for deterministic fixtures and survives command names with spaces.
    const tabFields = line.split("\t");
    if (tabFields.length >= 7) {
      const [pidRaw, ppidRaw, startToken, rssRaw, cpuRaw, cpuTimeRaw, ...commandParts] = tabFields;
      const normalized = normalizeProcessSnapshot({
        pid: Number.parseInt(pidRaw ?? "", 10),
        ppid: Number.parseInt(ppidRaw ?? "", 10),
        startToken: startToken ?? null,
        rssBytes: asFiniteNumber(rssRaw) === null ? null : asFiniteNumber(rssRaw)! * 1024,
        workingSetBytes: asFiniteNumber(rssRaw) === null ? null : asFiniteNumber(rssRaw)! * 1024,
        cpuPercent: asFiniteNumber(cpuRaw),
        cpuTimeMs: parseCpuTime(cpuTimeRaw),
        command: commandParts.join("\t"),
      });
      if (normalized) rows.push(normalized);
      continue;
    }

    // ps lstart is 24 characters (including the space used for a one-digit day).
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const [, pidRaw, ppidRaw, startToken, rssRaw, cpuRaw, cpuTimeRaw, command] = match;
    const rssKiB = asFiniteNumber(rssRaw);
    const normalized = normalizeProcessSnapshot({
      pid: Number.parseInt(pidRaw ?? "", 10),
      ppid: Number.parseInt(ppidRaw ?? "", 10),
      startToken: startToken ?? null,
      rssBytes: rssKiB === null ? null : rssKiB * 1024,
      workingSetBytes: rssKiB === null ? null : rssKiB * 1024,
      cpuPercent: asFiniteNumber(cpuRaw),
      cpuTimeMs: parseCpuTime(cpuTimeRaw),
      command: command ?? "",
    });
    if (normalized) rows.push(normalized);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

function parseWindowsRecord(record: Record<string, unknown>): ProcessSnapshot | null {
  const values = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
  const number = (key: string): number | null => {
    const value = values.get(key);
    return typeof value === "number"
      ? value
      : asFiniteNumber(typeof value === "string" ? value : undefined);
  };
  const command = String(
    values.get("commandline") ?? values.get("command") ?? values.get("name") ?? "",
  );
  const cpuTime100ns = number("cputime100ns") ?? number("cputime");
  const cpuTimeMs =
    cpuTime100ns === null ? null : cpuTime100ns > 1_000_000 ? cpuTime100ns / 10_000 : cpuTime100ns;
  const workingSet = number("workingsetbytes") ?? number("workingset");
  const normalized = normalizeProcessSnapshot({
    pid: Math.trunc(number("processid") ?? number("pid") ?? 0),
    ppid: number("parentprocessid") ?? number("ppid"),
    startToken: String(values.get("creationdate") ?? values.get("starttoken") ?? "") || null,
    rssBytes: workingSet,
    workingSetBytes: workingSet,
    cpuPercent: number("cpupercent"),
    cpuTimeMs,
    command,
  });
  return normalized;
}

/** Parse JSON emitted by the Windows provider's bounded PowerShell command. */
export function parseWindowsProcessJson(output: string): ProcessSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(output);
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.flatMap((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return [];
      const normalized = parseWindowsRecord(record as Record<string, unknown>);
      return normalized ? [normalized] : [];
    });
  } catch {
    return [];
  }
}

/** Parse CSV output for Windows fixtures/providers that cannot emit JSON. */
export function parseWindowsProcessCsv(output: string): ProcessSnapshot[] {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]!).map((header) => header.trim());
  return lines.slice(1).flatMap((line) => {
    const fields = parseCsvLine(line);
    const record = Object.fromEntries(
      headers.map((header, index) => [header, fields[index] ?? ""]),
    );
    const normalized = parseWindowsRecord(record);
    return normalized ? [normalized] : [];
  });
}

/** Create a bounded platform provider. The command output is parsed separately for deterministic tests. */
export function createPlatformProcessProvider(
  options: PlatformProcessProviderOptions = {},
): ProcessSnapshotProvider {
  const platform = options.platform ?? process.platform;
  const timeoutMs = Math.max(
    100,
    Math.min(30_000, Math.trunc(options.timeoutMs ?? (platform === "win32" ? 30_000 : 3_000))),
  );
  const maxBuffer = Math.max(
    64 * 1024,
    Math.min(8 * 1024 * 1024, Math.trunc(options.maxBufferBytes ?? 2 * 1024 * 1024)),
  );
  const run = options.execFile ?? execFileAsync;
  return {
    async listProcesses() {
      if (platform === "win32") {
        const script = [
          "$ErrorActionPreference='SilentlyContinue';",
          "Get-CimInstance Win32_Process | ForEach-Object {",
          "$p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;",
          "[PSCustomObject]@{ProcessId=$_.ProcessId;ParentProcessId=$_.ParentProcessId;CreationDate=$_.CreationDate;CommandLine=$_.CommandLine;WorkingSetBytes=$_.WorkingSetSize;CpuTime100ns=if($p){[int64](($p.UserProcessorTime+$p.PrivilegedProcessorTime).TotalMilliseconds*10000)}else{$null}}",
          "} | ConvertTo-Json -Compress",
        ].join(" ");
        const { stdout } = await run(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          {
            encoding: "utf8",
            timeout: timeoutMs,
            maxBuffer,
          },
        );
        return parseWindowsProcessJson(stdout);
      }
      const { stdout } = await run("ps", ["-axo", "pid=,ppid=,lstart=,rss=,pcpu=,time=,command="], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer,
      });
      return parsePosixProcessList(stdout);
    },
  };
}

function normalizeProfile(value: string): string {
  return value
    .replaceAll('"', "")
    .replaceAll("'", "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Extract a profile path from Chrome's command line without exposing it in artifacts. */
export function extractChromeProfilePath(command: string): string | null {
  const match = command.match(/(?:^|\s)--user-data-dir(?:=|\s+)("[^"]+"|'[^']+'|\S+)/i);
  return match?.[1] ? match[1].replace(/^['"]|['"]$/g, "") : null;
}

/** Redact paths, credentials, and token-like values while preserving process type flags. */
export function redactProcessCommand(command: string): string {
  return command
    .replace(/(--user-data-dir(?:=|\s+))("[^"]+"|'[^']+'|\S+)/gi, "$1<redacted-profile>")
    .replace(
      /(--(?:remote-debugging-auth-token|token|password|pass|cookie|proxy-server)(?:=|\s+))("[^"]+"|'[^']+'|\S+)/gi,
      "$1<redacted>",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"']+/gi, "<redacted-path>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted-token>");
}

export function redactProcessSnapshot(snapshot: ProcessSnapshot): ProcessSnapshot {
  return { ...snapshot, command: redactProcessCommand(snapshot.command), generation: undefined };
}

export function redactProcessTreeSample(sample: ProcessTreeSample): ProcessTreeSample {
  return {
    ...sample,
    processes: sample.processes.map(redactProcessSnapshot),
  };
}

export async function sampleOwnedChromeTree(
  options: SampleOwnedChromeTreeOptions,
): Promise<ProcessTreeSample> {
  if (!Number.isInteger(options.rootPid) || options.rootPid <= 0) {
    throw new Error("rootPid must be a positive integer");
  }
  const provider = options.provider ?? createPlatformProcessProvider();
  const allProcesses = [...(await provider.listProcesses())];
  const byPid = new Map(allProcesses.map((process) => [process.pid, process]));
  const children = new Map<number, number[]>();
  for (const process of allProcesses) {
    if (process.ppid === null) continue;
    const list = children.get(process.ppid) ?? [];
    list.push(process.pid);
    children.set(process.ppid, list);
  }
  const selected = new Set<number>();
  const pending = [options.rootPid];
  while (pending.length) {
    const pid = pending.pop()!;
    if (selected.has(pid)) continue;
    selected.add(pid);
    for (const child of children.get(pid) ?? []) pending.push(child);
  }
  const processes = [...selected]
    .map((pid) => byPid.get(pid))
    .filter((process): process is ProcessSnapshot => process !== undefined)
    .sort((left, right) => left.pid - right.pid);
  const sum = (key: "rssBytes" | "workingSetBytes" | "cpuPercent" | "cpuTimeMs"): number =>
    processes.reduce((total, process) => total + (process[key] ?? 0), 0);
  const processTypeCounts: Record<string, number> = {};
  for (const process of processes)
    processTypeCounts[process.processType] = (processTypeCounts[process.processType] ?? 0) + 1;
  const now = options.now?.() ?? new Date();
  return {
    sampledAt: now.toISOString(),
    sampledAtMs: now.getTime(),
    rootPid: options.rootPid,
    rootFound: byPid.has(options.rootPid),
    ...(options.generation ? { generation: options.generation } : {}),
    targetCount:
      options.targetCount === undefined ? null : Math.max(0, Math.trunc(options.targetCount)),
    targetTypes: { ...(options.targetTypes ?? {}) },
    processCount: processes.length,
    processTypeCounts,
    rssBytes: sum("rssBytes"),
    workingSetBytes: sum("workingSetBytes"),
    cpuPercent: sum("cpuPercent"),
    cpuTimeMs: sum("cpuTimeMs"),
    processes,
  };
}

export interface ProcessIdentityExpectation {
  pid: number;
  parentPid?: number | null;
  startToken: string;
  profilePath?: string;
  commandIncludes?: readonly string[];
  generation: string;
}

export interface ProcessIdentityObservation {
  pid: number;
  parentPid?: number | null;
  startToken: string | null;
  command: string;
  generation?: string;
}

export type ProcessIdentityMismatch =
  | "pid-mismatch"
  | "parent-pid-mismatch"
  | "start-token-mismatch"
  | "missing-start-token"
  | "profile-mismatch"
  | "command-mismatch"
  | "missing-command-evidence"
  | "generation-mismatch"
  | "missing-generation-evidence";

export interface ProcessIdentityValidation {
  eligible: boolean;
  mismatches: readonly ProcessIdentityMismatch[];
}

/** Validate every ownership signal required before a destructive process-tree action. */
export function validateProcessIdentity(
  observed: ProcessIdentityObservation,
  expected: ProcessIdentityExpectation,
): ProcessIdentityValidation {
  const mismatches: ProcessIdentityMismatch[] = [];
  if (observed.pid !== expected.pid) mismatches.push("pid-mismatch");
  if (expected.parentPid !== undefined && observed.parentPid !== expected.parentPid)
    mismatches.push("parent-pid-mismatch");
  if (!expected.startToken.trim() || !observed.startToken) mismatches.push("missing-start-token");
  else if (observed.startToken !== expected.startToken) mismatches.push("start-token-mismatch");

  const command = observed.command ?? "";
  const normalizedCommand = command.toLowerCase().replaceAll("\\", "/");
  let commandEvidence = false;
  if (expected.profilePath) {
    commandEvidence = true;
    if (!normalizedCommand.includes(normalizeProfile(expected.profilePath)))
      mismatches.push("profile-mismatch");
  }
  for (const required of expected.commandIncludes ?? []) {
    commandEvidence = true;
    if (!normalizedCommand.includes(required.toLowerCase())) mismatches.push("command-mismatch");
  }
  if (!commandEvidence) mismatches.push("missing-command-evidence");
  if (!expected.generation || !observed.generation) mismatches.push("missing-generation-evidence");
  else if (observed.generation !== expected.generation) mismatches.push("generation-mismatch");
  return { eligible: mismatches.length === 0, mismatches };
}

export function isProcessTerminationEligible(
  observed: ProcessIdentityObservation,
  expected: ProcessIdentityExpectation,
): boolean {
  return validateProcessIdentity(observed, expected).eligible;
}

/** Alias used by lifecycle code that wants the complete evidence result. */
export const validateTerminationIdentity = validateProcessIdentity;
