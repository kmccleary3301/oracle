import {
  ApprovalGrantAuthority,
  bindApprovalChallenge,
  createApprovalChallenge,
  type ApprovalChallenge,
} from "../approvalToken.js";
import type {
  ProjectBranchResult,
  ProjectCapabilityEvidence,
  ProjectConflictResult,
  ProjectConversationRecord,
  ProjectCreateResult,
  ProjectDeleteResult,
  ProjectGetResult,
  ProjectLifecycleDriver,
  ProjectListResult,
  ProjectMemoryVisibility,
  ProjectMutationResult,
  ProjectOperationResult,
  ProjectRecord,
  ProjectRequiresActionResult,
  ProjectRevision,
  ProjectServiceFailure,
  ProjectShareCommitResult,
  ProjectSharePreview,
  ProjectSharePreviewResult,
  ProjectShareTarget,
  ProjectSnapshot,
  ProjectSourceListResult,
  ProjectSourceRecord,
  ProjectSourceRemoveResult,
  ProjectUnsupportedResult,
} from "./projectLifecycleTypes.js";

export type * from "./projectLifecycleTypes.js";

export const PROJECT_APPROVAL_OPERATIONS = {
  delete: "project.delete",
  removeSource: "project.source.remove",
  share: "project.share",
} as const;

type ApprovalOperation =
  (typeof PROJECT_APPROVAL_OPERATIONS)[keyof typeof PROJECT_APPROVAL_OPERATIONS];

export interface ProjectCreateInput {
  name: string;
  instructions?: string;
}

export interface ProjectIdentityInput {
  projectId: string;
  expectedRevisionHash?: string;
}

export interface ProjectMutationInput extends ProjectIdentityInput {
  name?: string;
  targetProjectId?: string;
}

export interface ProjectApprovalInput extends ProjectIdentityInput {
  dryRun?: boolean;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
}

export interface ProjectSourceRemoveInput extends ProjectApprovalInput {
  sourceId: string;
}

export interface ProjectBranchInput extends ProjectIdentityInput {
  parentConversationId: string;
}

export interface ProjectShareInput extends ProjectApprovalInput {
  target: ProjectShareTarget;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exactId(value: unknown, label: string): string {
  if (!nonEmpty(value)) throw new Error(`${label} is required.`);
  return value.trim();
}

function revision(value: unknown): string {
  return exactId(value, "revisionHash");
}

function safeCapability(value: unknown): ProjectCapabilityEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<ProjectCapabilityEvidence>;
  const pageIdentity = ["chatgpt_app", "auth", "challenge", "other", "unknown"].includes(
    input.pageIdentity ?? "",
  )
    ? (input.pageIdentity as ProjectCapabilityEvidence["pageIdentity"])
    : "unknown";
  const loginState = ["logged_in", "login_required", "challenge_required", "unknown"].includes(
    input.loginState ?? "",
  )
    ? (input.loginState as ProjectCapabilityEvidence["loginState"])
    : "unknown";
  const projectControls = ["available", "unavailable", "unknown"].includes(
    input.projectControls ?? "",
  )
    ? (input.projectControls as ProjectCapabilityEvidence["projectControls"])
    : "unknown";
  const sourceControls = ["available", "unavailable", "unknown"].includes(
    input.sourceControls ?? "",
  )
    ? (input.sourceControls as ProjectCapabilityEvidence["sourceControls"])
    : "unknown";
  const shareControls = ["available", "unavailable", "unknown"].includes(input.shareControls ?? "")
    ? (input.shareControls as ProjectCapabilityEvidence["shareControls"])
    : "unknown";
  return {
    pageIdentity,
    loginState,
    projectControls,
    sourceControls,
    shareControls,
  };
}

