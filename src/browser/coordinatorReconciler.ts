import type { BrowserCoordinatorProfile, BrowserCoordinatorStore } from "./coordinatorStore.js";
import {
  validateProcessIdentity,
  type ProcessIdentityValidation,
  type ProcessSnapshot,
  createPlatformProcessProvider,
  type ProcessSnapshotProvider,
} from "./resourceTelemetry.js";
import { verifyDevToolsReachable } from "./profileState.js";

export type CoordinatorOwnershipClassification =
  | "healthy"
  | "adoptable-owned"
  | "terminal-owned"
  | "remote-detach-only"
  | "degraded";

export interface CoordinatorReconciliationResult {
  classification: CoordinatorOwnershipClassification;
  takeoverAllowed: boolean;
  terminationAllowed: boolean;
  requiresAction: boolean;
  generation: number | null;
  profile: BrowserCoordinatorProfile | null;
  reasons: readonly string[];
  ownerValidation: ProcessIdentityValidation | null;
  browserValidation: ProcessIdentityValidation | null;
  endpointReachable: boolean | null;
}

export interface CoordinatorReconcilerOptions {
  store: BrowserCoordinatorStore;
  now?: () => number;
  staleOwnerMs?: number;
  processProvider?: ProcessSnapshotProvider;
  endpointProbe?: (endpoint: string) => Promise<{ ok: boolean; error?: string }>;
  ownerObservation?: ProcessSnapshot | null;
  browserObservation?: ProcessSnapshot | null;
  remote?: boolean;
}

function endpointParts(endpoint: string): { host: string; port: number } | null {
  const separator = endpoint.lastIndexOf(":");
  if (separator <= 0) return null;
  const host = endpoint.slice(0, separator);
  const port = Number.parseInt(endpoint.slice(separator + 1), 10);
  return host && Number.isInteger(port) && port > 0 ? { host, port } : null;
}

function findProcess(
  processes: readonly ProcessSnapshot[],
  pid: number | null,
): ProcessSnapshot | null {
  return pid === null ? null : (processes.find((process) => process.pid === pid) ?? null);
}

