import { randomUUID } from "node:crypto";
import type {
  BrowserCoordinatorStoreOptions,
  BrowserCoordinatorTargetCeilings,
  BrowserCoordinatorTargetRole,
  BrowserCoordinatorTargetState,
} from "./coordinatorStore.js";
import { BrowserCoordinatorStore } from "./coordinatorStore.js";
import {
  reconcileCoordinatorOwnership,
  type CoordinatorReconciliationResult,
} from "./coordinatorReconciler.js";
import {
  createPlatformProcessProvider,
  type ProcessSnapshotProvider,
  type ProcessTreeSample,
} from "./resourceTelemetry.js";
import { BrowserAutomationError } from "../oracle/errors.js";

export const DEFAULT_COORDINATOR_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_COORDINATOR_TARGET_CEILINGS: BrowserCoordinatorTargetCeilings = {
  total: 3,
  roles: { mutation: 1, polling: 1, recovery: 1, auth: 1 },
};

export interface CoordinatorRuntimeOptions {
  /** Override the endpoint-derived profile id (primarily useful for isolated tests). */
  profileId?: string;
  profilePath?: string;
  databasePath?: string;
  resolveDatabasePath?: BrowserCoordinatorStoreOptions["resolveDatabasePath"];
  busyTimeoutMs?: number;
  staleOwnerMs?: number;
  heartbeatIntervalMs?: number;
  targetCeilings?: BrowserCoordinatorTargetCeilings;
  now?: () => number;
  ownerPid?: number;
  ownerStartToken?: string;
  browserPid?: number | null;
  maxResourceSamples?: number;
  processProvider?: ProcessSnapshotProvider;
  endpointProbe?: (endpoint: string) => Promise<{ ok: boolean; error?: string }>;
  logger?: (message: string) => void;
}

export interface CoordinatorEndpoint {
  host: string;
  port: number;
}

export interface CoordinatorReservationOptions {
  role?: BrowserCoordinatorTargetRole;
  ownerJobId?: string | null;
  url?: string | null;
}

export interface CoordinatorAttachmentOptions extends CoordinatorReservationOptions {
  state?: BrowserCoordinatorTargetState;
}

export interface CoordinatorTargetLease {
  readonly reservationId: string;
  readonly targetId?: string;
  readonly generation: number;
  readonly role: BrowserCoordinatorTargetRole;
  readonly logical: boolean;
  bind(targetId: string, url?: string | null): Promise<void>;
  release(options?: { confirmed?: boolean }): Promise<void>;
  markLost(): Promise<void>;
}

interface RuntimeLeaseState {
  readonly reservationId: string;
  readonly generation: number;
  readonly role: BrowserCoordinatorTargetRole;
  readonly logical: boolean;
  targetId?: string;
  released: boolean;
}

const runtimes = new Map<string, CoordinatorRuntime>();

export function endpointProfileId(host: string, port: number): string {
  return `${host}:${port}`;
}

export function coordinatorEndpointKey(host: string, port: number): string {
  return endpointProfileId(host, port);
}

export function getCoordinatorRuntime(
  endpoint: CoordinatorEndpoint,
  options: CoordinatorRuntimeOptions = {},
): CoordinatorRuntime {
  const key = `${coordinatorEndpointKey(endpoint.host, endpoint.port)}:${options.profileId ?? ""}:${options.databasePath ?? ""}`;
  const existing = runtimes.get(key);
  if (existing) return existing;
  const runtime = new CoordinatorRuntime(endpoint, options, key);
  runtimes.set(key, runtime);
  return runtime;
}

/** Close idle process-local runtimes. Active reservations are deliberately retained. */
export function closeIdleCoordinatorRuntimes(): void {
  for (const [key, runtime] of runtimes) {
    if (runtime.reservationCount === 0) {
      runtime.close();
      runtimes.delete(key);
    }
  }
}

/** Test/process shutdown hook. It marks outstanding reservations lost before closing. */
export function resetCoordinatorRuntimeCache(): void {
  for (const runtime of runtimes.values()) runtime.shutdown();
  runtimes.clear();
}