function safeProject(value: unknown): ProjectRecord {
  if (!value || typeof value !== "object") throw new Error("Project response was not an object.");
  const input = value as Partial<ProjectRecord>;
  return {
    projectId: exactId(input.projectId, "projectId"),
    revisionHash: revision(input.revisionHash),
    name: exactId(input.name, "project name").slice(0, 200),
    url: exactId(input.url, "project URL"),
    ...(nonEmpty(input.instructions) ? { instructions: input.instructions.slice(0, 8_000) } : {}),
    ...(input.memoryVisibility
      ? { memoryVisibility: normalizeMemoryVisibility(input.memoryVisibility) }
      : {}),
    ...(input.capability ? { capability: safeCapability(input.capability) } : {}),
  };
}

function normalizeMemoryVisibility(value: unknown): ProjectMemoryVisibility {
  return ["private", "project", "shared", "unknown"].includes(String(value))
    ? (String(value) as ProjectMemoryVisibility)
    : "unknown";
}

function safeConversation(value: unknown, projectId: string): ProjectConversationRecord {
  if (!value || typeof value !== "object")
    throw new Error("Conversation response was not an object.");
  const input = value as Partial<ProjectConversationRecord>;
  const conversationProjectId = exactId(input.projectId, "projectId");
  if (conversationProjectId !== projectId)
    throw new Error(`conversation-project-mismatch:${conversationProjectId}`);
  return {
    conversationId: exactId(input.conversationId, "conversationId"),
    url: exactId(input.url, "conversation URL"),
    title: nonEmpty(input.title) ? input.title.trim().slice(0, 240) : "Untitled",
    projectId: conversationProjectId,
    ...(nonEmpty(input.parentConversationId)
      ? { parentConversationId: input.parentConversationId.trim() }
      : {}),
  };
}

function safeSource(value: unknown, projectId: string): ProjectSourceRecord {
  if (!value || typeof value !== "object")
    throw new Error("Project source response was not an object.");
  const input = value as Partial<ProjectSourceRecord>;
  const sourceProjectId = exactId(input.projectId, "projectId");
  if (sourceProjectId !== projectId) throw new Error(`source-project-mismatch:${sourceProjectId}`);
  const status = ["ready", "processing", "unknown"].includes(String(input.status))
    ? (String(input.status) as ProjectSourceRecord["status"])
    : "unknown";
  return {
    sourceId: exactId(input.sourceId, "sourceId"),
    projectId: sourceProjectId,
    name: exactId(input.name, "source name").slice(0, 240),
    status,
    ...(input.capability ? { capability: safeCapability(input.capability) } : {}),
  };
}

function safeSnapshot(value: unknown, expectedProjectId?: string): ProjectSnapshot {
  if (!value || typeof value !== "object") throw new Error("Project snapshot was not an object.");
  const input = value as Partial<ProjectSnapshot>;
  const project = safeProject(input);
  if (expectedProjectId && project.projectId !== expectedProjectId)
    throw new Error(`project-id-mismatch:${project.projectId}`);
  const conversations = Array.isArray(input.conversations)
    ? input.conversations.flatMap((item) => {
        try {
          return [safeConversation(item, project.projectId)];
        } catch {
          return [];
        }
      })
    : [];
  const sources = Array.isArray(input.sources)
    ? input.sources.flatMap((item) => {
        try {
          return [safeSource(item, project.projectId)];
        } catch {
          return [];
        }
      })
    : [];
  return { ...project, conversations, sources };
}

function failureFromError(error: unknown, projectId?: string): ProjectServiceFailure {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (/unsupported|unavailable|not found|not implemented/.test(lower))
    return { state: "unsupported", projectId, reason: message };
  return { state: "requires_action", projectId, reason: message };
}

function conflict(
  projectId: string,
  expectedRevisionHash: string | undefined,
  observedRevisionHash?: string,
): ProjectConflictResult {
  return {
    state: "conflict",
    projectId,
    reason: "revision-conflict",
    expectedRevisionHash,
    observedRevisionHash,
    revisionHash: observedRevisionHash,
  };
}

function challengeFor(
  operation: ApprovalOperation,
  target: string,
  revisionHash: string,
  payload?: unknown,
): ApprovalChallenge {
  return createApprovalChallenge({
    operation,
    target,
    revision: revisionHash,
    payload,
    expiry: Date.now() + 5 * 60 * 1000,
  });
}

