import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { launch } from "chrome-launcher";
import { computeAdaptivePollPlan, type AdaptivePollState } from "../src/jobs/adaptivePolling.js";
import { connectToChrome } from "../src/browser/chromeLifecycle.js";
import {
  CoordinatorRuntime,
  type CoordinatorTargetLease,
} from "../src/browser/coordinatorRuntime.js";
import { BrowserCoordinatorStore } from "../src/browser/coordinatorStore.js";
import {
  calculateResourceTrends,
  type ResourceGovernorSample,
} from "../src/browser/resourceGovernor.js";
import {
  createPlatformProcessProvider,
  redactProcessTreeSample,
  sampleOwnedChromeTree,
  type ProcessSnapshotProvider,
  type ProcessTreeSample,
} from "../src/browser/resourceTelemetry.js";
import { redactBenchmarkArtifact } from "../src/benchmark/workloadHarness.js";

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_DURATION_MS = 5_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const TARGET_CLOSE_ATTEMPTS = 20;
const TARGET_CLOSE_DELAY_MS = 50;
const CLEANUP_ATTEMPTS = 50;
const CLEANUP_DELAY_MS = 100;
const MAX_CYCLE_TARGETS = 1;
const MiB = 1024 ** 2;
const MAX_PROMOTION_RSS_SLOPE_BYTES_PER_SECOND = (64 * MiB) / (60 * 60);
const PROMOTION_RSS_SLOPE_METHOD = "endpoint-delta-over-sample-span";
const PROMOTION_RSS_NOISE_METHOD = "sample-range";

export interface ResourceSoakOptions {
  durationMs: number;
  sampleIntervalMs: number;
  outputPath: string;
  deterministicOutputPath: string;
}

export interface ResourceSoakResult {
  soakPath: string;
  deterministicPath: string;
  sampleCount: number;
  orphanCount: number;
  durationMs: number;
}

export interface ResourceSoakChrome {
  readonly pid?: number;
  readonly port: number;
  kill(): void | Promise<void>;
}

export interface ResourceSoakBrowserClient {
  Target: {
    createTarget(options: { url: string }): Promise<{ targetId?: string }>;
    closeTarget(options: { targetId: string }): Promise<{ success?: boolean }>;
  };
  close(): Promise<void>;
}

export interface ResourceSoakTargetInventory {
  count: number;
  types: Readonly<Record<string, number>>;
  pageIds: readonly string[];
}