export async function reconcileCoordinatorOwnership(
  options: CoordinatorReconcilerOptions,
): Promise<CoordinatorReconciliationResult> {
  const profile = options.store.getProfile();
  if (!profile) {
    return {
      classification: "terminal-owned",
      takeoverAllowed: true,
      terminationAllowed: false,
      requiresAction: false,
      generation: null,
      profile: null,
      reasons: ["profile-missing"],
      ownerValidation: null,
      browserValidation: null,
      endpointReachable: false,
    };
  }
  if (profile.state === "stopped") {
    return {
      classification: "terminal-owned",
      takeoverAllowed: true,
      terminationAllowed: false,
      requiresAction: false,
      generation: profile.generation,
      profile,
      reasons: ["profile-stopped"],
      ownerValidation: null,
      browserValidation: null,
      endpointReachable: false,
    };
  }

  const now = options.now?.() ?? Date.now();
  const staleOwnerMs = Math.max(1, options.staleOwnerMs ?? 30_000);
  const stale = profile.heartbeatAt === null || now - profile.heartbeatAt >= staleOwnerMs;
  const endpoint = endpointParts(profile.devtoolsEndpoint ?? "");
  let endpointReachable: boolean | null = null;
  if (endpoint) {
    const probe = await (
      options.endpointProbe ??
      (async (endpointValue: string) => {
        const parsed = endpointParts(endpointValue);
        return parsed
          ? await verifyDevToolsReachable({ ...parsed, attempts: 1, timeoutMs: 500 })
          : { ok: false, error: "invalid-endpoint" };
      })
    )(profile.devtoolsEndpoint!);
    endpointReachable = probe.ok;
  }
  let processObservationUnavailable = false;
  let processes: readonly ProcessSnapshot[] = [];
  try {
    processes = await (options.processProvider ?? createPlatformProcessProvider()).listProcesses();
  } catch {
    processObservationUnavailable = true;
  }
  const owner =
    options.ownerObservation === undefined
      ? findProcess(processes, profile.ownerPid)
      : options.ownerObservation;
  const browser =
    options.browserObservation === undefined
      ? findProcess(processes, profile.browserPid)
      : options.browserObservation;
  const ownerValidation =
    owner && profile.ownerPid !== null && profile.ownerStartToken
      ? validateProcessIdentity(owner, {
          pid: profile.ownerPid,
          startToken: profile.ownerStartToken,
          profilePath: profile.path ?? undefined,
          commandIncludes: ["node"],
          generation: String(profile.generation),
        })
      : null;
  const browserValidation =
    browser && profile.browserPid !== null && profile.ownerStartToken
      ? validateProcessIdentity(browser, {
          pid: profile.browserPid,
          startToken: browser.startToken ?? "",
          profilePath: profile.path ?? undefined,
          commandIncludes: ["chrome"],
          generation: String(profile.generation),
        })
      : null;

  if (!stale && !processObservationUnavailable && ownerValidation?.eligible !== false) {
    return {
      classification: "healthy",
      takeoverAllowed: false,
      terminationAllowed: false,
      requiresAction: false,
      generation: profile.generation,
      profile,
      reasons: ["heartbeat-fresh"],
      ownerValidation,
      browserValidation,
      endpointReachable,
    };
  }
  const reasons: string[] = [];
  if (stale) reasons.push("heartbeat-stale");
  if (owner && ownerValidation && !ownerValidation.eligible)
    reasons.push(...ownerValidation.mismatches);
  if (browser && browserValidation && !browserValidation.eligible)
    reasons.push(...browserValidation.mismatches);
  if (endpointReachable === true) reasons.push("devtools-reachable");
  if (endpointReachable === false) reasons.push("devtools-unreachable");
  if (processObservationUnavailable) reasons.push("process-observation-unavailable");
  if (processObservationUnavailable) {
    return {
      classification: "degraded",
      takeoverAllowed: false,
      terminationAllowed: false,
      requiresAction: true,
      generation: profile.generation,
      profile,
      reasons,
      ownerValidation,
      browserValidation,
      endpointReachable,
    };
  }

  const ownerGone = profile.ownerPid === null || owner === null;
  const browserGone = profile.browserPid === null || browser === null;
  if (!stale) {
    return {
      classification: "degraded",
      takeoverAllowed: false,
      terminationAllowed: false,
      requiresAction: true,
      generation: profile.generation,
      profile,
      reasons,
      ownerValidation,
      browserValidation,
      endpointReachable,
    };
  }
  if (owner && ownerValidation && !ownerValidation.eligible) {
    return {
      classification: "degraded",
      takeoverAllowed: false,
      terminationAllowed: false,
      requiresAction: true,
      generation: profile.generation,
      profile,
      reasons,
      ownerValidation,
      browserValidation,
      endpointReachable,
    };
  }
  if (browser && browserValidation && !browserValidation.eligible) {
    return {
      classification: "degraded",
      takeoverAllowed: false,
      terminationAllowed: false,
      requiresAction: true,
      generation: profile.generation,
      profile,
      reasons,
      ownerValidation,
      browserValidation,
      endpointReachable,
    };
  }
  if (!browserGone && endpointReachable === true) {
    const classification = options.remote ? "remote-detach-only" : "adoptable-owned";
    return {
      classification,
      takeoverAllowed: true,
      terminationAllowed: false,
      requiresAction: false,
      generation: profile.generation,
      profile,
      reasons,
      ownerValidation,
      browserValidation,
      endpointReachable,
    };
  }
  if (ownerGone && browserGone && endpointReachable !== true) {
    return {
      classification: "terminal-owned",
      takeoverAllowed: true,
      terminationAllowed: false,
      requiresAction: false,
      generation: profile.generation,
      profile,
      reasons,
      ownerValidation,
      browserValidation,
      endpointReachable,
    };
  }
  return {
    classification: "degraded",
    takeoverAllowed: false,
    terminationAllowed: false,
    requiresAction: true,
    generation: profile.generation,
    profile,
    reasons,
    ownerValidation,
    browserValidation,
    endpointReachable,
  };
}