function sourceChallenge(
  projectId: string,
  sourceId: string,
  revisionHash: string,
): ApprovalChallenge {
  return challengeFor(
    PROJECT_APPROVAL_OPERATIONS.removeSource,
    `${projectId}:${sourceId}`,
    revisionHash,
    { projectId, sourceId },
  );
}

function requiresAction(
  project: ProjectRevision,
  reason: string,
  challenge?: ApprovalChallenge,
  extra: Record<string, unknown> = {},
): ProjectRequiresActionResult {
  return {
    state: "requires_action",
    projectId: project.projectId,
    revisionHash: project.revisionHash,
    reason,
    ...(challenge ? { approvalChallenge: challenge } : {}),
    ...extra,
  } as ProjectRequiresActionResult;
}
export class ChatgptProjectLifecycleService {
  private readonly approvalAuthority?: ApprovalGrantAuthority;
  private readonly principal?: string;
  private readonly session?: string;

  constructor(
    private readonly driver: ProjectLifecycleDriver,
    options: {
      approvalAuthority?: ApprovalGrantAuthority;
      principal?: string;
      session?: string;
    } = {},
  ) {
    this.approvalAuthority = options.approvalAuthority;
    this.principal = options.principal;
    this.session = options.session;
  }

  async listProjects(): Promise<ProjectListResult | ProjectServiceFailure> {
    try {
      return { state: "ok", projects: (await this.driver.listProjects()).map(safeProject) };
    } catch (error) {
      return failureFromError(error);
    }
  }

  async getProject(projectIdInput: string): Promise<ProjectGetResult | ProjectServiceFailure> {
    let projectId = "";
    try {
      projectId = exactId(projectIdInput, "projectId");
      const project = safeSnapshot(await this.driver.getProject(projectId), projectId);
      return { state: "ok", projectId, revisionHash: project.revisionHash, project };
    } catch (error) {
      return failureFromError(error, projectId || undefined);
    }
  }

  async createProject(
    input: ProjectCreateInput,
  ): Promise<ProjectCreateResult | ProjectServiceFailure> {
    try {
      const name = exactId(input.name, "project name");
      if (name.length > 50) throw new Error("Project names cannot be longer than 50 characters.");
      const instructions = input.instructions?.trim() ?? "";
      if (instructions.length > 8_000)
        throw new Error("Project instructions cannot be longer than 8000 characters.");
      const project = safeSnapshot(await this.driver.createProject({ name, instructions }));
      return {
        state: "ok",
        projectId: project.projectId,
        revisionHash: project.revisionHash,
        project,
        created: true,
      };
    } catch (error) {
      return failureFromError(error);
    }
  }

  async renameProject(
    input: ProjectMutationInput,
  ): Promise<ProjectMutationResult | ProjectServiceFailure> {
    return this.mutateProject(input, async (project, expectedRevisionHash) => {
      const name = exactId(input.name, "project name");
      if (name.length > 50) throw new Error("Project names cannot be longer than 50 characters.");
      return this.driver.renameProject({
        projectId: project.projectId,
        name,
        expectedRevisionHash,
      });
    });
  }

  async moveProject(
    input: ProjectMutationInput,
  ): Promise<ProjectMutationResult | ProjectServiceFailure> {
    return this.mutateProject(input, async (project, expectedRevisionHash) => {
      const targetProjectId = exactId(input.targetProjectId, "targetProjectId");
      if (targetProjectId === project.projectId)
        throw new Error("targetProjectId must differ from projectId.");
      return this.driver.moveProject({
        projectId: project.projectId,
        targetProjectId,
        expectedRevisionHash,
      });
    });
  }

