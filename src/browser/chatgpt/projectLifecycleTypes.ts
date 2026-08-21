import type { ApprovalChallenge, ApprovalGrantAuthority } from "../approvalToken.js";
import type { BrowserLogger, ChromeClient } from "../types.js";

export type ProjectOperationState =
  | "ok"
  | "unsupported"
  | "requires_action"
  | "conflict"
  | "disconnected";

export interface ProjectCapabilityEvidence {
  pageIdentity: "chatgpt_app" | "auth" | "challenge" | "other" | "unknown";
  loginState: "logged_in" | "login_required" | "challenge_required" | "unknown";
  projectControls: "available" | "unavailable" | "unknown";
  sourceControls: "available" | "unavailable" | "unknown";
  shareControls: "available" | "unavailable" | "unknown";
  reason?: string;
}

export interface ProjectRevision {
  projectId: string;
  revisionHash: string;
}

export type ProjectMemoryVisibility = "private" | "project" | "shared" | "unknown";

export interface ProjectRecord extends ProjectRevision {
  name: string;
  url: string;
  instructions?: string;
  memoryVisibility?: ProjectMemoryVisibility;
  capability?: ProjectCapabilityEvidence;
}

export interface ProjectConversationRecord {
  conversationId: string;
  url: string;
  title: string;
  projectId: string;
  parentConversationId?: string;
}

export interface ProjectSourceRecord {
  sourceId: string;
  projectId: string;
  name: string;
  status: "ready" | "processing" | "unknown";
  capability?: ProjectCapabilityEvidence;
}

export interface ProjectSnapshot extends ProjectRecord {
  conversations: ProjectConversationRecord[];
  sources: ProjectSourceRecord[];
}

export interface ProjectShareTarget {
  kind: "link" | "workspace" | "user";
  target?: string;
}

export interface ProjectSharePreview {
  projectId: string;
  revisionHash: string;
  target: ProjectShareTarget;
  external: boolean;
  unknown: boolean;
  approvalChallenge: ApprovalChallenge;
  capability?: ProjectCapabilityEvidence;
  summary: string;
}

export interface ProjectResultBase {
  state: ProjectOperationState;
  projectId?: string;
  revisionHash?: string;
  approvalChallenge?: ApprovalChallenge;
  reason?: string;
  capability?: ProjectCapabilityEvidence;
}

export interface ProjectUnsupportedResult extends ProjectResultBase {
  state: "unsupported";
  reason: string;
}

export interface ProjectRequiresActionResult extends ProjectResultBase {
  state: "requires_action";
  reason: string;
}

export interface ProjectConflictResult extends ProjectResultBase {
  state: "conflict";
  reason: string;
  expectedRevisionHash?: string;
  observedRevisionHash?: string;
}

export interface ProjectListResult extends ProjectResultBase {
  state: "ok";
  projects: ProjectRecord[];
}

export interface ProjectGetResult extends ProjectResultBase {
  state: "ok";
  project: ProjectSnapshot;
}

export interface ProjectCreateResult extends ProjectResultBase {
  state: "ok";
  project: ProjectSnapshot;
  created: true;
}

export interface ProjectMutationResult extends ProjectResultBase {
  state: "ok";
  project: ProjectSnapshot;
  changed: boolean;
}

export interface ProjectSourceListResult extends ProjectResultBase {
  state: "ok";
  projectId: string;
  revisionHash: string;
  sources: ProjectSourceRecord[];
}

export interface ProjectSourceRemoveResult extends ProjectResultBase {
  state: "ok";
  projectId: string;
  revisionHash: string;
  sourceId: string;
  removed: true;
}

export interface ProjectBranchResult extends ProjectResultBase {
  state: "ok";
  projectId: string;
  revisionHash: string;
  parentConversationId: string;
  conversation: ProjectConversationRecord;
  branched: true;
}

export interface ProjectSharePreviewResult extends ProjectResultBase {
  state: "ok";
  preview: ProjectSharePreview;
}

export interface ProjectShareCommitResult extends ProjectResultBase {
  state: "ok";
  project: ProjectSnapshot;
  shared: true;
  target: ProjectShareTarget;
}

export interface ProjectDeleteResult extends ProjectResultBase {
  state: "ok";
  projectId: string;
  revisionHash: string;
  deleted: true;
}

export type ProjectOperationResult =
  | ProjectListResult
  | ProjectGetResult
  | ProjectCreateResult
  | ProjectMutationResult
  | ProjectSourceListResult
  | ProjectSourceRemoveResult
  | ProjectBranchResult
  | ProjectSharePreviewResult
  | ProjectShareCommitResult
  | ProjectDeleteResult
  | ProjectUnsupportedResult
  | ProjectRequiresActionResult
  | ProjectConflictResult;

export interface ProjectLifecycleDriver {
  listProjects(): Promise<ProjectRecord[]>;
  getProject(projectId: string): Promise<ProjectSnapshot>;
  createProject(input: { name: string; instructions?: string }): Promise<ProjectSnapshot>;
  renameProject(input: {
    projectId: string;
    name: string;
    expectedRevisionHash: string;
  }): Promise<ProjectSnapshot>;
  moveProject(input: {
    projectId: string;
    targetProjectId: string;
    expectedRevisionHash: string;
  }): Promise<ProjectSnapshot>;
  deleteProject(input: { projectId: string; expectedRevisionHash: string }): Promise<void>;
  listProjectSources(projectId: string): Promise<ProjectSourceRecord[]>;
  removeProjectSource(input: {
    projectId: string;
    sourceId: string;
    expectedRevisionHash: string;
  }): Promise<ProjectSnapshot>;
  branchProjectConversation(input: {
    projectId: string;
    parentConversationId: string;
    expectedRevisionHash: string;
  }): Promise<ProjectConversationRecord>;
  previewProjectShare(input: {
    projectId: string;
    target: ProjectShareTarget;
    expectedRevisionHash: string;
  }): Promise<Omit<ProjectSharePreview, "approvalChallenge">>;
  shareProject(input: {
    projectId: string;
    target: ProjectShareTarget;
    expectedRevisionHash: string;
  }): Promise<ProjectSnapshot>;
}

export interface RuntimeProjectLifecycleOptions {
  Runtime: ChromeClient["Runtime"];
  Input?: ChromeClient["Input"];
  Page?: ChromeClient["Page"];
  timeoutMs?: number;
  logger?: BrowserLogger;
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}

export type ProjectServiceFailure =
  | ProjectUnsupportedResult
  | ProjectRequiresActionResult
  | ProjectConflictResult;