export interface CoordinatorResourceObservation {
  phase: "normal" | "soft" | "hard" | "unknown";
  reason: string;
  rssSoftBytes: number;
  rssHardBytes: number;
  rssResumeBytes: number;
}

export function recordCoordinatorResourceObservation(
  endpoint: CoordinatorEndpoint,
  sample: ProcessTreeSample,
  observation: CoordinatorResourceObservation,
  options: CoordinatorRuntimeOptions = {},
): boolean {
  const runtime = getCoordinatorRuntime(endpoint, options);
  if (runtime.generation === null) {
    closeIdleCoordinatorRuntimes();
    return false;
  }
  runtime.store.appendResourceSample({
    generation: runtime.generation,
    sampledAt: sample.sampledAtMs,
    processTreeRssBytes: sample.rssBytes,
    processTreeCpuTimeMs: sample.cpuTimeMs,
    chromePid: sample.rootPid,
    processCount: sample.processCount,
  });
  runtime.store.upsertResourceGate({
    generation: runtime.generation,
    phase: observation.phase,
    reason: observation.reason,
    processTreeRssBytes: sample.rssBytes,
    rssSoftBytes: observation.rssSoftBytes,
    rssHardBytes: observation.rssHardBytes,
    rssResumeBytes: observation.rssResumeBytes,
    sampledAt: sample.sampledAtMs,
  });
  return true;
}

export function clearCoordinatorResourceObservation(
  endpoint: CoordinatorEndpoint,
  options: CoordinatorRuntimeOptions = {},
): void {
  const runtime = getCoordinatorRuntime(endpoint, options);
  const current = runtime.store.getResourceGate();
  const profile = runtime.store.getProfile();
  if (current && profile) {
    runtime.store.upsertResourceGate({
      generation: profile.generation,
      phase: "normal",
      reason: "browser_stopped",
      processTreeRssBytes: 0,
      rssSoftBytes: current.rssSoftBytes,
      rssHardBytes: current.rssHardBytes,
      rssResumeBytes: current.rssResumeBytes,
    });
  }
  if (runtime.generation === null) closeIdleCoordinatorRuntimes();
}

export async function reserveCoordinatorTarget(
  host: string,
  port: number,
  options: CoordinatorReservationOptions & CoordinatorRuntimeOptions = {},
): Promise<CoordinatorTargetLease> {
  return await getCoordinatorRuntime({ host, port }, options).reserve(options);
}
export async function attachCoordinatorTarget(
  host: string,
  port: number,
  targetId: string,
  options: CoordinatorAttachmentOptions & CoordinatorRuntimeOptions = {},
): Promise<CoordinatorTargetLease> {
  return await getCoordinatorRuntime({ host, port }, options).attach(targetId, options);
}

export async function finalizeCoordinatorTarget(
  host: string,
  port: number,
  targetId: string,
  confirmed: boolean,
  options: CoordinatorRuntimeOptions = {},
): Promise<void> {
  const runtime = getCoordinatorRuntime({ host, port }, options);
  await runtime.finalize(targetId, confirmed);
}

export class CoordinatorRuntime {
  readonly endpoint: CoordinatorEndpoint;
  readonly profileId: string;
  readonly store: BrowserCoordinatorStore;
  readonly ownerPid: number;
  ownerStartToken: string;
  readonly #key: string;
  readonly #options: CoordinatorRuntimeOptions;
  #generation: number | null = null;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #leases = new Map<string, RuntimeLeaseState>();
  #closed = false;