  private async mutateProject(
    input: ProjectMutationInput,
    mutation: (project: ProjectSnapshot, expectedRevisionHash: string) => Promise<ProjectSnapshot>,
  ): Promise<ProjectMutationResult | ProjectServiceFailure> {
    let projectId = "";
    try {
      projectId = exactId(input.projectId, "projectId");
      const before = safeSnapshot(await this.driver.getProject(projectId), projectId);
      if (input.expectedRevisionHash && input.expectedRevisionHash !== before.revisionHash)
        return conflict(projectId, input.expectedRevisionHash, before.revisionHash);
      const after = safeSnapshot(await mutation(before, before.revisionHash), projectId);
      const verified = safeSnapshot(await this.driver.getProject(projectId), projectId);
      if (verified.revisionHash !== after.revisionHash)
        return conflict(projectId, after.revisionHash, verified.revisionHash);
      return {
        state: "ok",
        projectId,
        revisionHash: verified.revisionHash,
        project: verified,
        changed: verified.revisionHash !== before.revisionHash,
      };
    } catch (error) {
      return failureFromError(error, projectId || undefined);
    }
  }

  async listProjectSources(
    projectIdInput: string,
  ): Promise<ProjectSourceListResult | ProjectServiceFailure> {
    let projectId = "";
    try {
      projectId = exactId(projectIdInput, "projectId");
      const project = safeSnapshot(await this.driver.getProject(projectId), projectId);
      const sources = (await this.driver.listProjectSources(projectId)).map((source) =>
        safeSource(source, projectId),
      );
      return { state: "ok", projectId, revisionHash: project.revisionHash, sources };
    } catch (error) {
      return failureFromError(error, projectId || undefined);
    }
  }

  async removeProjectSource(
    input: ProjectSourceRemoveInput,
  ): Promise<
    | ProjectSourceRemoveResult
    | ProjectRequiresActionResult
    | ProjectConflictResult
    | ProjectUnsupportedResult
  > {
    let projectId = "";
    try {
      projectId = exactId(input.projectId, "projectId");
      const sourceId = exactId(input.sourceId, "sourceId");
      const before = safeSnapshot(await this.driver.getProject(projectId), projectId);
      if (input.expectedRevisionHash && input.expectedRevisionHash !== before.revisionHash)
        return conflict(projectId, input.expectedRevisionHash, before.revisionHash);
      if (!before.sources.some((source) => source.sourceId === sourceId))
        return requiresAction(before, "source-not-found");
      const challenge = bindApprovalChallenge(
        sourceChallenge(projectId, sourceId, before.revisionHash),
        input.approvalChallenge,
      );
      if (input.dryRun) return requiresAction(before, "approval-required", challenge, { sourceId });
      if (!this.approvalAuthority)
        return requiresAction(before, "approval-authority-unavailable", challenge, { sourceId });
      const consumed = this.approvalAuthority.consumeGrant(input.approvalGrant, challenge, {
        principal: this.principal,
        session: this.session,
      });
      if (consumed.state !== "consumed")
        return requiresAction(before, consumed.reason, challenge, { sourceId });
      await this.driver.removeProjectSource({
        projectId,
        sourceId,
        expectedRevisionHash: before.revisionHash,
      });
      const verified = safeSnapshot(await this.driver.getProject(projectId), projectId);
      if (verified.sources.some((source) => source.sourceId === sourceId))
        return requiresAction(verified, "source-removal-not-verified", challenge, { sourceId });
      return {
        state: "ok",
        projectId,
        revisionHash: verified.revisionHash,
        sourceId,
        removed: true,
      };
    } catch (error) {
      return failureFromError(error, projectId || undefined);
    }
  }

  async branchProjectConversation(
    input: ProjectBranchInput,
  ): Promise<ProjectBranchResult | ProjectServiceFailure> {
    let projectId = "";
    try {
      projectId = exactId(input.projectId, "projectId");
      const parentConversationId = exactId(input.parentConversationId, "parentConversationId");
      const before = safeSnapshot(await this.driver.getProject(projectId), projectId);
      if (input.expectedRevisionHash && input.expectedRevisionHash !== before.revisionHash)
        return conflict(projectId, input.expectedRevisionHash, before.revisionHash);
      if (
        !before.conversations.some(
          (conversation) => conversation.conversationId === parentConversationId,
        )
      )
        return requiresAction(before, "parent-conversation-not-found");
      const conversation = safeConversation(
        await this.driver.branchProjectConversation({
          projectId,
          parentConversationId,
          expectedRevisionHash: before.revisionHash,
        }),
        projectId,
      );
      if (conversation.parentConversationId !== parentConversationId)
        return requiresAction(before, "branch-parent-not-verified");
      const verified = safeSnapshot(await this.driver.getProject(projectId), projectId);
      if (
        !verified.conversations.some(
          (candidate) =>
            candidate.conversationId === conversation.conversationId &&
            candidate.parentConversationId === parentConversationId,
        )
      )
        return requiresAction(verified, "branch-not-verified");
      return {
        state: "ok",
        projectId,
        revisionHash: verified.revisionHash,
        parentConversationId,
        conversation,
        branched: true,
      };
    } catch (error) {
      return failureFromError(error, projectId || undefined);
    }
  }