export interface ResourceSoakDependencies {
  launch?: (options: {
    chromePath?: string;
    userDataDir: string;
    chromeFlags: string[];
    handleSIGINT: false;
  }) => Promise<ResourceSoakChrome>;
  connect?: (port: number, host: string) => Promise<ResourceSoakBrowserClient>;
  listTargets?: (host: string, port: number) => Promise<ResourceSoakTargetInventory>;
  sampleTree?: typeof sampleOwnedChromeTree;
  processProvider?: ProcessSnapshotProvider;
  wait?: (milliseconds: number) => Promise<void>;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function readFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseResourceSoakOptions(args: readonly string[]): ResourceSoakOptions {
  const durationMs = parsePositiveInteger(
    readFlag(args, "--duration-ms") ?? String(DEFAULT_DURATION_MS),
    "--duration-ms",
  );
  const sampleIntervalMs = parsePositiveInteger(
    readFlag(args, "--sample-interval-ms") ?? String(DEFAULT_SAMPLE_INTERVAL_MS),
    "--sample-interval-ms",
  );
  const outputPath = path.resolve(
    readFlag(args, "--output") ??
      path.join(".oracle-benchmarks", `resource-soak-${Date.now()}.json`),
  );
  const deterministicOutputPath = path.resolve(
    readFlag(args, "--deterministic-output") ??
      path.join(path.dirname(outputPath), "resource-cycle-fixture.json"),
  );
  return { durationMs, sampleIntervalMs, outputPath, deterministicOutputPath };
}

function activeTargetCount(store: BrowserCoordinatorStore): number {
  return store
    .listTargets()
    .filter((target) => ["admitted", "active", "closing"].includes(target.state)).length;
}

function artifactSample(sample: ProcessTreeSample): unknown {
  const redacted = redactProcessTreeSample(sample);
  return {
    sampledAt: redacted.sampledAt,
    sampledAtMs: redacted.sampledAtMs,
    rootPid: redacted.rootPid,
    rootFound: redacted.rootFound,
    targetCount: redacted.targetCount,
    targetTypes: redacted.targetTypes,
    processCount: redacted.processCount,
    processTypeCounts: redacted.processTypeCounts,
    rssBytes: redacted.rssBytes,
    workingSetBytes: redacted.workingSetBytes,
    cpuPercent: redacted.cpuPercent,
    cpuTimeMs: redacted.cpuTimeMs,
  };
}

function fixtureArtifact(): unknown {
  const fixtureSamples: ResourceGovernorSample[] = Array.from({ length: 200 }, (_, index) => ({
    sampledAtMs: 1_000 + index * 10,
    rssBytes: (52 + (index % 2)) * MiB,
    targetCount: 0,
    processCount: 0,
  }));
  return {
    schemaVersion: 1,
    mode: "resource-cycle-proof",
    label: "deterministic-fixture",
    source: "injected-process-provider",
    realProcessSampling: false,
    cycleCount: fixtureSamples.length,
    operations: ["chatgpt_create_session", "chatgpt_work_start"],
    calibratedRssBoundBytes: 64 * MiB,
    samples: fixtureSamples,
    trends: calculateResourceTrends(fixtureSamples),
    leases: { finalCount: 0, activeTargets: 0 },
    promotionGate: { status: "unclaimed", requiredDurationMs: EIGHT_HOURS_MS },
  };
}

export async function readChromeTargetInventory(
  host: string,
  port: number,
): Promise<ResourceSoakTargetInventory> {
  const response = await fetch(`http://${host}:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`Chrome target inventory failed with HTTP ${response.status}.`);
  }
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new Error("Chrome target inventory was not an array.");
  const pageIds: string[] = [];
  const types: Record<string, number> = {};
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const target = entry as { id?: unknown; type?: unknown };
    if (typeof target.id === "string" && target.id) pageIds.push(target.id);
    const type = typeof target.type === "string" && target.type ? target.type : "unknown";
    types[type] = (types[type] ?? 0) + 1;
  }
  return { count: raw.length, types, pageIds };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function countOutsideBaseline(
  current: ResourceSoakTargetInventory,
  baseline: ResourceSoakTargetInventory,
): number {
  const baselineIds = new Set(baseline.pageIds);
  return current.pageIds.filter((id) => !baselineIds.has(id)).length;
}

async function waitForTarget(
  listTargets: (host: string, port: number) => Promise<ResourceSoakTargetInventory>,
  host: string,
  port: number,
  targetId: string,
  wait: (milliseconds: number) => Promise<void>,
  present: boolean,
): Promise<ResourceSoakTargetInventory> {
  let latest: ResourceSoakTargetInventory | undefined;
  for (let attempt = 0; attempt < TARGET_CLOSE_ATTEMPTS; attempt += 1) {
    latest = await listTargets(host, port);
    const found = latest.pageIds.includes(targetId);
    if (found === present) return latest;
    if (attempt + 1 < TARGET_CLOSE_ATTEMPTS) await wait(TARGET_CLOSE_DELAY_MS);
  }
  throw new Error(
    `Chrome target ${targetId} did not become ${present ? "visible" : "absent"} in bounded time.`,
  );
}

function launchFlags(): string[] {
  return [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    ...(typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : []),
  ];
}

function assertLiveChromeSample(sample: ProcessTreeSample, rootPid: number): void {
  if (
    sample.rootPid !== rootPid ||
    !sample.rootFound ||
    sample.processCount <= 0 ||
    sample.rssBytes <= 0
  ) {
    throw new Error("Chrome root process sampling was missing or zero during the soak.");
  }
}

function resolvedDependencies(dependencies: ResourceSoakDependencies) {
  return {
    launch:
      dependencies.launch ??
      (async (options: {
        chromePath?: string;
        userDataDir: string;
        chromeFlags: string[];
        handleSIGINT: false;
      }) => await launch(options)),
    connect:
      dependencies.connect ??
      (async (port: number, host: string) =>
        (await connectToChrome(port, () => {}, host)) as unknown as ResourceSoakBrowserClient),
    listTargets: dependencies.listTargets ?? readChromeTargetInventory,
    sampleTree: dependencies.sampleTree ?? sampleOwnedChromeTree,
    processProvider: dependencies.processProvider ?? createPlatformProcessProvider(),
    wait: dependencies.wait ?? (async (milliseconds: number) => await delay(milliseconds)),
  };
}

export async function runResourceSoak(
  options: ResourceSoakOptions,
  suppliedDependencies: ResourceSoakDependencies = {},
): Promise<ResourceSoakResult> {
  const dependencies = resolvedDependencies(suppliedDependencies);
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "oracle-resource-soak-"));
  const databasePath = path.join(databaseDirectory, "coordinator.sqlite");
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "oracle-resource-soak-profile-"));
  const samples: ProcessTreeSample[] = [];
  const orphanCounts: number[] = [];
  const orphanEvidence: Array<{
    cycle: number;
    activeLeasesAfterRelease: number;
    pagesOutsideBaselineAfterRelease: number;
    baselineRestored: boolean;
  }> = [];
  const inventoryCounts: number[] = [];
  const startedAt = Date.now();
  let pollState: AdaptivePollState = { state: "running", attempts: 0 };
  let cycle = 0;
  let chrome: ResourceSoakChrome | undefined;
  let browser: ResourceSoakBrowserClient | undefined;
  let cleanup: ProcessTreeSample | undefined;
  let cleanupKillSucceeded = false;
  let cleanupError: unknown;
  let baselineInventory: ResourceSoakTargetInventory | undefined;

  try {
    const launched = await dependencies.launch({
      chromePath: process.env.CHROME_PATH?.trim() || undefined,
      userDataDir: profileDirectory,
      chromeFlags: launchFlags(),
      handleSIGINT: false,
    });
    chrome = launched;
    const rootPid = launched.pid;
    if (typeof rootPid !== "number" || !Number.isInteger(rootPid) || rootPid <= 0)
      throw new Error("Chrome launcher did not report a valid root PID.");
    const chromePort = launched.port;
    const browserClient = await dependencies.connect(chromePort, "127.0.0.1");
    browser = browserClient;
    const baseline = await dependencies.listTargets("127.0.0.1", chromePort);
    baselineInventory = baseline;

    while (Date.now() - startedAt < options.durationMs || samples.length === 0) {
      const runtime = new CoordinatorRuntime(
        { host: "127.0.0.1", port: chromePort },
        {
          databasePath,
          profileId: "resource-soak",
          ownerPid: process.pid,
          ownerStartToken: `soak-${process.pid}`,
          browserPid: rootPid,
          targetCeilings: { total: MAX_CYCLE_TARGETS },
        },
      );
      let lease: CoordinatorTargetLease | undefined;
      let targetId: string | undefined;
      try {
        const operation = cycle % 2 === 0 ? "chatgpt_create_session" : "chatgpt_work_start";
        lease = await runtime.reserve({ role: "polling", ownerJobId: operation });
        const created = await browserClient.Target.createTarget({ url: "about:blank" });
        targetId = created.targetId;
        if (!targetId) throw new Error("Chrome returned no target id.");
        await lease.bind(targetId, "about:blank");
        const liveInventory = await waitForTarget(
          dependencies.listTargets,
          "127.0.0.1",
          chromePort,
          targetId,
          dependencies.wait,
          true,
        );
        if (
          liveInventory.count > baseline.count + MAX_CYCLE_TARGETS ||
          !liveInventory.pageIds.includes(targetId)
        ) {
          throw new Error("Chrome target inventory exceeded the bounded cycle target budget.");
        }
        inventoryCounts.push(liveInventory.count);
        const sample = await dependencies.sampleTree({
          rootPid,
          targetCount: liveInventory.count,
          targetTypes: liveInventory.types,
          provider: dependencies.processProvider,
        });
        assertLiveChromeSample(sample, rootPid);
        samples.push(sample);

        await browserClient.Target.closeTarget({ targetId });
        const absentInventory = await waitForTarget(
          dependencies.listTargets,
          "127.0.0.1",
          chromePort,
          targetId,
          dependencies.wait,
          false,
        );
        await lease.release({ confirmed: true });
        lease = undefined;

        const verifier = new BrowserCoordinatorStore({
          profileId: "resource-soak",
          databasePath,
        });
        const activeLeasesAfterRelease = activeTargetCount(verifier);
        verifier.close();
        const pagesOutsideBaselineAfterRelease = countOutsideBaseline(absentInventory, baseline);
        const baselineRestored =
          activeLeasesAfterRelease === 0 &&
          pagesOutsideBaselineAfterRelease === 0 &&
          sameIds(absentInventory.pageIds, baseline.pageIds);
        orphanCounts.push(activeLeasesAfterRelease);
        orphanEvidence.push({
          cycle,
          activeLeasesAfterRelease,
          pagesOutsideBaselineAfterRelease,
          baselineRestored,
        });
        if (!baselineRestored) throw new Error("Resource soak left coordinator or Chrome targets.");

        pollState = computeAdaptivePollPlan({
          now: Date.now(),
          state: pollState,
          observation: { state: "running", progress: true },
          minDelayMs: options.sampleIntervalMs,
          maxDelayMs: Math.max(options.sampleIntervalMs, options.sampleIntervalMs * 4),
          backoffFactor: 1,
          jitterRatio: 0,
        }).state;
        cycle += 1;
        if (Date.now() - startedAt >= options.durationMs) break;
        await dependencies.wait(options.sampleIntervalMs);
      } catch (error) {
        if (targetId && browser) {
          await browserClient.Target.closeTarget({ targetId }).catch(() => undefined);
          await waitForTarget(
            dependencies.listTargets,
            "127.0.0.1",
            chromePort,
            targetId,
            dependencies.wait,
            false,
          ).catch(() => undefined);
        }
        if (lease) await lease.markLost().catch(() => undefined);
        throw error;
      } finally {
        runtime.close();
      }
    }
  } finally {
    if (browser) await browser.close().catch((error) => (cleanupError = error));
    const processChrome = chrome;
    if (processChrome) {
      try {
        await processChrome.kill();
        cleanupKillSucceeded = true;
      } catch (error) {
        cleanupError = error;
      }
      const processRootPid = processChrome.pid;
      if (
        typeof processRootPid === "number" &&
        Number.isInteger(processRootPid) &&
        processRootPid > 0
      ) {
        for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
          try {
            cleanup = await dependencies.sampleTree({
              rootPid: processRootPid,
              targetCount: 0,
              targetTypes: {},
              provider: dependencies.processProvider,
            });
          } catch (error) {
            cleanupError = error;
            break;
          }
          const latestCleanup = cleanup;
          if (latestCleanup && !latestCleanup.rootFound && latestCleanup.processCount === 0) break;
          if (attempt + 1 < CLEANUP_ATTEMPTS) await dependencies.wait(CLEANUP_DELAY_MS);
        }
      }
    }
    await rm(profileDirectory, { recursive: true, force: true });
    await rm(databaseDirectory, { recursive: true, force: true });
  }

  const launchedChrome = chrome;
  const launchedRootPid = launchedChrome?.pid;
  const confirmedCleanup = cleanup;
  if (
    !launchedChrome ||
    typeof launchedRootPid !== "number" ||
    !Number.isInteger(launchedRootPid) ||
    launchedRootPid <= 0 ||
    cleanupError ||
    !cleanupKillSucceeded ||
    !confirmedCleanup ||
    confirmedCleanup.rootFound ||
    confirmedCleanup.processCount !== 0 ||
    samples.length === 0 ||
    samples.some((sample) => !sample.rootFound || sample.processCount <= 0 || sample.rssBytes <= 0)
  ) {
    throw new Error("Chrome soak cleanup or live-process evidence was not confirmed.");
  }
  if (!baselineInventory || orphanEvidence.some((evidence) => !evidence.baselineRestored)) {
    throw new Error("Chrome soak orphan evidence was not clean for every cycle.");
  }

  const observedDurationMs = Date.now() - startedAt;
  const trends = calculateResourceTrends(samples);
  const rssValues = samples.map((sample) => sample.rssBytes);
  const finalInventory = orphanEvidence.at(-1);
  const realArtifact = redactBenchmarkArtifact({
    schemaVersion: 1,
    mode: "resource-soak",
    label: "smoke",
    source: "real-process-tree",
    realProcessSampling: true,
    redacted: true,
    rootPid: launchedRootPid,
    durationMs: observedDurationMs,
    requestedDurationMs: options.durationMs,
    sampleIntervalMs: options.sampleIntervalMs,
    sampleCount: samples.length,
    samples: samples.map(artifactSample),
    rss: {
      slopeBytesPerSecond: trends.rssBytes.slopePerSecond,
      minBytes: Math.min(...rssValues),
      maxBytes: Math.max(...rssValues),
      noiseBytes: Math.max(...rssValues) - Math.min(...rssValues),
    },
    chrome: {
      isolated: true,
      headless: true,
      rootFoundSamples: samples.filter((sample) => sample.rootFound).length,
      nonzeroProcessSamples: samples.filter(
        (sample) => sample.processCount > 0 && sample.rssBytes > 0,
      ).length,
      maxObservedPages: Math.max(...inventoryCounts),
      baselineRestoredAfterEveryCycle: orphanEvidence.every(
        (evidence) => evidence.baselineRestored,
      ),
      cleanupConfirmed: true,
    },
    cleanup: artifactSample(confirmedCleanup),
    orphans: {
      samplesWithActiveTargets: orphanCounts.filter((count) => count > 0).length,
      maxActiveTargetsAfterRelease: Math.max(...orphanCounts),
      cycles: orphanEvidence,
      finalCycle: finalInventory,
    },
    adaptivePoll: { finalState: pollState, cycles: cycle },
    promotionGate: {
      status: "unclaimed",
      requiredDurationMs: EIGHT_HOURS_MS,
      observedDurationMs,
      rssSlope: {
        method: PROMOTION_RSS_SLOPE_METHOD,
        noiseMethod: PROMOTION_RSS_NOISE_METHOD,
        observedBytesPerSecond: trends.rssBytes.slopePerSecond,
        maxBytesPerSecond: MAX_PROMOTION_RSS_SLOPE_BYTES_PER_SECOND,
        noiseBytes: Math.max(...rssValues) - Math.min(...rssValues),
      },
    },
  });
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await mkdir(path.dirname(options.deterministicOutputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(realArtifact, null, 2)}\n`, "utf8");
  const deterministicArtifact = redactBenchmarkArtifact(fixtureArtifact());
  await writeFile(
    options.deterministicOutputPath,
    `${JSON.stringify(deterministicArtifact, null, 2)}\n`,
    "utf8",
  );
  return {
    soakPath: options.outputPath,
    deterministicPath: options.deterministicOutputPath,
    sampleCount: samples.length,
    orphanCount: Math.max(...orphanCounts),
    durationMs: observedDurationMs,
  };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const options = parseResourceSoakOptions(args);
  const result = await runResourceSoak(options);
  process.stdout.write(
    `${JSON.stringify({ ...result, label: "smoke", eightHourPromotionGate: "unclaimed" }, null, 2)}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
