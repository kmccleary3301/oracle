import { BrowserAutomationError } from "../oracle/errors.js";
import { ResourceGovernor, type ResourceGovernorPhase } from "./resourceGovernor.js";
import {
  createPlatformProcessProvider,
  sampleOwnedChromeTree,
  validateProcessIdentity,
  type ProcessIdentityExpectation,
  type ProcessSnapshot,
  type ProcessSnapshotProvider,
  type ProcessTreeSample,
} from "./resourceTelemetry.js";
import type { BrowserLogger } from "./types.js";

const MiB = 1024 ** 2;

export const DEFAULT_BROWSER_RESOURCE_WATCHDOG_CONFIG = {
  pollIntervalMs: 1_000,
  rssSoftBytes: 4_096 * MiB,
  rssHardBytes: 6_144 * MiB,
  rssResumeBytes: 3_072 * MiB,
  maxConsecutiveSampleFailures: 3,
} as const;

export interface BrowserResourceWatchdogConfig {
  pollIntervalMs?: number;
  rssSoftBytes?: number;
  rssHardBytes?: number;
  rssResumeBytes?: number;
  maxConsecutiveSampleFailures?: number;
}

export interface BrowserResourceWatchdogOptions {
  rootPid: number;
  profilePath: string;
  logger: BrowserLogger;
  config?: BrowserResourceWatchdogConfig;
  onHardLimit: (
    error: BrowserAutomationError,
    evidence: BrowserResourceTerminationEvidence | null,
  ) => void | Promise<void>;
  onSample?: (
    sample: ProcessTreeSample,
    decision: {
      phase: ResourceGovernorPhase;
      reason: string;
      rssSoftBytes: number;
      rssHardBytes: number;
      rssResumeBytes: number;
    },
  ) => void | Promise<void>;
  onStop?: () => void;
}

export interface BrowserResourceTerminationEvidence {
  expected: ProcessIdentityExpectation;
  sample: ProcessTreeSample;
  generation: string;
}

export interface BrowserResourceWatchdogDependencies {
  sample?: typeof sampleOwnedChromeTree;
}

export interface BrowserResourceTerminationResult {
  terminated: boolean;
  termSignaledPids: readonly number[];
  killSignaledPids: readonly number[];
  remainingPids: readonly number[];
  reason: "terminated" | "identity_mismatch" | "processes_remain";
}