  async previewProjectShare(
    input: ProjectShareInput,
  ): Promise<ProjectSharePreviewResult | ProjectServiceFailure> {
    let projectId = "";
    try {
      projectId = exactId(input.projectId, "projectId");
      const before = safeSnapshot(await this.driver.getProject(projectId), projectId);
      if (input.expectedRevisionHash && input.expectedRevisionHash !== before.revisionHash)
        return conflict(projectId, input.expectedRevisionHash, before.revisionHash);
      const target = normalizeTarget(input.target);
      const challenge = challengeFor(
        PROJECT_APPROVAL_OPERATIONS.share,
        projectId,
        before.revisionHash,
        target,
      );
      const details = await this.driver.previewProjectShare({
        projectId,
        target,
        expectedRevisionHash: before.revisionHash,
      });
      const preview: ProjectSharePreview = {
        ...details,
        projectId,
        revisionHash: before.revisionHash,
        target,
        approvalChallenge: challenge,
        capability: safeCapability(details.capability),
        summary: nonEmpty(details.summary)
          ? details.summary.slice(0, 240)
          : "Project sharing requires confirmation.",
      };
      return {
        state: "ok",
        projectId,
        revisionHash: before.revisionHash,
        approvalChallenge: challenge,
        preview,
      };
    } catch (error) {
      return failureFromError(error, projectId || undefined);
    }
  }

  async shareProject(
    input: ProjectShareInput,
  ): Promise<
    | ProjectShareCommitResult
    | ProjectRequiresActionResult
    | ProjectConflictResult
    | ProjectUnsupportedResult
  > {
    let projectId = "";
    try {
      projectId = exactId(input.projectId, "projectId");
      const before = safeSnapshot(await this.driver.getProject(projectId), projectId);
      if (input.expectedRevisionHash && input.expectedRevisionHash !== before.revisionHash)
        return conflict(projectId, input.expectedRevisionHash, before.revisionHash);
      const target = normalizeTarget(input.target);
      const challenge = bindApprovalChallenge(
        challengeFor(PROJECT_APPROVAL_OPERATIONS.share, projectId, before.revisionHash, target),
        input.approvalChallenge,
      );
      const preview = await this.driver.previewProjectShare({
        projectId,
        target,
        expectedRevisionHash: before.revisionHash,
      });
      if (preview.unknown || preview.external)
        return requiresAction(
          before,
          preview.unknown ? "unknown-share-target" : "external-share-confirmation",
          challenge,
          { target },
        );
      if (input.dryRun) return requiresAction(before, "approval-required", challenge, { target });
      if (!this.approvalAuthority)
        return requiresAction(before, "approval-authority-unavailable", challenge, { target });
      const consumed = this.approvalAuthority.consumeGrant(input.approvalGrant, challenge, {
        principal: this.principal,
        session: this.session,
      });
      if (consumed.state !== "consumed")
        return requiresAction(before, consumed.reason, challenge, { target });
      await this.driver.shareProject({
        projectId,
        target,
        expectedRevisionHash: before.revisionHash,
      });
      const verified = safeSnapshot(await this.driver.getProject(projectId), projectId);
      if (verified.projectId !== projectId)
        return conflict(projectId, before.revisionHash, verified.revisionHash);
      return {
        state: "ok",
        projectId,
        revisionHash: verified.revisionHash,
        project: verified,
        shared: true,
        target,
      };
    } catch (error) {
      return failureFromError(error, projectId || undefined);
    }
  }