  constructor(
    endpoint: CoordinatorEndpoint,
    options: CoordinatorRuntimeOptions = {},
    cacheKey = coordinatorEndpointKey(endpoint.host, endpoint.port),
  ) {
    this.endpoint = { host: endpoint.host, port: endpoint.port };
    this.profileId = options.profileId ?? endpointProfileId(endpoint.host, endpoint.port);
    this.ownerPid = options.ownerPid ?? process.pid;
    this.ownerStartToken = options.ownerStartToken ?? "";
    this.#key = cacheKey;
    this.#options = options;
    this.store = new BrowserCoordinatorStore({
      profileId: this.profileId,
      profilePath: options.profilePath,
      databasePath: options.databasePath,
      resolveDatabasePath: options.resolveDatabasePath,
      busyTimeoutMs: options.busyTimeoutMs,
      staleOwnerMs: options.staleOwnerMs,
      targetCeilings: {
        ...DEFAULT_COORDINATOR_TARGET_CEILINGS,
        ...(options.targetCeilings ?? {}),
        roles: {
          ...DEFAULT_COORDINATOR_TARGET_CEILINGS.roles,
          ...(options.targetCeilings?.roles ?? {}),
        },
      },
      maxResourceSamples: options.maxResourceSamples,
      now: options.now,
    });
  }

  get reservationCount(): number {
    return this.#leases.size;
  }