export interface BrowserResourceTerminationDependencies {
  processProvider?: ProcessSnapshotProvider;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function terminateVerifiedOwnedChromeTree(
  evidence: BrowserResourceTerminationEvidence,
  dependencies: BrowserResourceTerminationDependencies = {},
): Promise<BrowserResourceTerminationResult> {
  const provider = dependencies.processProvider ?? createPlatformProcessProvider();
  const signal = dependencies.signal ?? ((pid, processSignal) => process.kill(pid, processSignal));
  const wait =
    dependencies.wait ??
    ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const latest = await provider.listProcesses();
  const currentRoot = latest.find((candidate) => candidate.pid === evidence.expected.pid);
  const validation = currentRoot
    ? validateProcessIdentity(
        {
          pid: currentRoot.pid,
          parentPid: currentRoot.ppid,
          startToken: currentRoot.startToken,
          command: currentRoot.command,
          generation: evidence.generation,
        },
        evidence.expected,
      )
    : null;
  if (!currentRoot || !validation?.eligible) {
    return {
      terminated: false,
      termSignaledPids: [],
      killSignaledPids: [],
      remainingPids: currentRoot ? [currentRoot.pid] : [],
      reason: "identity_mismatch",
    };
  }

  const captured = new Map(
    evidence.sample.processes
      .filter((candidate) => candidate.startToken)
      .map((candidate) => [candidate.pid, candidate] as const),
  );
  const signalCaptured = async (processSignal: NodeJS.Signals): Promise<number[]> => {
    const processes = await provider.listProcesses();
    const current = new Map(processes.map((candidate) => [candidate.pid, candidate] as const));
    const pids = [...captured.keys()].sort((left, right) => {
      if (left === evidence.expected.pid) return 1;
      if (right === evidence.expected.pid) return -1;
      return right - left;
    });
    const signaled: number[] = [];
    for (const pid of pids) {
      const expected = captured.get(pid);
      const observed = current.get(pid);
      if (
        !expected?.startToken ||
        !observed ||
        observed.startToken !== expected.startToken ||
        observed.command !== expected.command
      ) {
        continue;
      }
      try {
        signal(pid, processSignal);
        signaled.push(pid);
      } catch {
        // ESRCH is equivalent to successful cleanup; other failures remain visible below.
      }
    }
    return signaled;
  };

  const termSignaledPids = await signalCaptured("SIGTERM");
  await wait(2_000);
  const killSignaledPids = await signalCaptured("SIGKILL");
  if (killSignaledPids.length > 0) await wait(250);
  const remaining = await provider.listProcesses();
  const remainingPids = remaining
    .filter((candidate) => {
      const expected = captured.get(candidate.pid);
      return (
        expected?.startToken === candidate.startToken && expected.command === candidate.command
      );
    })
    .map((candidate) => candidate.pid);
  return {
    terminated: remainingPids.length === 0,
    termSignaledPids,
    killSignaledPids,
    remainingPids,
    reason: remainingPids.length === 0 ? "terminated" : "processes_remain",
  };
}
export interface BrowserResourceWatchdog {
  readonly exhaustion: Promise<never>;
  sampleNow(): Promise<void>;
  stop(): void;
}

interface ResolvedBrowserResourceWatchdogConfig {
  pollIntervalMs: number;
  rssSoftBytes: number;
  rssHardBytes: number;
  rssResumeBytes: number;
  maxConsecutiveSampleFailures: number;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function resolveBrowserResourceWatchdogConfig(
  config: BrowserResourceWatchdogConfig = {},
): ResolvedBrowserResourceWatchdogConfig {
  const resolved = {
    pollIntervalMs: positiveInteger(
      "pollIntervalMs",
      config.pollIntervalMs ?? DEFAULT_BROWSER_RESOURCE_WATCHDOG_CONFIG.pollIntervalMs,
    ),
    rssSoftBytes: positiveInteger(
      "rssSoftBytes",
      config.rssSoftBytes ?? DEFAULT_BROWSER_RESOURCE_WATCHDOG_CONFIG.rssSoftBytes,
    ),
    rssHardBytes: positiveInteger(
      "rssHardBytes",
      config.rssHardBytes ?? DEFAULT_BROWSER_RESOURCE_WATCHDOG_CONFIG.rssHardBytes,
    ),
    rssResumeBytes: positiveInteger(
      "rssResumeBytes",
      config.rssResumeBytes ?? DEFAULT_BROWSER_RESOURCE_WATCHDOG_CONFIG.rssResumeBytes,
    ),
    maxConsecutiveSampleFailures: positiveInteger(
      "maxConsecutiveSampleFailures",
      config.maxConsecutiveSampleFailures ??
        DEFAULT_BROWSER_RESOURCE_WATCHDOG_CONFIG.maxConsecutiveSampleFailures,
    ),
  };
  if (resolved.rssResumeBytes >= resolved.rssSoftBytes) {
    throw new RangeError("rssResumeBytes must be lower than rssSoftBytes");
  }
  if (resolved.rssSoftBytes >= resolved.rssHardBytes) {
    throw new RangeError("rssSoftBytes must be lower than rssHardBytes");
  }
  return resolved;
}

function rootProcess(sample: ProcessTreeSample, rootPid: number): ProcessSnapshot | null {
  return sample.processes.find((process) => process.pid === rootPid) ?? null;
}

function resourceError(
  message: string,
  sample: ProcessTreeSample | null,
  config: ResolvedBrowserResourceWatchdogConfig,
  reason: string,
): BrowserAutomationError {
  return new BrowserAutomationError(message, {
    stage: "browser-resource-limit",
    reason,
    rootPid: sample?.rootPid,
    rssBytes: sample?.rssBytes,
    processCount: sample?.processCount,
    rssHardBytes: config.rssHardBytes,
  });
}

class OwnedChromeResourceWatchdog implements BrowserResourceWatchdog {
  readonly exhaustion: Promise<never>;
  readonly #rootPid: number;
  readonly #logger: BrowserLogger;
  readonly #config: ResolvedBrowserResourceWatchdogConfig;
  readonly #sample: typeof sampleOwnedChromeTree;
  readonly #onHardLimit: BrowserResourceWatchdogOptions["onHardLimit"];
  readonly #onSample: BrowserResourceWatchdogOptions["onSample"];
  readonly #onStop: BrowserResourceWatchdogOptions["onStop"];
  readonly #generation: string;
  readonly #expected: ProcessIdentityExpectation;
  readonly #governor: ResourceGovernor;
  #rejectExhaustion!: (error: BrowserAutomationError) => void;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #checking = false;
  #sampleFailures = 0;
  #lastPhase: ResourceGovernorPhase = "normal";