  async deleteProject(
    input: ProjectApprovalInput,
  ): Promise<
    | ProjectDeleteResult
    | ProjectRequiresActionResult
    | ProjectConflictResult
    | ProjectUnsupportedResult
  > {
    let projectId = "";
    try {
      projectId = exactId(input.projectId, "projectId");
      const before = safeSnapshot(await this.driver.getProject(projectId), projectId);
      if (input.expectedRevisionHash && input.expectedRevisionHash !== before.revisionHash)
        return conflict(projectId, input.expectedRevisionHash, before.revisionHash);
      const challenge = bindApprovalChallenge(
        challengeFor(PROJECT_APPROVAL_OPERATIONS.delete, projectId, before.revisionHash, {
          projectId,
        }),
        input.approvalChallenge,
      );
      if (input.dryRun) return requiresAction(before, "approval-required", challenge);
      if (!this.approvalAuthority)
        return requiresAction(before, "approval-authority-unavailable", challenge);
      const consumed = this.approvalAuthority.consumeGrant(input.approvalGrant, challenge, {
        principal: this.principal,
        session: this.session,
      });
      if (consumed.state !== "consumed") return requiresAction(before, consumed.reason, challenge);
      await this.driver.deleteProject({ projectId, expectedRevisionHash: before.revisionHash });
      try {
        const remaining = safeSnapshot(await this.driver.getProject(projectId), projectId);
        return requiresAction(remaining, "deletion-not-verified", challenge);
      } catch (error) {
        if (
          !/not found|missing|deleted|unavailable/i.test(
            error instanceof Error ? error.message : String(error),
          )
        )
          throw error;
      }
      return { state: "ok", projectId, revisionHash: before.revisionHash, deleted: true };
    } catch (error) {
      return failureFromError(error, projectId || undefined);
    }
  }
}

function normalizeTarget(target: ProjectShareTarget): ProjectShareTarget {
  if (!target || !["link", "workspace", "user"].includes(target.kind))
    throw new Error("Unsupported share target.");
  const normalized = {
    kind: target.kind,
    ...(nonEmpty(target.target) ? { target: target.target.trim().slice(0, 240) } : {}),
  } as ProjectShareTarget;
  if (normalized.kind !== "link" && !normalized.target)
    throw new Error("Share target requires an exact target.");
  return normalized;
}

export async function listProjects(
  driver: ProjectLifecycleDriver,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).listProjects();
}
export async function getProject(
  driver: ProjectLifecycleDriver,
  projectId: string,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).getProject(projectId);
}
export async function createProject(
  driver: ProjectLifecycleDriver,
  input: ProjectCreateInput,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).createProject(input);
}
export async function renameProject(
  driver: ProjectLifecycleDriver,
  input: ProjectMutationInput,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).renameProject(input);
}
export async function moveProject(
  driver: ProjectLifecycleDriver,
  input: ProjectMutationInput,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).moveProject(input);
}
export async function listProjectSources(
  driver: ProjectLifecycleDriver,
  projectId: string,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).listProjectSources(projectId);
}
export async function removeProjectSource(
  driver: ProjectLifecycleDriver,
  input: ProjectSourceRemoveInput,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).removeProjectSource(input);
}
export async function branchProjectConversation(
  driver: ProjectLifecycleDriver,
  input: ProjectBranchInput,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).branchProjectConversation(input);
}
export async function previewProjectShare(
  driver: ProjectLifecycleDriver,
  input: ProjectShareInput,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).previewProjectShare(input);
}
export async function shareProject(
  driver: ProjectLifecycleDriver,
  input: ProjectShareInput,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).shareProject(input);
}
export async function deleteProject(
  driver: ProjectLifecycleDriver,
  input: ProjectApprovalInput,
): Promise<ProjectOperationResult> {
  return new ChatgptProjectLifecycleService(driver).deleteProject(input);
}

export const sanitizeProjectCapabilityForTest = safeCapability;