  get generation(): number | null {
    return this.#generation;
  }
  async reserve(options: CoordinatorReservationOptions = {}): Promise<CoordinatorTargetLease> {
    this.#assertOpen();
    const generation = await this.#ensureGeneration();
    const reservationId = `reservation_${this.ownerPid}_${randomUUID()}`;
    const role = options.role ?? "mutation";
    const admission = this.store.admitTarget({
      reservationId,
      generation,
      role,
      ownerJobId: options.ownerJobId,
      state: "admitted",
      url: options.url,
    });
    if (!admission.admitted) {
      this.#stopIfIdle();
      throw this.#admissionError(
        admission.reason,
        admission.activeTargetCount,
        admission.activeRoleCount,
      );
    }
    const lease: RuntimeLeaseState = {
      reservationId,
      generation,
      role,
      logical: false,
      released: false,
    };
    this.#leases.set(reservationId, lease);
    this.#startHeartbeat();
    return this.#publicLease(lease);
  }
  async attach(
    targetId: string,
    options: CoordinatorAttachmentOptions = {},
  ): Promise<CoordinatorTargetLease> {
    this.#assertOpen();
    if (!targetId.trim()) throw new Error("Coordinator targetId must not be empty.");
    const generation = await this.#ensureGeneration();
    const role = options.role ?? "mutation";
    const admission = this.store.admitTarget({
      targetId,
      generation,
      role,
      ownerJobId: options.ownerJobId,
      state: options.state ?? "active",
      url: options.url,
    });
    if (!admission.admitted) {
      this.#stopIfIdle();
      throw this.#admissionError(
        admission.reason,
        admission.activeTargetCount,
        admission.activeRoleCount,
      );
    }
    const lease: RuntimeLeaseState = {
      reservationId: targetId,
      targetId,
      generation,
      role,
      logical: true,
      released: false,
    };
    this.#leases.set(lease.reservationId, lease);
    this.#startHeartbeat();
    return this.#publicLease(lease);
  }

  async finalize(targetId: string, confirmed: boolean): Promise<void> {
    const lease = [...this.#leases.values()].find((entry) => entry.targetId === targetId);
    if (lease) {
      await this.#release(lease, confirmed);
      return;
    }
    if (this.#closed || this.#generation === null) return;
    const profile = this.store.getProfile();
    if (!profile || profile.generation !== this.#generation) return;
    if (profile.ownerPid !== this.ownerPid || profile.ownerStartToken !== this.ownerStartToken)
      return;
    const target = this.store
      .listTargets()
      .find((entry) => entry.targetId === targetId && entry.generation === this.#generation);
    if (target) {
      this.store.updateTarget({
        targetId,
        generation: target.generation,
        state: confirmed ? "closed" : "lost",
      });
    }
  }

  heartbeat(): boolean {
    if (this.#closed || this.#generation === null) return false;
    return this.store.heartbeatProfile({
      generation: this.#generation,
      ownerPid: this.ownerPid,
      ownerStartToken: this.ownerStartToken,
      browserPid: this.#options.browserPid,
      devtoolsEndpoint: `${this.endpoint.host}:${this.endpoint.port}`,
    });
  }

  shutdown(): void {
    if (this.#closed) return;
    for (const lease of this.#leases.values()) {
      this.store.updateTarget({
        targetId: lease.targetId ?? lease.reservationId,
        generation: lease.generation,
        state: "lost",
      });
    }
    this.#leases.clear();
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (this.#generation !== null) {
      this.store.releaseProfile({
        generation: this.#generation,
        ownerPid: this.ownerPid,
        ownerStartToken: this.ownerStartToken,
      });
    }
    this.#generation = null;
    this.#closed = true;
    this.store.close();
  }

  close(): void {
    if (this.#closed) return;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (this.#generation !== null && this.ownerStartToken.trim()) {
      this.store.releaseProfile({
        generation: this.#generation,
        ownerPid: this.ownerPid,
        ownerStartToken: this.ownerStartToken,
      });
    }
    this.#generation = null;
    this.#closed = true;
    this.store.close();
  }

  async reconcileOwnership(): Promise<CoordinatorReconciliationResult> {
    return await reconcileCoordinatorOwnership({
      store: this.store,
      now: this.#options.now,
      staleOwnerMs: this.#options.staleOwnerMs,
      processProvider: this.#options.processProvider,
      endpointProbe: this.#options.endpointProbe,
    });
  }

  async #resolveOwnerStartToken(): Promise<boolean> {
    if (this.ownerStartToken.trim()) return true;
    const provider = this.#options.processProvider ?? createPlatformProcessProvider();
    const process = (await provider.listProcesses()).find((entry) => entry.pid === this.ownerPid);
    if (!process?.startToken?.trim()) return false;
    this.ownerStartToken = process.startToken;
    return true;
  }

  async #ensureGeneration(): Promise<number> {
    if (this.#generation !== null) return this.#generation;
    if (!(await this.#resolveOwnerStartToken())) {
      throw new BrowserAutomationError(
        "Browser coordinator owner identity could not be verified.",
        {
          stage: "browser-coordinator",
          reason: "owner-identity-unverified",
          code: "profile-owner-requires-action",
          profileId: this.profileId,
        },
      );
    }
    const reconciliation = await this.reconcileOwnership();
    if (!reconciliation.takeoverAllowed && reconciliation.profile?.state === "running") {
      throw new BrowserAutomationError(
        reconciliation.requiresAction
          ? "Browser coordinator ownership evidence is contradictory; manual action is required."
          : `Browser coordinator profile ${this.profileId} is owned by another live process.`,
        {
          stage: "browser-coordinator",
          reason: reconciliation.requiresAction ? "degraded" : "owner_active",
          code: reconciliation.requiresAction
            ? "profile-owner-requires-action"
            : "profile-owner-active",
          profileId: this.profileId,
          endpoint: `${this.endpoint.host}:${this.endpoint.port}`,
          ownerPid: reconciliation.profile?.ownerPid,
        },
      );
    }
    const claimed = this.store.claimProfileGeneration({
      ownerPid: this.ownerPid,
      ownerStartToken: this.ownerStartToken,
      staleOwnerMs: this.#options.staleOwnerMs,
      takeover: reconciliation.takeoverAllowed,
      browserPid: this.#options.browserPid,
      devtoolsEndpoint: `${this.endpoint.host}:${this.endpoint.port}`,
    });
    if (!claimed.claimed) {
      throw new BrowserAutomationError(
        `Browser coordinator profile ${this.profileId} is owned by another live process.`,
        {
          stage: "browser-coordinator",
          reason: claimed.reason,
          code: "profile-owner-active",
          profileId: this.profileId,
          endpoint: `${this.endpoint.host}:${this.endpoint.port}`,
          ownerPid: claimed.profile.ownerPid,
        },
      );
    }
    this.#generation = claimed.generation;
    return claimed.generation;
  }

  #publicLease(lease: RuntimeLeaseState): CoordinatorTargetLease {
    return {
      get reservationId() {
        return lease.reservationId;
      },
      get targetId() {
        return lease.targetId;
      },
      get generation() {
        return lease.generation;
      },
      get role() {
        return lease.role;
      },
      get logical() {
        return lease.logical;
      },
      bind: async (targetId, url) => {
        await this.#bind(lease, targetId, url);
      },
      release: async (options) => {
        await this.#release(lease, options?.confirmed ?? true);
      },
      markLost: async () => {
        await this.#release(lease, false);
      },
    };
  }

  async #bind(lease: RuntimeLeaseState, targetId: string, url?: string | null): Promise<void> {
    this.#assertLease(lease);
    if (!targetId.trim()) throw new Error("Coordinator targetId must not be empty.");
    const binding = this.store.bindTargetReservation({
      reservationId: lease.reservationId,
      targetId,
      generation: lease.generation,
      url,
    });
    if (!binding.bound) {
      await this.#release(lease, false);
      throw new BrowserAutomationError(
        `Browser coordinator could not bind reservation ${lease.reservationId} to Chrome target ${targetId}.`,
        {
          stage: "browser-coordinator",
          reason: binding.reason,
          code: "target-bind-failed",
          profileId: this.profileId,
          targetId,
        },
      );
    }
    lease.targetId = targetId;
  }

  async #release(lease: RuntimeLeaseState, confirmed: boolean): Promise<void> {
    if (lease.released) return;
    lease.released = true;
    const targetId = lease.targetId ?? lease.reservationId;
    this.store.updateTarget({
      targetId,
      generation: lease.generation,
      state: confirmed ? "closed" : "lost",
    });
    this.#leases.delete(lease.reservationId);
    this.#stopIfIdle();
  }

  #assertLease(lease: RuntimeLeaseState): void {
    this.#assertOpen();
    if (lease.released || this.#leases.get(lease.reservationId) !== lease) {
      throw new Error(`Coordinator target reservation ${lease.reservationId} is already released.`);
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeat || this.#closed) return;
    const interval = Math.max(
      100,
      this.#options.heartbeatIntervalMs ?? DEFAULT_COORDINATOR_HEARTBEAT_INTERVAL_MS,
    );
    this.#heartbeat = setInterval(() => {
      try {
        if (!this.heartbeat()) {
          this.#options.logger?.(
            "Browser coordinator heartbeat was rejected; target ownership is no longer active.",
          );
        }
      } catch (error) {
        this.#options.logger?.(
          `Browser coordinator heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, interval);
    this.#heartbeat.unref?.();
  }

  #stopIfIdle(): void {
    if (this.#leases.size !== 0) return;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (this.#generation !== null) {
      this.store.releaseProfile({
        generation: this.#generation,
        ownerPid: this.ownerPid,
        ownerStartToken: this.ownerStartToken,
      });
    }
    this.#generation = null;
    this.store.close();
    this.#closed = true;
    if (runtimes.get(this.#key) === this) runtimes.delete(this.#key);
  }

  #admissionError(
    reason: string,
    activeTargetCount: number,
    activeRoleCount: number,
  ): BrowserAutomationError {
    const ceilingFailure = reason === "total_ceiling" || reason === "role_ceiling";
    const resourceFailure = reason.startsWith("resource_");
    return new BrowserAutomationError(
      ceilingFailure
        ? `Browser coordinator target capacity is exhausted for ${this.profileId}.`
        : resourceFailure
          ? `Browser coordinator paused target admission for ${this.profileId} (${reason}).`
          : `Browser coordinator rejected target admission for ${this.profileId} (${reason}).`,
      {
        stage: "browser-coordinator",
        reason,
        code: ceilingFailure
          ? "target-ceiling"
          : resourceFailure
            ? "resource-admission-paused"
            : "target-admission-rejected",
        profileId: this.profileId,
        endpoint: `${this.endpoint.host}:${this.endpoint.port}`,
        activeTargetCount,
        activeRoleCount,
      },
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Browser coordinator runtime is closed.");
  }
}