  private constructor(
    options: BrowserResourceWatchdogOptions,
    dependencies: BrowserResourceWatchdogDependencies,
    initialSample: ProcessTreeSample,
    initialRoot: ProcessSnapshot,
  ) {
    this.#rootPid = options.rootPid;
    this.#logger = options.logger;
    this.#config = resolveBrowserResourceWatchdogConfig(options.config);
    this.#sample = dependencies.sample ?? sampleOwnedChromeTree;
    this.#onHardLimit = options.onHardLimit;
    this.#onSample = options.onSample;
    this.#onStop = options.onStop;
    this.#generation = `${process.pid}:${options.rootPid}:${Date.now()}`;
    this.#expected = {
      pid: options.rootPid,
      parentPid: initialRoot.ppid,
      startToken: initialRoot.startToken ?? "",
      profilePath: options.profilePath,
      generation: this.#generation,
    };
    this.#governor = new ResourceGovernor({
      rssSoftBytes: this.#config.rssSoftBytes,
      rssHardBytes: this.#config.rssHardBytes,
      rssResumeBytes: this.#config.rssResumeBytes,
    });
    this.exhaustion = new Promise<never>((_resolve, reject) => {
      this.#rejectExhaustion = reject;
    });
    void this.exhaustion.catch(() => undefined);
    if (initialSample.rssBytes >= this.#config.rssHardBytes) {
      this.#schedule(0);
    } else {
      this.#schedule(this.#config.pollIntervalMs);
    }
  }

  static async start(
    options: BrowserResourceWatchdogOptions,
    dependencies: BrowserResourceWatchdogDependencies,
  ): Promise<OwnedChromeResourceWatchdog> {
    const sample = dependencies.sample ?? sampleOwnedChromeTree;
    const initialSample = await sample({ rootPid: options.rootPid });
    const initialRoot = rootProcess(initialSample, options.rootPid);
    if (!initialSample.rootFound || !initialRoot?.startToken) {
      throw resourceError(
        "Oracle could not establish owned Chrome process identity; closing the unmonitored browser.",
        initialSample,
        resolveBrowserResourceWatchdogConfig(options.config),
        "identity_unavailable",
      );
    }
    return new OwnedChromeResourceWatchdog(options, dependencies, initialSample, initialRoot);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    clearTimeout(this.#timer ?? undefined);
    this.#timer = null;
    this.#onStop?.();
  }

  async sampleNow(): Promise<void> {
    if (this.#stopped || this.#checking) return;
    this.#checking = true;
    try {
      const sample = await this.#sample({ rootPid: this.#rootPid });
      if (!sample.rootFound) {
        this.stop();
        return;
      }
      const root = rootProcess(sample, this.#rootPid);
      if (!root) {
        this.stop();
        return;
      }
      this.#sampleFailures = 0;
      const decision = this.#governor.decide({
        sample,
        ownership: "owned",
        identity: {
          expected: this.#expected,
          observed: {
            pid: root.pid,
            parentPid: root.ppid,
            startToken: root.startToken,
            command: root.command,
            generation: this.#generation,
          },
        },
      });
      await this.#onSample?.(sample, {
        phase: decision.phase,
        reason: decision.reason,
        rssSoftBytes: this.#config.rssSoftBytes,
        rssHardBytes: this.#config.rssHardBytes,
        rssResumeBytes: this.#config.rssResumeBytes,
      });
      if (decision.phase !== this.#lastPhase) {
        this.#lastPhase = decision.phase;
        if (decision.phase === "soft") {
          this.#logger(
            `[browser-resource] Chrome RSS reached ${(sample.rssBytes / MiB).toFixed(0)} MiB ` +
              `(soft limit ${(this.#config.rssSoftBytes / MiB).toFixed(0)} MiB); ` +
              `hard shutdown remains armed at ${(this.#config.rssHardBytes / MiB).toFixed(0)} MiB.`,
          );
        }
      }
      if (decision.phase === "hard") {
        const reason = decision.terminationEligible
          ? "rss_hard_watermark"
          : `identity_mismatch:${decision.identityValidation?.mismatches.join(",") || "unknown"}`;
        const error = resourceError(
          decision.terminationEligible
            ? `Chrome exceeded Oracle's ${(this.#config.rssHardBytes / MiB).toFixed(0)} MiB hard memory limit; the owned browser was stopped.`
            : "Chrome exceeded Oracle's hard memory limit, but process identity changed; Oracle refused to terminate an unverified process.",
          sample,
          this.#config,
          reason,
        );
        this.stop();
        this.#rejectExhaustion(error);
        if (decision.terminationEligible) {
          await this.#onHardLimit(error, {
            expected: this.#expected,
            sample,
            generation: this.#generation,
          });
        }
        return;
      }
    } catch (error) {
      this.#sampleFailures += 1;
      if (this.#sampleFailures >= this.#config.maxConsecutiveSampleFailures) {
        const failure = resourceError(
          `Oracle's Chrome memory monitor failed ${this.#sampleFailures} consecutive samples; closing the unmonitored owned browser.`,
          null,
          this.#config,
          "sampling_unavailable",
        );
        this.stop();
        this.#rejectExhaustion(failure);
        await this.#onHardLimit(failure, null);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#logger(`[browser-resource] Memory sample failed (${this.#sampleFailures}): ${message}`);
    } finally {
      this.#checking = false;
    }
    this.#schedule(this.#config.pollIntervalMs);
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.sampleNow(), delayMs);
    this.#timer.unref?.();
  }
}

export async function startOwnedChromeResourceWatchdog(
  options: BrowserResourceWatchdogOptions,
  dependencies: BrowserResourceWatchdogDependencies = {},
): Promise<BrowserResourceWatchdog> {
  return OwnedChromeResourceWatchdog.start(options, dependencies);
}
